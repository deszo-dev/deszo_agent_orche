//! Supervisor control channel and per-run containment (ADR-0002 sections 2 and 4).
//!
//! The runtime reaches this module only through a named pipe. Control requests carry the token given to that runtime
//! instance. A launch shim may only claim the Job of the run whose rendezvous its PID was bound to. Every run Job is a
//! child of the application Job, which stays the crash backstop. Escalation uses a monotonic clock that a wall-clock
//! change cannot extend.

use std::collections::HashMap;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{CloseHandle, DuplicateHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::JobObjects::{CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE};
use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

const RENDEZVOUS_WAIT: Duration = Duration::from_secs(10);
const PROVE_WAIT: Duration = Duration::from_secs(10);
const ESCALATION_TICK: Duration = Duration::from_millis(500);
const LINE_LIMIT: usize = 64 * 1024;
// winnt.h: the only Job right a shim receives. Declared here because windows-sys does not export it in the Job module.
const JOB_OBJECT_ASSIGN_PROCESS: u32 = 0x0001;

/// Exit code the escalation uses when the supervisor terminates a run Job.
pub const ESCALATION_EXIT: u32 = 2;
/// Exit code of a run Job terminated by an emergency Stop from the granted controller.
pub const EMERGENCY_EXIT: u32 = 3;
/// Exit code of a run Job terminated because the runtime stopped answering the supervisor.
pub const RUNTIME_LOST_EXIT: u32 = 4;
// A runtime that has not answered for this long is hung; its runs are stopped without waiting for it.
const RUNTIME_SILENCE: Duration = Duration::from_secs(15);

fn wide(text: &str) -> Vec<u16> { std::ffi::OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect() }

/// A kill-on-close Job. Dropping the last handle terminates any member the runtime did not stop.
pub struct Job(HANDLE);
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> Result<Job, String> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() { return Err("the run Job could not be created".into()); }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe { SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) };
        if ok == 0 { unsafe { CloseHandle(handle) }; return Err("the run Job could not be configured".into()); }
        Ok(Job(handle))
    }

    /// Active member count. Zero means no run member remains alive inside this Job.
    pub fn active_members(&self) -> Result<u32, String> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe { QueryInformationJobObject(self.0, JobObjectBasicAccountingInformation, &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, std::ptr::null_mut()) };
        if ok == 0 { Err("the run Job could not be queried".into()) } else { Ok(info.ActiveProcesses) }
    }

    pub fn terminate(&self, exit_code: u32) -> bool { unsafe { TerminateJobObject(self.0, exit_code) != 0 } }

    /// A non-inheritable handle that can only assign processes, duplicated into the shim whose PID is bound.
    fn assign_only_for(&self, process_id: u32) -> Result<usize, String> {
        let process = unsafe { OpenProcess(PROCESS_DUP_HANDLE, 0, process_id) };
        if process.is_null() { return Err("the shim process could not be opened".into()); }
        let mut duplicate: HANDLE = std::ptr::null_mut();
        let ok = unsafe { DuplicateHandle(GetCurrentProcess(), self.0, process, &mut duplicate, JOB_OBJECT_ASSIGN_PROCESS, 0, 0) };
        unsafe { CloseHandle(process) };
        if ok == 0 { Err("the Job handle could not be duplicated into the shim".into()) } else { Ok(duplicate as usize) }
    }
}

impl Drop for Job {
    fn drop(&mut self) { unsafe { CloseHandle(self.0) }; }
}

struct Run {
    job: Arc<Job>,
    armed: bool,
    observation: Duration,
    escalation: Duration,
    extension: Duration,
    last_heartbeat: Instant,
    escalated: bool,
    // The emergency credential is per run, issued with the arm, and works without the runtime (ADR-0002 section 4).
    emergency_token: String,
    emergency_stopped: bool,
    runtime_lost: bool,
}

struct Rendezvous {
    run_id: String,
    process_id: u32,
}

#[derive(Default)]
struct State {
    // The last moment the runtime answered; updated by its heartbeat, independent of any controller acknowledgement.
    runtime_seen: Option<Instant>,
    runs: HashMap<String, Run>,
    rendezvous: HashMap<String, Rendezvous>,
}

pub struct Supervisor {
    pub pipe_name: String,
    pub token: String,
    state: Arc<Mutex<State>>,
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), buffer.as_mut_ptr(), bytes as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status != 0 { return Err("the system random source is unavailable".into()); }
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl Supervisor {
    /// Starts the control pipe for one runtime instance. The name and token are passed to that runtime only.
    pub fn start() -> Result<Supervisor, String> {
        let pipe_name = format!(r"\\.\pipe\deszo-supervisor-{}", random_hex(8)?);
        let token = random_hex(32)?;
        let supervisor = Supervisor { pipe_name, token, state: Arc::new(Mutex::new(State { runtime_seen: Some(Instant::now()), ..State::default() })) };
        supervisor.serve();
        supervisor.escalate();
        Ok(supervisor)
    }

    fn serve(&self) {
        let name = self.pipe_name.clone();
        let token = self.token.clone();
        let state = Arc::clone(&self.state);
        thread::spawn(move || {
            // The first instance must be ours alone (FILE_FLAG_FIRST_PIPE_INSTANCE); remote clients are refused outright.
            let mut first = true;
            loop {
                let open_mode = PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
                first = false;
                let pipe = unsafe { CreateNamedPipeW(wide(&name).as_ptr(), open_mode,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, std::ptr::null()) };
                if pipe == INVALID_HANDLE_VALUE { thread::sleep(Duration::from_secs(1)); continue; }
                unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) };
                let (state, token) = (Arc::clone(&state), token.clone());
                // A raw handle is passed as its integer value so the thread owns it without a Send wrapper.
                let handle = pipe as usize;
                thread::spawn(move || {
                    connection(handle as HANDLE, &state, &token);
                    unsafe { DisconnectNamedPipe(handle as HANDLE); CloseHandle(handle as HANDLE); }
                });
            }
        });
    }

    // Stops a run whose runtime stopped responding, once the escalation deadline passes on this monotonic clock.
    fn escalate(&self) {
        let state = Arc::clone(&self.state);
        thread::spawn(move || loop {
            thread::sleep(ESCALATION_TICK);
            let mut guard = match state.lock() { Ok(guard) => guard, Err(poisoned) => poisoned.into_inner() };
            // Runtime liveness and controller attention are separate clocks. A silent runtime is a hard failure: stop now.
            let runtime_silent = guard.runtime_seen.map(|seen| seen.elapsed() > RUNTIME_SILENCE).unwrap_or(false);
            for run in guard.runs.values_mut() {
                if !run.armed || run.escalated { continue; }
                if runtime_silent {
                    run.escalated = true;
                    run.runtime_lost = true;
                    run.job.terminate(RUNTIME_LOST_EXIT);
                } else if run.last_heartbeat.elapsed() >= run.escalation + run.extension {
                    run.escalated = true;
                    run.job.terminate(ESCALATION_EXIT);
                }
            }
        });
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        // Every run Job closes with the supervisor; kill-on-close then removes any member still running.
        if let Ok(mut guard) = self.state.lock() { guard.runs.clear(); guard.rendezvous.clear(); }
    }
}

fn read_line(pipe: HANDLE, pending: &mut Vec<u8>) -> Option<String> {
    loop {
        if let Some(index) = pending.iter().position(|byte| *byte == b'\n') {
            let line = pending.drain(..=index).collect::<Vec<u8>>();
            return String::from_utf8(line[..line.len() - 1].to_vec()).ok();
        }
        if pending.len() > LINE_LIMIT { return None; }
        let mut chunk = [0u8; 4096];
        let mut read = 0u32;
        let ok = unsafe { ReadFile(pipe, chunk.as_mut_ptr(), chunk.len() as u32, &mut read, std::ptr::null_mut()) };
        if ok == 0 || read == 0 { return None; }
        pending.extend_from_slice(&chunk[..read as usize]);
    }
}

fn write_line(pipe: HANDLE, value: &Value) -> bool {
    let bytes = format!("{value}\n").into_bytes();
    let mut written = 0u32;
    let ok = unsafe { WriteFile(pipe, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut()) };
    ok != 0 && written as usize == bytes.len()
}

fn connection(pipe: HANDLE, state: &Arc<Mutex<State>>, token: &str) {
    let mut pending = Vec::new();
    while let Some(line) = read_line(pipe, &mut pending) {
        let request: Value = match serde_json::from_str(&line) { Ok(value) => value, Err(_) => break };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let reply = match request.get("op").and_then(Value::as_str) {
            Some("rendezvous") => rendezvous(pipe, state, &request),
            Some("result") => record_result(state, &request, pipe),
            Some(op) if op.starts_with("emergency_") => emergency(state, &request),
            _ if request.get("token").and_then(Value::as_str) == Some(token) => control(state, &request),
            _ => Err(("unauthorized".to_string(), "The supervisor request is not authorized.".to_string())),
        };
        let envelope = match reply {
            Ok(result) => json!({ "id": id, "result": result }),
            Err((code, message)) => json!({ "id": id, "error": { "code": code, "message": message } }),
        };
        if !write_line(pipe, &envelope) { break; }
    }
}

fn text(request: &Value, key: &str) -> Result<String, (String, String)> {
    request.get(key).and_then(Value::as_str).map(str::to_string).ok_or_else(|| ("invalid_request".into(), format!("{key} is required.")))
}

fn number(request: &Value, key: &str) -> Result<u64, (String, String)> {
    request.get(key).and_then(Value::as_u64).ok_or_else(|| ("invalid_request".into(), format!("{key} must be a nonnegative integer.")))
}

fn ensure_run(state: &mut State, run_id: &str) -> Result<(), (String, String)> {
    if !state.runs.contains_key(run_id) {
        let job = Job::new().map_err(|message| ("supervisor_error".to_string(), message))?;
        let emergency_token = random_hex(32).map_err(|message| ("supervisor_error".to_string(), message))?;
        state.runs.insert(run_id.to_string(), Run { job: Arc::new(job), armed: false, observation: Duration::ZERO, escalation: Duration::ZERO,
            extension: Duration::ZERO, last_heartbeat: Instant::now(), escalated: false, emergency_token, emergency_stopped: false, runtime_lost: false });
    }
    Ok(())
}

// Waits, bounded, until the Job reports no members; returns the last count.
fn drain(job: &Job) -> Result<u32, String> {
    let deadline = Instant::now() + PROVE_WAIT;
    loop {
        let active = job.active_members()?;
        if active == 0 || Instant::now() >= deadline { return Ok(active); }
        thread::sleep(Duration::from_millis(50));
    }
}

// Emergency operations authenticate with the run's emergency credential only. They stop the run without the runtime
// and read its containment, so a hung runtime or a silent controller cannot block them.
fn emergency(state: &Arc<Mutex<State>>, request: &Value) -> Result<Value, (String, String)> {
    let run_id = text(request, "runId")?;
    let token = text(request, "token")?;
    let op = text(request, "op")?;
    let job = {
        let mut guard = state.lock().map_err(|_| ("supervisor_error".to_string(), "The supervisor state is unavailable.".to_string()))?;
        let run = guard.runs.get_mut(&run_id).ok_or(("not_found".to_string(), "No run has that identity.".to_string()))?;
        if run.emergency_token != token { return Err(("unauthorized".into(), "The emergency credential does not match this run.".into())); }
        if op == "emergency_stop" { run.emergency_stopped = true; }
        Arc::clone(&run.job)
    };
    match op.as_str() {
        "emergency_stop" => {
            job.terminate(EMERGENCY_EXIT);
            Ok(json!({ "stopped": true, "remainingMembers": drain(&job).map_err(|message| ("supervisor_error".to_string(), message))? }))
        }
        "emergency_status" => Ok(json!({ "remainingMembers": job.active_members().ok() })),
        other => Err(("unsupported".into(), format!("The supervisor does not implement {other}."))),
    }
}

fn control(state: &Arc<Mutex<State>>, request: &Value) -> Result<Value, (String, String)> {
    let mut guard = state.lock().map_err(|_| ("supervisor_error".to_string(), "The supervisor state is unavailable.".to_string()))?;
    let op = text(request, "op")?;
    if op == "runtime_alive" {
        guard.runtime_seen = Some(Instant::now());
        return Ok(json!({ "alive": true }));
    }
    let run_id = text(request, "runId")?;
    match op.as_str() {
        "arm" => {
            let observation = Duration::from_millis(number(request, "observationDeadlineMs")?);
            let escalation = Duration::from_millis(number(request, "escalationDeadlineMs")?);
            if escalation <= observation { return Err(("invalid_request".into(), "The escalation deadline must be longer than the observation deadline.".into())); }
            ensure_run(&mut guard, &run_id)?;
            let run = guard.runs.get_mut(&run_id).expect("run present");
            run.armed = true; run.observation = observation; run.escalation = escalation; run.last_heartbeat = Instant::now(); run.escalated = false;
            // Returned once, to the runtime that armed the run; the runtime hands it to the granted controller only.
            Ok(json!({ "armed": true, "escalationDeadlineMs": escalation.as_millis() as u64, "emergencyToken": run.emergency_token.clone() }))
        }
        "disarm" => {
            if let Some(run) = guard.runs.get_mut(&run_id) { run.armed = false; }
            Ok(json!({ "armed": false }))
        }
        "heartbeat" => {
            let run = guard.runs.get_mut(&run_id).ok_or(("not_found".to_string(), "No armed run has that identity.".to_string()))?;
            run.last_heartbeat = Instant::now();
            Ok(json!({ "heartbeat": true }))
        }
        // A first-party extension of the escalation deadline. The runtime reports success only after this confirms it.
        "extend" => {
            let extension = Duration::from_millis(number(request, "extensionMs")?);
            let run = guard.runs.get_mut(&run_id).ok_or(("not_found".to_string(), "No armed run has that identity.".to_string()))?;
            run.extension += extension;
            Ok(json!({ "extendedByMs": extension.as_millis() as u64, "escalationInMs": (run.escalation + run.extension).saturating_sub(run.last_heartbeat.elapsed()).as_millis() as u64 }))
        }
        "bind_shim" => {
            let rendezvous_id = text(request, "rendezvousId")?;
            let process_id = number(request, "pid")? as u32;
            ensure_run(&mut guard, &run_id)?;
            guard.rendezvous.insert(rendezvous_id, Rendezvous { run_id: run_id.clone(), process_id });
            Ok(json!({ "bound": true }))
        }
        // Terminates the run Job and waits for zero members. Only zero members is a containment proof.
        "prove_stopped" => {
            // An unknown run (never bound, released, or from before a restart) is not a proof: report it as unknown, never zero.
            let Some(run) = guard.runs.get(&run_id) else { return Ok(json!({ "remainingMembers": null, "known": false })); };
            let job = Arc::clone(&run.job);
            drop(guard);
            job.terminate(1);
            Ok(json!({ "remainingMembers": drain(&job).map_err(|message| ("supervisor_error".to_string(), message))? }))
        }
        "release" => {
            if let Some(run) = guard.runs.get(&run_id) {
                if run.job.active_members().map_err(|message| ("supervisor_error".to_string(), message))? != 0 {
                    return Err(("members_remain".into(), "The run still has members; prove the Stop before releasing it.".into()));
                }
            }
            guard.runs.remove(&run_id);
            Ok(json!({ "released": true }))
        }
        "status" => {
            let run = guard.runs.get(&run_id).ok_or(("not_found".to_string(), "No run has that identity.".to_string()))?;
            Ok(json!({ "armed": run.armed, "escalated": run.escalated, "runtimeLost": run.runtime_lost, "heartbeatAgeMs": run.last_heartbeat.elapsed().as_millis() as u64,
                "observationExceeded": run.armed && run.last_heartbeat.elapsed() >= run.observation }))
        }
        other => Err(("unsupported".into(), format!("The supervisor does not implement {other}."))),
    }
}

// The shim waits here until its PID is bound and the Job handle is duplicated into it; containment precedes its resume.
fn rendezvous(pipe: HANDLE, state: &Arc<Mutex<State>>, request: &Value) -> Result<Value, (String, String)> {
    let rendezvous_id = text(request, "rendezvousId")?;
    let deadline = Instant::now() + RENDEZVOUS_WAIT;
    let (run_id, process_id) = loop {
        {
            let guard = state.lock().map_err(|_| ("supervisor_error".to_string(), "The supervisor state is unavailable.".to_string()))?;
            if let Some(entry) = guard.rendezvous.get(&rendezvous_id) { break (entry.run_id.clone(), entry.process_id); }
        }
        if Instant::now() >= deadline { return Err(("not_bound".into(), "The rendezvous was not bound in time.".into())); }
        thread::sleep(Duration::from_millis(25));
    };
    let mut client: u32 = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut client) } == 0 || client != process_id {
        return Err(("unauthorized".into(), "The rendezvous client is not the bound shim.".into()));
    }
    let guard = state.lock().map_err(|_| ("supervisor_error".to_string(), "The supervisor state is unavailable.".to_string()))?;
    let run = guard.runs.get(&run_id).ok_or(("not_found".to_string(), "The run Job is gone.".to_string()))?;
    let handle = run.job.assign_only_for(process_id).map_err(|message| ("supervisor_error".to_string(), message))?;
    Ok(json!({ "jobHandle": handle as u64 }))
}

// A shim's result is accepted only from the PID bound to its rendezvous, and the rendezvous is spent once it is recorded.
fn record_result(state: &Arc<Mutex<State>>, request: &Value, pipe: HANDLE) -> Result<Value, (String, String)> {
    let rendezvous_id = text(request, "rendezvousId")?;
    let code = request.get("exitCode").and_then(Value::as_i64).ok_or(("invalid_request".to_string(), "exitCode is required.".to_string()))? as i32;
    let mut guard = state.lock().map_err(|_| ("supervisor_error".to_string(), "The supervisor state is unavailable.".to_string()))?;
    let bound = guard.rendezvous.get(&rendezvous_id).map(|entry| entry.process_id).ok_or(("not_found".to_string(), "No rendezvous has that identity.".to_string()))?;
    let mut client: u32 = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut client) } == 0 || client != bound {
        return Err(("unauthorized".into(), "The result did not come from the bound shim.".into()));
    }
    guard.rendezvous.remove(&rendezvous_id);
    Ok(json!({ "recorded": true, "exitCode": code }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_reports_no_members_when_it_is_empty_and_terminates_cleanly() {
        let job = Job::new().expect("job");
        assert_eq!(job.active_members().expect("query"), 0);
        assert!(job.terminate(1));
        assert_eq!(job.active_members().expect("query"), 0);
    }

    #[test]
    fn control_requests_arm_extend_and_release_a_run() {
        let state = Arc::new(Mutex::new(State::default()));
        let arm = json!({ "op": "arm", "runId": "run-1", "observationDeadlineMs": 1000, "escalationDeadlineMs": 5000 });
        assert_eq!(control(&state, &arm).expect("arm")["armed"], json!(true));
        assert!(control(&state, &json!({ "op": "arm", "runId": "run-2", "observationDeadlineMs": 5000, "escalationDeadlineMs": 1000 })).is_err());
        assert_eq!(control(&state, &json!({ "op": "status", "runId": "run-1" })).expect("status")["escalated"], json!(false));
        assert!(control(&state, &json!({ "op": "extend", "runId": "run-1", "extensionMs": 2000 })).is_ok());
        assert_eq!(control(&state, &json!({ "op": "prove_stopped", "runId": "run-1" })).expect("prove")["remainingMembers"], json!(0));
        assert!(control(&state, &json!({ "op": "release", "runId": "run-1" })).is_ok());
        assert!(control(&state, &json!({ "op": "status", "runId": "run-1" })).is_err());
    }

    #[test]
    fn an_emergency_stop_needs_the_run_credential_and_drains_the_run() {
        let state = Arc::new(Mutex::new(State::default()));
        let armed = control(&state, &json!({ "op": "arm", "runId": "run-e", "observationDeadlineMs": 1000, "escalationDeadlineMs": 5000 })).expect("arm");
        let token = armed["emergencyToken"].as_str().expect("the arm returns the emergency credential").to_string();
        assert_eq!(token.len(), 64);
        let refused = emergency(&state, &json!({ "op": "emergency_stop", "runId": "run-e", "token": "not-the-credential" }));
        assert_eq!(refused.expect_err("a wrong credential is refused").0, "unauthorized");
        assert!(!state.lock().expect("state").runs["run-e"].emergency_stopped, "a refused request stops nothing");
        let stopped = emergency(&state, &json!({ "op": "emergency_stop", "runId": "run-e", "token": token })).expect("stop");
        assert_eq!(stopped["remainingMembers"], json!(0));
        assert!(state.lock().expect("state").runs["run-e"].emergency_stopped);
    }

    // The end-to-end contract: the shim asks for the Job over the pipe, the CLI runs inside it, and a proof of stop
    // terminates the Job and reports zero remaining members. A failure here means containment is not real.
    #[test]
    fn the_shim_runs_its_command_inside_the_run_job_and_a_proof_of_stop_drains_it() {
        let supervisor = Supervisor::start().expect("supervisor");
        let exe = std::env::current_exe().expect("test executable");
        let shim = exe.parent().and_then(|deps| deps.parent()).expect("target directory").join("deszo-launch-shim.exe");
        assert!(shim.is_file(), "the shim must be built alongside the tests: {}", shim.display());
        let rendezvous = format!("rendezvous-{}", random_hex(6).expect("random"));
        let mut child = std::process::Command::new(&shim)
            .args(["--pipe", &supervisor.pipe_name, "--rendezvous", &rendezvous, "--", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("shim");
        control(&supervisor.state, &json!({ "op": "bind_shim", "runId": "run-test", "rendezvousId": rendezvous, "pid": child.id() })).expect("bind");
        // Wait for the CLI to be created, assigned and resumed.
        let deadline = Instant::now() + Duration::from_secs(10);
        let members = loop {
            let active = supervisor.state.lock().expect("state").runs.get("run-test").map(|run| run.job.active_members());
            match active {
                Some(Ok(count)) if count > 0 => break count,
                _ if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                _ => panic!("the CLI never ran inside the run Job"),
            }
        };
        assert!(members >= 1, "the CLI is a member of the run Job");
        let proof = control(&supervisor.state, &json!({ "op": "prove_stopped", "runId": "run-test" })).expect("prove");
        assert_eq!(proof["remainingMembers"], json!(0), "a proof of stop reports zero members");
        let status = child.wait().expect("shim exit");
        assert_eq!(status.code(), Some(1), "the shim returns the CLI's exit code, which the Job termination set to 1");
    }

    // The runtime's heartbeat is its own clock: it does not depend on any controller acknowledgement.
    #[test]
    fn the_runtime_heartbeat_is_recorded_independently_of_the_controller() {
        let state = Arc::new(Mutex::new(State::default()));
        assert_eq!(control(&state, &json!({ "op": "runtime_alive" })).expect("alive")["alive"], json!(true));
        assert!(state.lock().expect("state").runtime_seen.is_some());
    }

    #[test]
    fn a_random_token_is_hex_of_the_requested_length() {
        let token = random_hex(32).expect("random");
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(token, random_hex(32).expect("random"));
    }
}
