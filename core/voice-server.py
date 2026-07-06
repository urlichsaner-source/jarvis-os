#!/usr/bin/env python3
"""
Jarvis OS — Voice-Server: haelt Whisper (STT) und Piper (TTS) WARM im RAM.
Port 5690, nur localhost. Endpoints:
  POST /stt            Body = Audio (webm/mp4/aiff/wav) → {"text","lang"}
  POST /tts            Body = JSON {"text","lang":"de|ru"} → audio/wav
  POST /record?id&text Body = Audio → Trainings-Dataset (LJSpeech, 22.050 Hz)
  GET  /health, /record/status

Konfiguration ueber Env:
  VOICE_MODELS_DIR   Ordner mit Piper-.onnx-Stimmen (Default ~/voice-models)
  VOICE_WHISPER      Whisper-Groesse (Default small)
  VOICE_DE/VOICE_RU  Stimm-Dateinamen (Default thorsten-high / irina-medium)
  VOICE_PERSONAL     eigene trainierte Stimme — ersetzt automatisch "de" wenn vorhanden
  VOICE_DATASET      Name des Aufnahme-Datasets (Default dataset-personal)
"""
import io
import json
import os
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("VOICE_PORT", "5690"))
VOICES_DIR = os.path.expanduser(os.environ.get("VOICE_MODELS_DIR", "~/voice-models"))
WHISPER_SIZE = os.environ.get("VOICE_WHISPER", "small")
VOICE_FILES = {
    "de": os.environ.get("VOICE_DE", "de_DE-thorsten-high.onnx"),
    "ru": os.environ.get("VOICE_RU", "ru_RU-irina-medium.onnx"),
}
PERSONAL_VOICE = os.environ.get("VOICE_PERSONAL", "de_DE-personal.onnx")
DATASET_NAME = os.environ.get("VOICE_DATASET", "dataset-personal")

print(f"[voice-server] lade faster-whisper ({WHISPER_SIZE}) …", flush=True)
from faster_whisper import WhisperModel
whisper = WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8")
whisper_lock = threading.Lock()
print("[voice-server] Whisper bereit.", flush=True)

print("[voice-server] lade Piper-Stimmen …", flush=True)
from piper import PiperVoice
VOICES = {}
for lang, fname in VOICE_FILES.items():
    p = os.path.join(VOICES_DIR, fname)
    if os.path.exists(p):
        VOICES[lang] = PiperVoice.load(p)
# Eigene trainierte Stimme — wird automatisch genutzt sobald vorhanden
personal_path = os.path.join(VOICES_DIR, PERSONAL_VOICE)
if os.path.exists(personal_path):
    VOICES["de"] = PiperVoice.load(personal_path)
    print(f"[voice-server] PERSOENLICHE Stimme aktiv ({PERSONAL_VOICE}).", flush=True)
if not VOICES:
    print(f"[voice-server] WARNUNG: keine Stimmen in {VOICES_DIR} — setup/setup.sh laedt Standard-Stimmen.", flush=True)
tts_lock = threading.Lock()
print(f"[voice-server] Piper bereit ({', '.join(VOICES) or 'keine'}).", flush=True)

# ---------- Aufnahme-Dataset fuer Stimm-Training (LJSpeech-Format) ----------
DATASET = os.path.join(VOICES_DIR, DATASET_NAME)
os.makedirs(os.path.join(DATASET, "wavs"), exist_ok=True)
META = os.path.join(DATASET, "metadata.csv")
meta_lock = threading.Lock()

def convert_to_wav_22050(raw: bytes, dst: str):
    """Browser-Audio (webm/mp4) → mono 22050 Hz s16 WAV (Piper-Trainingsformat) via PyAV."""
    import av
    pcm = b""
    with av.open(io.BytesIO(raw)) as ic:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=22050)
        for frame in ic.decode(audio=0):
            for rf in resampler.resample(frame):
                pcm += rf.to_ndarray().tobytes()
        for rf in resampler.resample(None):  # Resampler-Rest flushen
            pcm += rf.to_ndarray().tobytes()
    with wave.open(dst, "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(22050)
        wf.writeframes(pcm)

def record_status():
    done = {}
    if os.path.exists(META):
        for line in open(META, encoding="utf-8"):
            if "|" in line:
                done[line.split("|", 1)[0]] = True
    return {"done": sorted(done), "count": len(done)}

def record_save(rec_id: str, text: str, raw: bytes):
    if not rec_id.isdigit():
        raise ValueError("id muss numerisch sein")
    name = f"rec_{int(rec_id):04d}"
    convert_to_wav_22050(raw, os.path.join(DATASET, "wavs", f"{name}.wav"))
    with meta_lock:
        lines = []
        if os.path.exists(META):
            lines = [l for l in open(META, encoding="utf-8") if not l.startswith(name + "|")]
        lines.append(f"{name}|{text.strip()}\n")
        lines.sort()
        open(META, "w", encoding="utf-8").writelines(lines)
    return name

def synth_wav(text: str, lang: str) -> bytes:
    voice = VOICES.get(lang) or next(iter(VOICES.values()))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        with tts_lock:
            voice.synthesize_wav(text, wf)
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[voice-server] {fmt % args}", flush=True)

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "whisper": WHISPER_SIZE, "voices": list(VOICES),
                                    "personal_voice": os.path.exists(personal_path)})
        if self.path == "/record/status":
            return self._json(200, record_status())
        self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 20_000_000:
            return self._json(413, {"error": "zu gross"})
        raw = self.rfile.read(n)
        try:
            if self.path.startswith("/record?"):
                from urllib.parse import parse_qs, urlparse
                q = parse_qs(urlparse(self.path).query)
                rec_id = (q.get("id") or [""])[0]
                text = (q.get("text") or [""])[0]
                if not rec_id or not text:
                    return self._json(400, {"error": "id und text noetig"})
                name = record_save(rec_id, text, raw)
                print(f"[voice-server] Aufnahme gespeichert: {name}", flush=True)
                return self._json(200, {"ok": True, "name": name, **record_status()})
            if self.path == "/stt":
                t0 = time.time()
                with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
                    f.write(raw); tmp = f.name
                try:
                    with whisper_lock:
                        segments, info = whisper.transcribe(tmp, vad_filter=True, beam_size=1)
                        text = " ".join(s.text for s in segments).strip()
                finally:
                    os.unlink(tmp)
                print(f"[voice-server] STT {time.time()-t0:.1f}s: {text[:80]}", flush=True)
                return self._json(200, {"text": text, "lang": info.language})
            if self.path == "/tts":
                d = json.loads(raw or b"{}")
                text = str(d.get("text", "")).strip()[:800]
                if not text:
                    return self._json(400, {"error": "kein Text"})
                if not VOICES:
                    return self._json(503, {"error": "keine Piper-Stimmen installiert"})
                t0 = time.time()
                wav = synth_wav(text, d.get("lang", "de"))
                print(f"[voice-server] TTS {time.time()-t0:.1f}s · {len(text)} Zeichen ({d.get('lang','de')})", flush=True)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)
                return
        except Exception as e:
            return self._json(500, {"error": str(e)[:300]})
        self._json(404, {"error": "not found"})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"[voice-server] laeuft auf http://127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
