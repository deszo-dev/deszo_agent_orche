// Test-only Git client for P5-CLOSURE E-08 (interrupted fetch). It runs the real Git for Windows executable named in
// `git-real.txt` beside this executable. While `interrupt-fetch.txt` beside it holds a positive count, each `fetch`
// consumes one count and is interrupted mid-transfer instead: the transport leaves what an interrupted fetch leaves in the
// repository (a partial temporary pack under objects/pack and a stale remote-tracking ref when the marker asks for one)
// and exits like a lost connection ("fatal: early EOF"). Every other command, and every fetch once the count is spent,
// is the real Git.
use std::{env, fs, path::PathBuf, process::Command};

fn repository_root(args: &[String]) -> Option<PathBuf> {
    args.windows(2).find(|pair| pair[0] == "-C").map(|pair| PathBuf::from(&pair[1]))
}

fn main() {
    let exe = env::current_exe().expect("own path");
    let real = fs::read_to_string(exe.with_file_name("git-real.txt")).expect("git-real.txt names the real git.exe");
    let args: Vec<String> = env::args().skip(1).collect();
    let marker = exe.with_file_name("interrupt-fetch.txt");
    if args.iter().any(|arg| arg == "fetch") {
        if let Ok(text) = fs::read_to_string(&marker) {
            let mut parts = text.split_whitespace();
            let count: u32 = parts.next().and_then(|value| value.parse().ok()).unwrap_or(0);
            let stale = parts.next().map(str::to_string);
            if count > 0 {
                fs::write(&marker, format!("{} {}", count - 1, stale.clone().unwrap_or_default())).expect("count down");
                if let Some(root) = repository_root(&args) {
                    let pack = root.join(".git").join("objects").join("pack");
                    let _ = fs::create_dir_all(&pack);
                    let _ = fs::write(pack.join("tmp_pack_p5_interrupted"), b"PACK\x00\x00\x00\x02\x00\x00\x00\x09partial");
                    if let Some(object) = stale.filter(|value| value.len() >= 40) {
                        let refs = root.join(".git").join("refs").join("remotes").join("origin");
                        let _ = fs::create_dir_all(&refs);
                        let _ = fs::write(refs.join("main"), format!("{object}\n"));
                    }
                }
                eprintln!("fatal: early EOF\nfatal: fetch-pack: invalid index-pack output");
                std::process::exit(128);
            }
        }
    }
    let status = Command::new(real.trim()).args(&args).status().expect("run the real git.exe");
    std::process::exit(status.code().unwrap_or(128));
}
