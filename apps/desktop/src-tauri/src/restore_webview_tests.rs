//! Opt-in real WebView2/IPC fixture. No production setup or owner data directory
//! is used. The driver exercises the production command registration unchanged.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

#[test]
#[ignore = "requires Windows interactive desktop, installed browser tooling and built renderer"]
fn backup_restore_real_webview_journey() {
    assert_eq!(std::env::var("DOKAN_ALLOW_VISIBLE_RESTORE_TEST").as_deref(), Ok("1"), "visible desktop verification requires explicit operator opt-in; never run on the owner's active desktop");
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
    let evidence = repo.join(".scratch/evidence/402");
    let root = evidence.join(format!("native-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()));
    std::fs::create_dir_all(&root).unwrap();
    let seeded = Command::new("bun").current_dir(&repo).args(["apps/api/src/test-support/native-restore-fixture.ts"]).arg(&root).arg("create-webview").output().unwrap();
    assert!(seeded.status.success(), "{}", String::from_utf8_lossy(&seeded.stderr));
    // The first call still opens the real native dialog and is cancelled.
    // Selection automation is unsupported on this harness desktop, so only
    // subsequent picker results use a test-only native fixture adapter.
    crate::backup_picker::fixture_selections(vec![None, Some(root.join("selected.dknvbak")), Some(root.join("newer.dknvbak")), Some(root.join("corrupt.dknvbak")), Some(root.join("broken.dknvbak")), Some(root.join("selected.dknvbak"))]);
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
    let stop_driver = Arc::new(AtomicBool::new(false));
    let driver_stop = Arc::clone(&stop_driver);
    let driver_thread = Arc::new(Mutex::new(None));
    let driver_join = Arc::clone(&driver_thread);
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
        let log = std::fs::File::create(root.join("driver.log"))?;
        let mut driver = Command::new("bun").current_dir(&repo).arg("apps/desktop/tests/restore-webview.ts").arg(evidence.join("native-current.json"))
            .stdout(log.try_clone()?).stderr(log).spawn()?;
        *driver_join.lock().unwrap() = Some(thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(180);
            loop {
                match driver.try_wait() {
                    Ok(Some(exit)) => { driver_status.store(exit.code().unwrap_or(1), Ordering::SeqCst); break; }
                    Ok(None) if !driver_stop.load(Ordering::SeqCst) && Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                    _ => {
                        // This Child was spawned above, never found by name/PID.
                        let _ = driver.kill();
                        let _ = driver.wait();
                        driver_status.store(124, Ordering::SeqCst);
                        break;
                    }
                }
            }
            kill_sidecar(&handle);
            handle.exit(0);
        }));
        Ok(())
    }).build(tauri::generate_context!()).unwrap();
    app.run_return(|app, event| { if matches!(event, tauri::RunEvent::Exit) { kill_sidecar(app); } });
    stop_driver.store(true, Ordering::SeqCst);
    if let Some(join) = driver_thread.lock().unwrap().take() { join.join().unwrap(); }
    assert_eq!(status.load(Ordering::SeqCst), 0, "read native-current.json root/driver.log for actual Webview assertions");
}
