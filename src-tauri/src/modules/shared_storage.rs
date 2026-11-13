use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::modules::secrets;

const LEGACY_TEREX_ID: &str = "io.github.3xecutablefile.terex-ui";
const LEGACY_TERAX_ID: &str = "app.crynta.terax";
const LEGACY_SETTINGS: &str = "terax-settings.json";
const LEGACY_TEREX_SETTINGS: &str = "terex-settings.json";
const SETTINGS: &str = "tarex-settings.json";
const IMPORT_MARKER: &str = ".tarex-import.json";
const CREDENTIALS_MARKER: &str = ".tarex-credentials-handled";
const THEME_EXT: &str = ".terax-theme";
const NEW_THEME_EXT: &str = ".tarex-theme";
const MAX_STORE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_THEME_BYTES: u64 = 2 * 1024 * 1024;
const MAX_THEMES: usize = 200;

const STORES: &[(&str, &str)] = &[
    ("terax-ai-sessions.json", "tarex-ai-sessions.json"),
    ("terax-ai-agents.json", "tarex-ai-agents.json"),
    ("terax-ai-snippets.json", "tarex-ai-snippets.json"),
    ("terax-ai-todos.json", "tarex-ai-todos.json"),
    ("terax-spaces.json", "tarex-spaces.json"),
    ("terax-custom-themes.json", "tarex-custom-themes.json"),
];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LegacyImportSummary {
    pub imported: bool,
    pub source: Option<String>,
    pub files: Vec<String>,
    pub notice: Option<String>,
    pub error: Option<String>,
}

impl LegacyImportSummary {
    fn marker(&self) -> ImportMarker {
        ImportMarker {
            version: 1,
            imported: self.imported,
            source: self.source.clone(),
            files: self.files.clone(),
            notice: self.notice.clone(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct ImportMarker {
    version: u32,
    imported: bool,
    source: Option<String>,
    files: Vec<String>,
    notice: Option<String>,
}

impl From<ImportMarker> for LegacyImportSummary {
    fn from(value: ImportMarker) -> Self {
        Self {
            imported: value.imported,
            source: value.source,
            files: value.files,
            notice: value.notice,
            error: None,
        }
    }
}

#[derive(Serialize)]
pub struct SharedStoragePaths {
    pub data: PathBuf,
    pub config: PathBuf,
    pub local_data: PathBuf,
    pub import_summary: LegacyImportSummary,
    pub credentials_available: bool,
}

#[derive(Clone, Debug)]
struct LegacyBundle {
    id: &'static str,
    data: PathBuf,
    config: PathBuf,
    settings: PathBuf,
    modified: u64,
}

pub fn storage_paths(app: &tauri::AppHandle) -> Result<SharedStoragePaths, String> {
    let paths = app.path();
    let data = paths.app_data_dir().map_err(|e| e.to_string())?;
    let config = paths.app_config_dir().map_err(|e| e.to_string())?;
    let local_data = paths.app_local_data_dir().map_err(|e| e.to_string())?;
    let summary = ensure_import(&data, &config);
    let credentials_available = !credentials_handled(&data)
        && secrets::legacy_credentials_available(&legacy_local_candidates(&local_data));
    Ok(SharedStoragePaths {
        data,
        config,
        local_data,
        import_summary: summary,
        credentials_available,
    })
}

#[tauri::command]
pub fn shared_storage_paths(app: tauri::AppHandle) -> Result<SharedStoragePaths, String> {
    storage_paths(&app)
}

pub fn legacy_local_data_dirs(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(legacy_local_candidates(&local_data))
}

fn legacy_local_candidates(local_data: &Path) -> Vec<PathBuf> {
    [LEGACY_TEREX_ID, LEGACY_TERAX_ID]
        .into_iter()
        .map(|id| local_data.with_file_name(id))
        .filter(|path| path.is_dir())
        .collect()
}

fn legacy_bundles(data: &Path, config: &Path) -> Vec<LegacyBundle> {
    let mut bundles = Vec::new();
    for (index, id) in [LEGACY_TEREX_ID, LEGACY_TERAX_ID].into_iter().enumerate() {
        let data = data.with_file_name(id);
        let config = config.with_file_name(id);
        let Some(settings) = [data.join(LEGACY_SETTINGS), data.join(LEGACY_TEREX_SETTINGS)]
            .into_iter()
            .find(|path| path.is_file())
        else {
            continue;
        };
        let modified = settings
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(index as u64);
        bundles.push(LegacyBundle {
            id,
            data,
            config,
            settings,
            modified,
        });
    }
    bundles.sort_by(|a, b| b.modified.cmp(&a.modified));
    bundles
}

fn marker_path(data: &Path) -> PathBuf {
    data.join(IMPORT_MARKER)
}

fn credentials_handled(data: &Path) -> bool {
    data.join(CREDENTIALS_MARKER).is_file()
}

fn read_marker(data: &Path) -> Option<LegacyImportSummary> {
    let bytes = fs::read(marker_path(data)).ok()?;
    serde_json::from_slice::<ImportMarker>(&bytes)
        .ok()
        .map(Into::into)
}

fn write_marker(data: &Path, summary: &LegacyImportSummary) -> Result<(), String> {
    fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&summary.marker()).map_err(|e| e.to_string())?;
    write_atomic(&marker_path(data), &bytes).map_err(|e| e.to_string())
}

pub fn mark_credentials_handled(app: &tauri::AppHandle) -> Result<(), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    write_atomic(&data.join(CREDENTIALS_MARKER), b"1").map_err(|e| e.to_string())
}

fn ensure_import(data: &Path, config: &Path) -> LegacyImportSummary {
    if let Some(summary) = read_marker(data) {
        return summary;
    }
    if data.join(SETTINGS).is_file()
        || STORES
            .iter()
            .any(|(_, new_name)| data.join(new_name).is_file())
    {
        let summary = LegacyImportSummary::default();
        let _ = write_marker(data, &summary);
        return summary;
    }
    let bundles = legacy_bundles(data, config);
    let Some(bundle) = bundles.first() else {
        let summary = LegacyImportSummary::default();
        let _ = write_marker(data, &summary);
        return summary;
    };
    match import_bundle(bundle, data, config) {
        Ok(summary) => {
            let _ = write_marker(data, &summary);
            summary
        }
        Err(error) => LegacyImportSummary {
            error: Some(error),
            ..LegacyImportSummary::default()
        },
    }
}

fn import_bundle(
    bundle: &LegacyBundle,
    data: &Path,
    config: &Path,
) -> Result<LegacyImportSummary, String> {
    let mut summary = LegacyImportSummary {
        imported: true,
        source: Some(bundle.id.to_string()),
        ..LegacyImportSummary::default()
    };
    let mut background_reset = false;

    let settings = import_settings(&bundle.settings, &data.join(SETTINGS), &mut background_reset)?;
    if settings {
        summary.files.push(SETTINGS.to_string());
    }

    for (old_name, new_name) in STORES {
        let source = bundle.data.join(old_name);
        let destination = data.join(new_name);
        if copy_json_file(&source, &destination, MAX_STORE_BYTES) {
            summary.files.push((*new_name).to_string());
        }
    }

    let theme_dir = config.join("themes");
    let source_theme_dir = bundle.config.join("themes");
    if source_theme_dir.is_dir() {
        let mut count = 0;
        if let Ok(entries) = fs::read_dir(&source_theme_dir) {
            for entry in entries.flatten() {
                if count >= MAX_THEMES {
                    break;
                }
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if !name.to_ascii_lowercase().ends_with(THEME_EXT) {
                    continue;
                }
                let destination = theme_dir.join(format!(
                    "{}{}",
                    &name[..name.len() - THEME_EXT.len()],
                    NEW_THEME_EXT
                ));
                if copy_json_file(&path, &destination, MAX_THEME_BYTES) {
                    summary.files.push(format!(
                        "themes/{}",
                        destination
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("theme")
                    ));
                    count += 1;
                }
            }
        }
    }

    if background_reset {
        summary.notice = Some(
            "Imported your Terex/Terax settings, chats, agents, snippets, spaces, and themes. Background images were not copied; choose a new image in Settings.".to_string(),
        );
    } else if !summary.files.is_empty() {
        summary.notice = Some(
            "Imported your Terex/Terax settings, chats, agents, snippets, spaces, and themes."
                .to_string(),
        );
    }
    Ok(summary)
}

fn import_settings(source: &Path, destination: &Path, background_reset: &mut bool) -> Result<bool, String> {
    if destination.exists() {
        return Ok(false);
    }
    let bytes = read_regular_file(source, MAX_STORE_BYTES)?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid legacy settings: {e}"))?;
    let Some(object) = value.as_object_mut() else {
        return Err("legacy settings is not an object".to_string());
    };
    if object.get("themeId").and_then(|value| value.as_str()) == Some("terax-default") {
        object.insert(
            "themeId".to_string(),
            serde_json::Value::String("tarex-default".to_string()),
        );
    }
    if object.get("backgroundKind").and_then(|value| value.as_str()) == Some("image") {
        object.insert(
            "backgroundKind".to_string(),
            serde_json::Value::String("none".to_string()),
        );
        object.insert("backgroundImageId".to_string(), serde_json::Value::Null);
        *background_reset = true;
    }
    let rendered = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    write_atomic(destination, &rendered).map_err(|e| e.to_string())?;
    Ok(true)
}

fn copy_json_file(source: &Path, destination: &Path, max_bytes: u64) -> bool {
    if destination.exists() {
        return false;
    }
    let Ok(bytes) = read_regular_file(source, max_bytes) else {
        return false;
    };
    if serde_json::from_slice::<serde_json::Value>(&bytes).is_err() {
        return false;
    }
    write_atomic(destination, &bytes).is_ok()
}

fn read_regular_file(source: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("not a regular file".to_string());
    }
    if metadata.len() > max_bytes {
        return Err("file is too large".to_string());
    }
    fs::read(source).map_err(|e| e.to_string())
}

fn write_atomic(destination: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("tarex");
    let temporary = destination.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ));
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data-root/new-data");
        let config = root.path().join("config-root/new-config");
        (root, data, config)
    }

    #[test]
    fn imports_non_secret_legacy_data_and_transforms_settings() {
        let (root, data, config) = setup();
        let old = root.path().join("data-root").join(LEGACY_TERAX_ID);
        write(
            &old.join(LEGACY_SETTINGS),
            r#"{"themeId":"terax-default","backgroundKind":"image","backgroundImageId":"bg-1","customInstructions":"keep"}"#,
        );
        write(&old.join("terax-ai-sessions.json"), r#"{"sessions":[]}"#);
        write(&old.join("suspended-processes.json"), r#"[123]"#);
        write(&old.join("secrets.json"), r#"{"terax-ai::openai-api-key":"secret"}"#);
        let old_config = root.path().join("config-root").join(LEGACY_TERAX_ID);
        write(&old_config.join("themes/mine.terax-theme"), r#"{"id":"mine"}"#);

        let summary = ensure_import(&data, &config);
        assert!(summary.imported);
        assert_eq!(summary.source.as_deref(), Some(LEGACY_TERAX_ID));
        assert!(summary.error.is_none());
        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(data.join(SETTINGS)).unwrap()).unwrap();
        assert_eq!(settings["themeId"], "tarex-default");
        assert_eq!(settings["backgroundKind"], "none");
        assert!(settings["backgroundImageId"].is_null());
        assert_eq!(settings["customInstructions"], "keep");
        assert!(data.join("tarex-ai-sessions.json").is_file());
        assert!(!data.join("suspended-processes.json").exists());
        assert!(!data.join("secrets.json").exists());
        assert!(config.join("themes/mine.tarex-theme").is_file());
        assert!(!config.join("themes/mine.terax-theme").exists());
        assert!(data.join(IMPORT_MARKER).is_file());
        assert!(summary.files.contains(&"tarex-ai-sessions.json".to_string()));
        assert!(summary.files.iter().any(|file| file.contains("mine.tarex-theme")));
    }

    #[test]
    fn does_not_overwrite_existing_new_data_or_import_twice() {
        let (root, data, config) = setup();
        let old = root.path().join("data-root").join(LEGACY_TERAX_ID);
        write(&old.join(LEGACY_SETTINGS), r#"{"themeId":"old"}"#);
        write(&data.join(SETTINGS), r#"{"themeId":"new"}"#);
        let summary = ensure_import(&data, &config);
        assert!(!summary.imported);
        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(data.join(SETTINGS)).unwrap()).unwrap();
        assert_eq!(settings["themeId"], "new");
        assert!(data.join(IMPORT_MARKER).is_file());
        let second = ensure_import(&data, &config);
        assert!(!second.imported);
    }

    #[test]
    fn skips_symlinked_and_malformed_files() {
        let (root, data, config) = setup();
        let old = root.path().join("data-root").join(LEGACY_TERAX_ID);
        write(&old.join(LEGACY_SETTINGS), r#"{"themeId":"terax-default"}"#);
        write(&old.join("terax-ai-sessions.json"), "not json");
        let secret = root.path().join("outside.json");
        write(&secret, r#"{"sessions":[]}"#);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, old.join("terax-spaces.json")).unwrap();
        let summary = ensure_import(&data, &config);
        assert!(summary.imported);
        assert!(!data.join("tarex-ai-sessions.json").exists());
        assert!(!data.join("tarex-spaces.json").exists());
        assert!(summary.error.is_none());
    }

    #[test]
    fn picks_newest_valid_legacy_settings() {
        let (root, data, config) = setup();
        let older = root.path().join("data-root").join(LEGACY_TEREX_ID);
        write(&older.join(LEGACY_SETTINGS), r#"{"themeId":"terex"}"#);
        let newer = root.path().join("data-root").join(LEGACY_TERAX_ID);
        write(&newer.join(LEGACY_SETTINGS), r#"{"themeId":"terax"}"#);
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        let _ = filetime_set(&newer.join(LEGACY_SETTINGS), later);
        let summary = ensure_import(&data, &config);
        assert_eq!(summary.source.as_deref(), Some(LEGACY_TERAX_ID));
    }

    fn filetime_set(path: &Path, time: std::time::SystemTime) -> std::io::Result<()> {
        let file = fs::OpenOptions::new().write(true).open(path)?;
        file.set_times(fs::FileTimes::new().set_modified(time))
    }
}
