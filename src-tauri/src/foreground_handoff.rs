//! Cooperative foreground handoff to the independently installed launcher before a normal application close.
//! This transfers Windows UI activation eligibility only. It carries no Deszo credential, consent or run authority.
use serde_json::Value;
use std::{ffi::c_void, io::{Read, Write}, os::windows::process::CommandExt, process::{Command, Stdio}, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::{CloseHandle, FILETIME, HANDLE}, System::Threading::{GetProcessTimes, OpenProcess, WaitForSingleObject}};

const CLIENT: &str = "C:/Program Files/Deszo Control Host/deszo-control.exe";
const REQUEST: &str = "deszo-foreground-launcher";

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> *mut c_void;
    fn GetWindowThreadProcessId(window: *mut c_void, process: *mut u32) -> u32;
    fn AllowSetForegroundWindow(process: u32) -> i32;
}

fn owns_foreground() -> bool {
    let mut owner = 0;
    unsafe { GetWindowThreadProcessId(GetForegroundWindow(), &mut owner); }
    owner == std::process::id()
}

struct LauncherIdentity { pid: u32, creation_time: u64 }
struct ProcessHandle(HANDLE);
impl Drop for ProcessHandle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }

fn launcher_pid(bytes: &[u8], application_pid: u32) -> Result<LauncherIdentity, String> {
    let packets: Vec<Value> = std::str::from_utf8(bytes).map_err(|_| "Invalid native reply")?.lines()
        .map(serde_json::from_str).collect::<Result<_, _>>().map_err(|_| "Invalid native reply")?;
    if packets.len() != 2 || packets[0]["event"] != "native_connected" || packets[1]["id"] != REQUEST || packets[1].get("error").is_some() {
        return Err("The protected helper did not authenticate the host or returned a different reply".into());
    }
    let result = &packets[1]["result"];
    if result["applicationPid"].as_u64() != Some(application_pid as u64) { return Err("Launcher identity belongs to another application".into()); }
    let launcher = &result["launcher"];
    let pid = launcher["pid"].as_u64().filter(|p| *p > 0 && *p < u32::MAX as u64 && *p != application_pid as u64).ok_or("Invalid launcher PID")?;
    let birth = launcher["creationTime"].as_str().ok_or("Missing launcher creation identity")?;
    let image = launcher["imageSha256"].as_str().ok_or("Missing launcher image identity")?;
    if birth.is_empty() || !birth.bytes().all(|b| b.is_ascii_digit()) || image.len() != 64 || !image.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Incomplete launcher identity".into());
    }
    let creation_time = birth.parse::<u64>().map_err(|_| "Invalid launcher birth")?;
    if creation_time == 0 { return Err("Missing launcher birth".into()); }
    Ok(LauncherIdentity { pid: pid as u32, creation_time }) // ASFW_ANY (u32::MAX) is deliberately excluded.
}

fn trusted_launcher(policy: &str) -> Result<LauncherIdentity, String> {
    let mut child = Command::new(CLIENT).arg("client").creation_flags(0x08000000)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let document = serde_json::json!({"id":REQUEST,"method":"application.launcher_identity","params":{"policyId":policy}}).to_string() + "\n";
    let write = child.stdin.take().ok_or("Missing native input").and_then(|mut input| input.write_all(document.as_bytes()).map_err(|_| "Native request write failed"));
    if write.is_err() { let _ = child.kill(); let _ = child.wait(); return Err("Native request write failed".into()); }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() { return Err("Native helper refused the identity request".into()); }
                let mut bytes = Vec::new();
                child.stdout.take().ok_or("Missing native reply")?.take(16385).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                if bytes.len() > 16384 { return Err("Native reply exceeds its bound".into()); }
                return launcher_pid(&bytes, std::process::id());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err("Native launcher identity timed out".into()); }
        }
    }
}

pub fn before_close() {
    if std::env::var_os("DESZO_CONTROL_HOST_PIPE").is_none() || !owns_foreground() { return; }
    let Ok(policy) = std::env::var("DESZO_HOST_POLICY_ID") else { return; };
    let Ok(launcher) = trusted_launcher(&policy) else { return; };
    // Hold the exact process object through delegation: a dead/reused PID cannot become the recipient.
    let handle = unsafe { OpenProcess(0x1000 | 0x00100000, 0, launcher.pid) }; // QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    if handle.is_null() { return; }
    let process = ProcessHandle(handle);
    let mut birth = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut exit = birth; let mut kernel = birth; let mut user = birth;
    if unsafe { GetProcessTimes(process.0, &mut birth, &mut exit, &mut kernel, &mut user) } == 0
        || ((birth.dwHighDateTime as u64) << 32 | birth.dwLowDateTime as u64) != launcher.creation_time
        || unsafe { WaitForSingleObject(process.0, 0) } != 258 { return; }
    // User activity can revoke eligibility between these observations. No synthetic input or global bypass is used.
    if owns_foreground() { unsafe { AllowSetForegroundWindow(launcher.pid); } }
}

#[cfg(test)]
mod tests {
    use super::{launcher_pid, REQUEST};
    fn reply(pid: u64, owner: u32) -> Vec<u8> {
        format!("{{\"event\":\"native_connected\"}}\n{}\n", serde_json::json!({"id":REQUEST,"result":{"applicationPid":owner,"launcher":{"pid":pid,"creationTime":"12345","imageSha256":"a".repeat(64)}}})).into_bytes()
    }
    #[test]
    fn accepts_only_the_authenticated_application_bound_launcher_reply() {
        let identity = launcher_pid(&reply(400, 300), 300).unwrap(); assert_eq!(identity.pid, 400); assert_eq!(identity.creation_time, 12345);
        assert!(launcher_pid(&reply(400, 301), 300).is_err());
        for pid in [0, 300, u32::MAX as u64, u32::MAX as u64 + 1] { assert!(launcher_pid(&reply(pid, 300), 300).is_err()); }
    }
    #[test]
    fn refuses_unverified_or_substituted_helper_output() {
        let valid = String::from_utf8(reply(400, 300)).unwrap();
        for value in [valid.replace("native_connected", "unverified"), valid.replace(REQUEST, "other-request"), valid.replace("12345", "unknown"), valid.replace(&"a".repeat(64), "missing"), valid + "{}\n"] {
            assert!(launcher_pid(value.as_bytes(), 300).is_err());
        }
    }
}
