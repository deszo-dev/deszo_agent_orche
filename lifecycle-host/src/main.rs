use deszo_lifecycle_host::{candidate_digest, run_custody_service, Host, HostConfig, ServiceConfig};
use std::{env, fs, path::PathBuf, process::ExitCode};

fn usage() -> ! {
    eprintln!(
        "usage: deszo-lifecycle-host run --config <json> | custody-serve --config <json> | digest-candidate --path <directory>"
    );
    std::process::exit(2)
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let Some(command) = args.next() else { usage() };
    let rest: Vec<String> = args.collect();
    match command.as_str() {
        "digest-candidate" => {
            let path = rest
                .windows(2)
                .find(|v| v[0] == "--path")
                .map(|v| PathBuf::from(&v[1]))
                .unwrap_or_else(|| usage());
            match candidate_digest(&path) {
                Ok(digest) => {
                    println!("{digest}");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("candidate refused: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        "custody-serve" => {
            let path = rest
                .windows(2)
                .find(|v| v[0] == "--config")
                .map(|v| PathBuf::from(&v[1]))
                .unwrap_or_else(|| usage());
            let config: ServiceConfig = match fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|v| serde_json::from_slice(&v).map_err(|e| e.to_string()))
            {
                Ok(config) => config,
                Err(error) => {
                    eprintln!("custody service config refused: {error}");
                    return ExitCode::FAILURE;
                }
            };
            match run_custody_service(config) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("custody service stopped: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        "run" => {
            let path = rest
                .windows(2)
                .find(|v| v[0] == "--config")
                .map(|v| PathBuf::from(&v[1]))
                .unwrap_or_else(|| usage());
            let config: HostConfig = match fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|v| serde_json::from_slice(&v).map_err(|e| e.to_string()))
            {
                Ok(config) => config,
                Err(error) => {
                    eprintln!("host config refused: {error}");
                    return ExitCode::FAILURE;
                }
            };
            match Host::start(config).and_then(|mut host| host.run()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("lifecycle host stopped: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => usage(),
    }
}
