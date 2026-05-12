#!/usr/bin/env python3
import argparse
import json
import sys


def print_json(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


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
    from parakeet_mlx import from_pretrained

    model = from_pretrained(args.model_dir)
    result = model.transcribe(args.audio)
    text = getattr(result, "text", "") if result is not None else ""
    print_json({"text": (text or "").strip()})


def main():
    parser = argparse.ArgumentParser(prog="nvidia_engine.py")
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
        print(f"Parakeet engine error: {exc}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
