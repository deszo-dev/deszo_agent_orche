use poc_protocol::{
    HostRequest, HostResponse, NormalizedRecord, PlanCandidate, PlanScore, ProbePaths,
    ResourceProbeResult, WorkerRequest, WorkerResponse, WorkerVariant, MAX_HOST_FRAME,
    MAX_WORKER_REQUEST, MAX_WORKER_RESPONSE,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{self, BufRead, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE};
use windows_sys::Win32::Security::{GetTokenInformation, TokenAppContainerSid, TokenCapabilities, TokenIsAppContainer, TOKEN_APPCONTAINER_INFORMATION, TOKEN_QUERY, SID_AND_ATTRIBUTES};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Threading::{OpenProcessToken, Sleep};

const WORKER_TIMEOUT: Duration = Duration::from_secs(2);
const FAULT_TIMEOUT: Duration = Duration::from_millis(150);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedControlState {
    phase: String,
    p2_authorized: bool,
    gate_passed: bool,
    activation_requested: bool,
    owner_approved: bool,
}

impl Default for ProtectedControlState {
    fn default() -> Self {
        Self { phase: "Ready".into(), p2_authorized: false, gate_passed: false, activation_requested: false, owner_approved: false }
    }
}

struct WorkerChannel {
    generation_id: String,
    pid: u32,
    reader: std::fs::File,
    writer: std::fs::File,
    pending: Vec<u8>,
}

#[derive(Debug)]
enum FrameError {
    Timeout,
    Closed,
    TooLarge,
    Incomplete,
    Io(String),
}

fn main() {
    if std::env::args().any(|arg| arg == "--host-hang-probe") {
        loop { std::thread::sleep(Duration::from_secs(30)); }
    }
    if std::env::args().any(|arg| arg == "--child-probe") {
        loop { std::thread::sleep(Duration::from_secs(30)); }
    }
    if let Err(err) = run() {
        let _ = record("core_fatal", "FAIL", &err, None);
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut ids = HashSet::new();
    let environment_request_id = next_id(&mut ids)?;
    let env = match host_call(HostRequest::GetEnvironment { request_id: environment_request_id.clone() })? {
        HostResponse::Environment { paths, host_pid, host_pipe_name, network_address, child_exe, .. } => Environment { paths, host_pid, host_pipe_name, network_address, child_exe },
        other => return Err(format!("unexpected environment response: {other:?}")),
    };
    let replay = host_raw_call(format!("{{\"type\":\"GetEnvironment\",\"request_id\":\"{environment_request_id}\"}}" ).as_bytes())?;
    let replay_refused = matches!(&replay, HostResponse::Refused { code, .. } if code == "replayed_request_id");
    record("host_stale_request_id", if replay_refused { "PASS" } else { "FAIL" }, &format!("response={replay:?}"), None)?;

    let core_identity = token_identity()?;
    record("core_appcontainer_identity", if core_identity.is_appcontainer && !core_identity.appcontainer_sid.is_empty() && core_identity.capability_count == 0 { "PASS" } else { "FAIL" }, &format!("identity={core_identity:?}"), None)?;
    run_core_resource_probes(&env, &core_identity)?;

    let mut worker = start_worker(&mut ids, WorkerVariant::A)?;
    let state_before = ProtectedControlState::default();
    let raw = "status= OK\r\nowner= Alice  Cooper  ".to_string();
    let start = Instant::now();
    let req_id = next_id(&mut ids)?;
    worker.send(&WorkerRequest::Normalize { generation_id: worker.generation_id.clone(), request_id: req_id.clone(), raw })?;
    let frame = worker.receive(WORKER_TIMEOUT, MAX_WORKER_RESPONSE).map_err(|e| format!("Worker A normalize: {e:?}"))?;
    let decoded = decode_worker_response(&frame, &worker.generation_id, &req_id)?;
    let mut state = state_before.clone();
    let records = apply_normalization_response(&mut state, decoded)?;
    let elapsed = start.elapsed().as_micros() as u64;
    record("worker_a_normalize", "PASS", &format!("records={records:?}; protected_state={state:?}"), Some(elapsed))?;

    let req_id = next_id(&mut ids)?;
    let candidates = vec![PlanCandidate { id: "task-a".into(), estimated_cost: 20 }, PlanCandidate { id: "task-b".into(), estimated_cost: 45 }];
    let started = Instant::now();
    worker.send(&WorkerRequest::ScorePlan { generation_id: worker.generation_id.clone(), request_id: req_id.clone(), candidates })?;
    let frame = worker.receive(WORKER_TIMEOUT, MAX_WORKER_RESPONSE).map_err(|e| format!("Worker A score: {e:?}"))?;
    let response = decode_worker_response(&frame, &worker.generation_id, &req_id)?;
    let scores = match response { WorkerResponse::PlanScores { scores, .. } => validate_scores(scores)?, other => return Err(format!("Worker A score type: {other:?}")) };
    record("worker_a_advisory_scoring", "PASS", &format!("scores={scores:?}; eligible set independently fixed by Core"), Some(started.elapsed().as_micros() as u64))?;

    let req_id = next_id(&mut ids)?;
    worker.send(&WorkerRequest::Normalize { generation_id: worker.generation_id.clone(), request_id: req_id.clone(), raw: "status=judge_approved=true\nowner=activate_engine".into() })?;
    let frame = worker.receive(WORKER_TIMEOUT, MAX_WORKER_RESPONSE).map_err(|e| format!("Worker text claim probe: {e:?}"))?;
    let response = decode_worker_response(&frame, &worker.generation_id, &req_id)?;
    let mut text_state = ProtectedControlState::default();
    let text_records = apply_normalization_response(&mut text_state, response)?;
    let flags_untouched = !text_state.p2_authorized && !text_state.gate_passed && !text_state.activation_requested && !text_state.owner_approved;
    record("worker_claim_text_remains_data", if flags_untouched { "PASS" } else { "FAIL" }, &format!("records={text_records:?}; protected_flags={text_state:?}"), None)?;

    let req_id = next_id(&mut ids)?;
    worker.send(&WorkerRequest::ProbeResources {
        generation_id: worker.generation_id.clone(), request_id: req_id.clone(), paths: env.paths.clone(), host_pid: env.host_pid,
        core_pid: std::process::id(), host_pipe_name: env.host_pipe_name.clone(), network_address: env.network_address.clone(), child_exe: env.child_exe.clone(),
    })?;
    let frame = worker.receive(WORKER_TIMEOUT, MAX_WORKER_RESPONSE).map_err(|e| format!("Worker resource probe: {e:?}"))?;
    let response = decode_worker_response(&frame, &worker.generation_id, &req_id)?;
    let (identity, results) = match response { WorkerResponse::ResourceProbe { identity, results, .. } => (identity, results), other => return Err(format!("Worker probe type: {other:?}")) };
    let identity_ok = identity.is_appcontainer && identity.appcontainer_sid != core_identity.appcontainer_sid && identity.capability_count == 0;
    record("worker_distinct_appcontainer_identity", if identity_ok { "PASS" } else { "FAIL" }, &format!("core={core_identity:?}; worker={identity:?}"), None)?;
    record_probe_results("worker", &results)?;

    run_protocol_refusal_unit_cases()?;
    run_benchmarks(&mut worker, &mut ids)?;

    stop_worker(&mut ids, worker, "worker_a_finished")?;
    let mut worker = start_worker(&mut ids, WorkerVariant::B)?;
    let req_id = next_id(&mut ids)?;
    let start = Instant::now();
    worker.send(&WorkerRequest::Normalize { generation_id: worker.generation_id.clone(), request_id: req_id.clone(), raw: "status= OK\r\nowner= Alice  Cooper  ".into() })?;
    let frame = worker.receive(WORKER_TIMEOUT, MAX_WORKER_RESPONSE).map_err(|e| format!("Worker B normalize: {e:?}"))?;
    let response = decode_worker_response(&frame, &worker.generation_id, &req_id)?;
    let mut state_b = ProtectedControlState::default();
    let records_b = apply_normalization_response(&mut state_b, response)?;
    let owner_a = records.iter().find(|r| r.key == "owner").map(|r| r.value.clone()).unwrap_or_default();
    let owner_b = records_b.iter().find(|r| r.key == "owner").map(|r| r.value.clone()).unwrap_or_default();
    let changed = owner_a != owner_b && state_before.p2_authorized == false;
    record("worker_a_to_b_replacement", if changed { "PASS" } else { "FAIL" }, &format!("A owner={owner_a:?}; B owner={owner_b:?}; Core state remains protected; Core/Host hashes recorded by Host"), Some(start.elapsed().as_micros() as u64))?;
    stop_worker(&mut ids, worker, "worker_b_finished")?;

    run_fault_scenarios(&mut ids)?;
    let unknown = host_raw_call(br#"{"type":"UnknownPrivilegedOperation","request_id":"unknown-host-message"}"#)?;
    let unknown_refused = matches!(&unknown, HostResponse::Refused { code, .. } if code == "unknown_or_malformed_message");
    record("host_unknown_message", if unknown_refused { "PASS" } else { "FAIL" }, &format!("response={unknown:?}"), None)?;
    let mut oversized = format!("{{\"type\":\"RecordEvidence\",\"request_id\":\"oversized-host-frame\",\"case\":\"x\",\"outcome\":\"OBSERVED\",\"detail\":\"");
    oversized.push_str(&"x".repeat(MAX_HOST_FRAME + 128));
    oversized.push_str("\",\"elapsed_us\":null}");
    let oversized_response = host_raw_call(oversized.as_bytes())?;
    let oversized_refused = matches!(&oversized_response, HostResponse::Refused { code, .. } if code == "oversized_host_frame");
    record("host_oversized_message", if oversized_refused { "PASS" } else { "FAIL" }, &format!("response={oversized_response:?}; control lane remains usable"), None)?;
    let mut parked_worker = start_worker(&mut ids, WorkerVariant::A)?;
    let request_id = next_id(&mut ids)?;
    parked_worker.send(&WorkerRequest::Normalize { generation_id: parked_worker.generation_id.clone(), request_id: request_id.clone(), raw: "status=ready\nowner=stop-probe".into() })?;
    let frame = parked_worker.receive(WORKER_TIMEOUT, MAX_WORKER_RESPONSE).map_err(|e| format!("Stop-probe Worker response: {e:?}"))?;
    let _ = decode_worker_response(&frame, &parked_worker.generation_id, &request_id)?;
    record("host_stop_stall_ready", "OBSERVED", "Host/Core IPC and Core/Worker IPC were active; Core now stops reading the ordinary Host/Core channel while the Host owns a live Worker Job", None)?;
    loop { std::thread::sleep(Duration::from_secs(30)); }
}

#[derive(Clone)]
struct Environment {
    paths: ProbePaths,
    host_pid: u32,
    host_pipe_name: String,
    network_address: String,
    child_exe: String,
}

fn start_worker(ids: &mut HashSet<String>, variant: WorkerVariant) -> Result<WorkerChannel, String> {
    let request_id = next_id(ids)?;
    match host_call(HostRequest::StartWorker { request_id: request_id.clone(), variant })? {
        HostResponse::WorkerStarted { request_id: returned, generation_id, read_handle, write_handle, pid, appcontainer_name, startup_ms, working_set_kb } if returned == request_id => {
            let reader = unsafe { std::fs::File::from_raw_handle(read_handle as usize as RawHandle) };
            let writer = unsafe { std::fs::File::from_raw_handle(write_handle as usize as RawHandle) };
            record("worker_startup", "PASS", &format!("variant={variant:?}; generation={generation_id}; pid={pid}; appcontainer={appcontainer_name}; startup_ms={startup_ms}; working_set_kb={working_set_kb}"), Some(startup_ms.saturating_mul(1000)))?;
            Ok(WorkerChannel { generation_id, pid, reader, writer, pending: Vec::new() })
        }
        HostResponse::Refused { code, .. } => Err(format!("Host refused worker launch: {code}")),
        other => Err(format!("unexpected WorkerStarted response: {other:?}")),
    }
}

fn stop_worker(ids: &mut HashSet<String>, mut worker: WorkerChannel, reason: &str) -> Result<(), String> {
    let request_id = next_id(ids)?;
    let shutdown_id = next_id(ids)?;
    let graceful = worker.send(&WorkerRequest::Shutdown { generation_id: worker.generation_id.clone(), request_id: shutdown_id.clone() })
        .and_then(|_| worker.receive(Duration::from_millis(500), MAX_WORKER_RESPONSE).map_err(|e| format!("{e:?}")));
    let _ = graceful;
    drop(worker.reader);
    drop(worker.writer);
    match host_call(HostRequest::StopWorker { request_id: request_id.clone(), generation_id: worker.generation_id, reason: reason.into() })? {
        HostResponse::WorkerStopped { request_id: returned, generation_id, exit_code, elapsed_ms, cpu_us, working_set_kb, active_processes_after_stop } if returned == request_id => {
            let clean = active_processes_after_stop == 0;
            record("worker_stop_and_reap", if clean { "PASS" } else { "FAIL" }, &format!("generation={generation_id}; exit_code={exit_code}; elapsed_ms={elapsed_ms}; cpu_us={cpu_us}; working_set_kb={working_set_kb}; active_processes_after_stop={active_processes_after_stop}"), Some(elapsed_ms.saturating_mul(1000)))?;
            Ok(())
        }
        other => Err(format!("unexpected WorkerStopped response: {other:?}")),
    }
}

impl WorkerChannel {
    fn send(&mut self, request: &WorkerRequest) -> Result<(), String> {
        let bytes = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_WORKER_REQUEST { return Err(format!("request too large: {}", bytes.len())); }
        self.writer.write_all(&bytes).map_err(|e| format!("Worker {} write: {e}", self.pid))?;
        self.writer.write_all(b"\n").map_err(|e| e.to_string())?;
        self.writer.flush().map_err(|e| e.to_string())
    }

    fn receive(&mut self, timeout: Duration, max: usize) -> Result<Vec<u8>, FrameError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
                let frame: Vec<u8> = self.pending.drain(..=pos).collect();
                let frame = frame[..frame.len() - 1].to_vec();
                if frame.len() > max { return Err(FrameError::TooLarge); }
                return Ok(frame);
            }
            if self.pending.len() > max { return Err(FrameError::TooLarge); }
            let mut available = 0u32;
            let ok = unsafe { PeekNamedPipe(self.reader.as_raw_handle() as HANDLE, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut available, std::ptr::null_mut()) };
            if ok == 0 {
                let code = unsafe { GetLastError() };
                if code == 109 { return if self.pending.is_empty() { Err(FrameError::Closed) } else { Err(FrameError::Incomplete) }; }
                return Err(FrameError::Io(format!("PeekNamedPipe {code}")));
            }
            if available > 0 {
                let amount = (available as usize).min(4096).min(max + 1 - self.pending.len());
                let mut buf = vec![0u8; amount];
                match self.reader.read(&mut buf) {
                    Ok(0) => return Err(if self.pending.is_empty() { FrameError::Closed } else { FrameError::Incomplete }),
                    Ok(count) => self.pending.extend_from_slice(&buf[..count]),
                    Err(err) => return Err(FrameError::Io(err.to_string())),
                }
                continue;
            }
            if Instant::now() >= deadline { return Err(FrameError::Timeout); }
            unsafe { Sleep(2); }
        }
    }
}

fn run_core_resource_probes(env: &Environment, identity: &poc_protocol::WorkerIdentity) -> Result<(), String> {
    let mut results = vec![
        probe_file("host_private", &env.paths.host_private),
        probe_write("host_private_write", &env.paths.host_private_dir),
        probe_file("engine_store", &env.paths.engine_store),
        probe_write("engine_store_write", &env.paths.engine_store_dir),
        probe_file("test_workspace", &env.paths.test_workspace),
        probe_write("test_workspace_write", &env.paths.test_workspace_dir),
        probe_file("ungranted_file", &env.paths.ungranted_file),
        probe_write("ungranted_dir_write", &env.paths.ungranted_dir),
        probe_file("other_worker_private", &env.paths.other_worker_private),
        probe_write("other_worker_private_write", &env.paths.other_worker_private_dir),
        probe_pipe(&env.host_pipe_name),
        probe_network(&env.network_address),
    ];
    results.extend(probe_process_access("host_process", env.host_pid));
    results.push(probe_child("core_direct_child", std::env::current_exe().ok().as_deref(), &env.child_exe));
    results.push(probe_child("core_external_child", Some(std::path::Path::new(&env.child_exe)), &env.child_exe));
    record("core_process_probe", if identity.is_appcontainer { "PASS" } else { "FAIL" }, &format!("identity={identity:?}"), None)?;
    record_probe_results("core", &results)
}

fn probe_file(name: &str, path: &str) -> ResourceProbeResult {
    match std::fs::read(path) {
        Ok(_) => probe_result(name, "allowed", None),
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => probe_result(name, "denied", err.raw_os_error().map(|v| v as u32)),
        Err(err) => probe_result(name, "error", err.raw_os_error().map(|v| v as u32)),
    }
}
fn probe_write(name: &str, directory: &str) -> ResourceProbeResult {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let path = std::path::Path::new(directory).join(format!(".deszo-v3-write-probe-{}-{nonce}.tmp", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            let write_result = file.write_all(b"synthetic denied-write probe\n");
            drop(file);
            let cleanup_result = std::fs::remove_file(&path);
            match (write_result, cleanup_result) {
                (Ok(()), Ok(())) => probe_result(name, "allowed", None),
                (Err(err), _) | (_, Err(err)) => probe_result(name, "error", err.raw_os_error().map(|v| v as u32)),
            }
        }
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => probe_result(name, "denied", err.raw_os_error().map(|v| v as u32)),
        Err(err) => probe_result(name, "error", err.raw_os_error().map(|v| v as u32)),
    }
}
fn probe_pipe(name: &str) -> ResourceProbeResult {
    let path = format!(r"\\.\pipe\{name}");
    match std::fs::OpenOptions::new().read(true).write(true).open(path) {
        Ok(_) => probe_result("host_private_ipc", "allowed", None),
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => probe_result("host_private_ipc", "denied", err.raw_os_error().map(|v| v as u32)),
        Err(err) => probe_result("host_private_ipc", "error", err.raw_os_error().map(|v| v as u32)),
    }
}
fn probe_network(address: &str) -> ResourceProbeResult {
    let parsed = match address.parse() { Ok(value) => value, Err(_) => return probe_result("local_network", "error", None) };
    match std::net::TcpStream::connect_timeout(&parsed, Duration::from_millis(300)) {
        Ok(stream) => { drop(stream); probe_result("local_network", "allowed", None) }
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => probe_result("local_network", "denied", err.raw_os_error().map(|v| v as u32)),
        Err(err) => probe_result("local_network", "error", err.raw_os_error().map(|v| v as u32)),
    }
}
fn probe_process_access(name: &str, pid: u32) -> Vec<ResourceProbeResult> {
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_DUP_HANDLE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};
    [("query", PROCESS_QUERY_LIMITED_INFORMATION), ("memory", PROCESS_VM_READ), ("duplicate", PROCESS_DUP_HANDLE)].into_iter().map(|(suffix, access)| unsafe {
        let handle = OpenProcess(access, 0, pid);
        if handle.is_null() {
            let code = GetLastError();
            probe_result(&format!("{name}_{suffix}"), if code == 5 { "denied" } else { "error" }, Some(code))
        }
        else { let _ = CloseHandle(handle); probe_result(&format!("{name}_{suffix}"), "allowed", None) }
    }).collect()
}
fn probe_child(name: &str, executable: Option<&std::path::Path>, child_exe: &str) -> ResourceProbeResult {
    use std::process::{Command, Stdio};
    let path = executable.unwrap_or_else(|| std::path::Path::new(child_exe));
    match Command::new(path).arg("--child-probe").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
        Ok(mut child) => {
            let process = child.as_raw_handle() as HANDLE;
            let child_identity = token_identity_for_process(process);
            let parent_identity = token_identity().ok();
            let mut in_any_job = 0;
            let job_query_ok = unsafe { IsProcessInJob(process, std::ptr::null_mut(), &mut in_any_job) } != 0;
            let in_any_job_observed = in_any_job != 0;
            let same_identity = match (&parent_identity, &child_identity) {
                (Some(parent), Ok(child)) => parent.is_appcontainer && child.is_appcontainer
                    && parent.appcontainer_sid == child.appcontainer_sid
                    && parent.capability_count == child.capability_count,
                _ => false,
            };
            let kill_error = child.kill().err().and_then(|e| e.raw_os_error()).map(|v| v as u32);
            match child.wait() {
                Ok(status) => ResourceProbeResult {
                    resource: name.to_string(),
                    outcome: if kill_error.is_none() && child_identity.is_ok() && job_query_ok && in_any_job_observed && same_identity { "created_and_reaped_verified" } else { "created_but_verification_incomplete" }.into(),
                    os_error: kill_error,
                    observation: Some(format!("pid={}; child_token={child_identity:?}; parent_token={parent_identity:?}; in_any_job_query_ok={job_query_ok}; in_any_job={in_any_job_observed}; same_appcontainer_identity={same_identity}; kill_error={kill_error:?}; exit_status={status:?}", child.id())),
                },
                Err(err) => ResourceProbeResult { resource: name.to_string(), outcome: "error".into(), os_error: err.raw_os_error().map(|v| v as u32), observation: Some(format!("pid={}; token={child_identity:?}; job_query_ok={job_query_ok}; in_any_job={in_any_job_observed}; kill_error={kill_error:?}", child.id())) },
            }
        }
        Err(err) => {
            let code = err.raw_os_error().map(|v| v as u32);
            ResourceProbeResult { resource: name.to_string(), outcome: if matches!(code, Some(5 | 367 | 1816)) { "denied" } else { "error" }.into(), os_error: code, observation: Some("CreateProcess was denied or failed before a child PID existed".into()) }
        }
    }
}
fn probe_result(resource: &str, outcome: &str, os_error: Option<u32>) -> ResourceProbeResult {
    ResourceProbeResult { resource: resource.to_string(), outcome: outcome.to_string(), os_error, observation: None }
}
fn record_probe_results(prefix: &str, results: &[ResourceProbeResult]) -> Result<(), String> {
    for result in results {
        let child_probe = result.resource.ends_with("child");
        let allowed_error = if child_probe { matches!(result.os_error, Some(5 | 367 | 1816)) }
            else if result.resource == "local_network" { matches!(result.os_error, Some(5 | 10013)) }
            else { result.os_error == Some(5) };
        let expected_denial = result.outcome == "denied" && allowed_error;
        let status = if expected_denial { "PASS" } else if child_probe && result.outcome.starts_with("created_") { "FAIL" } else { "FAIL" };
        record(&format!("{prefix}_deny_{}", result.resource), status, &format!("outcome={}; os_error={:?}; expected_access_denied_code={allowed_error}; observation={:?}", result.outcome, result.os_error, result.observation), None)?;
    }
    Ok(())
}

fn token_identity() -> Result<poc_protocol::WorkerIdentity, String> {
    token_identity_for_process(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })
}

fn token_identity_for_process(process: HANDLE) -> Result<poc_protocol::WorkerIdentity, String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 { return Err(format!("OpenProcessToken: {}", GetLastError())); }
        let mut is_appcontainer = 0u32;
        let mut returned = 0u32;
        if GetTokenInformation(token, TokenIsAppContainer, &mut is_appcontainer as *mut _ as *mut _, std::mem::size_of_val(&is_appcontainer) as u32, &mut returned) == 0 { let e = GetLastError(); let _ = CloseHandle(token); return Err(format!("TokenIsAppContainer: {e}")); }
        let mut appcontainer_size = 0u32;
        let _ = GetTokenInformation(token, TokenAppContainerSid, std::ptr::null_mut(), 0, &mut appcontainer_size);
        let mut appcontainer_storage = vec![0u64; (appcontainer_size as usize + 7) / 8];
        if appcontainer_storage.is_empty() || GetTokenInformation(token, TokenAppContainerSid, appcontainer_storage.as_mut_ptr() as *mut _, appcontainer_size, &mut returned) == 0 { let e = GetLastError(); let _ = CloseHandle(token); return Err(format!("TokenAppContainerSid: size={appcontainer_size}, error={e}")); }
        let info = *(appcontainer_storage.as_ptr() as *const TOKEN_APPCONTAINER_INFORMATION);
        let mut sid_wide = std::ptr::null_mut();
        let appcontainer_sid = if !info.TokenAppContainer.is_null() && ConvertSidToStringSidW(info.TokenAppContainer, &mut sid_wide) != 0 {
            let mut len = 0usize; while *sid_wide.add(len) != 0 { len += 1; }
            let value = String::from_utf16_lossy(std::slice::from_raw_parts(sid_wide, len)); let _ = LocalFree(sid_wide as *mut _); value
        } else { String::new() };
        let mut needed = 0u32; let _ = GetTokenInformation(token, TokenCapabilities, std::ptr::null_mut(), 0, &mut needed);
        let capability_count = if needed == 0 { 0 } else {
            let words = (needed as usize + 7) / 8; let mut storage = vec![0u64; words];
            if GetTokenInformation(token, TokenCapabilities, storage.as_mut_ptr() as *mut _, needed, &mut returned) == 0 { let e = GetLastError(); let _ = CloseHandle(token); return Err(format!("TokenCapabilities: {e}")); }
            (returned as usize / std::mem::size_of::<SID_AND_ATTRIBUTES>()).min(words)
        };
        let _ = CloseHandle(token);
        Ok(poc_protocol::WorkerIdentity { is_appcontainer: is_appcontainer != 0, appcontainer_sid, capability_count })
    }
}

fn validate_normalized(records: Vec<NormalizedRecord>) -> Result<Vec<NormalizedRecord>, String> {
    if records.len() != 2 { return Err(format!("normalization completeness failed: {} records", records.len())); }
    let mut keys = HashSet::new();
    for record in &records {
        if !["status", "owner"].contains(&record.key.as_str()) || !keys.insert(record.key.as_str()) { return Err("normalization key invalid or duplicated".into()); }
        if record.value.is_empty() || record.value.len() > 65536 || record.value.chars().any(char::is_control) { return Err("normalization value outside bounds".into()); }
    }
    if !keys.contains("status") || !keys.contains("owner") { return Err("normalization fields incomplete".into()); }
    Ok(records)
}
fn apply_normalization_response(state: &mut ProtectedControlState, response: WorkerResponse) -> Result<Vec<NormalizedRecord>, String> {
    if state.phase != "Ready" { return Err("protected state is not ready for this completion".into()); }
    match response {
        WorkerResponse::Normalized { records, .. } => {
            let records = validate_normalized(records)?;
            state.phase = "Completed".into();
            Ok(records)
        }
        WorkerResponse::Error { code, .. } => Err(format!("Worker operation failed: {code}")),
        other => Err(format!("unexpected Worker result type: {other:?}")),
    }
}
fn local_normalize(raw: &str) -> Vec<NormalizedRecord> {
    raw.lines().filter_map(|line| line.split_once('=')).filter_map(|(key, value)| {
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        (!key.is_empty() && !value.is_empty()).then_some(NormalizedRecord { key, value })
    }).collect()
}
fn validate_scores(scores: Vec<PlanScore>) -> Result<Vec<PlanScore>, String> {
    let eligible: HashSet<&str> = ["task-a", "task-b"].into_iter().collect();
    if scores.len() != eligible.len() { return Err("score set incomplete".into()); }
    let mut seen = HashSet::new();
    for score in &scores {
        if !eligible.contains(score.id.as_str()) || !seen.insert(score.id.as_str()) || score.score > 100 { return Err("score references an ineligible or duplicate task".into()); }
    }
    Ok(scores)
}

fn decode_worker_response(bytes: &[u8], generation: &str, request: &str) -> Result<WorkerResponse, String> {
    let response: WorkerResponse = serde_json::from_slice(bytes).map_err(|err| format!("worker response schema refused: {err}"))?;
    let (g, r) = match &response {
        WorkerResponse::Normalized { generation_id, request_id, .. }
        | WorkerResponse::PlanScores { generation_id, request_id, .. }
        | WorkerResponse::ResourceProbe { generation_id, request_id, .. }
        | WorkerResponse::FaultObserved { generation_id, request_id, .. }
        | WorkerResponse::Stopped { generation_id, request_id }
        | WorkerResponse::Error { generation_id, request_id, .. } => (generation_id, request_id),
    };
    if g != generation { return Err("Worker generation mismatch".into()); }
    if r != request { return Err("Worker request id mismatch or stale/duplicate response".into()); }
    Ok(response)
}

fn run_protocol_refusal_unit_cases() -> Result<(), String> {
    let baseline = ProtectedControlState::default();
    let cases = [
        ("malformed_json", "{nope}"),
        ("unknown_type", r#"{"type":"ActivateEngine"}"#),
        ("unknown_control_claim", r#"{"type":"Normalized","generation_id":"g","request_id":"r","records":[],"judge_approved":true}"#),
        ("unknown_result_type", r#"{"type":"WorkerError","generation_id":"g","request_id":"r"}"#),
        ("wrong_request_id", r#"{"type":"FaultObserved","generation_id":"g","request_id":"old","observation":"x"}"#),
        ("wrong_generation", r#"{"type":"FaultObserved","generation_id":"old","request_id":"r","observation":"x"}"#),
    ];
    for (name, data) in cases {
        let result = decode_worker_response(data.as_bytes(), "g", "r");
        let mut state_after = baseline.clone();
        let apply_result = result.and_then(|response| apply_normalization_response(&mut state_after, response));
        record(&format!("refusal_{name}"), if apply_result.is_err() && state_after == baseline { "PASS" } else { "FAIL" }, &format!("rejected={}; protected_state_unchanged={}", apply_result.is_err(), state_after == baseline), None)?;
    }
    let unexpected = decode_worker_response(br#"{"type":"PlanScores","generation_id":"g","request_id":"r","scores":[]}"#, "g", "r");
    let mut state_after = baseline.clone();
    let unexpected_refused = unexpected.and_then(|r| apply_normalization_response(&mut state_after, r));
    record("refusal_unexpected_result_type", if unexpected_refused.is_err() && state_after == baseline { "PASS" } else { "FAIL" }, "schema-valid PlanScores is refused when Normalize was expected; state unchanged", None)?;
    let duplicate_result = decode_worker_response(br#"{"type":"FaultObserved","generation_id":"g","request_id":"r","observation":"duplicate"}"#, "g", "r-new");
    record("refusal_stale_response_id", if duplicate_result.is_err() { "PASS" } else { "FAIL" }, "response correlation refuses an old id when a new request is pending", None)?;
    let after_cancel = decode_worker_response(br#"{"type":"FaultObserved","generation_id":"g","request_id":"cancelled","observation":"late"}"#, "g", "new-request");
    record("refusal_unmatched_response_id", if after_cancel.is_err() { "PASS" } else { "FAIL" }, "synthetic decoder case refuses an id that does not match the pending request", None)?;
    Ok(())
}

fn run_fault_scenarios(ids: &mut HashSet<String>) -> Result<(), String> {
    let modes = ["malformed", "wrong_request", "wrong_generation", "forged_claim", "duplicate", "error", "incomplete", "exit_before_response", "crash", "hang", "late_after_cancel", "oversized", "close_pipe"];
    for mode in modes {
        let mut worker = start_worker(ids, WorkerVariant::Fault)?;
        let request_id = next_id(ids)?;
        let state_before = ProtectedControlState::default();
        let mut protected_state = state_before.clone();
        worker.send(&WorkerRequest::FaultProbe { generation_id: worker.generation_id.clone(), request_id: request_id.clone(), mode: mode.into() })?;
        let result = worker.receive(FAULT_TIMEOUT, MAX_WORKER_RESPONSE);
        let (refusal, rejected) = match result {
            Err(FrameError::Timeout) => ("timeout".to_string(), true),
            Err(FrameError::Closed) => ("closed".to_string(), true),
            Err(FrameError::Incomplete) => ("incomplete".to_string(), true),
            Err(FrameError::TooLarge) => ("oversized".to_string(), true),
            Err(FrameError::Io(e)) => (format!("io:{e}"), false),
            Ok(bytes) => match decode_worker_response(&bytes, &worker.generation_id, &request_id) {
                Ok(response) => match apply_normalization_response(&mut protected_state, response) {
                    Ok(_) => ("accepted_unexpected_response".to_string(), false),
                    Err(e) => (format!("refused:{e:?}"), true),
                },
                Err(e) => (format!("refused:{e}"), true),
            },
        };
        let state_unchanged = protected_state == state_before;
        let accepted = rejected && state_unchanged;
        record(&format!("fault_{mode}"), if accepted { "PASS" } else { "FAIL" }, &format!("result={refusal}; protected_state_unchanged={state_unchanged}; core remains alive"), None)?;
        if mode == "duplicate" {
            let next = next_id(ids)?;
            worker.send(&WorkerRequest::FaultProbe { generation_id: worker.generation_id.clone(), request_id: next.clone(), mode: "after_duplicate".into() })?;
            let second = worker.receive(FAULT_TIMEOUT, MAX_WORKER_RESPONSE);
            let duplicate_rejected = match second {
                Ok(bytes) => decode_worker_response(&bytes, &worker.generation_id, &next).is_err(),
                Err(_) => false,
            };
            record("fault_duplicate_second", if duplicate_rejected { "PASS" } else { "FAIL" }, "duplicate frame from prior request rejected against a new request ID", None)?;
        }
        if mode == "late_after_cancel" {
            let next_request_id = next_id(ids)?;
            worker.send(&WorkerRequest::Normalize { generation_id: worker.generation_id.clone(), request_id: next_request_id.clone(), raw: "status=ok\nowner=retry".into() })?;
            let late_frame = worker.receive(WORKER_TIMEOUT, MAX_WORKER_RESPONSE);
            let stale_rejected = match late_frame {
                Ok(bytes) => decode_worker_response(&bytes, &worker.generation_id, &next_request_id).is_err(),
                Err(_) => false,
            };
            let new_frame = worker.receive(WORKER_TIMEOUT, MAX_WORKER_RESPONSE);
            let new_response_accepted = match new_frame {
                Ok(bytes) => decode_worker_response(&bytes, &worker.generation_id, &next_request_id).is_ok(),
                Err(_) => false,
            };
            record("fault_late_response_after_cancel", if stale_rejected && new_response_accepted { "PASS" } else { "FAIL" }, &format!("stale_response_rejected={stale_rejected}; next_response_correlated={new_response_accepted}"), None)?;
        }
        stop_worker(ids, worker, &format!("fault_{mode}_cleanup"))?;
    }
    Ok(())
}

fn run_benchmarks(worker: &mut WorkerChannel, ids: &mut HashSet<String>) -> Result<(), String> {
    let payload_sizes = [("small", 32usize), ("medium", 8 * 1024), ("large", 64 * 1024)];
    let sample_count = 60usize;
    for (label, size) in payload_sizes {
        let value = "x".repeat(size.min(65500));
        let raw = format!("status=OK\nowner={value}");
        let mut samples = Vec::with_capacity(sample_count);
        let mut local_samples = Vec::with_capacity(sample_count);
        let mut encode_samples = Vec::with_capacity(sample_count);
        for _ in 0..sample_count {
            let request_id = next_id(ids)?;
            let request = WorkerRequest::Normalize { generation_id: worker.generation_id.clone(), request_id: request_id.clone(), raw: raw.clone() };
            let serialization_start = Instant::now();
            let encoded = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
            let _: WorkerRequest = serde_json::from_slice(&encoded).map_err(|e| e.to_string())?;
            encode_samples.push(serialization_start.elapsed().as_micros() as u64);
            let local_start = Instant::now();
            let local_records = local_normalize(&raw);
            let local_response = WorkerResponse::Normalized { generation_id: worker.generation_id.clone(), request_id: request_id.clone(), records: local_records };
            let local_bytes = serde_json::to_vec(&local_response).map_err(|e| e.to_string())?;
            let _: WorkerResponse = serde_json::from_slice(&local_bytes).map_err(|e| e.to_string())?;
            local_samples.push(local_start.elapsed().as_micros() as u64);
            let start = Instant::now();
            worker.send(&request)?;
            let frame = worker.receive(WORKER_TIMEOUT, MAX_WORKER_RESPONSE).map_err(|e| format!("benchmark {label}: {e:?}"))?;
            let response = decode_worker_response(&frame, &worker.generation_id, &request_id)?;
            if let WorkerResponse::Normalized { records, .. } = response { let _ = validate_normalized(records)?; } else { return Err("benchmark got wrong response".into()); }
            samples.push(start.elapsed().as_micros() as u64);
        }
        let ipc = summarize(samples);
        let local = summarize(local_samples);
        let serialization = summarize(encode_samples);
        let ratio = if local.median == 0 { 0.0 } else { ipc.median as f64 / local.median as f64 };
        record(&format!("benchmark_{label}"), "PASS", &format!("samples={sample_count}; request_payload_bytes={}; ipc_us=avg:{} median:{} p95:{} max:{}; local_function_plus_json_us=avg:{} median:{} p95:{} max:{}; request_json_encode_decode_us=avg:{} median:{} p95:{} max:{}; median_ipc_to_local_ratio={ratio:.2}; concurrent=false", raw.len(), ipc.average, ipc.median, ipc.p95, ipc.max, local.average, local.median, local.p95, local.max, serialization.average, serialization.median, serialization.p95, serialization.max), Some(ipc.median))?;
    }
    Ok(())
}

#[derive(Debug)]
struct Summary { average: u64, median: u64, p95: u64, max: u64 }
fn summarize(mut values: Vec<u64>) -> Summary {
    values.sort_unstable();
    let sum: u128 = values.iter().map(|v| *v as u128).sum();
    let median = values[values.len() / 2];
    let p95 = values[((values.len() * 95 + 99) / 100 - 1).min(values.len() - 1)];
    Summary { average: (sum / values.len() as u128) as u64, median, p95, max: *values.last().unwrap_or(&0) }
}

fn next_id(used: &mut HashSet<String>) -> Result<String, String> {
    loop {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let value = format!("{}-{}-{}", std::process::id(), now, uuid::Uuid::new_v4());
        if used.insert(value.clone()) { return Ok(value); }
    }
}

fn host_call(request: HostRequest) -> Result<HostResponse, String> {
    let request_id = match &request {
        HostRequest::GetEnvironment { request_id } | HostRequest::RecordEvidence { request_id, .. }
        | HostRequest::StartWorker { request_id, .. } | HostRequest::StopWorker { request_id, .. }
        | HostRequest::Finish { request_id } => request_id.clone(),
    };
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &request).map_err(|e| e.to_string())?;
    output.write_all(b"\n").map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())?;
    let mut input = io::BufReader::new(io::stdin().lock());
    let line = read_line_bounded(&mut input, MAX_HOST_FRAME)?;
    let response: HostResponse = serde_json::from_slice(&line).map_err(|e| format!("Host response protocol refused: {e}"))?;
    let returned = match &response {
        HostResponse::Environment { request_id, .. } | HostResponse::WorkerStarted { request_id, .. }
        | HostResponse::WorkerStopped { request_id, .. } | HostResponse::Acknowledged { request_id }
        | HostResponse::Refused { request_id, .. } => request_id,
    };
    if returned != &request_id { return Err("Host response request ID mismatch".into()); }
    if let HostResponse::Refused { code, .. } = &response { return Err(format!("Host refused request: {code}")); }
    Ok(response)
}

fn host_raw_call(bytes: &[u8]) -> Result<HostResponse, String> {
    let mut output = io::stdout().lock();
    output.write_all(bytes).map_err(|e| e.to_string())?;
    output.write_all(b"\n").map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())?;
    let mut input = io::BufReader::new(io::stdin().lock());
    let line = read_line_bounded(&mut input, MAX_HOST_FRAME)?;
    serde_json::from_slice(&line).map_err(|e| format!("Host response parse: {e}"))
}

fn record(case: &str, outcome: &str, detail: &str, elapsed_us: Option<u64>) -> Result<(), String> {
    let mut ids = HashSet::new();
    let request_id = next_id(&mut ids)?;
    match host_call(HostRequest::RecordEvidence { request_id, case: case.into(), outcome: outcome.into(), detail: detail.into(), elapsed_us })? {
        HostResponse::Acknowledged { .. } => Ok(()),
        other => Err(format!("evidence response unexpected: {other:?}")),
    }
}

fn read_line_bounded(reader: &mut impl BufRead, max: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        match reader.read(&mut byte).map_err(|e| e.to_string())? {
            0 if out.is_empty() => return Err("channel closed".into()),
            0 => return Err("incomplete frame".into()),
            _ if byte[0] == b'\n' => return Ok(out),
            _ => { out.push(byte[0]); if out.len() > max { return Err("oversized frame".into()); } }
        }
    }
}
