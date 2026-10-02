mod desktop;

// The sidecar freshness/stamp logic is exercised by `cargo test`; build.rs
// includes the same file textually.
#[cfg(test)]
mod sidecar_freshness;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(desktop::SidecarState::default())
        // issue #141: the vault gate's pre-boot credentials travel over the
        // sidecar's stdin pipe through these commands, never HTTP
        .invoke_handler(tauri::generate_handler![
            desktop::vault_status,
            desktop::vault_unlock,
            desktop::vault_setup,
            desktop::vault_unlock_recovery,
            desktop::vault_reset_passphrase,
            desktop::vault_setup_saved,
            desktop::vault_logout
        ])
        .setup(desktop::setup)
        .on_window_event(|window, event| {
            // Closing the last window shuts the app down; take the sidecar
            // with it so the api never outlives the desktop shell.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    desktop::kill_sidecar(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Dokan")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                desktop::kill_sidecar(app_handle);
            }
        });
}