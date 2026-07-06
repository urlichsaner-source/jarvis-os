#!/usr/bin/env python3
"""Einmal-Transkription einer Audiodatei (webm/mp4/wav) via faster-whisper.
Aufruf: .venv-python transcribe.py <datei> — gibt JSON {"text","lang"} auf stdout aus.
Sprache auto-erkannt (DE/RU beides im Einsatz)."""
import sys, json
from faster_whisper import WhisperModel

model = WhisperModel("small", device="cpu", compute_type="int8")
segments, info = model.transcribe(sys.argv[1], vad_filter=True)
text = " ".join(s.text for s in segments).strip()
print(json.dumps({"text": text, "lang": info.language}, ensure_ascii=False))
