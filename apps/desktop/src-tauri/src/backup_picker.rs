//! Native file selection. No renderer-provided path reaches the restore worker.
use std::path::PathBuf;

#[cfg(not(windows))]
pub fn choose(_owner: isize) -> Result<Option<PathBuf>, String> {
    Err("VAULT_RESTORE_UNSUPPORTED".to_string())
}

#[cfg(windows)]
pub fn choose(owner: isize) -> Result<Option<PathBuf>, String> {
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
    let filter: Vec<u16> = "Dokan encrypted backup (*.dknvbak)\0*.dknvbak\0\0".encode_utf16().collect();
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
    if !path.is_absolute() || path.extension().and_then(|s| s.to_str()) != Some("dknvbak") || !path.is_file() {
        return Err(super::backup_restore::FAILED.to_string());
    }
    Ok(Some(std::fs::canonicalize(path).map_err(|_| super::backup_restore::FAILED)?))
}
