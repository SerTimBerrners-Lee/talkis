use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRuntimeInfo {
    executable_path: String,
    bundle_path: String,
    launched_via_translocation: bool,
    launched_from_mounted_volume: bool,
    should_move_to_applications: bool,
}

fn build_runtime_info() -> Result<AppRuntimeInfo, String> {
    let executable_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let executable_path_str = executable_path.to_string_lossy().to_string();
    let bundle_path = executable_path
        .ancestors()
        .find(|path| path.extension().map(|ext| ext == "app").unwrap_or(false))
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| executable_path.clone());
    let bundle_path_str = bundle_path.to_string_lossy().to_string();
    let launched_via_translocation = executable_path_str.contains("/AppTranslocation/");
    let launched_from_mounted_volume = bundle_path_str.starts_with("/Volumes/");

    // In dev builds, never warn about Applications — the binary is
    // expected to live wherever target-dir points.
    let should_move = if cfg!(dev) {
        false
    } else {
        launched_via_translocation || launched_from_mounted_volume
    };

    Ok(AppRuntimeInfo {
        executable_path: executable_path_str,
        bundle_path: bundle_path_str,
        launched_via_translocation,
        launched_from_mounted_volume,
        should_move_to_applications: should_move,
    })
}

#[tauri::command]
pub fn get_app_runtime_info() -> Result<AppRuntimeInfo, String> {
    build_runtime_info()
}
