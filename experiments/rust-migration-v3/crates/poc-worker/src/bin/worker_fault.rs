fn main() {
    if let Err(err) = poc_worker::run_fault() {
        eprintln!("worker-fault: {err}");
        std::process::exit(2);
    }
}

