use poc_protocol::{HostRequest, HostResponse, ProbePaths, WorkerVariant, MAX_HOST_FRAME};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::c_void;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::net::TcpListener;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree, GENERIC_READ, GENERIC_WRITE, SetHandleInformation,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::{FreeSid, GetTokenInformation, TokenAppContainerSid, TokenCapabilities, TokenElevation, TokenElevationType, TokenHasRestrictions, TokenIntegrityLevel, TokenIsAppContainer, TokenRestrictedSids, TokenSessionId, TokenUser, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES, TOKEN_APPCONTAINER_INFORMATION, TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW};
use windows_sys::Win32::Security::Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_LIMIT_PROCESS_TIME,
};
use windows_sys::Win32::System::Pipes::{CreateNamedPipeW, CreatePipe, PIPE_TYPE_BYTE, PIPE_WAIT};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, OpenProcessToken,
    GetExitCodeProcess, GetProcessTimes, InitializeProcThreadAttributeList, ResumeThread,
    UpdateProcThreadAttribute, WaitForSingleObject,
    CREATE_NO_WINDOW, CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT,
    CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};
use windows_sys::Win32::System::SystemInformation::{GetProductInfo, GetVersionExW, OSVERSIONINFOW, OSVERSIONINFOEXW};
use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Evidence {
    case: String,
    outcome: String,
    detail: String,
    elapsed_us: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ProcessRecord {
    role: String,
    pid: u32,
    profile: String,
    sid: String,
    capabilities: Vec<String>,
    inherited_handle_list: Vec<String>,
    startup_ms: u64,
    job_membership_verified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RunReport {
    schema: String,
    run_id: String,
    started_utc_unix_ms: u128,
    os: OsInfo,
    toolchain: ToolchainInfo,
    machine: MachineInfo,
    repository: RepositoryInfo,
    elevated: Option<bool>,
    host_integrity_rid: Option<u32>,
    host_pid: u32,
    experiment_root: String,
    synthetic_fixture_root: String,
    network_endpoint: String,
    host_pipe_name: String,
    sandbox: SandboxConfig,
    processes: Vec<ProcessRecord>,
    appcontainer_profiles_created: Vec<String>,
    evidence: Vec<Evidence>,
    binary_hashes: BinaryHashes,
    cleanup: Vec<String>,
    finished: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct OsInfo { version: String, edition: String, build: String, display_version: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ToolchainInfo { rustc: String, cargo: String, active_toolchain: String, target: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
struct MachineInfo { processor: String, architecture: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
struct RepositoryInfo { branch: String, head: String, dirty_paths_at_snapshot: usize, experiment_source_sha256: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
struct SandboxConfig {
    mechanism: String,
    appcontainer_capabilities: Vec<String>,
    explicit_filesystem_grants: Vec<String>,
    network_grant: bool,
    handle_policy: String,
    job_limits: Vec<String>,
    worker_process_policy: String,
    environment_allowlist: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct BinaryHashes { host: String, core: String, worker_a: String, worker_b: String, worker_fault: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LauncherPreflight {
    schema: String,
    captured_utc_unix_ms: u128,
    stage: String,
    process_id: u32,
    token_is_appcontainer: Option<bool>,
    integrity_rid: Option<u32>,
    token_elevation_type: Option<i32>,
    elevated: Option<bool>,
    token_has_restrictions: Option<bool>,
    restricted_sid_count: Option<u32>,
    appcontainer_sid: Option<String>,
    capability_count: Option<u32>,
    user_name: Option<String>,
    user_sid: Option<String>,
    session_id: Option<u32>,
    token_query_errors: Vec<String>,
    os_kernel_version: Option<String>,
    os_platform_id: Option<u32>,
    os_product_type: Option<u8>,
    os_product_info: Option<u32>,
    get_version_ex: Option<String>,
    registry_product_name: Option<String>,
    registry_build: Option<String>,
    registry_display_version: Option<String>,
    winver_observation: String,
    windows_11_client_build: Option<bool>,
    ordinary_desktop_user_token: bool,
    os_query_errors: Vec<String>,
    decision: String,
}

struct Handle(HANDLE);
unsafe impl Send for Handle {}
impl Handle {
    fn raw(&self) -> HANDLE { self.0 }
    fn close(&mut self) { if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE { unsafe { let _ = CloseHandle(self.0); } self.0 = std::ptr::null_mut(); } }
}
impl Drop for Handle { fn drop(&mut self) { self.close(); } }

struct OwnedSid(*mut c_void);
impl Drop for OwnedSid {
    fn drop(&mut self) {
        if !self.0.is_null() { unsafe { let _ = FreeSid(self.0); } self.0 = std::ptr::null_mut(); }
    }
}

struct ManagedProcess {
    process: Handle,
    job: Handle,
    pid: u32,
    appcontainer_name: String,
    generation_id: String,
    job_membership_verified: bool,
}

struct StopOutcome {
    armed_at: Instant,
    terminate_error: Option<u32>,
    process_wait_status: u32,
    active_processes_after_stop: Option<u32>,
}

struct StopMonitor {
    cancel: Arc<AtomicBool>,
    outcome: Arc<Mutex<Option<StopOutcome>>>,
    join: Option<std::thread::JoinHandle<()>>,
}
impl StopMonitor {
    fn new(core: &ManagedProcess, armed: Arc<AtomicBool>) -> Result<Self, String> {
        let duplicate = |source: HANDLE| -> Result<Handle, String> {
            let mut target = std::ptr::null_mut();
            unsafe {
                if DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &mut target, 0, 0, DUPLICATE_SAME_ACCESS) == 0 {
                    return Err(format!("DuplicateHandle for Host Stop monitor: {}", GetLastError()));
                }
            }
            Ok(Handle(target))
        };
        let job = duplicate(core.job.raw())?;
        let process = duplicate(core.process.raw())?;
        let cancel = Arc::new(AtomicBool::new(false));
        let outcome = Arc::new(Mutex::new(None));
        let thread_cancel = Arc::clone(&cancel);
        let thread_outcome = Arc::clone(&outcome);
        let join = std::thread::spawn(move || {
            while !thread_cancel.load(Ordering::Acquire) && !armed.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(5)); }
            if thread_cancel.load(Ordering::Acquire) { return; }
            let armed_at = Instant::now();
            let delay_end = armed_at + Duration::from_millis(250);
            while Instant::now() < delay_end && !thread_cancel.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(5)); }
            if thread_cancel.load(Ordering::Acquire) { return; }
            let terminate_ok = unsafe { TerminateJobObject(job.raw(), 0xD362) } != 0;
            let terminate_error = if terminate_ok { None } else { Some(unsafe { GetLastError() }) };
            let wait_status = unsafe { WaitForSingleObject(process.raw(), 3000) };
            let active = query_active_processes(job.raw()).ok();
            if let Ok(mut slot) = thread_outcome.lock() {
                *slot = Some(StopOutcome { armed_at, terminate_error, process_wait_status: wait_status, active_processes_after_stop: active });
            }
        });
        Ok(Self { cancel, outcome, join: Some(join) })
    }

    fn finish(&mut self) -> Option<StopOutcome> {
        self.cancel.store(true, Ordering::Release);
        if let Some(join) = self.join.take() { let _ = join.join(); }
        self.outcome.lock().ok().and_then(|mut slot| slot.take())
    }
}
impl Drop for StopMonitor { fn drop(&mut self) { let _ = self.finish(); } }
impl ManagedProcess {
    fn terminate_and_wait(&mut self, code: u32, timeout: Duration) -> Result<(u32, u64, u32), String> {
        let start = Instant::now();
        let state = unsafe { WaitForSingleObject(self.process.raw(), 0) };
        if state != WAIT_OBJECT_0 {
            unsafe { if TerminateJobObject(self.job.raw(), code) == 0 { return Err(format!("TerminateJobObject failed: {}", GetLastError())); } }
        }
        let waited = unsafe { WaitForSingleObject(self.process.raw(), timeout.as_millis().min(u32::MAX as u128) as u32) };
        if waited != WAIT_OBJECT_0 { return Err(format!("process {} did not exit after Job termination (wait={waited})", self.pid)); }
        let mut exit_code = 0u32;
        unsafe { if GetExitCodeProcess(self.process.raw(), &mut exit_code) == 0 { return Err(format!("GetExitCodeProcess failed: {}", GetLastError())); } }
        let active = query_active_processes(self.job.raw()).unwrap_or(u32::MAX);
        Ok((exit_code, start.elapsed().as_millis() as u64, active))
    }
}

struct HostState {
    report: RunReport,
    experiment_root: PathBuf,
    fixtures: ProbePaths,
    child_exe: String,
    network_address: String,
    pipe_name: String,
    pipe_server: Handle,
    active_worker: Option<ManagedProcess>,
    core: Option<ManagedProcess>,
    profiles: Vec<String>,
    seen_request_ids: HashSet<String>,
    denied_network_accepts: Arc<AtomicUsize>,
    stop_network: Arc<AtomicBool>,
    network_thread: Option<std::thread::JoinHandle<()>>,
    stop_armed: Arc<AtomicBool>,
    original_core_hash: String,
    original_host_hash: String,
}

struct FixtureCleanupGuard { experiment_root: PathBuf, fixture_path: PathBuf }
impl FixtureCleanupGuard {
    fn remove(&self) -> Result<bool, String> {
        let fixtures_root = self.experiment_root.join("fixtures");
        let safe_name = self.fixture_path.file_name().and_then(|v| v.to_str())
            .and_then(|v| v.strip_prefix("run-"))
            .map(|v| v.len() == 8 && v.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
            .unwrap_or(false);
        if self.fixture_path.parent() != Some(fixtures_root.as_path()) || !safe_name {
            return Err(format!("refused fixture cleanup outside exact fixtures/run-<8 lowercase hex> path: {}", self.fixture_path.display()));
        }
        let metadata = match fs::symlink_metadata(&self.fixture_path) {
            Ok(value) => value,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(err) => return Err(format!("inspect fixture path {}: {err}", self.fixture_path.display())),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(format!("refused fixture cleanup because path is not a plain directory: {}", self.fixture_path.display()));
        }
        fs::remove_dir_all(&self.fixture_path).map_err(|e| format!("remove exact fixture directory {}: {e}", self.fixture_path.display()))?;
        Ok(true)
    }
}
impl Drop for FixtureCleanupGuard {
    fn drop(&mut self) {
        if let Err(err) = self.remove() {
            let evidence = self.experiment_root.join("evidence");
            let _ = fs::create_dir_all(&evidence);
            let _ = fs::write(evidence.join("fixture-cleanup-failure.txt"), err);
        }
    }
}

fn main() {
    let mode = std::env::args().nth(1);
    if mode.as_deref() == Some("--preflight") {
        std::process::exit(preflight_mode());
    }
    if mode.as_deref() == Some("--profile-diagnostic") { std::process::exit(profile_diagnostic_mode()); }
    if let Err(err) = run() {
        let host_identity = token_identity_for_process(unsafe { GetCurrentProcess() });
        let (elevated, integrity) = host_token_summary();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(root) = exe.parent().and_then(Path::parent).and_then(Path::parent) {
                let dir = root.join("evidence");
                let _ = fs::create_dir_all(&dir);
                let _ = fs::write(dir.join("launcher-failure.txt"), format!("{err}\nHost token: elevated={elevated:?}; integrity_rid={integrity:?}; appcontainer_identity={host_identity:?}\n"));
            }
        }
        eprintln!("poc-host failed: {err}");
        std::process::exit(2);
    }
}

fn preflight_mode() -> i32 {
    let root = match experiment_root() {
        Ok(path) => path,
        Err(err) => { eprintln!("launcher preflight failed: {err}"); return 4; }
    };
    match write_launcher_preflight(&root, "standalone_preflight") {
        Ok(preflight) => {
            println!("{}", serde_json::to_string_pretty(&preflight).unwrap_or_else(|_| "{}".into()));
            if preflight.token_is_appcontainer == Some(true) { return 3; }
            if preflight.elevated == Some(true) || preflight.integrity_rid != Some(8192) || preflight.token_has_restrictions != Some(false) { return 5; }
            if preflight.decision != "READY" { return 4; }
            0
        }
        Err(err) => { eprintln!("launcher preflight failed: {err}"); 4 }
    }
}

fn profile_diagnostic_mode() -> i32 {
    let root = match experiment_root() { Ok(path) => path, Err(err) => { eprintln!("profile diagnostic failed: {err}"); return 4; } };
    let preflight = match write_launcher_preflight(&root, "profile_diagnostic_gate") { Ok(value) => value, Err(err) => { eprintln!("profile diagnostic preflight failed: {err}"); return 4; } };
    let gate = preflight_exit_code(&preflight);
    if gate != 0 {
        println!("{}", serde_json::to_string_pretty(&preflight).unwrap_or_else(|_| "{}".into()));
        return gate;
    }

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("d3v3diag{}", &suffix[..12]);
    let display = "Deszo temporary API diagnostic";
    let description = "Harmless short-string profile for the isolated Variant 3 launcher diagnostic.";
    let n = wide(&name);
    let d = wide(display);
    let desc = wide(description);
    let mut sid = std::ptr::null_mut();
    let hresult = unsafe { CreateAppContainerProfile(n.as_ptr(), d.as_ptr(), desc.as_ptr(), std::ptr::null(), 0, &mut sid) };
    let sid_value = if sid.is_null() { None } else { sid_to_string(sid).ok() };
    let profile_created_or_returned = hresult >= 0 || !sid.is_null();
    if !sid.is_null() { unsafe { let _ = FreeSid(sid); } }
    let cleanup_hresult = if profile_created_or_returned {
        Some(unsafe { DeleteAppContainerProfile(n.as_ptr()) })
    } else { None };
    let record = serde_json::json!({
        "schema": "deszo-v3-profile-diagnostic/1",
        "captured_utc_unix_ms": SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_millis()).unwrap_or(0),
        "preflight_process_id": std::process::id(),
        "api": "CreateAppContainerProfile",
        "profile_name": name,
        "profile_name_encoding": "UTF-16LE PCWSTR with terminating NUL",
        "profile_name_utf16_units_excluding_nul": name.encode_utf16().count(),
        "profile_name_terminated": n.last() == Some(&0),
        "display_name": display,
        "display_name_utf16_units_excluding_nul": display.encode_utf16().count(),
        "display_name_terminated": d.last() == Some(&0),
        "description": description,
        "description_utf16_units_excluding_nul": description.encode_utf16().count(),
        "description_terminated": desc.last() == Some(&0),
        "string_pointers_nonnull": !n.is_empty() && !d.is_empty() && !desc.is_empty(),
        "pCapabilities_is_null": true,
        "dwCapabilityCount": 0,
        "ppSidAppContainerSid_initially_null": true,
        "hresult": format!("0x{:08x}", hresult as u32),
        "sid_returned": !sid.is_null(),
        "sid": sid_value,
        "profile_created_or_sid_returned": profile_created_or_returned,
        "cleanup_attempted": cleanup_hresult.is_some(),
        "cleanup_hresult": cleanup_hresult.map(|v| format!("0x{:08x}", v as u32)),
        "cleanup_succeeded": cleanup_hresult.map(|v| v >= 0),
    });
    let path = root.join("evidence").join("profile-diagnostic.json");
    if let Err(err) = fs::write(&path, serde_json::to_vec_pretty(&record).unwrap_or_default()) {
        eprintln!("profile diagnostic evidence write failed: {err}");
        return 4;
    }
    println!("{}", serde_json::to_string_pretty(&record).unwrap_or_else(|_| "{}".into()));
    if hresult < 0 { 6 } else if cleanup_hresult.map(|v| v >= 0).unwrap_or(false) { 0 } else { 7 }
}

fn preflight_exit_code(preflight: &LauncherPreflight) -> i32 {
    if preflight.token_is_appcontainer == Some(true) { 3 }
    else if preflight.elevated == Some(true) || preflight.integrity_rid != Some(8192) || preflight.token_has_restrictions != Some(false) { 5 }
    else if preflight.decision != "READY" { 4 }
    else { 0 }
}

fn run() -> Result<(), String> {
    let root = experiment_root()?;
    let preflight = write_launcher_preflight(&root, "run_gate")?;
    if preflight.decision != "READY" {
        return Err(format!("launcher preflight blocked before fixture creation or CreateAppContainerProfile: {}", preflight.decision));
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let fixture_root = root.join("fixtures").join(format!("run-{}", &run_id[..8]));
    let fixture_guard = FixtureCleanupGuard { experiment_root: root.clone(), fixture_path: fixture_root.clone() };
    let fixture = create_fixtures(&fixture_root)?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("controlled endpoint bind: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let network_address = listener.local_addr().map_err(|e| e.to_string())?.to_string();
    let denied_network_accepts = Arc::new(AtomicUsize::new(0));
    let stop_network = Arc::new(AtomicBool::new(false));
    let pipe_name = format!("DeszoV3Private-{}", &run_id[..12]);
    let pipe_server = create_private_named_pipe(&pipe_name)?;
    let child_exe = root.join("target").join("release").join("poc-worker-b.exe").to_string_lossy().to_string();
    let hashes = binary_hashes(&root)?;
    let host_token = host_token_summary();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let accept_count = Arc::clone(&denied_network_accepts);
    let stop_flag = Arc::clone(&stop_network);
    let network_thread = std::thread::spawn(move || while !stop_flag.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => { accept_count.fetch_add(1, Ordering::AcqRel); let _ = stream.shutdown(std::net::Shutdown::Both); }
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    });

    let report = RunReport {
        schema: "deszo-v3-feasibility-run/1".into(), run_id: run_id.clone(), started_utc_unix_ms: now,
        os: read_os_info(&root), toolchain: read_toolchain_info(&root), machine: read_machine_info(&root), repository: read_repository_info(&root), elevated: host_token.0, host_integrity_rid: host_token.1,
        host_pid: std::process::id(), experiment_root: root.to_string_lossy().to_string(), synthetic_fixture_root: fixture_root.to_string_lossy().to_string(),
        network_endpoint: network_address.clone(), host_pipe_name: pipe_name.clone(),
        sandbox: SandboxConfig { mechanism: "Windows AppContainer SECURITY_CAPABILITIES with zero capabilities + per-process Job Object".into(), appcontainer_capabilities: vec![], explicit_filesystem_grants: vec![], network_grant: false,
            handle_policy: "CreateProcessW EXTENDED_STARTUPINFO_PRESENT; PROC_THREAD_ATTRIBUTE_HANDLE_LIST; only stdio pipe handles and NUL stderr; Worker receives no Host control channel or process handle".into(),
            job_limits: vec!["KILL_ON_JOB_CLOSE".into(), "ACTIVE_PROCESS=1".into(), "PROCESS_MEMORY=256MiB".into(), "PROCESS_TIME=15s user time".into()], worker_process_policy: "No breakaway flags; one active process per Job; child launch should be refused; providers remain Host Custody launches".into(), environment_allowlist: vec!["SystemRoot", "WINDIR"].into_iter().map(str::to_string).collect() },
        processes: vec![], appcontainer_profiles_created: vec![], evidence: vec![], binary_hashes: hashes.clone(), cleanup: vec![], finished: false,
    };
    let mut state = HostState {
        report, experiment_root: root.clone(), fixtures: fixture, child_exe, network_address, pipe_name,
        pipe_server, active_worker: None, core: None, profiles: vec![], seen_request_ids: HashSet::new(),
        denied_network_accepts, stop_network, network_thread: Some(network_thread),
        stop_armed: Arc::new(AtomicBool::new(false)),
        original_core_hash: hashes.core.clone(), original_host_hash: hashes.host.clone(),
    };
    state.evidence("host_environment", "OBSERVED", &format!("elevated={:?}; integrity_rid={:?}; OS={:?}; rust={:?}; sandbox={:?}", state.report.elevated, state.report.host_integrity_rid, state.report.os, state.report.toolchain, state.report.sandbox), None);

    let mut pipes = create_duplex_pipes()?;
    let (core_exe, _) = executable_paths(&root);
    let core_profile = format!("d3v3{}core", &run_id.replace('-', "")[..12]);
    state.profiles.push(core_profile.clone());
    state.report.appcontainer_profiles_created.push(core_profile.clone());
    let start = Instant::now();
    let core = launch_appcontainer(&core_exe, &[], &core_profile, Some(pipes.child_read.raw()), Some(pipes.child_write.raw()), &system_directory(), 1)?;
    let startup_ms = start.elapsed().as_millis() as u64;
    let core_identity = token_identity_for_process(core.process.raw()).ok();
    let core_sid = core_identity.as_ref().map(|v| v.appcontainer_sid.clone()).unwrap_or_default();
    let core_caps = core_identity.as_ref().map(|v| v.capability_count).unwrap_or(usize::MAX);
    state.report.processes.push(process_record("protected_core", &core, startup_ms, core_sid, core_caps, vec!["stdin:Host control pipe", "stdout:Host control pipe", "stderr:NUL"].into_iter().map(str::to_string).collect()));
    state.evidence("core_appcontainer_token", if core_identity.as_ref().map(|v| v.is_appcontainer && v.capability_count == 0).unwrap_or(false) { "PASS" } else { "FAIL" }, &format!("token={core_identity:?}; profile={core_profile}; explicit grants=0; network grant=false"), None);
    state.core = Some(core);
    pipes.close_child_ends();
    let mut to_core = unsafe { fs::File::from_raw_handle(pipes.host_write.take().ok_or("missing Core stdin handle")? as RawHandle) };
    let from_core = unsafe { fs::File::from_raw_handle(pipes.host_read.take().ok_or("missing Core stdout handle")? as RawHandle) };
    let mut reader = io::BufReader::new(from_core);
    let mut stop_monitor = StopMonitor::new(state.core.as_ref().ok_or("Core missing after launch")?, Arc::clone(&state.stop_armed))?;

    let mut finish_seen = false;
    loop {
        let line = match read_frame(&mut reader, MAX_HOST_FRAME) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(FrameReadError::TooLarge) => {
                send_response(&mut to_core, &HostResponse::Refused { request_id: "unknown".into(), code: "oversized_host_frame".into() })?;
                continue;
            }
            Err(FrameReadError::Partial) => break,
            Err(FrameReadError::Io(e)) => return Err(e),
        };
        let parsed: Result<HostRequest, _> = serde_json::from_slice(&line);
        let request = match parsed {
            Ok(request) => request,
            Err(err) => {
                let id = serde_json::from_slice::<serde_json::Value>(&line).ok().and_then(|v| v.get("request_id").and_then(|v| v.as_str()).map(str::to_string)).unwrap_or_default();
                state.evidence("host_malformed_request", "PASS", &format!("refused malformed/unknown frame: {err}"), None);
                send_response(&mut to_core, &HostResponse::Refused { request_id: id, code: "unknown_or_malformed_message".into() })?;
                continue;
            }
        };
        let request_id = request_id(&request).to_string();
        if !state.seen_request_ids.insert(request_id.clone()) {
            send_response(&mut to_core, &HostResponse::Refused { request_id, code: "replayed_request_id".into() })?;
            continue;
        }
        match request {
            HostRequest::GetEnvironment { request_id } => {
                let response = HostResponse::Environment {
                    request_id, paths: state.fixtures.clone(), host_pid: state.report.host_pid,
                    host_pipe_name: state.pipe_name.clone(), network_address: state.network_address.clone(), child_exe: state.child_exe.clone(),
                };
                send_response(&mut to_core, &response)?;
            }
            HostRequest::RecordEvidence { request_id, case, outcome, detail, elapsed_us } => {
                if case.len() > 256 || outcome.len() > 32 || detail.len() > 4096 {
                    send_response(&mut to_core, &HostResponse::Refused { request_id, code: "evidence_bounds".into() })?;
                } else {
                    let stop_stall_ready = case == "host_stop_stall_ready" && outcome == "OBSERVED";
                    state.evidence(&case, &outcome, &detail, elapsed_us);
                    send_response(&mut to_core, &HostResponse::Acknowledged { request_id })?;
                    if stop_stall_ready { state.stop_armed.store(true, Ordering::Release); }
                }
            }
            HostRequest::StartWorker { request_id, variant } => {
                if state.active_worker.is_some() {
                    send_response(&mut to_core, &HostResponse::Refused { request_id, code: "worker_already_running".into() })?;
                    continue;
                }
                match state.start_worker(variant) {
                    Ok((process, remote_read, remote_write, working_set_kb, worker_startup_ms)) => {
                        let response = HostResponse::WorkerStarted { request_id, generation_id: process.generation_id.clone(), read_handle: remote_read as usize as u64,
                            write_handle: remote_write as usize as u64, pid: process.pid, appcontainer_name: process.appcontainer_name.clone(), startup_ms: worker_startup_ms, working_set_kb };
                        state.active_worker = Some(process);
                        send_response(&mut to_core, &response)?;
                    }
                    Err(err) => {
                        state.evidence("worker_launch", "FAIL", &err, None);
                        send_response(&mut to_core, &HostResponse::Refused { request_id, code: "worker_launch_failed".into() })?;
                    }
                }
            }
            HostRequest::StopWorker { request_id, generation_id, reason } => {
                let Some(mut process) = state.active_worker.take() else {
                    send_response(&mut to_core, &HostResponse::Refused { request_id, code: "no_worker".into() })?;
                    continue;
                };
                if process.generation_id != generation_id {
                    state.active_worker = Some(process);
                    send_response(&mut to_core, &HostResponse::Refused { request_id, code: "worker_generation_mismatch".into() })?;
                    continue;
                }
                let cpu_us = process_cpu_us(process.process.raw()).unwrap_or(0);
                let working_set_kb = process_working_set_kb(process.process.raw()).unwrap_or(0);
                let (exit_code, elapsed_ms, active_processes_after_stop) = process.terminate_and_wait(0xD35A, Duration::from_secs(3))?;
                state.evidence("worker_job_cleanup", if active_processes_after_stop == 0 { "PASS" } else { "FAIL" }, &format!("reason={reason}; pid={}; exit_code={exit_code}; active={active_processes_after_stop}; working_set_kb={working_set_kb}; cpu_us={cpu_us}", process.pid), Some(elapsed_ms * 1000));
                state.delete_profile(&process.appcontainer_name);
                send_response(&mut to_core, &HostResponse::WorkerStopped { request_id, generation_id, exit_code, elapsed_ms, cpu_us, working_set_kb, active_processes_after_stop })?;
            }
            HostRequest::Finish { request_id } => {
                finish_seen = true;
                send_response(&mut to_core, &HostResponse::Acknowledged { request_id })?;
                break;
            }
        }
    }
    drop(to_core);
    let stop_outcome = stop_monitor.finish();
    let mut worker_cleanup_clean = state.active_worker.is_none();
    if let Some(mut worker) = state.active_worker.take() {
        match worker.terminate_and_wait(0xD35B, Duration::from_secs(3)) {
            Ok((exit_code, elapsed_ms, active)) => {
                worker_cleanup_clean = active == 0;
                state.evidence("worker_job_cleanup", if worker_cleanup_clean { "PASS" } else { "FAIL" }, &format!("Host-owned cleanup after Core channel closed; pid={}; exit_code={exit_code}; elapsed_ms={elapsed_ms}; active_processes_after_stop={active}", worker.pid), Some(elapsed_ms * 1000));
            }
            Err(err) => { worker_cleanup_clean = false; state.evidence("worker_job_cleanup", "FAIL", &err, None); }
        }
        state.delete_profile(&worker.appcontainer_name);
    }
    let mut core_cleanup_clean = state.core.is_none();
    if let Some(core) = state.core.take() {
        let mut wait = unsafe { WaitForSingleObject(core.process.raw(), 3000) };
        if wait != WAIT_OBJECT_0 {
            unsafe { let _ = TerminateJobObject(core.job.raw(), 0xD35C); wait = WaitForSingleObject(core.process.raw(), 3000); }
        }
        let active = query_active_processes(core.job.raw()).ok();
        core_cleanup_clean = wait == WAIT_OBJECT_0 && active == Some(0);
        state.evidence("core_host_cleanup", if core_cleanup_clean { "PASS" } else { "FAIL" }, &format!("Host custody cleanup; wait_status={wait}; active_processes_after_stop={active:?}"), None);
        state.delete_profile(&core.appcontainer_name);
    }
    for name in state.profiles.clone() { state.delete_profile(&name); }
    run_core_hang_probe(&mut state)?;
    let network_reached = state.denied_network_accepts.load(Ordering::Acquire);
    state.evidence("controlled_network_endpoint", if network_reached == 0 { "PASS" } else { "FAIL" }, &format!("accept_count={network_reached}; endpoint={}", state.network_address), None);
    if state.original_core_hash != sha256_file(&executable_paths(&root).0)? || state.original_host_hash != sha256_file(&std::env::current_exe().map_err(|e| e.to_string())?)? {
        state.evidence("protected_binary_hash_stability", "FAIL", "Host or Core binary hash changed during Worker A/B replacement", None);
    } else {
        state.evidence("protected_binary_hash_stability", "PASS", "Host and Core hashes unchanged across Worker A/B", None);
    }
    state.report.cleanup.push(format!("appcontainer_profiles_deleted={}", state.profiles.is_empty()));
    state.report.cleanup.push(format!("worker_process_absent={}", state.active_worker.is_none()));
    state.report.cleanup.push(format!("core_process_absent={}", state.core.is_none()));
    if let Some(outcome) = stop_outcome {
        let profiles_clean = state.profiles.is_empty();
        let stop_clean = outcome.terminate_error.is_none() && outcome.process_wait_status == WAIT_OBJECT_0
            && outcome.active_processes_after_stop == Some(0) && worker_cleanup_clean && core_cleanup_clean && profiles_clean;
        let elapsed_ms = outcome.armed_at.elapsed().as_millis() as u64;
        state.evidence("host_stop_stalled_ordinary_channel", if stop_clean { "PASS" } else { "FAIL" },
            &format!("ordinary Host/Core channel carried the stall-ready marker then Core stopped reading; Host-owned out-of-band Stop called TerminateJobObject after 250ms; termination_error={:?}; core_wait_status={}; core_job_active_after_stop={:?}; worker_job_cleanup={worker_cleanup_clean}; core_cleanup={core_cleanup_clean}; profiles_clean={profiles_clean}; total_ms={elapsed_ms}", outcome.terminate_error, outcome.process_wait_status, outcome.active_processes_after_stop), Some(elapsed_ms * 1000));
        if stop_clean { finish_seen = true; }
    } else {
        state.evidence("host_stop_stalled_ordinary_channel", "FAIL", "Core did not reach the stall-ready marker and no independent Host Stop outcome was recorded", None);
    }
    state.report.finished = finish_seen;
    state.stop_network.store(true, Ordering::Release);
    if let Some(join) = state.network_thread.take() { let _ = join.join(); }
    state.pipe_server.close();
    match fixture_guard.remove() {
        Ok(true) => state.evidence("synthetic_fixture_cleanup", "PASS", &format!("removed only this run's fixture directory {}", fixture_root.display()), None),
        Ok(false) => state.evidence("synthetic_fixture_cleanup", "FAIL", "run fixture directory was already absent before normal cleanup", None),
        Err(err) => state.evidence("synthetic_fixture_cleanup", "FAIL", &err, None),
    }
    write_report(&root, &state.report)?;
    print_summary(&state.report);
    Ok(())
}

impl HostState {
    fn evidence(&mut self, case: &str, outcome: &str, detail: &str, elapsed_us: Option<u64>) {
        self.report.evidence.push(Evidence { case: case.into(), outcome: outcome.into(), detail: detail.chars().take(4096).collect(), elapsed_us });
    }

    fn start_worker(&mut self, variant: WorkerVariant) -> Result<(ManagedProcess, HANDLE, HANDLE, u64, u64), String> {
        let generation_id = uuid::Uuid::new_v4().to_string();
        let name = format!("d3v3{}w{}", &self.report.run_id.replace('-', "")[..8], &generation_id.replace('-', "")[..8]);
        self.profiles.push(name.clone());
        self.report.appcontainer_profiles_created.push(name.clone());
        let binary_name = match variant { WorkerVariant::A => "poc-worker-a.exe", WorkerVariant::B => "poc-worker-b.exe", WorkerVariant::Fault => "poc-worker-fault.exe" };
        let exe = self.experiment_root.join("target").join("release").join(binary_name);
        let (mut worker_stdin_read, mut core_worker_write, mut core_worker_read, mut worker_stdout_write) = (Handle(std::ptr::null_mut()), Handle(std::ptr::null_mut()), Handle(std::ptr::null_mut()), Handle(std::ptr::null_mut()));
        let sa = inherit_security_attributes();
        unsafe {
            if CreatePipe(&mut worker_stdin_read.0, &mut core_worker_write.0, &sa, 0) == 0 { return Err(format!("CreatePipe worker stdin: {}", GetLastError())); }
            if CreatePipe(&mut core_worker_read.0, &mut worker_stdout_write.0, &sa, 0) == 0 { return Err(format!("CreatePipe worker stdout: {}", GetLastError())); }
        }
        clear_inherit(core_worker_write.raw())?;
        clear_inherit(core_worker_read.raw())?;
        let worker_start = Instant::now();
        let mut process = launch_appcontainer(&exe, &[], &name, Some(worker_stdin_read.raw()), Some(worker_stdout_write.raw()), &system_directory(), 1)?;
        process.generation_id = generation_id.clone();
        worker_stdin_read.close();
        worker_stdout_write.close();
        let core = self.core.as_ref().ok_or("Core is not running")?;
        let remote_read = duplicate_into_process(core.process.raw(), core_worker_read.raw())?;
        let remote_write = duplicate_into_process(core.process.raw(), core_worker_write.raw())?;
        core_worker_read.close();
        core_worker_write.close();
        let startup_ms = worker_start.elapsed().as_millis() as u64;
        let working_set_kb = process_working_set_kb(process.process.raw()).unwrap_or(0);
        let identity = token_identity_for_process(process.process.raw()).ok();
        let sid = identity.as_ref().map(|v| v.appcontainer_sid.clone()).unwrap_or_default();
        let caps = identity.as_ref().map(|v| v.capability_count).unwrap_or(usize::MAX);
        let appcontainer = identity.as_ref().map(|v| v.is_appcontainer).unwrap_or(false);
        self.report.processes.push(process_record("repairable_worker", &process, startup_ms, sid.clone(), caps, vec!["stdin:Core pipe", "stdout:Core pipe", "stderr:NUL"].into_iter().map(str::to_string).collect()));
        self.evidence("worker_appcontainer", if !sid.is_empty() && appcontainer && caps == 0 { "PASS" } else { "FAIL" }, &format!("variant={variant:?}; profile={name}; token_sid={sid}; appcontainer={appcontainer}; capability_count={caps}; explicit_grants=0; network=false"), None);
        Ok((process, remote_read, remote_write, working_set_kb, startup_ms))
    }

    fn delete_profile(&mut self, name: &str) {
        let wide = wide(name);
        let result = unsafe { DeleteAppContainerProfile(wide.as_ptr()) };
        let cleanup_record = serde_json::json!({
            "api": "DeleteAppContainerProfile",
            "profile_name": name,
            "profile_name_encoding": "UTF-16LE PCWSTR with terminating NUL",
            "profile_name_terminated": wide.last() == Some(&0),
            "hresult": format!("0x{:08x}", result as u32),
            "cleanup_succeeded": result >= 0,
        });
        let _ = append_jsonl(&self.experiment_root, "profile-api-cleanup.jsonl", &cleanup_record);
        if result >= 0 {
            self.profiles.retain(|p| p != name);
            self.evidence("appcontainer_profile_cleanup", "PASS", &format!("deleted exact PoC profile {name}"), None);
        } else {
            self.evidence("appcontainer_profile_cleanup", "FAIL", &format!("DeleteAppContainerProfile({name}) HRESULT=0x{:08x}", result as u32), None);
        }
    }
}

impl Drop for HostState {
    fn drop(&mut self) {
        if let Some(mut process) = self.active_worker.take() {
            let _ = process.terminate_and_wait(0xD35F, Duration::from_secs(3));
        }
        if let Some(mut process) = self.core.take() {
            let _ = process.terminate_and_wait(0xD360, Duration::from_secs(3));
        }
        self.stop_network.store(true, Ordering::Release);
        if let Some(join) = self.network_thread.take() { let _ = join.join(); }
        for name in self.profiles.clone() {
            let wide = wide(&name);
            unsafe { let _ = DeleteAppContainerProfile(wide.as_ptr()); }
        }
    }
}

struct DuplexPipes { child_read: Handle, host_write: Option<HANDLE>, host_read: Option<HANDLE>, child_write: Handle }
impl DuplexPipes {
    fn close_child_ends(&mut self) { self.child_read.close(); self.child_write.close(); }
}
impl Drop for DuplexPipes { fn drop(&mut self) { self.child_read.close(); self.child_write.close(); if let Some(h) = self.host_write.take() { unsafe { let _ = CloseHandle(h); } } if let Some(h) = self.host_read.take() { unsafe { let _ = CloseHandle(h); } } } }

fn create_duplex_pipes() -> Result<DuplexPipes, String> {
    let mut child_read = Handle(std::ptr::null_mut());
    let mut host_write = Handle(std::ptr::null_mut());
    let mut host_read = Handle(std::ptr::null_mut());
    let mut child_write = Handle(std::ptr::null_mut());
    let sa = inherit_security_attributes();
    unsafe {
        if CreatePipe(&mut child_read.0, &mut host_write.0, &sa, 0) == 0 { return Err(format!("CreatePipe host->core: {}", GetLastError())); }
        if CreatePipe(&mut host_read.0, &mut child_write.0, &sa, 0) == 0 { return Err(format!("CreatePipe core->host: {}", GetLastError())); }
    }
    clear_inherit(host_write.raw())?;
    clear_inherit(host_read.raw())?;
    let host_write_raw = std::mem::replace(&mut host_write.0, std::ptr::null_mut());
    let host_read_raw = std::mem::replace(&mut host_read.0, std::ptr::null_mut());
    Ok(DuplexPipes { child_read, host_write: Some(host_write_raw), host_read: Some(host_read_raw), child_write })
}

fn launch_appcontainer(exe: &Path, args: &[String], profile_name: &str, stdin: Option<HANDLE>, stdout: Option<HANDLE>, current_dir: &Path, process_limit: u32) -> Result<ManagedProcess, String> {
    let app_sid = OwnedSid(create_profile(profile_name)?);
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() { return Err(format!("CreateJobObject: {}", unsafe { GetLastError() })); }
    let job = Handle(job);
    configure_job(job.raw(), process_limit)?;
    let mut null_stderr = open_nul_for_child()?;
    let mut child_handles = Vec::new();
    if let Some(handle) = stdin { child_handles.push(handle); }
    if let Some(handle) = stdout { child_handles.push(handle); }
    child_handles.push(null_stderr.raw());
    for handle in &child_handles { set_inherit(*handle, true)?; }

    let mut attributes_size = 0usize;
    unsafe { let _ = InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut attributes_size); }
    let word_count = (attributes_size + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>();
    let mut attribute_storage = vec![0usize; word_count];
    let attribute_list = attribute_storage.as_mut_ptr() as *mut _;
    unsafe { if InitializeProcThreadAttributeList(attribute_list, 2, 0, &mut attributes_size) == 0 { return Err(format!("InitializeProcThreadAttributeList: {}", GetLastError())); } }

    let security_caps = SECURITY_CAPABILITIES { AppContainerSid: app_sid.0, Capabilities: std::ptr::null_mut(), CapabilityCount: 0, Reserved: 0 };
    let handle_bytes = child_handles.len() * std::mem::size_of::<HANDLE>();
    let mut attrs_ok = true;
    unsafe {
        attrs_ok &= UpdateProcThreadAttribute(attribute_list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, &security_caps as *const _ as *const c_void, std::mem::size_of_val(&security_caps), std::ptr::null_mut(), std::ptr::null()) != 0;
        attrs_ok &= UpdateProcThreadAttribute(attribute_list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, child_handles.as_ptr() as *const c_void, handle_bytes, std::ptr::null_mut(), std::ptr::null()) != 0;
    }
    if !attrs_ok { let e = unsafe { GetLastError() }; unsafe { DeleteProcThreadAttributeList(attribute_list); } return Err(format!("UpdateProcThreadAttribute failed: {e}")); }

    let exe_wide = wide(exe.to_string_lossy().as_ref());
    let cwd_wide = wide(current_dir.to_string_lossy().as_ref());
    let mut command = quote_arg(exe.to_string_lossy().as_ref());
    for arg in args { command.push(' '); command.push_str(&quote_arg(arg)); }
    let mut command_wide = wide(&command);
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.unwrap_or(null_stderr.raw());
    startup.StartupInfo.hStdOutput = stdout.unwrap_or(null_stderr.raw());
    startup.StartupInfo.hStdError = null_stderr.raw();
    startup.lpAttributeList = attribute_list;
    let mut process_info = PROCESS_INFORMATION::default();
    let creation_start = Instant::now();
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let environment = format!("SystemRoot={system_root}\0WINDIR={system_root}\0\0");
    let environment_wide: Vec<u16> = environment.encode_utf16().collect();
    let created = unsafe {
        CreateProcessW(exe_wide.as_ptr(), command_wide.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, environment_wide.as_ptr() as *const c_void, cwd_wide.as_ptr(),
            &startup.StartupInfo, &mut process_info)
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list); }
    for handle in &child_handles { let _ = set_inherit(*handle, false); }
    null_stderr.close();
    if created == 0 { return Err(format!("CreateProcessW AppContainer {profile_name}: {}", unsafe { GetLastError() })); }
    let process = Handle(process_info.hProcess);
    let thread = Handle(process_info.hThread);
    if unsafe { AssignProcessToJobObject(job.raw(), process.raw()) } == 0 {
        let error = unsafe { GetLastError() };
        unsafe { let _ = TerminateJobObject(job.raw(), 0xD35D); let _ = WaitForSingleObject(process.raw(), 3000); }
        return Err(format!("AssignProcessToJobObject: {error}"));
    }
    let mut is_in_job = 0;
    if unsafe { IsProcessInJob(process.raw(), job.raw(), &mut is_in_job) } == 0 {
        let error = unsafe { GetLastError() };
        unsafe { let _ = TerminateJobObject(job.raw(), 0xD35E); let _ = WaitForSingleObject(process.raw(), 3000); }
        return Err(format!("IsProcessInJob query failed for assigned Job: {error}"));
    }
    if is_in_job == 0 {
        unsafe { let _ = TerminateJobObject(job.raw(), 0xD35E); let _ = WaitForSingleObject(process.raw(), 3000); }
        return Err("IsProcessInJob returned false for the assigned Job".into());
    }
    if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
        let error = unsafe { GetLastError() };
        unsafe { let _ = TerminateJobObject(job.raw(), 0xD35E); let _ = WaitForSingleObject(process.raw(), 3000); }
        return Err(format!("ResumeThread: {error}"));
    }
    drop(thread);
    let _ = creation_start;
    Ok(ManagedProcess { process, job, pid: process_info.dwProcessId, appcontainer_name: profile_name.to_string(), generation_id: uuid::Uuid::new_v4().to_string(), job_membership_verified: true })
}

fn create_profile(name: &str) -> Result<*mut c_void, String> {
    let n = wide(name);
    let display_text = "Deszo isolated feasibility process";
    let description_text = "Temporary profile created by experiments/rust-migration-v3; deleted at the end of the run.";
    let display = wide(display_text);
    let description = wide(description_text);
    let mut sid = std::ptr::null_mut();
    let no_capabilities = SID_AND_ATTRIBUTES::default();
    let result = unsafe { CreateAppContainerProfile(n.as_ptr(), display.as_ptr(), description.as_ptr(), &no_capabilities, 0, &mut sid) };
    let sid_value = if sid.is_null() { None } else { sid_to_string(sid).ok() };
    let evidence = serde_json::json!({
        "api": "CreateAppContainerProfile",
        "profile_name": name,
        "profile_name_encoding": "UTF-16LE PCWSTR with terminating NUL",
        "profile_name_utf16_units_excluding_nul": name.encode_utf16().count(),
        "profile_name_terminated": n.last() == Some(&0),
        "display_name": display_text,
        "display_name_utf16_units_excluding_nul": display_text.encode_utf16().count(),
        "display_name_terminated": display.last() == Some(&0),
        "description": description_text,
        "description_utf16_units_excluding_nul": description_text.encode_utf16().count(),
        "description_terminated": description.last() == Some(&0),
        "all_string_pointers_nonnull": !n.is_empty() && !display.is_empty() && !description.is_empty(),
        "pCapabilities_is_null": false,
        "pCapabilities_sid_initially_null": no_capabilities.Sid.is_null(),
        "dwCapabilityCount": 0,
        "ppSidAppContainerSid_initially_null": true,
        "hresult": format!("0x{:08x}", result as u32),
        "profile_creation_reported_success": result >= 0,
        "sid_returned": !sid.is_null(),
        "sid": sid_value,
    });
    if let Ok(root) = experiment_root() { let _ = append_jsonl(&root, "profile-api-calls.jsonl", &evidence); }
    if result < 0 {
        if !sid.is_null() { unsafe { let _ = FreeSid(sid); } }
        return Err(format!("CreateAppContainerProfile exact call diagnostics: {}; HRESULT=0x{:08x}", evidence, result as u32));
    }
    if sid.is_null() { return Err(format!("CreateAppContainerProfile succeeded but returned a null SID; call={evidence}")); }
    Ok(sid)
}

fn configure_job(job: HANDLE, process_limit: u32) -> Result<(), String> {
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_TIME | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    info.BasicLimitInformation.ActiveProcessLimit = process_limit;
    info.BasicLimitInformation.PerProcessUserTimeLimit = 15 * 10_000_000;
    info.ProcessMemoryLimit = 256 * 1024 * 1024;
    unsafe { if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const c_void, std::mem::size_of_val(&info) as u32) == 0 { return Err(format!("SetInformationJobObject: {}", GetLastError())); } }
    Ok(())
}

fn create_private_named_pipe(name: &str) -> Result<Handle, String> {
    let full_name = wide(&format!(r"\\.\pipe\{name}"));
    let sddl = wide("D:P(A;;GA;;;SY)");
    let mut descriptor = std::ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) == 0 { return Err(format!("SDDL conversion: {}", GetLastError())); }
    }
    let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
    let pipe = unsafe { CreateNamedPipeW(full_name.as_ptr(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, &sa) };
    unsafe { let _ = LocalFree(descriptor); }
    if pipe.is_null() || pipe == INVALID_HANDLE_VALUE { return Err(format!("CreateNamedPipeW: {}", unsafe { GetLastError() })); }
    Ok(Handle(pipe))
}

fn open_nul_for_child() -> Result<Handle, String> {
    let name = wide("NUL");
    let sa = inherit_security_attributes();
    let handle = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut()) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE { return Err(format!("CreateFileW NUL: {}", unsafe { GetLastError() })); }
    Ok(Handle(handle))
}

fn duplicate_into_process(target_process: HANDLE, source_handle: HANDLE) -> Result<HANDLE, String> {
    let mut remote = std::ptr::null_mut();
    unsafe {
        if DuplicateHandle(GetCurrentProcess(), source_handle, target_process, &mut remote, 0, 0, DUPLICATE_SAME_ACCESS) == 0 { return Err(format!("DuplicateHandle to Core failed: {}", GetLastError())); }
    }
    Ok(remote)
}

fn create_fixtures(root: &Path) -> Result<ProbePaths, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let host = root.join("host-private");
    let store = root.join("engine-store");
    let workspace = root.join("unrelated-test-workspace");
    let ungranted = root.join("ungranted");
    let other_worker = root.join("worker-two-private");
    for dir in [&host, &store, &workspace, &ungranted, &other_worker] { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    for (dir, name) in [(&host, "host-sentinel.txt"), (&store, "store-sentinel.txt"), (&workspace, "workspace-sentinel.txt"), (&ungranted, "ungranted-sentinel.txt"), (&other_worker, "worker-two-sentinel.txt")] {
        fs::write(dir.join(name), format!("synthetic feasibility sentinel: {name}\n")).map_err(|e| e.to_string())?;
    }
    Ok(ProbePaths {
        host_private: host.join("host-sentinel.txt").to_string_lossy().to_string(),
        host_private_dir: host.to_string_lossy().to_string(),
        engine_store: store.join("store-sentinel.txt").to_string_lossy().to_string(),
        engine_store_dir: store.to_string_lossy().to_string(),
        test_workspace: workspace.join("workspace-sentinel.txt").to_string_lossy().to_string(),
        test_workspace_dir: workspace.to_string_lossy().to_string(),
        ungranted_file: ungranted.join("ungranted-sentinel.txt").to_string_lossy().to_string(),
        ungranted_dir: ungranted.to_string_lossy().to_string(),
        other_worker_private: other_worker.join("worker-two-sentinel.txt").to_string_lossy().to_string(),
        other_worker_private_dir: other_worker.to_string_lossy().to_string(),
    })
}

fn process_record(role: &str, process: &ManagedProcess, startup_ms: u64, sid: String, capability_count: usize, inherited_handle_list: Vec<String>) -> ProcessRecord {
    let mut capabilities = vec![format!("capability_count={capability_count}")];
    if capability_count == 0 { capabilities.push("none".into()); }
    ProcessRecord { role: role.into(), pid: process.pid, profile: process.appcontainer_name.clone(), sid, capabilities, inherited_handle_list, startup_ms, job_membership_verified: process.job_membership_verified }
}

fn executable_paths(root: &Path) -> (PathBuf, PathBuf) { let release = root.join("target").join("release"); (release.join("poc-core.exe"), release.join("poc-host.exe")) }

fn run_core_hang_probe(state: &mut HostState) -> Result<(), String> {
    let name = format!("d3v3{}corehang", &state.report.run_id.replace('-', "")[..8]);
    state.profiles.push(name.clone());
    state.report.appcontainer_profiles_created.push(name.clone());
    let exe = executable_paths(&state.experiment_root).0;
    match launch_appcontainer(&exe, &["--host-hang-probe".into()], &name, None, None, &system_directory(), 1) {
        Ok(mut process) => {
            let identity = token_identity_for_process(process.process.raw()).ok();
            let sid = identity.as_ref().map(|i| i.appcontainer_sid.clone()).unwrap_or_default();
            let capabilities = identity.as_ref().map(|i| i.capability_count).unwrap_or(usize::MAX);
            let startup = process_working_set_kb(process.process.raw()).unwrap_or(0);
            state.report.processes.push(process_record("protected_core_hang_probe", &process, 0, sid, capabilities, vec!["stderr:NUL; no IPC handles".into()]));
            let wait = unsafe { WaitForSingleObject(process.process.raw(), 200) };
            let hung = wait == WAIT_TIMEOUT;
            let (_, elapsed_ms, active) = process.terminate_and_wait(0xD361, Duration::from_secs(3))?;
            state.evidence("core_hang_host_termination", if hung && active == 0 { "PASS" } else { "FAIL" }, &format!("pid={}; wait_status={wait}; initial_working_set_kb={startup}; elapsed_ms={elapsed_ms}; active_processes_after_stop={active}", process.pid), Some(elapsed_ms * 1000));
        }
        Err(err) => state.evidence("core_hang_host_termination", "BLOCKED", &format!("could not launch controlled Core hang probe: {err}"), None),
    }
    state.delete_profile(&name);
    Ok(())
}

fn binary_hashes(root: &Path) -> Result<BinaryHashes, String> {
    let (core, host) = executable_paths(root);
    Ok(BinaryHashes { host: sha256_file(&host)?, core: sha256_file(&core)?, worker_a: sha256_file(&root.join("target/release/poc-worker-a.exe"))?, worker_b: sha256_file(&root.join("target/release/poc-worker-b.exe"))?, worker_fault: sha256_file(&root.join("target/release/poc-worker-fault.exe"))? })
}
fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("hash {}: {e}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn process_working_set_kb(process: HANDLE) -> Result<u64, String> {
    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    unsafe { if K32GetProcessMemoryInfo(process, &mut counters, counters.cb) == 0 { return Err(format!("GetProcessMemoryInfo: {}", GetLastError())); } }
    Ok((counters.WorkingSetSize / 1024) as u64)
}
fn process_cpu_us(process: HANDLE) -> Result<u64, String> {
    let mut creation = windows_sys::Win32::Foundation::FILETIME::default();
    let mut exit = windows_sys::Win32::Foundation::FILETIME::default();
    let mut kernel = windows_sys::Win32::Foundation::FILETIME::default();
    let mut user = windows_sys::Win32::Foundation::FILETIME::default();
    unsafe { if GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) == 0 { return Err(format!("GetProcessTimes: {}", GetLastError())); } }
    let kt = ((kernel.dwHighDateTime as u64) << 32) | kernel.dwLowDateTime as u64;
    let ut = ((user.dwHighDateTime as u64) << 32) | user.dwLowDateTime as u64;
    Ok((kt + ut) / 10)
}
fn query_active_processes(job: HANDLE) -> Result<u32, String> {
    let mut storage = [0u64; 16];
    let mut needed = 0u32;
    unsafe { if QueryInformationJobObject(job, JobObjectBasicProcessIdList, storage.as_mut_ptr() as *mut c_void, std::mem::size_of_val(&storage) as u32, &mut needed) == 0 { return Err(format!("QueryInformationJobObject: {}", GetLastError())); } }
    let info = unsafe { &*(storage.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
    Ok(info.NumberOfAssignedProcesses)
}

enum FrameReadError { TooLarge, Partial, Io(String) }
fn read_frame(reader: &mut impl BufRead, max: usize) -> Result<Option<Vec<u8>>, FrameReadError> {
    let mut bytes = Vec::new();
    let mut too_large = false;
    loop {
        let mut byte = [0u8; 1];
        match reader.read(&mut byte).map_err(|e| FrameReadError::Io(e.to_string()))? {
            0 if bytes.is_empty() => return Ok(None),
            0 => return Err(FrameReadError::Partial),
            _ if byte[0] == b'\n' => return if too_large { Err(FrameReadError::TooLarge) } else { Ok(Some(bytes)) },
            _ if too_large => {},
            _ => { bytes.push(byte[0]); if bytes.len() > max { bytes.clear(); too_large = true; } }
        }
    }
}
fn send_response(writer: &mut impl Write, response: &HostResponse) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, response).map_err(|e| e.to_string())?;
    writer.write_all(b"\n").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}
fn request_id(request: &HostRequest) -> &str {
    match request {
        HostRequest::GetEnvironment { request_id } | HostRequest::RecordEvidence { request_id, .. }
        | HostRequest::StartWorker { request_id, .. } | HostRequest::StopWorker { request_id, .. }
        | HostRequest::Finish { request_id } => request_id,
    }
}

fn inherit_security_attributes() -> SECURITY_ATTRIBUTES { SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 1 } }
fn clear_inherit(handle: HANDLE) -> Result<(), String> { set_inherit(handle, false) }
fn set_inherit(handle: HANDLE, enabled: bool) -> Result<(), String> {
    let flags = if enabled { windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT } else { 0 };
    unsafe { if SetHandleInformation(handle, windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT, flags) == 0 { return Err(format!("SetHandleInformation: {}", GetLastError())); } }
    Ok(())
}
fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() }
fn system_directory() -> PathBuf { PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32") }
fn quote_arg(text: &str) -> String { format!("\"{}\"", text.replace('"', "\\\"")) }

fn read_os_info(root: &Path) -> OsInfo {
    read_environment_file(root).and_then(|v| v.get("os").cloned()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or(OsInfo { version: "not supplied by runner".into(), edition: "unknown".into(), build: "unknown".into(), display_version: "unknown".into() })
}
fn read_toolchain_info(root: &Path) -> ToolchainInfo {
    read_environment_file(root).and_then(|v| v.get("toolchain").cloned()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or(ToolchainInfo { rustc: "not supplied by runner".into(), cargo: "not supplied by runner".into(), active_toolchain: "not supplied by runner".into(), target: "x86_64-pc-windows-msvc".into() })
}
fn read_machine_info(root: &Path) -> MachineInfo {
    read_environment_file(root).and_then(|v| v.get("machine").cloned()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or(MachineInfo { processor: "unknown".into(), architecture: "unknown".into() })
}
fn read_repository_info(root: &Path) -> RepositoryInfo {
    read_environment_file(root).and_then(|v| v.get("repository").cloned()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or(RepositoryInfo { branch: "unknown".into(), head: "unknown".into(), dirty_paths_at_snapshot: 0, experiment_source_sha256: "unknown".into() })
}
fn read_environment_file(root: &Path) -> Option<serde_json::Value> { fs::read(root.join("evidence").join("environment.json")).ok().and_then(|v| serde_json::from_slice(&v).ok()) }

fn experiment_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent().and_then(Path::parent).and_then(Path::parent).map(Path::to_path_buf).ok_or_else(|| "cannot determine experiment root".into())
}

fn write_launcher_preflight(root: &Path, stage: &str) -> Result<LauncherPreflight, String> {
    let preflight = collect_launcher_preflight(root, stage);
    let evidence_dir = root.join("evidence");
    fs::create_dir_all(&evidence_dir).map_err(|e| format!("create preflight evidence directory: {e}"))?;
    let bytes = serde_json::to_vec_pretty(&preflight).map_err(|e| format!("serialize launcher preflight: {e}"))?;
    fs::write(evidence_dir.join("launcher-preflight.json"), bytes).map_err(|e| format!("write launcher preflight: {e}"))?;
    Ok(preflight)
}

fn append_jsonl(root: &Path, name: &str, value: &serde_json::Value) -> Result<(), String> {
    let path = root.join("evidence").join(name);
    let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    serde_json::to_writer(&mut file, value).map_err(|e| format!("serialize {}: {e}", path.display()))?;
    file.write_all(b"\n").map_err(|e| format!("append {}: {e}", path.display()))
}

fn collect_launcher_preflight(root: &Path, stage: &str) -> LauncherPreflight {
    let mut token_query_errors = Vec::new();
    let mut os_query_errors = Vec::new();
    let (mut token_is_appcontainer, mut integrity_rid, mut token_elevation_type, mut elevated,
        mut token_has_restrictions, mut restricted_sid_count, mut appcontainer_sid, mut user_name,
        mut capability_count, mut user_sid, mut session_id) = (None, None, None, None, None, None, None, None, None, None, None);

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            token_query_errors.push(format!("OpenProcessToken(TOKEN_QUERY): {}", GetLastError()));
        } else {
            match query_token_scalar::<u32>(token, TokenIsAppContainer, "TokenIsAppContainer") {
                Ok(value) => token_is_appcontainer = Some(value != 0), Err(err) => token_query_errors.push(err),
            }
            match query_token_scalar::<i32>(token, TokenElevationType, "TokenElevationType") {
                Ok(value) => token_elevation_type = Some(value), Err(err) => token_query_errors.push(err),
            }
            match query_token_scalar::<TOKEN_ELEVATION>(token, TokenElevation, "TokenElevation") {
                Ok(value) => elevated = Some(value.TokenIsElevated != 0), Err(err) => token_query_errors.push(err),
            }
            match query_token_scalar::<u32>(token, TokenHasRestrictions, "TokenHasRestrictions") {
                Ok(value) => token_has_restrictions = Some(value != 0), Err(err) => token_query_errors.push(err),
            }
            match query_token_scalar::<u32>(token, TokenSessionId, "TokenSessionId") {
                Ok(value) => session_id = Some(value), Err(err) => token_query_errors.push(err),
            }
            match query_token_buffer(token, TokenIntegrityLevel, "TokenIntegrityLevel") {
                Ok((storage, returned)) if returned >= std::mem::size_of::<TOKEN_MANDATORY_LABEL>() => {
                    let label = *(storage.as_ptr() as *const TOKEN_MANDATORY_LABEL);
                    if !label.Label.Sid.is_null() {
                        let count = *windows_sys::Win32::Security::GetSidSubAuthorityCount(label.Label.Sid);
                        if count > 0 { integrity_rid = Some(*windows_sys::Win32::Security::GetSidSubAuthority(label.Label.Sid, (count - 1) as u32)); }
                    }
                    if integrity_rid.is_none() { token_query_errors.push("TokenIntegrityLevel did not contain a usable SID RID".into()); }
                }
                Ok(_) => token_query_errors.push("TokenIntegrityLevel returned a short buffer".into()),
                Err(err) => token_query_errors.push(err),
            }
            match query_token_buffer(token, TokenUser, "TokenUser") {
                Ok((storage, returned)) if returned >= std::mem::size_of::<TOKEN_USER>() => {
                    let value = *(storage.as_ptr() as *const TOKEN_USER);
                    match sid_to_string(value.User.Sid) { Ok(sid) => user_sid = Some(sid), Err(err) => token_query_errors.push(err) }
                }
                Ok(_) => token_query_errors.push("TokenUser returned a short buffer".into()),
                Err(err) => token_query_errors.push(err),
            }
            match query_token_buffer(token, TokenRestrictedSids, "TokenRestrictedSids") {
                Ok((storage, returned)) => match read_group_count(&storage, returned) {
                    Some(count) => restricted_sid_count = Some(count),
                    None => token_query_errors.push("TokenRestrictedSids returned a short buffer".into()),
                },
                Err(err) => token_query_errors.push(err),
            }
            match query_token_buffer(token, TokenCapabilities, "TokenCapabilities") {
                Ok((storage, returned)) => match read_group_count(&storage, returned) {
                    Some(count) => capability_count = Some(count),
                    None => token_query_errors.push("TokenCapabilities returned a short buffer".into()),
                },
                Err(err) => token_query_errors.push(err),
            }
            if token_is_appcontainer == Some(true) {
                match query_token_buffer(token, TokenAppContainerSid, "TokenAppContainerSid") {
                    Ok((storage, returned)) if returned >= std::mem::size_of::<TOKEN_APPCONTAINER_INFORMATION>() => {
                        let value = *(storage.as_ptr() as *const TOKEN_APPCONTAINER_INFORMATION);
                        match sid_to_string(value.TokenAppContainer) { Ok(sid) => appcontainer_sid = Some(sid), Err(err) => token_query_errors.push(err) }
                    }
                    Ok(_) => token_query_errors.push("TokenAppContainerSid returned a short buffer".into()),
                    Err(err) => token_query_errors.push(err),
                }
            }
            let _ = CloseHandle(token);
        }
    }

    match current_user_name() {
        Ok(name) => user_name = Some(name),
        Err(err) => token_query_errors.push(err),
    }

    let mut version = OSVERSIONINFOEXW::default();
    version.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOEXW>() as u32;
    let rtl_status = unsafe { RtlGetVersion((&mut version as *mut OSVERSIONINFOEXW).cast::<OSVERSIONINFOW>()) };
    let os_kernel_version = if rtl_status == 0 {
        Some(format!("{}.{}.{}", version.dwMajorVersion, version.dwMinorVersion, version.dwBuildNumber))
    } else {
        os_query_errors.push(format!("RtlGetVersion returned NTSTATUS 0x{:08x}", rtl_status as u32));
        None
    };
    let os_platform_id = (rtl_status == 0).then_some(version.dwPlatformId);
    let os_product_type = (rtl_status == 0).then_some(version.wProductType);
    let windows_11_client_build = (rtl_status == 0).then_some(
        version.wProductType == 1 && version.dwMajorVersion >= 10 &&
            (version.dwMajorVersion > 10 || version.dwBuildNumber >= 22000)
    );
    let mut product_info = 0u32;
    let os_product_info = if rtl_status == 0 && unsafe { GetProductInfo(version.dwMajorVersion, version.dwMinorVersion, version.wServicePackMajor as u32, version.wServicePackMinor as u32, &mut product_info) } != 0 {
        Some(product_info)
    } else {
        if rtl_status == 0 { os_query_errors.push(format!("GetProductInfo failed: {}", unsafe { GetLastError() })); }
        None
    };
    let mut compatibility_version = OSVERSIONINFOW::default();
    compatibility_version.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    let get_version_ex = if unsafe { GetVersionExW(&mut compatibility_version) } != 0 {
        Some(format!("{}.{}.{} (manifest/compatibility-context API)", compatibility_version.dwMajorVersion, compatibility_version.dwMinorVersion, compatibility_version.dwBuildNumber))
    } else {
        let error = unsafe { GetLastError() };
        os_query_errors.push(format!("GetVersionExW failed: {error}"));
        None
    };
    let registry_os = read_environment_file(root).and_then(|v| v.get("os").cloned()).unwrap_or_default();
    let registry_product_name = registry_os.get("edition").and_then(|v| v.as_str()).map(str::to_owned);
    let registry_build = registry_os.get("build").and_then(|v| v.as_str()).map(str::to_owned);
    let registry_display_version = registry_os.get("display_version").and_then(|v| v.as_str()).map(str::to_owned);
    let required_token_fields_present = token_is_appcontainer.is_some() && integrity_rid.is_some() && token_elevation_type.is_some()
        && elevated.is_some() && token_has_restrictions.is_some() && restricted_sid_count.is_some()
        && capability_count.is_some() && user_name.is_some() && user_sid.is_some() && session_id.is_some()
        && (token_is_appcontainer != Some(true) || appcontainer_sid.is_some());
    let expected_account = user_name.as_deref().map(|name| name.rsplit('\\').next().unwrap_or(name).eq_ignore_ascii_case("deszo_poc")).unwrap_or(false);
    let ordinary_desktop_user_token = expected_account && token_is_appcontainer == Some(false) && elevated == Some(false)
        && integrity_rid == Some(8192) && token_has_restrictions == Some(false);
    let decision = if token_is_appcontainer == Some(true) {
        "BLOCKED: launcher token is already AppContainer; CreateAppContainerProfile was not attempted".to_string()
    } else if !required_token_fields_present || !token_query_errors.is_empty() {
        "BLOCKED: required launcher-token diagnostics are incomplete; CreateAppContainerProfile was not attempted".to_string()
    } else if !expected_account {
        "BLOCKED: launcher identity is not the required deszo_poc account; CreateAppContainerProfile was not attempted".to_string()
    } else if !ordinary_desktop_user_token {
        "BLOCKED: launcher is not an ordinary, non-elevated, medium-integrity desktop-user process; CreateAppContainerProfile was not attempted".to_string()
    } else if windows_11_client_build != Some(true) {
        "BLOCKED: the Windows 11 client-build acceptance target was not established; CreateAppContainerProfile was not attempted".to_string()
    } else {
        "READY".to_string()
    };
    LauncherPreflight {
        schema: "deszo-v3-launcher-preflight/1".into(),
        captured_utc_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_millis()).unwrap_or(0),
        stage: stage.into(), process_id: std::process::id(), token_is_appcontainer, integrity_rid,
        token_elevation_type, elevated, token_has_restrictions, restricted_sid_count, appcontainer_sid,
        capability_count, user_name, user_sid, session_id, token_query_errors, os_kernel_version, os_platform_id,
        os_product_type, os_product_info, get_version_ex, registry_product_name, registry_build,
        registry_display_version, winver_observation: "Not captured by this non-interactive preflight; operator may compare with winver in the desktop session".into(),
        windows_11_client_build, ordinary_desktop_user_token, os_query_errors, decision,
    }
}

fn current_user_name() -> Result<String, String> {
    let mut buffer = vec![0u16; 512];
    let mut length = buffer.len() as u32;
    if unsafe { GetUserNameW(buffer.as_mut_ptr(), &mut length) } == 0 {
        return Err(format!("GetUserNameW: {}", unsafe { GetLastError() }));
    }
    let used = (length as usize).min(buffer.len());
    let content_length = if used > 0 && buffer[used - 1] == 0 { used - 1 } else { used };
    String::from_utf16(&buffer[..content_length]).map_err(|err| format!("GetUserNameW returned invalid UTF-16: {err}"))
}

unsafe fn query_token_scalar<T: Copy + Default>(token: HANDLE, class: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS, name: &str) -> Result<T, String> {
    let mut value = T::default();
    let mut returned = 0u32;
    if GetTokenInformation(token, class, (&mut value as *mut T).cast(), std::mem::size_of::<T>() as u32, &mut returned) == 0 {
        return Err(format!("GetTokenInformation({name}): {}", GetLastError()));
    }
    Ok(value)
}

unsafe fn query_token_buffer(token: HANDLE, class: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS, name: &str) -> Result<(Vec<u64>, usize), String> {
    let mut needed = 0u32;
    let first_ok = GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut needed);
    let first_error = if first_ok == 0 { GetLastError() } else { 0 };
    if first_ok == 0 && first_error != 122 && needed == 0 {
        return Err(format!("GetTokenInformation({name}) size query: {first_error}"));
    }
    let alloc_bytes = needed.max(std::mem::size_of::<u32>() as u32);
    let mut storage = vec![0u64; (alloc_bytes as usize + 7) / 8];
    let mut returned = 0u32;
    if GetTokenInformation(token, class, storage.as_mut_ptr().cast(), alloc_bytes, &mut returned) == 0 {
        return Err(format!("GetTokenInformation({name}) data query: {} (required={needed}, allocated={alloc_bytes})", GetLastError()));
    }
    Ok((storage, returned as usize))
}

fn read_group_count(storage: &[u64], returned: usize) -> Option<u32> {
    if returned < std::mem::size_of::<u32>() || storage.is_empty() { return None; }
    Some(unsafe { *(storage.as_ptr() as *const u32) })
}

fn sid_to_string(sid: *mut c_void) -> Result<String, String> {
    if sid.is_null() { return Err("SID pointer was null".into()); }
    unsafe {
        let mut wide = std::ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut wide) == 0 { return Err(format!("ConvertSidToStringSidW: {}", GetLastError())); }
        let mut length = 0usize;
        while *wide.add(length) != 0 { length += 1; }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(wide, length));
        let _ = LocalFree(wide as *mut _);
        Ok(value)
    }
}

#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(lpversioninformation: *mut OSVERSIONINFOW) -> i32;
}

fn token_identity_for_process(process: HANDLE) -> Result<poc_protocol::WorkerIdentity, String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 { return Err(format!("OpenProcessToken: {}", GetLastError())); }
        let mut is_appcontainer = 0u32; let mut returned = 0u32;
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
            if GetTokenInformation(token, TokenCapabilities, storage.as_mut_ptr() as *mut _, needed, &mut returned) == 0 { let e = GetLastError(); let _ = CloseHandle(token); return Err(format!("TokenCapabilities child: {e}")); }
            (returned as usize / std::mem::size_of::<SID_AND_ATTRIBUTES>()).min(words)
        };
        let _ = CloseHandle(token);
        Ok(poc_protocol::WorkerIdentity { is_appcontainer: is_appcontainer != 0, appcontainer_sid, capability_count })
    }
}
fn host_token_summary() -> (Option<bool>, Option<u32>) {
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TokenIntegrityLevel, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return (None, None); }
        let mut elevation = TOKEN_ELEVATION::default(); let mut returned = 0u32;
        let elevated = (GetTokenInformation(token, TokenElevation, &mut elevation as *mut _ as *mut _, std::mem::size_of_val(&elevation) as u32, &mut returned) != 0).then_some(elevation.TokenIsElevated != 0);
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, std::ptr::null_mut(), 0, &mut needed);
        let mut bytes = vec![0u64; (needed as usize + 7) / 8];
        let ok = !bytes.is_empty() && GetTokenInformation(token, TokenIntegrityLevel, bytes.as_mut_ptr() as *mut _, needed, &mut returned) != 0;
        let rid = if ok {
            let label = *(bytes.as_ptr() as *const windows_sys::Win32::Security::TOKEN_MANDATORY_LABEL);
            let sid = label.Label.Sid;
            if sid.is_null() { None } else {
                let count = *windows_sys::Win32::Security::GetSidSubAuthorityCount(sid);
                (count > 0).then(|| *windows_sys::Win32::Security::GetSidSubAuthority(sid, (count - 1) as u32))
            }
        } else { None };
        let _ = CloseHandle(token);
        (elevated, rid)
    }
}
fn write_report(root: &Path, report: &RunReport) -> Result<(), String> {
    let evidence_dir = root.join("evidence"); fs::create_dir_all(&evidence_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(report).map_err(|e| e.to_string())?;
    fs::write(evidence_dir.join(format!("run-{}.json", report.run_id)), &json).map_err(|e| e.to_string())?;
    fs::write(evidence_dir.join("run.json"), json).map_err(|e| e.to_string())?;
    Ok(())
}
fn print_summary(report: &RunReport) {
    let pass = report.evidence.iter().filter(|e| e.outcome == "PASS").count();
    let fail = report.evidence.iter().filter(|e| e.outcome == "FAIL").count();
    let unproven = report.evidence.iter().filter(|e| e.outcome == "UNPROVEN").count();
    let other = report.evidence.iter().filter(|e| e.outcome != "PASS" && e.outcome != "FAIL" && e.outcome != "UNPROVEN").count();
    println!("DESZO-RUST-MIGRATION-V3-POC run={} finished={} PASS={} FAIL={} UNPROVEN={} OTHER={} evidence={}", report.run_id, report.finished, pass, fail, unproven, other, report.evidence.len());
    for e in report.evidence.iter().filter(|e| e.outcome == "FAIL") { println!("FAIL {} :: {}", e.case, e.detail); }
    println!("Evidence: experiments/rust-migration-v3/evidence/run.json");
}

