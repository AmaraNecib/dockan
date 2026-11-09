mod backup_reveal;
mod backup_picker;
mod backup_restore;
mod desktop;

// The sidecar freshness/stamp logic is exercised by `cargo test`; build.rs
// includes the same file textually.
#[cfg(test)]
mod sidecar_freshness;

use tauri::{Manager, RunEvent};

pub(crate) fn app_builder() -> tauri::Builder<tauri::Wry> {
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
            desktop::vault_setup_warning,
            desktop::vault_logout,
            desktop::backup_reveal,
            desktop::backup_restore_choose,
            desktop::backup_restore_preview,
            desktop::backup_restore_cancel,
            desktop::backup_restore_confirmed,
            desktop::backup_restore_outcome
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    let exe_dir = std::env::current_exe().expect("could not determine the Dokan executable path");
    let exe_dir = exe_dir
        .parent()
        .expect("Dokan executable has no parent directory");
    let portable = exe_dir.join(desktop::PORTABLE_MARKER).is_file();
    if portable {
        if let Err(error) = desktop::defer_portable_main_window(&mut context.config_mut().app.windows, true) {
            desktop::show_portable_startup_error(&error);
            std::process::exit(1);
        }
    }
    let built = app_builder()
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
        .build(context);
    let app = match built {
        Ok(app) => app,
        Err(error) if portable => {
            desktop::show_portable_startup_error(&error.to_string());
            std::process::exit(1);
        }
        Err(error) => panic!("error while building Dokan: {error}"),
    };
    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            desktop::kill_sidecar(app_handle);
        }
    });
}
