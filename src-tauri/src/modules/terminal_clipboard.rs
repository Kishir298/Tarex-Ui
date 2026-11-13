use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use serde::Serialize;
use std::{
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Default)]
pub struct TerminalClipboardState(Arc<Mutex<Option<tempfile::TempDir>>>);

impl TerminalClipboardState {
    pub fn cleanup(&self) {
        if let Ok(mut directory) = self.0.lock() {
            directory.take();
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ClipboardContent {
    Text { text: String },
    Image { path: String },
}

fn save_image(
    directory: &mut Option<tempfile::TempDir>,
    image: &tauri::image::Image<'_>,
) -> Result<PathBuf, String> {
    let pixels = u64::from(image.width()) * u64::from(image.height());
    if pixels == 0 || pixels > 32 * 1024 * 1024 || pixels * 4 != image.rgba().len() as u64 {
        return Err("Clipboard image dimensions are invalid or exceed 32 megapixels".into());
    }
    if directory.is_none() {
        let dir = tempfile::Builder::new()
            .prefix("tarex-clipboard-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        *directory = Some(dir);
    }
    let dir = directory
        .as_ref()
        .ok_or("Clipboard image directory unavailable")?;
    let mut file = tempfile::Builder::new()
        .prefix("paste-")
        .suffix(".png")
        .tempfile_in(dir.path())
        .map_err(|e| e.to_string())?;
    {
        let mut output = std::io::BufWriter::new(file.as_file_mut());
        PngEncoder::new(&mut output)
            .write_image(
                image.rgba(),
                image.width(),
                image.height(),
                ExtendedColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?;
        output.flush().map_err(|e| e.to_string())?;
    }
    let (_, path) = file.keep().map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn terminal_clipboard_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalClipboardState>,
) -> Result<Option<ClipboardContent>, String> {
    let directory = state.0.clone();
    // Clipboard reads must stay off the UI thread: X11/Wayland owners may need it to reply.
    tauri::async_runtime::spawn_blocking(move || {
        let mut directory = directory.lock().map_err(|e| e.to_string())?;
        if let Ok(image) = app.clipboard().read_image() {
            let path = save_image(&mut directory, &image)?;
            return Ok(Some(ClipboardContent::Image {
                path: path.to_string_lossy().into_owned(),
            }));
        }
        Ok(app
            .clipboard()
            .read_text()
            .ok()
            .filter(|text| !text.is_empty())
            .map(|text| ClipboardContent::Text { text }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_round_trip_to_private_unique_files_and_cleanup() {
        let state = TerminalClipboardState::default();
        let image = tauri::image::Image::new_owned(vec![1, 2, 3, 255, 4, 5, 6, 128], 2, 1);
        let path = save_image(&mut state.0.lock().unwrap(), &image).unwrap();
        let other = save_image(&mut state.0.lock().unwrap(), &image).unwrap();
        assert_ne!(path, other);
        assert_eq!(
            image::open(&path).unwrap().to_rgba8().as_raw(),
            image.rgba()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        state.cleanup();
        assert!(!path.exists() && !other.exists());
    }

    #[test]
    fn invalid_images_do_not_create_files() {
        let mut directory = None;
        for image in [
            tauri::image::Image::new_owned(vec![], 0, 1),
            tauri::image::Image::new_owned(vec![0; 3], 1, 1),
            tauri::image::Image::new_owned(vec![], u32::MAX, u32::MAX),
        ] {
            assert!(save_image(&mut directory, &image).is_err());
            assert!(directory.is_none());
        }
    }
}
