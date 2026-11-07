//! P6-G0 Engine-only switch (ADR-0010 sections 5-8, reduced to the G0 contract). One installed Shell stays fixed while the
//! selected Engine changes. Staging never touches the selector. A switch fences Custody, proves zero active jobs, stops the
//! managed Engine tree, takes Host-owned no-write guards on the production SQLite file set, runs the candidate's maintenance
//! preflight against a disposable copy, and commits the candidate with one atomic selector write. Every phase is persisted
//! before its effect; a restarted Host reconciles the same operation from its durable record or holds.

use super::*;

pub(super) const PHASE_STAGING: &str = "staging";
pub(super) const PHASE_STAGED: &str = "staged";
pub(super) const PHASE_FENCED: &str = "fenced";
pub(super) const PHASE_A_STOPPED: &str = "a_stopped";
pub(super) const PHASE_GUARDED: &str = "guarded";
pub(super) const PHASE_PREFLIGHT_RUNNING: &str = "preflight_running";
pub(super) const PHASE_PREFLIGHT_PASSED: &str = "preflight_passed";
pub(super) const PHASE_COMMITTING: &str = "committing";
pub(super) const PHASE_COMMITTED: &str = "committed";
pub(super) const PHASE_VERIFIED: &str = "verified";
pub(super) const PHASE_FALLBACK: &str = "fallback_a";
pub(super) const PHASE_ROLLED_BACK: &str = "rolled_back";
pub(super) const PHASE_ABANDONED: &str = "abandoned";
pub(super) const PHASE_HELD: &str = "held";

const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(120);

/// The one nonterminal P6 operation of an installation: a staged Engine and, once started, its switch.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct EngineOperation {
    pub operation_id: String,
    pub request_fingerprint: String,
    pub from_build_id: String,
    pub to_build_id: String,
    pub package_sha256: String,
    pub shell_build_id: String,
    pub previous_generation: String,
    pub candidate_generation: String,
    pub phase: String,
    #[serde(default)]
    pub failure: Option<String>,
    #[serde(default)]
    pub fallback_attempted: bool,
    /// The production Store file identities and the disposable copy's identities, recorded when the guards were taken.
    #[serde(default)]
    pub store_evidence: Option<serde_json::Value>,
    /// The candidate's maintenance facts, bound by the Host to the exact candidate process.
    #[serde(default)]
    pub preflight: Option<serde_json::Value>,
    #[serde(default)]
    pub receipt: Option<serde_json::Value>,
    /// Set when the Host could not prove the managed Engine tree ended. The hold names that process instance (C09).
    #[serde(default)]
    pub termination_unproven: Option<UnprovenTermination>,
    /// The phase that a hold interrupted. A hold after the previous Engine stopped, before any candidate ran, may restart it (M5).
    #[serde(default)]
    pub held_from: Option<String>,
    /// The managed Engine process the fence was taken to stop, recorded with the fence before any stop starts. A restart mid-stop proves it ended (C09).
    #[serde(default)]
    pub stopping: Option<StoppingInstance>,
}

/// The managed Engine tree a fenced switch is stopping: the root process and every process its Job held when the fence was taken, each
/// with its creation time, so a reused identifier is never mistaken for it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoppingInstance {
    pub process_id: u32,
    #[serde(default)]
    pub process_creation_time: Option<u64>,
    /// The Job's members at the fence. A restart mid-stop proves each one ended before it may start the previous Engine (C09).
    #[serde(default)]
    pub members: Vec<UnprovenMember>,
    /// False when the Job's membership could not be read at the fence: a restart then holds rather than guessing.
    #[serde(default)]
    pub members_known: bool,
}

/// The managed Engine process instance a switch could not prove ended, with the reason the Host recorded.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct UnprovenTermination {
    pub process_id: u32,
    #[serde(default)]
    pub process_creation_time: Option<u64>,
    pub build_id: String,
    pub generation: String,
    pub reason: String,
    /// True when the debug-only seam, not the Job's own answer, withheld the proof.
    pub injected: bool,
    /// Every process the Job held at the unproven verdict. The proof covers each of them (H1).
    #[serde(default)]
    pub members: Vec<UnprovenMember>,
    /// False when the Job's membership could not be read: an unknown membership is never proof.
    #[serde(default)]
    pub members_known: bool,
}

/// One process the Job held at the unproven verdict, with its creation time so a reused identifier is never mistaken for it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct UnprovenMember {
    pub process_id: u32,
    #[serde(default)]
    pub process_creation_time: Option<u64>,
}

impl EngineOperation {
    pub(super) fn terminal(&self) -> bool {
        matches!(self.phase.as_str(), PHASE_VERIFIED | PHASE_ROLLED_BACK | PHASE_ABANDONED)
    }

    /// True while the Host is changing or holding the managed Engine. Its exit is then part of the switch, not a crash to relaunch,
    /// and the Host stays up to hold it. Staging copies a package beside the running Engine and never touches it; a staged, verified,
    /// rolled-back or abandoned operation changes nothing and blocks nothing.
    pub(super) fn in_flight(&self) -> bool {
        matches!(self.phase.as_str(), PHASE_FENCED | PHASE_A_STOPPED | PHASE_GUARDED | PHASE_PREFLIGHT_RUNNING
            | PHASE_PREFLIGHT_PASSED | PHASE_COMMITTING | PHASE_COMMITTED | PHASE_FALLBACK | PHASE_HELD)
    }
}

/// A refusal with the stable machine code the Engine acts on. Plain strings convert as `engine_switch_refused`.
#[derive(Debug)]
pub(super) struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure { code: "engine_switch_refused", message }
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Failure { code: "engine_switch_refused", message: message.into() }
    }
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure { code, message: message.into() }
}

pub(super) fn failure_response(failure: Failure) -> Response {
    Response { ok: false, result: None, error: Some(failure.message), code: Some(failure.code.into()) }
}

struct Request {
    operation_id: String,
    from: String,
    to: String,
    package_sha256: String,
    shell_build_id: String,
    generation: String,
}

fn text<'a>(payload: &'a serde_json::Value, name: &str) -> Result<&'a str, Failure> {
    payload.get(name).and_then(serde_json::Value::as_str).ok_or_else(|| fail("invalid_request", format!("{name} is required")))
}

fn parse_request(payload: &serde_json::Value) -> Result<Request, Failure> {
    let operation_id = text(payload, "operationId")?.to_string();
    Uuid::parse_str(&operation_id).map_err(|_| fail("invalid_request", "operationId must be a UUID"))?;
    let from = text(payload, "fromEngineBuildId")?.to_string();
    let to = text(payload, "toEngineBuildId")?.to_string();
    let package_sha256 = text(payload, "packageSha256")?.to_string();
    let shell_build_id = text(payload, "shellBuildId")?.to_string();
    let generation = text(payload, "generation")?.to_string();
    validate_id(&from)?;
    validate_id(&to)?;
    validate_id(&shell_build_id)?;
    if from == to {
        return Err(fail("invalid_request", "the target Engine identity must differ from the active one"));
    }
    if !valid_lower_hex(&package_sha256, 64) {
        return Err(fail("invalid_request", "packageSha256 must be a lowercase SHA-256 digest"));
    }
    Ok(Request { operation_id, from, to, package_sha256, shell_build_id, generation })
}

fn p6_shell(shared: &Shared) -> Result<ShellRelease, Failure> {
    shared.shell.clone().ok_or_else(|| fail("p6_unavailable", "This installation is not a P6 installation; Engine switching is unavailable."))
}

fn status_value(operation: &EngineOperation) -> serde_json::Value {
    serde_json::json!({
        "operationId": operation.operation_id,
        "phase": operation.phase,
        "fromEngineBuildId": operation.from_build_id,
        "toEngineBuildId": operation.to_build_id,
        "packageSha256": operation.package_sha256,
        "shellBuildId": operation.shell_build_id,
        "previousGeneration": operation.previous_generation,
        "candidateGeneration": operation.candidate_generation,
        "fallbackAttempted": operation.fallback_attempted,
        "failure": operation.failure,
        "preflight": operation.preflight,
        "receipt": operation.receipt,
        "terminationUnproven": operation.termination_unproven,
    })
}

fn same_identity(operation: &EngineOperation, request: &Request) -> bool {
    operation.operation_id == request.operation_id && operation.from_build_id == request.from && operation.to_build_id == request.to
        && operation.package_sha256 == request.package_sha256 && operation.shell_build_id == request.shell_build_id
}

fn mutate_operation(shared: &Shared, operation_id: &str, change: impl FnOnce(&mut EngineOperation)) -> Result<(), String> {
    let mut state = shared.state.lock().map_err(poison)?;
    let operation = state.durable.engine_operation.as_mut().filter(|op| op.operation_id == operation_id)
        .ok_or("the Engine operation record disappeared")?;
    change(operation);
    persist_state(&shared.state_file, &state.durable)
}

fn set_phase(shared: &Shared, operation_id: &str, phase: &str) -> Result<(), String> {
    mutate_operation(shared, operation_id, |operation| operation.phase = phase.into())
}

/// Debug-only M1 seam: parks the switch worker at a named point until the test writes `resume-<point>`. It writes `reached-<point>` first,
/// so the test sequences its Host actions against the worker's position. The wait is bounded so a failed test cannot hang the Host.
fn barrier(shared: &Shared, point: &str) {
    let Some(directory) = shared.config.test_switch_barrier_dir.as_deref() else { return };
    let reached = std::path::Path::new(directory).join(format!("reached-{point}"));
    let resume = std::path::Path::new(directory).join(format!("resume-{point}"));
    let _ = fs::write(&reached, b"reached");
    let started = Instant::now();
    while !resume.exists() && started.elapsed() < Duration::from_secs(120) {
        thread::sleep(Duration::from_millis(20));
    }
    let _ = log_event(shared, "test_switch_barrier", serde_json::json!({ "point": point, "released": resume.exists() }));
}

/// Deliberate crash points for native recovery tests. Only a debug Host honours them (validated at start).
fn crash_point(shared: &Shared, name: &str) {
    if shared.config.test_switch_crash_at.as_deref() == Some(name) {
        let _ = log_event(shared, "test_switch_crash_point", serde_json::json!({ "point": name }));
        std::process::exit(86);
    }
}

fn operation_directory(shared: &Shared, operation_id: &str) -> PathBuf {
    shared.host_dir.join("p6").join(operation_id)
}

pub(super) fn verify_engine_package(root: &Path, expected_id: &str, shell: &ShellRelease, expected_digest: &str) -> Result<BuildManifest, Failure> {
    let manifest = verify_build(root, expected_id)?;
    if manifest.bootstrap != "engine" {
        return Err(fail("engine_package_invalid", "the package is not an Engine package"));
    }
    verify_engine_binding(root, shell, &manifest)?;
    if !digest_eq(&candidate_digest(root)?, expected_digest) {
        return Err(fail("engine_package_digest_mismatch", "the Engine package does not match the requested digest"));
    }
    Ok(manifest)
}

/// Stages the exact Engine package beneath the installation while the active Engine keeps running. Idempotent for the same
/// operation; a different package under the same identity is refused.
/// Abandons a stage that failed after its intent was durable: the partial package is removed and the record is terminal, so a different
/// operation can stage. The failure is recorded and logged; the caller returns the stage's own refusal.
fn abandon_stage(shared: &Shared, operation_id: &str, message: &str, installed: &Path, already_installed: bool) {
    let incoming = shared.installation_root.join("versions").join(format!(".incoming-{operation_id}"));
    if incoming.exists() {
        let _ = fs::remove_dir_all(&incoming);
    }
    if !already_installed && installed.exists() {
        let _ = fs::remove_dir_all(installed);
    }
    let _ = mutate_operation(shared, operation_id, |operation| {
        operation.phase = PHASE_ABANDONED.into();
        operation.failure = Some(format!("The stage was abandoned before any switch: {message}"));
    });
    let _ = log_event(shared, "engine_stage_abandoned", serde_json::json!({ "operationId": operation_id, "message": message }));
}

pub(super) fn stage(shared: &Arc<Shared>, payload: &serde_json::Value) -> Result<serde_json::Value, Failure> {
    let shell = p6_shell(shared)?;
    let request = parse_request(payload)?;
    if request.shell_build_id != shell.shell_build_id {
        return Err(fail("shell_mismatch", "the requested Shell identity is not the installed Shell"));
    }
    // The identity of the operation, not the transient generation: a re-stage after a Host restart is the same operation.
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&serde_json::json!({ "operationId": request.operation_id,
        "fromEngineBuildId": request.from, "toEngineBuildId": request.to, "packageSha256": request.package_sha256,
        "shellBuildId": request.shell_build_id })).map_err(err)?));
    let _gate = shared.switch_gate.lock().map_err(poison)?;
    let mut superseded: Option<String> = None;
    let resuming = {
        let state = shared.state.lock().map_err(poison)?;
        if request.generation != state.durable.generation {
            return Err(fail("stale_generation", "the stage request belongs to a stale Engine generation"));
        }
        if request.from != state.durable.active_build_id {
            return Err(fail("stale_engine", "the stage request does not name the active Engine"));
        }
        match state.durable.engine_operation.as_ref() {
            Some(existing) if existing.operation_id == request.operation_id => {
                if existing.request_fingerprint != fingerprint {
                    return Err(fail("operation_replayed", "this operation identity was replayed with different content"));
                }
                if existing.phase != PHASE_STAGING {
                    return Ok(status_value(existing));
                }
                true
            }
            // A stage that never switched holds nothing, so this stage supersedes it (N2). A switch in progress or a hold is refused.
            Some(existing) if !existing.terminal() && matches!(existing.phase.as_str(), PHASE_STAGING | PHASE_STAGED) => {
                superseded = Some(existing.operation_id.clone());
                false
            }
            Some(existing) if !existing.terminal() => {
                return Err(fail("another_engine_operation_active", "another Engine operation is active; the stage is refused"));
            }
            _ => false,
        }
    };
    // The staged package is verified before any file or record is written.
    let staging_root = shared.staging_root.clone();
    let staged = fs::canonicalize(staging_root.join(&request.to)).map_err(err)?;
    if !staged.starts_with(&staging_root) {
        return Err(fail("invalid_request", "the staged Engine is outside the Host staging area"));
    }
    verify_engine_package(&staged, &request.to, &shell, &request.package_sha256)?;
    let installed = shared.installation_root.join("versions").join(&request.to);
    let already_installed = installed.exists();
    if already_installed {
        verify_engine_package(&installed, &request.to, &shell, &request.package_sha256).map_err(|_| {
            fail("engine_identity_conflict", "an installed Engine with this identity has different content")
        })?;
    }
    let candidate_generation = {
        let mut state = shared.state.lock().map_err(poison)?;
        let candidate_generation = if resuming {
            state.durable.engine_operation.as_ref().map(|op| op.candidate_generation.clone()).unwrap_or_default()
        } else {
            Uuid::new_v4().to_string()
        };
        if !resuming {
            // Stage intent is durable before the first byte is copied (G0-C01).
            state.durable.engine_operation = Some(EngineOperation {
                operation_id: request.operation_id.clone(), request_fingerprint: fingerprint.clone(),
                from_build_id: request.from.clone(), to_build_id: request.to.clone(), package_sha256: request.package_sha256.clone(),
                shell_build_id: request.shell_build_id.clone(), previous_generation: state.durable.generation.clone(),
                candidate_generation: candidate_generation.clone(), phase: PHASE_STAGING.into(), failure: None,
                fallback_attempted: false, store_evidence: None, preflight: None, receipt: None, termination_unproven: None, held_from: None,
                stopping: None,
            });
            persist_state(&shared.state_file, &state.durable).map_err(err)?;
        }
        candidate_generation
    };
    // The superseded stage is retired only now, once this stage's own checks have passed and its intent is durable (N2).
    if let Some(old) = superseded.as_deref() {
        let incoming = shared.installation_root.join("versions").join(format!(".incoming-{old}"));
        if incoming.exists() {
            let _ = fs::remove_dir_all(&incoming);
        }
        let _ = log_event(shared, "engine_stage_superseded", serde_json::json!({ "operationId": old, "by": request.operation_id }));
    }
    crash_point(shared, "after_stage_intent");
    // A copy that fails after the intent is durable abandons the stage, so one failed stage never wedges later switches.
    let copied = (|| -> Result<(), Failure> {
        if already_installed {
            return Ok(());
        }
        let incoming = shared.installation_root.join("versions").join(format!(".incoming-{}", request.operation_id));
        if incoming.exists() {
            fs::remove_dir_all(&incoming).map_err(err)?;
        }
        // C02: the debug-only crash point lands after the first real file, so the Host exits with a partial incoming directory.
        copy_tree_observed(&staged, &incoming, &mut || {
            crash_point(shared, "mid_stage_copy");
            Ok(())
        })?;
        if !digest_eq(&candidate_digest(&incoming)?, &request.package_sha256) {
            let _ = fs::remove_dir_all(&incoming);
            return Err(fail("engine_package_digest_mismatch", "the staged Engine changed during the copy"));
        }
        fs::rename(&incoming, &installed).map_err(err)?;
        verify_engine_package(&installed, &request.to, &shell, &request.package_sha256)?;
        Ok(())
    })();
    if let Err(failure) = copied {
        abandon_stage(shared, &request.operation_id, &failure.message, &installed, already_installed);
        return Err(failure);
    }
    crash_point(shared, "after_stage_copy");
    let mut state = shared.state.lock().map_err(poison)?;
    let operation = state.durable.engine_operation.as_mut().ok_or("the Engine operation record disappeared")?;
    operation.phase = PHASE_STAGED.into();
    let snapshot = status_value(operation);
    persist_state(&shared.state_file, &state.durable).map_err(err)?;
    drop(state);
    crash_point(shared, "after_stage_record");
    log_event(shared, "engine_staged", serde_json::json!({ "operationId": request.operation_id, "engineBuildId": request.to,
        "packageSha256": request.package_sha256, "candidateGeneration": candidate_generation }))?;
    Ok(snapshot)
}

/// Debug-only C09/B3 seam: holds the fence window open for a bounded time, so a racing Custody admission can be observed.
fn fence_window_pause(shared: &Shared) {
    if cfg!(debug_assertions) {
        if let Some(millis) = shared.config.test_switch_fence_pause_ms {
            thread::sleep(Duration::from_millis(millis));
        }
    }
}

/// Undoes a fence before its worker starts: the operation returns to staged and Custody admits again (L-2). The refusal is returned.
fn abort_fence(shared: &Shared, operation_id: &str, failure: Failure) -> Failure {
    let _ = mutate_operation(shared, operation_id, |operation| {
        operation.phase = PHASE_STAGED.into();
        operation.stopping = None;
    });
    if let Some(custody) = shared.custody.as_ref() {
        let _ = custody.set_fenced(false);
    }
    failure
}

/// Accepts one switch for a staged Engine. The Custody fence and the zero-job proof happen before this returns, so an
/// accepted request has no admitted Custody work left to race. The Engine stop and the Store boundary run afterwards.
pub(super) fn switch(shared: &Arc<Shared>, payload: &serde_json::Value) -> Result<serde_json::Value, Failure> {
    let shell = p6_shell(shared)?;
    let request = parse_request(payload)?;
    if request.shell_build_id != shell.shell_build_id {
        return Err(fail("shell_mismatch", "the requested Shell identity is not the installed Shell"));
    }
    let _gate = shared.switch_gate.lock().map_err(poison)?;
    let (operation, active_build, active_digest, generation) = {
        let state = shared.state.lock().map_err(poison)?;
        let operation = state.durable.engine_operation.clone().ok_or_else(|| fail("engine_not_staged", "no Engine is staged for this switch"))?;
        (operation, state.durable.active_build_id.clone(), state.durable.active_digest.clone(), state.durable.generation.clone())
    };
    if operation.operation_id != request.operation_id || !same_identity(&operation, &request) {
        return Err(fail("switch_identity_mismatch", "the switch does not match the staged Engine operation"));
    }
    if operation.phase != PHASE_STAGED {
        // A repeated request returns the recorded outcome and starts nothing.
        // Only an operation still stopping this Engine accepts a repeated request. A committed or verified operation has nothing left
        // to stop: its repeated request returns the recorded outcome and does not keep the caller quiesced (C13).
        let started = matches!(operation.phase.as_str(), PHASE_FENCED | PHASE_A_STOPPED | PHASE_GUARDED | PHASE_PREFLIGHT_RUNNING
            | PHASE_PREFLIGHT_PASSED | PHASE_COMMITTING);
        let mut value = status_value(&operation);
        value["accepted"] = serde_json::json!(started);
        value["duplicate"] = serde_json::json!(true);
        return Ok(value);
    }
    if request.from != active_build || request.generation != generation {
        return Err(fail("stale_engine", "the switch does not name the active Engine generation"));
    }
    let shell_manifest_root = shared.installation_root.join("versions");
    verify_engine_package(&shell_manifest_root.join(&request.to), &request.to, &shell, &request.package_sha256)?;
    let active_root = shell_manifest_root.join(&active_build);
    if !digest_eq(&candidate_digest(&active_root)?, &active_digest) {
        return Err(fail("active_package_changed", "the active Engine package changed outside the Host"));
    }
    // Fence and zero-job proof, serialized by the registry lock that also admits Custody work.
    if let Some(custody) = shared.custody.as_ref() {
        custody.set_fenced(true).map_err(Failure::from)?;
        log_event(shared, "engine_switch_fence_window", serde_json::json!({ "operationId": request.operation_id }))
            .map_err(|message| abort_fence(shared, &request.operation_id, fail("engine_switch_refused", message)))?;
        fence_window_pause(shared);
        let active = custody.active_job_count().map_err(|error| abort_fence(shared, &request.operation_id, Failure::from(error)))?;
        if active > 0 {
            custody.set_fenced(false).map_err(Failure::from)?;
            return Err(fail("custody_jobs_active", format!("{active} Custody invocation(s) still hold the Engine; the switch is not accepted")));
        }
    }
    // The managed Engine tree is recorded in the same locked write that persists FENCED. The run loop leaves an in-flight switch alone, so it
    // cannot reap the tree between this snapshot and the fence (C09). A switch with no managed Engine to stop is refused and unfenced.
    {
        let mut state = shared.state.lock().map_err(poison)?;
        let Some(managed) = state.managed.as_ref() else {
            drop(state);
            return Err(abort_fence(shared, &request.operation_id, fail("engine_not_running", "no managed Engine is running to switch from")));
        };
        let stopping = stopping_of(managed);
        let Some(operation) = state.durable.engine_operation.as_mut() else {
            drop(state);
            return Err(abort_fence(shared, &request.operation_id, fail("engine_switch_refused", "the Engine operation record disappeared")));
        };
        operation.phase = PHASE_FENCED.into();
        operation.stopping = Some(stopping);
        if let Err(message) = persist_state(&shared.state_file, &state.durable) {
            drop(state);
            return Err(abort_fence(shared, &request.operation_id, fail("engine_switch_refused", message)));
        }
    }
    crash_point(shared, "after_fenced");
    log_event(shared, "engine_switch_accepted", serde_json::json!({ "operationId": request.operation_id,
        "fromEngineBuildId": request.from, "toEngineBuildId": request.to, "generation": generation }))
        .map_err(|message| abort_fence(shared, &request.operation_id, fail("engine_switch_refused", message)))?;
    let inner = Arc::clone(shared);
    let operation_id = request.operation_id.clone();
    if let Err(error) = thread::Builder::new().name("deszo-engine-switch".into()).spawn(move || run_switch(&inner, &operation_id)) {
        // No worker means no switch: the operation returns to staged and the fence lifts before the refusal is returned (L1).
        return Err(abort_fence(shared, &request.operation_id, fail("switch_worker_unavailable", format!("the switch worker could not start: {error}"))));
    }
    let state = shared.state.lock().map_err(poison)?;
    let operation = state.durable.engine_operation.clone().ok_or("the Engine operation record disappeared")?;
    let mut value = status_value(&operation);
    value["accepted"] = serde_json::json!(true);
    value["duplicate"] = serde_json::json!(false);
    Ok(value)
}

pub(super) fn status(shared: &Arc<Shared>, payload: &serde_json::Value) -> Result<serde_json::Value, Failure> {
    let operation_id = text(payload, "operationId")?;
    let state = shared.state.lock().map_err(poison)?;
    match state.durable.engine_operation.as_ref().filter(|op| op.operation_id == operation_id) {
        Some(operation) => Ok(status_value(operation)),
        None => Err(fail("not_found", "no Engine operation has that identity")),
    }
}

/// Candidate process → Host: its maintenance preflight is complete on the disposable copy. Every fact that the Host can check
/// itself (process parentage, identities, the copy's digest) is checked here, and the candidate's claims are never trusted alone.
pub(super) fn maintenance_ready(shared: &Arc<Shared>, payload: &serde_json::Value) -> Result<serde_json::Value, Failure> {
    let operation_id = text(payload, "operationId")?.to_string();
    let pid = payload.get("pid").and_then(serde_json::Value::as_u64).and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| fail("invalid_request", "pid is required"))?;
    let application_pid = payload.get("applicationPid").and_then(serde_json::Value::as_u64).and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| fail("invalid_request", "applicationPid is required"))?;
    let engine_build_id = text(payload, "engineBuildId")?.to_string();
    let shell_build_id = text(payload, "shellBuildId")?.to_string();
    let generation = text(payload, "generation")?.to_string();
    let copy_sha256 = text(payload, "copySha256")?.to_string();
    let shell = p6_shell(shared)?;
    let mut state = shared.state.lock().map_err(poison)?;
    let operation = state.durable.engine_operation.clone().ok_or_else(|| fail("not_found", "no Engine operation is active"))?;
    if operation.operation_id != operation_id || operation.phase != PHASE_PREFLIGHT_RUNNING {
        return Err(fail("preflight_refused", "the maintenance result does not belong to the running preflight"));
    }
    let managed = state.managed.as_mut().ok_or_else(|| fail("preflight_refused", "no candidate process is running"))?;
    if managed.child.id() != application_pid || managed.build_id != operation.to_build_id || managed.generation != operation.candidate_generation
        || managed.bootstrap != "engine" || engine_build_id != operation.to_build_id || generation != operation.candidate_generation
        || shell_build_id != shell.shell_build_id
    {
        return Err(fail("preflight_refused", "the maintenance result does not match the candidate process or its identities"));
    }
    if shared.desktop_bootstrap && process_parent_pid(pid)? != application_pid {
        return Err(fail("preflight_refused", "the maintenance result did not come from the candidate's Shell child"));
    }
    let expected_copy = operation.store_evidence.as_ref()
        .and_then(|evidence| evidence.get("copiedFiles")).and_then(|files| files.as_array())
        .and_then(|files| files.iter().find(|file| file.get("name").and_then(serde_json::Value::as_str) == Some("state.sqlite")))
        .and_then(|file| file.get("sha256").and_then(serde_json::Value::as_str).map(str::to_owned));
    if expected_copy.as_deref() != Some(copy_sha256.as_str()) {
        return Err(fail("preflight_refused", "the candidate did not read the Host's disposable copy"));
    }
    let facts = serde_json::json!({ "pid": pid, "applicationPid": application_pid, "engineBuildId": engine_build_id,
        "shellBuildId": shell_build_id, "generation": generation, "copySha256": copy_sha256,
        "storeSchemaVersion": payload.get("storeSchemaVersion").cloned().unwrap_or(serde_json::Value::Null),
        "migrationCount": payload.get("migrationCount").cloned().unwrap_or(serde_json::Value::Null),
        "quickCheck": payload.get("quickCheck").cloned().unwrap_or(serde_json::Value::Null) });
    if let Some(operation) = state.durable.engine_operation.as_mut() {
        operation.preflight = Some(facts.clone());
        operation.phase = PHASE_PREFLIGHT_PASSED.into();
    }
    persist_state(&shared.state_file, &state.durable).map_err(err)?;
    drop(state);
    log_event(shared, "engine_preflight_passed", facts)?;
    shared.ready.notify_all();
    Ok(serde_json::json!({ "accepted": true }))
}

/// Candidate process → Host: the decision to continue into ordinary startup. Only a committed selection answers `commit`.
pub(super) fn maintenance_wait(shared: &Arc<Shared>, payload: &serde_json::Value) -> Result<serde_json::Value, Failure> {
    let operation_id = text(payload, "operationId")?;
    let state = shared.state.lock().map_err(poison)?;
    let operation = state.durable.engine_operation.as_ref().filter(|op| op.operation_id == operation_id)
        .ok_or_else(|| fail("not_found", "no Engine operation has that identity"))?;
    let decision = match operation.phase.as_str() {
        PHASE_PREFLIGHT_RUNNING | PHASE_PREFLIGHT_PASSED | PHASE_COMMITTING => "pending",
        PHASE_COMMITTED | PHASE_VERIFIED => "commit",
        _ => "abort",
    };
    Ok(serde_json::json!({ "decision": decision }))
}

/// The switch worker. Its outcome is always a persisted phase; an error that reaches it is an uncertainty and holds.
fn run_switch(shared: &Arc<Shared>, operation_id: &str) {
    if let Err(reason) = drive_switch(shared, operation_id) {
        // A switch the Host's own shutdown stopped before its commit is not held: it is left as a crash would leave it, and the
        // restart reconciles it (the selected Engine starts). A committed switch keeps its record beside the committed phase.
        if stopped_by_shutdown_before_commit(shared, operation_id) {
            // The Host is stopping and no selector was written: the production Store guard ends with the switch.
            let _ = shared.switch_guard.lock().map(|mut slot| slot.take());
        } else {
            hold(shared, operation_id, reason);
        }
    }
}

fn stopped_by_shutdown_before_commit(shared: &Shared, operation_id: &str) -> bool {
    let Ok(state) = shared.state.lock() else { return false };
    state.shutdown_requested && state.durable.engine_operation.as_ref().is_some_and(|operation| {
        operation.operation_id == operation_id
            && matches!(operation.phase.as_str(), PHASE_FENCED | PHASE_A_STOPPED | PHASE_GUARDED | PHASE_PREFLIGHT_RUNNING | PHASE_PREFLIGHT_PASSED | PHASE_FALLBACK)
    })
}

fn shutdown_requested(shared: &Shared) -> bool {
    shared.state.lock().map(|state| state.shutdown_requested).unwrap_or(true)
}

fn hold(shared: &Shared, operation_id: &str, reason: String) {
    let _ = mutate_operation(shared, operation_id, |operation| {
        // Once the selector names the candidate, a failure is recorded beside the committed phase and never hides the selection:
        // a restart still starts the committed Engine. Only a pre-commit uncertainty becomes a hold.
        if !matches!(operation.phase.as_str(), PHASE_COMMITTED | PHASE_VERIFIED) {
            if operation.phase != PHASE_HELD {
                operation.held_from = Some(operation.phase.clone());
            }
            operation.phase = PHASE_HELD.into();
        }
        operation.failure = Some(reason.clone());
    });
    let _ = log_event(shared, "engine_switch_held", serde_json::json!({ "operationId": operation_id, "message": reason }));
    shared.ready.notify_all();
}

/// The managed tree the fence recorded, for a stop that finds the Engine no longer recorded.
fn recorded_stopping(shared: &Shared) -> Option<StoppingInstance> {
    let state = shared.state.lock().ok()?;
    state.durable.engine_operation.as_ref()?.stopping.clone()
}

/// The managed Engine tree as a fence records it: the root process and every process its Job holds now, each with its creation time.
fn stopping_of(managed: &ManagedProcess) -> StoppingInstance {
    let process_id = managed.child.id();
    let (members_known, members) = match managed.containment.members() {
        Ok(ids) => (true, ids.into_iter().map(|process_id| UnprovenMember {
            process_id,
            process_creation_time: crate::custody::native::creation_time_of(process_id),
        }).collect()),
        Err(_) => (false, Vec::new()),
    };
    StoppingInstance { process_id, process_creation_time: crate::custody::native::creation_time_of(process_id), members, members_known }
}

/// The managed Engine tree now, read again after the fence's grace period. None when no managed Engine is recorded.
fn managed_stopping(shared: &Shared) -> Option<StoppingInstance> {
    let state = shared.state.lock().ok()?;
    state.managed.as_ref().map(stopping_of)
}

/// Every process the Job holds at the unproven verdict, read while the Host still holds the Job's handle (H1).
fn unproven_members(shared: &Shared) -> (bool, Vec<UnprovenMember>) {
    let Ok(state) = shared.state.lock() else { return (false, Vec::new()) };
    match state.unproven.as_ref().map(|process| process.containment.members()) {
        Some(Ok(ids)) => (true, ids.into_iter().map(|process_id| UnprovenMember {
            process_id,
            process_creation_time: crate::custody::native::creation_time_of(process_id),
        }).collect()),
        _ => (false, Vec::new()),
    }
}

/// Records the managed tree a fenced stop could not prove ended, with the hold, in one durable write (C09). The Job this Host still holds is
/// the freshest membership; without it the fence-time snapshot stands.
fn record_unproven_termination(shared: &Shared, operation_id: &str, stopping: &StoppingInstance, reason: String, injected: bool) -> Result<(), String> {
    let (members_known, members) = match unproven_members(shared) {
        (true, members) => (true, members),
        (false, _) => (stopping.members_known, stopping.members.clone()),
    };
    let (build_id, generation) = {
        let state = shared.state.lock().map_err(poison)?;
        let operation = state.durable.engine_operation.as_ref().ok_or("the Engine operation record disappeared")?;
        (operation.from_build_id.clone(), operation.previous_generation.clone())
    };
    let record = UnprovenTermination { process_id: stopping.process_id, process_creation_time: stopping.process_creation_time,
        build_id, generation, reason, injected, members, members_known };
    {
        let mut state = shared.state.lock().map_err(poison)?;
        if let Some(operation) = state.durable.engine_operation.as_mut() {
            operation.termination_unproven = Some(record.clone());
            // The record and the hold are one durable write: a restart between two writes could otherwise leave the record unread (C09).
            if !matches!(operation.phase.as_str(), PHASE_COMMITTED | PHASE_VERIFIED) {
                if operation.phase != PHASE_HELD {
                    operation.held_from = Some(operation.phase.clone());
                }
                operation.phase = PHASE_HELD.into();
            }
            operation.failure = Some(record.reason.clone());
        }
        persist_state(&shared.state_file, &state.durable)?;
    }
    log_event(shared, "managed_process_termination_unproven", serde_json::json!({ "operationId": operation_id,
        "processId": record.process_id, "processCreationTime": record.process_creation_time, "buildId": record.build_id,
        "generation": record.generation, "injected": record.injected, "reason": record.reason }))
}

fn drive_switch(shared: &Arc<Shared>, operation_id: &str) -> Result<(), String> {
    // The accepting Engine returns its owner response only after the Host accepted the switch. Its tree ends after a short grace
    // period, so that response is not cut off; Custody is already fenced and Runs are already refused, so nothing new starts.
    thread::sleep(Duration::from_millis(1_500));
    // 1. The managed Engine tree ends before anything touches the Store (G0-C09/C10). The tree is recorded again after the grace period, so a
    // process it started in that window is covered. A tree that is no longer recorded is unproven: it is recorded from the fence-time snapshot,
    // so a restart can prove it later instead of guessing, and the switch holds.
    let Some(stopping) = managed_stopping(shared) else {
        let fenced = recorded_stopping(shared)
            .ok_or("the managed Engine is no longer recorded during the fenced switch; its tree cannot be proven stopped")?;
        let reason = "the managed Engine left the Host's records during the fenced switch; its tree cannot be proven stopped".to_string();
        record_unproven_termination(shared, operation_id, &fenced, reason.clone(), false)?;
        return Err(reason);
    };
    mutate_operation(shared, operation_id, |operation| operation.stopping = Some(stopping.clone()))?;
    if let Err(reason) = shutdown_managed_for_switch(shared) {
        let injected = cfg!(debug_assertions) && shared.config.test_switch_termination_uncertain;
        record_unproven_termination(shared, operation_id, &stopping, reason.clone(), injected)?;
        return Err(format!("the active Engine's process tree could not be proven ended: {reason}"));
    }
    set_phase(shared, operation_id, PHASE_A_STOPPED)?;
    crash_point(shared, "after_a_stopped");

    // 2. The Store boundary: Host-owned guards on the production files and a consistent disposable copy.
    let (profile, scratch) = (shared.profile_root.clone(), operation_directory(shared, operation_id).join("preflight"));
    fs::create_dir_all(scratch.parent().ok_or("the preflight directory has no parent")?).map_err(err)?;
    let store = profile.join("store").join("state.sqlite");
    let guard = match store_guard::guard_and_copy_store(&store, &scratch) {
        Ok(guard) => guard,
        Err(reason) => return Err(format!("the production Store boundary could not be established: {reason}")),
    };
    let evidence = serde_json::to_value(guard.evidence()).map_err(err)?;
    *shared.switch_guard.lock().map_err(poison)? = Some(guard);
    {
        let mut state = shared.state.lock().map_err(poison)?;
        let operation = state.durable.engine_operation.as_mut().ok_or("the Engine operation record disappeared")?;
        operation.store_evidence = Some(evidence);
        operation.phase = PHASE_GUARDED.into();
        persist_state(&shared.state_file, &state.durable)?;
    }
    crash_point(shared, "after_guard");

    // 3. The candidate runs only its maintenance preflight, against the disposable copy, before any ordinary startup.
    let (to, candidate_generation) = {
        let state = shared.state.lock().map_err(poison)?;
        let operation = state.durable.engine_operation.as_ref().ok_or("the Engine operation record disappeared")?;
        (operation.to_build_id.clone(), operation.candidate_generation.clone())
    };
    // The phase is recorded before the candidate exists, so its preflight result always finds the operation it belongs to.
    set_phase(shared, operation_id, PHASE_PREFLIGHT_RUNNING)?;
    crash_point(shared, "after_preflight_started");
    barrier(shared, "pre_candidate_spawn");
    if let Err(reason) = spawn_maintenance_build(shared, &to, &candidate_generation, operation_id, &scratch) {
        return fallback_to_a(shared, operation_id, format!("the candidate did not start its preflight: {reason}"));
    }
    // The candidate is running its preflight at this point (G0-C07).
    crash_point(shared, "after_candidate_spawned");
    if let Err(reason) = wait_for_preflight(shared, operation_id, PREFLIGHT_TIMEOUT) {
        return fallback_to_a(shared, operation_id, reason);
    }
    crash_point(shared, "after_preflight_passed");

    // 4. Immediately before the commit: the guarded production file set and the copy are unchanged, and the candidate
    // package is still the staged one. A changed production Store holds; it is never restored or replaced.
    {
        let mut slot = shared.switch_guard.lock().map_err(poison)?;
        let guard = slot.as_mut().ok_or("the Store guards are no longer held")?;
        if let Err(reason) = guard.verify_unchanged() {
            return Err(format!("the guarded Store changed before the commit: {reason}"));
        }
        let snapshot = guard.evidence();
        log_event(shared, "engine_store_boundary_verified", serde_json::json!({ "operationId": operation_id,
            "productionSnapshotSha256": snapshot.snapshot_sha256, "productionFiles": snapshot.production_files.len(),
            "copiedFiles": snapshot.copied_files.len() }))?;
    }
    // A candidate that exited after its preflight report never becomes the committed selection.
    let candidate_alive = {
        let mut state = shared.state.lock().map_err(poison)?;
        match state.managed.as_mut() {
            Some(managed) => managed.child.try_wait().map_err(err)?.is_none(),
            None => false,
        }
    };
    if !candidate_alive {
        return fallback_to_a(shared, operation_id, "the candidate exited before the commit".into());
    }
    let candidate_root = shared.installation_root.join("versions").join(&to);
    let shell = shared.shell.clone().ok_or("the P6 Shell is unavailable")?;
    let package_sha256 = {
        let state = shared.state.lock().map_err(poison)?;
        state.durable.engine_operation.as_ref().map(|op| op.package_sha256.clone()).unwrap_or_default()
    };
    if verify_engine_package(&candidate_root, &to, &shell, &package_sha256).is_err() {
        return fallback_to_a(shared, operation_id, "the candidate package changed before the commit".into());
    }
    barrier(shared, "pre_commit");

    // 5. The commit: one atomic selector write, then the production guards are released, then the Host records the commit.
    // The commit decision is taken under the state lock the Host's shutdown also takes, so the two cannot interleave (P6-HOST-M1).
    match commit(shared, operation_id, &to, &candidate_generation, &package_sha256)? {
        CommitOutcome::Committed => {}
        CommitOutcome::ShutdownWon => {
            return Err("the Host shutdown was accepted before the commit; no selector was written".into());
        }
        CommitOutcome::CandidateNotRunning => {
            return fallback_to_a(shared, operation_id, "the candidate exited before the commit".into());
        }
    }
    barrier(shared, "post_commit");
    crash_point(shared, "after_commit");

    // 6. The committed candidate continues ordinary startup in the same process; its readiness completes the operation.
    match wait_for_candidate_ready(shared, &candidate_generation, readiness_timeout(&shared.config)) {
        Ok(()) => {
            let _ = mark_verified(shared, operation_id);
            Ok(())
        }
        Err(reason) => Err(format!("the committed Engine did not become ready (no automatic rollback after commit): {reason}")),
    }
}

/// The commit's decision: the selector was written, the Host's shutdown was accepted first, or the candidate was no longer running.
enum CommitOutcome {
    Committed,
    ShutdownWon,
    CandidateNotRunning,
}

fn commit(shared: &Arc<Shared>, operation_id: &str, to: &str, candidate_generation: &str, package_sha256: &str) -> Result<CommitOutcome, String> {
    let digest = candidate_digest(&shared.installation_root.join("versions").join(to))?;
    if !digest_eq(&digest, package_sha256) {
        return Err("the candidate package changed at the commit".into());
    }
    crash_point(shared, "before_commit_write");
    {
        // P6-HOST-M1: the commit decision and the single selector write share the state lock that the Host's shutdown takes before it
        // stops the candidate. A shutdown already requested wins and nothing is written. Otherwise the candidate is read here, after the
        // package check, so a candidate that exited during that check is refused. Either the commit lands first (a later shutdown is a
        // postcommit stop, and a restart reconciles the committed Engine) or the shutdown does (no commit).
        let mut state = shared.state.lock().map_err(poison)?;
        if state.shutdown_requested {
            return Ok(CommitOutcome::ShutdownWon);
        }
        let running = match state.managed.as_mut() {
            Some(managed) => managed.child.try_wait().map_err(err)?.is_none()
                && managed.build_id == to && managed.generation == candidate_generation,
            None => false,
        };
        if !running {
            return Ok(CommitOutcome::CandidateNotRunning);
        }
        state.durable.engine_operation.as_mut().ok_or("the Engine operation record disappeared")?.phase = PHASE_COMMITTING.into();
        persist_state(&shared.state_file, &state.durable)?;
        // The single commit point: active.json names the candidate and the operation that selected it.
        write_json_atomic(&shared.active_file, &ActivePointer { build_id: to.into(), digest: digest.clone(), generation: candidate_generation.into(),
            committed_operation_id: Some(operation_id.into()) })?;
        crash_point(shared, "after_commit_write");
        state.durable.active_build_id = to.into();
        state.durable.active_digest = digest.clone();
        state.durable.generation = candidate_generation.into();
        // Custody learns the committed generation before the committed phase is visible to anything that reads it.
        if let Some(custody) = shared.custody.as_ref() {
            custody.set_generation(candidate_generation);
            // The selector already names the candidate, so a fence that cannot lift is logged and the committed phase is still recorded.
            // A restart then reconciles the commit from the selector rather than holding a switch that succeeded.
            if let Err(error) = custody.set_fenced(false) {
                let _ = log_event(shared, "engine_switch_custody_unfence_failed", serde_json::json!({ "operationId": operation_id, "message": error }));
            }
        }
        state.durable.engine_operation.as_mut().ok_or("the Engine operation record disappeared")?.phase = PHASE_COMMITTED.into();
        persist_state(&shared.state_file, &state.durable)?;
    }
    // The Store boundary ends here, before ordinary startup of the candidate can open the production Store.
    shared.switch_guard.lock().map_err(poison)?.take();
    crash_point(shared, "after_commit_guard_release");
    crash_point(shared, "after_committed_phase");
    log_event(shared, "engine_switch_committed", serde_json::json!({ "operationId": operation_id, "engineBuildId": to,
        "generation": candidate_generation, "packageSha256": digest }))?;
    shared.ready.notify_all();
    Ok(CommitOutcome::Committed)
}

fn mark_verified(shared: &Shared, operation_id: &str) -> Result<(), String> {
    mutate_operation(shared, operation_id, |operation| {
        if operation.phase == PHASE_COMMITTED {
            operation.phase = PHASE_VERIFIED.into();
        }
    })
}

/// The exact previous Engine, restarted once, only before the commit and only while the production Store is provably unchanged.
fn fallback_to_a(shared: &Arc<Shared>, operation_id: &str, reason: String) -> Result<(), String> {
    // The Host is stopping: the previous Engine is not started during its shutdown. The pre-commit switch is left as a crash leaves it.
    if shutdown_requested(shared) {
        return Err(format!("{reason}; the Host is stopping, so the previous Engine is not restarted during its shutdown"));
    }
    if let Err(error) = shutdown_managed(shared) {
        return Err(format!("{reason}; the candidate tree could not be proven ended: {error}"));
    }
    {
        // A fallback is permitted only with the production Store proven unchanged under the guards it was taken with.
        let mut slot = shared.switch_guard.lock().map_err(poison)?;
        let Some(guard) = slot.as_mut() else {
            return Err(format!("{reason}; the Store guards are not held, so no fallback is permitted"));
        };
        if let Err(error) = guard.verify_unchanged() {
            return Err(format!("{reason}; the Store changed, so no fallback is permitted: {error}"));
        }
    }
    // The restart uses the generation this Host serves now: no commit happened, so it is the selected Engine's generation.
    let (active_build, current_generation) = {
        let mut state = shared.state.lock().map_err(poison)?;
        let operation = state.durable.engine_operation.as_mut().ok_or("the Engine operation record disappeared")?;
        if operation.fallback_attempted {
            return Err(format!("{reason}; this operation already used its one fallback"));
        }
        operation.fallback_attempted = true;
        operation.phase = PHASE_FALLBACK.into();
        operation.failure = Some(reason.clone());
        persist_state(&shared.state_file, &state.durable)?;
        (state.durable.active_build_id.clone(), state.durable.generation.clone())
    };
    crash_point(shared, "before_fallback_start");
    // The Store guards end before the exact previous Engine opens its own Store.
    shared.switch_guard.lock().map_err(poison)?.take();
    // The switch is over and the previous Engine is about to start: its own Custody admissions, including the continuations it resumes
    // on startup, must not meet the switch's fence (M2). The fence lifts before the start, not after its readiness.
    if let Some(custody) = shared.custody.as_ref() {
        custody.set_fenced(false)?;
    }
    if let Err(error) = spawn_build(shared, &active_build, &current_generation) {
        return Err(format!("{reason}; the exact previous Engine could not be restarted: {error}"));
    }
    if let Err(error) = wait_for_engine_ready(shared, readiness_timeout(&shared.config)) {
        return Err(format!("{reason}; the restarted previous Engine did not become ready: {error}"));
    }
    mutate_operation(shared, operation_id, |operation| operation.phase = PHASE_ROLLED_BACK.into())?;
    let _ = log_event(shared, "engine_switch_rolled_back", serde_json::json!({ "operationId": operation_id, "engineBuildId": active_build,
        "message": reason }));
    Ok(())
}

fn wait_for_preflight(shared: &Arc<Shared>, operation_id: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut state = shared.state.lock().map_err(poison)?;
    loop {
        if state.durable.engine_operation.as_ref().is_some_and(|op| op.operation_id == operation_id && op.phase == PHASE_PREFLIGHT_PASSED) {
            return Ok(());
        }
        match state.managed.as_mut() {
            Some(managed) => {
                if let Some(status) = managed.child.try_wait().map_err(err)? {
                    return Err(format!("the candidate exited before its preflight result with status {status}"));
                }
            }
            None => return Err("the candidate exited before its preflight result".into()),
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("the candidate did not report its preflight result in time".into());
        }
        let (next, _) = shared.ready.wait_timeout(state, (deadline - now).min(Duration::from_millis(250))).map_err(poison)?;
        state = next;
    }
}

fn wait_for_candidate_ready(shared: &Arc<Shared>, generation: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut state = shared.state.lock().map_err(poison)?;
    loop {
        if state.ready_generation.as_deref() == Some(generation) && state.durable.generation == generation {
            // A readiness report counts only while the reporting candidate is still the running, recorded Engine (P6-HOST-M1).
            return match state.managed.as_mut() {
                Some(managed) => match managed.child.try_wait().map_err(err)? {
                    Some(status) => Err(format!("the candidate exited after reporting readiness with status {status}")),
                    None => Ok(()),
                },
                None => Err("the candidate is not running".into()),
            };
        }
        match state.managed.as_mut() {
            Some(managed) => {
                if let Some(status) = managed.child.try_wait().map_err(err)? {
                    return Err(format!("the candidate exited before readiness with status {status}"));
                }
            }
            None => return Err("the candidate is not running".into()),
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("the candidate did not become ready before the deadline".into());
        }
        let (next, _) = shared.ready.wait_timeout(state, (deadline - now).min(Duration::from_millis(250))).map_err(poison)?;
        state = next;
    }
}

/// The candidate's maintenance launch: the same stable Shell, the candidate's package root, and a bootstrap that names the
/// Host-owned disposable copy. The Shell starts the candidate's maintenance entrypoint before any ordinary startup.
fn spawn_maintenance_build(shared: &Arc<Shared>, to: &str, generation: &str, operation_id: &str, scratch: &Path) -> Result<(), String> {
    let maintenance = MaintenanceSpec { operation_id: operation_id.into(), preflight_store: scratch.join("state.sqlite") };
    spawn_build_with(shared, to, generation, Some(maintenance))
}

/// Restart after Host restart: the same Engine operation is reconciled from durable state. Returns the plan for the Host's
/// first launch. Anything that cannot be proven exact holds rather than starting an Engine.
pub(super) enum StartPlan {
    Start,
    Hold(String),
}

/// Fresh proof that every process a fenced stop recorded has ended: the managed root and each member the Job held at the fence. Kill-on-close
/// ends a tree whose Host died, so one bounded wait covers them all. An unknown membership, an unreadable creation time or the debug seam never proves an end.
fn stopping_ended(stopping: &StoppingInstance, injected_uncertain: bool) -> bool {
    if injected_uncertain && cfg!(debug_assertions) {
        return false;
    }
    if !stopping.members_known {
        return false;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    std::iter::once((stopping.process_id, stopping.process_creation_time))
        .chain(stopping.members.iter().map(|member| (member.process_id, member.process_creation_time)))
        .all(|(process_id, created)| instance_gone_by(process_id, created, deadline))
}

fn instance_gone_by(process_id: u32, created: Option<u64>, deadline: Instant) -> bool {
    let Some(created) = created else { return false };
    loop {
        if crate::custody::native::identity_alive(process_id, created) == Some(false) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Fresh proof that the recorded managed process instance has ended. A seam can withhold it, and an unknown answer is never proof.
fn proven_ended(unproven: &UnprovenTermination, injected_uncertain: bool) -> bool {
    if injected_uncertain && cfg!(debug_assertions) {
        return false;
    }
    // Every recorded instance must be gone, or no longer that process: the recorded root and each member the Job held at the verdict.
    // An unknown membership is never proof (H1).
    let gone = |process_id: u32, created: Option<u64>| match created {
        Some(created) => crate::custody::native::identity_alive(process_id, created) == Some(false),
        None => false,
    };
    unproven.members_known
        && gone(unproven.process_id, unproven.process_creation_time)
        && unproven.members.iter().all(|member| gone(member.process_id, member.process_creation_time))
}

pub(super) fn reconcile_at_start(durable: &mut DurableState, install: &Path, profile: &Path, state_file: &Path, active_file: &Path,
    journal_file: &Path, proof_uncertain: bool) -> Result<StartPlan, String> {
    let Some(operation) = durable.engine_operation.clone() else { return Ok(StartPlan::Start) };
    let mut plan = StartPlan::Start;
    let mut operation = operation;
    let active: Option<ActivePointer> = fs::read(active_file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let committed_here = active.as_ref().is_some_and(|pointer| pointer.committed_operation_id.as_deref() == Some(operation.operation_id.as_str()));
    let phase = operation.phase.clone();
    let record = |operation: &mut EngineOperation, phase: &str, failure: Option<String>| {
        operation.phase = phase.into();
        operation.failure = failure;
    };
    match phase.as_str() {
        PHASE_STAGING | PHASE_STAGED => {
            let incoming = install.join("versions").join(format!(".incoming-{}", operation.operation_id));
            if incoming.exists() {
                let _ = fs::remove_dir_all(&incoming);
            }
        }
        // A fenced stop may not have ended the previous Engine's tree: the root and every member recorded with the fence must be proven gone.
        // A proven end abandons the switch and restarts the committed Engine (C04/C10). Otherwise the switch holds on those processes (C09).
        PHASE_FENCED => match operation.stopping.clone() {
            Some(stopping) if !stopping_ended(&stopping, proof_uncertain) => {
                operation.termination_unproven = Some(UnprovenTermination {
                    process_id: stopping.process_id,
                    process_creation_time: stopping.process_creation_time,
                    build_id: operation.from_build_id.clone(),
                    generation: operation.previous_generation.clone(),
                    reason: "the Host restarted while the previous Engine's process tree could not be proven ended".into(),
                    injected: proof_uncertain && cfg!(debug_assertions),
                    members: stopping.members.clone(),
                    members_known: stopping.members_known,
                });
                operation.held_from = Some(phase.clone());
                record(&mut operation, PHASE_HELD, Some("The Host restarted while the previous Engine's process tree could not be proven ended; the switch holds.".into()));
                plan = StartPlan::Hold("The previous Engine's process tree could not be proven ended after a restart; the switch holds.".into());
            }
            _ => record(&mut operation, PHASE_ABANDONED, Some(
                "The Host restarted before the Store boundary; the committed Engine restarted and the switch was not completed.".into())),
        },
        // The Host records a_stopped only after the tree was proven ended in this session, so the restart does not check it again.
        PHASE_A_STOPPED => record(&mut operation, PHASE_ABANDONED, Some(
            "The Host restarted after the previous Engine stopped, before the Store boundary; the committed Engine restarted and the switch was not completed.".into())),
        PHASE_GUARDED | PHASE_PREFLIGHT_RUNNING | PHASE_PREFLIGHT_PASSED | PHASE_COMMITTING if !committed_here => {
            let unchanged = match operation.store_evidence.as_ref() {
                Some(evidence) => production_store_unchanged(profile, evidence),
                None => false,
            };
            if unchanged && !operation.fallback_attempted {
                operation.fallback_attempted = true;
                record(&mut operation, PHASE_ROLLED_BACK, Some("The Host restarted before the commit; the exact committed Engine was restarted.".into()));
            } else {
                record(&mut operation, PHASE_HELD, Some(if unchanged {
                    "The Host restarted during a fallback-capable phase; the fallback budget is spent, so the switch holds.".into()
                } else {
                    "The Host restarted and the guarded production Store cannot be proven unchanged; the switch holds.".into()
                }));
                plan = StartPlan::Hold("The Host restarted with an unprovable Store boundary; the switch holds.".into());
            }
        }
        PHASE_COMMITTING | PHASE_COMMITTED => {
            // The selector is the authority: a commit is in effect only when active.json names this operation. Otherwise the
            // record claims a commit the selector does not show, which holds rather than guessing which Engine is selected.
            if committed_here {
                if let Some(pointer) = active {
                    durable.active_build_id = pointer.build_id.clone();
                    durable.active_digest = pointer.digest.clone();
                    durable.generation = pointer.generation.clone();
                    // The restarted Host serves the committed selection under the generation the selector now names; the
                    // operation follows it, so the candidate's readiness completes the record.
                    operation.candidate_generation = pointer.generation.clone();
                }
                operation.phase = PHASE_COMMITTED.into();
            } else {
                record(&mut operation, PHASE_HELD, Some("The committed record and the selector disagree; the switch holds.".into()));
                plan = StartPlan::Hold("The committed record and the selector disagree; the switch holds.".into());
            }
        }
        PHASE_FALLBACK => record(&mut operation, PHASE_ROLLED_BACK, Some("The Host restarted during the fallback; the committed Engine was restarted.".into())),
        // A held termination resumes only on fresh proof of the recorded process instance (C09). Any other hold stays held.
        PHASE_HELD => match operation.termination_unproven.clone() {
            Some(unproven) if proven_ended(&unproven, proof_uncertain) => {
                append_journal(journal_file, "engine_termination_proven", serde_json::json!({ "operationId": operation.operation_id,
                    "processId": unproven.process_id, "processCreationTime": unproven.process_creation_time }))?;
                record(&mut operation, PHASE_ABANDONED, Some("The Host proved the previous Engine's process tree ended after a restart; the switch is abandoned and the committed Engine restarts.".into()));
                plan = StartPlan::Start;
            }
            Some(unproven) => plan = StartPlan::Hold(format!("The previous Engine's process tree is still unproven after a restart: {}", unproven.reason)),
            // The previous Engine's tree ended and no candidate ever ran, so the held switch cannot have written the Store. The committed
            // Engine restarts: a guard failure must not strand the installation behind a permanent hold (M5).
            None if operation.held_from.as_deref() == Some(PHASE_A_STOPPED) && operation.preflight.is_none() => {
                record(&mut operation, PHASE_ABANDONED, Some("The switch was held after the previous Engine stopped and before any candidate ran; the committed Engine restarts.".into()));
                plan = StartPlan::Start;
            }
            None => plan = StartPlan::Hold(operation.failure.clone().unwrap_or_else(|| "a held switch".into())),
        },
        _ => {}
    }
    durable.engine_operation = Some(operation.clone());
    persist_state(state_file, durable)?;
    append_journal(journal_file, "engine_operation_reconciled", serde_json::json!({ "operationId": operation.operation_id,
        "phase": operation.phase }))?;
    Ok(plan)
}

/// True only when every file the Host recorded at the Store boundary still has the same bytes, and no other SQLite file exists.
fn production_store_unchanged(profile: &Path, evidence: &serde_json::Value) -> bool {
    let Some(files) = evidence.get("productionFiles").and_then(serde_json::Value::as_array) else { return false };
    let store = profile.join("store");
    let mut expected: Vec<String> = Vec::new();
    for file in files {
        let (Some(name), Some(sha256), Some(bytes)) = (file.get("name").and_then(serde_json::Value::as_str),
            file.get("sha256").and_then(serde_json::Value::as_str), file.get("bytes").and_then(serde_json::Value::as_u64)) else { return false };
        let path = store.join(name);
        match fs::read(&path) {
            Ok(content) if content.len() as u64 == bytes && hex::encode(Sha256::digest(&content)) == sha256 => {}
            _ => return false,
        }
        expected.push(name.to_string());
    }
    let present: Vec<String> = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal"].iter()
        .filter(|name| store.join(name).exists()).map(|name| name.to_string()).collect();
    expected.sort();
    let mut present = present;
    present.sort();
    expected == present
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_must_name_two_distinct_engines_and_a_lowercase_digest() {
        let good = serde_json::json!({ "operationId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "fromEngineBuildId": "engine-a",
            "toEngineBuildId": "engine-b", "packageSha256": "a".repeat(64), "shellBuildId": "shell-g0", "generation": "gen" });
        assert!(parse_request(&good).is_ok());
        let same = serde_json::json!({ "operationId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "fromEngineBuildId": "engine-a",
            "toEngineBuildId": "engine-a", "packageSha256": "a".repeat(64), "shellBuildId": "shell-g0", "generation": "gen" });
        assert_eq!(parse_request(&same).err().map(|f| f.code), Some("invalid_request"));
        let upper = serde_json::json!({ "operationId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "fromEngineBuildId": "engine-a",
            "toEngineBuildId": "engine-b", "packageSha256": "A".repeat(64), "shellBuildId": "shell-g0", "generation": "gen" });
        assert!(parse_request(&upper).is_err());
    }

    #[test]
    fn terminal_and_in_flight_phases_are_exactly_the_settled_and_working_outcomes() {
        let mut operation = EngineOperation { operation_id: "op".into(), request_fingerprint: String::new(), from_build_id: "a".into(),
            to_build_id: "b".into(), package_sha256: String::new(), shell_build_id: "s".into(), previous_generation: "g".into(),
            candidate_generation: "c".into(), phase: PHASE_HELD.into(), failure: None, fallback_attempted: false, store_evidence: None,
            preflight: None, receipt: None, termination_unproven: None, held_from: None, stopping: None };
        assert!(!operation.terminal(), "a held switch is not settled and blocks new work");
        assert!(operation.in_flight(), "a held switch keeps the Host up to hold it");
        for phase in [PHASE_FENCED, PHASE_A_STOPPED, PHASE_GUARDED, PHASE_PREFLIGHT_RUNNING, PHASE_PREFLIGHT_PASSED, PHASE_COMMITTING,
            PHASE_COMMITTED, PHASE_FALLBACK] {
            operation.phase = phase.into();
            assert!(operation.in_flight(), "{phase} is a switch in progress");
        }
        operation.phase = PHASE_STAGING.into();
        assert!(!operation.in_flight(), "a stage copies beside the running Engine and holds nothing");
        operation.phase = PHASE_STAGED.into();
        assert!(!operation.in_flight() && !operation.terminal(), "a staged operation changes nothing and blocks nothing");
        for phase in [PHASE_VERIFIED, PHASE_ROLLED_BACK, PHASE_ABANDONED] {
            operation.phase = phase.into();
            assert!(operation.terminal());
            assert!(!operation.in_flight(), "{phase} is settled");
        }
    }

    #[test]
    fn production_store_comparison_refuses_any_drift_and_extra_sidecar() {
        let root = std::env::temp_dir().join(format!("deszo-p6-g0-drift-{}", Uuid::new_v4()));
        let store = root.join("store");
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("state.sqlite"), b"database").unwrap();
        let evidence = serde_json::json!({ "productionFiles": [{ "name": "state.sqlite", "bytes": 8,
            "sha256": hex::encode(Sha256::digest(b"database")) }] });
        assert!(production_store_unchanged(&root, &evidence));
        fs::write(store.join("state.sqlite"), b"changed!").unwrap();
        assert!(!production_store_unchanged(&root, &evidence));
        fs::write(store.join("state.sqlite"), b"database").unwrap();
        fs::write(store.join("state.sqlite-journal"), b"hot").unwrap();
        assert!(!production_store_unchanged(&root, &evidence));
        fs::remove_dir_all(root).unwrap();
    }
}
