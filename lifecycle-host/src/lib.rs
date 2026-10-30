//! UI-independent lifecycle core. The CLI and a future Dioxus surface use this same `Host`.

use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

mod custody;
pub use custody::{run_service as run_custody_service, AllowedExecutable, CustodyConfig, CustodyRegistry, Refusal, ServiceConfig};

const IPC_MAX_LINE: usize = 128 * 1024;
const ENGINE_READY_TIMEOUT: Duration = Duration::from_secs(45);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);
const SOURCE_INVENTORY_PATH: &str = ".deszo-source-inventory.json";
const SOURCE_INVENTORY_BATCH_MAX: usize = 32;
const MANAGED_RELAUNCH_LIMIT: usize = 3;
const MANAGED_RELAUNCH_WINDOW: Duration = Duration::from_secs(60);

/// What the Host does after a managed Engine exited while Process Custody keeps its CLIs alive.
#[derive(Debug, PartialEq, Eq)]
enum RelaunchDecision {
    /// Start the same active, re-verified build in the same generation.
    Relaunch,
    /// The rolling budget is spent: latch relaunch off for this Host's lifetime.
    Exhausted,
    /// Keep serving Custody only (clean exit, desktop bootstrap, latched budget, or a lifecycle operation in progress).
    Hold,
}

/// Pure relaunch policy. `recent` counts relaunches inside the rolling window. A clean exit, a desktop bootstrap and an
/// already-latched budget never relaunch; a durable lifecycle operation is never raced; the budget is finite.
fn managed_relaunch_decision(bootstrap: &str, clean_exit: bool, already_exhausted: bool, operation_active: bool, recent: usize) -> RelaunchDecision {
    if bootstrap != "runtime" || clean_exit || already_exhausted {
        return RelaunchDecision::Hold;
    }
    if recent >= MANAGED_RELAUNCH_LIMIT {
        return RelaunchDecision::Exhausted;
    }
    if operation_active {
        return RelaunchDecision::Hold;
    }
    RelaunchDecision::Relaunch
}
const SOURCE_INVENTORY_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub installation_root: PathBuf,
    pub profile_root: PathBuf,
    pub staging_root: PathBuf,
    pub node_executable: PathBuf,
    pub initial_build_id: String,
    #[serde(default)]
    pub fixture_state: Option<PathBuf>,
    #[serde(default)]
    pub dev_test_confirmation_off: bool,
    /// For the isolated integration harness only. The child writes its private startup line straight to the
    /// harness pipe; the Host never reads or stores the first-party credential in that line.
    #[serde(default)]
    pub forward_runtime_stdout: bool,
    #[serde(default)]
    pub test_setup_token_stdout: bool,
    #[serde(default)]
    pub test_duplicate_receipt_delivery: bool,
    #[serde(default)]
    pub test_pause_after_shutdown_requested_ms: Option<u64>,
    #[serde(default)]
    pub test_engine_ready_timeout_ms: Option<u64>,
    #[serde(default = "default_true")]
    pub forward_runtime_stderr: bool,
    /// Process Custody (PoC). Absent means custody commands are refused and no CLI is ever launched through the Host.
    #[serde(default)]
    pub custody: Option<CustodyConfig>,
}

fn default_true() -> bool {
    true
}

fn readiness_timeout(config: &HostConfig) -> Duration {
    config
        .test_engine_ready_timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(ENGINE_READY_TIMEOUT)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JudgeEvidence {
    pub kind: String,
    pub workflow_id: String,
    pub judge_node_instance_id: String,
    pub attempt_id: String,
    pub checkpoint_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessConditions {
    pub application_responsive: bool,
    pub engine_ready: bool,
    pub same_profile: bool,
    pub same_store: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleRequest {
    pub operation_id: String,
    pub action: String,
    pub installation_id: String,
    pub profile_root: String,
    pub run_id: String,
    pub node_instance_id: String,
    pub candidate_id: String,
    pub candidate_digest: String,
    pub expected_generation: String,
    pub judge_evidence: JudgeEvidence,
    pub readiness: ReadinessConditions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleReceipt {
    pub operation_id: String,
    pub receipt_id: String,
    pub installation_id: String,
    pub profile_root: String,
    pub candidate_id: String,
    pub candidate_digest: String,
    pub previous_generation: String,
    pub activated_generation: String,
    pub store_id: String,
    pub host_pid: u32,
    #[serde(default)]
    pub application_pid: u32,
    pub engine_pid: u32,
    #[serde(default)]
    pub application_build_id: String,
    #[serde(default)]
    pub runtime_instance_id: String,
    pub actual_activation: bool,
    pub application_responsive: bool,
    pub engine_ready: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildManifest {
    schema_version: u32,
    build_id: String,
    runtime_api_version: u32,
    bootstrap: String,
    #[serde(default)]
    source_commit: Option<String>,
    #[serde(default)]
    dirty_source_digest: Option<String>,
    #[serde(default)]
    inputs_digest: Option<String>,
    #[serde(default)]
    artifacts: Vec<BuildArtifact>,
    #[serde(default)]
    source_inventory: Option<BuildArtifactRef>,
    #[serde(default)]
    desktop_executable: Option<String>,
    #[serde(default)]
    desktop_build_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildArtifact {
    path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildArtifactRef {
    path: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuildSourceInventory {
    schema_version: u32,
    kind: String,
    source_commit: String,
    source_digest: String,
    files: Vec<BuildSourceInventoryEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuildSourceInventoryEntry {
    path: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    absent: Option<bool>,
}

#[derive(Deserialize)]
struct RuntimeResourceManifest {
    kind: String,
    version: u32,
    files: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivePointer {
    build_id: String,
    digest: String,
    generation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationRecord {
    request: LifecycleRequest,
    request_fingerprint: String,
    phase: String,
    failure: Option<String>,
    receipt: Option<LifecycleReceipt>,
    receipt_acknowledged: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableState {
    schema_version: u32,
    installation_id: String,
    active_build_id: String,
    active_digest: String,
    generation: String,
    store_id: Option<String>,
    operation: Option<OperationRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    capability: String,
    command: String,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// A stable machine code for refusals that the Engine must act on (for example `stale_engine`).
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

struct RuntimeState {
    durable: DurableState,
    managed: Option<ManagedProcess>,
    ready_generation: Option<String>,
    stop_requested: bool,
}

struct Shared {
    config: HostConfig,
    installation_root: PathBuf,
    installation_id: String,
    desktop_bootstrap: bool,
    profile_root: PathBuf,
    staging_root: PathBuf,
    state_file: PathBuf,
    active_file: PathBuf,
    endpoint_file: PathBuf,
    capability: String,
    address: SocketAddr,
    state: Mutex<RuntimeState>,
    ready: Condvar,
    journal: Mutex<File>,
    custody: Option<CustodyRegistry>,
}

struct ManagedProcess {
    child: Child,
    containment: Containment,
    generation: String,
    build_id: String,
    bootstrap: String,
    engine_pid: Option<u32>,
}

#[cfg(windows)]
struct Containment(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Containment {}
// A Job object is internally synchronized; its handle may be queried and terminated from any thread.
#[cfg(windows)]
unsafe impl Sync for Containment {}

#[cfg(unix)]
struct Containment(i32);

#[cfg(not(any(windows, unix)))]
struct Containment;

impl Containment {
    fn create() -> Result<Self, String> {
        #[cfg(windows)]
        unsafe {
            use std::{mem::size_of, ptr::null};
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::JobObjects::{
                    CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
            };
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Err(format!(
                    "CreateJobObjectW failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return Err(format!(
                    "SetInformationJobObject failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self(handle))
        }
        #[cfg(unix)]
        {
            Ok(Self(0))
        }
        #[cfg(not(any(windows, unix)))]
        {
            Err("process-tree containment is not implemented on this platform".into())
        }
    }

    fn assign(&mut self, child: &Child) -> Result<(), String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            return self.assign_handle(child.as_raw_handle() as _);
        }
        #[cfg(unix)]
        {
            self.0 = child.id() as i32;
            Ok(())
        }
    }

    // Assigns a process by its raw handle, for launches that create the process suspended (Process Custody).
    #[cfg(windows)]
    fn assign_handle(&self, process: windows_sys::Win32::Foundation::HANDLE) -> Result<(), String> {
        let ok = unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0, process) };
        if ok == 0 {
            return Err(format!("AssignProcessToJobObject failed: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn terminate(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            let ok =
                unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) };
            if ok == 0 {
                return Err(format!(
                    "TerminateJobObject failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        #[cfg(unix)]
        {
            let result = unsafe { libc::kill(-self.0, libc::SIGKILL) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                return Err(format!(
                    "kill process group failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        Ok(())
    }

    fn is_empty(&self) -> Result<bool, String> {
        #[cfg(windows)]
        unsafe {
            use std::mem::size_of;
            use windows_sys::Win32::System::JobObjects::{
                JobObjectBasicAccountingInformation, QueryInformationJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            };
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            if ok == 0 {
                return Err(format!(
                    "QueryInformationJobObject failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(info.ActiveProcesses == 0)
        }
        #[cfg(unix)]
        {
            let result = unsafe { libc::kill(-self.0, 0) };
            let error = std::io::Error::last_os_error();
            Ok(result != 0 && error.raw_os_error() == Some(libc::ESRCH))
        }
        #[cfg(not(any(windows, unix)))]
        {
            Ok(false)
        }
    }
}

#[cfg(windows)]
impl Drop for Containment {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

pub struct Host {
    shared: Arc<Shared>,
    listener: TcpListener,
    _ownership: File,
}

impl Host {
    pub fn start(config: HostConfig) -> Result<Self, String> {
        validate_config(&config)?;
        let installation_root = fs::canonicalize(&config.installation_root).map_err(err)?;
        let profile_root = node_path(&fs::canonicalize(&config.profile_root).map_err(err)?);
        let staging_root = fs::canonicalize(&config.staging_root).map_err(err)?;
        let host_dir = installation_root.join(".deszo-host");
        fs::create_dir_all(&host_dir).map_err(err)?;
        let initial_manifest = verify_build(
            &installation_root
                .join("versions")
                .join(&config.initial_build_id),
            &config.initial_build_id,
        )?;
        let desktop_bootstrap = initial_manifest.bootstrap == "tauri";
        let installation_id =
            installation_identity(&installation_root, &profile_root, desktop_bootstrap)?;
        let profile_key = hex::encode(Sha256::digest(profile_root.to_string_lossy().as_bytes()));
        let state_dir = if desktop_bootstrap {
            host_dir.join("profiles").join(profile_key)
        } else {
            host_dir.clone()
        };
        let lock_identity = if desktop_bootstrap {
            format!("installation\0{}", installation_root.display())
        } else {
            format!(
                "{}\0{}",
                installation_root.display(),
                profile_root.display()
            )
        };
        let lock_name = hex::encode(Sha256::digest(lock_identity.as_bytes()));
        let lock_path = host_dir.join(format!("ownership-{lock_name}.lock"));
        let ownership = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(err)?;
        ownership.try_lock_exclusive().map_err(|_| {
            if desktop_bootstrap {
                "another lifecycle Host already owns this desktop installation".to_string()
            } else {
                "another lifecycle Host already owns this installation/profile".to_string()
            }
        })?;
        fs::create_dir_all(&state_dir).map_err(err)?;
        refuse_legacy_owner(&profile_root)?;

        let state_file = state_dir.join("lifecycle.json");
        let active_file = host_dir.join("active.json");
        let endpoint_file = host_dir.join("ipc-endpoint.json");
        let journal_file = host_dir.join("operations.ndjson");
        let mut durable = load_or_initialize(
            &config,
            &installation_root,
            &profile_root,
            &state_file,
            &active_file,
            &installation_id,
            desktop_bootstrap,
        )?;
        reconcile_crash(&mut durable, &state_file, &active_file, &journal_file)?;

        let listener =
            TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).map_err(err)?;
        let address = listener.local_addr().map_err(err)?;
        listener.set_nonblocking(true).map_err(err)?;
        let capability = random_capability();
        let journal = OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&journal_file)
            .map_err(err)?;
        let custody = match &config.custody {
            Some(custody_config) => Some(CustodyRegistry::open(&host_dir, &durable.generation, custody_config)?),
            None => None,
        };
        let shared = Arc::new(Shared {
            custody,
            config: config.clone(),
            installation_root,
            installation_id,
            desktop_bootstrap,
            profile_root,
            staging_root,
            state_file,
            active_file,
            endpoint_file,
            capability,
            address,
            state: Mutex::new(RuntimeState {
                durable,
                managed: None,
                ready_generation: None,
                stop_requested: false,
            }),
            ready: Condvar::new(),
            journal: Mutex::new(journal),
        });
        write_json_atomic(
            &shared.endpoint_file,
            &serde_json::json!({ "address": address.to_string(), "protocol": "deszo-lifecycle-host/1" }),
        )?;
        log_event(
            &shared,
            "host_started",
            serde_json::json!({ "hostPid": std::process::id(), "installationId": shared.state.lock().map_err(poison)?.durable.installation_id, "profileRoot": shared.profile_root }),
        )?;

        let listener_shared = Arc::clone(&shared);
        let listener_thread = listener.try_clone().map_err(err)?;
        thread::Builder::new()
            .name("deszo-lifecycle-ipc".into())
            .spawn(move || serve(listener_thread, listener_shared))
            .map_err(err)?;

        start_current_build(&shared)?;
        if let Err(error) = wait_for_engine_ready(&shared, readiness_timeout(&shared.config)) {
            let cleanup = shutdown_managed(&shared);
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => {
                    format!("{error}; managed process cleanup failed: {cleanup_error}")
                }
            });
        }
        Ok(Self {
            shared,
            listener,
            _ownership: ownership,
        })
    }

    /// Keep the Host alive independently of the application. The headless executable accepts an owner-side
    /// `shutdown` line on stdin; GUI callers drive the same core and decide their own window lifetime.
    pub fn run(&mut self) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("deszo-lifecycle-console".into())
            .spawn(move || {
                let stdin = std::io::stdin();
                for line in stdin.lock().lines().map_while(Result::ok) {
                    if line.trim() == "shutdown" {
                        let _ = tx.send(());
                        break;
                    }
                }
            })
            .map_err(err)?;
        // Abnormal managed-Engine exits relaunched under Process Custody, bounded per rolling window.
        let mut relaunches: Vec<Instant> = Vec::new();
        let mut relaunch_exhausted = false;
        loop {
            if rx.recv_timeout(Duration::from_millis(250)).is_ok() {
                break;
            }
            let unexpected_exit = {
                let mut guard = self.shared.state.lock().map_err(poison)?;
                if guard.stop_requested {
                    break;
                }
                let lifecycle_transition =
                    guard.durable.operation.as_ref().is_some_and(|operation| {
                        matches!(
                            operation.phase.as_str(),
                            "accepted" | "shutdown_requested" | "old_process_stopped" | "starting"
                        )
                    });
                if lifecycle_transition {
                    None
                } else if let Some(process) = guard.managed.as_mut() {
                    process.child.try_wait().map_err(err)?.map(|status| {
                        (
                            process.child.id(),
                            process.build_id.clone(),
                            process.generation.clone(),
                            process.bootstrap.clone(),
                            status.to_string(),
                            status.success(),
                        )
                    })
                } else {
                    None
                }
            };
            if let Some((pid, build_id, generation, bootstrap, status, clean_exit)) = unexpected_exit {
                let message = format!("managed {bootstrap} application {pid} exited unexpectedly with status {status}");
                log_event(
                    &self.shared,
                    "managed_application_exited_unexpectedly",
                    serde_json::json!({ "pid": pid, "buildId": build_id, "generation": generation, "bootstrap": bootstrap,
                        "status": status, "message": message }),
                )?;
                // With Process Custody enabled, an Engine that exits does not end the Host: the CLIs it admitted are still
                // owned here. The managed tree is released; the Host keeps serving custody until a new Engine attaches.
                if self.shared.custody.is_some() {
                    let mut guard = self.shared.state.lock().map_err(poison)?;
                    if let Some(mut process) = guard.managed.take() {
                        let _ = process.containment.terminate();
                        let _ = process.child.wait();
                    }
                    guard.ready_generation = None;
                    drop(guard);
                    // A runtime Engine that crashed is replaced from the same active, re-verified package and generation,
                    // so the replacement reattaches the Custody-owned CLIs instead of leaving them without an Engine. A clean
                    // exit, a desktop bootstrap or an exhausted relaunch budget leaves the Host serving custody only.
                    let now = Instant::now();
                    relaunches.retain(|at| now.duration_since(*at) < MANAGED_RELAUNCH_WINDOW);
                    // A crash loop latches off for the Host's lifetime; a lifecycle operation in progress is never raced.
                    let operation_active = self.shared.state.lock().map_err(poison)?.durable.operation.is_some();
                    let decision = managed_relaunch_decision(&bootstrap, clean_exit, relaunch_exhausted, operation_active, relaunches.len());
                    if decision == RelaunchDecision::Exhausted {
                        relaunch_exhausted = true;
                        log_event(&self.shared, "managed_application_relaunch_exhausted",
                            serde_json::json!({ "previousPid": pid, "buildId": build_id, "generation": generation }))?;
                    }
                    if decision == RelaunchDecision::Relaunch {
                        relaunches.push(now);
                        match start_current_build(&self.shared) {
                            Ok(()) => log_event(&self.shared, "managed_application_relaunched",
                                serde_json::json!({ "previousPid": pid, "buildId": build_id, "generation": generation,
                                    "attempt": relaunches.len() }))?,
                            Err(error) => log_event(&self.shared, "managed_application_relaunch_failed",
                                serde_json::json!({ "previousPid": pid, "buildId": build_id, "generation": generation,
                                    "message": error }))?,
                        }
                    }
                    continue;
                }
                if let Err(error) = shutdown_managed(&self.shared) {
                    let cleanup_message =
                        format!("{message}; managed process cleanup failed: {error}");
                    let _ = log_event(
                        &self.shared,
                        "managed_process_cleanup_failed",
                        serde_json::json!({ "pid": pid, "buildId": build_id, "message": cleanup_message }),
                    );
                    return Err(cleanup_message);
                }
                return Err(message);
            }
            let guard = self.shared.state.lock().map_err(poison)?;
            if guard.stop_requested {
                break;
            }
        }
        // A graceful Host stop ends every custody Job it still owns, with a recorded reason, before the managed tree.
        if let Some(custody) = &self.shared.custody {
            custody.shutdown();
        }
        shutdown_managed(&self.shared)?;
        self.listener.set_nonblocking(true).ok();
        let _ = fs::remove_file(&self.shared.endpoint_file);
        log_event(
            &self.shared,
            "host_stopped",
            serde_json::json!({ "hostPid": std::process::id() }),
        )?;
        Ok(())
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // A normal drop is graceful. An OS crash closes the Windows Job/process group and contains descendants.
        let _ = shutdown_managed(&self.shared);
        let _ = fs::remove_file(&self.shared.endpoint_file);
    }
}

pub fn candidate_digest(path: &Path) -> Result<String, String> {
    let root = fs::canonicalize(path).map_err(err)?;
    if !root.is_dir() {
        return Err("candidate root is not a directory".into());
    }
    let mut files = Vec::new();
    collect_files(&root, &root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    if files.is_empty() {
        return Err("candidate contains no files".into());
    }
    let mut hash = Sha256::new();
    for (name, path) in files {
        let bytes = fs::read(&path).map_err(err)?;
        hash.update((name.len() as u64).to_be_bytes());
        hash.update(name.as_bytes());
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    Ok(hex::encode(hash.finalize()))
}

fn file_sha256(path: &Path) -> Result<String, String> {
    Ok(hex::encode(Sha256::digest(fs::read(path).map_err(err)?)))
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    for item in fs::read_dir(dir).map_err(err)? {
        let item = item.map_err(err)?;
        let kind = item.file_type().map_err(err)?;
        if kind.is_symlink() {
            return Err(format!(
                "candidate contains a symbolic link: {}",
                item.path().display()
            ));
        }
        if kind.is_dir() {
            collect_files(root, &item.path(), out)?;
        } else if kind.is_file() {
            let item_path = item.path();
            let rel = item_path.strip_prefix(root).map_err(err)?;
            let name = rel
                .components()
                .map(|part| match part {
                    Component::Normal(s) => s.to_string_lossy().replace('\\', "/"),
                    _ => String::new(),
                })
                .collect::<Vec<_>>()
                .join("/");
            out.push((name, item_path));
        } else {
            return Err(format!(
                "candidate contains an unsupported file: {}",
                item.path().display()
            ));
        }
    }
    Ok(())
}

fn validate_config(config: &HostConfig) -> Result<(), String> {
    for (name, path) in [
        ("installation_root", &config.installation_root),
        ("profile_root", &config.profile_root),
        ("staging_root", &config.staging_root),
    ] {
        if !path.is_absolute() || !path.exists() || !path.is_dir() {
            return Err(format!("{name} must be an existing absolute directory"));
        }
    }
    if !config.node_executable.is_absolute() || !config.node_executable.is_file() {
        return Err("node_executable must be an existing absolute file".into());
    }
    validate_id(&config.initial_build_id)?;
    if config.fixture_state.is_some() && !cfg!(debug_assertions) {
        return Err("fixture providers are unavailable in a release Host".into());
    }
    if config.test_duplicate_receipt_delivery && !cfg!(debug_assertions) {
        return Err("duplicate receipt delivery is unavailable in a release Host".into());
    }
    if config
        .test_pause_after_shutdown_requested_ms
        .is_some_and(|millis| millis > 30_000 || !cfg!(debug_assertions))
    {
        return Err("shutdown-boundary test pause is unavailable in a release Host".into());
    }
    if config
        .test_engine_ready_timeout_ms
        .is_some_and(|millis| !(100..=60_000).contains(&millis) || !cfg!(debug_assertions))
    {
        return Err("short Engine readiness timeout is unavailable in a release Host".into());
    }
    let install = fs::canonicalize(&config.installation_root).map_err(err)?;
    let stage = fs::canonicalize(&config.staging_root).map_err(err)?;
    if !stage.starts_with(install.join("staging")) {
        return Err("staging_root must be inside installation_root/staging".into());
    }
    Ok(())
}

fn load_or_initialize(
    config: &HostConfig,
    install: &Path,
    _profile: &Path,
    state_file: &Path,
    active_file: &Path,
    installation_id: &str,
    desktop_bootstrap: bool,
) -> Result<DurableState, String> {
    if state_file.is_file() {
        let bytes = fs::read(state_file).map_err(err)?;
        let mut state: DurableState = serde_json::from_slice(&bytes).map_err(err)?;
        let mut active: ActivePointer =
            serde_json::from_slice(&fs::read(active_file).map_err(err)?).map_err(err)?;
        if state.installation_id != installation_id {
            return Err("Host state belongs to a different installation/profile identity".into());
        }
        if state.active_build_id != active.build_id || state.active_digest != active.digest {
            let recover_candidate = state.operation.as_ref().is_some_and(|operation| {
                operation.receipt.is_none()
                    && operation.request.candidate_id == active.build_id
                    && operation.request.candidate_digest == active.digest
                    && matches!(operation.phase.as_str(), "old_process_stopped" | "starting")
            });
            if !recover_candidate {
                return Err("durable Host state and active installation pointer disagree".into());
            }
            verify_build(
                &install.join("versions").join(&active.build_id),
                &active.build_id,
            )?;
            state.active_build_id = active.build_id.clone();
            state.active_digest = active.digest.clone();
            state.generation = active.generation.clone();
            if let Some(operation) = state.operation.as_mut() {
                operation.phase = "starting".into();
                operation.failure = None;
            }
        }
        state.generation = Uuid::new_v4().to_string();
        active.generation = state.generation.clone();
        write_json_atomic(active_file, &active)?;
        write_json_atomic(state_file, &state)?;
        return Ok(state);
    }
    let (build_id, digest) = if active_file.is_file() {
        let active: ActivePointer =
            serde_json::from_slice(&fs::read(active_file).map_err(err)?).map_err(err)?;
        let active_path = install.join("versions").join(&active.build_id);
        verify_build(&active_path, &active.build_id)?;
        let actual = candidate_digest(&active_path)?;
        if !digest_eq(&actual, &active.digest) {
            return Err("active application package changed outside the Host".into());
        }
        (active.build_id, actual)
    } else {
        let initial_path = install.join("versions").join(&config.initial_build_id);
        let manifest = verify_build(&initial_path, &config.initial_build_id)?;
        (manifest.build_id, candidate_digest(&initial_path)?)
    };
    if desktop_bootstrap {
        let manifest = verify_build(&install.join("versions").join(&build_id), &build_id)?;
        if manifest.bootstrap != "tauri" {
            return Err("active installation bootstrap changed from desktop to runtime".into());
        }
    }
    let generation = Uuid::new_v4().to_string();
    let state = DurableState {
        schema_version: 1,
        installation_id: installation_id.into(),
        active_build_id: build_id,
        active_digest: digest.clone(),
        generation: generation.clone(),
        store_id: None,
        operation: None,
    };
    write_json_atomic(
        active_file,
        &ActivePointer {
            build_id: state.active_build_id.clone(),
            digest,
            generation,
        },
    )?;
    write_json_atomic(state_file, &state)?;
    Ok(state)
}

fn reconcile_crash(
    state: &mut DurableState,
    state_file: &Path,
    active_file: &Path,
    journal_file: &Path,
) -> Result<(), String> {
    let mut recovered = None;
    if let Some(operation) = state.operation.as_mut() {
        if operation.receipt.is_none()
            && matches!(
                operation.phase.as_str(),
                "accepted" | "shutdown_requested" | "old_process_stopped"
            )
        {
            operation.phase = "failed".into();
            operation.failure = Some(
                "Host restarted before candidate activation; the operation was not replayed."
                    .into(),
            );
            recovered = Some((
                operation.request.operation_id.clone(),
                operation.phase.clone(),
            ));
        }
    }
    if let Some((operation_id, phase)) = recovered {
        persist_state(state_file, state)?;
        append_journal(
            journal_file,
            "operation_reconciled_without_replay",
            serde_json::json!({ "operationId": operation_id, "phase": phase, "activeBuildId": state.active_build_id }),
        )?;
    }
    let _ = active_file;
    Ok(())
}

fn installation_identity(
    install: &Path,
    profile: &Path,
    desktop_bootstrap: bool,
) -> Result<String, String> {
    let install = fs::canonicalize(install).map_err(err)?;
    let bytes = if desktop_bootstrap {
        format!("desktop-installation\0{}", install.display())
    } else {
        format!(
            "{}\0{}",
            install.display(),
            node_path(&fs::canonicalize(profile).map_err(err)?).display()
        )
    };
    Ok(hex::encode(&Sha256::digest(bytes.as_bytes())[..16]))
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("build/candidate identity is malformed".into());
    }
    Ok(())
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_build_inventory_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 || path.starts_with('/') || path.ends_with('/')
        || path.contains('\\') || path.contains(':') || path.chars().any(|ch| ch.is_control() || matches!(ch, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err("build source inventory contains a non-portable path".into());
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.ends_with('.') || part.ends_with(' ') {
            return Err("build source inventory contains a non-canonical path".into());
        }
        let stem = part.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_lowercase();
        if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0')
        {
            return Err("build source inventory contains a reserved Windows path".into());
        }
    }
    Ok(())
}

fn read_build_source_inventory(root: &Path, manifest: &BuildManifest) -> Result<Option<BuildSourceInventory>, String> {
    let Some(reference) = manifest.source_inventory.as_ref() else { return Ok(None); };
    if reference.path != SOURCE_INVENTORY_PATH || !valid_lower_hex(&reference.sha256, 64) {
        return Err("build source inventory reference is malformed".into());
    }
    let matching = manifest.artifacts.iter().filter(|artifact| artifact.path == SOURCE_INVENTORY_PATH).collect::<Vec<_>>();
    if matching.len() != 1 || matching[0].sha256 != reference.sha256
        || matching[0].bytes == 0 || matching[0].bytes > SOURCE_INVENTORY_FILE_MAX_BYTES
    {
        return Err("build source inventory reference does not match exactly one packaged artifact".into());
    }
    let path = root.join(SOURCE_INVENTORY_PATH);
    let metadata = fs::symlink_metadata(&path).map_err(err)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != matching[0].bytes {
        return Err("build source inventory artifact is not a bounded regular file".into());
    }
    let bytes = fs::read(&path).map_err(err)?;
    if bytes.len() as u64 != matching[0].bytes || !digest_eq(&hex::encode(Sha256::digest(&bytes)), &reference.sha256) {
        return Err("build source inventory artifact digest is invalid".into());
    }
    let inventory: BuildSourceInventory = serde_json::from_slice(&bytes).map_err(err)?;
    if inventory.schema_version != 1 || inventory.kind != "DeszoBuildSourceInventory"
        || inventory.files.is_empty() || inventory.files.len() > 50_000
        || !valid_lower_hex(&inventory.source_digest, 64)
        || !matches!(inventory.source_commit.len(), 40 | 64) || !valid_lower_hex(&inventory.source_commit, inventory.source_commit.len())
        || manifest.source_commit.as_deref() != Some(inventory.source_commit.as_str())
        || manifest.dirty_source_digest.as_deref() != Some(inventory.source_digest.as_str())
    {
        return Err("build source inventory identity does not match its build manifest".into());
    }
    let mut paths = std::collections::HashSet::with_capacity(inventory.files.len());
    for entry in &inventory.files {
        validate_build_inventory_path(&entry.path)?;
        if !paths.insert(entry.path.as_str()) {
            return Err("build source inventory contains duplicate paths".into());
        }
        match (&entry.sha256, entry.absent) {
            (Some(digest), None) if valid_lower_hex(digest, 64) => {}
            (None, Some(true)) => {}
            _ => return Err("build source inventory entry must identify a file digest or absence".into()),
        }
    }
    // serde_json's default Value map is key-sorted, which gives the same JCS object-key order used by
    // canonicalHash for this restricted {path, sha256|absent} inventory structure.
    let canonical_files = serde_json::to_vec(&serde_json::to_value(&inventory.files).map_err(err)?).map_err(err)?;
    let actual_source_digest = hex::encode(Sha256::digest(canonical_files));
    if !digest_eq(&actual_source_digest, &inventory.source_digest) {
        return Err("build source inventory content digest is invalid".into());
    }
    Ok(Some(inventory))
}

fn select_source_inventory_entries(inventory: &BuildSourceInventory, paths: &[String]) -> Result<Vec<serde_json::Value>, String> {
    let by_path = inventory.files.iter().map(|entry| (entry.path.as_str(), entry)).collect::<std::collections::HashMap<_, _>>();
    paths.iter().map(|path| match by_path.get(path.as_str()) {
        Some(entry) => match (&entry.sha256, entry.absent) {
            (Some(sha256), None) => Ok(serde_json::json!({"path": path, "sha256": sha256})),
            (None, Some(true)) => Ok(serde_json::json!({"path": path, "absent": true})),
            _ => Err("active source inventory contains an invalid requested entry".into()),
        },
        None => Ok(serde_json::json!({"path": path, "missing": true})),
    }).collect()
}

fn verify_build(root: &Path, expected_id: &str) -> Result<BuildManifest, String> {
    let root = fs::canonicalize(root).map_err(err)?;
    let manifest_path = root.join("build.json");
    let manifest: BuildManifest =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(err)?).map_err(err)?;
    if manifest.schema_version != 1
        || manifest.build_id != expected_id
        || manifest.runtime_api_version != 2
        || !matches!(manifest.bootstrap.as_str(), "runtime" | "tauri")
    {
        return Err(
            "candidate manifest is malformed or incompatible with the managed runtime".into(),
        );
    }
    read_build_source_inventory(&root, &manifest)?;
    if !root.join("runtime/runner.mjs").is_file() {
        return Err("candidate is missing required artifact runtime/runner.mjs".into());
    }
    if manifest.bootstrap == "runtime" && !root.join("runtime/core/engine.mjs").is_file() {
        return Err("candidate is missing required artifact runtime/core/engine.mjs".into());
    }
    if manifest.bootstrap == "tauri" {
        let resources: RuntimeResourceManifest = serde_json::from_slice(
            &fs::read(root.join("runtime/runtime-manifest.json")).map_err(err)?,
        )
        .map_err(err)?;
        if resources.kind != "DeszoRuntimeBuild" || resources.version != 1 {
            return Err("desktop runtime resource manifest is incompatible".into());
        }
        for name in ["runner.mjs", "bridge.mjs", "deszo-launch-shim.exe"] {
            let expected = resources
                .files
                .get(name)
                .ok_or_else(|| format!("desktop resource manifest does not list {name}"))?;
            let actual = file_sha256(&root.join("runtime").join(name))?;
            if !digest_eq(expected, &actual) {
                return Err(format!(
                    "desktop runtime resource digest is invalid for {name}"
                ));
            }
        }
    }
    if manifest.bootstrap == "tauri" {
        let executable = manifest
            .desktop_executable
            .as_deref()
            .ok_or("desktop manifest is missing desktopExecutable")?;
        let executable_path = Path::new(executable);
        if executable_path.components().count() != 1 || !root.join(executable_path).is_file() {
            return Err(
                "desktop manifest executable must name a file in the candidate root".into(),
            );
        }
        if manifest.desktop_build_id.as_deref() != Some(expected_id) {
            return Err(
                "desktop manifest build identity does not match the candidate identity".into(),
            );
        }
        for relative in [
            "runtime/bridge.mjs",
            "runtime/runtime-manifest.json",
            "runtime/deszo-launch-shim.exe",
        ] {
            if !root.join(relative).is_file() {
                return Err(format!(
                    "desktop candidate is missing required resource {relative}"
                ));
            }
        }
    }
    Ok(manifest)
}

fn verify_staged_candidate(shared: &Shared, request: &LifecycleRequest) -> Result<PathBuf, String> {
    validate_id(&request.candidate_id)?;
    let path = shared.staging_root.join(&request.candidate_id);
    let canonical = fs::canonicalize(&path).map_err(err)?;
    if !canonical.starts_with(&shared.staging_root) {
        return Err("candidate is outside the Host staging area".into());
    }
    let manifest = verify_build(&canonical, &request.candidate_id)?;
    if (shared.desktop_bootstrap && manifest.bootstrap != "tauri")
        || (!shared.desktop_bootstrap && manifest.bootstrap != "runtime")
    {
        return Err("candidate bootstrap is incompatible with this Host installation".into());
    }
    let actual = candidate_digest(&canonical)?;
    if !digest_eq(&actual, &request.candidate_digest) {
        return Err("candidate content digest does not match the lifecycle request".into());
    }
    Ok(canonical)
}

fn node_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
}

fn start_current_build(shared: &Arc<Shared>) -> Result<(), String> {
    let (build_id, digest, generation) = {
        let state = shared.state.lock().map_err(poison)?;
        (
            state.durable.active_build_id.clone(),
            state.durable.active_digest.clone(),
            state.durable.generation.clone(),
        )
    };
    let actual = candidate_digest(&shared.installation_root.join("versions").join(&build_id))?;
    if !digest_eq(&actual, &digest) {
        return Err("active application package changed outside the Host".into());
    }
    spawn_build(shared, &build_id, &generation)
}

fn spawn_build(shared: &Arc<Shared>, build_id: &str, generation: &str) -> Result<(), String> {
    // Node's Windows path parser does not accept Rust's extended `\\?\` absolute paths.
    // Keep those paths for filesystem operations, but pass ordinary drive paths to Node.
    let build_root = node_path(&shared.installation_root.join("versions").join(build_id));
    let manifest = verify_build(&build_root, build_id)?;
    let executable = if manifest.bootstrap == "tauri" {
        build_root.join(
            manifest
                .desktop_executable
                .as_deref()
                .expect("verified desktop executable"),
        )
    } else {
        shared.config.node_executable.clone()
    };
    let setup_stream = manifest.bootstrap == "runtime"
        && shared.config.test_setup_token_stdout
        && shared
            .state
            .lock()
            .map_err(poison)?
            .durable
            .operation
            .is_none();
    let mut command = if manifest.bootstrap == "tauri" {
        let mut command = Command::new(&executable);
        command.arg("--host-managed");
        command
    } else {
        let runtime = build_root.join("runtime/runner.mjs");
        let mut command = Command::new(&shared.config.node_executable);
        command
            .args(["--disable-warning=ExperimentalWarning"])
            .arg(&runtime)
            .arg("--root")
            .arg(&shared.profile_root)
            .arg("--connection-file")
            .arg(shared.profile_root.join("runtime/connection.json"))
            .arg("--host-contained");
        if let Some(fixtures) = &shared.config.fixture_state {
            command.arg("--fixture-state").arg(fixtures);
        }
        if shared.config.dev_test_confirmation_off {
            command.arg("--dev-test-confirmation-off");
        }
        if setup_stream {
            if !cfg!(debug_assertions) {
                return Err("test setup credentials are unavailable in a release Host".into());
            }
            command.arg("--first-party-token-stdout");
        }
        command
    };
    if manifest.bootstrap == "tauri" {
        // An explicitly supplied WebView2 root is a host-side override (used by isolated desktop
        // runs). Give each immutable build its own browser data directory so a closing version
        // cannot hold a profile lock while its replacement starts. Normal desktop launches keep
        // Tauri/WebView2's default user-data location because this variable is absent.
        if let Some(root) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
            let build_root = PathBuf::from(root).join(build_id);
            fs::create_dir_all(&build_root).map_err(err)?;
            command.env("WEBVIEW2_USER_DATA_FOLDER", build_root);
        }
    }
    command
        .current_dir(&build_root)
        .stdin(Stdio::piped())
        .stdout(if setup_stream && shared.config.forward_runtime_stdout {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stderr(if shared.config.forward_runtime_stderr {
            Stdio::inherit()
        } else {
            Stdio::null()
        });
    if manifest.bootstrap == "runtime" {
        command
            .env("DESZO_LIFECYCLE_HOST_ADDRESS", shared.address.to_string())
            .env("DESZO_LIFECYCLE_HOST_CAPABILITY", &shared.capability)
            .env("DESZO_LIFECYCLE_INSTALLATION_ID", &shared.installation_id)
            .env("DESZO_LIFECYCLE_PROFILE_ROOT", &shared.profile_root)
            .env("DESZO_LIFECYCLE_GENERATION", generation)
            .env("DESZO_APPLICATION_BUILD_ID", build_id)
            .env("DESZO_LIFECYCLE_APPLICATION_PID", "self")
            .env(
                "DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT",
                if shared.config.test_duplicate_receipt_delivery {
                    "1"
                } else {
                    "0"
                },
            );
    }
    let command_args: Vec<String> = command
        .get_args()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut containment = Containment::create()?;
    let mut child = command.spawn().map_err(err)?;
    if let Err(error) = containment.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let pid = child.id();
    let mut state = shared.state.lock().map_err(poison)?;
    if state.managed.is_some() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Host already has a managed application process".into());
    }
    state.managed = Some(ManagedProcess {
        child,
        containment,
        generation: generation.into(),
        build_id: build_id.into(),
        bootstrap: manifest.bootstrap.clone(),
        engine_pid: None,
    });
    state.ready_generation = None;
    let stdin = state
        .managed
        .as_mut()
        .and_then(|process| process.child.stdin.as_mut())
        .ok_or("managed runtime stdin is unavailable")?;
    let bootstrap = if manifest.bootstrap == "tauri" {
        serde_json::to_vec(&serde_json::json!({
            "command": "bootstrap",
            "hostAddress": shared.address.to_string(),
            "hostCapability": shared.capability,
            "installationId": shared.installation_id,
            "profileRoot": shared.profile_root,
            "generation": generation,
            "applicationBuildId": build_id,
            "applicationRoot": build_root,
            "nodeExecutable": shared.config.node_executable,
            "testDuplicateReceiptDelivery": shared.config.test_duplicate_receipt_delivery,
        }))
        .map_err(err)?
    } else {
        b"{\"command\":\"contained\"}\n".to_vec()
    };
    let bootstrap_result = stdin
        .write_all(&bootstrap)
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush());
    if let Err(error) = bootstrap_result {
        let mut failed = state.managed.take().expect("managed process was inserted");
        let _ = failed.child.kill();
        let _ = failed.child.wait();
        return Err(err(error));
    }
    drop(state);
    log_event(
        shared,
        "application_spawned",
        serde_json::json!({ "pid": pid, "applicationPid": pid, "buildId": build_id, "generation": generation, "profileRoot": shared.profile_root,
            "bootstrap": manifest.bootstrap, "executable": executable, "arguments": command_args }),
    )?;
    Ok(())
}

fn serve(listener: TcpListener, shared: Arc<Shared>) {
    loop {
        match listener.accept() {
            Ok((stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let inner = Arc::clone(&shared);
                let _ = thread::Builder::new()
                    .name("deszo-lifecycle-peer".into())
                    .spawn(move || handle_connection(stream, inner));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20))
            }
            Err(error) => {
                let _ = log_event(
                    &shared,
                    "ipc_listener_error",
                    serde_json::json!({ "message": error.to_string() }),
                );
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn handle_connection(mut stream: TcpStream, shared: Arc<Shared>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let cloned = match stream.try_clone() {
        Ok(value) => value,
        Err(_) => return,
    };
    let reader = BufReader::new(cloned);
    let mut line = String::new();
    if reader
        .take((IPC_MAX_LINE + 1) as u64)
        .read_line(&mut line)
        .is_err()
        || line.len() > IPC_MAX_LINE
    {
        return;
    }
    let envelope: Envelope = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(_) => {
            send_response(&mut stream, error_response("malformed request".into()));
            return;
        }
    };
    if !constant_time_equal(envelope.capability.as_bytes(), shared.capability.as_bytes()) {
        send_response(
            &mut stream,
            error_response("unauthenticated lifecycle peer".into()),
        );
        return;
    }
    match dispatch(&shared, envelope.command.as_str(), envelope.payload) {
        Dispatch::Reply(value) => send_response(&mut stream, value),
        Dispatch::Activate(request) => {
            let request = *request;
            send_response(
                &mut stream,
                ok(serde_json::json!({ "accepted": true, "operationId": request.operation_id })),
            );
            let inner = Arc::clone(&shared);
            let _ = thread::Builder::new()
                .name("deszo-candidate-activation".into())
                .spawn(move || activate_candidate(&inner, request));
        }
    }
}

enum Dispatch {
    Reply(Response),
    Activate(Box<LifecycleRequest>),
}

fn dispatch(shared: &Arc<Shared>, command: &str, payload: serde_json::Value) -> Dispatch {
    match command {
        "engine.ready" => match serde_json::from_value::<ReadyMessage>(payload) {
            Ok(message) => match accept_ready(shared, message) {
                Ok(result) => Dispatch::Reply(ok(result)),
                Err(message) => Dispatch::Reply(error_response(message)),
            },
            Err(parse_error) => Dispatch::Reply(error_response(format!(
                "invalid engine readiness message: {parse_error}"
            ))),
        },
        "engine.source_release" => match active_source_release(shared, &payload) {
            Ok(result) => Dispatch::Reply(ok(result)),
            Err(message) => Dispatch::Reply(Response { ok: false, result: None, error: Some(message), code: Some("source_release_unavailable".into()) }),
        },
        "engine.source_inventory" => match active_source_inventory(shared, &payload) {
            Ok(result) => Dispatch::Reply(ok(result)),
            Err(message) => Dispatch::Reply(Response { ok: false, result: None, error: Some(message), code: Some("source_inventory_unavailable".into()) }),
        },
        "lifecycle.activate_candidate" => match serde_json::from_value::<LifecycleRequest>(payload)
        {
            Ok(request) => match accept_operation(shared, request.clone()) {
                Ok(true) => Dispatch::Activate(Box::new(request)),
                Ok(false) => Dispatch::Reply(ok(
                    serde_json::json!({ "accepted": true, "duplicate": true, "operationId": request.operation_id }),
                )),
                Err(message) => Dispatch::Reply(error_response(message)),
            },
            Err(parse_error) => Dispatch::Reply(error_response(format!(
                "invalid lifecycle operation: {parse_error}"
            ))),
        },
        "lifecycle.receipt_ack" => match payload.get("receiptId").and_then(|v| v.as_str()) {
            Some(id) => match acknowledge_receipt(shared, id) {
                Ok(()) => Dispatch::Reply(ok(serde_json::json!({ "acknowledged": true }))),
                Err(message) => Dispatch::Reply(error_response(message)),
            },
            None => Dispatch::Reply(error_response(
                "receipt acknowledgement is missing its identity".into(),
            )),
        },
        command if command.starts_with("custody.") => match &shared.custody {
            Some(custody) => match custody.dispatch(command, &payload) {
                Ok(value) => Dispatch::Reply(ok(value)),
                Err(refusal) => Dispatch::Reply(Response { ok: false, result: None, error: Some(refusal.message), code: Some(refusal.code.to_string()) }),
            },
            None => Dispatch::Reply(Response { ok: false, result: None, error: Some("Process Custody is not enabled in this Host.".into()), code: Some("custody_disabled".into()) }),
        },
        "engine.status" => {
            let state = match shared.state.lock() {
                Ok(value) => value,
                Err(poisoned) => return Dispatch::Reply(error_response(poisoned.to_string())),
            };
            let operation = state.durable.operation.as_ref().map(|v| serde_json::json!({ "operationId": v.request.operation_id, "phase": v.phase, "failure": v.failure }));
            let application_pid = state.managed.as_ref().map(|process| process.child.id());
            let engine_pid = state
                .managed
                .as_ref()
                .and_then(|process| process.engine_pid);
            Dispatch::Reply(ok(
                serde_json::json!({ "hostPid": std::process::id(), "installationId": state.durable.installation_id, "profileRoot": shared.profile_root,
                "applicationPid": application_pid, "enginePid": engine_pid,
                "activeBuildId": state.durable.active_build_id, "generation": state.durable.generation, "operation": operation, "receipt": state.durable.operation.as_ref().and_then(|v| v.receipt.as_ref()) }),
            ))
        }
        _ => Dispatch::Reply(error_response(
            "unsupported lifecycle protocol command".into(),
        )),
    }
}

// The Engine does not infer its own trusted source release from a local Git checkout or a build label. The
// Lifecycle Host returns the active, already verified package identity and the source fields in its build
// manifest. The whole package is re-hashed for each request, and the active generation is checked again after
// filesystem work so an activation cannot race the result.
fn active_source_release(shared: &Arc<Shared>, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let requested_generation = payload.get("generation").and_then(|value| value.as_str())
        .ok_or_else(|| "source release request is missing its lifecycle generation".to_string())?;
    let requested_engine_pid = payload.get("pid").and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok()).filter(|value| *value > 0)
        .ok_or_else(|| "source release request is missing a valid managed Engine PID".to_string())?;
    let (generation, build_id, expected_digest, application_pid, expected_engine_pid, ready_generation) = {
        let state = shared.state.lock().map_err(poison)?;
        let managed = state.managed.as_ref().ok_or("Lifecycle Host has no managed application")?;
        let application_pid = managed.child.id();
        if requested_generation != state.durable.generation
            || managed.generation != state.durable.generation
            || managed.build_id != state.durable.active_build_id
        {
            return Err("source release request belongs to a stale Engine generation".into());
        }
        (state.durable.generation.clone(), state.durable.active_build_id.clone(), state.durable.active_digest.clone(),
            application_pid, managed.engine_pid, state.ready_generation.clone())
    };
    let parent_pid = if expected_engine_pid.is_none() && shared.desktop_bootstrap {
        Some(process_parent_pid(requested_engine_pid)?)
    } else { None };
    validate_source_release_engine_pid(requested_engine_pid, application_pid, expected_engine_pid,
        ready_generation.as_deref(), &generation, shared.desktop_bootstrap, parent_pid)?;
    let versions = fs::canonicalize(shared.installation_root.join("versions")).map_err(err)?;
    let root = fs::canonicalize(versions.join(&build_id)).map_err(err)?;
    if !path_is_within(&versions, &root) {
        return Err("active source release is outside the managed versions directory".into());
    }
    let manifest = verify_build(&root, &build_id)?;
    let package_digest = candidate_digest(&root)?;
    if !digest_eq(&package_digest, &expected_digest) {
        return Err("active managed package changed after Host verification".into());
    }
    let result = source_release_value(&shared.installation_id, &build_id, &manifest, &package_digest)?;
    let state = shared.state.lock().map_err(poison)?;
    let managed = state.managed.as_ref().ok_or("Lifecycle Host has no managed application")?;
    let current_application_pid = managed.child.id();
    let current_parent_pid = if managed.engine_pid.is_none() && shared.desktop_bootstrap {
        Some(process_parent_pid(requested_engine_pid)?)
    } else { None };
    if state.durable.generation != generation || state.durable.active_build_id != build_id
        || state.durable.active_digest != expected_digest || managed.generation != generation || managed.build_id != build_id
    {
        return Err("active source release changed while it was being verified".into());
    }
    validate_source_release_engine_pid(requested_engine_pid, current_application_pid, managed.engine_pid,
        state.ready_generation.as_deref(), &generation, shared.desktop_bootstrap, current_parent_pid)
        .map_err(|_| "active source release changed while it was being verified".to_string())?;
    Ok(result)
}

fn active_source_inventory(shared: &Arc<Shared>, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let requested_generation = payload.get("generation").and_then(|value| value.as_str())
        .ok_or_else(|| "source inventory request is missing its lifecycle generation".to_string())?;
    let requested_paths = payload.get("paths").and_then(|value| value.as_array())
        .ok_or_else(|| "source inventory request is missing its path batch".to_string())?;
    if requested_paths.is_empty() || requested_paths.len() > SOURCE_INVENTORY_BATCH_MAX {
        return Err("source inventory path batch is empty or exceeds its bound".into());
    }
    let mut paths = Vec::with_capacity(requested_paths.len());
    let mut unique = std::collections::HashSet::with_capacity(requested_paths.len());
    let mut total_path_bytes = 0usize;
    for value in requested_paths {
        let path = value.as_str().ok_or("source inventory path is not text")?;
        if !path.is_ascii() || path.len() > 4096 {
            return Err("source inventory path is outside the portable P5 path bound".into());
        }
        validate_build_inventory_path(path)?;
        if path.split('/').any(|part| matches!(part.to_ascii_lowercase().as_str(), ".git" | ".p5")) {
            return Err("source inventory query includes a reserved P5 path".into());
        }
        total_path_bytes = total_path_bytes.checked_add(path.len()).ok_or("source inventory path batch is too large")?;
        if total_path_bytes > 32 * 1024 || !unique.insert(path) {
            return Err("source inventory path batch is too large or contains duplicates".into());
        }
        paths.push(path.to_string());
    }

    let before = active_source_release(shared, payload)?;
    let build_id = before.get("buildId").and_then(|value| value.as_str()).ok_or("active source release omitted its build identity")?;
    let package_digest = before.get("packageSha256").and_then(|value| value.as_str()).ok_or("active source release omitted its package digest")?;
    let versions = fs::canonicalize(shared.installation_root.join("versions")).map_err(err)?;
    let root = fs::canonicalize(versions.join(build_id)).map_err(err)?;
    if !path_is_within(&versions, &root) {
        return Err("active source inventory is outside the managed versions directory".into());
    }
    let manifest = verify_build(&root, build_id)?;
    let inventory = read_build_source_inventory(&root, &manifest)?
        .ok_or("active build has no attested source inventory")?;
    if inventory.source_commit != before["sourceCommit"].as_str().unwrap_or_default()
        || inventory.source_digest != before["sourceDigest"].as_str().unwrap_or_default()
    {
        return Err("active source inventory changed its source release identity".into());
    }
    let entries = select_source_inventory_entries(&inventory, &paths)?;
    let result = serde_json::json!({
        "schemaVersion": 1,
        "kind": "ProtectedSelfRepairRunningSourceInventory",
        "installationId": before["installationId"],
        "buildId": build_id,
        "packageSha256": package_digest,
        "sourceCommit": inventory.source_commit,
        "sourceDigest": inventory.source_digest,
        "generation": requested_generation,
        "entries": entries,
    });
    let after = active_source_release(shared, payload)?;
    if before != after {
        return Err("active source release changed while its inventory was being read".into());
    }
    Ok(result)
}

fn validate_source_release_engine_pid(requested_pid: u32, application_pid: u32, managed_engine_pid: Option<u32>,
    ready_generation: Option<&str>, active_generation: &str, desktop_bootstrap: bool,
    observed_parent_pid: Option<u32>) -> Result<(), String> {
    if requested_pid == 0 { return Err("source release request has an invalid Engine PID".into()); }
    if ready_generation == Some(active_generation) {
        return if managed_engine_pid == Some(requested_pid) { Ok(()) }
            else { Err("source release request belongs to a different ready Engine process".into()) };
    }
    if ready_generation.is_some() || managed_engine_pid.is_some() {
        return Err("source release request belongs to a stale or inconsistent Engine generation".into());
    }
    if desktop_bootstrap {
        if observed_parent_pid == Some(application_pid) { Ok(()) }
        else { Err("source release request did not come from the managed desktop Engine child".into()) }
    } else if requested_pid == application_pid {
        Ok(())
    } else {
        Err("source release request did not come from the managed runtime process".into())
    }
}

fn source_release_value(installation_id: &str, build_id: &str, manifest: &BuildManifest, package_digest: &str) -> Result<serde_json::Value, String> {
    if installation_id.len() != 32 || !installation_id.bytes().all(|value| value.is_ascii_hexdigit())
        || build_id.is_empty() || build_id.len() > 100
        || !build_id.bytes().all(|value| value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-'))
    {
        return Err("active installation or build identity is malformed".into());
    }
    if package_digest.len() != 64 || !package_digest.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("active managed package digest is malformed".into());
    }
    let source_commit = manifest.source_commit.as_deref().ok_or("active build has no trusted source commit")?;
    if !matches!(source_commit.len(), 40 | 64) || !source_commit.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("active build source commit is malformed".into());
    }
    let source_digest = manifest.dirty_source_digest.as_deref().ok_or("active build has no captured source digest")?;
    let inputs_digest = manifest.inputs_digest.as_deref().ok_or("active build has no captured input digest")?;
    for (label, digest) in [("source", source_digest), ("input", inputs_digest)] {
        if digest.len() != 64 || !digest.bytes().all(|value| value.is_ascii_hexdigit()) {
            return Err(format!("active build {label} digest is malformed"));
        }
    }
    Ok(serde_json::json!({
        "schemaVersion": 1,
        "kind": "ProtectedSelfRepairRunningSourceRelease",
        "installationId": installation_id.to_ascii_lowercase(),
        "buildId": build_id,
        "bootstrap": manifest.bootstrap,
        "packageSha256": package_digest.to_ascii_lowercase(),
        "sourceCommit": source_commit.to_ascii_lowercase(),
        "sourceDigest": source_digest.to_ascii_lowercase(),
        "inputsDigest": inputs_digest.to_ascii_lowercase(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyMessage {
    pid: u32,
    application_pid: u32,
    application_build_id: String,
    installation_id: String,
    profile_root: String,
    generation: String,
    store_id: String,
    runtime_instance_id: String,
}

#[cfg(windows)]
fn process_parent_pid(pid: u32) -> Result<u32, String> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(format!(
                "Could not inspect the managed process tree: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        let mut ok = Process32FirstW(snapshot, &mut entry);
        while ok != 0 {
            if entry.th32ProcessID == pid {
                found = Some(entry.th32ParentProcessID);
                break;
            }
            ok = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        found.ok_or_else(|| format!("Engine process {pid} was absent from the process snapshot"))
    }
}

#[cfg(target_os = "linux")]
fn process_parent_pid(pid: u32) -> Result<u32, String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).map_err(err)?;
    let fields = stat
        .rsplit_once(')')
        .ok_or("process stat record is malformed")?
        .1;
    fields
        .split_whitespace()
        .nth(1)
        .ok_or("process stat record has no parent PID")?
        .parse()
        .map_err(err)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn process_parent_pid(_pid: u32) -> Result<u32, String> {
    Err("desktop Engine parent verification is unavailable on this platform".into())
}

fn accept_ready(shared: &Arc<Shared>, message: ReadyMessage) -> Result<serde_json::Value, String> {
    let mut state = shared.state.lock().map_err(poison)?;
    let Some(managed) = state.managed.as_ref() else {
        let active_build_id = state.durable.active_build_id.clone();
        let generation = state.durable.generation.clone();
        drop(state);
        let _ = log_event(
            shared,
            "engine_readiness_refused",
            serde_json::json!({ "pid": message.pid, "activeBuildId": active_build_id, "generation": generation,
                "reason": "Host has no managed application process" }),
        );
        return Err("Host has no managed application process".into());
    };
    let application_pid = managed.child.id();
    if message.application_pid != application_pid {
        return Err("Engine readiness names a different managed desktop process".into());
    }
    if shared.desktop_bootstrap {
        if process_parent_pid(message.pid)? != application_pid {
            return Err("Engine readiness did not come from a direct child of the managed Tauri application".into());
        }
    } else if message.pid != application_pid {
        return Err("Engine readiness came from a process other than the managed runtime".into());
    }
    if message.installation_id != state.durable.installation_id
        || message.profile_root != shared.profile_root.to_string_lossy()
    {
        return Err("Engine readiness names a different installation/profile".into());
    }
    if message.application_build_id != state.durable.active_build_id
        || message.generation != state.durable.generation
        || managed.build_id != message.application_build_id
        || managed.generation != message.generation
    {
        return Err(
            "Engine readiness build or generation does not match the active installation".into(),
        );
    }
    if let Some(expected) = &state.durable.store_id {
        if expected != &message.store_id {
            return Err("new Engine did not open the original persistent store".into());
        }
    } else {
        state.durable.store_id = Some(message.store_id.clone());
    }
    if let Some(managed) = state.managed.as_mut() {
        managed.engine_pid = Some(message.pid);
    }
    state.ready_generation = Some(message.generation.clone());
    let mut receipt = None;
    if let Some(operation) = state.durable.operation.as_mut() {
        if operation.phase == "starting"
            && operation.request.candidate_id == message.application_build_id
        {
            let request = &operation.request;
            let value = LifecycleReceipt {
                operation_id: request.operation_id.clone(),
                receipt_id: Uuid::new_v4().to_string(),
                installation_id: request.installation_id.clone(),
                profile_root: request.profile_root.clone(),
                candidate_id: request.candidate_id.clone(),
                candidate_digest: request.candidate_digest.clone(),
                previous_generation: request.expected_generation.clone(),
                activated_generation: message.generation.clone(),
                store_id: message.store_id.clone(),
                host_pid: std::process::id(),
                application_pid,
                engine_pid: message.pid,
                application_build_id: message.application_build_id.clone(),
                runtime_instance_id: message.runtime_instance_id.clone(),
                actual_activation: true,
                application_responsive: true,
                engine_ready: true,
            };
            operation.receipt = Some(value.clone());
            operation.phase = "verified".into();
            operation.failure = None;
            receipt = Some(value);
        } else if operation.phase == "verified" && !operation.receipt_acknowledged {
            if let Some(saved) = operation.receipt.as_mut() {
                // Reconcile an unacknowledged receipt against the currently ready Engine generation after a Host crash.
                saved.activated_generation = message.generation.clone();
                saved.engine_pid = message.pid;
                receipt = Some(saved.clone());
            }
        }
    }
    persist_state(&shared.state_file, &state.durable)?;
    drop(state);
    log_event(
        shared,
        "engine_ready",
        serde_json::json!({ "pid": message.pid, "enginePid": message.pid, "applicationPid": message.application_pid,
        "buildId": message.application_build_id, "generation": message.generation,
        "storeId": message.store_id, "runtimeInstanceId": message.runtime_instance_id, "receiptId": receipt.as_ref().map(|r| &r.receipt_id) }),
    )?;
    shared.ready.notify_all();
    Ok(serde_json::json!({ "ready": true, "receipt": receipt }))
}

fn accept_operation(shared: &Arc<Shared>, request: LifecycleRequest) -> Result<bool, String> {
    validate_request_shape(&request)?;
    if request.action != "application.activate_candidate" {
        return Err("Host supports only application.activate_candidate".into());
    }
    if request.installation_id != shared.installation_id {
        return Err("lifecycle request installation identity mismatch".into());
    }
    if node_path(&fs::canonicalize(&request.profile_root).map_err(err)?) != shared.profile_root {
        return Err("lifecycle request profile identity mismatch".into());
    }
    if request.expected_generation.is_empty() {
        return Err("lifecycle request is missing the expected application generation".into());
    }
    if request.judge_evidence.kind != "engine_validated_designated_judge_decision"
        || request.judge_evidence.workflow_id.is_empty()
        || request.judge_evidence.judge_node_instance_id.is_empty()
        || request.judge_evidence.attempt_id.is_empty()
    {
        return Err("lifecycle request is missing Engine-validated Judge decision evidence".into());
    }
    if !request.readiness.application_responsive
        || !request.readiness.engine_ready
        || !request.readiness.same_profile
        || !request.readiness.same_store
    {
        return Err("lifecycle request does not require all Host readiness checks".into());
    }
    let _ = verify_staged_candidate(shared, &request)?;
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&request).map_err(err)?));
    let mut state = shared.state.lock().map_err(poison)?;
    if state.durable.generation != request.expected_generation {
        return Err("stale lifecycle request: expected generation is not active".into());
    }
    if let Some(existing) = &state.durable.operation {
        if existing.request.operation_id == request.operation_id {
            if existing.request_fingerprint == fingerprint {
                if existing.phase == "failed" {
                    return Err(
                        "the durable lifecycle operation failed and will not be replayed".into(),
                    );
                }
                return Ok(false);
            }
            return Err("lifecycle operation identity was replayed with different content".into());
        }
        if !matches!(existing.phase.as_str(), "failed" | "verified") {
            return Err("another lifecycle operation is already active".into());
        }
    }
    state.durable.operation = Some(OperationRecord {
        request: request.clone(),
        request_fingerprint: fingerprint,
        phase: "accepted".into(),
        failure: None,
        receipt: None,
        receipt_acknowledged: false,
    });
    persist_state(&shared.state_file, &state.durable)?;
    drop(state);
    log_event(
        shared,
        "activation_accepted",
        serde_json::json!({ "operationId": request.operation_id, "runId": request.run_id, "nodeInstanceId": request.node_instance_id,
        "candidateId": request.candidate_id, "candidateDigest": request.candidate_digest, "expectedGeneration": request.expected_generation }),
    )?;
    Ok(true)
}

fn activate_candidate(shared: &Arc<Shared>, request: LifecycleRequest) {
    if let Err(error) = activate_candidate_inner(shared, &request) {
        if let Ok(mut state) = shared.state.lock() {
            if let Some(operation) = state.durable.operation.as_mut().filter(|op| {
                op.request.operation_id == request.operation_id && op.receipt.is_none()
            }) {
                operation.phase = "failed".into();
                operation.failure = Some(error.clone());
                let _ = persist_state(&shared.state_file, &state.durable);
            }
        }
        let _ = log_event(
            shared,
            "activation_failed",
            serde_json::json!({ "operationId": request.operation_id, "message": error }),
        );
        shared.ready.notify_all();
    }
}

fn activate_candidate_inner(
    shared: &Arc<Shared>,
    request: &LifecycleRequest,
) -> Result<(), String> {
    let source = verify_staged_candidate(shared, request)?;
    {
        let mut state = shared.state.lock().map_err(poison)?;
        let operation = state
            .durable
            .operation
            .as_mut()
            .ok_or("lifecycle intent disappeared")?;
        if operation.request.operation_id != request.operation_id || operation.phase != "accepted" {
            return Err("lifecycle intent is no longer eligible".into());
        }
        operation.phase = "shutdown_requested".into();
        persist_state(&shared.state_file, &state.durable)?;
    }
    log_event(
        shared,
        "shutdown_requested",
        serde_json::json!({ "operationId": request.operation_id, "reason": "managed_restart" }),
    )?;
    if let Some(millis) = shared.config.test_pause_after_shutdown_requested_ms {
        thread::sleep(Duration::from_millis(millis));
    }
    shutdown_managed_for_lifecycle(shared)?;
    {
        let mut state = shared.state.lock().map_err(poison)?;
        let operation = state
            .durable
            .operation
            .as_mut()
            .ok_or("lifecycle intent disappeared")?;
        operation.phase = "old_process_stopped".into();
        persist_state(&shared.state_file, &state.durable)?;
    }
    log_event(
        shared,
        "old_process_stopped",
        serde_json::json!({ "operationId": request.operation_id }),
    )?;

    let destination = shared
        .installation_root
        .join("versions")
        .join(&request.candidate_id);
    fs::create_dir_all(destination.parent().expect("version parent")).map_err(err)?;
    if destination.exists() {
        let existing = candidate_digest(&destination)?;
        if !digest_eq(&existing, &request.candidate_digest) {
            return Err(
                "installed candidate identity already exists with different content".into(),
            );
        }
    } else {
        let staging_copy = shared
            .installation_root
            .join("versions")
            .join(format!(".incoming-{}", request.operation_id));
        if staging_copy.exists() {
            fs::remove_dir_all(&staging_copy).map_err(err)?;
        }
        copy_tree(&source, &staging_copy)?;
        let copied = candidate_digest(&staging_copy)?;
        if !digest_eq(&copied, &request.candidate_digest) {
            let _ = fs::remove_dir_all(&staging_copy);
            return Err("candidate changed during activation copy".into());
        }
        fs::rename(&staging_copy, &destination).map_err(err)?;
    }
    let installed_digest = candidate_digest(&destination)?;
    if !digest_eq(&installed_digest, &request.candidate_digest) {
        return Err("activated candidate digest does not match the authorized digest".into());
    }
    let new_generation = Uuid::new_v4().to_string();
    {
        let mut state = shared.state.lock().map_err(poison)?;
        state.durable.active_build_id = request.candidate_id.clone();
        state.durable.active_digest = installed_digest.clone();
        state.durable.generation = new_generation.clone();
        // Custody follows the lifecycle generation: the new Engine attaches under it, the previous one is refused.
        if let Some(custody) = &shared.custody {
            custody.set_generation(&new_generation);
        }
        let operation = state
            .durable
            .operation
            .as_mut()
            .ok_or("lifecycle intent disappeared")?;
        operation.phase = "starting".into();
        write_json_atomic(
            &shared.active_file,
            &ActivePointer {
                build_id: request.candidate_id.clone(),
                digest: installed_digest.clone(),
                generation: new_generation.clone(),
            },
        )?;
        persist_state(&shared.state_file, &state.durable)?;
    }
    log_event(
        shared,
        "candidate_activated",
        serde_json::json!({ "operationId": request.operation_id, "candidateId": request.candidate_id,
        "candidateDigest": installed_digest, "generation": new_generation }),
    )?;
    spawn_build(shared, &request.candidate_id, &new_generation)?;

    let deadline = Instant::now() + readiness_timeout(&shared.config);
    let mut state = shared.state.lock().map_err(poison)?;
    loop {
        let operation = state
            .durable
            .operation
            .as_ref()
            .ok_or("lifecycle intent disappeared")?;
        if operation.request.operation_id != request.operation_id {
            return Err("lifecycle operation was superseded".into());
        }
        if operation.phase == "verified" {
            return Ok(());
        }
        if operation.phase == "failed" {
            let failure = operation
                .failure
                .clone()
                .unwrap_or_else(|| "new Engine readiness failed".into());
            drop(state);
            shutdown_managed(shared)?;
            return Err(failure);
        }
        if let Some(managed) = state.managed.as_mut() {
            if let Some(status) = managed.child.try_wait().map_err(err)? {
                drop(state);
                shutdown_managed(shared)?;
                return Err(format!(
                    "new Engine exited before lifecycle readiness with status {status}"
                ));
            }
        } else {
            drop(state);
            return Err("new Engine exited before lifecycle readiness".into());
        }
        let now = Instant::now();
        if now >= deadline {
            drop(state);
            shutdown_managed(shared)?;
            return Err("new Engine did not become ready before the Host deadline".into());
        }
        let wait = (deadline - now).min(Duration::from_millis(250));
        let (next, _) = shared.ready.wait_timeout(state, wait).map_err(poison)?;
        state = next;
    }
}

fn acknowledge_receipt(shared: &Arc<Shared>, receipt_id: &str) -> Result<(), String> {
    let mut state = shared.state.lock().map_err(poison)?;
    let operation = state
        .durable
        .operation
        .as_mut()
        .ok_or("there is no lifecycle receipt to acknowledge")?;
    let receipt = operation
        .receipt
        .as_ref()
        .ok_or("there is no lifecycle receipt to acknowledge")?;
    if receipt.receipt_id != receipt_id {
        return Err("receipt identity does not match the Host journal".into());
    }
    operation.receipt_acknowledged = true;
    persist_state(&shared.state_file, &state.durable)?;
    drop(state);
    log_event(
        shared,
        "receipt_acknowledged",
        serde_json::json!({ "receiptId": receipt_id }),
    )
}

fn wait_for_engine_ready(shared: &Arc<Shared>, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut state = shared.state.lock().map_err(poison)?;
    loop {
        if state.ready_generation.as_deref() == Some(state.durable.generation.as_str()) {
            return Ok(());
        }
        if let Some(managed) = state.managed.as_mut() {
            if let Some(status) = managed.child.try_wait().map_err(err)? {
                return Err(format!(
                    "managed Engine exited before readiness with status {status}"
                ));
            }
        } else {
            return Err("managed Engine exited before readiness".into());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("managed Engine did not become ready".into());
        }
        let wait = (deadline - now).min(Duration::from_millis(250));
        let (next, _) = shared.ready.wait_timeout(state, wait).map_err(poison)?;
        state = next;
    }
}

fn shutdown_managed(shared: &Arc<Shared>) -> Result<(), String> {
    shutdown_managed_inner(shared, false)
}

fn shutdown_managed_for_lifecycle(shared: &Arc<Shared>) -> Result<(), String> {
    shutdown_managed_inner(shared, true)
}

fn shutdown_managed_inner(shared: &Arc<Shared>, require_running: bool) -> Result<(), String> {
    let mut managed = {
        let mut state = shared.state.lock().map_err(poison)?;
        state.managed.take()
    };
    let Some(mut process) = managed.take() else {
        return Ok(());
    };
    let exited_before_shutdown = process.child.try_wait().map_err(err)?;
    if let Some(status) = exited_before_shutdown.as_ref() {
        if require_running {
            let message = format!(
                "managed {} application {} exited before Host shutdown with status {status}",
                process.bootstrap,
                process.child.id()
            );
            log_event(
                shared,
                "managed_application_exited_unexpectedly",
                serde_json::json!({ "pid": process.child.id(), "buildId": &process.build_id,
                    "generation": &process.generation, "bootstrap": &process.bootstrap,
                    "status": status.to_string(), "message": &message }),
            )?;
        }
    } else if let Some(stdin) = process.child.stdin.as_mut() {
        let _ = stdin.write_all(b"{\"command\":\"shutdown\"}\n");
        let _ = stdin.flush();
    }
    let started = Instant::now();
    loop {
        if process.child.try_wait().map_err(err)?.is_some() {
            break;
        }
        if started.elapsed() >= SHUTDOWN_TIMEOUT {
            process.containment.terminate()?;
            break;
        }
        thread::sleep(Duration::from_millis(40));
    }
    let _ = process.child.wait();
    let containment_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if process.containment.is_empty()? {
            break;
        }
        if Instant::now() >= containment_deadline {
            process.containment.terminate()?;
            let verify_deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < verify_deadline && !process.containment.is_empty()? {
                thread::sleep(Duration::from_millis(50));
            }
            if !process.containment.is_empty()? {
                return Err(
                    "Host could not confirm termination of every owned managed process".into(),
                );
            }
            break;
        }
        thread::sleep(Duration::from_millis(40));
    }
    log_event(
        shared,
        "managed_process_tree_stopped",
        serde_json::json!({ "pid": process.child.id(), "applicationPid": process.child.id(), "enginePid": process.engine_pid,
            "buildId": process.build_id, "generation": process.generation, "bootstrap": process.bootstrap }),
    )?;
    if require_running {
        if let Some(status) = exited_before_shutdown {
            return Err(format!(
                "managed {} application {} exited before Host shutdown with status {status}",
                process.bootstrap,
                process.child.id()
            ));
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(err)?;
    for entry in fs::read_dir(source).map_err(err)? {
        let entry = entry.map_err(err)?;
        let ty = entry.file_type().map_err(err)?;
        if ty.is_symlink() {
            return Err("candidate contains a symbolic link".into());
        }
        let out = destination.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&entry.path(), &out)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), out).map_err(err)?;
        } else {
            return Err("candidate contains an unsupported filesystem object".into());
        }
    }
    Ok(())
}

fn persist_state(path: &Path, state: &DurableState) -> Result<(), String> {
    write_json_atomic(path, state)
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("state path has no parent")?;
    fs::create_dir_all(parent).map_err(err)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec(value).map_err(err)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(err)?;
    file.write_all(&bytes).map_err(err)?;
    file.sync_all().map_err(err)?;
    replace_file(&temporary, path)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(format!(
            "atomic state replacement failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(err)
}

fn append_journal(path: &Path, kind: &str, payload: serde_json::Value) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(err)?;
    let row = serde_json::json!({ "at": now(), "hostPid": std::process::id(), "type": kind, "payload": payload });
    writeln!(file, "{}", serde_json::to_string(&row).map_err(err)?).map_err(err)?;
    file.sync_all().map_err(err)
}

fn log_event(shared: &Shared, kind: &str, payload: serde_json::Value) -> Result<(), String> {
    let row = serde_json::json!({ "at": now(), "hostPid": std::process::id(), "type": kind, "payload": payload });
    let mut journal = shared.journal.lock().map_err(poison)?;
    writeln!(journal, "{}", serde_json::to_string(&row).map_err(err)?).map_err(err)?;
    journal.sync_all().map_err(err)?;
    eprintln!("{}", serde_json::to_string(&row).map_err(err)?);
    Ok(())
}

fn send_response(stream: &mut TcpStream, response: Response) {
    if let Ok(bytes) = serde_json::to_vec(&response) {
        let _ = stream.write_all(&bytes);
        let _ = stream.write_all(b"\n");
        let _ = stream.flush();
    }
}
fn ok(result: serde_json::Value) -> Response {
    Response {
        ok: true,
        result: Some(result),
        error: None,
        code: None,
    }
}
fn error_response(message: String) -> Response {
    Response {
        ok: false,
        result: None,
        error: Some(message),
        code: None,
    }
}
fn random_capability() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn digest_eq(left: &str, right: &str) -> bool {
    constant_time_equal(left.as_bytes(), right.as_bytes())
}
fn constant_time_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}
fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn poison<T>(error: std::sync::PoisonError<T>) -> String {
    error.to_string()
}

fn refuse_legacy_owner(profile_root: &Path) -> Result<(), String> {
    if std::env::var_os("DESZO_CONTROL_HOST_PIPE").is_some() {
        return Err(
            "legacy lifecycle Host binding is active; refusing concurrent ownership".into(),
        );
    }
    #[cfg(windows)]
    {
        use std::{os::windows::ffi::OsStrExt, ptr::null};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING},
            System::Pipes::WaitNamedPipeW,
        };
        let pipe: Vec<u16> = std::ffi::OsStr::new(r"\\.\pipe\deszo-control-host-v1")
            .encode_wide()
            .chain(Some(0))
            .collect();
        let available = unsafe { WaitNamedPipeW(pipe.as_ptr(), 0) } != 0;
        if available {
            let handle = unsafe {
                CreateFileW(
                    pipe.as_ptr(),
                    0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    null(),
                    OPEN_EXISTING,
                    0,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(handle) };
                // The legacy service owns one configured profile tree. Its mere presence must
                // not prevent an independently installed Host from using an isolated profile.
                // Registered legacy profiles are constrained beneath this configured root.
                let program_files = std::env::var_os("ProgramFiles")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
                let installation_file = program_files
                    .join("Deszo Control Host")
                    .join("installation.json");
                let installation: serde_json::Value =
                    serde_json::from_slice(&fs::read(&installation_file).map_err(|error| {
                        format!("cannot scope the active legacy Control Host: {error}")
                    })?)
                    .map_err(|error| {
                        format!("cannot parse the active legacy Control Host installation: {error}")
                    })?;
                let legacy_profile_root = installation
                    .get("profileRoot")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        "active legacy Control Host has no configured profile root".to_string()
                    })?;
                let legacy_profile_root =
                    fs::canonicalize(legacy_profile_root).map_err(|error| {
                        format!(
                            "cannot resolve the active legacy Control Host profile root: {error}"
                        )
                    })?;
                if path_is_within(&legacy_profile_root, profile_root) {
                    return Err(
                        "legacy Windows Control Host owns the requested profile tree".into(),
                    );
                }
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let root = node_path(root).to_string_lossy().replace('/', "\\");
    let candidate = node_path(candidate).to_string_lossy().replace('/', "\\");
    let root = root.trim_end_matches('\\').to_lowercase();
    let candidate = candidate.to_lowercase();
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

#[cfg(not(windows))]
fn path_is_within(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn validate_request_shape(request: &LifecycleRequest) -> Result<(), String> {
    if request.operation_id.is_empty()
        || request.run_id.is_empty()
        || request.node_instance_id.is_empty()
    {
        return Err("operation/run/node identity is required".into());
    }
    Uuid::parse_str(&request.operation_id)
        .map_err(|_| "lifecycle operation identity must be a UUID")?;
    Uuid::parse_str(&request.run_id).map_err(|_| "workflow run identity must be a UUID")?;
    validate_id(&request.candidate_id)?;
    if request.candidate_digest.len() != 64
        || !request
            .candidate_digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("candidate digest must be lowercase SHA-256".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{managed_relaunch_decision, RelaunchDecision, MANAGED_RELAUNCH_LIMIT};

    #[test]
    fn managed_relaunch_policy_is_bounded_and_never_races() {
        // An abnormal runtime Engine exit relaunches while the rolling budget lasts.
        for recent in 0..MANAGED_RELAUNCH_LIMIT {
            assert_eq!(managed_relaunch_decision("runtime", false, false, false, recent), RelaunchDecision::Relaunch);
        }
        // The budget is finite, and once latched no later exit relaunches, even after the window empties.
        assert_eq!(managed_relaunch_decision("runtime", false, false, false, MANAGED_RELAUNCH_LIMIT), RelaunchDecision::Exhausted);
        assert_eq!(managed_relaunch_decision("runtime", false, true, false, 0), RelaunchDecision::Hold);
        // A clean exit, a desktop bootstrap and a durable lifecycle operation never relaunch.
        assert_eq!(managed_relaunch_decision("runtime", true, false, false, 0), RelaunchDecision::Hold);
        assert_eq!(managed_relaunch_decision("tauri", false, false, false, 0), RelaunchDecision::Hold);
        assert_eq!(managed_relaunch_decision("runtime", false, false, true, 0), RelaunchDecision::Hold);
    }

    use super::*;
    fn temp(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("deszo-host-{label}-{}", Uuid::new_v4()))
    }
    fn fixture(root: &Path, build: &str, marker: &str) -> PathBuf {
        let path = root.join(build);
        fs::create_dir_all(path.join("runtime/core")).unwrap();
        fs::write(path.join("build.json"), serde_json::json!({"schemaVersion":1,"buildId":build,"runtimeApiVersion":2,"bootstrap":"runtime","marker":marker}).to_string()).unwrap();
        fs::write(path.join("runtime/runner.mjs"), "// real entry name").unwrap();
        fs::write(
            path.join("runtime/core/engine.mjs"),
            "// real Engine artifact",
        )
        .unwrap();
        path
    }
    #[test]
    fn running_source_release_binds_host_package_and_build_source_fields() {
        let manifest: BuildManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "buildId": "release-1", "runtimeApiVersion": 2, "bootstrap": "runtime",
            "sourceCommit": "A".repeat(40), "dirtySourceDigest": "B".repeat(64), "inputsDigest": "C".repeat(64)
        })).unwrap();
        let release = source_release_value("a".repeat(32).as_str(), "release-1", &manifest, "D".repeat(64).as_str()).unwrap();
        assert_eq!(release["kind"], "ProtectedSelfRepairRunningSourceRelease");
        assert_eq!(release["installationId"], "a".repeat(32));
        assert_eq!(release["packageSha256"], "d".repeat(64));
        assert_eq!(release["sourceCommit"], "a".repeat(40));
        assert_eq!(release["sourceDigest"], "b".repeat(64));
        assert_eq!(release["inputsDigest"], "c".repeat(64));

        let incomplete: BuildManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "buildId": "release-1", "runtimeApiVersion": 2, "bootstrap": "runtime",
            "sourceCommit": "a".repeat(40), "dirtySourceDigest": null, "inputsDigest": "c".repeat(64)
        })).unwrap();
        assert!(source_release_value("a".repeat(32).as_str(), "release-1", &incomplete, "d".repeat(64).as_str()).is_err());
    }
    #[test]
    fn packaged_source_inventory_is_digest_bound_and_returns_only_requested_entries() {
        let root = temp("source-inventory");
        fs::create_dir_all(&root).unwrap();
        let files = vec![
            BuildSourceInventoryEntry { path: "runtime/core/engine.mjs".into(), sha256: Some("a".repeat(64)), absent: None },
            BuildSourceInventoryEntry { path: "runtime/optional.mjs".into(), sha256: None, absent: Some(true) },
        ];
        let canonical_files = serde_json::to_vec(&serde_json::to_value(&files).unwrap()).unwrap();
        let source_digest = hex::encode(Sha256::digest(&canonical_files));
        let source_commit = "b".repeat(40);
        let inventory_bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "kind": "DeszoBuildSourceInventory", "sourceCommit": source_commit,
            "sourceDigest": source_digest, "files": files,
        })).unwrap();
        fs::write(root.join(SOURCE_INVENTORY_PATH), &inventory_bytes).unwrap();
        let artifact_digest = hex::encode(Sha256::digest(&inventory_bytes));
        let manifest: BuildManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "buildId": "release-1", "runtimeApiVersion": 2, "bootstrap": "runtime",
            "sourceCommit": source_commit, "dirtySourceDigest": source_digest, "inputsDigest": "c".repeat(64),
            "artifacts": [{"path": SOURCE_INVENTORY_PATH, "sha256": artifact_digest, "bytes": inventory_bytes.len()}],
            "sourceInventory": {"path": SOURCE_INVENTORY_PATH, "sha256": artifact_digest}
        })).unwrap();
        let inventory = read_build_source_inventory(&root, &manifest).unwrap().unwrap();
        let selected = select_source_inventory_entries(&inventory, &[
            "runtime/core/engine.mjs".into(), "runtime/optional.mjs".into(), "runtime/missing.mjs".into(),
        ]).unwrap();
        assert_eq!(selected, vec![
            serde_json::json!({"path":"runtime/core/engine.mjs", "sha256":"a".repeat(64)}),
            serde_json::json!({"path":"runtime/optional.mjs", "absent":true}),
            serde_json::json!({"path":"runtime/missing.mjs", "missing":true}),
        ]);
        fs::write(root.join(SOURCE_INVENTORY_PATH), b"{}").unwrap();
        assert!(read_build_source_inventory(&root, &manifest).is_err(), "a changed inventory must not be served");
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn source_release_pid_is_bound_before_or_after_engine_readiness() {
        let generation = "generation-a";
        assert!(validate_source_release_engine_pid(42, 10, None, None, generation, true, Some(10)).is_ok(),
            "the authenticated Engine child may request read-only release identity before readiness");
        assert!(validate_source_release_engine_pid(42, 10, None, None, generation, true, Some(11)).is_err(),
            "a different process tree cannot use the startup source-release path");
        assert!(validate_source_release_engine_pid(10, 10, None, None, generation, false, None).is_ok(),
            "the managed in-process runtime may request source identity before readiness");
        assert!(validate_source_release_engine_pid(42, 10, None, None, generation, false, None).is_err(),
            "a child process is not the managed in-process runtime");
        assert!(validate_source_release_engine_pid(42, 10, Some(42), Some(generation), generation, true, None).is_ok(),
            "a ready Engine remains bound to the PID accepted by engine.ready");
        assert!(validate_source_release_engine_pid(43, 10, Some(42), Some(generation), generation, true, None).is_err());
        assert!(validate_source_release_engine_pid(42, 10, Some(42), Some("generation-old"), generation, true, None).is_err());
        assert!(validate_source_release_engine_pid(42, 10, Some(42), None, generation, true, None).is_err(),
            "inconsistent readiness state fails closed");
    }
    #[test]
    fn candidate_digest_covers_build_identity_and_all_files() {
        let root = temp("digest");
        let path = fixture(&root, "a", "old");
        let before = candidate_digest(&path).unwrap();
        fs::write(path.join("build.json"), "changed").unwrap();
        assert_ne!(before, candidate_digest(&path).unwrap());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn candidate_digest_refuses_symlinks() {
        let root = temp("symlink");
        let path = fixture(&root, "a", "old");
        #[cfg(unix)]
        std::os::unix::fs::symlink(path.join("build.json"), path.join("escape")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(path.join("build.json"), path.join("escape")).unwrap();
        assert!(candidate_digest(&path)
            .unwrap_err()
            .contains("symbolic link"));
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn ownership_file_lock_is_exclusive_but_released_on_drop() {
        let path = temp("lock");
        fs::create_dir_all(&path).unwrap();
        let lock = path.join("owner.lock");
        let first = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock)
            .unwrap();
        first.try_lock_exclusive().unwrap();
        let second = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock)
            .unwrap();
        assert!(second.try_lock_exclusive().is_err());
        drop(first);
        second.try_lock_exclusive().unwrap();
        let _ = fs::remove_dir_all(path);
    }
    #[test]
    fn malformed_candidate_identity_and_request_shape_fail_closed() {
        assert!(validate_id("../other").is_err());
        let mut request: LifecycleRequest = serde_json::from_value(serde_json::json!({"operationId":"00000000-0000-4000-8000-000000000001","action":"application.activate_candidate","installationId":"i","profileRoot":"/p","runId":"00000000-0000-4000-8000-000000000002","nodeInstanceId":"j","candidateId":"b","candidateDigest":"ABC","expectedGeneration":"g","judgeEvidence":{"kind":"engine_validated_designated_judge_decision","workflowId":"w","judgeNodeInstanceId":"j","attemptId":"a","checkpointId":"c"},"readiness":{"applicationResponsive":true,"engineReady":true,"sameProfile":true,"sameStore":true}})).unwrap();
        assert!(validate_request_shape(&request).is_err());
        request.candidate_digest = "a".repeat(64);
        assert!(validate_request_shape(&request).is_ok());
    }
    #[test]
    fn atomic_pointer_replacement_preserves_valid_json() {
        let root = temp("atomic");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("active.json");
        write_json_atomic(
            &file,
            &ActivePointer {
                build_id: "a".into(),
                digest: "d".into(),
                generation: "g".into(),
            },
        )
        .unwrap();
        let mut value: ActivePointer = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        value.build_id = "b".into();
        write_json_atomic(&file, &value).unwrap();
        assert_eq!(
            serde_json::from_slice::<ActivePointer>(&fs::read(&file).unwrap())
                .unwrap()
                .build_id,
            "b"
        );
        let _ = fs::remove_dir_all(root);
    }
}
