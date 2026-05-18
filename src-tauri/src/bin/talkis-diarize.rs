use hound::WavReader;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const SERVER_NAME: &str = "talkis-diarize";
const MODEL_ID: &str = "sherpa-diarization-pyannote-titanet-int8";
const SEGMENTATION_FILE: &str = "pyannote-segmentation-3.0.int8.onnx";
const EMBEDDING_FILE: &str = "nemo_en_titanet_small.onnx";
const SEGMENTATION_URL: &str = "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.int8.onnx";
const EMBEDDING_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx";
const MAX_REQUEST_BYTES: usize = 1024 * 1024 * 1024;
const PORTABLE_PYTHON_VERSION: &str = "3.12.13";
const PORTABLE_PYTHON_RELEASE: &str = "20260510";
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

const SHERPA_PYTHON_VALIDATE_SCRIPT: &str = r#"
import sys
import sherpa_onnx

segmentation_model, embedding_model = sys.argv[1], sys.argv[2]
segmentation = sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
    pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=segmentation_model),
    num_threads=1,
    debug=False,
    provider="cpu",
)
embedding = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
    model=embedding_model,
    num_threads=1,
    debug=False,
    provider="cpu",
)
clustering = sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.9)
config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
    segmentation=segmentation,
    embedding=embedding,
    clustering=clustering,
)
if not config.validate():
    raise SystemExit(2)
sherpa_onnx.OfflineSpeakerDiarization(config)
"#;

const SHERPA_PYTHON_DIARIZATION_SCRIPT: &str = r#"
import array
import sys
import wave
import sherpa_onnx

segmentation_model, embedding_model, wav_path = sys.argv[1], sys.argv[2], sys.argv[3]
with wave.open(wav_path, "rb") as wav:
    if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000:
        raise RuntimeError("Diarization expects mono 16-bit 16 kHz WAV")
    pcm = array.array("h")
    pcm.frombytes(wav.readframes(wav.getnframes()))

if sys.byteorder == "big":
    pcm.byteswap()

samples = array.array("f", (max(-1.0, min(1.0, sample / 32768.0)) for sample in pcm))
segmentation = sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
    pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=segmentation_model),
    num_threads=1,
    debug=False,
    provider="cpu",
)
embedding = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
    model=embedding_model,
    num_threads=1,
    debug=False,
    provider="cpu",
)
clustering = sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.9)
config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
    segmentation=segmentation,
    embedding=embedding,
    clustering=clustering,
)
diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
result = diarizer.process(samples)
for segment in result.sort_by_start_time():
    speaker = str(segment.speaker)
    if speaker.isdigit():
        speaker = f"SPEAKER_{int(speaker):02d}"
    elif not speaker.upper().startswith("SPEAKER_"):
        speaker = f"SPEAKER_{speaker}"
    print(f"{float(segment.start):.3f} -- {float(segment.end):.3f} {speaker.upper()}", flush=True)
"#;

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

struct MultipartData {
    fields: HashMap<String, String>,
    file: Vec<u8>,
}

struct PortablePythonAsset {
    target: &'static str,
    url: &'static str,
    sha256: &'static str,
}

#[derive(Debug)]
struct SpeakerTurn {
    start: f64,
    end: f64,
    speaker_id: String,
}

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
    let mut port = 8003u16;
    let mut data_dir = env::temp_dir().join("talkis-diarize");
    let mut models_dir = data_dir.join("models");
    let args = env::args().skip(1).collect::<Vec<_>>();
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--host" if index + 1 < args.len() => {
                host = args[index + 1].clone();
                index += 2;
            }
            "--port" if index + 1 < args.len() => {
                port = args[index + 1].parse().unwrap_or(port);
                index += 2;
            }
            "--data-dir" if index + 1 < args.len() => {
                data_dir = PathBuf::from(&args[index + 1]);
                index += 2;
            }
            "--models-dir" if index + 1 < args.len() => {
                models_dir = PathBuf::from(&args[index + 1]);
                index += 2;
            }
            _ => {
                index += 1;
            }
        }
    }

    RuntimeConfig {
        host,
        port,
        data_dir,
        models_dir,
    }
}

fn handle_connection(mut stream: TcpStream, config: &RuntimeConfig) {
    let response = match read_request(&mut stream) {
        Ok(request) => route_request(&request, config),
        Err(err) => (
            400,
            json!({ "error": { "message": err, "type": "local_diarization_error" } }).to_string(),
        ),
    };
    let _ = write_json(&mut stream, response.0, response.1);
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut buffer = Vec::new();
    let mut temp = [0u8; 8192];
    let mut header_end = None;
    let mut content_length = 0usize;

    loop {
        let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..read]);
        if buffer.len() > MAX_REQUEST_BYTES {
            return Err("request too large".to_string());
        }
        if header_end.is_none() {
            if let Some(pos) = find_subsequence(&buffer, b"\r\n\r\n") {
                header_end = Some(pos + 4);
                let headers = String::from_utf8_lossy(&buffer[..pos]);
                for line in headers.lines().skip(1) {
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            content_length = value.trim().parse().unwrap_or(0);
                        }
                    }
                }
            }
        }
        if let Some(end) = header_end {
            if buffer.len() >= end + content_length {
                break;
            }
        }
    }

    let header_end = header_end.ok_or_else(|| "invalid HTTP request".to_string())?;
    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("").to_string();
    let path = request_parts.next().unwrap_or("").to_string();
    let headers = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.trim().to_lowercase(), value.trim().to_string()))
        })
        .collect::<HashMap<_, _>>();
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
                "engine": "sherpa-onnx"
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
        ("POST", "/v1/audio/diarization") => match diarize(request, config) {
            Ok(turns) => (
                200,
                json!({
                    "segments": turns.into_iter().map(|turn| json!({
                        "start": turn.start,
                        "end": turn.end,
                        "speakerId": turn.speaker_id
                    })).collect::<Vec<_>>()
                })
                .to_string(),
            ),
            Err((status, message)) => (
                status,
                json!({ "error": { "message": message, "type": "local_diarization_error" } })
                    .to_string(),
            ),
        },
        _ if request.method == "POST" && path.starts_with("/v1/models/") => {
            let model = percent_decode(path.trim_start_matches("/v1/models/"));
            match install_model(config, &model) {
                Ok(id) => (
                    200,
                    json!({ "id": id, "object": "model", "status": "downloaded" }).to_string(),
                ),
                Err((status, message)) => (
                    status,
                    json!({ "error": { "message": message, "type": "local_diarization_error" } })
                        .to_string(),
                ),
            }
        }
        _ if request.method == "DELETE" && path.starts_with("/v1/models/") => {
            let model = percent_decode(path.trim_start_matches("/v1/models/"));
            match delete_model(config, &model) {
                Ok(id) => (
                    200,
                    json!({ "id": id, "object": "model", "status": "deleted" }).to_string(),
                ),
                Err((status, message)) => (
                    status,
                    json!({ "error": { "message": message, "type": "local_diarization_error" } })
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

fn model_dir(config: &RuntimeConfig) -> PathBuf {
    config.models_dir.join(MODEL_ID)
}

fn segmentation_path(config: &RuntimeConfig) -> PathBuf {
    model_dir(config).join(SEGMENTATION_FILE)
}

fn embedding_path(config: &RuntimeConfig) -> PathBuf {
    model_dir(config).join(EMBEDDING_FILE)
}

fn marker_path(config: &RuntimeConfig) -> PathBuf {
    model_dir(config).join("model.json")
}

fn installed_models(config: &RuntimeConfig) -> Vec<String> {
    if segmentation_path(config).is_file()
        && embedding_path(config).is_file()
        && marker_path(config).is_file()
    {
        vec![MODEL_ID.to_string()]
    } else {
        Vec::new()
    }
}

fn install_model(config: &RuntimeConfig, requested: &str) -> Result<String, (u16, String)> {
    if !requested.eq_ignore_ascii_case(MODEL_ID) {
        return Err((
            404,
            format!(
                "Модель «{}» не поддерживается встроенным diarization runtime.",
                requested
            ),
        ));
    }

    let dir = model_dir(config);
    fs::create_dir_all(&dir).map_err(|err| {
        (
            500,
            format!("Не удалось подготовить директорию модели: {}", err),
        )
    })?;
    download_file_if_missing(
        SEGMENTATION_URL,
        &segmentation_path(config),
        SEGMENTATION_FILE,
    )?;
    download_file_if_missing(EMBEDDING_URL, &embedding_path(config), EMBEDDING_FILE)?;
    ensure_sherpa_runtime(config)?;
    fs::write(
        marker_path(config),
        json!({
            "id": MODEL_ID,
            "engine": "sherpa-onnx",
            "segmentation": SEGMENTATION_FILE,
            "embedding": EMBEDDING_FILE
        })
        .to_string(),
    )
    .map_err(|err| {
        (
            500,
            format!("Не удалось сохранить состояние модели: {}", err),
        )
    })?;

    Ok(MODEL_ID.to_string())
}

fn download_file_if_missing(url: &str, path: &Path, label: &str) -> Result<(), (u16, String)> {
    if path.is_file() {
        return Ok(());
    }

    let temp_path = path.with_extension("download");
    let mut response = reqwest::blocking::get(url)
        .and_then(|response| response.error_for_status())
        .map_err(|err| (502, format!("Не удалось скачать {}: {}", label, err)))?;
    let mut file = fs::File::create(&temp_path)
        .map_err(|err| (500, format!("Не удалось сохранить {}: {}", label, err)))?;
    std::io::copy(&mut response, &mut file).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        (502, format!("Не удалось записать {}: {}", label, err))
    })?;
    file.flush().map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        (
            500,
            format!("Не удалось завершить запись {}: {}", label, err),
        )
    })?;
    fs::rename(&temp_path, path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        (500, format!("Не удалось установить {}: {}", label, err))
    })
}

fn delete_model(config: &RuntimeConfig, requested: &str) -> Result<String, (u16, String)> {
    if !requested.eq_ignore_ascii_case(MODEL_ID) {
        return Err((
            404,
            format!(
                "Модель «{}» не поддерживается встроенным diarization runtime.",
                requested
            ),
        ));
    }

    let dir = model_dir(config);
    if dir.is_dir() {
        fs::remove_dir_all(&dir)
            .map_err(|err| (500, format!("Не удалось удалить модель: {}", err)))?;
    }

    Ok(MODEL_ID.to_string())
}

fn diarize(
    request: &HttpRequest,
    config: &RuntimeConfig,
) -> Result<Vec<SpeakerTurn>, (u16, String)> {
    let multipart = parse_multipart(request)?;
    let requested_model = multipart
        .fields
        .get("model")
        .map(String::as_str)
        .unwrap_or(MODEL_ID);
    if !requested_model.eq_ignore_ascii_case(MODEL_ID) {
        return Err((
            404,
            format!(
                "Модель «{}» не поддерживается встроенным diarization runtime.",
                requested_model
            ),
        ));
    }
    if !segmentation_path(config).is_file() || !embedding_path(config).is_file() {
        return Err((404, format!("Модель «{}» ещё не скачана.", MODEL_ID)));
    }
    validate_wav_mono_16k(&multipart.file)?;

    let input_path = unique_temp_path("diarization-input", "wav");
    fs::write(&input_path, &multipart.file).map_err(|err| {
        (
            500,
            format!("Не удалось сохранить WAV для diarization: {}", err),
        )
    })?;
    let result = run_sherpa_diarization(config, &input_path);
    let _ = fs::remove_file(&input_path);
    result
}

fn run_sherpa_diarization(
    config: &RuntimeConfig,
    input_path: &Path,
) -> Result<Vec<SpeakerTurn>, (u16, String)> {
    if let Some(binary) = resolve_sherpa_binary() {
        return run_sherpa_binary_diarization(config, input_path, &binary);
    }

    ensure_sherpa_runtime(config)?;
    run_sherpa_python_diarization(config, input_path)
}

fn run_sherpa_binary_diarization(
    config: &RuntimeConfig,
    input_path: &Path,
    binary: &Path,
) -> Result<Vec<SpeakerTurn>, (u16, String)> {
    let output = Command::new(&binary)
        .arg(format!(
            "--segmentation.pyannote-model={}",
            segmentation_path(config).to_string_lossy()
        ))
        .arg(format!(
            "--embedding.model={}",
            embedding_path(config).to_string_lossy()
        ))
        .arg("--clustering.cluster-threshold=0.9")
        .arg(input_path)
        .output()
        .map_err(|err| {
            (
                500,
                format!(
                    "Не удалось запустить sherpa-onnx diarization binary «{}»: {}",
                    binary.display(),
                    err
                ),
            )
        })?;

    if !output.status.success() {
        return Err((
            500,
            format!(
                "sherpa-onnx diarization завершился с ошибкой: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut turns = stdout
        .lines()
        .filter_map(parse_sherpa_turn_line)
        .collect::<Vec<_>>();
    turns.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if turns.is_empty() {
        return Err((
            500,
            "sherpa-onnx diarization не вернул сегменты говорящих.".to_string(),
        ));
    }

    Ok(turns)
}

fn resolve_sherpa_binary() -> Option<PathBuf> {
    if let Ok(value) = env::var("TALKIS_SHERPA_DIARIZATION_BIN") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if command_runs(&path, &["--help"]) {
                return Some(path);
            }
        }
    }

    let system_binary = PathBuf::from("sherpa-onnx-offline-speaker-diarization");
    if command_runs(&system_binary, &["--help"]) {
        return Some(system_binary);
    }

    None
}

fn ensure_sherpa_runtime(config: &RuntimeConfig) -> Result<(), (u16, String)> {
    let venv_dir = config.data_dir.join("sherpa-onnx-venv");
    prepare_sherpa_venv(&venv_dir)?;
    if validate_sherpa_python_runtime(config, &venv_python_path(&venv_dir)) {
        return Ok(());
    }

    let _ = fs::remove_dir_all(&venv_dir);
    prepare_sherpa_venv(&venv_dir)?;
    if validate_sherpa_python_runtime(config, &venv_python_path(&venv_dir)) {
        return Ok(());
    }

    Err((
        500,
        "sherpa-onnx установлен, но Python runtime для разметки говорящих не запускается."
            .to_string(),
    ))
}

fn command_runs(path: &Path, args: &[&str]) -> bool {
    Command::new(path)
        .args(args)
        .output()
        .map(|output| {
            output.status.success() || !output.stderr.is_empty() || !output.stdout.is_empty()
        })
        .unwrap_or(false)
}

fn run_sherpa_python_diarization(
    config: &RuntimeConfig,
    input_path: &Path,
) -> Result<Vec<SpeakerTurn>, (u16, String)> {
    let venv_dir = config.data_dir.join("sherpa-onnx-venv");
    let python = venv_python_path(&venv_dir);
    let script_path = unique_temp_path("sherpa-diarization", "py");
    fs::write(&script_path, SHERPA_PYTHON_DIARIZATION_SCRIPT).map_err(|err| {
        (
            500,
            format!("Не удалось подготовить Python diarization script: {}", err),
        )
    })?;

    let output = Command::new(&python)
        .arg(&script_path)
        .arg(segmentation_path(config))
        .arg(embedding_path(config))
        .arg(input_path)
        .output()
        .map_err(|err| {
            (
                500,
                format!(
                    "Не удалось запустить Python diarization runtime «{}»: {}",
                    python.display(),
                    err
                ),
            )
        });
    let _ = fs::remove_file(&script_path);
    let output = output?;

    if !output.status.success() {
        return Err((
            500,
            format!(
                "sherpa-onnx diarization завершился с ошибкой: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut turns = stdout
        .lines()
        .filter_map(parse_sherpa_turn_line)
        .collect::<Vec<_>>();
    turns.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if turns.is_empty() {
        return Err((
            500,
            "sherpa-onnx diarization не вернул сегменты говорящих.".to_string(),
        ));
    }

    Ok(turns)
}

fn validate_sherpa_python_runtime(config: &RuntimeConfig, python: &Path) -> bool {
    Command::new(python)
        .arg("-c")
        .arg(SHERPA_PYTHON_VALIDATE_SCRIPT)
        .arg(segmentation_path(config))
        .arg(embedding_path(config))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn prepare_sherpa_venv(venv_dir: &Path) -> Result<(), (u16, String)> {
    let venv_python = venv_python_path(venv_dir);

    if venv_dir.is_dir() && !venv_is_usable(&venv_python) {
        fs::remove_dir_all(venv_dir).map_err(|err| {
            (
                500,
                format!(
                    "Не удалось очистить поврежденный sherpa-onnx Python venv: {}",
                    err
                ),
            )
        })?;
    }

    if !venv_python.is_file() {
        let python = find_system_python()
            .map(Ok)
            .unwrap_or_else(|| install_portable_python(venv_dir))?;
        let output = Command::new(&python)
            .args(["-m", "venv"])
            .arg(venv_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|err| {
                (
                    500,
                    format!("Не удалось создать Python venv для sherpa-onnx: {}", err),
                )
            })?;
        if !output.status.success() {
            return Err((
                500,
                format!(
                    "Не удалось создать Python venv для sherpa-onnx: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
    }

    let output = Command::new(&venv_python)
        .args(["-m", "pip", "install", "--upgrade", "pip", "sherpa-onnx"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| {
            (
                500,
                format!("Не удалось установить sherpa-onnx dependencies: {}", err),
            )
        })?;
    if !output.status.success() {
        return Err((
            500,
            format!(
                "Не удалось установить sherpa-onnx dependencies: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }

    Ok(())
}

fn venv_bin_dir(venv_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        venv_dir.join("Scripts")
    } else {
        venv_dir.join("bin")
    }
}

fn venv_python_path(venv_dir: &Path) -> PathBuf {
    venv_bin_dir(venv_dir).join(if cfg!(windows) {
        "python.exe"
    } else {
        "python"
    })
}

fn venv_is_usable(python: &Path) -> bool {
    python_is_supported_path(python)
        && Command::new(python)
            .args(["-m", "pip", "--version"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
}

fn find_system_python() -> Option<String> {
    env::var("TALKIS_SHERPA_PYTHON")
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

fn install_portable_python(venv_dir: &Path) -> Result<String, (u16, String)> {
    let engine_dir = venv_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| env::temp_dir().join("talkis-diarize-python"));
    let python_path = portable_python_path(&engine_dir);
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
    let install_dir = portable_python_dir(&engine_dir);
    let temp_dir = engine_dir.join(format!(
        "python-download-{}",
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let archive_path = engine_dir.join(format!(
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

    let output = Command::new("/usr/bin/tar")
        .args([
            "-xzf",
            &archive_path.to_string_lossy(),
            "-C",
            &temp_dir.to_string_lossy(),
        ])
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

fn portable_python_dir(engine_dir: &Path) -> PathBuf {
    engine_dir.join(format!(
        "python-{}-{}-{}",
        PORTABLE_PYTHON_VERSION,
        PORTABLE_PYTHON_RELEASE,
        platform_target()
    ))
}

fn portable_python_path(engine_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        portable_python_dir(engine_dir).join("python.exe")
    } else {
        portable_python_dir(engine_dir).join("bin").join("python3")
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

fn parse_sherpa_turn_line(line: &str) -> Option<SpeakerTurn> {
    let trimmed = line.trim();
    let parts = trimmed.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 4 || parts[1] != "--" {
        return None;
    }
    let start = parts[0].parse::<f64>().ok()?;
    let end = parts[2].parse::<f64>().ok()?;
    let speaker_id = parts[3]
        .trim()
        .replace("speaker_", "SPEAKER_")
        .to_uppercase();
    if end <= start || !speaker_id.starts_with("SPEAKER_") {
        return None;
    }

    Some(SpeakerTurn {
        start,
        end,
        speaker_id,
    })
}

fn validate_wav_mono_16k(bytes: &[u8]) -> Result<(), (u16, String)> {
    let reader = WavReader::new(Cursor::new(bytes))
        .map_err(|err| (400, format!("Diarization ожидает WAV audio: {}", err)))?;
    let spec = reader.spec();
    if spec.sample_rate != 16000 {
        return Err((400, "WAV должен быть 16 kHz.".to_string()));
    }
    if spec.channels != 1 {
        return Err((400, "WAV должен быть mono.".to_string()));
    }
    if spec.bits_per_sample != 16 {
        return Err((400, "WAV должен быть PCM 16-bit.".to_string()));
    }
    Ok(())
}

fn parse_multipart(request: &HttpRequest) -> Result<MultipartData, (u16, String)> {
    let content_type = request.headers.get("content-type").ok_or_else(|| {
        (
            400,
            "Для локального diarization нужен multipart/form-data.".to_string(),
        )
    })?;
    let boundary = content_type
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix("boundary="))
        .map(|value| value.trim_matches('"').to_string())
        .ok_or_else(|| (400, "Не найден multipart boundary.".to_string()))?;
    let delimiter = format!("--{}", boundary);
    let mut fields = HashMap::new();
    let mut file = Vec::new();

    for raw_part in split_by_subsequence(&request.body, delimiter.as_bytes()) {
        let part = trim_part(raw_part);
        if part.is_empty() || part == b"--" {
            continue;
        }
        let Some(header_end) = find_subsequence(part, b"\r\n\r\n") else {
            continue;
        };
        let header = String::from_utf8_lossy(&part[..header_end]);
        let body = trim_trailing_crlf(&part[header_end + 4..]);
        let name = header
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

fn unique_temp_path(prefix: &str, extension: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let pid = std::process::id();
    env::temp_dir().join(format!(
        "talkis-{}-{}-{}.{}",
        prefix,
        pid,
        now,
        extension.trim_start_matches('.')
    ))
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
