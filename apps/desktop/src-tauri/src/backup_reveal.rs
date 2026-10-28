//! Read-only file reveal. No backup is created or modified here.
use std::path::Path;

pub const MISSING: &str = "BACKUP_REVEAL_MISSING";
pub const FAILED: &str = "BACKUP_REVEAL_FAILED";

pub fn reveal_backup(path: &Path) -> Result<(), &'static str> {
    if !path.is_absolute() {
        return Err(FAILED);
    }
    let metadata = std::fs::metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            MISSING
        } else {
            FAILED
        }
    })?;
    if !metadata.is_file() {
        return Err(MISSING);
    }
    reveal_file(path)
}

#[cfg(not(windows))]
fn reveal_file(_path: &Path) -> Result<(), &'static str> {
    Err("BACKUP_REVEAL_UNSUPPORTED")
}

#[cfg(windows)]
fn reveal_file(path: &Path) -> Result<(), &'static str> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(memory: *mut c_void);
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHParseDisplayName(
            name: *const u16,
            bind_context: *mut c_void,
            pidl: *mut *mut c_void,
            attributes_in: u32,
            attributes_out: *mut u32,
        ) -> i32;
        fn SHOpenFolderAndSelectItems(
            pidl: *const c_void,
            count: u32,
            children: *const *const c_void,
            flags: u32,
        ) -> i32;
    }

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            // SAFETY: constructed only after successful initialization on this thread.
            unsafe { CoUninitialize() };
        }
    }
    struct ItemIdList(*mut c_void);
    impl Drop for ItemIdList {
        fn drop(&mut self) {
            // SAFETY: SHParseDisplayName allocates its PIDL with the COM allocator.
            unsafe { CoTaskMemFree(self.0) };
        }
    }

    let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
    if name.contains(&0) {
        return Err(FAILED);
    }
    name.push(0);
    // SAFETY: null reserved argument and COINIT_APARTMENTTHREADED are valid.
    if unsafe { CoInitializeEx(ptr::null_mut(), 2) } < 0 {
        return Err(FAILED);
    }
    let _apartment = ComApartment;
    let mut raw_pidl = ptr::null_mut();
    // SAFETY: name is NUL-terminated UTF-16; output points to live writable storage.
    let parsed = unsafe {
        SHParseDisplayName(
            name.as_ptr(),
            ptr::null_mut(),
            &mut raw_pidl,
            0,
            ptr::null_mut(),
        )
    };
    let pidl = ItemIdList(raw_pidl);
    if parsed < 0 || pidl.0.is_null() {
        return Err(FAILED);
    }
    // SAFETY: with count=0, the absolute PIDL identifies the file to select in
    // its parent folder. No child array is required. The PIDL stays live.
    let opened = unsafe { SHOpenFolderAndSelectItems(pidl.0, 0, ptr::null(), 0) };
    if opened < 0 {
        Err(FAILED)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_missing_file_and_a_directory() {
        let dir = std::env::temp_dir().join(format!("dokan-reveal-refusal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(reveal_backup(&dir.join("missing.db.enc")), Err(MISSING));
        assert_eq!(reveal_backup(&dir), Err(MISSING));
        assert_eq!(reveal_backup(Path::new("relative.db.enc")), Err(FAILED));
        std::fs::remove_dir(&dir).unwrap();
    }

    /// Opt in on a real Windows desktop. This opens Explorer, not a fake process.
    #[test]
    #[cfg(windows)]
    #[ignore = "requires an interactive Windows desktop"]
    fn windows_reveals_a_real_unicode_file_without_modifying_it() {
        let dir =
            std::env::temp_dir().join(format!("dokan-reveal-نسخ المحل-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("completed, backup #401.db.enc");
        std::fs::write(&path, b"read-only native reveal fixture").unwrap();
        assert_eq!(reveal_backup(&path), Ok(()));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"read-only native reveal fixture"
        );
        println!("Native Windows reveal accepted for {}", path.display());
        // Keep the fixture so the selected file can be inspected in Explorer.
    }
}
