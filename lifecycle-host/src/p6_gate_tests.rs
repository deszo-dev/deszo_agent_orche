//! P6-G0 gate tests: a real P6 installation (one verified Shell, verified Engine packages, one durable selector) driven through the
//! same dispatch and stage logic the authenticated IPC uses. Every refusal here must leave the selector, the staging area and the
//! operation record untouched, and an accepted stage must never change the selector.

use super::*;

fn scratch(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("deszo-p6-gate-{label}-{}", Uuid::new_v4()))
}

fn hex_digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

const SHELL_BRIDGE: &[u8] = b"bridge";
const SHELL_SHIM: &[u8] = b"shim";

/// Writes a complete schema-2 Engine package under `root`, bound to the Shell's frozen resources, and returns its digest.
/// `variant` changes the Engine bundle, so two packages with one identity can still differ in content.
fn write_engine_variant(root: &Path, engine_id: &str, shell_build_id: &str, variant: &str) -> String {
    fs::create_dir_all(root.join("runtime")).unwrap();
    let runner = format!("// engine {engine_id}\n{variant}").into_bytes();
    fs::write(root.join("runtime/runner.mjs"), &runner).unwrap();
    fs::write(root.join("runtime/bridge.mjs"), SHELL_BRIDGE).unwrap();
    fs::write(root.join("runtime/deszo-launch-shim.exe"), SHELL_SHIM).unwrap();
    let resources = serde_json::json!({ "kind": "DeszoRuntimeBuild", "version": 1, "testFaultHooks": false, "files": {
        "runner.mjs": hex_digest(&runner), "bridge.mjs": hex_digest(SHELL_BRIDGE), "deszo-launch-shim.exe": hex_digest(SHELL_SHIM) } });
    fs::write(root.join("runtime/runtime-manifest.json"), serde_json::to_vec(&resources).unwrap()).unwrap();
    let mut artifacts = Vec::new();
    for relative in ["runtime/bridge.mjs", "runtime/deszo-launch-shim.exe", "runtime/runner.mjs", "runtime/runtime-manifest.json"] {
        let bytes = fs::read(root.join(relative)).unwrap();
        artifacts.push(serde_json::json!({ "path": relative, "sha256": hex_digest(&bytes), "bytes": bytes.len() }));
    }
    let manifest = serde_json::json!({ "schemaVersion": 2, "buildId": engine_id, "engineBuildId": engine_id, "shellBuildId": shell_build_id,
        "runtimeApiVersion": 2, "bootstrap": "engine", "artifacts": artifacts });
    fs::write(root.join("build.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    candidate_digest(root).unwrap()
}

fn write_engine(root: &Path, engine_id: &str, shell_build_id: &str) -> String {
    write_engine_variant(root, engine_id, shell_build_id, "")
}

fn shell_release(install: &Path) -> ShellRelease {
    let exe = b"shell executable".to_vec();
    let shell_root = install.join("shell");
    fs::create_dir_all(&shell_root).unwrap();
    fs::write(shell_root.join("deszo.exe"), &exe).unwrap();
    let release = ShellRelease {
        schema_version: 1,
        kind: SHELL_RELEASE_KIND.into(),
        shell_build_id: "shell-g0".into(),
        desktop_executable: ShellFile { path: "deszo.exe".into(), sha256: hex_digest(&exe), bytes: exe.len() as u64 },
        frozen_resources: vec![
            ShellFile { path: "runtime/bridge.mjs".into(), sha256: hex_digest(SHELL_BRIDGE), bytes: SHELL_BRIDGE.len() as u64 },
            ShellFile { path: "runtime/deszo-launch-shim.exe".into(), sha256: hex_digest(SHELL_SHIM), bytes: SHELL_SHIM.len() as u64 },
        ],
    };
    fs::write(shell_root.join(SHELL_RELEASE_FILE), serde_json::to_vec(&release).unwrap()).unwrap();
    release
}

/// A Shared over a real P6 installation whose selector names engine-a. The Host's IPC is not started; the logic is.
fn p6_shared(root: &Path) -> (PathBuf, Arc<Shared>) {
    p6_shared_with(root, false)
}

/// As `p6_shared`; with `custody`, a live Custody registry (allowlisting this test executable) backs the zero-job proof.
fn p6_shared_with(root: &Path, custody: bool) -> (PathBuf, Arc<Shared>) {
    let install = root.join("installation");
    let host_dir = install.join(".deszo-host");
    let profile = root.join("profile");
    fs::create_dir_all(&host_dir).unwrap();
    fs::create_dir_all(profile.join("store")).unwrap();
    fs::create_dir_all(install.join("staging")).unwrap();
    // Host::start canonicalizes the installation and staging roots; the staging location check compares canonical paths.
    let install = fs::canonicalize(&install).unwrap();
    fs::write(profile.join("store").join("state.sqlite"), b"production store").unwrap();
    let shell = shell_release(&install);
    let engine_a_digest = write_engine(&install.join("versions").join("engine-a"), "engine-a", "shell-g0");
    let active_file = host_dir.join("active.json");
    let state_file = host_dir.join("profiles").join("p6-gate").join("lifecycle.json");
    fs::create_dir_all(state_file.parent().unwrap()).unwrap();
    write_json_atomic(&active_file, &ActivePointer { build_id: "engine-a".into(), digest: engine_a_digest.clone(), generation: "gen-1".into(),
        committed_operation_id: None }).unwrap();
    let durable = DurableState { schema_version: 1, installation_id: "p6-gate".into(), active_build_id: "engine-a".into(),
        active_digest: engine_a_digest, generation: "gen-1".into(), store_id: None, operation: None, engine_operation: None };
    let journal = OpenOptions::new().create(true).append(true).open(host_dir.join("operations.ndjson")).unwrap();
    let config: HostConfig = serde_json::from_value(serde_json::json!({ "installationRoot": install, "profileRoot": profile,
        "stagingRoot": install.join("staging"), "nodeExecutable": std::env::current_exe().unwrap(), "initialBuildId": "engine-a" })).unwrap();
    // The registry allowlists this test executable, so invocations can be admitted for real; none is ever launched here.
    let custody_registry = custody.then(|| {
        let exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
        let sha256 = file_sha256(&exe).unwrap();
        let config = CustodyConfig { allowed_executables: vec![AllowedExecutable { path: exe, sha256 }], ..Default::default() };
        CustodyRegistry::open(&host_dir, "gen-1", &config).unwrap()
    });
    let shared = Arc::new(Shared {
        config,
        installation_root: install.clone(),
        installation_id: "p6-gate".into(),
        desktop_bootstrap: true,
        shell: Some(shell),
        profile_root: profile.clone(),
        staging_root: install.join("staging"),
        host_dir,
        state_file,
        active_file,
        endpoint_file: install.join("ipc-endpoint.json"),
        capability: "c".repeat(64),
        address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state: Mutex::new(RuntimeState { durable, managed: None, unproven: None, ready_generation: None, stop_requested: false,
            shutdown_requested: false }),
        ready: Condvar::new(),
        journal: Mutex::new(journal),
        custody: custody_registry,
        switch_gate: Mutex::new(()),
        switch_guard: Mutex::new(None),
        managed_stop: Mutex::new(()),
    });
    (install, shared)
}

fn refused_code(result: Dispatch) -> Option<String> {
    match result {
        Dispatch::Reply(response) => {
            assert!(!response.ok, "the request must be refused");
            response.code
        }
        Dispatch::Activate(_) => panic!("a P6 installation must never start a legacy activation"),
    }
}

/// A staging request for engine-b against the installed engine-a, bound to the installed Shell and the given generation.
fn stage_payload(operation_id: &str, package_sha256: &str, generation: &str) -> serde_json::Value {
    serde_json::json!({ "operationId": operation_id, "fromEngineBuildId": "engine-a", "toEngineBuildId": "engine-b",
        "packageSha256": package_sha256, "shellBuildId": "shell-g0", "generation": generation })
}

/// Places an engine-b package in the staging area with the given bundle variant and returns its digest.
fn stage_package(shared: &Shared, variant: &str) -> String {
    write_engine_variant(&shared.staging_root.join("engine-b"), "engine-b", "shell-g0", variant)
}

#[test]
fn p6_installation_refuses_legacy_activation_before_any_side_effect() {
    let root = scratch("legacy");
    let (install, shared) = p6_shared(&root);
    let selector_before = fs::read(&shared.active_file).unwrap();
    let payload = serde_json::json!({ "operationId": Uuid::new_v4().to_string(), "action": "application.activate_candidate",
        "installationId": "p6-gate", "profileRoot": shared.profile_root, "runId": Uuid::new_v4().to_string(), "nodeInstanceId": "node",
        "candidateId": "engine-b", "candidateDigest": "0".repeat(64), "expectedGeneration": "gen-1",
        "judgeEvidence": { "kind": "engine_validated_designated_judge_decision", "workflowId": "w", "judgeNodeInstanceId": "j", "attemptId": "a", "checkpointId": "c" },
        "readiness": { "applicationResponsive": true, "engineReady": true, "sameProfile": true, "sameStore": true } });
    let code = refused_code(dispatch(&shared, "lifecycle.activate_candidate", payload));
    assert_eq!(code.as_deref(), Some("p6_legacy_activation_refused"));
    assert!(shared.state.lock().unwrap().durable.operation.is_none(), "no legacy operation was recorded");
    assert_eq!(fs::read(&shared.active_file).unwrap(), selector_before, "the selector is unchanged");
    assert!(!install.join("staging").join("engine-b").exists(), "nothing was staged");
    fs::remove_dir_all(root).ok();
}

#[test]
fn stage_refuses_a_different_shell_and_writes_nothing() {
    let root = scratch("stage-shell");
    let (install, shared) = p6_shared(&root);
    let payload = serde_json::json!({ "operationId": Uuid::new_v4().to_string(), "fromEngineBuildId": "engine-a",
        "toEngineBuildId": "engine-b", "packageSha256": "a".repeat(64), "shellBuildId": "some-other-shell", "generation": "gen-1" });
    let failure = engine_switch::stage(&shared, &payload).err().expect("a foreign Shell is refused");
    assert_eq!(failure.code, "shell_mismatch");
    assert!(shared.state.lock().unwrap().durable.engine_operation.is_none());
    assert!(!install.join("versions").join("engine-b").exists());
    fs::remove_dir_all(root).ok();
}

#[test]
fn switch_and_maintenance_refuse_without_a_staged_operation() {
    let root = scratch("no-stage");
    let (_install, shared) = p6_shared(&root);
    let payload = serde_json::json!({ "operationId": Uuid::new_v4().to_string(), "fromEngineBuildId": "engine-a",
        "toEngineBuildId": "engine-b", "packageSha256": "a".repeat(64), "shellBuildId": "shell-g0", "generation": "gen-1" });
    let switch = engine_switch::switch(&shared, &payload).err().expect("a switch without a staged Engine is refused");
    assert_eq!(switch.code, "engine_not_staged");
    let ready = serde_json::json!({ "operationId": Uuid::new_v4().to_string(), "pid": 1, "applicationPid": 1,
        "engineBuildId": "engine-b", "shellBuildId": "shell-g0", "generation": "gen-2", "copySha256": "0".repeat(64) });
    let maintenance = engine_switch::maintenance_ready(&shared, &ready).err().expect("an unbound preflight is refused");
    assert_eq!(maintenance.code, "not_found");
    assert!(shared.state.lock().unwrap().durable.engine_operation.is_none());
    fs::remove_dir_all(root).ok();
}

#[test]
fn a_staged_engine_package_must_match_its_digest_and_shell_binding() {
    let root = scratch("binding");
    let install = root.join("installation");
    fs::create_dir_all(install.join("shell")).unwrap();
    let shell = shell_release(&install);
    let candidate = root.join("candidate");
    let digest = write_engine(&candidate, "engine-b", "shell-g0");
    assert!(engine_switch::verify_engine_package(&candidate, "engine-b", &shell, &digest).is_ok(), "a correctly bound package verifies");
    let wrong_digest = engine_switch::verify_engine_package(&candidate, "engine-b", &shell, &"b".repeat(64)).err().expect("a digest mismatch is refused");
    assert_eq!(wrong_digest.code, "engine_package_digest_mismatch");
    let other_shell = ShellRelease { shell_build_id: "shell-other".into(), ..shell.clone() };
    let foreign = engine_switch::verify_engine_package(&candidate, "engine-b", &other_shell, &digest).err().expect("another Shell is refused");
    assert!(foreign.message.contains("not bound"), "the binding check names the mismatch: {}", foreign.message);
    fs::remove_dir_all(root).ok();
}

#[test]
fn a_staged_package_altered_truncated_extended_or_missing_is_refused_and_leaves_no_trace() {
    // Each damage is paired with the verification message that must refuse it: the Host names the exact defect it found.
    let cases: [(&str, fn(&Path), &str); 4] = [
        ("altered", |staged| fs::write(staged.join("runtime/runner.mjs"), b"// tampered runner\n").unwrap(), "artifact digest is invalid"),
        ("truncated", |staged| {
            let bytes = fs::read(staged.join("runtime/runner.mjs")).unwrap();
            fs::write(staged.join("runtime/runner.mjs"), &bytes[..bytes.len() / 2]).unwrap();
        }, "wrong size"),
        ("unlisted-executable", |staged| fs::write(staged.join("runtime/unlisted.exe"), b"MZ extra").unwrap(), "exact package file set"),
        ("missing-artifact", |staged| fs::remove_file(staged.join("runtime/bridge.mjs")).unwrap(), "missing"),
    ];
    for (label, damage, expected) in cases {
        let root = scratch(label);
        let (install, shared) = p6_shared(&root);
        // The digest is the one the Engine packaged; the damage happens to the staged bytes the Host would copy.
        let digest = stage_package(&shared, "");
        damage(&shared.staging_root.join("engine-b"));
        let before = fs::read(&shared.active_file).unwrap();
        let refused = engine_switch::stage(&shared, &stage_payload(&Uuid::new_v4().to_string(), &digest, "gen-1"))
            .err().unwrap_or_else(|| panic!("{label}: a damaged staged package must be refused"));
        assert!(refused.message.contains(expected), "{label}: refused by the exact check '{expected}': {}", refused.message);
        assert!(shared.state.lock().unwrap().durable.engine_operation.is_none(), "{label}: no stage intent was recorded");
        assert!(!install.join("versions").join("engine-b").exists(), "{label}: nothing reached the installation");
        assert_eq!(fs::read(&shared.active_file).unwrap(), before, "{label}: the selector is unchanged");
        fs::remove_dir_all(root).ok();
    }
}

#[test]
fn a_clean_stage_is_idempotent_keeps_the_selector_and_refuses_a_different_package_under_the_same_identity() {
    let root = scratch("stage-idempotent");
    let (install, shared) = p6_shared(&root);
    let digest = stage_package(&shared, "");
    let before = fs::read(&shared.active_file).unwrap();
    let operation = Uuid::new_v4().to_string();
    let first = engine_switch::stage(&shared, &stage_payload(&operation, &digest, "gen-1")).expect("a valid package stages");
    assert_eq!(first["phase"], "staged");
    let installed = install.join("versions").join("engine-b");
    assert!(installed.is_dir(), "the verified package is installed beside engine-a");
    assert_eq!(package_digest(&installed), digest, "the installed bytes are the staged bytes");
    assert_eq!(fs::read(&shared.active_file).unwrap(), before, "staging never changes the selector");
    // The same operation again answers with its recorded state and writes nothing new.
    let again = engine_switch::stage(&shared, &stage_payload(&operation, &digest, "gen-1")).expect("the replay is idempotent");
    assert_eq!(again["phase"], "staged");
    // Another operation may stage the same verified package: it supersedes the staged one, which never switched (N2).
    let successor = Uuid::new_v4().to_string();
    let superseding = engine_switch::stage(&shared, &stage_payload(&successor, &digest, "gen-1")).expect("the staged operation is superseded");
    assert_eq!(superseding["phase"], "staged");
    assert_eq!(shared.state.lock().unwrap().durable.engine_operation.as_ref().unwrap().operation_id, successor);
    // A different package under the installed identity is an identity conflict, whichever operation asks, and the installed bytes stay.
    let other = stage_package(&shared, "// a different build\n");
    assert_ne!(other, digest, "the second package really differs");
    let conflict = engine_switch::stage(&shared, &stage_payload(&Uuid::new_v4().to_string(), &other, "gen-1")).err()
        .expect("a different package under an installed identity is refused");
    assert_eq!(conflict.code, "engine_identity_conflict");
    // Once the operation has settled, the same identity with other bytes is refused the same way, and the installed Engine
    // keeps its verified bytes.
    {
        let mut state = shared.state.lock().unwrap();
        state.durable.engine_operation.as_mut().unwrap().phase = "rolled_back".into();
    }
    let conflict = engine_switch::stage(&shared, &stage_payload(&Uuid::new_v4().to_string(), &other, "gen-1")).err()
        .expect("a different package under an installed identity is refused");
    assert_eq!(conflict.code, "engine_identity_conflict");
    assert_eq!(package_digest(&installed), digest, "the installed Engine is unchanged by the refused conflict");
    fs::remove_dir_all(root).ok();
}

#[test]
fn a_stale_generation_or_unknown_engine_is_refused_before_any_record() {
    let root = scratch("stale");
    let (_install, shared) = p6_shared(&root);
    let digest = stage_package(&shared, "");
    let stale = engine_switch::stage(&shared, &stage_payload(&Uuid::new_v4().to_string(), &digest, "gen-0"))
        .err().expect("a stale generation is refused");
    assert_eq!(stale.code, "stale_generation");
    let mut unknown = stage_payload(&Uuid::new_v4().to_string(), &digest, "gen-1");
    unknown["fromEngineBuildId"] = serde_json::json!("engine-z");
    let refused = engine_switch::stage(&shared, &unknown).err().expect("an unknown active Engine is refused");
    assert_eq!(refused.code, "stale_engine");
    assert!(shared.state.lock().unwrap().durable.engine_operation.is_none());
    fs::remove_dir_all(root).ok();
}

/// The Host's own digest of a directory (the one the staging request is compared with), computed with the Host's routine.
fn package_digest(path: &Path) -> String {
    candidate_digest(path).unwrap()
}

fn switch_payload(operation_id: &str, package_sha256: &str) -> serde_json::Value {
    serde_json::json!({ "operationId": operation_id, "fromEngineBuildId": "engine-a", "toEngineBuildId": "engine-b",
        "packageSha256": package_sha256, "shellBuildId": "shell-g0", "generation": "gen-1" })
}

#[test]
fn a_switch_waits_while_custody_holds_admitted_work_and_leaves_the_engine_and_the_fence_unchanged() {
    let root = scratch("custody-switch");
    let (install, shared) = p6_shared_with(&root, true);
    let digest = stage_package(&shared, "");
    let operation = Uuid::new_v4().to_string();
    engine_switch::stage(&shared, &stage_payload(&operation, &digest, "gen-1")).expect("the candidate is staged");
    let registry = shared.custody.as_ref().expect("the custody registry is attached");
    let epoch = registry.dispatch("custody.attach", &serde_json::json!({ "generation": "gen-1" })).unwrap()["epoch"].as_u64().unwrap();
    // An allowlisted invocation is admitted (its work exists, and it is counted as active) but nothing needs to be launched.
    let exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    registry.dispatch("custody.reserve", &serde_json::json!({ "epoch": epoch, "generation": "gen-1", "attemptId": "attempt-held",
        "runId": "run-1", "provider": "codex", "command": exe.to_string_lossy(), "args": [], "cwd": std::env::temp_dir().to_string_lossy(),
        "env": {}, "stdinHex": null, "deadlineMs": 60_000 })).expect("the allowlisted invocation is admitted");
    assert_eq!(registry.active_job_count().unwrap(), 1, "admitted work holds the Engine");
    let refused = engine_switch::switch(&shared, &switch_payload(&operation, &digest)).err().expect("the switch waits for custody");
    assert_eq!(refused.code, "custody_jobs_active");
    assert!(refused.message.contains("1 Custody invocation"), "the refusal counts the held work: {}", refused.message);
    // Nothing moved: the operation is still staged, the selector still names engine-a, and the fence was released with the refusal.
    assert_eq!(shared.state.lock().unwrap().durable.engine_operation.as_ref().unwrap().phase, "staged");
    assert_eq!(shared.state.lock().unwrap().durable.active_build_id, "engine-a");
    assert!(install.join(".deszo-host").join("active.json").is_file());
    let selector: serde_json::Value = serde_json::from_slice(&fs::read(shared.active_file.clone()).unwrap()).unwrap();
    assert_eq!(selector["buildId"], "engine-a", "the committed selector is unchanged");
    let admitted_after = registry.dispatch("custody.reserve", &serde_json::json!({ "epoch": epoch, "generation": "gen-1", "attemptId": "attempt-after-refusal",
        "runId": "run-1", "provider": "codex", "command": exe.to_string_lossy(), "args": [], "cwd": std::env::temp_dir().to_string_lossy(),
        "env": {}, "stdinHex": null, "deadlineMs": 60_000 }));
    assert!(admitted_after.is_ok(), "the refused switch leaves custody admitting work again");
    fs::remove_dir_all(root).ok();
}

#[test]
fn stage_copy_failure_after_durable_intent_abandons_operation_and_leaves_selector_unchanged() {
    let root = scratch("stage-abandon");
    let (install, shared) = p6_shared(&root);
    let digest = stage_package(&shared, "");
    let selector_before = fs::read(&shared.active_file).unwrap();
    let operation = Uuid::new_v4().to_string();

    // Trigger a real filesystem failure during the copy phase after intent has been recorded.
    // Pre-create the incoming directory with an exclusively locked file (controlled sharing violation).
    let incoming = install.join("versions").join(format!(".incoming-{operation}"));
    fs::create_dir_all(&incoming).unwrap();
    let locked_path = incoming.join("locked_file.bin");
    #[cfg(windows)]
    let lock_guard = {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .share_mode(0)
            .open(&locked_path)
            .unwrap()
    };
    #[cfg(not(windows))]
    let lock_guard = {
        let f = fs::File::create(&locked_path).unwrap();
        let mut perms = fs::metadata(&incoming).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&incoming, perms).unwrap();
        f
    };

    // Staging must fail during the copy phase after intent has been durably persisted:
    let failure = engine_switch::stage(&shared, &stage_payload(&operation, &digest, "gen-1"))
        .err()
        .expect("stage must fail on copy/remove error");
    assert!(!failure.message.is_empty(), "failure message must be present");

    // 1. Stage intent was durably recorded and then abandoned in durable state
    let state = shared.state.lock().unwrap();
    let op = state.durable.engine_operation.as_ref().expect("operation must be recorded");
    assert_eq!(op.operation_id, operation);
    assert_eq!(op.phase, engine_switch::PHASE_ABANDONED, "operation is recorded as abandoned");
    assert!(op.failure.is_some(), "failure explanation is recorded");
    drop(state);

    // 2. Active selector is completely unchanged: Engine A remains committed
    assert_eq!(fs::read(&shared.active_file).unwrap(), selector_before, "active.json is byte-identical");
    let selector: serde_json::Value = serde_json::from_slice(&fs::read(&shared.active_file).unwrap()).unwrap();
    assert_eq!(selector["buildId"], "engine-a");

    // 3. No incomplete Engine package becomes selectable
    let installed_b = install.join("versions").join("engine-b");
    assert!(!installed_b.exists(), "engine-b is not installed in versions");

    // 4. Check journal has recorded engine_stage_abandoned event
    let journal_content = fs::read_to_string(shared.host_dir.join("operations.ndjson")).unwrap();
    assert!(journal_content.contains("engine_stage_abandoned"), "abandon event logged");

    // Release the lock so subsequent operations / cleanup can proceed
    drop(lock_guard);
    #[cfg(not(windows))]
    {
        let mut perms = fs::metadata(&incoming).unwrap().permissions();
        perms.set_readonly(false);
        fs::set_permissions(&incoming, perms).unwrap();
    }

    // 5. Host restart preserves correct behavior: reconciliation handles the abandoned state cleanly
    let mut durable = shared.state.lock().unwrap().durable.clone();
    let plan = engine_switch::reconcile_at_start(
        &mut durable,
        &install,
        &shared.profile_root,
        &shared.state_file,
        &shared.active_file,
        &shared.host_dir.join("operations.ndjson"),
        false,
    ).expect("reconciliation must succeed");
    assert!(matches!(plan, engine_switch::StartPlan::Start), "Host restarts committed Engine A");
    assert_eq!(durable.active_build_id, "engine-a");

    // 6. A future valid stage of the same or a new operation succeeds (not wedged)
    let successor = Uuid::new_v4().to_string();
    let result = engine_switch::stage(&shared, &stage_payload(&successor, &digest, "gen-1"))
        .expect("a subsequent stage must succeed");
    assert_eq!(result["phase"], "staged");
    assert!(installed_b.is_dir(), "engine-b is now installed cleanly");
    assert_eq!(package_digest(&installed_b), digest);

    // Selector still names engine-a (stage never selects)
    assert_eq!(fs::read(&shared.active_file).unwrap(), selector_before);

    fs::remove_dir_all(root).ok();
}

/// Serialises the tests that set or remove NODE_TEST_CONTEXT, which is process-wide.
static TEST_CONTEXT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn a_test_fault_package_is_installed_only_inside_a_node_test_process() {
    let _context_guard = TEST_CONTEXT_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = scratch("test-hooks");
    let install = root.join("installation");
    fs::create_dir_all(install.join("shell")).unwrap();
    let shell = shell_release(&install);
    let candidate = root.join("candidate");
    write_engine(&candidate, "engine-b", "shell-g0");
    // The trusted builder lists the marker among the package artifacts; the same listing is reproduced here.
    let marker = b"DESZO_TEST_FAULT_HOOKS_V1
";
    fs::write(candidate.join(".deszo-test-fault-hooks"), marker).unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(candidate.join("build.json")).unwrap()).unwrap();
    manifest["artifacts"].as_array_mut().unwrap().push(serde_json::json!({ "path": ".deszo-test-fault-hooks", "sha256": hex_digest(marker), "bytes": marker.len() }));
    fs::write(candidate.join("build.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    let digest = candidate_digest(&candidate).unwrap();
    std::env::remove_var("NODE_TEST_CONTEXT");
    let refused = engine_switch::verify_engine_package(&candidate, "engine-b", &shell, &digest).err().expect("a test-fault package is refused outside a test");
    assert!(refused.message.contains("test-fault"), "the verifier names the refusal: {}", refused.message);
    std::env::set_var("NODE_TEST_CONTEXT", "1");
    let accepted = engine_switch::verify_engine_package(&candidate, "engine-b", &shell, &digest);
    std::env::remove_var("NODE_TEST_CONTEXT");
    assert!(accepted.is_ok(), "the same package verifies inside a Node test process");
    fs::remove_dir_all(root).ok();
}

#[test]
fn a_test_fault_marker_without_artifact_records_is_still_refused() {
    let _context_guard = TEST_CONTEXT_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = scratch("test-hooks-no-records");
    let install = root.join("installation");
    fs::create_dir_all(install.join("shell")).unwrap();
    let shell = shell_release(&install);
    let candidate = root.join("candidate");
    write_engine(&candidate, "engine-b", "shell-g0");
    // A manifest that lists no artifacts skips the artifact-set check; the marker on disk must still be refused outside a test process.
    let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(candidate.join("build.json")).unwrap()).unwrap();
    manifest["artifacts"] = serde_json::json!([]);
    fs::write(candidate.join("build.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    fs::write(candidate.join(".DESZO-TEST-FAULT-HOOKS"), b"DESZO_TEST_FAULT_HOOKS_V1
").unwrap();
    let digest = candidate_digest(&candidate).unwrap();
    std::env::remove_var("NODE_TEST_CONTEXT");
    let refused = engine_switch::verify_engine_package(&candidate, "engine-b", &shell, &digest).err().expect("the marker is refused without a test process");
    assert!(refused.message.contains("test-fault"), "the refusal names the marker: {}", refused.message);
    fs::remove_dir_all(root).ok();
}
