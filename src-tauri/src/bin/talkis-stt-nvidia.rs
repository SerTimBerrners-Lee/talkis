use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

const SERVER_NAME: &str = "talkis-stt-nvidia";
const ENGINE_NAME: &str = "parakeet-mlx";
const MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;
const ENGINE_SCRIPT_NAME: &str = "nvidia_engine.py";
const NVIDIA_ENGINE_SCRIPT: &str = include_str!("../runtime_engines/nvidia_engine.py");
const PORTABLE_PYTHON_VERSION: &str = "3.12.13";
const PORTABLE_PYTHON_RELEASE: &str = "20260510";
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

struct RuntimeConfig {
    host: String,
    port: u16,
    data_dir: PathBuf,
    models_dir: PathBuf,
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct ParakeetModel {
    id: &'static str,
    aliases: &'static [&'static str],
    dir_name: &'static str,
}

struct PortablePythonAsset {
    target: &'static str,
    url: &'static str,
    sha256: &'static str,
}

struct MultipartData {
    fields: HashMap<String, String>,
    file: Vec<u8>,
}

const PARAKEET_MODELS: &[ParakeetModel] = &[
    ParakeetModel {
        id: "mlx-community/parakeet-tdt-0.6b-v3",
        aliases: &[
            "nvidia/parakeet-tdt-0.6b-v3",
            "parakeet-tdt-06b-v3",
            "parakeet-tdt-0.6b-v3",
        ],
        dir_name: "parakeet-tdt-06b-v3",
    },
    ParakeetModel {
        id: "mlx-community/parakeet-tdt-0.6b-v2",
        aliases: &[
            "nvidia/parakeet-tdt-0.6b-v2",
            "parakeet-tdt-06b-v2",
            "parakeet-tdt-0.6b-v2",
        ],
        dir_name: "parakeet-tdt-06b-v2",
    },
];

const PORTABLE_PYTHON_ASSETS: &[PortablePythonAsset] = &[
    PortablePythonAsset {
        target: "aarch64-apple-darwin",
        url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.12.13%2B20260510-aarch64-apple-darwin-install_only.tar.gz",
        sha256: "5a30271f8d345a5b02b0c9e4e31e0f1e1455a8e4a04fba95cd9762472abc3b17",
    },
    PortablePythonAsset {
        target: "x86_64-apple-darwin",
        url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.12.13%2B20260510-x86_64-apple-darwin-install_only.tar.gz",
        sha256: "cd369e76973c3179bc578230d8615ab621968ed758c5e32f636eecef4ad79894",
    },
];

fn main() {
    let config = parse_args();
    if let Err(err) = fs::create_dir_all(&config.data_dir) {
        eprintln!("failed to prepare data dir: {}", err);
        std::process::exit(1);
    }

    if let Err(err) = fs::create_dir_all(&config.models_dir) {
        eprintln!("failed to prepare model dir: {}", err);
        std::process::exit(1);
    }

    let bind_addr = format!("{}:{}", config.host, config.port);
    let listener = TcpListener::bind(&bind_addr).unwrap_or_else(|err| {
        eprintln!("failed to bind {}: {}", bind_addr, err);
        std::process::exit(1);
    });

    eprintln!("{} listening on {}", SERVER_NAME, bind_addr);
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle_connection(stream, &config),
            Err(err) => eprintln!("connection error: {}", err),
        }
    }
}

fn parse_args() -> RuntimeConfig {
    let mut host = "127.0.0.1".to_string();
    let mut port = 8001;
    let mut data_dir = default_data_dir();
    let mut custom_models_dir: Option<PathBuf> = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--host" => {
                if let Some(value) = args.next() {
                    host = value;
                }
            }
            "--port" => {
                if let Some(value) = args.next() {
                    port = value.parse().unwrap_or(port);
                }
            }
            "--data-dir" => {
                if let Some(value) = args.next() {
                    data_dir = PathBuf::from(value);
                }
            }
            "--models-dir" => {
                if let Some(value) = args.next() {
                    custom_models_dir = Some(PathBuf::from(value));
                }
            }
            _ => {}
        }
    }

    let models_dir = custom_models_dir.unwrap_or_else(|| data_dir.join("models"));

    RuntimeConfig {
        host,
        port,
        data_dir,
        models_dir,
    }
}

fn default_data_dir() -> PathBuf {
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join("Library")
        .join("Application Support")
        .join("com.trixter.talkis")
        .join("local-stt")
}

fn handle_connection(mut stream: TcpStream, config: &RuntimeConfig) {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(message) => {
            let _ = write_json(&mut stream, 400, json!({ "error": message }).to_string());
            return;
        }
    };

    let response = route_request(&request, config);
    let _ = write_json(&mut stream, response.0, response.1);
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut buffer = Vec::new();
    let mut temp = [0u8; 8192];
    let header_end;

    loop {
        let bytes_read = stream
            .read(&mut temp)
            .map_err(|err| format!("read error: {}", err))?;
        if bytes_read == 0 {
            return Err("empty request".to_string());
        }
        buffer.extend_from_slice(&temp[..bytes_read]);
        if buffer.len() > MAX_REQUEST_BYTES {
            return Err("request too large".to_string());
        }
        if let Some(index) = find_subsequence(&buffer, b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
    }

    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.lines();
    let first_line = lines.next().ok_or_else(|| "bad request".to_string())?;
    let mut first_parts = first_line.split_whitespace();
    let method = first_parts
        .next()
        .ok_or_else(|| "missing method".to_string())?
        .to_string();
    let path = first_parts
        .next()
        .ok_or_else(|| "missing path".to_string())?
        .to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);

    while buffer.len() < header_end + content_length {
        let bytes_read = stream
            .read(&mut temp)
            .map_err(|err| format!("read body error: {}", err))?;
        if bytes_read == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..bytes_read]);
        if buffer.len() > MAX_REQUEST_BYTES {
            return Err("request too large".to_string());
        }
    }

    let body_end = (header_end + content_length).min(buffer.len());
    Ok(HttpRequest {
        method,
        path,
        headers,
        body: buffer[header_end..body_end].to_vec(),
    })
}

fn route_request(request: &HttpRequest, config: &RuntimeConfig) -> (u16, String) {
    let path = request.path.split('?').next().unwrap_or(&request.path);

    match (request.method.as_str(), path) {
        ("GET", "/health") => (
            200,
            json!({
                "status": "ok",
                "runtime": SERVER_NAME,
                "engine": ENGINE_NAME,
                "configured": engine_ready(config)
            })
            .to_string(),
        ),
        ("GET", "/v1/models") => (
            200,
            json!({
                "object": "list",
                "data": installed_models(config)
                    .into_iter()
                    .map(|id| json!({ "id": id, "object": "model" }))
                    .collect::<Vec<_>>()
            })
            .to_string(),
        ),
        ("POST", "/v1/audio/transcriptions") => match transcribe(request, config) {
            Ok(text) => (200, json!({ "text": text }).to_string()),
            Err((status, message)) => (
                status,
                json!({ "error": { "message": message, "type": "local_stt_error" } }).to_string(),
            ),
        },
        _ if request.method == "POST" && path.starts_with("/v1/models/") => {
            let encoded_model = path.trim_start_matches("/v1/models/");
            let model = percent_decode(encoded_model);
            match install_model(config, &model) {
                Ok(id) => (
                    200,
                    json!({
                        "id": id,
                        "object": "model",
                        "status": "downloaded"
                    })
                    .to_string(),
                ),
                Err((status, message)) => (
                    status,
                    json!({ "error": { "message": message, "type": "local_stt_error" } })
                        .to_string(),
                ),
            }
        }
        _ if request.method == "DELETE" && path.starts_with("/v1/models/") => {
            let encoded_model = path.trim_start_matches("/v1/models/");
            let model = percent_decode(encoded_model);
            match delete_model(config, &model) {
                Ok(id) => (
                    200,
                    json!({
                        "id": id,
                        "object": "model",
                        "status": "deleted"
                    })
                    .to_string(),
                ),
                Err((status, message)) => (
                    status,
                    json!({ "error": { "message": message, "type": "local_stt_error" } })
                        .to_string(),
                ),
            }
        }
        _ => (
            404,
            json!({ "error": "Not found", "path": path }).to_string(),
        ),
    }
}

fn find_model(value: &str) -> Option<&'static ParakeetModel> {
    PARAKEET_MODELS.iter().find(|model| {
        model.id.eq_ignore_ascii_case(value)
            || model.dir_name.eq_ignore_ascii_case(value)
            || model
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(value))
    })
}

fn model_dir(config: &RuntimeConfig, model: &ParakeetModel) -> PathBuf {
    config.models_dir.join(model.dir_name)
}

fn marker_path(config: &RuntimeConfig, model: &ParakeetModel) -> PathBuf {
    config.models_dir.join(format!("{}.json", model.dir_name))
}

fn engine_dir(config: &RuntimeConfig) -> PathBuf {
    config.data_dir.join("runtime").join("parakeet-engine")
}

fn engine_script_path(config: &RuntimeConfig) -> PathBuf {
    engine_dir(config).join(ENGINE_SCRIPT_NAME)
}

fn venv_dir(config: &RuntimeConfig) -> PathBuf {
    engine_dir(config).join(".venv")
}

fn venv_python(config: &RuntimeConfig) -> PathBuf {
    if cfg!(windows) {
        venv_dir(config).join("Scripts").join("python.exe")
    } else {
        venv_dir(config).join("bin").join("python")
    }
}

fn portable_python_dir(config: &RuntimeConfig) -> PathBuf {
    engine_dir(config).join(format!(
        "python-{}-{}-{}",
        PORTABLE_PYTHON_VERSION,
        PORTABLE_PYTHON_RELEASE,
        platform_target()
    ))
}

fn portable_python_path(config: &RuntimeConfig) -> PathBuf {
    if cfg!(windows) {
        portable_python_dir(config).join("python.exe")
    } else {
        portable_python_dir(config).join("bin").join("python3")
    }
}

fn engine_ready(config: &RuntimeConfig) -> bool {
    engine_script_path(config).is_file()
        && venv_python(config).is_file()
        && engine_dir(config).join("dependencies.ok").is_file()
        && venv_is_usable(config)
}

fn install_model(config: &RuntimeConfig, requested: &str) -> Result<String, (u16, String)> {
    let model = find_model(requested).ok_or_else(|| {
        (
            404,
            format!(
                "Модель «{}» не поддерживается встроенным Parakeet runtime.",
                requested
            ),
        )
    })?;

    fs::create_dir_all(&config.models_dir).map_err(|err| {
        (
            500,
            format!("Не удалось подготовить директорию моделей: {}", err),
        )
    })?;
    ensure_engine(config)?;

    let destination = model_dir(config, model);
    if !destination.join("config.json").is_file() {
        fs::create_dir_all(&destination).map_err(|err| {
            (
                500,
                format!("Не удалось подготовить директорию Parakeet модели: {}", err),
            )
        })?;

        run_engine_command(
            config,
            vec![
                "download".to_string(),
                "--model-id".to_string(),
                model.id.to_string(),
                "--model-dir".to_string(),
                destination.to_string_lossy().to_string(),
            ],
        )?;
    }

    write_model_marker(config, model)?;
    Ok(model.id.to_string())
}

fn delete_model(config: &RuntimeConfig, requested: &str) -> Result<String, (u16, String)> {
    let model = find_model(requested).ok_or_else(|| {
        (
            404,
            format!(
                "Модель «{}» не поддерживается встроенным Parakeet runtime.",
                requested
            ),
        )
    })?;

    let dir = model_dir(config, model);
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|err| {
            (
                500,
                format!("Не удалось удалить модель «{}»: {}", model.id, err),
            )
        })?;
    }

    let marker = marker_path(config, model);
    if marker.is_file() {
        fs::remove_file(&marker).map_err(|err| {
            (
                500,
                format!(
                    "Не удалось удалить состояние модели «{}»: {}",
                    model.id, err
                ),
            )
        })?;
    }

    Ok(model.id.to_string())
}

fn write_model_marker(config: &RuntimeConfig, model: &ParakeetModel) -> Result<(), (u16, String)> {
    let marker = json!({
        "id": model.id,
        "directory": model.dir_name,
        "engine": ENGINE_NAME
    });
    fs::write(marker_path(config, model), marker.to_string()).map_err(|err| {
        (
            500,
            format!(
                "Не удалось сохранить состояние модели «{}»: {}",
                model.id, err
            ),
        )
    })
}

fn installed_models(config: &RuntimeConfig) -> Vec<String> {
    let mut models = PARAKEET_MODELS
        .iter()
        .filter(|model| model_dir(config, model).join("config.json").is_file())
        .map(|model| model.id.to_string())
        .collect::<Vec<_>>();
    models.sort();
    models
}

fn transcribe(request: &HttpRequest, config: &RuntimeConfig) -> Result<String, (u16, String)> {
    let multipart = parse_multipart(request)?;
    let requested_model = multipart
        .fields
        .get("model")
        .map(String::as_str)
        .unwrap_or("mlx-community/parakeet-tdt-0.6b-v3");
    let model = find_model(requested_model).ok_or_else(|| {
        (
            404,
            format!(
                "Модель «{}» не поддерживается встроенным Parakeet runtime.",
                requested_model
            ),
        )
    })?;

    let path = model_dir(config, model);
    if !path.join("config.json").is_file() {
        return Err((404, format!("Модель «{}» ещё не скачана.", model.id)));
    }

    ensure_engine(config)?;
    let tmp_dir = config.data_dir.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|err| {
        (
            500,
            format!("Не удалось подготовить временную папку: {}", err),
        )
    })?;
    let request_id = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let audio_path = tmp_dir.join(format!(
        "parakeet-input-{}-{}.wav",
        std::process::id(),
        request_id
    ));
    fs::write(&audio_path, &multipart.file).map_err(|err| {
        (
            500,
            format!("Не удалось сохранить аудио для Parakeet: {}", err),
        )
    })?;

    let language = multipart
        .fields
        .get("language")
        .map(String::as_str)
        .unwrap_or("auto");
    let result = run_engine_command(
        config,
        vec![
            "transcribe".to_string(),
            "--model-dir".to_string(),
            path.to_string_lossy().to_string(),
            "--audio".to_string(),
            audio_path.to_string_lossy().to_string(),
            "--language".to_string(),
            language.to_string(),
        ],
    );
    let _ = fs::remove_file(&audio_path);

    let stdout = result?;
    let parsed: serde_json::Value = serde_json::from_str(&stdout).map_err(|err| {
        (
            502,
            format!(
                "Parakeet engine вернул некорректный JSON: {} ({})",
                err, stdout
            ),
        )
    })?;
    Ok(parsed
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

fn ensure_engine(config: &RuntimeConfig) -> Result<(), (u16, String)> {
    let engine_dir = engine_dir(config);
    fs::create_dir_all(&engine_dir).map_err(|err| {
        (
            500,
            format!("Не удалось подготовить Parakeet engine runtime: {}", err),
        )
    })?;

    let script_path = engine_script_path(config);
    if fs::read_to_string(&script_path).ok().as_deref() != Some(NVIDIA_ENGINE_SCRIPT) {
        fs::write(&script_path, NVIDIA_ENGINE_SCRIPT).map_err(|err| {
            (
                500,
                format!("Не удалось сохранить Parakeet engine script: {}", err),
            )
        })?;
    }

    if venv_python(config).is_file() && !venv_is_usable(config) {
        fs::remove_dir_all(venv_dir(config)).map_err(|err| {
            (
                500,
                format!(
                    "Не удалось очистить поврежденный Parakeet Python venv: {}",
                    err
                ),
            )
        })?;
        let dependencies_marker = engine_dir.join("dependencies.ok");
        if dependencies_marker.is_file() {
            let _ = fs::remove_file(dependencies_marker);
        }
    }

    if !venv_python(config).is_file() {
        let python = find_system_python()
            .map(Ok)
            .unwrap_or_else(|| install_portable_python(config))?;
        let venv_path = venv_dir(config).to_string_lossy().to_string();
        let output = Command::new(&python)
            .args(["-m", "venv", &venv_path])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|err| {
                (
                    500,
                    format!("Не удалось создать Python venv для Parakeet: {}", err),
                )
            })?;
        if !output.status.success() {
            return Err((
                500,
                format!(
                    "Не удалось создать Python venv для Parakeet: {}",
                    String::from_utf8_lossy(&output.stderr)
                ),
            ));
        }
    }

    let dependencies_marker = engine_dir.join("dependencies.ok");
    if !dependencies_marker.is_file() {
        run_python(
            &venv_python(config),
            ["-m", "pip", "install", "-U", "pip", "setuptools", "wheel"],
        )?;
        run_python(
            &venv_python(config),
            [
                "-m",
                "pip",
                "install",
                "-U",
                "parakeet-mlx",
                "huggingface_hub",
            ],
        )?;
        fs::write(&dependencies_marker, "ok").map_err(|err| {
            (
                500,
                format!("Не удалось сохранить состояние Parakeet engine: {}", err),
            )
        })?;
    }

    Ok(())
}

fn find_system_python() -> Option<String> {
    env::var("TALKIS_NVIDIA_PYTHON")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .filter(|value| python_is_supported(value))
        .or_else(|| {
            [
                "python3.12",
                "python3.11",
                "python3.10",
                "python3.13",
                "python3",
                "python",
            ]
            .into_iter()
            .find(|candidate| python_is_supported(candidate))
            .map(str::to_string)
        })
}

fn install_portable_python(config: &RuntimeConfig) -> Result<String, (u16, String)> {
    let python_path = portable_python_path(config);
    if python_path.is_file() && python_is_supported_path(&python_path) {
        return Ok(python_path.to_string_lossy().to_string());
    }

    let asset = portable_python_asset().ok_or_else(|| {
        (
            500,
            format!(
                "Для этой платформы нет встроенного Python runtime: {}.",
                platform_target()
            ),
        )
    })?;

    let install_dir = portable_python_dir(config);
    let temp_dir = engine_dir(config).join(format!(
        "python-download-{}",
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let archive_path = engine_dir(config).join(format!(
        "python-{}-{}.tar.gz.download",
        PORTABLE_PYTHON_VERSION,
        platform_target()
    ));
    let _ = fs::remove_dir_all(&temp_dir);
    fs::create_dir_all(&temp_dir).map_err(|err| {
        (
            500,
            format!(
                "Не удалось подготовить временную папку Python runtime: {}",
                err
            ),
        )
    })?;

    let bytes = reqwest::blocking::get(asset.url)
        .and_then(|response| response.error_for_status())
        .map_err(|err| {
            (
                502,
                format!("Не удалось скачать встроенный Python runtime: {}", err),
            )
        })?
        .bytes()
        .map_err(|err| {
            (
                502,
                format!("Не удалось прочитать встроенный Python runtime: {}", err),
            )
        })?;
    verify_sha256(&bytes, asset.sha256)?;
    fs::write(&archive_path, &bytes).map_err(|err| {
        (
            500,
            format!("Не удалось сохранить встроенный Python runtime: {}", err),
        )
    })?;

    let archive_arg = archive_path.to_string_lossy().to_string();
    let temp_dir_arg = temp_dir.to_string_lossy().to_string();
    let output = Command::new("/usr/bin/tar")
        .args(["-xzf", &archive_arg, "-C", &temp_dir_arg])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| {
            (
                500,
                format!("Не удалось распаковать встроенный Python runtime: {}", err),
            )
        })?;
    if !output.status.success() {
        let _ = fs::remove_file(&archive_path);
        let _ = fs::remove_dir_all(&temp_dir);
        return Err((
            500,
            format!(
                "Не удалось распаковать встроенный Python runtime: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        ));
    }

    let extracted_python_dir = temp_dir.join("python");
    if !extracted_python_dir.is_dir() {
        let _ = fs::remove_file(&archive_path);
        let _ = fs::remove_dir_all(&temp_dir);
        return Err((
            500,
            "Архив встроенного Python runtime имеет неожиданную структуру.".to_string(),
        ));
    }

    let _ = fs::remove_dir_all(&install_dir);
    fs::rename(&extracted_python_dir, &install_dir).map_err(|err| {
        (
            500,
            format!("Не удалось установить встроенный Python runtime: {}", err),
        )
    })?;
    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_dir_all(&temp_dir);

    if python_path.is_file() && python_is_supported_path(&python_path) {
        Ok(python_path.to_string_lossy().to_string())
    } else {
        Err((
            500,
            "Встроенный Python runtime установлен, но не запускается.".to_string(),
        ))
    }
}

fn portable_python_asset() -> Option<&'static PortablePythonAsset> {
    let target = platform_target();
    PORTABLE_PYTHON_ASSETS
        .iter()
        .find(|asset| asset.target == target)
}

fn platform_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        _ => "unsupported",
    }
}

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), (u16, String)> {
    let actual = hex::encode(Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err((
            502,
            "Встроенный Python runtime не прошел проверку целостности.".to_string(),
        ))
    }
}

fn python_is_supported(name: &str) -> bool {
    let output = Command::new(name)
        .args([
            "-c",
            "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }

    let version = String::from_utf8_lossy(&output.stdout);
    let Some((major, minor)) = parse_python_version(&version) else {
        return false;
    };

    major == 3 && (10..=13).contains(&minor)
}

fn python_is_supported_path(path: &Path) -> bool {
    let output = Command::new(path)
        .args([
            "-c",
            "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }

    let version = String::from_utf8_lossy(&output.stdout);
    let Some((major, minor)) = parse_python_version(&version) else {
        return false;
    };

    major == 3 && (10..=13).contains(&minor)
}

fn parse_python_version(value: &str) -> Option<(u32, u32)> {
    let trimmed = value.trim();
    let (major, minor) = trimmed.split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

fn venv_is_usable(config: &RuntimeConfig) -> bool {
    let python = venv_python(config);
    if !python.is_file() {
        return false;
    }

    Command::new(python)
        .args([
            "-c",
            "import sys, pip; assert sys.version_info[:2] >= (3, 10) and sys.version_info[:2] <= (3, 13)",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn run_engine_command<I>(config: &RuntimeConfig, args: I) -> Result<String, (u16, String)>
where
    I: IntoIterator<Item = String>,
{
    let mut command = Command::new(venv_python(config));
    command.arg(engine_script_path(config));
    command.args(args);
    command.env("HF_HOME", config.data_dir.join("hf-cache"));
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let output = command.output().map_err(|err| {
        (
            500,
            format!("Не удалось запустить Parakeet engine: {}", err),
        )
    })?;
    if !output.status.success() {
        return Err((
            502,
            format!(
                "Parakeet engine завершился с ошибкой: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_python<'a, I>(python: &Path, args: I) -> Result<(), (u16, String)>
where
    I: IntoIterator<Item = &'a str>,
{
    let output = Command::new(python)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| {
            (
                500,
                format!("Не удалось запустить Python для Parakeet: {}", err),
            )
        })?;
    if output.status.success() {
        Ok(())
    } else {
        Err((
            502,
            format!(
                "Не удалось установить Parakeet engine dependencies: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        ))
    }
}

fn parse_multipart(request: &HttpRequest) -> Result<MultipartData, (u16, String)> {
    let content_type = request.headers.get("content-type").ok_or_else(|| {
        (
            400,
            "Для локальной транскрипции нужен multipart/form-data.".to_string(),
        )
    })?;
    let boundary = content_type
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix("boundary="))
        .map(|value| value.trim_matches('"').as_bytes().to_vec())
        .ok_or_else(|| (400, "В multipart/form-data нет boundary.".to_string()))?;
    let boundary_marker = [b"--".as_slice(), boundary.as_slice()].concat();

    let mut fields = HashMap::new();
    let mut file = Vec::new();

    for part in split_by_subsequence(&request.body, &boundary_marker) {
        if part.is_empty() || part == b"--" || part == b"--\r\n" {
            continue;
        }
        let part = trim_part(part);
        let Some(header_end) = find_subsequence(part, b"\r\n\r\n") else {
            continue;
        };
        let header_text = String::from_utf8_lossy(&part[..header_end]);
        let body = trim_trailing_crlf(&part[header_end + 4..]);
        let name = header_text
            .lines()
            .find(|line| line.to_lowercase().starts_with("content-disposition:"))
            .and_then(extract_multipart_name);

        match name.as_deref() {
            Some("file") => file = body.to_vec(),
            Some(name) => {
                fields.insert(name.to_string(), String::from_utf8_lossy(body).to_string());
            }
            None => {}
        }
    }

    if file.is_empty() {
        return Err((400, "В запросе нет аудиофайла.".to_string()));
    }

    Ok(MultipartData { fields, file })
}

fn extract_multipart_name(line: &str) -> Option<String> {
    line.split(';').map(str::trim).find_map(|part| {
        part.strip_prefix("name=")
            .map(|value| value.trim_matches('"').to_string())
    })
}

fn split_by_subsequence<'a>(bytes: &'a [u8], needle: &[u8]) -> Vec<&'a [u8]> {
    let mut parts = Vec::new();
    let mut start = 0;
    while let Some(relative) = find_subsequence(&bytes[start..], needle) {
        parts.push(&bytes[start..start + relative]);
        start += relative + needle.len();
    }
    parts.push(&bytes[start..]);
    parts
}

fn trim_part(bytes: &[u8]) -> &[u8] {
    let bytes = bytes.strip_prefix(b"\r\n").unwrap_or(bytes);
    trim_trailing_crlf(bytes)
}

fn trim_trailing_crlf(bytes: &[u8]) -> &[u8] {
    bytes
        .strip_suffix(b"\r\n")
        .or_else(|| bytes.strip_suffix(b"\n"))
        .unwrap_or(bytes)
}

fn find_subsequence(bytes: &[u8], needle: &[u8]) -> Option<usize> {
    bytes
        .windows(needle.len())
        .position(|window| window == needle)
}

fn write_json(stream: &mut TcpStream, status: u16, body: String) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    );
    stream.write_all(response.as_bytes())
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    index += 3;
                    continue;
                }
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).to_string()
}
