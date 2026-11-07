// Test-only Git client pinned to wire protocol v0. It runs the real Git for Windows executable named in `git-real.txt`
// beside this executable, with `-c protocol.version=0` first. Against a real local repository server that keeps the
// default uploadpack restrictions, a v0 fetch of an unadvertised object ID is genuinely refused by the server
// ("Server does not allow request for unadvertised object"), which is the behavior the P5 enrolled-ref fallback handles.
use std::{env, fs, process::Command};

fn main() {
    let exe = env::current_exe().expect("own path");
    let real = fs::read_to_string(exe.with_file_name("git-real.txt")).expect("git-real.txt names the real git.exe");
    let status = Command::new(real.trim())
        .arg("-c")
        .arg("protocol.version=0")
        .args(env::args_os().skip(1))
        .status()
        .expect("run the real git.exe");
    std::process::exit(status.code().unwrap_or(128));
}
