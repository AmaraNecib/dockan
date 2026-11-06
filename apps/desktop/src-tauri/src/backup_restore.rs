//! Native process boundary for encrypted restore. No renderer command is
//! registered until selection, confirmation and the remaining evidence exist.
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
            return Err(FAILED.to_string());
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
        cmd.current_dir(api_root())
            .env("DOKAN_DATA_DIR", data)
            .env("DOKAN_VAULT", "on");
        cmd
    }
    fn fixture_command(root: &Path, action: &str, extra: Option<&str>) -> serde_json::Value {
        let mut cmd = Command::new("bun");
        cmd.current_dir(api_root())
            .arg("src/test-support/native-restore-fixture.ts")
            .arg(root)
            .arg(action);
        if let Some(extra) = extra {
            cmd.arg(extra);
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
        let mut cmd = api_command(data);
        cmd.env("DOKAN_PORT", port.to_string())
            .env("DOKAN_PORT_ROOT", data.join("run"))
            .env("DOKAN_VAULT_STDIN", "1")
            .env("DOKAN_BOOT_TOKEN", "a".repeat(64))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut child = LiveChild(cmd.spawn().unwrap());
        let mut input = child.0.stdin.take().unwrap();
        input
            .write_all(b"{\"action\":\"unlock\",\"passphrase\":\"native fixture passphrase\"}\n")
            .unwrap();
        input.flush().unwrap();
        let output = child.0.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(output).read_line(&mut line);
            let _ = tx.send(line);
        });
        let line = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
        (child, reply["sessionToken"].as_str().unwrap().to_string())
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
        let chosen = root.0.join("selected.dknvbak");
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
