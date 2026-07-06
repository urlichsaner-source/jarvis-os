#!/bin/bash
# Jarvis OS — Setup: Python-Venv, Voice-Modelle, Beispiel-Config.
# Voraussetzungen: Node >= 18, Python >= 3.10, Ollama (brew install ollama)
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "══ Jarvis OS Setup ══"

# 1) Node pruefen
node -e 'if(parseInt(process.versions.node)<18){console.error("Node >= 18 noetig");process.exit(1)}' \
  && echo "✓ Node $(node -v)"

# 2) Python-Venv fuer Voice (faster-whisper + piper)
if [ ! -d .venv ]; then
  if command -v uv >/dev/null; then uv venv .venv && uv pip install --python .venv/bin/python -r setup/requirements.txt
  else python3 -m venv .venv && .venv/bin/pip install -r setup/requirements.txt; fi
fi
echo "✓ Python-Venv bereit (.venv)"

# 3) Piper-Standardstimmen laden (DE + RU, ~180 MB)
MODELS="${VOICE_MODELS_DIR:-$HOME/voice-models}"
mkdir -p "$MODELS"
for f in "de/de_DE/thorsten/high/de_DE-thorsten-high.onnx" "de/de_DE/thorsten/high/de_DE-thorsten-high.onnx.json" \
         "ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx" "ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx.json"; do
  base="$(basename "$f")"
  [ -f "$MODELS/$base" ] || curl -sL -o "$MODELS/$base" "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/$f"
done
echo "✓ Piper-Stimmen in $MODELS"

# 4) Personal Layer anlegen (falls noch nicht vorhanden)
if [ ! -f personal/config.json ]; then
  mkdir -p personal/{memory,secrets,skills,automations,settings}
  cp setup/config.example.json personal/config.json
  echo "✓ personal/config.json angelegt (Kopie der Beispiel-Config) — Pfade anpassen!"
else
  echo "✓ personal/config.json existiert"
fi

# 5) Ollama-Hinweis
curl -s http://localhost:11434/ >/dev/null 2>&1 \
  && echo "✓ Ollama laeuft" \
  || echo "⚠ Ollama nicht erreichbar — 'brew services start ollama' und 'ollama pull qwen2.5:7b'"

echo ""
echo "Starten:"
echo "  .venv/bin/python core/voice-server.py &     # Stimme (Port 5690)"
echo "  node server/server.mjs                      # Deck (Port 5677)"
echo "  → http://localhost:5677"
echo ""
echo "Autostart (macOS): setup/launchd/README.md"
