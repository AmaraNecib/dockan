//! Native process boundary for encrypted restore. Credentials use stdin only.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const FAILED: &str = "VAULT_RESTORE_FAILED";
const MAX_REPLY: u64 = 65536;
struct WorkerSlot {
    stopping: bool,
    child: Option<Arc<Mutex<Child>>>,
}
static WORKER: Mutex<WorkerSlot> = Mutex::new(WorkerSlot {
    stopping: false,
    child: None,
});

pub fn worker_stopped() -> bool {
    WORKER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .child
        .is_none()
}

/// Worker creation and shutdown share a registry lock, so shutdown sees every
/// helper it must reap, including one whose reply is still pending.
pub fn shutdown() {
    let mut slot = WORKER.lock().unwrap_or_else(|p| p.into_inner());
    slot.stopping = true;
    if let Some(child) = slot.child.take() {
        let _ = stop_child(&mut child.lock().unwrap_or_else(|p| p.into_inner()));
    }
}

/// Confirm the old process is gone before an installer can acquire its folder.
pub fn stop_child(child: &mut Child) -> Result<(), String> {
    if child.try_wait().map_err(|_| FAILED)?.is_none() {
        child.kill().map_err(|_| FAILED)?;
    }
    child.wait().map_err(|_| FAILED)?;
    Ok(())
}

/// The caller builds a command from the native-owned sidecar configuration.
/// Credentials go to its pipe, never command arguments or the environment.
pub fn run_worker(
    mut command: Command,
    request: &serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let deadline = Instant::now().checked_add(timeout).ok_or(FAILED)?;
    let payload = serde_json::to_vec(request).map_err(|_| FAILED)?;
    if payload.len() > 4096 {
        return Err(FAILED.to_string());
    }
    let child = {
        let mut slot = WORKER.lock().unwrap_or_else(|p| p.into_inner());
        if slot.stopping || slot.child.is_some() {
            return Err(FAILED.to_string());
        }
        let child = command
            .arg("--vault-restore-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| FAILED)?;
        let handle = Arc::new(Mutex::new(child));
        slot.child = Some(Arc::clone(&handle));
        handle
    };
    let result = (|| {
        let (mut stdin, stdout) = {
            let mut child = child.lock().unwrap_or_else(|p| p.into_inner());
            (
                child.stdin.take().ok_or(FAILED)?,
                child.stdout.take().ok_or(FAILED)?,
            )
        };
        stdin.write_all(&payload).map_err(|_| FAILED)?;
        stdin.flush().map_err(|_| FAILED)?;
        drop(stdin);
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let read = stdout.take(MAX_REPLY + 1).read_to_end(&mut bytes);
            let _ = tx.send((read, bytes));
        });
        let (read, bytes) = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| FAILED)?;
        read.map_err(|_| FAILED)?;
        if bytes.len() as u64 > MAX_REPLY {
            return Err(FAILED.to_string());
        }
        let status = loop {
            if let Some(status) = child
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .try_wait()
                .map_err(|_| FAILED)?
            {
                break status;
            }
            if Instant::now() >= deadline {
                return Err(FAILED.to_string());
            }
            thread::sleep(Duration::from_millis(10));
        };
        let reply: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| FAILED)?;
        if !status.success() || reply.get("ok") != Some(&serde_json::Value::Bool(true)) {
            return Err(if reply.get("code").and_then(|v| v.as_str()) == Some("VAULT_BACKUP_NEWER_SCHEMA") {
                "VAULT_BACKUP_NEWER_SCHEMA"
            } else { FAILED }.to_string());
        }
        Ok(reply)
    })();
    if result.is_err() {
        // A timeout may leave a pending install intent. Reap the helper before
        // relaunching; the fresh sidecar replays that intent before any writer.
        // Retain an unconfirmed child in the shutdown registry. Returning an
        // error must not abandon a live installer or authorize a fresh writer.
        stop_child(&mut child.lock().unwrap_or_else(|p| p.into_inner()))?;
        WORKER.lock().unwrap_or_else(|p| p.into_inner()).child = None;
    } else {
        WORKER.lock().unwrap_or_else(|p| p.into_inner()).child = None;
    }
    result
}

/// Capture the durable journal state before quiescing or stopping the sidecar.
/// A missing journal is a valid empty baseline; every other read error fails closed.
pub fn capture_restore_baseline(data_dir: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    read_restore_baseline(data_dir, |path| std::fs::read(path))
}

fn read_restore_baseline(
    data_dir: &std::path::Path,
    read_journal: impl FnOnce(&std::path::Path) -> std::io::Result<Vec<u8>>,
) -> Result<Option<Vec<u8>>, String> {
    match read_journal(&data_dir.join("vault/restore-intent.json")) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(FAILED.to_string()),
    }
}

/// Run the production journal/stop/install/restart lifecycle from the command handler
/// and non-UI process tests using the exact baseline captured before quiescence.
pub fn run_restore_lifecycle_from_baseline<T>(
    data_dir: &std::path::Path,
    previous: Option<Vec<u8>>,
    stop_current: impl FnOnce() -> Result<(), String>,
    install: impl FnOnce(),
    restart: impl FnOnce() -> Result<T, String>,
) -> Result<(T, serde_json::Value), String> {
    let path = data_dir.join("vault/restore-intent.json");
    stop_current()?;
    install();
    let restarted = restart()?;
    let after = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(FAILED.to_string()),
    };
    let outcome = restore_completion(data_dir, previous.as_deref(), after.as_deref())?;
    Ok((restarted, outcome))
}

pub fn restore_completion(
    data_dir: &std::path::Path,
    previous: Option<&[u8]>,
    after: Option<&[u8]>,
) -> Result<serde_json::Value, String> {
    let changed = after.is_some() && after != previous;
    let intent = after.and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok());
    let status = if changed {
        match intent.as_ref().and_then(|v| v.get("state")).and_then(|v| v.as_str()) {
            Some("committed") => "restored",
            Some("rolled-back") => "rolled-back",
            _ => return Err(FAILED.to_string()),
        }
    } else { "refused" };
    let safety_file = intent.as_ref().filter(|_| changed).and_then(|v| v.get("safetyFile")).and_then(|v| v.as_str())
        .filter(|name| name.starts_with("restore-") && name.ends_with(".dknvbak") && !name.contains(['/', '\\']));
    Ok(serde_json::json!({"status":status, "safetyDirectory":data_dir.join("vault"), "safetyPath":safety_file.map(|name| data_dir.join("vault").join(name)), "selectedUnchanged":true}))
}

/// Drain only the exact native launch and its live authenticated session.
pub fn quiesce(
    port: u16,
    boot_token: &str,
    session: &str,
    timeout: Duration,
) -> Result<(), String> {
    if boot_token.len() != 64
        || !boot_token.bytes().all(|c| c.is_ascii_hexdigit())
        || session.len() != 43
        || !session
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(FAILED.to_string());
    }
    let deadline = Instant::now().checked_add(timeout).ok_or(FAILED)?;
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or(FAILED)
    };
    let mut stream =
        TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), remaining()?)
            .map_err(|_| FAILED)?;
    stream
        .set_write_timeout(Some(remaining()?))
        .map_err(|_| FAILED)?;
    write!(stream, "POST /api/vault/quiesce HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nx-dokan-boot-token: {boot_token}\r\nx-vault-session: {session}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").map_err(|_| FAILED)?;
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        stream
            .set_read_timeout(Some(remaining()?))
            .map_err(|_| FAILED)?;
        let n = stream.read(&mut chunk).map_err(|_| FAILED)?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() > 4096 {
            return Err(FAILED.to_string());
        }
    }
    let response = std::str::from_utf8(&bytes).map_err(|_| FAILED)?;
    let (headers, body) = response.split_once("\r\n\r\n").ok_or(FAILED)?;
    let mut lines = headers.lines();
    let status = lines.next().ok_or(FAILED)?;
    let parts: Vec<_> = status.split_whitespace().collect();
    if !matches!(parts.first(), Some(&"HTTP/1.0" | &"HTTP/1.1")) || parts.get(1) != Some(&"200") {
        return Err(FAILED.to_string());
    }
    let mut length = None;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(FAILED)?;
        if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("content-encoding")
        {
            return Err(FAILED.to_string());
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(FAILED.to_string());
            }
            length = Some(value.trim().parse::<usize>().map_err(|_| FAILED)?);
        }
    }
    let reply: serde_json::Value = serde_json::from_str(body).map_err(|_| FAILED)?;
    if length != Some(body.len()) || reply != serde_json::json!({"ok": true}) {
        return Err(FAILED.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::path::{Path, PathBuf};
    static TEST_GATE: Mutex<()> = Mutex::new(());
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    struct LiveChild(Child);
    impl Drop for LiveChild {
        fn drop(&mut self) {
            let _ = stop_child(&mut self.0);
        }
    }
    fn api_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../api")
    }
    fn api_command(data: &Path) -> Command {
        // build.rs has just freshness-checked/compiled this exact sidecar.
        // Exercise its real executable/argv path, not only Bun's source runner.
        let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "dokan-api-x86_64-pc-windows-msvc{}",
                std::env::consts::EXE_SUFFIX
            ));
        let mut cmd = Command::new(binary);
        let malicious_external_path = data.parent().unwrap().join("external-legacy.db");
        cmd.current_dir(api_root())
            .env("DOKAN_DATA_DIR", data)
            .env("DOKAN_VAULT", "on")
            .env("DOKAN_DB_PATH", &malicious_external_path);
        let pinned = crate::desktop::child_environment(data, &data.join("run"), Path::new(""), 0, &"a".repeat(64));
        for (key, value) in pinned {
            if key == "DOKAN_DB_PATH" {
                cmd.env(key, value);
            }
        }
        cmd
    }
    fn fixture_command(root: &Path, action: &str, extra: Option<&str>) -> serde_json::Value {
        fixture_command_with_credential(root, action, extra, None)
    }
    fn fixture_command_with_credential(root: &Path, action: &str, extra: Option<&str>, credential: Option<&str>) -> serde_json::Value {
        let mut cmd = Command::new("bun");
        cmd.current_dir(api_root())
            .arg("src/test-support/native-restore-fixture.ts")
            .arg(root)
            .arg(action);
        if let Some(extra) = extra {
            cmd.arg(extra);
        }
        if let Some(credential) = credential {
            cmd.arg(credential);
        }
        let out = cmd.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }
    fn served(data: &Path, port: u16) -> (LiveChild, String) {
        served_as(data, port, "native fixture passphrase")
    }
    fn served_as(data: &Path, port: u16, passphrase: &str) -> (LiveChild, String) {
        let mut cmd = api_command(data);
        cmd.env("DOKAN_PORT", port.to_string())
            .env("DOKAN_PORT_ROOT", data.join("run"))
            .env("DOKAN_VAULT_STDIN", "1")
            .env("DOKAN_BOOT_TOKEN", "a".repeat(64))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut child = LiveChild(cmd.spawn().unwrap());
        let mut input = child.0.stdin.take().unwrap();
        let output = child.0.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 { break; }
                if tx.send(line).is_err() { break; }
            }
        });
        input.write_all(b"{\"action\":\"status\"}\n").unwrap();
        input.flush().unwrap();
        let locked: serde_json::Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(20)).unwrap()).unwrap();
        assert_eq!(locked["status"]["unlocked"], false, "fresh sidecar must start locked: {locked}");
        let request = serde_json::json!({"action":"unlock","passphrase":passphrase}).to_string() + "\n";
        input.write_all(request.as_bytes()).unwrap();
        input.flush().unwrap();
        let reply: serde_json::Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(20)).unwrap()).unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
        (child, reply["sessionToken"].as_str().unwrap().to_string())
    }

    #[test]
    fn unreadable_prior_journal_fails_before_stop_and_never_classifies_old_terminal_state() {
        let old_terminal = br#"{"state":"committed","safetyFile":"restore-old.dknvbak"}"#;
        let stopped = std::cell::Cell::new(false);
        let installed = std::cell::Cell::new(false);
        let restarted = std::cell::Cell::new(false);
        let result = read_restore_baseline(Path::new("C:/fixture"), |_| {
            assert_eq!(serde_json::from_slice::<serde_json::Value>(old_terminal).unwrap()["state"], "committed");
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "fixture unreadable"))
        }).and_then(|baseline| run_restore_lifecycle_from_baseline(
            Path::new("C:/fixture"), baseline,
            || { stopped.set(true); Ok(()) },
            || installed.set(true),
            || { restarted.set(true); Ok(()) },
        ));
        assert!(result.is_err(), "an unreadable baseline must not emit a restore verdict");
        assert!(!stopped.get(), "the current sidecar must remain live when its journal baseline is untrusted");
        assert!(!installed.get(), "a refused attempt must not run the installer");
        assert!(!restarted.get(), "a refused attempt must not replace the live sidecar");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(old_terminal).unwrap()["state"], "committed");
    }

    #[test]
    fn backup_restore_native_stops_before_install_and_reopens_real_encrypted_records() {
        let _test = TEST_GATE.lock().unwrap();
        let root = Fixture(std::env::temp_dir().join(format!(
                "dokan-native-restore-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )));
        std::fs::create_dir_all(&root.0).unwrap();
        fixture_command(&root.0, "create", None);
        let data = root.0.join("current");
        let chosen = crate::backup_picker::checked_selection(root.0.join("dokan-2026-11-06.db")).unwrap();
        let external_db = root.0.join("external-legacy.db");
        let external_wal = root.0.join("external-legacy.db-wal");
        let external_shm = root.0.join("external-legacy.db-shm");
        std::fs::write(&external_db, b"external database sentinel").unwrap();
        std::fs::write(&external_wal, b"external wal sentinel").unwrap();
        std::fs::write(&external_shm, b"external shm sentinel").unwrap();
        let credential = serde_json::json!({"passphrase":"native fixture passphrase"});
        let preview = run_worker(
            api_command(&data),
            &serde_json::json!({"action":"preview", "path":chosen, "credential":credential}),
            Duration::from_secs(20),
        )
        .unwrap();
        let request = serde_json::json!({"action":"install", "path":chosen, "credential":credential, "currentCredential":credential, "confirmed":true, "expectedSha256":preview["preview"]["sha256"]});
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let (mut old, old_session) = served(&data, port);
        assert!(
            run_worker(api_command(&data), &request, Duration::from_secs(20)).is_err(),
            "live writer must exclude the installer"
        );
        assert!(quiesce(port, &"b".repeat(64), &old_session, Duration::from_secs(5)).is_err());
        quiesce(port, &"a".repeat(64), &old_session, Duration::from_secs(20)).unwrap();
        assert!(
            run_worker(api_command(&data), &request, Duration::from_secs(20)).is_err(),
            "quiesced but unreaped child still owns the folder"
        );
        stop_child(&mut old.0).unwrap();
        let installed = run_worker(api_command(&data), &request, Duration::from_secs(20)).unwrap();
        let records = fixture_command(&root.0, "records", None);
        assert!(records["names"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("Restored native record")));
        assert!(!records["names"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("Original native record")));
        let safety = fixture_command(&root.0, "safety", installed["safetyPath"].as_str());
        assert!(safety["names"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("Original native record")));
        let (_fresh, fresh_session) = served(&data, port);
        assert_ne!(old_session, fresh_session);
        assert!(
            quiesce(port, &"a".repeat(64), &old_session, Duration::from_secs(5)).is_err(),
            "stale session must be refused after restart"
        );
        assert_eq!(std::fs::read(&external_db).unwrap(), b"external database sentinel");
        assert_eq!(std::fs::read(&external_wal).unwrap(), b"external wal sentinel");
        assert_eq!(std::fs::read(&external_shm).unwrap(), b"external shm sentinel");
    }

    #[test]
    fn shared_restore_lifecycle_reopens_success_and_migration_rollback_with_pinned_db_path() {
        let _test = TEST_GATE.lock().unwrap();
        let root = Fixture(std::env::temp_dir().join(format!(
            "dokan-native-lifecycle-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        )));
        std::fs::create_dir_all(&root.0).unwrap();
        fixture_command(&root.0, "create-webview", None);
        let data = root.0.join("current");
        let external_db = root.0.join("external-legacy.db");
        let external_wal = root.0.join("external-legacy.db-wal");
        let external_shm = root.0.join("external-legacy.db-shm");
        std::fs::write(&external_db, b"external database sentinel").unwrap();
        std::fs::write(&external_wal, b"external wal sentinel").unwrap();
        std::fs::write(&external_shm, b"external shm sentinel").unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (mut old, old_session) = served(&data, port);
        let original_credential = serde_json::json!({"passphrase":"native fixture passphrase"});
        let incoming_credential = serde_json::json!({"passphrase":"incoming native fixture passphrase"});
        let selected = root.0.join("selected.dknvbak");
        let success_preview = run_worker(api_command(&data), &serde_json::json!({"action":"preview","path":selected,"credential":incoming_credential}), Duration::from_secs(20)).unwrap();
        let success_request = serde_json::json!({"action":"install","path":selected,"credential":incoming_credential,"currentCredential":original_credential,"confirmed":true,"expectedSha256":success_preview["preview"]["sha256"]});
        let success_worker_ok = std::cell::Cell::new(false);
        let ((mut restored_sidecar, restored_session), restored) = run_restore_lifecycle_from_baseline(
            &data,
            capture_restore_baseline(&data).unwrap(),
            || { quiesce(port, &"a".repeat(64), &old_session, Duration::from_secs(20))?; stop_child(&mut old.0) },
            || success_worker_ok.set(run_worker(api_command(&data), &success_request, Duration::from_secs(20)).is_ok()),
            || Ok(served_as(&data, port, "incoming native fixture passphrase")),
        ).unwrap();
        assert!(success_worker_ok.get(), "the committed replacement must be accepted by the real sidecar worker");
        assert_eq!(restored["status"], "restored");
        let restored_records = fixture_command_with_credential(&root.0, "records", None, Some("incoming native fixture passphrase"));
        assert!(restored_records["names"].as_array().unwrap().contains(&serde_json::json!("Restored native record")));
        assert!(!restored_records["names"].as_array().unwrap().contains(&serde_json::json!("Original native record")));
        let restored_safety = fixture_command(&root.0, "safety", restored["safetyPath"].as_str());
        assert!(restored_safety["names"].as_array().unwrap().contains(&serde_json::json!("Original native record")));
        assert_eq!(std::fs::read(&external_db).unwrap(), b"external database sentinel");
        assert_eq!(std::fs::read(&external_wal).unwrap(), b"external wal sentinel");
        assert_eq!(std::fs::read(&external_shm).unwrap(), b"external shm sentinel");
        assert!(quiesce(port, &"a".repeat(64), &old_session, Duration::from_secs(3)).is_err(), "old session must not operate after success restart");

        let broken = root.0.join("broken.dknvbak");
        let failure_preview = run_worker(api_command(&data), &serde_json::json!({"action":"preview","path":broken,"credential":incoming_credential}), Duration::from_secs(20)).unwrap();
        let failure_request = serde_json::json!({"action":"install","path":broken,"credential":incoming_credential,"currentCredential":incoming_credential,"confirmed":true,"expectedSha256":failure_preview["preview"]["sha256"]});
        let failure_worker_ok = std::cell::Cell::new(true);
        let ((rolled_back_sidecar, _), rolled_back) = run_restore_lifecycle_from_baseline(
            &data,
            capture_restore_baseline(&data).unwrap(),
            || { quiesce(port, &"a".repeat(64), &restored_session, Duration::from_secs(20))?; stop_child(&mut restored_sidecar.0) },
            || failure_worker_ok.set(run_worker(api_command(&data), &failure_request, Duration::from_secs(20)).is_ok()),
            || Ok(served_as(&data, port, "incoming native fixture passphrase")),
        ).unwrap();
        assert!(!failure_worker_ok.get(), "the broken incoming schema must fail its real migration");
        assert_eq!(rolled_back["status"], "rolled-back");
        let original_after_failure = fixture_command_with_credential(&root.0, "records", None, Some("incoming native fixture passphrase"));
        assert!(original_after_failure["names"].as_array().unwrap().contains(&serde_json::json!("Restored native record")));
        let failure_safety = fixture_command_with_credential(&root.0, "safety", rolled_back["safetyPath"].as_str(), Some("incoming native fixture passphrase"));
        assert!(failure_safety["names"].as_array().unwrap().contains(&serde_json::json!("Restored native record")));
        assert_eq!(std::fs::read(&external_db).unwrap(), b"external database sentinel");
        assert_eq!(std::fs::read(&external_wal).unwrap(), b"external wal sentinel");
        assert_eq!(std::fs::read(&external_shm).unwrap(), b"external shm sentinel");
        drop(rolled_back_sidecar);
    }

    #[test]
    fn backup_restore_worker_receives_secrets_only_on_stdin_and_reaps_timeouts() {
        let _test = TEST_GATE.lock().unwrap();
        let mut command = Command::new("bun");
        command.args(["-e", "const text = await Bun.stdin.text(); const r = JSON.parse(text); console.log(JSON.stringify({ok:true, length:r.secret.length, args:process.argv}));"]);
        let reply = run_worker(
            command,
            &serde_json::json!({"secret":"fixture-secret"}),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(reply["length"], 14);
        assert!(!reply["args"].to_string().contains("fixture-secret"));
        let mut stuck = Command::new("bun");
        stuck.args(["-e", "await Bun.sleep(60000)"]);
        assert!(run_worker(stuck, &serde_json::json!({}), Duration::from_millis(100)).is_err());
    }

    #[test]
    fn backup_restore_shutdown_reaps_a_pending_native_worker() {
        let _test = TEST_GATE.lock().unwrap();
        let mut command = Command::new("bun");
        command.args(["-e", "await Bun.stdin.text(); await Bun.sleep(60000)"]);
        let worker = thread::spawn(move || {
            run_worker(command, &serde_json::json!({}), Duration::from_secs(20))
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let child = loop {
            if let Some(child) = WORKER.lock().unwrap().child.clone() {
                break child;
            }
            assert!(Instant::now() < deadline, "worker never registered");
            thread::sleep(Duration::from_millis(10));
        };
        shutdown();
        let result = worker.join().unwrap();
        WORKER.lock().unwrap().stopping = false;
        assert!(result.is_err());
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(worker_stopped());
    }

    #[test]
    fn backup_restore_quiesce_refuses_header_injection_without_connecting() {
        assert!(quiesce(
            1,
            &"a".repeat(64),
            "bad\r\nheader",
            Duration::from_millis(100)
        )
        .is_err());
    }
}
