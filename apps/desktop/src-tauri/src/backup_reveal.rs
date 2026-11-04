//! Reveal only a completed backup attested by the authenticated, native-owned sidecar.
use std::path::{Component, Path, Prefix};

pub const MISSING: &str = "BACKUP_REVEAL_MISSING";
pub const FAILED: &str = "BACKUP_REVEAL_FAILED";

/// Pure lexical gate. Run before any filesystem lookup, including on the trusted root.
pub fn check_candidate(path: &Path, data_dir: &Path) -> Result<(), &'static str> {
    fn local_path(path: &Path) -> bool {
        let mut parts = path.components();
        if !matches!(parts.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
            || !matches!(parts.next(), Some(Component::RootDir))
        {
            return false;
        }
        // Components normalizes away interior dots. Check the raw spelling too.
        let Some(text) = path.to_str() else {
            return false;
        };
        text[3..].split(['\\', '/']).all(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            !part.is_empty()
                && !part.ends_with(['.', ' '])
                && !part
                    .chars()
                    .any(|c| c <= '\u{1f}' || ":*?\"<>|".contains(c))
                && !matches!(
                    stem.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL"
                        | "COM¹" | "COM²" | "COM³"
                        | "LPT¹" | "LPT²" | "LPT³"
                )
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
    }
    if !local_path(path)
        || !local_path(data_dir)
        || path.parent() != Some(data_dir.join("backups").as_path())
    {
        return Err(FAILED);
    }
    Ok(())
}

/// `audit` must come from the existing activitiesList RPC using a live session,
/// on the native-owned sidecar port. It must never come from command arguments.
pub fn reveal_backup(
    path: &Path,
    data_dir: &Path,
    audit: &serde_json::Value,
) -> Result<(), &'static str> {
    check_candidate(path, data_dir)?;
    let recorded = audit
        .get("json")
        .and_then(|v| v.get("items"))
        .and_then(|v| v.as_array())
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("type").and_then(|v| v.as_str()) == Some("BACKUP_CREATED")
                    && item
                        .get("ref")
                        .and_then(|v| v.as_str())
                        .is_some_and(|recorded| Path::new(recorded) == path)
            })
        });
    if !recorded {
        return Err(FAILED);
    }
    reveal_recorded_file(path)
}

#[cfg(not(windows))]
fn reveal_recorded_file(_path: &Path) -> Result<(), &'static str> {
    Err("BACKUP_REVEAL_UNSUPPORTED")
}

#[cfg(windows)]
fn reveal_recorded_file(path: &Path) -> Result<(), &'static str> {
    // Windows paths accept both separators, but the Shell parser requires its
    // native spelling. Normalize components only after the raw-path rejection.
    let native_path: std::path::PathBuf = path.components().collect();
    let path = native_path.as_path();
    let _pinned = windows::pin_local_file(path)?;
    // Keep every non-reparse component locked against writes/renames until Shell
    // parsing and selection finish. A canonicalize-then-open check would race.
    windows::select_file(path)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            sharing: u32,
            security: *const c_void,
            creation: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
        fn GetFileInformationByHandleEx(
            handle: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }
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

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn file_error(error: std::io::Error) -> &'static str {
        file_error_code(error.raw_os_error())
    }

    pub(super) fn file_error_code(code: Option<i32>) -> &'static str {
        // ERROR_FILE_NOT_FOUND identifies the requested leaf. PATH_NOT_FOUND
        // can describe a missing ancestor or another unresolvable path, so do
        // not tell the user the backup itself is missing.
        if code == Some(2) { MISSING } else { FAILED }
    }

    pub(super) fn pin_local_file(path: &Path) -> Result<Vec<OwnedHandle>, &'static str> {
        // check_candidate already excludes UNC/device prefixes and dot/stream forms.
        let root = path.ancestors().last().ok_or(FAILED)?;
        let root_name = wide(root);
        // SAFETY: root_name is a NUL-terminated drive root. Remote, unknown and
        // substituted network drives are refused before CreateFile touches them.
        if !matches!(unsafe { GetDriveTypeW(root_name.as_ptr()) }, 2 | 3) {
            return Err(FAILED);
        }
        let mut pinned = Vec::new();
        for component in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
            let name = wide(component);
            // SAFETY: pointers and flags follow CreateFileW's contract. OPEN_REPARSE_POINT
            // opens the link itself. Pinned parents cannot be replaced while descending.
            // GENERIC_READ, SHARE_READ only, OPEN_EXISTING, BACKUP_SEMANTICS.
            // Attribute-only handles do not enforce Windows sharing restrictions.
            let raw = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    0x8000_0000,
                    1,
                    ptr::null(),
                    3,
                    0x0200_0000 | 0x0020_0000,
                    ptr::null_mut(),
                )
            };
            if raw as isize == -1 {
                return Err(file_error(std::io::Error::last_os_error()));
            }
            // SAFETY: CreateFileW returned an owned, valid handle.
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            #[repr(C)]
            struct AttributeTag {
                attributes: u32,
                tag: u32,
            }
            let mut info = AttributeTag {
                attributes: 0,
                tag: 0,
            };
            // SAFETY: FileAttributeTagInfo=9 expects exactly this pair of u32s.
            if unsafe {
                GetFileInformationByHandleEx(
                    handle.as_raw_handle(),
                    9,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<AttributeTag>() as u32,
                )
            } == 0
            {
                return Err(FAILED);
            }
            if info.attributes & 0x400 != 0 {
                return Err(FAILED);
            }
            let directory = info.attributes & 0x10 != 0;
            if component == path && directory {
                return Err(MISSING);
            }
            if component != path && !directory {
                return Err(FAILED);
            }
            pinned.push(handle);
        }
        Ok(pinned)
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

    pub(super) fn select_file(path: &Path) -> Result<(), &'static str> {
        let name = wide(path);
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
        // SAFETY: count=0 selects the absolute file PIDL in its parent. All path
        // components remain pinned and no child array is required.
        if unsafe { SHOpenFolderAndSelectItems(pidl.0, 0, ptr::null(), 0) } < 0 {
            Err(FAILED)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_file_error_mapping_only_calls_missing_leaf_missing() {
        assert_eq!(windows::file_error_code(Some(2)), MISSING);
        assert_eq!(windows::file_error_code(Some(3)), FAILED);
        assert_eq!(windows::file_error_code(Some(5)), FAILED);
        assert_eq!(windows::file_error_code(Some(123)), FAILED);
        assert_eq!(windows::file_error_code(None), FAILED);
    }

    fn receipt(path: &Path) -> serde_json::Value {
        serde_json::json!({"json":{"items":[{"type":"BACKUP_CREATED","ref":path}]}})
    }

    #[test]
    #[cfg(windows)]
    fn refuses_extended_dos_device_aliases_before_filesystem_access() {
        for name in ["COM¹.db", "COM².db", "COM³.db", "LPT¹.db", "LPT².db", "LPT³.db"] {
            let root = Path::new("C:/shop");
            assert_eq!(check_candidate(&root.join("backups").join(name), root), Err(FAILED), "{name}");
        }
    }

    #[test]
    #[cfg(windows)]
    fn refuses_an_unattested_local_file() {
        let dir = std::env::temp_dir().join(format!("unattested-401-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("backups")).unwrap();
        let path = dir.join("backups/not-a-completed-backup.txt");
        std::fs::write(&path, b"not a completed backup").unwrap();
        assert_eq!(
            reveal_backup(&path, &dir, &serde_json::json!({"json":{"items":[]}})),
            Err(FAILED)
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn refuses_network_device_stream_and_traversal_paths_without_lookup() {
        let root = Path::new(r"C:\shop");
        for text in [
            r"\\attacker\share\backup.db",
            r"\\?\C:\shop\backups\backup.db",
            r"\\.\C:\shop\backups\backup.db",
            r"C:shop\backups\backup.db",
            r"C:\shop\backups\..\vault.json",
            r"C:\shop\backups\.\backup.db",
            r"C:\shop\backups\backup.db:stream",
            r"C:\shop\backups\NUL.db",
            r"C:\shop\backups\file. ",
            r"C:\other\backups\backup.db",
        ] {
            assert_eq!(
                check_candidate(Path::new(text), root),
                Err(FAILED),
                "{text}"
            );
        }
        assert_eq!(
            check_candidate(Path::new(r"C:\shop\backups\نسخ, #401.db"), root),
            Ok(())
        );
        assert_eq!(
            check_candidate(
                Path::new(r"C:\shop\backups\backup.db"),
                Path::new(r"\\server\shop")
            ),
            Err(FAILED)
        );
    }

    #[test]
    #[cfg(windows)]
    fn refuses_missing_directory_and_wrong_audit_without_selection() {
        let dir = std::env::temp_dir().join(format!("dokan-refusal-401-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("backups")).unwrap();
        let missing = dir.join("backups/missing.db");
        assert_eq!(
            reveal_backup(&missing, &dir, &receipt(&missing)),
            Err(MISSING)
        );
        let directory = dir.join("backups/a-directory");
        std::fs::create_dir(&directory).unwrap();
        assert_eq!(
            reveal_backup(&directory, &dir, &receipt(&directory)),
            Err(MISSING)
        );
        assert_eq!(
            reveal_backup(&missing, &dir, &receipt(&directory)),
            Err(FAILED)
        );
        assert_eq!(
            reveal_backup(
                &missing,
                &dir,
                &serde_json::json!({"json":{"items":[{"type":"ITEM_CREATED","ref":missing}]}})
            ),
            Err(FAILED)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn refuses_a_junction_before_descending_to_its_target() {
        let dir = std::env::temp_dir().join(format!("dokan-junction-401-{}", std::process::id()));
        let outside = dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let link = dir.join("backups");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status()
            .unwrap();
        assert!(status.success());
        let path = link.join("missing.db");
        assert_eq!(reveal_backup(&path, &dir, &receipt(&path)), Err(FAILED));
        std::fs::remove_dir(link).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn pins_file_and_ancestors_against_replacement_and_deletion() {
        let dir = std::env::temp_dir().join(format!("dokan-pinned-401-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("backups")).unwrap();
        let path = dir.join("backups/نسخ, #401.db");
        std::fs::write(&path, b"completed").unwrap();
        let pinned = windows::pin_local_file(&path).unwrap();
        assert!(std::fs::remove_file(&path).is_err());
        assert!(std::fs::rename(dir.join("backups"), dir.join("moved")).is_err());
        assert!(std::fs::write(&path, b"replacement").is_err());
        drop(pinned);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Tests the real Shell boundary with native-side audit data, not renderer authority.
    #[test]
    #[cfg(windows)]
    #[ignore = "requires an interactive Windows desktop"]
    fn windows_reveals_a_recorded_unicode_file_without_modifying_it() {
        let dir =
            std::env::temp_dir().join(format!("dokan-reveal-نسخ المحل-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("backups")).unwrap();
        let path = dir.join("backups/completed, backup #401.db.enc");
        std::fs::write(&path, b"read-only native reveal fixture").unwrap();
        assert_eq!(reveal_backup(&path, &dir, &receipt(&path)), Ok(()));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"read-only native reveal fixture"
        );
        println!("Native Windows reveal accepted for {}", path.display());
    }
}
