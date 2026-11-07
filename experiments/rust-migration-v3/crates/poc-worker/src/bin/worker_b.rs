fn main() {
    if std::env::args().any(|arg| arg == "--child-probe") {
        loop { std::thread::sleep(std::time::Duration::from_secs(30)); }
    }
    if let Err(err) = poc_worker::run(poc_protocol::WorkerVariant::B) {
        eprintln!("worker-b: {err}");
        std::process::exit(2);
    }
}

