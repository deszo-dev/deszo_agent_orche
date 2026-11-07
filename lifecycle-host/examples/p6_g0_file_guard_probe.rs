#![cfg(windows)]

use serde_json::json;
use std::{ffi::OsStr, fs::OpenOptions, io::{self, Write}, os::windows::ffi::OsStrExt, path::Path, ptr::null_mut};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, GENERIC_READ},
    Storage::FileSystem::{
        CreateFileW, DeleteFileW, GetFileInformationByHandle, MoveFileExW,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH, OPEN_EXISTING,
    },
};

fn wide(value: &OsStr) -> Vec<u16> { value.encode_wide().chain(std::iter::once(0)).collect() }

fn open(path: &Path, access: u32, share: u32) -> Result<HANDLE, u32> {
    let path = wide(path.as_os_str());
    let handle = unsafe { CreateFileW(path.as_ptr(), access, share, null_mut(), OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut()) };
    if handle == INVALID_HANDLE_VALUE { Err(unsafe { GetLastError() }) } else { Ok(handle) }
}

fn identity(handle: HANDLE) -> Result<serde_json::Value, u32> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 { return Err(unsafe { GetLastError() }); }
    Ok(json!({
        "volumeSerial": info.dwVolumeSerialNumber,
        "fileIndexHigh": info.nFileIndexHigh,
        "fileIndexLow": info.nFileIndexLow,
        "sizeHigh": info.nFileSizeHigh,
        "sizeLow": info.nFileSizeLow,
        "lastWriteHigh": info.ftLastWriteTime.dwHighDateTime,
        "lastWriteLow": info.ftLastWriteTime.dwLowDateTime
    }))
}

fn hold(paths: &[String]) -> Result<(), String> {
    let mut handles = Vec::new();
    let mut files = Vec::new();
    for value in paths {
        let path = Path::new(value);
        let handle = open(path, GENERIC_READ, FILE_SHARE_READ).map_err(|code| format!("CreateFile guard refused {} with Win32 error {code}", path.display()))?;
        match identity(handle) {
            Ok(id) => { files.push(json!({"path": path, "identity": id})); handles.push(handle); }
            Err(code) => { unsafe { CloseHandle(handle); } for prior in handles { unsafe { CloseHandle(prior); } } return Err(format!("GetFileInformationByHandle failed with Win32 error {code}")); }
        }
    }
    println!("{}", json!({"event":"guard_ready", "shareMode":"FILE_SHARE_READ", "files":files}));
    io::stdout().flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
    for handle in handles { unsafe { CloseHandle(handle); } }
    println!("{}", json!({"event":"guard_released"}));
    Ok(())
}

fn write_probe(path: &Path) -> Result<(), u32> {
    let mut file = OpenOptions::new().write(true).open(path).map_err(|error| error.raw_os_error().unwrap_or(0) as u32)?;
    file.write_all(&[0x5a]).map_err(|error| error.raw_os_error().unwrap_or(0) as u32)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else { eprintln!("usage: p6_g0_file_guard_probe <hold|try-guard|try-write|try-delete|try-rename> ..."); std::process::exit(2); };
    let rest: Vec<String> = args.collect();
    let result = match command.as_str() {
        "hold" if !rest.is_empty() => hold(&rest),
        "try-guard" if rest.len() == 1 => match open(Path::new(&rest[0]), GENERIC_READ, FILE_SHARE_READ) {
            Ok(handle) => { let _ = unsafe { CloseHandle(handle) }; println!("{}", json!({"opened":true})); Ok(()) },
            Err(code) => { println!("{}", json!({"opened":false,"win32Error":code})); Ok(()) }
        },
        "try-write" if rest.len() == 1 => match write_probe(Path::new(&rest[0])) {
            Ok(()) => { println!("{}", json!({"write":"succeeded"})); Ok(()) },
            Err(code) => { println!("{}", json!({"write":"refused","win32Error":code})); Ok(()) }
        },
        "try-delete" if rest.len() == 1 => { let path = wide(Path::new(&rest[0]).as_os_str()); let ok = unsafe { DeleteFileW(path.as_ptr()) }; println!("{}", json!({"deleted":ok != 0,"win32Error":if ok == 0 { Some(unsafe { GetLastError() }) } else { None }})); Ok(()) },
        "try-rename" if rest.len() == 2 => { let source = wide(Path::new(&rest[0]).as_os_str()); let target = wide(Path::new(&rest[1]).as_os_str()); let ok = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) }; println!("{}", json!({"renamed":ok != 0,"win32Error":if ok == 0 { Some(unsafe { GetLastError() }) } else { None }})); Ok(()) },
        _ => Err("invalid command arguments".to_string()),
    };
    if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
}
