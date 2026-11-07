use poc_protocol::{
    NormalizedRecord, PlanScore, ResourceProbeResult, WorkerIdentity, WorkerRequest,
    WorkerResponse, WorkerVariant, MAX_WORKER_REQUEST,
};
use std::io::{self, BufRead, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::os::windows::io::AsRawHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenAppContainerSid, TokenCapabilities, TokenIsAppContainer,
    TOKEN_APPCONTAINER_INFORMATION, TOKEN_QUERY, SID_AND_ATTRIBUTES,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_DUP_HANDLE, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_VM_READ,
};

pub fn run(variant: WorkerVariant) -> Result<(), String> {
    let mut input = io::BufReader::new(io::stdin().lock());
    let mut output = io::BufWriter::new(io::stdout().lock());
    loop {
        let frame = match read_frame(&mut input, MAX_WORKER_REQUEST) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(()),
            Err(err) => return Err(err.to_string()),
        };
        let request: WorkerRequest = serde_json::from_slice(&frame)
            .map_err(|err| format!("worker request rejected: {err}"))?;
        match request {
            WorkerRequest::Normalize { generation_id, request_id, raw } => {
                let records = normalize(&raw, variant)?;
                write_response(&mut output, WorkerResponse::Normalized { generation_id, request_id, records })?;
            }
            WorkerRequest::ScorePlan { generation_id, request_id, candidates } => {
                let mut scores: Vec<_> = candidates.into_iter().map(|c| PlanScore {
                    id: c.id,
                    score: 100u8.saturating_sub((c.estimated_cost % 101) as u8),
                }).collect();
                scores.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
                write_response(&mut output, WorkerResponse::PlanScores { generation_id, request_id, scores })?;
            }
            WorkerRequest::ProbeResources { generation_id, request_id, paths, host_pid, core_pid, host_pipe_name, network_address, child_exe } => {
                let identity = token_identity()?;
                let mut results = vec![
                    probe_file("host_private", &paths.host_private),
                    probe_write("host_private_write", &paths.host_private_dir),
                    probe_file("engine_store", &paths.engine_store),
                    probe_write("engine_store_write", &paths.engine_store_dir),
                    probe_file("test_workspace", &paths.test_workspace),
                    probe_write("test_workspace_write", &paths.test_workspace_dir),
                    probe_file("ungranted_file", &paths.ungranted_file),
                    probe_write("ungranted_dir_write", &paths.ungranted_dir),
                    probe_file("other_worker_private", &paths.other_worker_private),
                    probe_write("other_worker_private_write", &paths.other_worker_private_dir),
                    probe_pipe(&host_pipe_name),
                    probe_network(&network_address),
                ];
                results.extend(probe_process_access("host_process", host_pid));
                results.extend(probe_process_access("core_process", core_pid));
                results.push(probe_child("direct_rust_child", std::env::current_exe().ok().as_deref(), &child_exe));
                results.push(probe_child("controlled_external_child", Some(std::path::Path::new(&child_exe)), &child_exe));
                write_response(&mut output, WorkerResponse::ResourceProbe { generation_id, request_id, identity, results })?;
            }
            WorkerRequest::FaultProbe { generation_id, request_id, mode } => {
                write_response(&mut output, WorkerResponse::FaultObserved { generation_id, request_id, observation: format!("fault probe {mode} is unavailable in this Worker build") })?;
            }
            WorkerRequest::Shutdown { generation_id, request_id } => {
                write_response(&mut output, WorkerResponse::Stopped { generation_id, request_id })?;
                output.flush().map_err(|err| err.to_string())?;
                return Ok(());
            }
        }
    }
}

pub fn run_fault() -> Result<(), String> {
    let mut input = io::BufReader::new(io::stdin().lock());
    let mut output = io::BufWriter::new(io::stdout().lock());
    loop {
        let frame = match read_frame(&mut input, MAX_WORKER_REQUEST) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(()),
            Err(err) => return Err(err.to_string()),
        };
        let request: WorkerRequest = serde_json::from_slice(&frame)
            .map_err(|err| format!("worker request rejected: {err}"))?;
        match request {
            WorkerRequest::FaultProbe { generation_id, request_id, mode } => {
                match mode.as_str() {
                    "crash" => std::process::abort(),
                    "hang" => loop { std::thread::sleep(Duration::from_secs(60)); },
                    "late_after_cancel" => {
                        std::thread::sleep(Duration::from_millis(300));
                        write_response(&mut output, WorkerResponse::FaultObserved { generation_id, request_id, observation: "delayed response from cancelled request".into() })?;
                    }
                    "close_pipe" | "exit_before_response" => return Ok(()),
                    "incomplete" => {
                        output.write_all(b"{\"type\":\"Normalized\",\"generation_id\":").map_err(|e| e.to_string())?;
                        output.flush().map_err(|e| e.to_string())?;
                        return Ok(());
                    }
                    "oversized" => {
                        output.write_all(&vec![b'x'; 256 * 1024]).map_err(|e| e.to_string())?;
                        output.write_all(b"\n").map_err(|e| e.to_string())?;
                        output.flush().map_err(|e| e.to_string())?;
                        loop { std::thread::sleep(Duration::from_secs(60)); }
                    }
                    "malformed" => {
                        output.write_all(b"{nope}\n").map_err(|e| e.to_string())?;
                        output.flush().map_err(|e| e.to_string())?;
                        continue;
                    }
                    "wrong_request" => write_response(&mut output, WorkerResponse::FaultObserved { generation_id, request_id: "stale-request-id".into(), observation: "wrong request id".into() })?,
                    "wrong_generation" => write_response(&mut output, WorkerResponse::FaultObserved { generation_id: "stale-generation-id".into(), request_id, observation: "wrong generation".into() })?,
                    "forged_claim" => {
                        let payload = serde_json::json!({
                            "type": "Normalized", "generation_id": generation_id, "request_id": request_id,
                            "records": [{"key":"status","value":"ok"}], "judge_approved":true,
                            "gate_passed":true,"repair_authorized":true,"scope_granted":true,
                            "build_accepted":true,"activate_engine":true,"owner_approved":true
                        });
                        serde_json::to_writer(&mut output, &payload).map_err(|e| e.to_string())?;
                        output.write_all(b"\n").map_err(|e| e.to_string())?;
                        output.flush().map_err(|e| e.to_string())?;
                    }
                    "duplicate" => {
                        let first = WorkerResponse::FaultObserved { generation_id: generation_id.clone(), request_id: request_id.clone(), observation: "first".into() };
                        let duplicate = WorkerResponse::FaultObserved { generation_id, request_id, observation: "duplicate".into() };
                        write_response(&mut output, first)?;
                        write_response(&mut output, duplicate)?;
                    }
                    "error" => {
                        write_response(&mut output, WorkerResponse::Error { generation_id, request_id, code: "synthetic_error".into() })?;
                    }
                    other => write_response(&mut output, WorkerResponse::FaultObserved { generation_id, request_id, observation: format!("unknown fault mode {other}") })?,
                }
            }
            WorkerRequest::Shutdown { generation_id, request_id } => {
                write_response(&mut output, WorkerResponse::Stopped { generation_id, request_id })?;
                output.flush().map_err(|e| e.to_string())?;
                return Ok(());
            }
            WorkerRequest::Normalize { generation_id, request_id, raw } => {
                let records = normalize(&raw, WorkerVariant::A)?;
                write_response(&mut output, WorkerResponse::Normalized { generation_id, request_id, records })?;
            }
            _ => return Err("fault worker accepts only fault probes and shutdown".into()),
        }
    }
}

fn normalize(raw: &str, variant: WorkerVariant) -> Result<Vec<NormalizedRecord>, String> {
    if raw.len() > 16 * 1024 { return Err("normalization input exceeded 16 KiB".into()); }
    let mut out = Vec::new();
    for line in raw.lines() {
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim().to_ascii_lowercase();
            let mut value = value.trim().to_string();
            if variant == WorkerVariant::B { value = value.split_whitespace().collect::<Vec<_>>().join(" "); }
            if !key.is_empty() && !value.is_empty() {
                out.push(NormalizedRecord { key, value });
            }
        }
    }
    Ok(out)
}

fn write_response(output: &mut impl Write, response: WorkerResponse) -> Result<(), String> {
    serde_json::to_writer(&mut *output, &response).map_err(|err| err.to_string())?;
    output.write_all(b"\n").map_err(|err| err.to_string())?;
    output.flush().map_err(|err| err.to_string())
}

fn read_frame(reader: &mut impl BufRead, max: usize) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        match reader.read(&mut byte)? {
            0 if bytes.is_empty() => return Ok(None),
            0 => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "partial request")),
            _ if byte[0] == b'\n' => return Ok(Some(bytes)),
            _ => {
                bytes.push(byte[0]);
                if bytes.len() > max { return Err(io::Error::new(io::ErrorKind::InvalidData, "request too large")); }
            }
        }
    }
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
    let parsed: SocketAddr = match address.parse() {
        Ok(value) => value,
        Err(_) => return probe_result("local_network", "error", None),
    };
    match TcpStream::connect_timeout(&parsed, Duration::from_millis(300)) {
        Ok(stream) => { drop(stream); probe_result("local_network", "allowed", None) }
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => probe_result("local_network", "denied", err.raw_os_error().map(|v| v as u32)),
        Err(err) => probe_result("local_network", "error", err.raw_os_error().map(|v| v as u32)),
    }
}

fn probe_process_access(name: &str, pid: u32) -> Vec<ResourceProbeResult> {
    let tests = [
        ("query", PROCESS_QUERY_LIMITED_INFORMATION),
        ("memory", PROCESS_VM_READ),
        ("duplicate", PROCESS_DUP_HANDLE),
    ];
    tests.into_iter().map(|(suffix, access)| unsafe {
        let handle = OpenProcess(access, 0, pid);
        if handle.is_null() {
            let code = GetLastError();
            probe_result(&format!("{name}_{suffix}"), if code == 5 { "denied" } else { "error" }, Some(code))
        } else {
            let _ = CloseHandle(handle);
            probe_result(&format!("{name}_{suffix}"), "allowed", None)
        }
    }).collect()
}

fn probe_child(name: &str, executable: Option<&std::path::Path>, child_exe: &str) -> ResourceProbeResult {
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

pub fn token_identity() -> Result<WorkerIdentity, String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err(format!("OpenProcessToken: {}", GetLastError())); }
        let result = token_identity_from_handle(token);
        let _ = CloseHandle(token);
        result
    }
}

pub fn token_identity_for_process(process: HANDLE) -> Result<WorkerIdentity, String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 { return Err(format!("OpenProcessToken child: {}", GetLastError())); }
        let result = token_identity_from_handle(token);
        let _ = CloseHandle(token);
        result
    }
}

unsafe fn token_identity_from_handle(token: HANDLE) -> Result<WorkerIdentity, String> {
    let mut is_appcontainer = 0u32;
    let mut returned = 0u32;
    if GetTokenInformation(token, TokenIsAppContainer, &mut is_appcontainer as *mut _ as *mut _, std::mem::size_of_val(&is_appcontainer) as u32, &mut returned) == 0 {
        return Err(format!("TokenIsAppContainer: {}", GetLastError()));
    }
    let mut appcontainer_size = 0u32;
    let _ = GetTokenInformation(token, TokenAppContainerSid, std::ptr::null_mut(), 0, &mut appcontainer_size);
    let mut appcontainer_storage = vec![0u64; (appcontainer_size as usize + 7) / 8];
    if appcontainer_storage.is_empty() || GetTokenInformation(token, TokenAppContainerSid, appcontainer_storage.as_mut_ptr() as *mut _, appcontainer_size, &mut returned) == 0 {
        return Err(format!("TokenAppContainerSid (size={appcontainer_size}): {}", GetLastError()));
    }
    let info = *(appcontainer_storage.as_ptr() as *const TOKEN_APPCONTAINER_INFORMATION);
    let mut sid_wide = std::ptr::null_mut();
    let sid_string = if !info.TokenAppContainer.is_null() && ConvertSidToStringSidW(info.TokenAppContainer, &mut sid_wide) != 0 {
        let mut len = 0usize;
        while *sid_wide.add(len) != 0 { len += 1; }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(sid_wide, len));
        let _ = LocalFree(sid_wide as *mut _);
        text
    } else { String::new() };

    let mut needed = 0u32;
    let _ = GetTokenInformation(token, TokenCapabilities, std::ptr::null_mut(), 0, &mut needed);
    let capability_count = if needed == 0 { 0 } else {
        let words = (needed as usize + std::mem::size_of::<u64>() - 1) / std::mem::size_of::<u64>();
        let mut storage = vec![0u64; words];
        if GetTokenInformation(token, TokenCapabilities, storage.as_mut_ptr() as *mut _, needed, &mut returned) == 0 {
            return Err(format!("TokenCapabilities: {}", GetLastError()));
        }
        (returned as usize / std::mem::size_of::<SID_AND_ATTRIBUTES>()).min(words)
    };
    Ok(WorkerIdentity { is_appcontainer: is_appcontainer != 0, appcontainer_sid: sid_string, capability_count })
}

