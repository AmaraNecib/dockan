//! Native file selection. No renderer-provided path reaches the restore worker.
use std::path::PathBuf;

pub fn choose(owner: isize) -> Result<Option<PathBuf>, String> {
    #[cfg(all(test, feature = "native-restore-webview-test"))]
    if let Some(Some(path)) = TEST_SELECTIONS.lock().unwrap().pop_front() {
        return checked_selection(path).map(Some);
    }
    choose_native(owner)
}

// Only this lib-test build can replace selection. No runtime environment,
// renderer command or production executable can enable the fixture adapter.
#[cfg(all(test, feature = "native-restore-webview-test"))]
static TEST_SELECTIONS: std::sync::Mutex<std::collections::VecDeque<Option<PathBuf>>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
#[cfg(all(test, feature = "native-restore-webview-test"))]
pub(crate) fn fixture_selections(paths: Vec<Option<PathBuf>>) {
    *TEST_SELECTIONS.lock().unwrap() = paths.into();
}

pub(crate) fn checked_selection(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || !path.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("dknvbak") || extension.eq_ignore_ascii_case("db")
        })
        || !path.is_file()
    {
        return Err(super::backup_restore::FAILED.to_string());
    }
    std::fs::canonicalize(path).map_err(|_| super::backup_restore::FAILED.to_string())
}

#[cfg(test)]
mod tests {
    use super::checked_selection;
    use std::path::PathBuf;

    #[test]
    fn accepts_encrypted_export_extensions_and_rejects_other_files() {
        let root = std::env::temp_dir().join(format!("dokan-picker-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for name in ["dokan-2026-11-06.db", "backup.DKNVBAK", "backup.DB"] {
            let path = root.join(name);
            std::fs::write(&path, b"fixture bundle bytes").unwrap();
            assert_eq!(checked_selection(path.clone()).unwrap(), path.canonicalize().unwrap());
        }
        for name in ["plaintext.sqlite", "backup.txt"] {
            let path = root.join(name);
            std::fs::write(&path, b"fixture bytes").unwrap();
            assert!(checked_selection(path).is_err(), "unsupported extension must fail closed");
        }
        let _ = std::fs::remove_dir_all(root);
        assert!(checked_selection(PathBuf::from("relative.db")).is_err());
    }
}

#[cfg(not(windows))]
fn choose_native(_owner: isize) -> Result<Option<PathBuf>, String> {
    Err("VAULT_RESTORE_UNSUPPORTED".to_string())
}

#[cfg(windows)]
fn choose_native(owner: isize) -> Result<Option<PathBuf>, String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStringExt;
    #[repr(C)]
    struct OpenFileName {
        size: u32,
        owner: isize,
        instance: isize,
        filter: *const u16,
        custom_filter: *mut u16,
        max_custom_filter: u32,
        filter_index: u32,
        file: *mut u16,
        max_file: u32,
        file_title: *mut u16,
        max_file_title: u32,
        initial_dir: *const u16,
        title: *const u16,
        flags: u32,
        file_offset: u16,
        file_extension: u16,
        default_extension: *const u16,
        custom_data: isize,
        hook: *const c_void,
        template_name: *const u16,
        reserved: *const c_void,
        reserved_word: u32,
        flags_ex: u32,
    }
    #[link(name = "comdlg32")]
    extern "system" {
        fn GetOpenFileNameW(params: *mut OpenFileName) -> i32;
        fn CommDlgExtendedError() -> u32;
    }
    let filter: Vec<u16> = "Dokan encrypted backup (*.dknvbak;*.db)\0*.dknvbak;*.db\0\0".encode_utf16().collect();
    let title: Vec<u16> = "اختيار نسخة دكان المشفّرة\0".encode_utf16().collect();
    let mut file = vec![0u16; 32768];
    // SAFETY: OPENFILENAMEW is a C structure whose zero values mean unused
    // optional fields. The writable UTF-16 buffer outlives this blocking call.
    let mut params: OpenFileName = unsafe { std::mem::zeroed() };
    params.size = std::mem::size_of::<OpenFileName>() as u32;
    params.owner = owner;
    params.filter = filter.as_ptr();
    params.filter_index = 1;
    params.file = file.as_mut_ptr();
    params.max_file = file.len() as u32;
    params.title = title.as_ptr();
    // Explorer, existing path/file, no current-directory mutation, no recent
    // document entry. Single selection only; never execute or open the file.
    params.flags = 0x00080000 | 0x00000800 | 0x00001000 | 0x00000008 | 0x02000000;
    // SAFETY: pointers and lengths above follow the Windows dialog contract.
    if unsafe { GetOpenFileNameW(&mut params) } == 0 {
        // SAFETY: this thread immediately reads the dialog's extended error.
        return if unsafe { CommDlgExtendedError() } == 0 { Ok(None) } else { Err(super::backup_restore::FAILED.to_string()) };
    }
    let end = file.iter().position(|c| *c == 0).ok_or(super::backup_restore::FAILED)?;
    let path = PathBuf::from(std::ffi::OsString::from_wide(&file[..end]));
    checked_selection(path).map(Some)
}
