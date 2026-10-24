fn main() {
    println!("cargo:rerun-if-env-changed=DESZO_DESKTOP_BUILD_ID");
    let build_id = std::env::var("DESZO_DESKTOP_BUILD_ID").unwrap_or_else(|_| {
        let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
        format!("deszo-{}", version.replace('.', "-"))
    });
    assert!(
        !build_id.is_empty()
            && build_id.len() <= 64
            && build_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "DESZO_DESKTOP_BUILD_ID must be a short alphanumeric build identity"
    );
    println!("cargo:rustc-env=DESZO_DESKTOP_BUILD_ID={build_id}");
    tauri_build::build()
}
