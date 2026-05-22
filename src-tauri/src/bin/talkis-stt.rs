use hound::WavReader;
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use whisper_rs::{
    convert_integer_to_float_audio, convert_stereo_to_mono_audio, FullParams, SamplingStrategy,
    WhisperContext, WhisperContextParameters,
};

const SERVER_NAME: &str = "talkis-stt";
const MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;

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

struct WhisperModel {
    id: &'static str,
    aliases: &'static [&'static str],
    file_name: &'static str,
    url: &'static str,
}

struct MultipartData {
    fields: HashMap<String, String>,
    file: Vec<u8>,
}

const WHISPER_MODELS: &[WhisperModel] = &[
    WhisperModel {
        id: "whisper-tiny",
        aliases: &["tiny", "Systran/faster-whisper-tiny"],
        file_name: "ggml-tiny.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    },
    WhisperModel {
        id: "whisper-base",
        aliases: &["base", "Systran/faster-whisper-base"],
        file_name: "ggml-base.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    },
    WhisperModel {
        id: "whisper-small",
        aliases: &["small", "Systran/faster-whisper-small"],
        file_name: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    },
    WhisperModel {
        id: "whisper-medium",
        aliases: &["medium", "Systran/faster-whisper-medium"],
        file_name: "ggml-medium.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    },
    WhisperModel {
        id: "whisper-large-v2",
        aliases: &["large-v2", "Systran/faster-whisper-large-v2"],
        file_name: "ggml-large-v2.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v2.bin",
    },
    WhisperModel {
        id: "whisper-large-v3",
        aliases: &["large-v3", "Systran/faster-whisper-large-v3"],
        file_name: "ggml-large-v3.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
    },
    WhisperModel {
        id: "whisper-large-v3-turbo",
        aliases: &[
            "large-v3-turbo",
            "Systran/faster-whisper-large-v3-turbo",
            "mlx-community/whisper-large-v3-turbo-4bit",
        ],
        file_name: "ggml-large-v3-turbo.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
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
    let mut port = 8000;
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
                "engine": "whisper.cpp"
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
            Ok(body) => (200, body),
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

fn find_model(value: &str) -> Option<&'static WhisperModel> {
    WHISPER_MODELS.iter().find(|model| {
        model.id.eq_ignore_ascii_case(value)
            || model.file_name.eq_ignore_ascii_case(value)
            || model
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(value))
    })
}

fn model_path(config: &RuntimeConfig, model: &WhisperModel) -> PathBuf {
    config.models_dir.join(model.file_name)
}

fn marker_path(config: &RuntimeConfig, model: &WhisperModel) -> PathBuf {
    config.models_dir.join(format!("{}.json", model.id))
}

fn install_model(config: &RuntimeConfig, requested: &str) -> Result<String, (u16, String)> {
    let model = find_model(requested).ok_or_else(|| {
        (
            404,
            format!(
                "Модель «{}» не поддерживается встроенным Whisper runtime.",
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

    let path = model_path(config, model);
    if !path.is_file() {
        let temp_path = path.with_extension("download");
        let mut response = reqwest::blocking::get(model.url)
            .and_then(|response| response.error_for_status())
            .map_err(|err| {
                (
                    502,
                    format!("Не удалось скачать модель «{}»: {}", model.id, err),
                )
            })?;

        let mut file = fs::File::create(&temp_path).map_err(|err| {
            (
                500,
                format!("Не удалось сохранить модель «{}»: {}", model.id, err),
            )
        })?;
        std::io::copy(&mut response, &mut file).map_err(|err| {
            let _ = fs::remove_file(&temp_path);
            (
                502,
                format!("Не удалось записать модель «{}»: {}", model.id, err),
            )
        })?;
        file.flush().map_err(|err| {
            let _ = fs::remove_file(&temp_path);
            (
                500,
                format!("Не удалось завершить запись модели «{}»: {}", model.id, err),
            )
        })?;
        fs::rename(&temp_path, &path).map_err(|err| {
            let _ = fs::remove_file(&temp_path);
            (
                500,
                format!("Не удалось установить модель «{}»: {}", model.id, err),
            )
        })?;
    }

    write_model_marker(config, model)?;
    Ok(model.id.to_string())
}

fn delete_model(config: &RuntimeConfig, requested: &str) -> Result<String, (u16, String)> {
    let model = find_model(requested).ok_or_else(|| {
        (
            404,
            format!(
                "Модель «{}» не поддерживается встроенным Whisper runtime.",
                requested
            ),
        )
    })?;

    let path = model_path(config, model);
    if path.is_file() {
        fs::remove_file(&path).map_err(|err| {
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

    let temp_path = path.with_extension("download");
    if temp_path.is_file() {
        let _ = fs::remove_file(temp_path);
    }

    Ok(model.id.to_string())
}

fn write_model_marker(config: &RuntimeConfig, model: &WhisperModel) -> Result<(), (u16, String)> {
    let marker = json!({
        "id": model.id,
        "file": model.file_name,
        "engine": "whisper.cpp"
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
    let mut models = WHISPER_MODELS
        .iter()
        .filter(|model| model_path(config, model).is_file())
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
        .unwrap_or("whisper-tiny");
    let model = find_model(requested_model).ok_or_else(|| {
        (
            404,
            format!(
                "Модель «{}» не поддерживается встроенным Whisper runtime.",
                requested_model
            ),
        )
    })?;

    let path = model_path(config, model);
    if !path.is_file() {
        return Err((404, format!("Модель «{}» ещё не скачана.", model.id)));
    }

    let audio = read_wav_mono_16k(&multipart.file)?;
    let context = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
        .map_err(|err| {
            (
                500,
                format!("Не удалось загрузить модель «{}»: {}", model.id, err),
            )
        })?;
    let mut state = context.create_state().map_err(|err| {
        (
            500,
            format!("Не удалось создать состояние Whisper: {}", err),
        )
    })?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 0 });
    params.set_n_threads(
        std::thread::available_parallelism()
            .map(|value| value.get().min(8) as i32)
            .unwrap_or(4),
    );
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_suppress_nst(true);
    params.set_temperature(0.0);
    params.set_temperature_inc(0.0);
    params.set_entropy_thold(2.2);

    if let Some(language) = multipart.fields.get("language") {
        let language = language.trim();
        if !language.is_empty() && language != "auto" {
            params.set_language(Some(language));
        }
    }

    state
        .full(params, &audio)
        .map_err(|err| (500, format!("Whisper не смог распознать аудио: {}", err)))?;

    let segments = state
        .as_iter()
        .map(|segment| {
            let text = segment.to_string();
            json!({
                "start": segment.start_timestamp() as f64 / 100.0,
                "end": segment.end_timestamp() as f64 / 100.0,
                "text": text.trim()
            })
        })
        .collect::<Vec<_>>();
    let text = state
        .as_iter()
        .map(|segment| segment.to_string())
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string();
    let response_format = multipart
        .fields
        .get("response_format")
        .map(|value| value.trim())
        .unwrap_or("json");

    if response_format == "verbose_json" {
        Ok(json!({ "text": text, "segments": segments }).to_string())
    } else {
        Ok(json!({ "text": text }).to_string())
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

fn read_wav_mono_16k(bytes: &[u8]) -> Result<Vec<f32>, (u16, String)> {
    let reader = WavReader::new(Cursor::new(bytes))
        .map_err(|err| (400, format!("Локальный STT ожидает WAV audio: {}", err)))?;
    let spec = reader.spec();
    if spec.sample_rate != 16000 {
        return Err((400, "WAV должен быть 16 kHz.".to_string()));
    }
    if spec.channels != 1 && spec.channels != 2 {
        return Err((400, "WAV должен быть mono или stereo.".to_string()));
    }
    if spec.bits_per_sample != 16 {
        return Err((400, "WAV должен быть PCM 16-bit.".to_string()));
    }

    let channels = spec.channels;
    let samples = reader
        .into_samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| (400, format!("Не удалось прочитать WAV samples: {}", err)))?;
    let mut audio = vec![0.0f32; samples.len()];
    convert_integer_to_float_audio(&samples, &mut audio).map_err(|err| {
        (
            400,
            format!("Не удалось конвертировать WAV samples: {}", err),
        )
    })?;

    if channels == 1 {
        Ok(audio)
    } else {
        let mut mono = vec![0.0f32; audio.len() / 2];
        convert_stereo_to_mono_audio(&audio, &mut mono)
            .map_err(|err| (400, format!("Не удалось сделать mono WAV: {}", err)))?;
        Ok(mono)
    }
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
