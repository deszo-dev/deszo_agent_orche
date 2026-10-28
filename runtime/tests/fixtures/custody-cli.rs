// Deterministic provider fixture for Process Custody tests. It speaks the Codex JSON event stream, needs no model and no
// subscription, and is selected by --model. It records every invocation and the NAMES of its environment (never values)
// so a test can prove that one launch happened and that no lifecycle or custody credential reached the provider.
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn fixture_dir() -> PathBuf {
    env::var_os("CUSTODY_FIXTURE_STATE_DIR")
        .map(PathBuf::from)
        .expect("CUSTODY_FIXTURE_STATE_DIR names the fixture state directory")
}

// One newline-delimited event, flushed at once so that the Host's spool sees output while the CLI is still running.
fn event(line: &str) {
    let mut out = io::stdout().lock();
    writeln!(out, "{line}").expect("write event");
    out.flush().expect("flush event");
}

fn answer(text: &str) {
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
    event(&format!(r#"{{"type":"item.completed","item":{{"type":"agent_message","text":"{escaped}"}}}}"#));
    event(r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}"#);
}

// Reads `key=NUMBER` from the prompt; the prompt carries the test's directives.
fn directive(prompt: &str, key: &str, default: u64) -> u64 {
    prompt
        .split(|c: char| c.is_whitespace() || c == ']' || c == '[')
        .find_map(|token| token.strip_prefix(&format!("{key}=")).and_then(|value| value.parse().ok()))
        .unwrap_or(default)
}

fn text_directive<'a>(prompt: &'a str, key: &str) -> Option<&'a str> {
    prompt
        .split(|c: char| c.is_whitespace() || c == ']' || c == '[')
        .find_map(|token| token.strip_prefix(&format!("{key}=")))
}

#[link(name = "kernel32")]
extern "system" {
    fn GetStdHandle(which: u32) -> isize;
    fn SetHandleInformation(handle: isize, mask: u32, flags: u32) -> i32;
}

// The descendant must not hold this CLI's output pipes open: its standard handles stop being inheritable before it is spawned, so
// the CLI's own streams end with the CLI while the descendant lives on in the Job.
fn stop_inheriting_standard_handles() {
    const HANDLE_FLAG_INHERIT: u32 = 1;
    for which in [-10i32 as u32, -11i32 as u32, -12i32 as u32] {
        unsafe {
            let handle = GetStdHandle(which);
            if handle != 0 && handle != -1 {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

// Appends one numbered line to `path` every 100 ms for `millis`, then exits. Run as a descendant or by the writer models.
fn write_ticks(path: &PathBuf, millis: u64) {
    let started = std::time::Instant::now();
    let mut tick = 0u64;
    while started.elapsed() < Duration::from_millis(millis) {
        let mut file = OpenOptions::new().create(true).append(true).open(path).expect("open marker");
        writeln!(file, "{} {tick}", std::process::id()).expect("write marker");
        tick += 1;
        thread::sleep(Duration::from_millis(100));
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // Descendant mode for `custody-orphan`: no provider protocol, just the marker.
    if args.first().is_some_and(|arg| arg == "--orphan-writer") {
        write_ticks(&PathBuf::from(&args[1]), args[2].parse().expect("orphan duration"));
        return;
    }
    if args.iter().any(|arg| arg == "--version") {
        println!("Deszo Custody fixture CLI 1.0");
        return;
    }
    // The fixture advertises the bounded noninteractive options that the real Custody adapter requires. This lets the real
    // Engine's CLI capability check run unchanged in Process Custody integration tests.
    if args.first().is_some_and(|arg| arg == "--help") {
        println!("--ask-for-approval <never|on-request>\nexec");
        return;
    }
    if args.first().is_some_and(|arg| arg == "exec") && args.get(1).is_some_and(|arg| arg == "--help") {
        println!("--json\n--sandbox <workspace-write>\n--ephemeral\n--ignore-user-config\n--ignore-rules\n--skip-git-repo-check");
        return;
    }
    if args.first().is_some_and(|arg| arg == "login") {
        println!("Logged in using ChatGPT");
        return;
    }
    let model = args.windows(2).find(|pair| pair[0] == "--model").map(|pair| pair[1].clone()).unwrap_or_default();
    let mut prompt = String::new();
    io::stdin().read_to_string(&mut prompt).expect("read provider prompt");

    let dir = fixture_dir();
    let mut log = OpenOptions::new().create(true).append(true).open(dir.join("invocations.log")).expect("open invocation log");
    writeln!(log, "{} {}", std::process::id(), model).expect("record invocation");
    // Names only. A credential in this list is a leak, and the test fails on it.
    let mut names: Vec<String> = env::vars().map(|(name, _)| name).collect();
    names.sort();
    fs::write(dir.join(format!("env-{}.txt", std::process::id())), names.join("\n")).expect("record environment names");

    event(r#"{"type":"thread.started","thread_id":"custody-fixture"}"#);
    match model.as_str() {
        "custody-p2-parent-a" => {
            let marker = env::current_dir().expect("working directory").join("p2-parent-a.log");
            let mut file = OpenOptions::new().create(true).append(true).open(marker).expect("open Parent A side-effect marker");
            writeln!(file, "{} accepted", std::process::id()).expect("record Parent A side effect");
            answer("P2_PARENT_A_OK gate=P2_PARENT_B");
        }
        "custody-p2-fail-once" => {
            let cwd = env::current_dir().expect("working directory");
            let attempts = cwd.join("p2-parent-b-attempts.log");
            let prior = fs::read_to_string(&attempts).unwrap_or_default().lines().count();
            let ordinal = prior + 1;
            let mut log = OpenOptions::new().create(true).append(true).open(&attempts).expect("open Parent B attempt marker");
            writeln!(log, "{} {ordinal}", std::process::id()).expect("record Parent B invocation");
            if ordinal == 1 {
                eprintln!("P2 Parent B deterministic first-attempt failure before its side effect");
                event(r#"{"type":"error","message":"P2 Parent B first attempt failed before side effect."}"#);
                std::process::exit(6);
            }
            if prompt.contains("gate=P2_PARENT_B") {
                let ready = cwd.join("READY-P2_PARENT_B.marker");
                let release = cwd.join("RELEASE-P2_PARENT_B.marker");
                fs::write(&ready, format!("{} ready\n", std::process::id())).expect("write Parent B READY marker");
                let started = std::time::Instant::now();
                while !release.exists() {
                    if started.elapsed() > Duration::from_secs(180) {
                        eprintln!("P2 Parent B gated Custody invocation exceeded its bounded wait");
                        std::process::exit(7);
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
            let mut accepted = OpenOptions::new().create(true).append(true).open(cwd.join("p2-parent-b-accepted.log"))
                .expect("open Parent B accepted side-effect marker");
            writeln!(accepted, "{} accepted", std::process::id()).expect("record Parent B accepted side effect");
            answer("P2_PARENT_B_OK");
        }
        "custody-p2-parent-c" => {
            let cwd = env::current_dir().expect("working directory");
            let count = |name: &str| fs::read_to_string(cwd.join(name)).unwrap_or_default().lines().count();
            let a_count = count("p2-parent-a.log");
            let b_count = count("p2-parent-b-accepted.log");
            if a_count != 1 || b_count != 1 || !prompt.contains("P2_PARENT_B_OK") {
                eprintln!("P2 Parent C verification failed: A effects={a_count}, B effects={b_count}, B output present={}", prompt.contains("P2_PARENT_B_OK"));
                std::process::exit(8);
            }
            let mut file = OpenOptions::new().create(true).append(true).open(cwd.join("p2-parent-c.log"))
                .expect("open Parent C side-effect marker");
            writeln!(file, "{} verified", std::process::id()).expect("record Parent C side effect");
            answer("P2_PARENT_C_OK");
        }
        "custody-p2-gated-repair" => {
            let cwd = env::current_dir().expect("working directory");
            let ready = cwd.join("READY-P2_REPAIR.marker");
            let release = cwd.join("RELEASE-P2_REPAIR.marker");
            fs::write(&ready, format!("{} ready\n", std::process::id())).expect("write Repair READY marker");
            let started = std::time::Instant::now();
            while !release.exists() {
                if started.elapsed() > Duration::from_secs(180) {
                    eprintln!("P2 Repair gated Custody invocation exceeded its bounded wait");
                    std::process::exit(9);
                }
                thread::sleep(Duration::from_millis(50));
            }
            let mut file = OpenOptions::new().create(true).append(true).open(cwd.join("p2-repair-executed.log"))
                .expect("open Repair side-effect marker");
            writeln!(file, "{} verified", std::process::id()).expect("record Repair execution");
            answer("P2_REPAIR_VERIFIED");
        }
        "custody-p2-repair-fail" => {
            eprintln!("P2 deterministic Repair failure");
            event(r#"{"type":"error","message":"P2 Repair failed."}"#);
            std::process::exit(10);
        }
        "custody-p2-gated-repair-fail" => {
            let cwd = env::current_dir().expect("working directory");
            let ready = cwd.join("READY-P2_REPAIR.marker");
            let release = cwd.join("RELEASE-P2_REPAIR.marker");
            fs::write(&ready, format!("{} ready\n", std::process::id())).expect("write Repair READY marker");
            let started = std::time::Instant::now();
            while !release.exists() {
                if started.elapsed() > Duration::from_secs(180) {
                    eprintln!("P2 failed Repair gate exceeded its bounded wait");
                    std::process::exit(11);
                }
                thread::sleep(Duration::from_millis(50));
            }
            eprintln!("P2 Repair failed after Engine absence");
            event(r#"{"type":"error","message":"P2 Repair failed while Engine was absent."}"#);
            std::process::exit(12);
        }
        "custody-p3-auth-fail" => {
            eprintln!("Authentication required; invalid token codex_secret_test_value");
            event(r#"{"type":"error","message":"Authentication required; invalid token codex_secret_test_value."}"#);
            std::process::exit(13);
        }
        "custody-p4-fail" => {
            eprintln!("P4 deterministic ordinary Agent failure");
            eprintln!("EXPANSION_ONLY_P4_DETAIL");
            event(r#"{"type":"error","message":"P4 deterministic ordinary Agent failure."}"#);
            std::process::exit(14);
        }
        "custody-p4-gated-fail" => {
            let gate = text_directive(&prompt, "gate").expect("the prompt names the worker READY/RELEASE gate");
            let cwd = env::current_dir().expect("working directory");
            let ready = cwd.join(format!("READY-{gate}.marker"));
            let release = cwd.join(format!("RELEASE-{gate}.marker"));
            fs::write(&ready, format!("{} ready\n", std::process::id())).expect("write worker READY marker");
            let started = std::time::Instant::now();
            while !release.exists() {
                if started.elapsed() > Duration::from_secs(180) {
                    eprintln!("P4 gated failure fixture exceeded its bounded wait");
                    std::process::exit(16);
                }
                thread::sleep(Duration::from_millis(50));
            }
            eprintln!("P4 deterministic ordinary Agent failure");
            eprintln!("EXPANSION_ONLY_P4_DETAIL");
            event(r#"{"type":"error","message":"P4 deterministic ordinary Agent failure."}"#);
            std::process::exit(14);
        }
        "custody-p4-wait" => answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"awaiting_progress","rationale":"The current evidence does not justify another action.","evidenceRefs":[],"action":{"type":"wait"}}"#),
        "custody-p4-gated-wait" => {
            let cwd = env::current_dir().expect("working directory");
            let ready = cwd.join("READY-P4_JUDGE.marker");
            let release = cwd.join("RELEASE-P4_JUDGE.marker");
            fs::write(&ready, format!("{} ready\n", std::process::id())).expect("write Judge READY marker");
            let started = std::time::Instant::now();
            while !release.exists() {
                if started.elapsed() > Duration::from_secs(180) {
                    eprintln!("P4 gated Judge exceeded its bounded wait");
                    std::process::exit(15);
                }
                thread::sleep(Duration::from_millis(50));
            }
            answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"awaiting_progress","rationale":"The current evidence does not justify another action.","evidenceRefs":[],"action":{"type":"wait"}}"#);
        }
        "custody-p4-repair-result" => answer("P4_REPAIR_OK"),
        "custody-p4-verify" => answer("P4_VERIFIED"),
        "custody-p4-observer" => answer("P4_OBSERVER_RAN"),
        "custody-p4-question" => {
            if prompt.contains("\"ownerInput\"") {
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"awaiting_progress","rationale":"The Owner answer is recorded; the current evidence is now evaluated.","evidenceRefs":[],"action":{"type":"wait"}}"#);
            } else {
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"owner_decision_required","rationale":"Owner input is required to resolve this decision.","evidenceRefs":[],"action":{"type":"request_human_input","question":"Which supported option should be used?","answerSpec":{"type":"choice","options":[{"id":"keep","label":"Keep current behavior"},{"id":"change","label":"Use the permitted change"}]}}}"#);
            }
        }
        "custody-p4-repair" => answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"repair_required","rationale":"The captured failure matches the permitted Repair profile.","evidenceRefs":[],"action":{"type":"request_repair","repairProfileId":"default"}}"#),
        "custody-p4-adaptive" => {
            if prompt.contains("\"attentionKind\":\"repair_approval\"") {
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"repair_acceptable","rationale":"The exact Repair result and required verification are acceptable.","evidenceRefs":[],"action":{"type":"accept_repair"}}"#);
            } else {
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"repair_required","rationale":"The captured failure matches the permitted Repair profile.","evidenceRefs":[],"action":{"type":"request_repair","repairProfileId":"default"}}"#);
            }
        }
        "custody-p4-adaptive-question" => {
            if prompt.contains("\"ownerInput\"") {
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"awaiting_progress","rationale":"The Owner answer is recorded; the current evidence is now evaluated.","evidenceRefs":[],"action":{"type":"wait"}}"#);
            } else if prompt.contains("\"attentionKind\":\"repair_approval\"") {
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"owner_decision_required","rationale":"Owner input is required to resolve this Repair decision.","evidenceRefs":[],"action":{"type":"request_human_input","question":"Choose how to proceed with this Repair result.","answerSpec":{"type":"choice","options":[{"id":"accept","label":"Accept this result"},{"id":"stop","label":"Stop this Repair"}]}}}"#);
            } else {
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"repair_required","rationale":"The captured failure matches the permitted Repair profile.","evidenceRefs":[],"action":{"type":"request_repair","repairProfileId":"default"}}"#);
            }
        }
        "custody-p4-adaptive-reject" => {
            if prompt.contains("\"attentionKind\":\"repair_approval\"") {
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"repair_rejected","rationale":"The Repair result does not satisfy the captured criteria.","evidenceRefs":[],"action":{"type":"reject_repair","reasonCode":"repair_rejected"}}"#);
            } else {
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"repair_required","rationale":"The captured failure matches the permitted Repair profile.","evidenceRefs":[],"action":{"type":"request_repair","repairProfileId":"default"}}"#);
            }
        }
        "custody-p4-evidence" => {
            if prompt.contains("EXPANSION_ONLY_P4_DETAIL") {
                fs::write(dir.join("p4-evidence-expansion-received.txt"), "verified\n").expect("record expanded evidence receipt");
                answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"awaiting_progress","rationale":"The requested evidence was received and evaluated.","evidenceRefs":[],"action":{"type":"wait"}}"#);
                return;
            }
            let catalog = prompt.split("\"referenceCatalog\":[").nth(1).expect("the evidence prompt includes a reference catalog");
            let after_id = catalog.split("\"id\":\"").nth(1).expect("the reference catalog has a bounded item");
            let reference = after_id.split('"').next().expect("the reference id is closed");
            let decision = format!(r#"{{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"evidence_insufficient","rationale":"One issued evidence item is needed for this attention.","evidenceRefs":[],"action":{{"type":"request_evidence","evidenceRefs":["{reference}"]}}}}"#);
            answer(&decision);
        }
        "custody-p4-accept" => answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"repair_acceptable","rationale":"The exact Repair result and required verification are acceptable.","evidenceRefs":[],"action":{"type":"accept_repair"}}"#),
        "custody-p4-reject" => answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"repair_rejected","rationale":"The Repair result does not meet the captured acceptance criteria.","evidenceRefs":[],"action":{"type":"reject_repair","reasonCode":"repair_rejected"}}"#),
        "custody-p4-invalid" => answer(r#"{"schemaVersion":1,"kind":"JudgeDecision","reasonCode":"repair_required","rationale":"Forged authority fields are not accepted.","evidenceRefs":[],"runId":"foreign-run","action":{"type":"request_repair","repairProfileId":"default"}}"#),
        "custody-steady" => {
            let ticks = directive(&prompt, "ticks", 20);
            for tick in 0..ticks {
                event(&format!(r#"{{"type":"progress","tick":{tick}}}"#));
                thread::sleep(Duration::from_millis(500));
            }
            answer("Steady run complete.");
        }
        "custody-stdio" => {
            eprintln!("P1C-10 durable stderr fixture marker");
            let ticks = directive(&prompt, "ticks", 6);
            for tick in 0..ticks {
                event(&format!(r#"{{"type":"progress","tick":{tick}}}"#));
                thread::sleep(Duration::from_millis(500));
            }
            answer("Custody stdout and stderr replay complete.");
        }
        "custody-gated" => {
            let gate = text_directive(&prompt, "gate").expect("the prompt names its READY/RELEASE gate");
            let cwd = env::current_dir().expect("working directory");
            let ready = cwd.join(format!("READY-{gate}.marker"));
            let release = cwd.join(format!("RELEASE-{gate}.marker"));
            fs::write(&ready, format!("{} ready\n", std::process::id())).expect("write READY marker");
            eprintln!("P1C gated Custody invocation is waiting for RELEASE");
            let started = std::time::Instant::now();
            while !release.exists() {
                if started.elapsed() > Duration::from_secs(180) {
                    eprintln!("P1C gated Custody invocation exceeded its bounded wait");
                    std::process::exit(4);
                }
                thread::sleep(Duration::from_millis(50));
            }
            answer("P1C_GATE_RELEASED");
        }
        "custody-verify" => {
            let marker = env::current_dir().expect("working directory").join("custody-writer.log");
            let rows = fs::read_to_string(marker).expect("Node A side-effect record");
            let executions = rows.lines().count();
            if executions != 1 || !prompt.contains("P1C_GATE_RELEASED") {
                eprintln!("P1C verification failed: writer executions={executions}, gate result present={}", prompt.contains("P1C_GATE_RELEASED"));
                std::process::exit(5);
            }
            let mut count = OpenOptions::new().create(true).append(true).open("custody-node-c.log").expect("open Node C counter");
            writeln!(count, "{} verified", std::process::id()).expect("record Node C execution");
            answer("P1C_VERIFY_OK");
        }
        "custody-split" => {
            // A two-byte character is split across two writes, and the first record is a partial line.
            let record = "{\"type\":\"progress\",\"text\":\"Splitté-ünïcode\"}\n";
            let bytes = record.as_bytes();
            let split = record.find('é').expect("the fixture text contains é") + 1;
            let mut out = io::stdout().lock();
            out.write_all(&bytes[..split]).expect("write first half");
            out.flush().expect("flush first half");
            thread::sleep(Duration::from_millis(400));
            out.write_all(&bytes[split..]).expect("write second half");
            out.flush().expect("flush second half");
            drop(out);
            answer("Split output complete.");
        }
        "custody-descendant" => {
            // A descendant inherits this CLI's Job and its pipes; it must end with the CLI's containment, never sooner.
            let child = Command::new("cmd.exe")
                .args(["/d", "/s", "/c", "ping -n 300 127.0.0.1 >nul"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .spawn()
                .expect("spawn descendant");
            fs::write(dir.join("descendant.pid"), child.id().to_string()).expect("record descendant");
            let ticks = directive(&prompt, "ticks", 120);
            for tick in 0..ticks {
                event(&format!(r#"{{"type":"progress","tick":{tick}}}"#));
                thread::sleep(Duration::from_millis(500));
            }
            answer("Descendant run complete.");
        }
        "custody-writer" => {
            // Writes into its own workspace while it runs: the bytes another execution there would conflict with.
            let ticks = directive(&prompt, "ticks", 120);
            let marker = env::current_dir().expect("working directory").join("custody-writer.log");
            for tick in 0..ticks {
                let mut file = OpenOptions::new().create(true).append(true).open(&marker).expect("open marker");
                writeln!(file, "{} {tick}", std::process::id()).expect("write marker");
                event(&format!(r#"{{"type":"progress","tick":{tick}}}"#));
                thread::sleep(Duration::from_millis(500));
            }
            answer("Writer run complete.");
        }
        "custody-orphan" => {
            // The leader starts a descendant in its Job that outlives it, writing a marker for `orphanMs`, and then exits at once.
            stop_inheriting_standard_handles();
            let marker = dir.join("orphan.log");
            let child = Command::new(env::current_exe().expect("fixture path"))
                .args(["--orphan-writer", &marker.to_string_lossy(), &directive(&prompt, "orphanMs", 8000).to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn orphan descendant");
            fs::write(dir.join("descendant.pid"), child.id().to_string()).expect("record descendant");
            answer("Leader exits; its descendant runs on.");
        }
        "custody-exit" => {
            let delay = directive(&prompt, "delayMs", 0);
            if delay > 0 { thread::sleep(Duration::from_millis(delay)); }
            answer("Exiting with the directed code.");
            std::process::exit(directive(&prompt, "code", 3) as i32);
        }
        _ => answer("Deterministic custody fixture response."),
    }
}
