#!/usr/bin/env python3
"""Local dictation STT for the viewer composer.

Reads an audio file and prints {"text": "..."} as JSON. Kept dependency-light
and stateless so the Next route can shell out to it per request. Model choice,
device, and language come from argv so the route stays in control.
"""
import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: whisper_transcribe.py <audio> [model] [device] [language]"}))
        return 2
    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "small"
    device = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else "cpu"
    language = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"faster-whisper відсутній: {exc}"}))
        return 3

    compute_type = "int8_float16" if device == "cuda" else "int8"
    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments, _ = model.transcribe(audio_path, language=language, vad_filter=True)
        text = "".join(segment.text for segment in segments).strip()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"розпізнавання не вдалося: {exc}"}))
        return 4

    print(json.dumps({"text": text}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
