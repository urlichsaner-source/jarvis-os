# Jarvis OS

Ein lokales, persönliches KI-Kommandozentrum — 100 % auf deiner Maschine, 0 € Betriebskosten.
Holo-HUD-Dashboard („Command Deck") mit drehbarem 3D-Partikel-Kern, lokalem LLM (Ollama),
echter Sprach-Konversation (Whisper + Piper), Wissensgraph über deinen Markdown-Vault,
Automationen, Analytics und Memory-Engine.

![Architektur](docs/architektur.md)

## Kernideen

1. **Dein Vault ist die Datenbank.** Jarvis OS hat keine eigene Datenhaltung — es liest
   deinen Obsidian-/Markdown-Vault (Prioritäten, Loops, Projekte, Prompts) live.
2. **Alles lokal.** Ollama als Gehirn, faster-whisper als Ohr, Piper als Stimme.
   Keine Cloud, keine API-Kosten, deine Daten bleiben bei dir.
3. **Core / Personal strikt getrennt.** Dieses Repo ist der öffentliche Core.
   Alles Persönliche (Pfade, Keys, Persona, Memory) lebt in `personal/` — gitignored.

## Quickstart

```bash
git clone <repo> jarvis-os && cd jarvis-os
./setup/setup.sh                       # Venv + Piper-Stimmen + Beispiel-Config
brew services start ollama && ollama pull qwen2.5:7b
.venv/bin/python core/voice-server.py &   # Stimme (Port 5690)
node server/server.mjs                     # Deck → http://localhost:5677
```

Beim ersten Start läuft alles mit **Dummy-Daten** (`setup/dummy-vault/`).
Eigene Daten: `personal/config.json` anpassen (wird von `setup.sh` angelegt) —
`vaultPath` auf deinen Vault zeigen lassen, fertig. Der Core bleibt unverändert.

## Struktur

```
jarvis-os/
├── core/        Config-Layer, Voice-Server (STT+TTS), Tools (FlowDictate)
├── modules/     Vault-Parser, KI-Kern+Memory, Analytics, Action-Layer
├── server/      HTTP-Server (zero-dependency, Node >= 18)
├── ui/          Command Deck + Stimm-Studio (single-file, PWA)
├── setup/       Setup-Skript, Beispiel-Config, Dummy-Vault, launchd-Templates
├── docs/        Architektur, Stimm-Training, Betrieb
└── personal/    DEIN Layer — Config, Memory, Secrets, Skills (NICHT im Git)
```

## Features

- **Command Deck**: One-Pager ohne Scroll — Stats, Prioritäten, Empfehlungen,
  Jobs-Puls, permanente Konsole, Detail-Module als Holo-Overlays
- **3D-Kern**: 650-Punkte-Partikel-Sphäre, frei drehbar, pulsiert beim Denken,
  Partikel fliegen beim Wissenszugriff hinein (Canvas, kein Three.js)
- **Sprach-Gespräch**: Mikro-Tipp → sprechen → Auto-Stopp bei Stille →
  Antwort mit neuraler Stimme (satzweise gestreamt) → hört wieder zu
- **Eigene Stimme**: Aufnahme-Studio (`/stimme`) + Trainings-Runbook →
  Piper-Fine-Tune, wird automatisch geladen
- **Memory-Engine**: Gesprächsverlauf persistent, Kontext beim nächsten Start
- **FlowDictate** (`core/tools/`): systemweites Diktat — Hotkey halten, sprechen,
  KI-bereinigter Text landet an der Cursor-Position
- **Automationen**: launchd-Jobs mit Status + One-Click-Run, Dienste-Monitor,
  Claude-Code-Headless-Tasks (optional)
- **Analytics**: Token/Tool-Calls/Commits pro Tag aus Claude-Code-Transcripts

## Anforderungen

macOS (launchd/Voice-Routing), Node >= 18, Python >= 3.10, [Ollama](https://ollama.com).
Apple Silicon mit 16 GB RAM reicht für 7-8B-Modelle komfortabel.

## Lizenz

MIT — nutze es, verändere es, teile es. Der `personal/`-Ordner gehört dir allein.
