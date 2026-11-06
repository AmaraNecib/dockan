//! Opt-in real WebView2/IPC fixture. No production setup or owner data directory
//! is used. The driver exercises the production command registration unchanged.
use super::*;
use std::sync::atomic::{AtomicI32, Ordering};

#[test]
#[ignore = "requires Windows interactive desktop, installed browser tooling and built renderer"]
fn backup_restore_real_webview_journey() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
    let evidence = repo.join(".scratch/evidence/402");
    let root = evidence.join(format!("native-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()));
    std::fs::create_dir_all(&root).unwrap();
    let seeded = Command::new("bun").current_dir(&repo).args(["apps/api/src/test-support/native-restore-fixture.ts"]).arg(&root).arg("create-webview").output().unwrap();
    assert!(seeded.status.success(), "{}", String::from_utf8_lossy(&seeded.stderr));
    let (cdp_port, cdp_reservation) = reserve_port().unwrap();
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", format!("--remote-debugging-port={cdp_port}"));
    drop(cdp_reservation);
    let (port, reservation) = reserve_port().unwrap();
    let config = SidecarConfig {
        binary: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!("dokan-api-x86_64-pc-windows-msvc{}", std::env::consts::EXE_SUFFIX)),
        data_dir: root.join("current"), port_root: root.join("current/run"),
        web_dist: if std::env::var_os("DOKAN_NATIVE_RESTORE_BEFORE").is_some() { evidence.join("before-dist") } else { repo.join("apps/web/dist") }, port, boot_token: generate_boot_token(),
    };
    assert!(config.web_dist.join("index.html").is_file(), "build the real renderer before the native journey");
    let status = Arc::new(AtomicI32::new(-1));
    let driver_status = Arc::clone(&status);
    let record = serde_json::json!({"root":root,"origin":format!("http://127.0.0.1:{port}"),"cdpPort":cdp_port,"pid":std::process::id()});
    std::fs::write(evidence.join("native-current.json"), record.to_string()).unwrap();
    let app = crate::app_builder().any_thread().setup(move |app| {
        let sidecar = launch_verified_sidecar_with_reservation(&config, reservation)?;
        {
            let state = app.state::<SidecarState>();
            let mut slot = state.0.lock().unwrap();
            slot.config = Some(config.clone());
            assert!(install_sidecar(&mut slot, sidecar));
        }
        app.add_capability(backup_restore_capability(port).to_string())?;
        app.add_capability(backup_reveal_capability(port).to_string())?;
        let window = app.get_webview_window("main").unwrap();
        window.set_title("Dokan restore verification")?;
        window.navigate(setup_navigation_url(port, &config.boot_token).parse()?)?;
        let handle = app.handle().clone();
        thread::spawn(move || {
            let result = Command::new("bun").current_dir(&repo).arg("apps/desktop/tests/restore-webview.ts").arg(evidence.join("native-current.json")).output();
            match result {
                Ok(out) => {
                    let _ = std::fs::write(root.join("driver.log"), [out.stdout, out.stderr].concat());
                    driver_status.store(out.status.code().unwrap_or(1), Ordering::SeqCst);
                }
                Err(error) => { let _ = std::fs::write(root.join("driver.log"), error.to_string()); driver_status.store(1, Ordering::SeqCst); }
            }
            kill_sidecar(&handle);
            handle.exit(0);
        });
        Ok(())
    }).build(tauri::generate_context!()).unwrap();
    app.run_return(|app, event| { if matches!(event, tauri::RunEvent::Exit) { kill_sidecar(app); } });
    assert_eq!(status.load(Ordering::SeqCst), 0, "read native-current.json root/driver.log for actual Webview assertions");
}
