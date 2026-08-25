//! Packaged-build bootstrap: spawn the Bun API sidecar, wait for it to be
//! reachable, then point the main window at the api's origin.
//!
//! Production topology (ticket 15): the web frontend calls the api with
//! relative `/api/*` URLs (same-origin contract it already uses through the
//! vite proxy in dev). In a packaged app there is no vite, so the api ITSELF
//! serves the built UI (`DOKAN_WEB_DIST`) and the window is navigated to
//! `http://127.0.0.1:<port>` — same origin, cookies and session work with no
//! CORS and no custom-protocol proxy. Data, logs, backups and the port record
//! all live under the OS app-data dir, never in the install folder.
//!
//! Dev builds (`tauri dev`) never spawn the sidecar: the developer runs
//! `bun run dev:api` + `bun run dev:desktop` and the window loads the vite
//! devUrl unchanged.

use std::io::{BufRead, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{App, AppHandle, Manager, WebviewWindow};

/// Baked per-build secret for the first-run admin provisioning flow. The shop
/// owner types it once in the UI setup step; a support engineer can pass a
/// different value via the environment when rotating access.
const PRODUCTION_BUILD_SECRET: &str = "b75510c2e58fe309";

/// Strong per-build signing secret for better-auth so the shared-laptop
/// session-cookie signing is not the dev default.
const PRODUCTION_AUTH_SECRET: &str = "430b09b331c94ffc0a90f1eb9b92c9246fa504976b4214b415a558ff56544e3e";

const PORT_FILE: &str = ".dokan-port";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_INTERVAL: Duration = Duration::from_millis(150);

/// Owns the spawned sidecar so it can be killed when the app exits.
#[derive(Default)]
pub struct SidecarState(pub Mutex<Option<Child>>);

/// Hook called from the builder's `setup`. In debug builds this is a no-op
/// (dev mode works without the sidecar); release builds spawn the api and
/// steer the window to it.
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    match spawn_and_navigate(app) {
        Ok(()) => Ok(()),
        Err(err) => {
            // The window is already open on the bundled UI, whose in-app
            // error states handle a missing api; log loudly and keep going so
            // an api hiccup never blanks out the whole app.
            eprintln!("[dokan] sidecar bootstrap failed: {err}");
            Ok(())
        }
    }
}

/// Kill the sidecar (best effort) when the app shuts down. Must be idempotent.
pub fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let mut guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn spawn_and_navigate(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = ensure_dir(app.path().app_data_dir()?)?;
    let port_root = ensure_dir(data_dir.join("run"))?;
    let resource_dir = app.path().resource_dir()?;

    let sidecar = resource_dir.join(sidecar_file_name());
    if !sidecar.is_file() {
        return Err(format!("sidecar binary not found at {}", sidecar.display()).into());
    }

    let child = build_command(&sidecar)
        .env("DOKAN_DATA_DIR", &data_dir)
        .env("DOKAN_PORT_ROOT", &port_root)
        .env("DOKAN_WEB_DIST", resource_dir.join("ui"))
        .env("DOKAN_BUILD_SECRET", std::env::var("DOKAN_BUILD_SECRET").unwrap_or_else(|_| PRODUCTION_BUILD_SECRET.to_string()))
        .env("DOKAN_AUTH_SECRET", std::env::var("DOKAN_AUTH_SECRET").unwrap_or_else(|_| PRODUCTION_AUTH_SECRET.to_string()))
        .spawn()?;

    let state = app.state::<SidecarState>();
    let mut guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.replace(child);

    let port = wait_for_api_port(&port_root)?;
    if let Some(window) = app.get_webview_window("main") {
        navigate(window, &format!("http://127.0.0.1:{port}"))?;
    }
    Ok(())
}

/// The bundled sidecar lands in the resource dir under its plain name; the
/// `-<target-triple>` suffix is stripped at bundle time.
fn sidecar_file_name() -> &'static str {
    if cfg!(windows) {
        "dokan-api.exe"
    } else {
        "dokan-api"
    }
}

#[cfg(windows)]
fn build_command(sidecar: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(sidecar);
    // CREATE_NO_WINDOW: the Bun runtime is a console subsystem app; without
    // this flag a black console would pop up beside the desktop window.
    cmd.creation_flags(0x0800_0000);
    cmd
}

#[cfg(not(windows))]
fn build_command(sidecar: &Path) -> Command {
    Command::new(sidecar)
}

fn ensure_dir(dir: PathBuf) -> Result<PathBuf, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Poll the port record until the api publishes it, then confirm the port
/// actually accepts connections before steering the window there (a written
/// record precedes the accept loop, so this closes the tiny boot race).
fn wait_for_api_port(port_root: &Path) -> Result<u16, Box<dyn std::error::Error>> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let port_file = port_root.join(PORT_FILE);
    loop {
        if let Ok(raw) = std::fs::read_to_string(&port_file) {
            if let Ok(port) = raw.trim().parse::<u16>() {
                if port > 0 && port_accepts(port) {
                    return Ok(port);
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("api did not publish a reachable port within {STARTUP_TIMEOUT:?}").into());
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
}

/// Raw TCP probe (mirrors the api's own liveness probe): succeed when a
/// health GET through {host}:{port} returns an HTTP status line — the port is
/// both bound AND served by the api.
fn port_accepts(port: u16) -> bool {
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<std::net::SocketAddr>() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(b"GET /health HTTP/1.0\r\n\r\n").is_err() {
        return false;
    }
    let mut line = String::new();
    if std::io::BufReader::new(&mut stream).read_line(&mut line).is_err() {
        return false;
    }
    line.starts_with("HTTP/1.")
}

fn navigate(window: WebviewWindow, url: &str) -> Result<(), Box<dyn std::error::Error>> {
    window.navigate(url.parse()?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal HTTP/1 server that answers `GET /health` with 200, used to
    /// prove the health probe requires a real responding listener. Serves
    /// exactly one request, then the thread exits so joins never hang.
    fn spawn_health_server() -> (u16, std::thread::JoinHandle<()>, std::net::TcpListener) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let acceptor = listener.try_clone().unwrap();
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = acceptor.accept() {
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });
        (port, handle, listener)
    }

    #[test]
    fn port_accepts_a_responding_health_server() {
        let (port, handle, _listener) = spawn_health_server();
        assert!(port_accepts(port));
        drop(_listener);
        handle.join().unwrap();
    }

    #[test]
    fn port_accepts_is_false_for_a_closed_port() {
        // bind then drop: the port is free, nothing listens there
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!port_accepts(port));
    }

    #[test]
    fn wait_for_api_port_reads_the_record_and_probes_the_port() {
        let dir = std::env::temp_dir().join(format!("dokan-port-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (port, handle, _listener) = spawn_health_server();
        let dir_for_thread = dir.clone();
        std::thread::spawn(move || {
            std::fs::write(dir_for_thread.join(PORT_FILE), port.to_string()).unwrap();
        });
        let found = wait_for_api_port(&dir).unwrap();
        assert_eq!(found, port);
        drop(_listener);
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn kill_sidecar_terminates_the_spawned_child() {
        let state = SidecarState::default();
        let child = std::process::Command::new("cmd")
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .spawn()
            .unwrap();
        state.0.lock().unwrap().replace(child);
        kill_sidecar_from_state(&state);
        assert!(state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .is_none());
    }

    /// Test-only sibling of [`kill_sidecar`] (which needs an AppHandle).
    fn kill_sidecar_from_state(state: &SidecarState) {
        let mut guard = state.0.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}