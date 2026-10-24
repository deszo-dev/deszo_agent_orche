#![cfg_attr(windows, windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const COMPILED_DESKTOP_BUILD_ID: &str = env!("DESZO_DESKTOP_BUILD_ID");

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LifecycleBootstrap {
    host_address: String,
    host_capability: Option<String>,
    installation_id: String,
    profile_root: PathBuf,
    generation: String,
    application_build_id: String,
    application_root: PathBuf,
    node_executable: PathBuf,
    #[serde(default)]
    test_duplicate_receipt_delivery: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostBootstrapLine {
    command: String,
    #[serde(flatten)]
    bootstrap: LifecycleBootstrap,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostControlLine {
    command: String,
}

impl LifecycleBootstrap {
    fn validate(&self) -> Result<(), String> {
        let (host, port) = self.host_address.split_once(':').ok_or("Lifecycle Host address is malformed")?;
        if host != "127.0.0.1" || port.parse::<u16>().ok().filter(|value| *value > 0).is_none() {
            return Err("Lifecycle Host endpoint must be loopback TCP".into());
        }
        let capability = self.host_capability.as_deref().ok_or("Lifecycle Host capability was already consumed")?;
        if capability.len() != 64 || !capability.bytes().all(|value| value.is_ascii_hexdigit()) {
            return Err("Lifecycle Host capability is malformed".into());
        }
        if self.application_build_id != COMPILED_DESKTOP_BUILD_ID {
            return Err("This desktop executable does not match the Host-selected build identity".into());
        }
        if !self.profile_root.is_absolute() || !self.profile_root.is_dir() {
            return Err("Lifecycle Host profile is not an existing absolute directory".into());
        }
        if !self.node_executable.is_absolute() || !self.node_executable.is_file() {
            return Err("Lifecycle Host Node executable is unavailable".into());
        }
        let executable = fs::canonicalize(std::env::current_exe().map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        let actual_root = node_path(executable.parent().ok_or("Desktop executable has no parent directory")?);
        let expected_root = node_path(&fs::canonicalize(&self.application_root).map_err(|error| error.to_string())?);
        if actual_root != expected_root {
            return Err("The running desktop executable is outside the Host-selected build directory".into());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod foreground_handoff;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    port: u16,
    token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_party_token: Option<String>,
    root: String,
    scratch_root: String,
    process_containment: String,
    descriptor_version: u8,
    api_versions: Vec<String>,
    store_id: String,
    runtime_instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    application_pid: Option<u32>,
    application_root: String,
    node_executable: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bridge_script: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    connection_file: Option<String>,
}

/// Windows Job Object owned only by Rust. Every descendant of the Node runtime inherits
/// membership, so closing the Job terminates CLI children even if Node itself dies.
#[cfg(windows)]
mod job {
    use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle, process::Child, ptr::null, time::{Duration, Instant}};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    pub struct Job(HANDLE);
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return Err("Could not create the process-containment Job Object.".into());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                // No breakaway flag: descendants cannot leave the Job.
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return Err("Could not configure the process-containment Job Object.".into());
                }
                Ok(Job(handle))
            }
        }

        pub fn assign(&self, child: &Child) -> Result<(), String> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                Err("Could not assign the runtime to its Job Object.".into())
            } else {
                Ok(())
            }
        }

        /// A failed query is uncertainty, never "no processes".
        fn active_processes(&self) -> Result<u32, String> {
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                let ok = QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut c_void,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                );
                if ok == 0 {
                    Err(format!("the Job Object could not be queried (error {})", std::io::Error::last_os_error()))
                } else {
                    Ok(info.ActiveProcesses)
                }
            }
        }

        #[cfg(test)]
        pub fn active_processes_for_test(&self) -> Result<u32, String> {
            self.active_processes()
        }

        /// A second handle to the same Job, so a test can observe it after the supervisor closed its own.
        #[cfg(test)]
        pub fn duplicate_for_test(job: &Job) -> Job {
            use windows_sys::Win32::{Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS}, System::Threading::GetCurrentProcess};
            unsafe {
                let mut copy: HANDLE = std::ptr::null_mut();
                let ok = DuplicateHandle(GetCurrentProcess(), job.0, GetCurrentProcess(), &mut copy, 0, 0, DUPLICATE_SAME_ACCESS);
                assert!(ok != 0, "duplicate job handle");
                Job(copy)
            }
        }

        /// Terminate every member and wait until the Job reports no active process.
        pub fn terminate_and_wait(&self, timeout: Duration) -> Result<(), String> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err(format!("the Job Object could not be terminated (error {})", std::io::Error::last_os_error()));
            }
            let started = Instant::now();
            loop {
                let active = self.active_processes()?;
                if active == 0 {
                    return Ok(());
                }
                if started.elapsed() >= timeout {
                    return Err(format!("{active} owned process(es) were still running {} s after termination", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(windows)]
mod supervisor;

struct Runner {
    child: Child,
    connection: Connection,
    #[cfg(windows)]
    job: job::Job,
    // Lives as long as this runtime: its pipe and run Jobs end with it (ADR-0002 section 4). Held, never read.
    #[cfg(windows)]
    #[allow(dead_code)]
    supervisor: Option<supervisor::Supervisor>,
}

impl Runner {
    /// Terminate the whole owned tree. An error means termination could not be confirmed.
    fn contain_exit(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        let contained = self.job.terminate_and_wait(Duration::from_secs(10));
        #[cfg(not(windows))]
        let contained: Result<(), String> = Ok(());
        let _ = self.child.kill();
        let _ = self.child.wait();
        contained
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        if let Some(stdin) = self.child.stdin.as_mut() {
            let _ = stdin.write_all(b"{\"command\":\"shutdown\"}\n");
            let _ = stdin.flush();
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Closing the Job handle afterwards also kills any member (KILL_ON_JOB_CLOSE).
        let _ = self.contain_exit();
    }
}

#[derive(Default)]
struct Shared {
    runner: Option<Runner>,
    generation: u64,
    /// Runtime starts attempted by this process, including failed ones. A consumed one-time host value must never be
    /// offered again, even when the earlier attempt never produced a generation.
    spawn_attempts: u64,
    /// Set when owned processes could not be confirmed terminated; no new runtime starts.
    uncertain: Option<String>,
    lifecycle_bootstrap: Option<LifecycleBootstrap>,
}

struct RuntimeState(Arc<Mutex<Shared>>);

/// Watches one runtime generation independently of UI calls. On unexpected exit it terminates and
/// drains the owned Job at once and tells the window, which reconnects to a new generation.
fn supervise(app: tauri::AppHandle, shared: Arc<Mutex<Shared>>, generation: u64) {
    watch_generation(shared, generation, move |message| {
        let _ = app.emit("runtime-lost", message);
    });
}

/// The window-independent supervisor core (also exercised by the native tests).
fn watch_generation(shared: Arc<Mutex<Shared>>, generation: u64, on_lost: impl Fn(String) + Send + 'static) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let mut guard = match shared.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if guard.generation != generation {
            return;
        }
        let exited = match guard.runner.as_mut() {
            None => return,
            Some(runner) => runner.child.try_wait().map(|status| status.is_some()).unwrap_or(true),
        };
        if !exited {
            continue;
        }
        let mut runner = guard.runner.take().expect("runner present");
        let message = match runner.contain_exit() {
            Ok(()) => "The runtime exited unexpectedly; its owned process tree was terminated. A new runtime starts and recovers interrupted runs.".to_string(),
            Err(error) => {
                let message = format!("The runtime exited and its owned processes could not be confirmed terminated: {error}. Close Deszo to release them before starting again.");
                guard.uncertain = Some(message.clone());
                message
            }
        };
        drop(guard);
        drop(runner);
        on_lost(message);
        return;
    })
}

/// Paths handed to Node must not carry the Windows verbatim prefix: Node's module loader cannot
/// resolve a `\\?\C:\...` script (EISDIR on `C:`). A verbatim UNC path becomes `\\server\share`;
/// other paths, including those with spaces, pass through unchanged (each is one argv element).
fn node_path(path: &std::path::Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
}

fn storage_root(app: &tauri::AppHandle, lifecycle: Option<&LifecycleBootstrap>) -> Result<PathBuf, String> {
    let root = if let Some(bootstrap) = lifecycle {
        bootstrap.profile_root.clone()
    } else if std::env::var_os("DESZO_CONTROL_HOST_PIPE").is_some() {
        let selected = std::env::var_os("DESZO_HOST_PROFILE_ROOT").ok_or("The host launch did not select a data profile")?;
        let path = PathBuf::from(selected);
        if !path.is_absolute() || !path.is_dir() { return Err("The host data profile is not an existing absolute directory".into()); }
        path
    } else if cfg!(debug_assertions) {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        if bundled_frontend_loaded(app) {
            development.join(".deszo")
        } else {
            development.join(".deszo").join("tauri-dev-fixture")
        }
    } else {
        app.path().app_local_data_dir().map_err(|e| e.to_string())?
    };
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    // Canonical form without the Windows verbatim prefix, so paths shown to the user are plain.
    let canonical = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    Ok(node_path(&canonical))
}

fn bundled_frontend_loaded(app: &tauri::AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else { return false; };
    let Ok(url) = window.url() else { return false; };
    let bundled_origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || ((url.scheme() == "http" || url.scheme() == "https") && url.host_str() == Some("tauri.localhost"));
    bundled_origin && matches!(url.path(), "/" | "/index.html") && url.query().is_none() && url.fragment().is_none()
}

fn connection_for_window(mut connection: Connection, app: &tauri::AppHandle) -> Connection {
    if !bundled_frontend_loaded(app) {
        connection.first_party_token = None;
    }
    connection
}

#[tauri::command]
fn get_runner_connection(app: tauri::AppHandle, state: tauri::State<RuntimeState>) -> Result<Connection, String> {
    let shared = state.0.clone();
    let mut guard = shared.lock().map_err(|e| e.to_string())?;
    if let Some(message) = &guard.uncertain {
        return Err(message.clone());
    }
    if let Some(runner) = guard.runner.as_mut() {
        if runner.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(connection_for_window(runner.connection.clone(), &app));
        }
        // Node exited unexpectedly: terminate its owned descendants before a new generation starts.
        if let Err(error) = runner.contain_exit() {
            let message = format!("The previous runtime's processes could not be confirmed terminated: {error}. Close Deszo to release them.");
            guard.uncertain = Some(message.clone());
            guard.runner = None;
            return Err(message);
        }
        guard.runner = None;
    }
    // Keep only profile/resource identity after the one-use Host capability is sent to Node. A
    // failed spawn cannot silently fall back to the user's default profile or replay this capability.
    let lifecycle = guard.lifecycle_bootstrap.clone();
    if let Some(bootstrap) = lifecycle.as_ref() {
        bootstrap.validate()?;
    }
    let development_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dev_script = development_root.join("runtime/runner.mjs");
    let script = node_path(&if cfg!(debug_assertions) && dev_script.is_file() {
        dev_script
    } else if let Some(bootstrap) = lifecycle.as_ref() {
        bootstrap.application_root.join("runtime/runner.mjs")
    } else {
        app.path().resource_dir().map_err(|e| e.to_string())?.join("runtime").join("runner.mjs")
    });
    if !script.is_file() {
        return Err(format!("The bundled runtime is missing at {}.", script.display()));
    }
    let dev_bridge = development_root.join("mcp/bridge.mjs");
    let bridge_script = node_path(&if cfg!(debug_assertions) && dev_bridge.is_file() {
        dev_bridge
    } else if let Some(bootstrap) = lifecycle.as_ref() {
        bootstrap.application_root.join("runtime/bridge.mjs")
    } else {
        app.path().resource_dir().map_err(|e| e.to_string())?.join("runtime").join("bridge.mjs")
    });
    if !bridge_script.is_file() {
        return Err(format!("The bundled authoring bridge is missing at {}.", bridge_script.display()));
    }
    let storage = storage_root(&app, lifecycle.as_ref())?;
    let runtime_dir = storage.join("runtime");
    fs::create_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
    let stderr = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime_dir.join("runner.log"))
        .map_err(|e| e.to_string())?;
    let node = resolve_node_executable(lifecycle.as_ref())?;
    let mut command = Command::new(&node);
    let connection_file = runtime_dir.join("connection.json");
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg(script)
        .arg("--root")
        .arg(&storage)
        .arg("--connection-file")
        .arg(&connection_file)
        .arg("--bridge-file")
        .arg(&bridge_script)
        .arg("--first-party-token-stdout")
        .current_dir(&storage)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr);
    if let Some(bootstrap) = lifecycle.as_ref() {
        command
            .arg("--host-contained")
            .env("DESZO_LIFECYCLE_HOST_ADDRESS", &bootstrap.host_address)
            .env("DESZO_LIFECYCLE_HOST_CAPABILITY", bootstrap.host_capability.as_deref().ok_or("Lifecycle Host capability was already consumed")?)
            .env("DESZO_LIFECYCLE_INSTALLATION_ID", &bootstrap.installation_id)
            .env("DESZO_LIFECYCLE_PROFILE_ROOT", &bootstrap.profile_root)
            .env("DESZO_LIFECYCLE_GENERATION", &bootstrap.generation)
            .env("DESZO_APPLICATION_BUILD_ID", &bootstrap.application_build_id)
            .env("DESZO_LIFECYCLE_APPLICATION_PID", std::process::id().to_string())
            .env(
                "DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT",
                if bootstrap.test_duplicate_receipt_delivery { "1" } else { "0" },
            );
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.arg("--supervised").creation_flags(0x08000000);
    }
    if !bundled_frontend_loaded(&app) && cfg!(debug_assertions) && std::env::var_os("DESZO_CONTROL_HOST_PIPE").is_none() {
        command.arg("--dev-test-confirmation-off");
    }
    #[cfg(windows)]
    let job = job::Job::new()?;
    // The runtime learns the supervisor pipe, its control token and the shim location; it never receives them in a manifest.
    #[cfg(windows)]
    let supervisor = supervisor::Supervisor::start()?;
    #[cfg(windows)]
    {
        // Every supervised process launches through the shim. Refuse to start rather than fail each run later.
        let shim = launch_shim(&app, lifecycle.as_ref())?;
        command.env("DESZO_SUPERVISOR_PIPE", &supervisor.pipe_name).env("DESZO_SUPERVISOR_TOKEN", &supervisor.token).env("DESZO_LAUNCH_SHIM", shim);
    }
    strip_one_time_host_env(&mut command, guard.spawn_attempts);
    guard.spawn_attempts += 1;
    if let Some(bootstrap) = guard.lifecycle_bootstrap.as_mut() {
        bootstrap.host_capability = None;
    }
    let mut child = command.spawn().map_err(|e| format!("Node.js could not be started: {e}"))?;
    // Node waits for this confirmation before it initializes and can start any CLI.
    #[cfg(windows)]
    {
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let stdin = child.stdin.as_mut().ok_or("Runtime stdin unavailable")?;
        stdin.write_all(b"{\"command\":\"contained\"}\n").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
    }
    let stdout = child.stdout.take().ok_or("Runtime stdout unavailable")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader.read_line(&mut line).map(|_| line);
        let _ = sender.send(result);
    });
    let line = match receiver.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(line)) => line,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The runtime did not start within 30 seconds. See runtime/runner.log in the data folder.".into());
        }
    };
    let mut connection: Connection = match serde_json::from_str(&line) {
        Ok(connection) => connection,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("The runtime returned an invalid connection: {e}"));
        }
    };
    connection.application_pid = lifecycle.as_ref().map(|_| std::process::id());
    guard.generation += 1;
    let generation = guard.generation;
    guard.runner = Some(Runner {
        child,
        connection: connection.clone(),
        #[cfg(windows)]
        job,
        #[cfg(windows)]
        supervisor: Some(supervisor),
    });
    drop(guard);
    supervise(app.clone(), shared, generation);
    Ok(connection_for_window(connection, &app))
}

/// The native launch shim: the development build output, or the copy bundled with the application's runtime.
#[cfg(windows)]
fn launch_shim(app: &tauri::AppHandle, lifecycle: Option<&LifecycleBootstrap>) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("debug").join("deszo-launch-shim.exe"));
    }
    candidates.push(if let Some(bootstrap) = lifecycle {
        bootstrap.application_root.join("runtime").join("deszo-launch-shim.exe")
    } else {
        app.path().resource_dir().map_err(|e| e.to_string())?.join("runtime").join("deszo-launch-shim.exe")
    });
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| {
        "The launch shim deszo-launch-shim.exe is missing, so no run could be contained. Run `npm run shim:dev` (development) or `npm run shim:build` (release), then restart Deszo.".to_string()
    })
}

/// Host bootstrap values valid for one runtime registration (runtime/host/runtimeBinding.mjs). The first runtime of this
/// process receives them; a later generation must not inherit a consumed launch proof or attach secret, because the host
/// refuses a replay. Without them the new runtime fails closed with the host's bootstrap error instead of retrying with
/// the same consumed values.
const ONE_TIME_HOST_ENV: [&str; 5] = [
    "DESZO_HOST_OPERATION_ID",
    "DESZO_HOST_REGISTRATION_NONCE",
    "DESZO_HOST_PROCESS_EVIDENCE",
    "DESZO_HOST_RUNTIME_GENERATION",
    "DESZO_HOST_ATTACH_SECRET",
];

fn strip_one_time_host_env(command: &mut Command, previous_spawn_attempts: u64) {
    if previous_spawn_attempts == 0 {
        return;
    }
    for name in ONE_TIME_HOST_ENV {
        command.env_remove(name);
    }
}

fn resolve_node_executable(lifecycle: Option<&LifecycleBootstrap>) -> Result<PathBuf, String> {
    if let Some(bootstrap) = lifecycle {
        return Ok(node_path(&bootstrap.node_executable));
    }
    if std::env::var_os("DESZO_CONTROL_HOST_PIPE").is_some() {
        let node = PathBuf::from(std::env::var_os("DESZO_HOST_NODE_PATH").ok_or("The host launch did not select Node.js")?);
        if !node.is_absolute() || !node.is_file() { return Err("The selected host Node.js executable is unavailable".into()); }
        return Ok(node_path(&node));
    }
    let output = Command::new("node").args(["-p", "process.execPath"]).output().map_err(|e| format!("Node.js could not be resolved: {e}"))?;
    if !output.status.success() { return Err("Node.js did not report its executable path.".into()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let executable = PathBuf::from(path);
    if !executable.is_file() { return Err(format!("Node.js executable is unavailable at {}.", executable.display())); }
    Ok(node_path(&executable))
}

fn main() {
    let managed_by_host = std::env::args().any(|argument| argument == "--host-managed");
    let lifecycle_bootstrap = if managed_by_host {
        let stdin = std::io::stdin();
        let mut line = String::new();
        stdin.lock().read_line(&mut line).expect("Could not read the private Host bootstrap pipe");
        let message: HostBootstrapLine = serde_json::from_str(&line).expect("Host bootstrap was malformed");
        assert_eq!(message.command, "bootstrap", "The first Host pipe message must be bootstrap");
        message.bootstrap.validate().expect("Host bootstrap validation failed");
        Some(message.bootstrap)
    } else {
        None
    };
    let shared = Arc::new(Mutex::new(Shared {
        lifecycle_bootstrap,
        ..Shared::default()
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RuntimeState(shared))
        .setup(|app| {
            if app.state::<RuntimeState>().0.lock().map_err(|error| error.to_string())?.lifecycle_bootstrap.is_some() {
                let handle = app.handle().clone();
                std::thread::Builder::new()
                    .name("deszo-host-shutdown-pipe".into())
                    .spawn(move || {
                        let stdin = std::io::stdin();
                        for line in stdin.lock().lines().map_while(Result::ok) {
                            if serde_json::from_str::<HostControlLine>(&line).is_ok_and(|message| message.command == "shutdown") {
                                handle.exit(0);
                                break;
                            }
                        }
                    })
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_runner_connection])
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                foreground_handoff::before_close();
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut guard) = window.state::<RuntimeState>().0.lock() {
                    guard.generation += 1;
                    guard.runner = None;
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Could not start Deszo");
}

#[cfg(all(test, windows))]
mod tests {
    use super::job::Job;
    use std::{process::Command, sync::Mutex, time::Duration};

    /// Job tests depend on process timing; run them one at a time.
    static JOB_TESTS: Mutex<()> = Mutex::new(());

    /// The R4 hazard and its remedy: after the direct child (standing in for Node) dies, its
    /// descendant still runs inside the Job until the supervisor terminates and drains the Job.
    #[test]
    fn descendants_survive_the_direct_child_until_the_job_is_drained() {
        let _serial = JOB_TESTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let job = Job::new().expect("job");
        let mut child = Command::new("cmd")
            // One long-lived descendant: a short leading ping could be the only member the loop sees before the kill.
            .args(["/c", "ping -n 60 127.0.0.1 >nul"])
            .spawn()
            .expect("spawn");
        job.assign(&child).expect("assign");
        // Wait until the long-running descendant exists (cmd plus ping), however busy the machine is.
        let started = std::time::Instant::now();
        while job.active_processes_for_test().expect("query") < 2 {
            assert!(started.elapsed() < Duration::from_secs(30), "the descendant never started");
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_millis(1500));
        child.kill().expect("kill direct child");
        let _ = child.wait();
        std::thread::sleep(Duration::from_millis(200));
        assert!(job.active_processes_for_test().expect("query") >= 1, "the descendant outlives its parent");
        job.terminate_and_wait(Duration::from_secs(10)).expect("drained");
        assert_eq!(job.active_processes_for_test().expect("query"), 0);
    }

    /// Packaged-crash stand-in: a contained "runtime" starts a long-running descendant and then dies.
    /// The supervisor notices without any UI call, drains the Job and reports the loss.
    #[test]
    fn supervisor_drains_the_job_when_the_runtime_dies() {
        let _serial = JOB_TESTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        use super::{watch_generation, Connection, Runner, Shared};
        use std::sync::{mpsc, Arc, Mutex};
        let job = Job::new().expect("job");
        let child = Command::new("cmd")
            .args(["/c", "start /b ping -n 60 127.0.0.1 >nul & ping -n 3 127.0.0.1 >nul"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("spawn");
        job.assign(&child).expect("assign");
        let started = std::time::Instant::now();
        while job.active_processes_for_test().expect("query") < 2 {
            assert!(started.elapsed() < Duration::from_secs(30), "the descendant never started");
            std::thread::sleep(Duration::from_millis(100));
        }
        let probe = Job::duplicate_for_test(&job);
        let connection = Connection { port: 1, token: String::new(), first_party_token: None, root: String::new(), scratch_root: String::new(), process_containment: "tauri-job".into(),
            descriptor_version: 1, api_versions: vec!["v2".into(), "v3".into()], store_id: String::new(), runtime_instance_id: String::new(), application_pid: None,
            application_root: String::new(), node_executable: String::new(), bridge_script: None, connection_file: None };
        let shared = Arc::new(Mutex::new(Shared { runner: Some(Runner { child, connection, job, supervisor: None }), generation: 7, spawn_attempts: 1, uncertain: None,
            lifecycle_bootstrap: None }));
        let (sender, receiver) = mpsc::channel();
        watch_generation(shared.clone(), 7, move |message| { let _ = sender.send(message); });
        let message = receiver.recv_timeout(Duration::from_secs(30)).expect("the supervisor reported the loss");
        assert!(message.contains("terminated"), "{message}");
        assert!(shared.lock().unwrap().runner.is_none());
        assert!(shared.lock().unwrap().uncertain.is_none());
        assert_eq!(probe.active_processes_for_test().expect("query"), 0, "no descendant survives the runtime");
    }

    #[test]
    fn node_paths_drop_the_verbatim_prefix() {
        use super::node_path;
        use std::path::Path;
        assert_eq!(node_path(Path::new(r"\\?\C:\Program Files\Deszo\runtime\runner.mjs")), Path::new(r"C:\Program Files\Deszo\runtime\runner.mjs"));
        assert_eq!(node_path(Path::new(r"\\?\UNC\server\share\Deszo\runner.mjs")), Path::new(r"\\server\share\Deszo\runner.mjs"));
        assert_eq!(node_path(Path::new(r"C:\plain\runner.mjs")), Path::new(r"C:\plain\runner.mjs"));
    }

    /// PILOT-02: the installed app's resource directory is canonical (`\\?\` prefixed). Launch the
    /// runner exactly as the shell does from such a path and wait for its authenticated connection.
    #[test]
    fn runner_starts_from_a_canonical_resource_path() {
        use std::io::{BufRead, BufReader};
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let bundled = manifest.join("../dist-runtime/runner.mjs");
        let script = if bundled.is_file() { bundled } else { manifest.join("../runtime/runner.mjs") };
        let canonical = std::fs::canonicalize(&script).expect("canonical script");
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"), "Windows canonical paths are verbatim");
        let root = std::env::temp_dir().join(format!("deszo startup check {}", std::process::id()));
        let mut child = Command::new("node")
            .arg("--disable-warning=ExperimentalWarning")
            .arg(super::node_path(&canonical))
            .arg("--root")
            .arg(&root)
            .arg("--connection-file")
            .arg(root.join("runtime").join("connection.json"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("node");
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).expect("connection line");
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&root);
        let connection: serde_json::Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("runner did not start: {line:?}"));
        assert!(connection["port"].as_u64().unwrap_or(0) > 0 && connection["token"].as_str().map_or(false, |token| token.len() >= 32));
    }
}

#[cfg(test)]
mod one_time_host_env_tests {
    use super::{strip_one_time_host_env, ONE_TIME_HOST_ENV};
    use std::process::Command;

    fn inherited(command: &Command, name: &str) -> bool {
        command.get_envs().any(|(key, value)| key.to_str() == Some(name) && value.is_some())
    }

    #[test]
    fn first_runtime_keeps_its_bootstrap_and_later_generations_do_not_inherit_it() {
        let mut first = Command::new("node");
        for name in ONE_TIME_HOST_ENV {
            first.env(name, "one-time");
        }
        strip_one_time_host_env(&mut first, 0);
        for name in ONE_TIME_HOST_ENV {
            assert!(inherited(&first, name), "{name} belongs to the first runtime");
        }

        let mut later = Command::new("node");
        for name in ONE_TIME_HOST_ENV {
            later.env(name, "consumed");
        }
        later.env("DESZO_HOST_POLICY_ID", "policy");
        strip_one_time_host_env(&mut later, 1);
        for name in ONE_TIME_HOST_ENV {
            assert!(!inherited(&later, name), "{name} must not be inherited by a later generation");
        }
        assert!(inherited(&later, "DESZO_HOST_POLICY_ID"), "the policy binding is not a one-time value");
    }
}
