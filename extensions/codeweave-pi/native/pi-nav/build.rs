fn main() {
    let target = std::env::var("TARGET").expect("Cargo always sets TARGET for build scripts");
    println!("cargo:rustc-env=PI_NAV_BUILD_TARGET={target}");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_NAPI_ADDON");

    if std::env::var_os("CARGO_FEATURE_NAPI_ADDON").is_some() {
        napi_build::setup();
    }
}
