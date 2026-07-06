#!/usr/bin/env python3
"""
FlowDictate — systemweites Diktier-Tool (Wispr-Flow-Klon, 100 % lokal, 0 €).

Bedienung: RECHTE OPTION-TASTE (⌥ rechts) gedrueckt HALTEN und sprechen.
Loslassen → faster-whisper transkribiert → Ollama entfernt Fuellwoerter/Slang
und setzt saubere Zeichensetzung → Text wird an der Cursor-Position der
aktiven App eingefuegt (Cmd+V). DE + RU automatisch erkannt.

Benoetigte macOS-Rechte (einmalig, fuer den Python-Prozess bzw. Terminal):
  · Mikrofon  · Bedienungshilfen (Accessibility)  · Eingabemonitoring
"""
import os
import queue
import subprocess
import threading
import time

import numpy as np
import requests
import sounddevice as sd
from pynput import keyboard

# ---------- Konfiguration ----------
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("FLOW_MODEL", "qwen2.5:7b")
WHISPER_SIZE = os.environ.get("FLOW_WHISPER", "small")   # small = gute Diktat-Qualitaet
HOTKEY = keyboard.Key.alt_r                               # rechte Option-Taste
SAMPLE_RATE = 16000
MIN_SEC = 0.4        # kuerzere Aufnahmen ignorieren (versehentlicher Tastendruck)
MAX_SEC = 120        # Sicherheitslimit
RAW_MODE_PREFIX = "roh"  # gesprochenes "roh" am Anfang → ohne KI-Cleanup einfuegen

CLEANUP_PROMPT = """Du bist ein Diktat-Korrektor. Der folgende Text ist eine rohe Sprach-Transkription.
Wandle sie in sauberen, natuerlichen Schrifttext um:
- Entferne Fuellwoerter (aeh, aehm, halt, quasi, sozusagen, also am Satzanfang, ну, вот, короче, э-э)
- Entferne Wortwiederholungen und Selbstkorrekturen (behalte die korrigierte Version)
- Setze korrekte Zeichensetzung und Gross-/Kleinschreibung
- Korrigiere offensichtliche Transkriptionsfehler aus dem Kontext
- Behalte Inhalt, Ton und SPRACHE exakt bei (Deutsch bleibt Deutsch, Russisch bleibt Russisch)
- Fuege NICHTS hinzu, beantworte NICHTS, kommentiere NICHTS
Gib NUR den bereinigten Text aus, ohne Anfuehrungszeichen.

Transkription: {text}

Bereinigter Text:"""

log_lock = threading.Lock()
def log(msg: str):
    with log_lock:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def play(sound: str):
    subprocess.Popen(["afplay", f"/System/Library/Sounds/{sound}.aiff"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# ---------- Whisper (einmal laden, warm halten) ----------
log(f"Lade faster-whisper ({WHISPER_SIZE}) …")
from faster_whisper import WhisperModel
whisper = WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8")
log("Whisper bereit.")

# ---------- Aufnahme ----------
class Recorder:
    def __init__(self):
        self.q: "queue.Queue[np.ndarray]" = queue.Queue()
        self.stream = None
        self.frames = []
        self.recording = False
        self.started_at = 0.0

    def start(self):
        if self.recording:
            return
        self.frames = []
        self.recording = True
        self.started_at = time.time()
        self.stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="float32",
            blocksize=int(SAMPLE_RATE * 0.1),
            callback=lambda indata, *_: self.frames.append(indata.copy()) if self.recording else None,
        )
        self.stream.start()
        play("Pop")
        log("● Aufnahme laeuft …")

    def stop(self) -> np.ndarray | None:
        if not self.recording:
            return None
        self.recording = False
        dur = time.time() - self.started_at
        try:
            self.stream.stop(); self.stream.close()
        except Exception:
            pass
        if dur < MIN_SEC or not self.frames:
            log(f"(zu kurz, {dur:.1f}s — ignoriert)")
            return None
        audio = np.concatenate(self.frames, axis=0).flatten()
        return audio[: SAMPLE_RATE * MAX_SEC]

rec = Recorder()

# ---------- Pipeline: Transkription → Cleanup → Einfuegen ----------
def cleanup(text: str) -> str:
    try:
        r = requests.post(f"{OLLAMA}/api/generate", json={
            "model": MODEL,
            "prompt": CLEANUP_PROMPT.format(text=text),
            "stream": False,
            "options": {"temperature": 0.1},
        }, timeout=60)
        r.raise_for_status()
        out = r.json().get("response", "").strip().strip('"').strip()
        # Schutz: Wenn das Modell halluziniert (viel laenger/leer), lieber Rohtext
        if out and len(out) <= len(text) * 2:
            return out
    except Exception as e:
        log(f"Ollama-Cleanup fehlgeschlagen ({e}) — nutze Rohtext")
    return text

def paste(text: str):
    # Text in Zwischenablage + Cmd+V in die aktive App (bleibt danach im Clipboard)
    p = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
    p.communicate(text.encode("utf-8"))
    time.sleep(0.15)
    subprocess.run(["osascript", "-e",
                    'tell application "System Events" to keystroke "v" using command down'])

def process(audio: np.ndarray):
    t0 = time.time()
    segments, info = whisper.transcribe(audio, vad_filter=True)
    raw = " ".join(s.text for s in segments).strip()
    if not raw:
        play("Basso"); log("(nichts verstanden)")
        return
    log(f"🗣  {info.language}: {raw}")
    if raw.lower().lstrip(" ,.").startswith(RAW_MODE_PREFIX + " "):
        final = raw.lstrip(" ,.")[len(RAW_MODE_PREFIX):].strip()  # "roh" = ohne Cleanup
    else:
        final = cleanup(raw)
    log(f"✍️  {final}  ({time.time()-t0:.1f}s)")
    paste(final)
    play("Glass")

# ---------- Hotkey-Listener ----------
def on_press(key):
    if key == HOTKEY:
        rec.start()

def on_release(key):
    if key == HOTKEY:
        audio = rec.stop()
        if audio is not None:
            threading.Thread(target=process, args=(audio,), daemon=True).start()

def main():
    log("=" * 52)
    log(f"FLOWDICTATE · Whisper {WHISPER_SIZE} · Cleanup {MODEL}")
    log("Rechte ⌥-Taste HALTEN → sprechen → loslassen = einfuegen")
    log(f"Tipp: mit '{RAW_MODE_PREFIX} …' beginnen = ohne KI-Cleanup")
    log("=" * 52)
    play("Purr")
    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
        listener.join()

if __name__ == "__main__":
    main()
