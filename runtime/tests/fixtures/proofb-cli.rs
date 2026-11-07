use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

fn event(value: &str) {
    println!("{value}");
}

fn json_string(source: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = source.find(&needle)? + needle.len();
    let rest = source[start..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn fixture_dir() -> PathBuf {
    env::var_os("DESZO_PROOFB_FIXTURE_STATE")
        .map(PathBuf::from)
        .expect("fixture state directory is required")
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.as_slice() == ["--help"] {
        println!("Usage: codex [OPTIONS] <COMMAND>\n--ask-for-approval <policy>");
        return;
    }
    if args.as_slice() == ["exec", "--help"] {
        println!("Usage: codex exec [OPTIONS] [PROMPT]\n--json\n--sandbox <sandbox>\n--ephemeral\n--ignore-user-config\n--ignore-rules\n--skip-git-repo-check");
        return;
    }
    if args.iter().any(|arg| arg == "--version") {
        println!("Deszo Proof B local fixture CLI 1.0");
        return;
    }
    if args.first().is_some_and(|arg| arg == "login") {
        println!("Logged in using ChatGPT");
        return;
    }

    let model = args
        .windows(2)
        .find(|pair| pair[0] == "--model")
        .map(|pair| pair[1].as_str())
        .unwrap_or("fixture-echo");
    let mut prompt = String::new();
    io::stdin().read_to_string(&mut prompt).expect("read provider prompt");

    if env::var_os("DESZO_LIFECYCLE_HOST_CAPABILITY").is_some()
        || env::var_os("DESZO_LIFECYCLE_HOST_ADDRESS").is_some()
    {
        let _ = fs::write(fixture_dir().join("provider-host-capability-leak.marker"), "leaked");
    }

    if model == "fixture-fail-once" {
        let marker = fixture_dir().join("parent-watcher-failed.marker");
        if OpenOptions::new().write(true).create_new(true).open(marker).is_ok() {
            event(r#"{"type":"thread.started","thread_id":"proofb-parent"}"#);
            event(r#"{"type":"error","message":"Deterministic local fixture interruption."}"#);
            std::process::exit(1);
        }
    }

    if model == "fixture-slow-child" {
        use std::os::windows::process::CommandExt;
        let fixture = fixture_dir();
        let child = Command::new("cmd.exe")
            .args(["/d", "/s", "/c", "ping -n 300 127.0.0.1 >nul"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn contained provider descendant");
        fs::write(fixture.join("slow-provider.pid"), std::process::id().to_string()).expect("write provider PID");
        fs::write(fixture.join("slow-descendant.pid"), child.id().to_string()).expect("write descendant PID");
        // Output while it runs, so that a Host-owned CLI's spool holds bytes across an application replacement.
        event(r#"{"type":"thread.started","thread_id":"proofb-slow-child"}"#);
        for tick in 0..240 {
            event(&format!(r#"{{"type":"progress","tick":{tick}}}"#));
            thread::sleep(Duration::from_secs(1));
        }
        return;
    }

    // Supervised write proof: a leader and a descendant run in the workspace, and the leader writes Git objects and refs into its repository
    // every quarter second until it is ended. Each tick is logged, so the proof can show that the writes stopped with the process tree.
    if model == "fixture-git-writer" {
        use std::os::windows::process::CommandExt;
        let fixture = fixture_dir();
        let cwd = env::current_dir().expect("workspace directory");
        let descendant = Command::new("cmd.exe")
            .args(["/d", "/s", "/c", "ping -n 300 127.0.0.1 >nul"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn writer descendant");
        fs::write(fixture.join("writer.pid"), std::process::id().to_string()).expect("write writer PID");
        fs::write(fixture.join("writer-descendant.pid"), descendant.id().to_string()).expect("write writer descendant PID");
        event(r#"{"type":"thread.started","thread_id":"proofb-git-writer"}"#);
        for tick in 0..100_000u32 {
            let file = format!("tick-{tick}.txt");
            fs::write(cwd.join(&file), format!("tick {tick}
")).expect("write tick file");
            let hash = Command::new("git").args(["hash-object", "-w", &file]).current_dir(&cwd).output().expect("git hash-object");
            let sha = String::from_utf8_lossy(&hash.stdout).trim().to_string();
            let reference = format!("refs/deszo-proof/tick-{tick}");
            let updated = Command::new("git").args(["update-ref", reference.as_str(), sha.as_str()]).current_dir(&cwd).status().expect("git update-ref");
            let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let mut log = OpenOptions::new().create(true).append(true).open(fixture.join("writes.log")).expect("open writes log");
            writeln!(log, "{tick} {millis} {}", updated.success()).expect("log tick");
            event(&format!(r#"{{"type":"progress","tick":{tick}}}"#));
            thread::sleep(Duration::from_millis(250));
        }
        return;
    }

    let answer = if model == "fixture-lifecycle-proposal" {
        let candidate = fs::read_to_string(PathBuf::from("candidate.json")).expect("read staged candidate identity");
        let candidate_id = json_string(&candidate, "candidateId").expect("candidateId");
        let digest = json_string(&candidate, "candidateDigest").expect("candidateDigest");
        let checkpoint = json_string(&candidate, "continuationCheckpointId").expect("continuationCheckpointId");
        format!(
            "Candidate reviewed; deterministic local checks passed.\nREQUEST_LIFECYCLE_ACTION {{\"action\":\"application.activate_candidate\",\"target_version\":\"{candidate_id}\",\"candidate_digest\":\"{digest}\",\"continuation_checkpoint_id\":\"{checkpoint}\"}}"
        )
    } else {
        "{\"message\":\"Deterministic local fixture response.\"}".to_string()
    };
    event(r#"{"type":"thread.started","thread_id":"proofb-local-fixture"}"#);
    let escaped = answer.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r");
    println!(r#"{{"type":"item.completed","item":{{"type":"agent_message","text":"{escaped}"}}}}"#);
    event(r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}"#);
}
