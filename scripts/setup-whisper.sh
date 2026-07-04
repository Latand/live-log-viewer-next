#!/usr/bin/env bash
# Creates the local faster-whisper venv the viewer's dictation uses and
# pre-downloads the model so the first dictation is not the slow one.
set -euo pipefail

VENV="${LLV_WHISPER_VENV:-$HOME/.cache/live-log-viewer/whisper-venv}"
MODEL="${LLV_WHISPER_MODEL:-small}"
DEVICE="${LLV_WHISPER_DEVICE:-cpu}"

python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet faster-whisper

COMPUTE=int8
[ "$DEVICE" = "cuda" ] && COMPUTE=int8_float16
"$VENV/bin/python" - "$MODEL" "$DEVICE" "$COMPUTE" <<'PY'
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device=sys.argv[2], compute_type=sys.argv[3])
print("model ready:", sys.argv[1], sys.argv[2])
PY

echo "whisper venv ready at $VENV"
