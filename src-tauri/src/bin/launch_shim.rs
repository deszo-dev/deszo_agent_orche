//! Native launch shim (ADR-0002 section 4).
//!
//! Node starts this process with `--pipe <name> --rendezvous <id> -- <program> [args...]`. The shim asks the supervisor for
//! the run's Job through an authenticated rendezvous, creates the CLI suspended, assigns it to that Job, and only then
//! resumes it, so no provider or check code runs before containment. Stdio handles pass through unchanged, so Node keeps
//! stream capture. The shim stays outside the Job, returns the CLI exit code, and fails closed with 120-122 otherwise.

use std::env;
use std::process::exit;

// Shim failures use values a CLI does not return, so a real CLI exit code is never mistaken for a containment failure.
// The runtime maps exactly these values to spawn failures (runtime/core/supervisor-client.mjs).
pub const EXIT_RENDEZVOUS_FAILED: i32 = 0x7DE5_0120;
pub const EXIT_ASSIGNMENT_FAILED: i32 = 0x7DE5_0121;
pub const EXIT_SPAWN_FAILED: i32 = 0x7DE5_0122;

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub pipe: String,
    pub rendezvous: String,
    pub program: String,
    pub arguments: Vec<String>,
}

pub fn parse_invocation(args: &[String]) -> Result<Invocation, String> {
    let mut pipe = None;
    let mut rendezvous = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--" => {
                let program = args.get(index + 1).ok_or("no program after --")?.clone();
                return Ok(Invocation {
                    pipe: pipe.ok_or("--pipe is required")?,
                    rendezvous: rendezvous.ok_or("--rendezvous is required")?,
                    program,
                    arguments: args[index + 2..].to_vec(),
                });
            }
            "--pipe" => { pipe = Some(args.get(index + 1).ok_or("--pipe needs a value")?.clone()); index += 2; }
            "--rendezvous" => { rendezvous = Some(args.get(index + 1).ok_or("--rendezvous needs a value")?.clone()); index += 2; }
            other => return Err(format!("unexpected argument {other}")),
        }
    }
    Err("the command must follow --".into())
}

/// Windows argument quoting that CreateProcess and the CLI's own argv parser both accept.
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

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let invocation = match parse_invocation(&args) {
        Ok(invocation) => invocation,
        Err(message) => {
            eprintln!("deszo-launch-shim: {message}");
            exit(EXIT_SPAWN_FAILED);
        }
    };
    #[cfg(windows)]
    exit(native::run(&invocation));
    #[cfg(not(windows))]
    {
        let _ = invocation;
        eprintln!("deszo-launch-shim runs only on Windows.");
        exit(EXIT_SPAWN_FAILED);
    }
}

#[cfg(windows)]
mod native {
    use super::{command_line, Invocation, EXIT_ASSIGNMENT_FAILED, EXIT_RENDEZVOUS_FAILED, EXIT_SPAWN_FAILED};
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, DuplicateHandle, GetHandleInformation, DUPLICATE_SAME_ACCESS, GENERIC_READ, GENERIC_WRITE,
        HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::Threading::{CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess, InitializeProcThreadAttributeList,
        ResumeThread, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT,
        INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW};

    // An attribute list that passes exactly the listed handles to the child, and is freed when it goes out of scope.
    struct AttributeList { buffer: Vec<usize> }
    impl AttributeList {
        fn with_handles(handles: &[HANDLE]) -> Result<AttributeList, String> {
            let mut size = 0usize;
            unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
            let words = size.div_ceil(std::mem::size_of::<usize>());
            let mut list = AttributeList { buffer: vec![0usize; words] };
            if unsafe { InitializeProcThreadAttributeList(list.ptr(), 1, 0, &mut size) } == 0 {
                return Err("the attribute list could not be initialised".into());
            }
            let ok = unsafe { UpdateProcThreadAttribute(list.ptr(), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, handles.as_ptr() as *const c_void,
                handles.len() * std::mem::size_of::<HANDLE>(), std::ptr::null_mut(), std::ptr::null_mut()) };
            if ok == 0 { return Err("the handle list could not be set".into()); }
            Ok(list)
        }
        fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST { self.buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST }
    }
    impl Drop for AttributeList {
        fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.ptr()) } }
    }

    // The stdio handles the CLI receives, in stdin, stdout, stderr order. A handle that is not inheritable is copied as an
    // inheritable one, because CreateProcess rejects a handle list that names a non-inheritable handle. Every other
    // inheritable handle of this process stays here.
    fn inheritable_stdio() -> Result<[HANDLE; 3], String> {
        let mut out = [std::ptr::null_mut::<c_void>(); 3];
        for (slot, id) in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].into_iter().enumerate() {
            let handle = unsafe { GetStdHandle(id) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE { continue; }
            let mut flags = 0u32;
            if unsafe { GetHandleInformation(handle, &mut flags) } != 0 && flags & HANDLE_FLAG_INHERIT != 0 {
                out[slot] = handle;
                continue;
            }
            let mut copy: HANDLE = std::ptr::null_mut();
            let ok = unsafe { DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &mut copy, 0, 1, DUPLICATE_SAME_ACCESS) };
            if ok == 0 { return Err("a standard stream could not be made inheritable".into()); }
            out[slot] = copy;
        }
        Ok(out)
    }

    fn wide(text: &str) -> Vec<u16> { std::ffi::OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect() }

    // A newline-delimited JSON exchange over the supervisor's named pipe. The pipe handle is non-inheritable.
    struct Pipe(HANDLE);
    impl Pipe {
        fn open(name: &str) -> Result<Pipe, String> {
            let handle = unsafe { CreateFileW(wide(name).as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, std::ptr::null(), OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut()) };
            if handle == INVALID_HANDLE_VALUE { Err("the supervisor pipe is unavailable".into()) } else { Ok(Pipe(handle)) }
        }
        fn send(&self, line: &str) -> Result<(), String> {
            let bytes = format!("{line}\n").into_bytes();
            let mut written = 0u32;
            let ok = unsafe { WriteFile(self.0, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut()) };
            if ok == 0 || written as usize != bytes.len() { Err("the supervisor pipe rejected a write".into()) } else { Ok(()) }
        }
        fn receive_line(&self) -> Result<String, String> {
            let mut line = Vec::new();
            loop {
                let mut byte = 0u8;
                let mut read = 0u32;
                let ok = unsafe { ReadFile(self.0, &mut byte, 1, &mut read, std::ptr::null_mut()) };
                if ok == 0 || read == 0 { return Err("the supervisor closed the pipe".into()); }
                if byte == b'\n' { return String::from_utf8(line).map_err(|_| "a non-UTF-8 reply".to_string()); }
                line.push(byte);
                if line.len() > 4096 { return Err("the supervisor reply is too long".into()); }
            }
        }
    }
    impl Drop for Pipe { fn drop(&mut self) { unsafe { CloseHandle(self.0) }; } }

    // Asks for the run Job. The supervisor duplicates a restricted assign-only handle into this process and returns its value.
    fn rendezvous(invocation: &Invocation) -> Result<HANDLE, String> {
        let pipe = Pipe::open(&invocation.pipe)?;
        pipe.send(&format!(r#"{{"op":"rendezvous","rendezvousId":"{}"}}"#, invocation.rendezvous))?;
        // Replies use the supervisor's envelope: { "id", "result": { ... } } or { "id", "error": { "code", "message" } }.
        let reply: serde_json::Value = serde_json::from_str(&pipe.receive_line()?).map_err(|_| "an unreadable supervisor reply".to_string())?;
        if let Some(message) = reply.pointer("/error/message").and_then(|value| value.as_str()) { return Err(message.to_string()); }
        let value = reply.pointer("/result/jobHandle").and_then(|value| value.as_u64()).ok_or("the supervisor sent no Job handle")?;
        Ok(value as usize as HANDLE)
    }

    fn report(invocation: &Invocation, exit_code: i32) {
        if let Ok(pipe) = Pipe::open(&invocation.pipe) {
            let _ = pipe.send(&format!(r#"{{"op":"result","rendezvousId":"{}","exitCode":{}}}"#, invocation.rendezvous, exit_code));
        }
    }

    pub fn run(invocation: &Invocation) -> i32 {
        let job = match rendezvous(invocation) {
            Ok(job) => job,
            Err(message) => { eprintln!("deszo-launch-shim: {message}; the process was not started."); return EXIT_RENDEZVOUS_FAILED; }
        };
        let mut command = wide(&command_line(&invocation.program, &invocation.arguments));
        // A bare program name is searched on PATH through the command line; an explicit path is the application itself.
        let explicit_path = invocation.program.contains(['\\', '/', ':']);
        let application = if explicit_path { wide(&invocation.program) } else { Vec::new() };
        let application_name = if explicit_path { application.as_ptr() } else { std::ptr::null() };
        let stdio = match inheritable_stdio() {
            Ok(stdio) => stdio,
            Err(message) => {
                eprintln!("deszo-launch-shim: {message}; nothing ran.");
                unsafe { CloseHandle(job) };
                report(invocation, EXIT_SPAWN_FAILED);
                return EXIT_SPAWN_FAILED;
            }
        };
        let mut listed: Vec<HANDLE> = Vec::new();
        for handle in stdio { if !handle.is_null() && !listed.contains(&handle) { listed.push(handle); } }
        let mut attributes = match AttributeList::with_handles(&listed) {
            Ok(list) => list,
            Err(message) => {
                eprintln!("deszo-launch-shim: {message}; nothing ran.");
                unsafe { CloseHandle(job) };
                report(invocation, EXIT_SPAWN_FAILED);
                return EXIT_SPAWN_FAILED;
            }
        };
        let startup = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                dwFlags: STARTF_USESTDHANDLES,
                hStdInput: stdio[0],
                hStdOutput: stdio[1],
                hStdError: stdio[2],
                ..unsafe { std::mem::zeroed() }
            },
            lpAttributeList: attributes.ptr(),
        };
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // bInheritHandles is required for an explicit handle list; the list limits the inheritance to the stdio handles.
        let created = unsafe { CreateProcessW(application_name, command.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, std::ptr::null::<c_void>(), std::ptr::null(),
            &startup as *const STARTUPINFOEXW as *const STARTUPINFOW, &mut process) };
        if created == 0 {
            eprintln!("deszo-launch-shim: the process could not be created; nothing ran.");
            unsafe { CloseHandle(job) };
            report(invocation, EXIT_SPAWN_FAILED);
            return EXIT_SPAWN_FAILED;
        }
        // Containment precedes resume: if the assignment fails, the suspended CLI never runs.
        let assigned = unsafe { AssignProcessToJobObject(job, process.hProcess) };
        if assigned == 0 {
            unsafe { TerminateProcess(process.hProcess, EXIT_ASSIGNMENT_FAILED as u32) };
            eprintln!("deszo-launch-shim: the process could not be assigned to its Job; it was terminated before it ran.");
            unsafe { CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job) };
            report(invocation, EXIT_ASSIGNMENT_FAILED);
            return EXIT_ASSIGNMENT_FAILED;
        }
        unsafe { ResumeThread(process.hThread) };
        unsafe { WaitForSingleObject(process.hProcess, INFINITE) };
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(process.hProcess, &mut code) };
        unsafe { CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job) };
        report(invocation, code as i32);
        code as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> { values.iter().map(|value| value.to_string()).collect() }

    #[test]
    fn parses_the_pipe_rendezvous_and_the_command_after_double_dash() {
        let parsed = parse_invocation(&strings(&["--pipe", r"\\.\pipe\deszo-x", "--rendezvous", "abc", "--", "codex", "exec", "--json"])).unwrap();
        assert_eq!(parsed, Invocation { pipe: r"\\.\pipe\deszo-x".into(), rendezvous: "abc".into(), program: "codex".into(), arguments: strings(&["exec", "--json"]) });
    }

    #[test]
    fn refuses_a_command_without_a_program_or_without_rendezvous() {
        assert!(parse_invocation(&strings(&["--pipe", "p", "--rendezvous", "r", "--"])).is_err());
        assert!(parse_invocation(&strings(&["--pipe", "p", "--", "codex"])).is_err());
        assert!(parse_invocation(&strings(&["--pipe", "p", "--rendezvous", "r", "codex"])).is_err());
    }

    #[test]
    fn quotes_arguments_the_way_the_windows_argv_parser_reads_them() {
        assert_eq!(quote_argument("plain"), "plain");
        assert_eq!(quote_argument("two words"), "\"two words\"");
        assert_eq!(quote_argument(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_argument(r"C:\dir\"), r"C:\dir\");
        assert_eq!(quote_argument(r#"C:\dir with space\"#), r#""C:\dir with space\\""#);
        assert_eq!(quote_argument(""), "\"\"");
    }

    #[test]
    fn builds_a_command_line_with_the_program_first() {
        assert_eq!(command_line("node", &strings(&["-e", "1 + 1"])), "node -e \"1 + 1\"");
    }
}
