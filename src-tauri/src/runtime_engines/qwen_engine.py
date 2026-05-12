#!/usr/bin/env python3
import argparse
import json
import os
import sys
import warnings


LANGUAGE_NAMES = {
    "ar": "Arabic",
    "cs": "Czech",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "fa": "Persian",
    "fi": "Finnish",
    "fil": "Filipino",
    "fr": "French",
    "hi": "Hindi",
    "hu": "Hungarian",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "mk": "Macedonian",
    "ms": "Malay",
    "nl": "Dutch",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sv": "Swedish",
    "th": "Thai",
    "tr": "Turkish",
    "vi": "Vietnamese",
    "yue": "Cantonese",
    "zh": "Chinese",
}


def print_json(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def normalize_language(value):
    if not value:
        return None
    value = value.strip()
    if not value or value.lower() == "auto":
        return None
    return LANGUAGE_NAMES.get(value.lower(), value)


def choose_runtime():
    import torch

    forced = os.environ.get("TALKIS_QWEN_DEVICE_MAP", "").strip()
    if forced:
        dtype_name = os.environ.get("TALKIS_QWEN_DTYPE", "").strip().lower()
        dtype = {
            "bfloat16": torch.bfloat16,
            "float16": torch.float16,
            "float32": torch.float32,
        }.get(dtype_name, torch.float32)
        return forced, dtype

    if torch.cuda.is_available():
        return "cuda:0", torch.bfloat16

    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps", torch.float16

    return "cpu", torch.float32


def build_model(model_dir):
    import torch
    from qwen_asr import Qwen3ASRModel

    device_map, dtype = choose_runtime()
    attempts = [
        {"device_map": device_map, "dtype": dtype},
    ]

    if device_map != "cpu":
        attempts.append({"device_map": "cpu", "dtype": torch.float32})

    last_error = None
    for kwargs in attempts:
        try:
            return Qwen3ASRModel.from_pretrained(
                model_dir,
                max_inference_batch_size=1,
                max_new_tokens=512,
                **kwargs,
            )
        except Exception as exc:
            last_error = exc
            warnings.warn(f"Qwen load failed with {kwargs}: {exc}")

    raise last_error


def download_model(args):
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=args.model_id,
        local_dir=args.model_dir,
        local_dir_use_symlinks=False,
        resume_download=True,
    )
    print_json({"ok": True, "model_dir": args.model_dir})


def transcribe(args):
    model = build_model(args.model_dir)
    result = model.transcribe(
        audio=args.audio,
        language=normalize_language(args.language),
    )
    first = result[0] if isinstance(result, list) and result else result
    text = getattr(first, "text", "") if first is not None else ""
    language = getattr(first, "language", None) if first is not None else None
    print_json({"text": (text or "").strip(), "language": language})


def main():
    parser = argparse.ArgumentParser(prog="qwen_engine.py")
    subparsers = parser.add_subparsers(dest="command", required=True)

    download_parser = subparsers.add_parser("download")
    download_parser.add_argument("--model-id", required=True)
    download_parser.add_argument("--model-dir", required=True)

    transcribe_parser = subparsers.add_parser("transcribe")
    transcribe_parser.add_argument("--model-dir", required=True)
    transcribe_parser.add_argument("--audio", required=True)
    transcribe_parser.add_argument("--language", default="auto")

    args = parser.parse_args()
    try:
        if args.command == "download":
            download_model(args)
        elif args.command == "transcribe":
            transcribe(args)
        else:
            parser.error(f"Unknown command: {args.command}")
    except Exception as exc:
        print(f"Qwen engine error: {exc}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
