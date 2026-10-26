//! Process Custody (Host Process Custody PoC, Windows).
//!
//! The Lifecycle Host launches one Engine-admitted provider invocation into its own kill-on-close Job, outside the Job of
//! the managed application. Replacing or losing the Engine therefore does not end the CLI. The Host decides nothing about
//! workflows: it checks the launch against an executable allowlist and a single-use permit, contains the process, spools
//! its output durably and records the OS outcome. The Engine pulls output from a durable offset and acknowledges only the
//! bytes it has committed. When the Host itself dies, its Job closes and the CLI tree ends; the next Host never adopts it.

use crate::{constant_time_equal, node_path, now, write_json_atomic, Containment, IPC_MAX_LINE};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Largest stdin payload a Custody launch carries. The lifecycle IPC line is 128 KiB and carries stdin as hex (two bytes per byte),
/// so a larger prompt is refused, not truncated. A longer prompt needs a file handoff, which this PoC does not implement.
pub const STDIN_LIMIT: usize = 48 * 1024;
// The read reply is hex-encoded inside the same bounded IPC line, so one read carries at most 32 KiB of output.
const READ_LIMIT: usize = 32 * 1024;
const READ_CHUNK: usize = 64 * 1024;
const DEFAULT_PERMIT_TTL: Duration = Duration::from_secs(60);
const DEFAULT_SPOOL_LIMIT: u64 = 512 * 1024 * 1024;
const DRAIN: Duration = Duration::from_secs(5);
const TICK: Duration = Duration::from_millis(100);
// Credential and internal-authority variables are removed again at the Host boundary. Windows environment names are
// case-insensitive, so both the exact names and prefixes are compared in uppercase even if an Engine sends a lowercase key.
const DENIED_ENV_NAMES: [&str; 16] = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_VERSION", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY",
    "GOOGLE_API_KEY", "DESZO_PROCESS_CUSTODY", "DESZO_OWNER_TOKEN", "OWNER_TOKEN", "FIRST_PARTY_TOKEN", "HOST_TOKEN",
    "DESZO_TEST_DUPLICATE_LIFECYCLE", "DESZO_JUDGE_TOKEN", "DESZO_HOST_TOKEN", "DESZO_LAUNCH_SHIM"];
const DENIED_ENV_PREFIXES: [&str; 19] = ["DESZO_LIFECYCLE_", "DESZO_SUPERVISOR_", "DESZO_LAUNCH_SHIM", "DESZO_CUSTODY_", "DESZO_TEST_DUPLICATE_LIFECYCLE",
    "DESZO_JUDGE_", "DESZO_HOST_", "DESZO_OWNER_", "CODEX_APP_", "CODEX_INTERNAL_", "CODEX_PERMISSION_", "CODEX_SESSION_", "CODEX_TASK_",
    "CODEX_THREAD_", "CODEX_TOOL_", "CODEX_MCP_", "CODEX_SAGE_", "CODEX_APPLY_PATCH_", "CODEX_WINDOWS_SANDBOX_"];
const TERMINAL_STATES: [&str; 12] = ["exited", "stopped", "deadline_terminated", "spool_limit_exceeded", "spool_failed", "emergency_stopped",
    "launch_failed", "permit_expired", "refused_host_restart", "host_lost", "host_stopped", "admission_cancelled"];
const STOP_STATES: [&str; 6] = ["stopped", "deadline_terminated", "spool_limit_exceeded", "spool_failed", "emergency_stopped", "host_stopped"];

/// A refusal carries a stable machine code (returned in the IPC response) and a human message.
#[derive(Debug)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

fn refuse<T>(code: &'static str, message: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal { code, message: message.into() })
}

fn storage(message: String) -> Refusal {
    Refusal { code: "storage_unavailable", message }
}

fn text<'a>(payload: &'a Value, key: &str) -> Result<&'a str, Refusal> {
    payload.get(key).and_then(Value::as_str).ok_or_else(|| Refusal { code: "invalid_request", message: format!("{key} is required") })
}

fn number(payload: &Value, key: &str) -> Result<u64, Refusal> {
    payload.get(key).and_then(Value::as_u64).ok_or_else(|| Refusal { code: "invalid_request", message: format!("{key} must be a nonnegative integer") })
}

/// One executable the Host may launch, identified by its canonical path and SHA-256 digest.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedExecutable {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustodyConfig {
    #[serde(default)]
    pub allowed_executables: Vec<AllowedExecutable>,
    #[serde(default)]
    pub spool_limit_bytes: Option<u64>,
    #[serde(default)]
    pub permit_ttl_ms: Option<u64>,
    /// Test-only, debug builds: abort the Host after a CLI is created and before its `running` state is recorded.
    #[serde(default)]
    pub test_crash_after_spawn: bool,
    /// Test-only, debug builds: abort the Host after a spool write has reached this many bytes and before it is synced.
    #[serde(default)]
    pub test_crash_after_spool_bytes: Option<u64>,
    /// Test-only, debug builds: after a CLI is created, assigned and resumed, wait this long and then fail the write of its
    /// `running` record, exactly where a full or failing disk would.
    #[serde(default)]
    pub test_fail_running_record_after_ms: Option<u64>,
    /// Test-only, debug builds: drain an ended invocation's Job for only this long and skip its termination, so that a descendant that
    /// outlives its leader leaves the Job not empty when the end is recorded. While `test-fail-drain-proof` exists in the custody
    /// directory, the later drain proof cannot be written.
    #[serde(default)]
    pub test_undrained_drain_ms: Option<u64>,
}

// The durable record of one admitted invocation. Permits and emergency credentials are stored only as digests.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    custody_id: String,
    attempt_id: String,
    run_id: String,
    provider: String,
    executable: String,
    executable_sha256: String,
    cwd: String,
    invocation_digest: String,
    deadline_ms: u64,
    epoch: u64,
    state: String,
    process_id: Option<u32>,
    process_creation_time: Option<u64>,
    exit_code: Option<i32>,
    // Whether the Job was verified empty when the Host recorded this record's terminal state. Absent in older records.
    #[serde(default)]
    drained: Option<bool>,
    termination_reason: Option<String>,
    stdout_durable: u64,
    stderr_durable: u64,
    stdout_acked: u64,
    stderr_acked: u64,
    spool_complete: bool,
    tail_gap_possible: bool,
    permit_sha256: String,
    emergency_sha256: String,
    created_at: String,
    updated_at: String,
}

impl Record {
    fn is_terminal(&self) -> bool {
        TERMINAL_STATES.contains(&self.state.as_str())
    }

    fn view(&self) -> Value {
        json!({ "custodyId": self.custody_id, "attemptId": self.attempt_id, "runId": self.run_id, "provider": self.provider,
            "state": self.state, "terminal": self.is_terminal(), "processId": self.process_id, "processCreationTime": self.process_creation_time,
            "exitCode": self.exit_code, "terminationReason": self.termination_reason, "stdoutDurable": self.stdout_durable,
            "stderrDurable": self.stderr_durable, "stdoutAcked": self.stdout_acked, "stderrAcked": self.stderr_acked,
            "spoolComplete": self.spool_complete, "tailGapPossible": self.tail_gap_possible, "executable": self.executable,
            "executableSha256": self.executable_sha256, "invocationDigest": self.invocation_digest })
    }
}

// Arguments and environment for an admitted invocation. They are held in memory only and never written to disk.
struct Pending {
    args: Vec<String>,
    env: Vec<(String, String)>,
    stdin: Vec<u8>,
}

// A running invocation: its Job, its process handle and the durable byte counters the readers advance.
struct Live {
    job: Arc<Containment>,
    process: native::Handle,
    stdout_durable: Arc<AtomicU64>,
    stderr_durable: Arc<AtomicU64>,
    stop: Arc<Mutex<Option<String>>>,
    deadline: Instant,
}

#[derive(Default)]
struct Inner {
    epoch: u64,
    records: BTreeMap<String, Record>,
    by_attempt: HashMap<String, String>,
    pending: HashMap<String, Pending>,
    permit_expires: HashMap<String, Instant>,
    live: HashMap<String, Arc<Live>>,
    // The Jobs of ended invocations that were not verified empty when their end was recorded. Kept, so that a later status can verify
    // the Job empty and record the proof the workspace hold needs; dropped once it is.
    undrained: HashMap<String, Arc<Containment>>,
}

// The state that the supervisor thread of one invocation needs.
#[derive(Clone)]
struct Context {
    root: PathBuf,
    inner: Arc<Mutex<Inner>>,
    undrained_drain: Option<Duration>,
}

pub struct CustodyRegistry {
    root: PathBuf,
    // The lifecycle generation this Host currently serves. A candidate activation advances it, and an Engine from the
    // previous generation is refused from that point on.
    generation: Mutex<String>,
    host_pid: u32,
    allowlist: Vec<AllowedExecutable>,
    spool_limit: u64,
    permit_ttl: Duration,
    crash_after_spawn: bool,
    crash_after_spool_bytes: Option<u64>,
    fail_running_record_after: Option<Duration>,
    undrained_drain: Option<Duration>,
    inner: Arc<Mutex<Inner>>,
}

impl CustodyRegistry {
    /// Opens the durable custody state under the Host directory and reconciles every record with this Host's lifetime.
    /// An admitted invocation was never launched; a launching or running one ended with the previous Host's Job.
    pub fn open(host_dir: &Path, generation: &str, config: &CustodyConfig) -> Result<Self, String> {
        let root = host_dir.join("custody");
        fs::create_dir_all(root.join("attempts")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("spool")).map_err(|e| e.to_string())?;
        let epoch = match fs::read(root.join("epoch.json")) {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok().and_then(|value| value["epoch"].as_u64())
                .ok_or("custody epoch record is unreadable")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.to_string()),
        };
        let mut records = BTreeMap::new();
        let mut by_attempt = HashMap::new();
        for entry in fs::read_dir(root.join("attempts")).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            let mut record: Record = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("custody record {} is unreadable: {e}", path.display()))?;
            reconcile(&mut record, &root);
            write_json_atomic(&path, &record)?;
            by_attempt.insert(record.attempt_id.clone(), record.custody_id.clone());
            records.insert(record.custody_id.clone(), record);
        }
        Ok(Self {
            root,
            generation: Mutex::new(generation.to_string()),
            host_pid: std::process::id(),
            allowlist: config.allowed_executables.clone(),
            spool_limit: config.spool_limit_bytes.unwrap_or(DEFAULT_SPOOL_LIMIT),
            permit_ttl: config.permit_ttl_ms.map(Duration::from_millis).unwrap_or(DEFAULT_PERMIT_TTL),
            crash_after_spawn: config.test_crash_after_spawn && cfg!(debug_assertions),
            crash_after_spool_bytes: config.test_crash_after_spool_bytes,
            fail_running_record_after: config.test_fail_running_record_after_ms.filter(|_| cfg!(debug_assertions)).map(Duration::from_millis),
            undrained_drain: config.test_undrained_drain_ms.filter(|_| cfg!(debug_assertions)).map(Duration::from_millis),
            inner: Arc::new(Mutex::new(Inner { epoch, records, by_attempt, ..Inner::default() })),
        })
    }

    /// Routes one authenticated `custody.*` command. The caller has already checked the lifecycle capability.
    pub fn dispatch(&self, command: &str, payload: &Value) -> Result<Value, Refusal> {
        match command {
            "custody.attach" => self.attach(payload),
            "custody.reserve" => self.reserve(payload),
            "custody.launch" => self.launch(payload),
            "custody.status" => self.status(payload),
            "custody.read" => self.read(payload),
            "custody.ack" => self.ack(payload),
            "custody.stop" => self.stop(payload, false),
            "custody.emergency_stop" => self.stop(payload, true),
            "custody.cancel" => self.cancel(payload),
            _ => refuse("unsupported", "The Host does not implement that custody command."),
        }
    }

    /// Graceful Host shutdown: every running invocation is stopped and recorded before the Host exits.
    pub fn shutdown(&self) {
        let lives: Vec<Arc<Live>> = match self.inner.lock() {
            Ok(inner) => inner.live.values().cloned().collect(),
            Err(_) => return,
        };
        for live in &lives {
            record_stop(&live.stop, "host_stopped");
            let _ = live.job.terminate();
        }
        let deadline = Instant::now() + DRAIN;
        while Instant::now() < deadline {
            if self.inner.lock().map(|inner| inner.live.is_empty()).unwrap_or(true) {
                break;
            }
            thread::sleep(TICK);
        }
    }

    fn guard(&self) -> Result<MutexGuard<'_, Inner>, Refusal> {
        self.inner.lock().map_err(|_| Refusal { code: "unavailable", message: "The custody state is unavailable.".into() })
    }

    /// Called by the Host under its own state lock when a candidate activation advances the lifecycle generation.
    pub fn set_generation(&self, generation: &str) {
        if let Ok(mut current) = self.generation.lock() {
            *current = generation.to_string();
        }
    }

    fn current_generation(&self) -> String {
        self.generation.lock().map(|current| current.clone()).unwrap_or_default()
    }

    fn check_generation(&self, payload: &Value) -> Result<(), Refusal> {
        if text(payload, "generation")? != self.current_generation() {
            return refuse("stale_generation", "The Engine's lifecycle generation does not match this Host.");
        }
        Ok(())
    }

    // Engine generation fencing: only the most recent attach may issue control commands.
    fn check_epoch(inner: &Inner, payload: &Value) -> Result<(), Refusal> {
        if number(payload, "epoch")? != inner.epoch {
            return refuse("stale_engine", "This Engine generation no longer controls custody; reattach before issuing commands.");
        }
        Ok(())
    }

    fn attach(&self, payload: &Value) -> Result<Value, Refusal> {
        self.check_generation(payload)?;
        let mut inner = self.guard()?;
        inner.epoch += 1;
        write_json_atomic(&self.root.join("epoch.json"), &json!({ "epoch": inner.epoch })).map_err(storage)?;
        Ok(json!({ "epoch": inner.epoch, "hostPid": self.host_pid, "generation": self.current_generation() }))
    }

    fn reserve(&self, payload: &Value) -> Result<Value, Refusal> {
        self.check_generation(payload)?;
        let attempt_id = text(payload, "attemptId")?;
        if attempt_id.is_empty() || attempt_id.len() > 128 || !attempt_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return refuse("invalid_request", "attemptId is malformed");
        }
        let run_id = text(payload, "runId")?;
        let provider = text(payload, "provider")?;
        let command = text(payload, "command")?;
        let cwd_text = text(payload, "cwd")?;
        let deadline_ms = number(payload, "deadlineMs")?;
        let args = string_array(payload, "args")?;
        let env = environment_pairs(payload)?;
        let stdin = match payload.get("stdinHex") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::String(hex_text)) => hex::decode(hex_text).map_err(|_| Refusal { code: "invalid_request", message: "stdinHex is not hexadecimal".into() })?,
            Some(_) => return refuse("invalid_request", "stdinHex must be a string"),
        };
        if stdin.len() > STDIN_LIMIT {
            return refuse("stdin_too_large", "The invocation's stdin exceeds the Custody launch limit; it was not launched.");
        }
        let (executable, executable_sha256) = self.admit_executable(command)?;
        let cwd = node_path(&fs::canonicalize(cwd_text).map_err(|_| Refusal { code: "cwd_unavailable", message: "The working directory does not exist.".into() })?);
        if !cwd.is_dir() {
            return refuse("cwd_unavailable", "The working directory is not a directory.");
        }
        let cwd_text = cwd.to_string_lossy().into_owned();
        let executable_text = executable.to_string_lossy().into_owned();
        let mut env_names: Vec<&str> = env.iter().map(|(name, _)| name.as_str()).collect();
        env_names.sort_unstable();
        let digest = sha256_hex(&serde_json::to_vec(&json!({ "provider": provider, "executable": executable_text, "args": args, "cwd": cwd_text,
            "stdinSha256": sha256_hex(&stdin), "envNames": env_names })).map_err(|e| storage(e.to_string()))?);
        // Hashing a native CLI can take seconds in an unoptimized Host build. Keep the registry lock free while checking
        // the allowlist so status, Stop, and Engine-epoch commands for already running invocations remain responsive.
        let mut inner = self.guard()?;
        Self::check_epoch(&inner, payload)?;
        if let Some(existing_id) = inner.by_attempt.get(attempt_id).cloned() {
            let existing = inner.records.get(&existing_id).ok_or_else(|| storage("custody index is inconsistent".into()))?;
            if existing.invocation_digest != digest {
                return refuse("conflicting_invocation", "This attempt was already admitted with a different invocation; nothing was launched.");
            }
            return Ok(json!({ "custodyId": existing_id, "state": existing.state, "reused": true, "permit": null, "emergencyToken": null }));
        }
        let custody_id = Uuid::new_v4().to_string();
        let permit = random_hex(32);
        let emergency = random_hex(32);
        let stamp = now();
        let record = Record { custody_id: custody_id.clone(), attempt_id: attempt_id.into(), run_id: run_id.into(), provider: provider.into(),
            executable: executable_text, executable_sha256: executable_sha256.clone(), cwd: cwd_text, invocation_digest: digest.clone(), deadline_ms,
            epoch: inner.epoch, state: "admitted".into(), process_id: None, process_creation_time: None, exit_code: None, drained: None, termination_reason: None,
            stdout_durable: 0, stderr_durable: 0, stdout_acked: 0, stderr_acked: 0, spool_complete: false, tail_gap_possible: false,
            permit_sha256: sha256_hex(permit.as_bytes()), emergency_sha256: sha256_hex(emergency.as_bytes()), created_at: stamp.clone(), updated_at: stamp };
        write_json_atomic(&self.record_path(&custody_id), &record).map_err(storage)?;
        fs::create_dir_all(self.spool_dir(&custody_id)).map_err(|e| storage(e.to_string()))?;
        inner.permit_expires.insert(custody_id.clone(), Instant::now() + self.permit_ttl);
        inner.pending.insert(custody_id.clone(), Pending { args, env, stdin });
        inner.by_attempt.insert(attempt_id.into(), custody_id.clone());
        inner.records.insert(custody_id.clone(), record);
        // The canonical directory admitted here: the Engine holds the workspace by this root, not by the path it asked for.
        Ok(json!({ "custodyId": custody_id, "state": "admitted", "reused": false, "permit": permit, "emergencyToken": emergency,
            "deadlineMs": deadline_ms, "executableSha256": executable_sha256, "invocationDigest": digest, "cwd": inner.records[&custody_id].cwd.clone() }))
    }

    fn launch(&self, payload: &Value) -> Result<Value, Refusal> {
        self.check_generation(payload)?;
        let mut inner = self.guard()?;
        Self::check_epoch(&inner, payload)?;
        let custody_id = text(payload, "custodyId")?.to_string();
        let permit = text(payload, "permit")?;
        let record = inner.records.get(&custody_id).cloned().ok_or(Refusal { code: "not_found", message: "No custody record has that identity.".into() })?;
        if !digest_equal(&sha256_hex(permit.as_bytes()), &record.permit_sha256) {
            return refuse("permit_refused", "The launch permit does not belong to this admitted invocation.");
        }
        // Idempotent: a repeated launch of an invocation already past admission returns its state and starts nothing.
        if record.state != "admitted" {
            return Ok(status_of(&inner, &custody_id));
        }
        // The permit is single-use. It gates the launch only; once the CLI runs, the admitted deadline governs its lifetime.
        let expires = inner.permit_expires.remove(&custody_id);
        let pending = inner.pending.remove(&custody_id);
        let expired = expires.map(|at| Instant::now() > at).unwrap_or(true);
        let Some(pending) = pending.filter(|_| !expired) else {
            finish_record(&mut inner, &self.root, &custody_id, "permit_expired", Some("The launch permit expired before launch; nothing was started."), None, false)?;
            return refuse("permit_expired", "The launch permit expired before the invocation was launched.");
        };
        // The workspace must still be the directory admitted for this invocation. A junction or a replaced directory between
        // admission and launch is refused here, before anything is spawned.
        let current_cwd = fs::canonicalize(&record.cwd).map(|path| node_path(&path).to_string_lossy().into_owned());
        if current_cwd.map(|value| value != record.cwd).unwrap_or(true) {
            finish_record(&mut inner, &self.root, &custody_id, "launch_failed", Some("The workspace changed after admission; nothing was launched."), None, false)?;
            return refuse("workspace_changed", "The workspace is no longer the directory admitted for this invocation; nothing was launched.");
        }
        // The executable is verified again at launch: the admission's digest must still match what is about to run.
        let launched_digest = file_sha256(Path::new(&record.executable));
        if launched_digest.map(|digest| !digest_equal(&digest, &record.executable_sha256)).unwrap_or(true) {
            finish_record(&mut inner, &self.root, &custody_id, "launch_failed", Some("The executable changed after admission; nothing was launched."), None, false)?;
            return refuse("executable_changed", "The executable is no longer the one admitted; nothing was launched.");
        }
        set_state(&mut inner, &self.root, &custody_id, "spawning")?;
        let job = match Containment::create() {
            Ok(job) => job,
            Err(message) => {
                finish_record(&mut inner, &self.root, &custody_id, "launch_failed", Some(&message), None, false)?;
                return refuse("launch_failed", message);
            }
        };
        let spawned = match native::spawn(&job, &record.executable, &pending.args, &record.cwd, &pending.env, pending.stdin) {
            Ok(spawned) => spawned,
            Err(message) => {
                finish_record(&mut inner, &self.root, &custody_id, "launch_failed", Some(&message), None, false)?;
                return refuse("launch_failed", message);
            }
        };
        if self.crash_after_spawn {
            std::process::abort();
        }
        let live = Arc::new(Live {
            job: Arc::new(job),
            process: spawned.process,
            stdout_durable: Arc::new(AtomicU64::new(0)),
            stderr_durable: Arc::new(AtomicU64::new(0)),
            stop: Arc::new(Mutex::new(None)),
            deadline: Instant::now() + Duration::from_millis(record.deadline_ms),
        });
        // Every thread that supervises this CLI starts before the record says it runs and before the registry serves it. If one
        // cannot start, the CLI is terminated and recorded: an unsupervised CLI with no deadline and no record is never left running.
        let context = Context { root: self.root.clone(), inner: Arc::clone(&self.inner), undrained_drain: self.undrained_drain };
        let (stdout_sender, stdout_receiver) = mpsc::channel();
        let (stderr_sender, stderr_receiver) = mpsc::channel();
        let started = spawn_reader(spawned.stdout, self.spool_path(&custody_id, "stdout"), ReaderTarget {
            job: Arc::clone(&live.job), stop: Arc::clone(&live.stop), durable: Arc::clone(&live.stdout_durable), limit: self.spool_limit,
            crash_after: self.crash_after_spool_bytes }, stdout_sender)
            .and_then(|_| spawn_reader(spawned.stderr, self.spool_path(&custody_id, "stderr"), ReaderTarget {
                job: Arc::clone(&live.job), stop: Arc::clone(&live.stop), durable: Arc::clone(&live.stderr_durable), limit: self.spool_limit,
                crash_after: self.crash_after_spool_bytes }, stderr_sender))
            .and_then(|_| {
                let supervised = Arc::clone(&live);
                let id = custody_id.clone();
                thread::Builder::new().name("deszo-custody-supervisor".into()).spawn(move || {
                    supervise(context, id, supervised, vec![stdout_receiver, stderr_receiver]);
                }).map(|_| ()).map_err(|e| e.to_string())
            });
        if let Err(message) = started {
            // The CLI never ran under supervision: the Job is terminated, and whether it is then empty is the record's evidence.
            let _ = live.job.terminate();
            let drained = wait_empty(&live.job, DRAIN);
            if let Some(entry) = inner.records.get_mut(&custody_id) {
                entry.process_id = Some(spawned.pid);
                entry.process_creation_time = Some(spawned.creation_time);
                entry.drained = Some(drained);
            }
            // The drain verdict counts only once the record that carries it is durable. If that write fails, the verdict is withdrawn and the Job
            // is kept, so that a later status proves the drain durably (recheck_drain), as supervise does.
            if let Err(error) = finish_record(&mut inner, &self.root, &custody_id, "launch_failed", Some(&message), None, false) {
                if let Some(entry) = inner.records.get_mut(&custody_id) {
                    entry.drained = Some(false);
                }
                inner.undrained.insert(custody_id.clone(), Arc::clone(&live.job));
                return Err(error);
            }
            if !drained {
                inner.undrained.insert(custody_id.clone(), Arc::clone(&live.job));
            }
            return refuse("launch_failed", message);
        }
        // Inserted under the same lock the supervisor needs to finish, so it cannot remove the entry before it exists. It is inserted
        // before the running record is written, so that a Stop always reaches the Job, even when that write fails.
        inner.live.insert(custody_id.clone(), Arc::clone(&live));
        {
            let entry = inner.records.get_mut(&custody_id).ok_or_else(|| storage("custody index is inconsistent".into()))?;
            entry.state = "running".into();
            entry.process_id = Some(spawned.pid);
            entry.process_creation_time = Some(spawned.creation_time);
            entry.updated_at = now();
            let snapshot = entry.clone();
            let written = match self.fail_running_record_after {
                Some(after) => {
                    thread::sleep(after);
                    Err("injected failure writing the running record".to_string())
                }
                None => write_json_atomic(&self.record_path(&custody_id), &snapshot),
            };
            if let Err(error) = written {
                // The running state was never made durable, so the record keeps its spawning state: a repeated launch reports that the CLI is
                // not running, never that it is. The CLI must not run on without a durable record of it: its Job is terminated, and the supervisor
                // records its end.
                entry.state = "spawning".into();
                record_stop(&live.stop, "spool_failed");
                let _ = live.job.terminate();
                return Err(storage(error));
            }
        }
        Ok(status_of(&inner, &custody_id))
    }

    // The Engine withdraws an admission it can no longer launch (for example after a linked-repair guard refused it between
    // admission and launch). Only an admitted, never-launched invocation can be withdrawn; its permit becomes unusable.
    fn cancel(&self, payload: &Value) -> Result<Value, Refusal> {
        self.check_generation(payload)?;
        let mut inner = self.guard()?;
        Self::check_epoch(&inner, payload)?;
        let custody_id = text(payload, "custodyId")?.to_string();
        let record = inner.records.get(&custody_id).cloned().ok_or(Refusal { code: "not_found", message: "No custody record has that identity.".into() })?;
        if record.state == "admitted" {
            finish_record(&mut inner, &self.root, &custody_id, "admission_cancelled", Some("The Engine withdrew this admission before launch; nothing was started."), None, false)?;
            inner.permit_expires.remove(&custody_id);
        }
        Ok(status_of(&inner, &custody_id))
    }

    fn status(&self, payload: &Value) -> Result<Value, Refusal> {
        self.check_generation(payload)?;
        let mut inner = self.guard()?;
        Self::check_epoch(&inner, payload)?;
        let custody_id = text(payload, "custodyId")?;
        if !inner.records.contains_key(custody_id) {
            return refuse("not_found", "No custody record has that identity.");
        }
        let proof_write_fails = self.undrained_drain.is_some() && self.root.join("test-fail-drain-proof").exists();
        recheck_drain(&mut inner, &self.root, custody_id, proof_write_fails);
        Ok(status_of(&inner, custody_id))
    }

    fn read(&self, payload: &Value) -> Result<Value, Refusal> {
        self.check_generation(payload)?;
        let inner = self.guard()?;
        Self::check_epoch(&inner, payload)?;
        let custody_id = text(payload, "custodyId")?.to_string();
        let stream = text(payload, "stream")?.to_string();
        let offset = number(payload, "offset")?;
        let limit = payload.get("max").and_then(Value::as_u64).unwrap_or(READ_CHUNK as u64).min(READ_LIMIT as u64);
        let record = inner.records.get(&custody_id).ok_or(Refusal { code: "not_found", message: "No custody record has that identity.".into() })?;
        let terminal = record.is_terminal();
        let durable = durable_bytes(&inner, record, &stream)?;
        drop(inner);
        if offset > durable {
            return refuse("offset_beyond_durable", "The requested offset is beyond the durable spool.");
        }
        let end = durable.min(offset.saturating_add(limit));
        let mut bytes = vec![0u8; (end - offset) as usize];
        if !bytes.is_empty() {
            let mut file = File::open(self.spool_path(&custody_id, &stream)).map_err(|e| storage(e.to_string()))?;
            file.seek(SeekFrom::Start(offset)).map_err(|e| storage(e.to_string()))?;
            file.read_exact(&mut bytes).map_err(|e| storage(e.to_string()))?;
        }
        Ok(json!({ "stream": stream, "offset": offset, "nextOffset": end, "durableEnd": durable, "terminal": terminal,
            "eof": terminal && end == durable, "dataHex": hex::encode(&bytes) }))
    }

    fn ack(&self, payload: &Value) -> Result<Value, Refusal> {
        self.check_generation(payload)?;
        let mut inner = self.guard()?;
        Self::check_epoch(&inner, payload)?;
        let custody_id = text(payload, "custodyId")?.to_string();
        let stream = text(payload, "stream")?.to_string();
        let offset = number(payload, "offset")?;
        let record = inner.records.get(&custody_id).cloned().ok_or(Refusal { code: "not_found", message: "No custody record has that identity.".into() })?;
        if offset > durable_bytes(&inner, &record, &stream)? {
            return refuse("ack_beyond_durable", "The Engine acknowledged bytes the spool has not made durable.");
        }
        // The durable counters are persisted with each acknowledgement, so the record reflects what the spool holds while the CLI
        // runs and not only after its terminal state.
        let durable_now = (durable_bytes(&inner, &record, "stdout")?, durable_bytes(&inner, &record, "stderr")?);
        let acked_now = {
            let entry = inner.records.get_mut(&custody_id).ok_or_else(|| storage("custody index is inconsistent".into()))?;
            let field = if stream == "stderr" { &mut entry.stderr_acked } else { &mut entry.stdout_acked };
            // Monotonic: a late or repeated acknowledgement never moves the cursor backwards.
            if offset > *field {
                *field = offset;
                entry.stdout_durable = durable_now.0;
                entry.stderr_durable = durable_now.1;
                entry.updated_at = now();
                let snapshot = entry.clone();
                write_json_atomic(&self.record_path(&custody_id), &snapshot).map_err(storage)?;
            }
            if stream == "stderr" { entry.stderr_acked } else { entry.stdout_acked }
        };
        Ok(json!({ "acked": acked_now }))
    }

    // An authorized Stop (epoch-fenced) or an emergency Stop (per-attempt credential, usable without any Engine).
    fn stop(&self, payload: &Value, emergency: bool) -> Result<Value, Refusal> {
        let custody_id = text(payload, "custodyId")?.to_string();
        let inner = self.guard()?;
        if emergency {
            let token = text(payload, "emergencyToken")?;
            let record = inner.records.get(&custody_id).ok_or(Refusal { code: "not_found", message: "No custody record has that identity.".into() })?;
            if !digest_equal(&sha256_hex(token.as_bytes()), &record.emergency_sha256) {
                return refuse("unauthorized", "The emergency credential does not match this invocation.");
            }
        } else {
            self.check_generation(payload)?;
            Self::check_epoch(&inner, payload)?;
        }
        if !inner.records.contains_key(&custody_id) {
            return refuse("not_found", "No custody record has that identity.");
        }
        let live = inner.live.get(&custody_id).cloned();
        drop(inner);
        if let Some(live) = live {
            record_stop(&live.stop, if emergency { "emergency_stopped" } else { "stopped" });
            let _ = live.job.terminate();
            wait_empty(&live.job, DRAIN);
        }
        let inner = self.guard()?;
        if !inner.records.contains_key(&custody_id) {
            return refuse("not_found", "No custody record has that identity.");
        }
        Ok(status_of(&inner, &custody_id))
    }

    // Admits only an absolute path whose canonical form and content match an allowlist entry.
    fn admit_executable(&self, command: &str) -> Result<(PathBuf, String), Refusal> {
        if !Path::new(command).is_absolute() {
            return refuse("executable_not_allowed", "The executable must be named by an absolute path.");
        }
        let requested = fs::canonicalize(command).map_err(|_| Refusal { code: "executable_not_allowed", message: "The executable does not exist.".into() })?;
        let requested = node_path(&requested);
        let key = requested.to_string_lossy().to_lowercase();
        for allowed in &self.allowlist {
            let Ok(allowed_path) = fs::canonicalize(&allowed.path) else { continue };
            if node_path(&allowed_path).to_string_lossy().to_lowercase() != key {
                continue;
            }
            let digest = file_sha256(&requested).map_err(storage)?;
            if digest.eq_ignore_ascii_case(&allowed.sha256) {
                return Ok((requested, digest));
            }
            return refuse("executable_not_allowed", "The executable's content does not match its allowlist entry.");
        }
        refuse("executable_not_allowed", "The executable is not on the Custody allowlist.")
    }

    fn record_path(&self, custody_id: &str) -> PathBuf {
        self.root.join("attempts").join(format!("{custody_id}.json"))
    }

    fn spool_dir(&self, custody_id: &str) -> PathBuf {
        self.root.join("spool").join(custody_id)
    }

    fn spool_path(&self, custody_id: &str, stream: &str) -> PathBuf {
        self.spool_dir(custody_id).join(if stream == "stderr" { "stderr.bin" } else { "stdout.bin" })
    }
}

// Reconciliation at Host start. Nothing here adopts a process: the previous Job ended with the previous Host.
fn reconcile(record: &mut Record, root: &Path) {
    let spool_dir = root.join("spool").join(&record.custody_id);
    let spool = |name: &str| spool_dir.join(name);
    match record.state.as_str() {
        "admitted" => {
            record.state = "refused_host_restart".into();
            record.termination_reason = Some("The Host restarted before this invocation was launched; it was not launched and will not be launched.".into());
        }
        "spawning" | "running" => {
            record.state = "host_lost".into();
            record.termination_reason = Some("The Host stopped while this invocation was starting or running; its kill-on-close Job ended the CLI tree. The next Host does not adopt it.".into());
            record.stdout_durable = file_length(&spool("stdout.bin"));
            record.stderr_durable = file_length(&spool("stderr.bin"));
            record.spool_complete = false;
            record.tail_gap_possible = true;
        }
        // An end whose Job the previous Host could not verify empty. That Host's Job handles are closed now (kill-on-close), so the drain
        // evidence no longer applies; the end is decided as for a lost Host, by the recorded process instance.
        _ if record.is_terminal() && record.drained == Some(false) => {
            record.drained = None;
        }
        _ => {}
    }
    record.updated_at = now();
}

fn durable_bytes(inner: &Inner, record: &Record, stream: &str) -> Result<u64, Refusal> {
    if let Some(live) = inner.live.get(&record.custody_id) {
        return Ok(if stream == "stderr" { live.stderr_durable.load(Ordering::SeqCst) } else { live.stdout_durable.load(Ordering::SeqCst) });
    }
    Ok(if stream == "stderr" { record.stderr_durable } else { record.stdout_durable })
}

fn status_of(inner: &Inner, custody_id: &str) -> Value {
    let record = &inner.records[custody_id];
    let mut value = record.view();
    if let Some(live) = inner.live.get(custody_id) {
        value["stdoutDurable"] = json!(live.stdout_durable.load(Ordering::SeqCst));
        value["stderrDurable"] = json!(live.stderr_durable.load(Ordering::SeqCst));
        value["jobEmpty"] = json!(live.job.is_empty().unwrap_or(false));
    }
    value["processTreeEnded"] = json!(process_tree_ended(record, inner.live.contains_key(custody_id)));
    value
}

// Whether every process of this invocation has ended, as this Host can establish it; `None` means it cannot. A live record has not
// ended. A record the Host terminated has ended when its Job was verified empty. A record that never reached a process has nothing
// to end. A record whose Host is gone has ended only when the recorded process instance no longer exists. The Engine releases its
// workspace hold only on `true`.
fn process_tree_ended(record: &Record, live: bool) -> Option<bool> {
    if live {
        return Some(false);
    }
    match record.state.as_str() {
        "admitted" => Some(false),
        // The Host that recorded this invocation is gone, and with it the last handle of its kill-on-close Job. A recorded process instance
        // decides by its own death. With no recorded instance, no process of the invocation can run: the spawn either never happened, or
        // the process was assigned to that closed Job, or it was still suspended and never resumed.
        "host_lost" => match (record.process_id, record.process_creation_time) {
            (Some(pid), Some(created)) => native::identity_alive(pid, created).map(|alive| !alive),
            (None, _) => Some(true),
            _ => None,
        },
        // Spawning with no recorded process: the spawn never completed in this Host, so no process of the invocation exists.
        "spawning" if record.process_id.is_none() => Some(true),
        _ if record.is_terminal() => match (record.drained, record.process_id, record.process_creation_time) {
            (Some(drained), _, _) => Some(drained),
            (None, None, _) => Some(true),
            // An undrained end whose recording Host is gone (reconcile cleared `drained`): decided as for a lost Host.
            (None, Some(pid), Some(created)) => native::identity_alive(pid, created).map(|alive| !alive),
            (None, Some(_), None) => None,
        },
        _ => None,
    }
}

fn set_state(inner: &mut Inner, root: &Path, custody_id: &str, state: &str) -> Result<(), Refusal> {
    let entry = inner.records.get_mut(custody_id).ok_or_else(|| storage("custody index is inconsistent".into()))?;
    entry.state = state.into();
    entry.updated_at = now();
    let snapshot = entry.clone();
    write_json_atomic(&root.join("attempts").join(format!("{custody_id}.json")), &snapshot).map_err(storage)
}

fn finish_record(inner: &mut Inner, root: &Path, custody_id: &str, state: &str, reason: Option<&str>, exit_code: Option<i32>, spool_complete: bool) -> Result<(), Refusal> {
    let entry = inner.records.get_mut(custody_id).ok_or_else(|| storage("custody index is inconsistent".into()))?;
    entry.state = state.into();
    entry.termination_reason = reason.map(str::to_string);
    entry.exit_code = exit_code;
    entry.spool_complete = spool_complete;
    entry.updated_at = now();
    let snapshot = entry.clone();
    inner.pending.remove(custody_id);
    write_json_atomic(&root.join("attempts").join(format!("{custody_id}.json")), &snapshot).map_err(storage)
}

fn record_stop(stop: &Mutex<Option<String>>, reason: &str) {
    if let Ok(mut guard) = stop.lock() {
        if guard.is_none() {
            *guard = Some(reason.to_string());
        }
    }
}

// An ended invocation whose Job was not empty when its end was recorded: once the Job is verified empty, the record says so durably, and
// the Job is no longer kept.
fn recheck_drain(inner: &mut Inner, root: &Path, custody_id: &str, test_write_fails: bool) {
    let Some(job) = inner.undrained.get(custody_id) else { return };
    if !job.is_empty().unwrap_or(false) {
        return;
    }
    let Some(entry) = inner.records.get_mut(custody_id) else { return };
    let mut proven = entry.clone();
    proven.drained = Some(true);
    proven.updated_at = now();
    // The proof counts only once it is durable.
    let written = if test_write_fails { Err("injected drain-proof write failure".to_string()) }
        else { write_json_atomic(&root.join("attempts").join(format!("{custody_id}.json")), &proven) };
    if written.is_err() {
        return;
    }
    *entry = proven;
    inner.undrained.remove(custody_id);
}

fn wait_empty(job: &Containment, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        if job.is_empty().unwrap_or(false) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(TICK);
    }
}

// The shared pieces one reader needs: the Job to terminate on a fault, the stop reason to record, its durable counter and the spool limit.
struct ReaderTarget {
    job: Arc<Containment>,
    stop: Arc<Mutex<Option<String>>>,
    durable: Arc<AtomicU64>,
    limit: u64,
    crash_after: Option<u64>,
}

// Copies one pipe into its durable spool. Bytes count as durable only after the file has synced, so an offset the Engine
// reads is always backed by disk. A reader reports whether it reached a clean end of stream.
fn spawn_reader(pipe: File, path: PathBuf, target: ReaderTarget, done: mpsc::Sender<bool>) -> Result<(), String> {
    thread::Builder::new().name("deszo-custody-reader".into()).spawn(move || {
        let mut pipe = pipe;
        let mut clean = true;
        let mut spool = match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => file,
            Err(_) => {
                // Without a spool the output cannot be kept, so the CLI is not allowed to keep running unobserved.
                record_stop(&target.stop, "spool_failed");
                let _ = target.job.terminate();
                let _ = done.send(false);
                return;
            }
        };
        let mut buffer = vec![0u8; READ_CHUNK];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let size = target.durable.load(Ordering::SeqCst);
                    if size + read as u64 > target.limit {
                        clean = false;
                        record_stop(&target.stop, "spool_limit_exceeded");
                        let _ = target.job.terminate();
                        break;
                    }
                    let written = spool.write_all(&buffer[..read]);
                    // Test hook: the Host dies with these bytes written but not yet synced or made durable.
                    if let Some(limit) = target.crash_after {
                        if size + read as u64 >= limit && cfg!(debug_assertions) {
                            std::process::abort();
                        }
                    }
                    if written.and_then(|_| spool.sync_data()).is_err() {
                        clean = false;
                        record_stop(&target.stop, "spool_failed");
                        let _ = target.job.terminate();
                        break;
                    }
                    target.durable.store(size + read as u64, Ordering::SeqCst);
                }
                // A closed pipe is the normal end of a stream; any other error means the capture is incomplete.
                Err(error) => {
                    if error.raw_os_error() != Some(109) {
                        clean = false;
                    }
                    break;
                }
            }
        }
        let _ = done.send(clean);
    }).map(|_| ()).map_err(|e| e.to_string())
}

// Waits for the CLI, enforces its admitted deadline on the monotonic clock, drains its Job, and records the terminal state
// once. The Engine learns the outcome from this record; no Engine is needed for any of it.
fn supervise(context: Context, custody_id: String, live: Arc<Live>, clean: Vec<mpsc::Receiver<bool>>) {
    loop {
        match native::wait(&live.process, TICK) {
            native::Wait::Exited | native::Wait::Failed => break,
            native::Wait::Pending => {
                if Instant::now() >= live.deadline {
                    record_stop(&live.stop, "deadline_terminated");
                }
                // While a stop is recorded (an operator Stop, the deadline, a capture fault or a failed running record), termination is requested
                // on every tick until the leader ends, so one refused termination request is not final.
                if live.stop.lock().map(|guard| guard.is_some()).unwrap_or(false) {
                    let _ = live.job.terminate();
                }
            }
        }
    }
    let exit_code = native::exit_code(&live.process).unwrap_or(-1);
    // A descendant can outlive its leader. The Job, not the leader, is the containment boundary, so drain it. The record keeps
    // whether the Job was empty after that drain: only then has every process of this invocation ended.
    let mut drained = wait_empty(&live.job, context.undrained_drain.unwrap_or(DRAIN));
    // The test hook leaves the Job as a termination that did not empty it in time would: a descendant still in it.
    if !drained && context.undrained_drain.is_none() {
        let _ = live.job.terminate();
        drained = wait_empty(&live.job, DRAIN);
    }
    let streams_clean = clean.iter().all(|done| done.recv_timeout(DRAIN).unwrap_or(false));
    let reason = live.stop.lock().ok().and_then(|guard| guard.clone());
    let state = reason.clone().filter(|r| STOP_STATES.contains(&r.as_str())).unwrap_or_else(|| "exited".into());
    let text = match state.as_str() {
        "stopped" => Some("Stopped by an authorized Stop request."),
        "emergency_stopped" => Some("Stopped by the emergency credential."),
        "deadline_terminated" => Some("The admitted process deadline elapsed."),
        "spool_limit_exceeded" => Some("The durable spool reached its hard limit; output after the limit was not captured."),
        "spool_failed" => Some("The durable spool could not be written; output after the failure was not captured."),
        "host_stopped" => Some("The Host was shutting down."),
        _ => None,
    };
    let stdout_final = live.stdout_durable.load(Ordering::SeqCst);
    let stderr_final = live.stderr_durable.load(Ordering::SeqCst);
    // A capture fault never counts as a complete spool, whatever the process exit code was.
    let capture_fault = matches!(state.as_str(), "spool_limit_exceeded" | "spool_failed");
    let Ok(mut inner) = context.inner.lock() else { return };
    // The drain proof counts only once the record that carries it is durable. A record that cannot be written is reported as not drained,
    // and its Job is kept, so that a later status proves the drain and writes the proof (recheck_drain).
    let mut proven = drained;
    if let Some(entry) = inner.records.get_mut(&custody_id) {
        entry.state = state;
        entry.exit_code = Some(exit_code);
        entry.termination_reason = text.map(str::to_string);
        entry.stdout_durable = stdout_final;
        entry.stderr_durable = stderr_final;
        entry.spool_complete = streams_clean && !capture_fault;
        entry.drained = Some(drained);
        entry.tail_gap_possible = !streams_clean;
        entry.updated_at = now();
        let snapshot = entry.clone();
        if write_json_atomic(&context.root.join("attempts").join(format!("{custody_id}.json")), &snapshot).is_err() {
            proven = false;
            entry.drained = Some(false);
        }
    }
    if !proven {
        inner.undrained.insert(custody_id.clone(), Arc::clone(&live.job));
    }
    inner.live.remove(&custody_id);
    inner.pending.remove(&custody_id);
}

fn string_array(payload: &Value, key: &str) -> Result<Vec<String>, Refusal> {
    let values = payload.get(key).and_then(Value::as_array).ok_or_else(|| Refusal { code: "invalid_request", message: format!("{key} must be an array") })?;
    values.iter().map(|value| value.as_str().map(str::to_string).ok_or_else(|| Refusal { code: "invalid_request", message: format!("{key} must contain strings") })).collect()
}

// The provider's environment, with every lifecycle, supervisor and Custody credential removed. Names are checked, values are never logged.
fn environment_pairs(payload: &Value) -> Result<Vec<(String, String)>, Refusal> {
    let object = payload.get("env").and_then(Value::as_object).ok_or_else(|| Refusal { code: "invalid_request", message: "env must be an object".into() })?;
    let mut pairs = Vec::new();
    for (name, value) in object {
        let value = value.as_str().ok_or_else(|| Refusal { code: "invalid_request", message: "env values must be strings".into() })?;
        if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0') {
            return refuse("invalid_request", "an environment entry is malformed");
        }
        let upper_name = name.to_ascii_uppercase();
        if DENIED_ENV_NAMES.contains(&upper_name.as_str()) || DENIED_ENV_PREFIXES.iter().any(|prefix| upper_name.starts_with(prefix)) {
            continue;
        }
        pairs.push((name.clone(), value.to_string()));
    }
    Ok(pairs)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buffer);
    hex::encode(buffer)
}

fn digest_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.bytes().zip(right.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn file_length(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

/// Configuration of the custody component on its own (`custody-serve`): where its state lives and which generation it serves.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub state_root: PathBuf,
    pub generation: String,
    /// Debug builds only: a fixed 64-hex capability, so that a test can run Engines against a known Host. Release builds
    /// always draw a random capability, and a supplied value is refused there.
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub custody: CustodyConfig,
}

/// Runs the custody component alone: the same authenticated `custody.*` commands the Host serves beside a managed application.
/// It writes its endpoint under the state root and stops when its stdin reads `shutdown`; a graceful stop ends every Job it owns.
pub fn run_service(config: ServiceConfig) -> Result<(), String> {
    fs::create_dir_all(&config.state_root).map_err(|e| e.to_string())?;
    let capability = match config.capability.as_deref() {
        None => random_hex(32),
        Some(_) if !cfg!(debug_assertions) => return Err("a supplied custody capability is accepted only in a debug build".into()),
        Some(value) if value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()) => value.to_string(),
        Some(_) => return Err("the custody capability must be 64 hexadecimal characters".into()),
    };
    let registry = Arc::new(CustodyRegistry::open(&config.state_root, &config.generation, &config.custody)?);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    write_json_atomic(&config.state_root.join("endpoint.json"), &json!({ "address": address.to_string(), "protocol": "deszo-custody/1",
        "pid": std::process::id(), "generation": config.generation }))?;
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = Arc::clone(&stop);
        thread::Builder::new().name("deszo-custody-console".into()).spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                if line.trim() == "shutdown" {
                    break;
                }
            }
            stop.store(true, Ordering::SeqCst);
        }).map_err(|e| e.to_string())?;
    }
    let capability = Arc::new(capability);
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let (registry, capability) = (Arc::clone(&registry), Arc::clone(&capability));
                thread::Builder::new().name("deszo-custody-peer".into()).spawn(move || serve_connection(stream, &registry, &capability))
                    .map_err(|e| e.to_string())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(error.to_string()),
        }
    }
    registry.shutdown();
    Ok(())
}

// One newline-delimited request, authenticated by the capability before any command is dispatched.
fn serve_connection(mut stream: TcpStream, registry: &CustodyRegistry, capability: &str) {
    // The listener is non-blocking; an accepted stream must not inherit that, or a request that has not arrived yet is
    // refused with WouldBlock and the connection is dropped with the request unread.
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok(reader) = stream.try_clone() else { return };
    let mut line = String::new();
    if BufReader::new(reader).take((IPC_MAX_LINE + 1) as u64).read_line(&mut line).is_err() || line.len() > IPC_MAX_LINE {
        return;
    }
    let envelope: Value = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(_) => {
            let _ = writeln!(stream, "{}", json!({ "ok": false, "error": "malformed request", "code": "invalid_request" }));
            return;
        }
    };
    let presented = envelope.get("capability").and_then(Value::as_str).unwrap_or("");
    let response = if !constant_time_equal(presented.as_bytes(), capability.as_bytes()) {
        json!({ "ok": false, "error": "unauthenticated lifecycle peer", "code": "unauthenticated" })
    } else {
        let command = envelope.get("command").and_then(Value::as_str).unwrap_or("");
        let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);
        match registry.dispatch(command, &payload) {
            Ok(result) => json!({ "ok": true, "result": result }),
            Err(refusal) => json!({ "ok": false, "error": refusal.message, "code": refusal.code }),
        }
    };
    let _ = writeln!(stream, "{response}");
}

/// Windows argument quoting that CreateProcess and the CLI's own argv parser both accept (ADR-0002 section 4).
pub fn quote_argument(argument: &str) -> String {
    if !argument.is_empty() && !argument.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '"')) {
        return argument.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for ch in argument.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat('\\').take(backslashes));
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    out.extend(std::iter::repeat('\\').take(backslashes * 2));
    out.push('"');
    out
}

pub fn command_line(program: &str, arguments: &[String]) -> String {
    std::iter::once(program).chain(arguments.iter().map(String::as_str)).map(quote_argument).collect::<Vec<_>>().join(" ")
}

#[cfg(windows)]
mod native {
    use super::{command_line, Containment};
    use std::{
        ffi::c_void,
        fs::File,
        io::Write,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
        thread,
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, SetHandleInformation, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0,
            WAIT_TIMEOUT},
        Security::SECURITY_ATTRIBUTES,
        System::{
            Pipes::CreatePipe,
            Threading::{CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, GetProcessTimes, InitializeProcThreadAttributeList,
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, ResumeThread, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
                CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW},
        },
    };

    pub struct Handle(pub HANDLE);
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    pub struct Spawned {
        pub process: Handle,
        pub pid: u32,
        pub creation_time: u64,
        pub stdout: File,
        pub stderr: File,
    }

    pub enum Wait {
        Exited,
        Pending,
        Failed,
    }

    // The attribute list passes exactly the listed handles to the child. It is freed when it goes out of scope.
    struct AttributeList {
        buffer: Vec<usize>,
    }

    impl AttributeList {
        fn with_handles(handles: &[HANDLE]) -> Result<AttributeList, String> {
            let mut size = 0usize;
            unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
            let words = size.div_ceil(std::mem::size_of::<usize>());
            let mut list = AttributeList { buffer: vec![0usize; words] };
            if unsafe { InitializeProcThreadAttributeList(list.ptr(), 1, 0, &mut size) } == 0 {
                return Err(last_os_error("InitializeProcThreadAttributeList"));
            }
            let ok = unsafe { UpdateProcThreadAttribute(list.ptr(), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, handles.as_ptr() as *const c_void,
                handles.len() * std::mem::size_of::<HANDLE>(), std::ptr::null_mut(), std::ptr::null_mut()) };
            if ok == 0 {
                return Err(last_os_error("UpdateProcThreadAttribute"));
            }
            Ok(list)
        }

        fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
            self.buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
        }
    }

    impl Drop for AttributeList {
        fn drop(&mut self) {
            unsafe { DeleteProcThreadAttributeList(self.ptr()) }
        }
    }

    fn last_os_error(call: &str) -> String {
        format!("{call} failed: {}", std::io::Error::last_os_error())
    }

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect()
    }

    // Windows requires the block sorted by name (case-insensitive) and terminated by an empty entry.
    fn environment_block(env: &[(String, String)]) -> Vec<u16> {
        let mut entries: Vec<String> = env.iter().map(|(name, value)| format!("{name}={value}")).collect();
        entries.sort_by_key(|entry| entry.to_uppercase());
        let mut block = Vec::new();
        for entry in entries {
            block.extend(entry.encode_utf16());
            block.push(0);
        }
        block.push(0);
        block
    }

    fn pipe_pair(inherit_read_side: bool) -> Result<(HANDLE, HANDLE), String> {
        let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 1 };
        let (mut read, mut write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
        if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
            return Err(last_os_error("CreatePipe"));
        }
        // Only the child's end is inheritable; the Host keeps the other end private.
        let private = if inherit_read_side { write } else { read };
        unsafe { SetHandleInformation(private, HANDLE_FLAG_INHERIT, 0) };
        Ok((read, write))
    }

    fn filetime(value: FILETIME) -> u64 {
        ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
    }

    /// Creates the CLI suspended, assigns it to the Custody Job, then resumes it. A failed assignment kills it before it runs.
    pub fn spawn(job: &Containment, executable: &str, args: &[String], cwd: &str, env: &[(String, String)], stdin: Vec<u8>) -> Result<Spawned, String> {
        let (stdin_read, stdin_write) = pipe_pair(true)?;
        let (stdout_read, stdout_write) = pipe_pair(false)?;
        let (stderr_read, stderr_write) = pipe_pair(false)?;
        let child_side = [stdin_read, stdout_write, stderr_write];
        let close_child_side = || unsafe {
            CloseHandle(stdin_read);
            CloseHandle(stdout_write);
            CloseHandle(stderr_write);
        };
        let mut attributes = match AttributeList::with_handles(&child_side) {
            Ok(list) => list,
            Err(message) => {
                close_child_side();
                unsafe { CloseHandle(stdin_write); CloseHandle(stdout_read); CloseHandle(stderr_read) };
                return Err(message);
            }
        };
        let startup = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                dwFlags: STARTF_USESTDHANDLES,
                hStdInput: stdin_read,
                hStdOutput: stdout_write,
                hStdError: stderr_write,
                ..unsafe { std::mem::zeroed() }
            },
            lpAttributeList: attributes.ptr(),
        };
        let mut command = wide(&command_line(executable, args));
        let application = wide(executable);
        let environment = environment_block(env);
        let directory = wide(cwd);
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe { CreateProcessW(application.as_ptr(), command.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, environment.as_ptr() as *const c_void,
            directory.as_ptr(), &startup as *const STARTUPINFOEXW as *const STARTUPINFOW, &mut info) };
        close_child_side();
        if created == 0 {
            unsafe { CloseHandle(stdin_write); CloseHandle(stdout_read); CloseHandle(stderr_read) };
            return Err(last_os_error("CreateProcessW"));
        }
        // Containment precedes resume: if the Job assignment fails, the suspended CLI is terminated before any of its code runs.
        if let Err(message) = job.assign_handle(info.hProcess) {
            unsafe {
                TerminateProcess(info.hProcess, 1);
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
                CloseHandle(stdin_write);
                CloseHandle(stdout_read);
                CloseHandle(stderr_read);
            }
            return Err(message);
        }
        let (mut created_at, mut exited, mut kernel, mut user) = (FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }, FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }, FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 });
        let creation_time = if unsafe { GetProcessTimes(info.hProcess, &mut created_at, &mut exited, &mut kernel, &mut user) } != 0 { filetime(created_at) } else { 0 };
        if unsafe { ResumeThread(info.hThread) } == u32::MAX {
            let message = last_os_error("ResumeThread");
            let _ = job.terminate();
            unsafe { CloseHandle(info.hThread); CloseHandle(info.hProcess); CloseHandle(stdin_write); CloseHandle(stdout_read); CloseHandle(stderr_read) };
            return Err(message);
        }
        unsafe { CloseHandle(info.hThread) };
        // A CLI that never reads its stdin must not block the Host, so the prompt is written from a helper thread.
        let mut stdin_file = unsafe { File::from_raw_handle(stdin_write as _) };
        thread::Builder::new().name("deszo-custody-stdin".into()).spawn(move || {
            let _ = stdin_file.write_all(&stdin);
        }).map_err(|e| e.to_string())?;
        Ok(Spawned {
            process: Handle(info.hProcess),
            pid: info.dwProcessId,
            creation_time,
            stdout: unsafe { File::from_raw_handle(stdout_read as _) },
            stderr: unsafe { File::from_raw_handle(stderr_read as _) },
        })
    }

    pub fn wait(process: &Handle, timeout: Duration) -> Wait {
        match unsafe { WaitForSingleObject(process.0, timeout.as_millis() as u32) } {
            WAIT_OBJECT_0 => Wait::Exited,
            WAIT_TIMEOUT => Wait::Pending,
            _ => Wait::Failed,
        }
    }

    // The process instance (PID plus creation time) the Host recorded: `Some(true)` while it still runs, `Some(false)` once it has ended
    // or its PID now names a different process, and `None` when Windows gives no answer. A still-active exit code reads as alive, so an
    // uncertain answer keeps the workspace held.
    pub fn identity_alive(pid: u32, creation_time: u64) -> Option<bool> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER { Some(false) } else { None };
        }
        let handle = Handle(handle);
        let created = creation_of(&handle)?;
        if created != creation_time {
            return Some(false);
        }
        const STILL_ACTIVE: i32 = 259;
        Some(exit_code(&handle) == Some(STILL_ACTIVE))
    }

    #[cfg(test)]
    pub fn creation_time_of(pid: u32) -> Option<u64> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        creation_of(&Handle(handle))
    }

    fn creation_of(handle: &Handle) -> Option<u64> {
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        if unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
            return None;
        }
        Some(filetime(created))
    }

    pub fn exit_code(process: &Handle) -> Option<i32> {
        let mut code = 0u32;
        if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
            None
        } else {
            Some(code as i32)
        }
    }
}

// Process Custody is a Windows implementation in this PoC. Other platforms compile, and refuse every launch.
#[cfg(not(windows))]
mod native {
    use super::Containment;
    use std::{fs::File, time::Duration};

    pub struct Handle;

    pub struct Spawned {
        pub process: Handle,
        pub pid: u32,
        pub creation_time: u64,
        pub stdout: File,
        pub stderr: File,
    }

    pub enum Wait {
        Exited,
        Pending,
        Failed,
    }

    pub fn spawn(_job: &Containment, _executable: &str, _args: &[String], _cwd: &str, _env: &[(String, String)], _stdin: Vec<u8>) -> Result<Spawned, String> {
        Err("Process Custody requires Windows in this PoC.".into())
    }

    pub fn wait(_process: &Handle, _timeout: Duration) -> Wait {
        Wait::Failed
    }

    pub fn exit_code(_process: &Handle) -> Option<i32> {
        None
    }

    pub fn identity_alive(_pid: u32, _creation_time: u64) -> Option<bool> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("deszo-custody-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn quoting_matches_the_windows_argv_parser() {
        assert_eq!(quote_argument("plain"), "plain");
        assert_eq!(quote_argument("two words"), "\"two words\"");
        assert_eq!(quote_argument(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_argument(""), "\"\"");
    }

    #[test]
    fn provider_environment_never_carries_lifecycle_or_custody_authority() {
        let payload = json!({ "env": { "PATH": "C:\\bin", "DESZO_LIFECYCLE_HOST_CAPABILITY": "secret", "DESZO_SUPERVISOR_TOKEN": "t",
            "DESZO_LAUNCH_SHIM": "shim", "DESZO_CUSTODY_PERMIT": "p", "DESZO_MANAGED_INVOCATION": "ok", "OPENAI_API_KEY": "api",
            "codex_api_key": "lowercase-api", "DESZO_OWNER_TOKEN": "owner", "OWNER_TOKEN": "owner", "FIRST_PARTY_TOKEN": "owner",
            "HOST_TOKEN": "host", "DESZO_JUDGE_SECRET": "judge", "DESZO_HOST_CAPABILITY": "host", "deszo_custody_epoch": "1",
            "CODEX_HOME": "profile", "CODEX_PERMISSION_PROFILE": ":danger-full-access", "CODEX_SESSION_ID": "outer-session",
            "CODEX_APP_TOOLS_PIPE_PATH": "internal-pipe", "CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY": "outer-task",
            "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY": "outer-family" } });
        let names: Vec<String> = environment_pairs(&payload).unwrap().into_iter().map(|(name, _)| name).collect();
        assert!(names.contains(&"PATH".to_string()));
        assert!(names.contains(&"DESZO_MANAGED_INVOCATION".to_string()));
        assert!(names.contains(&"CODEX_HOME".to_string()), "the supported Codex auth home remains available");
        assert!(!names.iter().any(|name| ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY",
            "GOOGLE_API_KEY", "DESZO_PROCESS_CUSTODY", "DESZO_OWNER_TOKEN", "OWNER_TOKEN", "FIRST_PARTY_TOKEN", "HOST_TOKEN"]
            .contains(&name.to_ascii_uppercase().as_str())));
        assert!(!names.iter().any(|name| {
            let upper = name.to_ascii_uppercase();
            ["DESZO_LIFECYCLE_", "DESZO_SUPERVISOR_", "DESZO_LAUNCH_SHIM", "DESZO_CUSTODY_", "DESZO_TEST_DUPLICATE_LIFECYCLE",
                "DESZO_JUDGE_", "DESZO_HOST_", "DESZO_OWNER_", "CODEX_APP_", "CODEX_INTERNAL_", "CODEX_PERMISSION_", "CODEX_SESSION_",
                "CODEX_TASK_", "CODEX_THREAD_", "CODEX_TOOL_", "CODEX_MCP_", "CODEX_SAGE_", "CODEX_APPLY_PATCH_", "CODEX_WINDOWS_SANDBOX_"]
                .iter().any(|prefix| upper.starts_with(prefix))
        }));
    }

    #[test]
    fn reconciliation_never_relaunches_or_adopts() {
        let root = temp("reconcile");
        let base = |state: &str| Record { custody_id: "c1".into(), attempt_id: "a1".into(), run_id: "r".into(), provider: "codex".into(), executable: "x".into(),
            executable_sha256: "0".into(), cwd: "c".into(), invocation_digest: "d".into(), deadline_ms: 1, epoch: 1, state: state.into(), process_id: Some(7),
            process_creation_time: Some(9), exit_code: None, drained: None, termination_reason: None, stdout_durable: 0, stderr_durable: 0, stdout_acked: 0, stderr_acked: 0,
            spool_complete: false, tail_gap_possible: false, permit_sha256: "p".into(), emergency_sha256: "e".into(), created_at: "t".into(), updated_at: "t".into() };
        let mut admitted = base("admitted");
        reconcile(&mut admitted, &root);
        assert_eq!(admitted.state, "refused_host_restart");
        let mut running = base("running");
        reconcile(&mut running, &root);
        assert_eq!(running.state, "host_lost");
        assert!(running.tail_gap_possible && !running.spool_complete);
        let mut exited = base("exited");
        reconcile(&mut exited, &root);
        assert_eq!(exited.state, "exited", "a terminal record is never rewritten");
        fs::remove_dir_all(root).ok();
    }

    // H3: a recorded process instance is alive only while it is that process. A PID now naming another process is a different
    // instance, and a killed, reaped process has ended. Real child process.
    #[cfg(windows)]
    #[test]
    fn a_recorded_process_instance_is_alive_only_while_it_is_that_process() {
        let mut child = std::process::Command::new("PING.EXE").args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null())
            .spawn().expect("a child process starts");
        let pid = child.id();
        let created = super::native::creation_time_of(pid).expect("the child's creation time is readable");
        assert_eq!(super::native::identity_alive(pid, created), Some(true), "the running instance is alive");
        assert_eq!(super::native::identity_alive(pid, created.wrapping_add(1)), Some(false), "a PID with another creation time is another process");
        child.kill().expect("the child can be stopped");
        child.wait().expect("the child is reaped");
        assert_eq!(super::native::identity_alive(pid, created), Some(false), "the ended instance is not alive");
    }

    // H3: a terminal record has ended only when its Job was verified empty, or when it never reached a process. A live record has not.
    #[test]
    fn a_terminal_record_has_ended_only_with_verified_drain_or_no_process() {
        let base = |state: &str, process: Option<u32>, drained: Option<bool>| Record { custody_id: "c1".into(), attempt_id: "a1".into(), run_id: "r".into(),
            provider: "codex".into(), executable: "x".into(), executable_sha256: "0".into(), cwd: "c".into(), invocation_digest: "d".into(), deadline_ms: 1,
            epoch: 1, state: state.into(), process_id: process, process_creation_time: process.map(|_| 9), exit_code: None, drained,
            termination_reason: None, stdout_durable: 0, stderr_durable: 0, stdout_acked: 0, stderr_acked: 0, spool_complete: false,
            tail_gap_possible: false, permit_sha256: "p".into(), emergency_sha256: "e".into(), created_at: "t".into(), updated_at: "t".into() };
        assert_eq!(process_tree_ended(&base("running", Some(7), None), true), Some(false), "a live record has not ended");
        assert_eq!(process_tree_ended(&base("exited", Some(7), Some(true)), false), Some(true), "a drained Job has ended");
        assert_eq!(process_tree_ended(&base("stopped", Some(7), Some(false)), false), Some(false), "a Job that did not drain has not ended");
        assert_eq!(process_tree_ended(&base("admitted", None, None), false), Some(false), "an admission the Host has not withdrawn may still launch");
        assert_eq!(process_tree_ended(&base("admission_cancelled", None, None), false), Some(true), "a withdrawn admission never ran a process");
        // A record without a drain verdict comes from a Host that is gone: its recorded process instance decides, as for a lost Host.
        assert_eq!(process_tree_ended(&base("exited", Some(7), None), false), native::identity_alive(7, 9).map(|alive| !alive),
            "a record without a drain verdict is decided by its recorded process instance");
        let mut no_instance = base("exited", Some(7), None);
        no_instance.process_creation_time = None;
        assert_eq!(process_tree_ended(&no_instance, false), None, "without a recorded instance nothing can prove the end");
        assert_eq!(process_tree_ended(&base("host_lost", None, None), false), Some(true),
            "a lost invocation that never recorded a process cannot run one: its Host and that Host's Job are gone");
        // A Host restart turns an undrained end into one that its recorded process instance decides; a drained end is kept as it is.
        let root = std::env::temp_dir();
        let mut undrained = base("stopped", Some(7), Some(false));
        reconcile(&mut undrained, &root);
        assert_eq!(undrained.drained, None, "the previous Host's drain verdict no longer applies after a restart");
        let mut drained = base("exited", Some(7), Some(true));
        reconcile(&mut drained, &root);
        assert_eq!(drained.drained, Some(true), "a verified drain is kept");
        let mut spawning = base("spawning", None, None);
        reconcile(&mut spawning, &root);
        assert_eq!((spawning.state.as_str(), process_tree_ended(&spawning, false)), ("host_lost", Some(true)),
            "a Host lost during spawning, before any process was recorded, frees its workspace");
    }

    #[test]
    fn digest_comparison_is_exact() {
        assert!(digest_equal("abc", "abc"));
        assert!(!digest_equal("abc", "abd"));
        assert!(!digest_equal("abc", "abcd"));
    }
}

// Real Windows processes. PING.EXE is the only allowlisted executable; each test owns its state directory and stops what it starts.
#[cfg(all(test, windows))]
mod process_tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("deszo-custody-proc-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ping() -> PathBuf {
        PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32").join("PING.EXE")
    }

    fn registry(label: &str, mut config: CustodyConfig) -> (PathBuf, CustodyRegistry) {
        let path = ping();
        config.allowed_executables.push(AllowedExecutable { path: path.clone(), sha256: file_sha256(&path).unwrap() });
        let dir = temp(label);
        let registry = CustodyRegistry::open(&dir, "gen-1", &config).unwrap();
        (dir, registry)
    }

    // A registry that allowlists one specific file, for tests that alter that file's content after admission.
    fn registry_with_path(label: &str, path: PathBuf) -> (PathBuf, CustodyRegistry) {
        let sha256 = file_sha256(&path).unwrap();
        let dir = temp(label);
        let config = CustodyConfig { allowed_executables: vec![AllowedExecutable { path, sha256 }], ..CustodyConfig::default() };
        let registry = CustodyRegistry::open(&dir, "gen-1", &config).unwrap();
        (dir, registry)
    }

    fn attach(registry: &CustodyRegistry) -> u64 {
        registry.dispatch("custody.attach", &json!({ "generation": "gen-1" })).unwrap()["epoch"].as_u64().unwrap()
    }

    fn reserve_for(registry: &CustodyRegistry, epoch: u64, attempt: &str, command: &str, cwd: &Path, deadline_ms: u64, args: &[&str]) -> Result<Value, Refusal> {
        registry.dispatch("custody.reserve", &json!({ "epoch": epoch, "generation": "gen-1", "attemptId": attempt, "runId": "run-1",
            "provider": "codex", "command": command, "args": args, "cwd": cwd.to_string_lossy(), "env": { "PATH": std::env::var("PATH").unwrap_or_default(),
            "DESZO_LIFECYCLE_HOST_CAPABILITY": "must-not-leak" }, "stdinHex": null, "deadlineMs": deadline_ms }))
    }

    fn reserve(registry: &CustodyRegistry, epoch: u64, attempt: &str, deadline_ms: u64) -> Value {
        reserve_for(registry, epoch, attempt, ping().to_str().unwrap(), &std::env::temp_dir(), deadline_ms, &["-n", "30", "127.0.0.1"]).unwrap()
    }

    fn launch(registry: &CustodyRegistry, epoch: u64, custody_id: &str, permit: &str) -> Result<Value, Refusal> {
        registry.dispatch("custody.launch", &json!({ "epoch": epoch, "generation": "gen-1", "custodyId": custody_id, "permit": permit }))
    }

    fn status(registry: &CustodyRegistry, epoch: u64, custody_id: &str) -> Value {
        registry.dispatch("custody.status", &json!({ "epoch": epoch, "generation": "gen-1", "custodyId": custody_id })).unwrap()
    }

    fn wait_for(registry: &CustodyRegistry, epoch: u64, custody_id: &str, states: &[&str], bound: Duration) -> Value {
        let deadline = Instant::now() + bound;
        loop {
            let value = status(registry, epoch, custody_id);
            if states.contains(&value["state"].as_str().unwrap()) {
                return value;
            }
            assert!(Instant::now() < deadline, "the invocation never reached {states:?}: {value}");
            thread::sleep(Duration::from_millis(100));
        }
    }

    // PC-01: one OS process starts inside the custody Job; the spool captures its real output; its stop drains the Job.
    #[test]
    fn an_admitted_invocation_runs_one_contained_process_and_its_stop_drains_the_job() {
        let (dir, registry) = registry("contain", CustodyConfig::default());
        let epoch = attach(&registry);
        let admitted = reserve(&registry, epoch, "attempt-contain", 60_000);
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        let permit = admitted["permit"].as_str().unwrap().to_string();
        let running = launch(&registry, epoch, &id, &permit).unwrap();
        assert_eq!(running["state"], "running");
        let pid = running["processId"].as_u64().unwrap() as u32;
        assert!(pid > 0);
        assert_eq!(running["jobEmpty"], json!(false), "the CLI is a member of the custody Job");
        let captured = wait_for(&registry, epoch, &id, &["running"], Duration::from_secs(1));
        assert!(captured["processCreationTime"].as_u64().unwrap() > 0, "the creation identity is recorded");
        // Output reaches the spool while the process runs; the Engine reads it from offset 0.
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let durable = status(&registry, epoch, &id)["stdoutDurable"].as_u64().unwrap();
            if durable > 0 { break; }
            assert!(Instant::now() < deadline, "PING output never reached the spool");
            thread::sleep(Duration::from_millis(200));
        }
        let read = registry.dispatch("custody.read", &json!({ "epoch": epoch, "generation": "gen-1", "custodyId": id, "stream": "stdout", "offset": 0, "max": 65536 })).unwrap();
        let bytes = hex::decode(read["dataHex"].as_str().unwrap()).unwrap();
        assert!(!bytes.is_empty() && String::from_utf8_lossy(&bytes).contains("Pinging"), "the spool holds the CLI's real stdout");
        let stopped = registry.dispatch("custody.stop", &json!({ "epoch": epoch, "generation": "gen-1", "custodyId": id })).unwrap();
        assert_eq!(stopped["jobEmpty"], json!(true), "a stop drains the custody Job");
        let terminal = wait_for(&registry, epoch, &id, &["stopped"], Duration::from_secs(10));
        assert_eq!(terminal["terminal"], json!(true));
        assert!(terminal["stdoutDurable"].as_u64().unwrap() >= bytes.len() as u64);
        fs::remove_dir_all(dir).ok();
    }

    // PC-02 / PC-03: repeated and concurrent launches of one admitted invocation create exactly one process.
    #[test]
    fn duplicate_and_concurrent_launches_never_create_a_second_process() {
        let (dir, registry) = registry("duplicate", CustodyConfig::default());
        let registry = Arc::new(registry);
        let epoch = attach(&registry);
        let admitted = reserve(&registry, epoch, "attempt-duplicate", 60_000);
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        let permit = admitted["permit"].as_str().unwrap().to_string();
        let handles: Vec<_> = (0..4).map(|_| {
            let registry = Arc::clone(&registry);
            let (id, permit) = (id.clone(), permit.clone());
            thread::spawn(move || launch(&registry, epoch, &id, &permit).unwrap())
        }).collect();
        let pids: Vec<u64> = handles.into_iter().map(|handle| handle.join().unwrap()["processId"].as_u64().unwrap()).collect();
        assert!(pids.iter().all(|pid| *pid == pids[0]), "every concurrent launch observed the same process: {pids:?}");
        let again = reserve_for(&registry, epoch, "attempt-duplicate", ping().to_str().unwrap(), &std::env::temp_dir(), 60_000, &["-n", "30", "127.0.0.1"]).unwrap();
        assert_eq!(again["reused"], json!(true));
        assert!(again["permit"].is_null(), "a repeated admission never reissues the permit");
        let conflict = reserve_for(&registry, epoch, "attempt-duplicate", ping().to_str().unwrap(), &std::env::temp_dir(), 60_000, &["-n", "5", "127.0.0.1"]).unwrap_err();
        assert_eq!(conflict.code, "conflicting_invocation");
        registry.dispatch("custody.stop", &json!({ "epoch": epoch, "generation": "gen-1", "custodyId": id })).unwrap();
        wait_for(&registry, epoch, &id, &["stopped"], Duration::from_secs(10));
        fs::remove_dir_all(dir).ok();
    }

    // PC-04 / PC-05 / PC-06 / PC-07: stale generations, forged permits, unlisted executables and missing workspaces are refused.
    #[test]
    fn stale_engines_forged_permits_and_unapproved_launches_are_refused_before_any_process() {
        let (dir, registry) = registry("refuse", CustodyConfig::default());
        let first = attach(&registry);
        let second = attach(&registry);
        assert_eq!(reserve_for(&registry, first, "a-stale", ping().to_str().unwrap(), &std::env::temp_dir(), 1000, &["-n", "1", "127.0.0.1"]).unwrap_err().code, "stale_engine");
        let admitted = reserve(&registry, second, "a-current", 60_000);
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        assert_eq!(launch(&registry, first, &id, "forged").unwrap_err().code, "stale_engine");
        assert_eq!(launch(&registry, second, &id, "forged").unwrap_err().code, "permit_refused");
        let cmd = std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
        assert_eq!(reserve_for(&registry, second, "a-shell", &cmd, &std::env::temp_dir(), 1000, &["/c", "echo", "x"]).unwrap_err().code, "executable_not_allowed");
        assert_eq!(reserve_for(&registry, second, "a-relative", "PING.EXE", &std::env::temp_dir(), 1000, &["-n", "1", "127.0.0.1"]).unwrap_err().code, "executable_not_allowed");
        assert_eq!(reserve_for(&registry, second, "a-workspace", ping().to_str().unwrap(), &dir.join("missing"), 1000, &["-n", "1", "127.0.0.1"]).unwrap_err().code, "cwd_unavailable");
        // The genuine admitted invocation remains launchable by its permit holder; nothing above started a process.
        assert_eq!(status(&registry, second, &id)["state"], "admitted");
        fs::remove_dir_all(dir).ok();
    }

    // The admitted deadline is enforced by the Host alone, with no Engine call after launch.
    #[test]
    fn the_admitted_deadline_ends_the_process_with_no_engine_attached() {
        let (dir, registry) = registry("deadline", CustodyConfig::default());
        let epoch = attach(&registry);
        let admitted = reserve(&registry, epoch, "attempt-deadline", 1500);
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        launch(&registry, epoch, &id, admitted["permit"].as_str().unwrap()).unwrap();
        let ended = wait_for(&registry, epoch, &id, &["deadline_terminated"], Duration::from_secs(15));
        assert_eq!(ended["jobEmpty"].is_null(), true, "a terminal record no longer reports a live Job");
        assert_eq!(ended["terminationReason"], "The admitted process deadline elapsed.");
        fs::remove_dir_all(dir).ok();
    }

    // A permit gates the launch only. Expiry before launch starts nothing.
    #[test]
    fn an_expired_permit_never_starts_a_process() {
        let (dir, registry) = registry("permit", CustodyConfig { permit_ttl_ms: Some(1), ..CustodyConfig::default() });
        let epoch = attach(&registry);
        let admitted = reserve(&registry, epoch, "attempt-permit", 60_000);
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        thread::sleep(Duration::from_millis(30));
        assert_eq!(launch(&registry, epoch, &id, admitted["permit"].as_str().unwrap()).unwrap_err().code, "permit_expired");
        assert_eq!(status(&registry, epoch, &id)["state"], "permit_expired");
        fs::remove_dir_all(dir).ok();
    }

    // A spool that reaches its hard limit ends the invocation with an explicit state and never reports a complete capture.
    #[test]
    fn the_spool_hard_limit_is_an_explicit_failure() {
        let (dir, registry) = registry("spool", CustodyConfig { spool_limit_bytes: Some(64), ..CustodyConfig::default() });
        let epoch = attach(&registry);
        let admitted = reserve(&registry, epoch, "attempt-spool", 60_000);
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        launch(&registry, epoch, &id, admitted["permit"].as_str().unwrap()).unwrap();
        let ended = wait_for(&registry, epoch, &id, &["spool_limit_exceeded"], Duration::from_secs(20));
        assert_eq!(ended["spoolComplete"], json!(false));
        assert!(ended["stdoutDurable"].as_u64().unwrap() <= 64, "no byte beyond the limit was made durable");
        fs::remove_dir_all(dir).ok();
    }

    // The emergency credential stops the invocation without an Engine; a wrong credential stops nothing.
    #[test]
    fn the_emergency_credential_stops_without_any_engine() {
        let (dir, registry) = registry("emergency", CustodyConfig::default());
        let epoch = attach(&registry);
        let admitted = reserve(&registry, epoch, "attempt-emergency", 60_000);
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        let token = admitted["emergencyToken"].as_str().unwrap().to_string();
        launch(&registry, epoch, &id, admitted["permit"].as_str().unwrap()).unwrap();
        let refused = registry.dispatch("custody.emergency_stop", &json!({ "custodyId": id, "emergencyToken": "wrong" })).unwrap_err();
        assert_eq!(refused.code, "unauthorized");
        assert_eq!(status(&registry, epoch, &id)["state"], "running", "a refused emergency request stops nothing");
        let stopped = registry.dispatch("custody.emergency_stop", &json!({ "custodyId": id, "emergencyToken": token })).unwrap();
        assert_eq!(stopped["jobEmpty"], json!(true));
        wait_for(&registry, epoch, &id, &["emergency_stopped"], Duration::from_secs(10));
        fs::remove_dir_all(dir).ok();
    }

    // PC-26 (Host half): a junction swapped into the admitted workspace between admission and launch is refused before any
    // process is created. The admitted directory is replaced by a junction to another directory, as a stale alias would be.
    #[test]
    fn a_workspace_redirected_by_a_junction_after_admission_is_refused_before_any_spawn() {
        let (dir, registry) = registry("redirect", CustodyConfig::default());
        let epoch = attach(&registry);
        let workspace = dir.join("workspace");
        let elsewhere = dir.join("elsewhere");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        let admitted = reserve_for(&registry, epoch, "attempt-redirect", ping().to_str().unwrap(), &workspace, 60_000, &["-n", "30", "127.0.0.1"]).unwrap();
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        fs::remove_dir(&workspace).unwrap();
        let junction = std::process::Command::new("cmd").args(["/c", "mklink", "/J", workspace.to_str().unwrap(), elsewhere.to_str().unwrap()])
            .output().expect("mklink runs");
        assert!(junction.status.success(), "the junction could be created: {}", String::from_utf8_lossy(&junction.stderr));
        let refused = launch(&registry, epoch, &id, admitted["permit"].as_str().unwrap()).unwrap_err();
        assert_eq!(refused.code, "workspace_changed");
        let record = status(&registry, epoch, &id);
        assert_eq!(record["state"], "launch_failed");
        assert!(record["processId"].is_null(), "no process was ever created for the redirected workspace");
        fs::remove_dir(&workspace).ok();
        fs::remove_dir_all(dir).ok();
    }

    // An admission the Engine withdraws before launch can never become a process, even with its genuine permit.
    #[test]
    fn a_withdrawn_admission_never_launches_with_its_genuine_permit() {
        let (dir, registry) = registry("withdraw", CustodyConfig::default());
        let epoch = attach(&registry);
        let admitted = reserve(&registry, epoch, "attempt-withdraw", 60_000);
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        let withdrawn = registry.dispatch("custody.cancel", &json!({ "epoch": epoch, "generation": "gen-1", "custodyId": id })).unwrap();
        assert_eq!(withdrawn["state"], "admission_cancelled");
        let attempted = launch(&registry, epoch, &id, admitted["permit"].as_str().unwrap()).unwrap();
        assert_eq!(attempted["state"], "admission_cancelled", "the genuine permit reports the withdrawn record and starts nothing");
        assert!(attempted["processId"].is_null());
        fs::remove_dir_all(dir).ok();
    }

    // A spool that cannot be opened ends its CLI at once: the output cannot be kept, so the process must not run unobserved.
    #[test]
    fn a_spool_that_cannot_be_opened_ends_its_cli_and_is_recorded() {
        let (dir, registry) = registry("spoolfail", CustodyConfig::default());
        let epoch = attach(&registry);
        let admitted = reserve(&registry, epoch, "attempt-spoolfail", 60_000);
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        // A directory where the spool file must be makes the spool impossible to open.
        fs::create_dir_all(dir.join("custody").join("spool").join(&id).join("stdout.bin")).unwrap();
        launch(&registry, epoch, &id, admitted["permit"].as_str().unwrap()).unwrap();
        let ended = wait_for(&registry, epoch, &id, &["spool_failed"], Duration::from_secs(20));
        assert_eq!(ended["spoolComplete"], json!(false), "a failed spool is never a complete result");
        assert_eq!(ended["terminal"], json!(true));
        fs::remove_dir_all(dir).ok();
    }

    // The executable is verified again at launch: an allowlisted file changed after admission is refused before it runs.
    #[test]
    fn an_executable_changed_after_admission_is_refused_at_launch() {
        let source = ping();
        let copy = std::env::temp_dir().join(format!("deszo-custody-ping-{}.exe", Uuid::new_v4()));
        fs::copy(&source, &copy).unwrap();
        let (dir, registry) = registry_with_path("changed", copy.clone());
        let epoch = attach(&registry);
        let admitted = reserve_for(&registry, epoch, "attempt-changed", copy.to_str().unwrap(), &std::env::temp_dir(), 60_000,
            &["-n", "1", "127.0.0.1"]).unwrap();
        let id = admitted["custodyId"].as_str().unwrap().to_string();
        // Bytes appended to the admitted file change its digest; the file still runs, so only the digest check can refuse it.
        let mut bytes = fs::read(&copy).unwrap();
        bytes.extend_from_slice(b"changed-after-admission");
        fs::write(&copy, bytes).unwrap();
        let refused = launch(&registry, epoch, &id, admitted["permit"].as_str().unwrap()).unwrap_err();
        assert_eq!(refused.code, "executable_changed");
        assert_eq!(status(&registry, epoch, &id)["processId"], Value::Null, "no process was created");
        fs::remove_dir_all(dir).ok();
        fs::remove_file(copy).ok();
    }
}

// Generation fencing after a candidate activation: the Host advances the generation it serves, and the previous one is refused.
#[cfg(test)]
mod generation_tests {
    use super::*;

    #[test]
    fn a_new_lifecycle_generation_fences_the_previous_one() {
        let dir = std::env::temp_dir().join(format!("deszo-custody-gen-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let registry = CustodyRegistry::open(&dir, "gen-1", &CustodyConfig::default()).unwrap();
        registry.set_generation("gen-2");
        let stale = registry.dispatch("custody.attach", &json!({ "generation": "gen-1" })).unwrap_err();
        assert_eq!(stale.code, "stale_generation", "an Engine from the replaced generation cannot attach");
        let current = registry.dispatch("custody.attach", &json!({ "generation": "gen-2" })).unwrap();
        assert_eq!(current["generation"], "gen-2");
        fs::remove_dir_all(dir).ok();
    }
}
