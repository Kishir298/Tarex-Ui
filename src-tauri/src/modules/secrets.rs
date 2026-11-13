//! Secret storage with platform-appropriate backends.
//!
//! - macOS: macOS Keychain (via `keyring` crate)
//! - Windows: Credential Manager (via `keyring` crate)
//! - Linux: a file in the app's local data dir, mode 0600. The default
//!   `keyring` backend on Linux is the Secret Service over D-Bus, which
//!   silently fails on systems without gnome-keyring/kwallet (and on the
//!   "login" collection not being created). For an open-source desktop
//!   app shipped via AppImage/deb/rpm, we cannot assume a keyring daemon
//!   exists. The file backend is the same approach Brave/Chromium fall
//!   back to in that scenario; user-only file permissions provide the
//!   isolation the secret-service collection would have otherwise.
//!
//! The frontend talks to `secrets_get`, `secrets_set`, `secrets_delete`,
//! and `secrets_get_all` — no platform branching in JS.
//!
//! All commands take `&AppHandle` so we can resolve the data directory
//! once via Tauri's path API.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::AppHandle;

const LEGACY_KEYRING_SERVICE: &str = "terax-ai";
const KEYRING_ACCOUNTS: &[&str] = &[
    "openai-api-key",
    "anthropic-api-key",
    "google-api-key",
    "xai-api-key",
    "cerebras-api-key",
    "groq-api-key",
    "deepseek-api-key",
    "mistral-api-key",
    "openrouter-api-key",
    "openai-compatible-api-key",
];

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

#[derive(Default)]
pub struct SecretsState {
    #[cfg(target_os = "linux")]
    cache: Mutex<Option<HashMap<String, String>>>,
    #[cfg(not(target_os = "linux"))]
    _phantom: Mutex<()>,
}

#[cfg(target_os = "linux")]
pub(crate) fn key(service: &str, account: &str) -> String {
    format!("{}::{}", service, account)
}

#[cfg(target_os = "linux")]
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::modules::shared_storage::storage_paths(app)?.local_data;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

#[cfg(target_os = "linux")]
fn read_store(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    read_store_at(&store_path(app)?)
}

#[cfg(target_os = "linux")]
pub(crate) fn read_store_at(path: &std::path::Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice::<HashMap<String, String>>(&bytes).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn write_store(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    write_store_at(&store_path(app)?, map)
}

#[cfg(target_os = "linux")]
pub(crate) fn write_store_at(
    path: &std::path::Path,
    map: &HashMap<String, String>,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;

    // 0600: only the owning user can read or write the secrets file.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn with_store<F, R>(app: &AppHandle, state: &SecretsState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut HashMap<String, String>) -> R,
{
    let mut guard = state.cache.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(read_store(app)?);
    }
    let map = guard.as_mut().expect("cache initialized above");
    Ok(f(map))
}

#[cfg(not(target_os = "linux"))]
fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| e.to_string())
}


pub fn legacy_credentials_available(legacy_local_dirs: &[PathBuf]) -> bool {
    #[cfg(target_os = "linux")]
    {
        legacy_local_dirs.iter().any(|dir| {
            read_store_at(&dir.join("secrets.json"))
                .map(|map| {
                    map.keys()
                        .any(|key| key.starts_with(&format!("{LEGACY_KEYRING_SERVICE}::")))
                })
                .unwrap_or(false)
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = legacy_local_dirs;
        KEYRING_ACCOUNTS.iter().any(|account| {
            keyring::Entry::new(LEGACY_KEYRING_SERVICE, account)
                .ok()
                .and_then(|entry| entry.get_password().ok())
                .is_some_and(|value| !value.is_empty())
        })
    }
}

fn custom_endpoint_accounts(data: &std::path::Path) -> Vec<String> {
    let path = data.join("tarex-settings.json");
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Vec::new();
    };
    value
        .get("customEndpoints")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|endpoint| endpoint.get("id").and_then(|value| value.as_str()))
        .map(|id| format!("compat-{id}-api-key"))
        .collect()
}

fn copy_legacy_credentials(
    app: &AppHandle,
    state: &tauri::State<'_, SecretsState>,
    skip: bool,
) -> Result<usize, String> {
    if skip {
        return Ok(0);
    }
    let paths = crate::modules::shared_storage::storage_paths(app)?;
    let mut accounts = KEYRING_ACCOUNTS
        .iter()
        .map(|account| (*account).to_string())
        .collect::<Vec<_>>();
    accounts.extend(custom_endpoint_accounts(&paths.data));

    #[cfg(target_os = "linux")]
    {
        let mut legacy = HashMap::new();
        for dir in crate::modules::shared_storage::legacy_local_data_dirs(app)? {
            if let Ok(map) = read_store_at(&dir.join("secrets.json")) {
                for (key, value) in map {
                    if let Some(account) = key.strip_prefix(&format!("{LEGACY_KEYRING_SERVICE}::"))
                    {
                        legacy.insert(account.to_string(), value);
                    }
                }
            }
        }
        if legacy.is_empty() {
            return Ok(0);
        }
        let mut imported = 0;
        with_store(app, state, |map| {
            for (account, value) in legacy {
                let destination = key("tarex-ai", &account);
                if !map.contains_key(&destination) && !value.is_empty() {
                    map.insert(destination, value);
                    imported += 1;
                }
            }
        })?;
        if imported > 0 {
            let snapshot = {
                let guard = state.cache.lock().map_err(|e| e.to_string())?;
                guard.as_ref().cloned().unwrap_or_default()
            };
            write_store(app, &snapshot)?;
        }
        Ok(imported)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = state;
        let mut imported = 0;
        for account in accounts {
            let Ok(old) = keyring::Entry::new(LEGACY_KEYRING_SERVICE, &account) else {
                continue;
            };
            let Ok(value) = old.get_password() else {
                continue;
            };
            if value.is_empty() {
                continue;
            }
            let Ok(destination) = keyring::Entry::new("tarex-ai", &account) else {
                continue;
            };
            if destination.get_password().is_ok() {
                continue;
            }
            if destination.set_password(&value).is_ok() {
                imported += 1;
            }
        }
        Ok(imported)
    }
}

#[tauri::command]
pub async fn legacy_import_credentials(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    skip: bool,
) -> Result<usize, String> {
    let result = copy_legacy_credentials(&app, &state, skip);
    if result.is_ok() {
        crate::modules::shared_storage::mark_credentials_handled(&app)?;
    }
    result
}

#[tauri::command]
pub async fn secrets_get(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        let _ = state; // capture
        let key = key(&service, &account);
        with_store(&app, &state, |m| m.get(&key).cloned())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[tauri::command]
pub async fn secrets_set(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let key = key(&service, &account);
        with_store(&app, &state, |m| {
            m.insert(key, password);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(&app, &snapshot)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        e.set_password(&password).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn secrets_delete(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let key = key(&service, &account);
        with_store(&app, &state, |m| {
            m.remove(&key);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(&app, &snapshot)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use tempfile::TempDir;

    #[test]
    fn key_format_is_service_double_colon_account() {
        assert_eq!(key("openai", "alice"), "openai::alice");
        assert_eq!(key("", ""), "::");
    }

    #[test]
    fn read_store_at_missing_path_is_empty() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nope.json");
        let map = read_store_at(&p).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        let mut m = HashMap::new();
        m.insert(key("svc", "alice"), "p1".into());
        m.insert(key("svc", "bob"), "p2".into());

        write_store_at(&p, &m).unwrap();
        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, m);
    }

    #[test]
    fn write_uses_mode_0600() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let mode = fs::metadata(&p).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600, "secrets file must be user-only readable");
    }

    #[test]
    fn write_does_not_leave_tmp_file_on_success() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let tmp_path = p.with_extension("json.tmp");
        assert!(!tmp_path.exists(), "tmp file must be renamed away on success");
    }

    #[test]
    fn write_overwrites_existing_atomically() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");

        let mut first = HashMap::new();
        first.insert("a".into(), "1".into());
        write_store_at(&p, &first).unwrap();

        let mut second = HashMap::new();
        second.insert("b".into(), "2".into());
        write_store_at(&p, &second).unwrap();

        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, second);
        assert!(!loaded.contains_key("a"));
    }

    #[test]
    fn read_store_at_garbage_file_errors() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        fs::write(&p, b"not json").unwrap();
        assert!(read_store_at(&p).is_err());
    }
}

/// Batch read — single IPC roundtrip for the cold-boot fan-out.
#[tauri::command]
pub async fn secrets_get_all(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    #[cfg(target_os = "linux")]
    {
        with_store(&app, &state, |m| {
            accounts
                .iter()
                .map(|a| m.get(&key(&service, a)).cloned())
                .collect()
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        Ok(accounts
            .into_iter()
            .map(|a| {
                keyring::Entry::new(&service, &a)
                    .ok()
                    .and_then(|e| e.get_password().ok())
            })
            .collect())
    }
}
