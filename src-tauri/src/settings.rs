//! `settings.json` in the app config directory: the list of watched services.
//!
//! This side only reads and writes the text. What is in it, and repairing it
//! when it is broken, is `src/lib/settings.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Could not locate the config directory: {err}"))?;
    Ok(dir.join("settings.json"))
}

/// The file's text, or `None` on a first launch.
#[tauri::command]
pub fn settings_load(app: AppHandle) -> Result<Option<String>, String> {
    read_optional(&settings_path(&app)?)
}

/// Replace the file's text.
#[tauri::command]
pub fn settings_save(app: AppHandle, contents: String) -> Result<(), String> {
    write_atomic(&settings_path(&app)?, &contents)
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Could not read {}: {err}", path.display())),
    }
}

/// Write to a sibling temp file, then rename over the target.
///
/// The file is the only record of the services you added. A crash or a full
/// disk mid-write must leave the old list, not half of a new one: a rename is
/// atomic on the same volume, a plain overwrite is not.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create {}: {err}", parent.display()))?;
    }

    let temp = path.with_extension("json.tmp");
    fs::write(&temp, contents)
        .map_err(|err| format!("Could not write {}: {err}", temp.display()))?;

    fs::rename(&temp, path).map_err(|err| {
        // Best-effort cleanup so a failed rename doesn't leave litter behind.
        let _ = fs::remove_file(&temp);
        format!("Could not save {}: {err}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory per test, under the system temp dir.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("app-status-tracker-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_first_launch_reads_as_none() {
        let dir = scratch("first-launch");
        assert_eq!(read_optional(&dir.join("settings.json")), Ok(None));
    }

    #[test]
    fn writes_create_the_directory_and_round_trip() {
        let dir = scratch("round-trip");
        let path = dir.join("nested").join("settings.json");
        write_atomic(&path, "{\"services\":[]}").unwrap();
        assert_eq!(
            read_optional(&path),
            Ok(Some("{\"services\":[]}".to_owned()))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_replaces_the_old_contents_and_leaves_no_temp_file() {
        let dir = scratch("replace");
        let path = dir.join("settings.json");
        write_atomic(&path, "old").unwrap();
        write_atomic(&path, "new").unwrap();
        assert_eq!(read_optional(&path), Ok(Some("new".to_owned())));
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
