# Architektur

## Zwei-Schichten-Modell

```
┌──────────────────────────────────────────────────────┐
│  PERSONAL LAYER (personal/ — gitignored, nur deins)  │
│  config.json · memory/ · secrets/ · skills/          │
└──────────────────────┬───────────────────────────────┘
                       │ core/config.mjs laedt personal/config.json,
                       │ faellt sonst auf setup/config.example.json zurueck
┌──────────────────────▼───────────────────────────────┐
│  CORE (oeffentlich)                                   │
│                                                       │
│  server/server.mjs ── HTTP :5677 ── ui/index.html     │
│      │                                                │
│      ├─ modules/vault.mjs      Vault = Datenbank      │
│      ├─ modules/ollama.mjs     KI-Kern + Memory       │
│      ├─ modules/analytics.mjs  Transcripts + Git      │
│      ├─ modules/actions.mjs    launchd/Push/Claude    │
│      └─ core/voice-server.py   :5690 Whisper + Piper  │
└──────────────────────────────────────────────────────┘
```

## Datenfluesse

**Frage an den Kern** (Text oder Stimme):
Browser → `/api/ollama/ask` → Stichwort-grep im Vault (Wissenszugriff, Quellen als
SSE-Event) → Kontext + Gespraechsverlauf + Persona (aus Config) → Ollama `/api/chat`
Stream → Tokens als SSE → UI spricht fertige Saetze sofort via `/api/voice/tts` (Piper).
Jede Runde wird in `memoryDir/history.jsonl` persistiert (Memory-Engine) und beim
naechsten Start als Verlauf geladen.

**Sprache rein:** MediaRecorder (Browser, VAD-Auto-Stopp via WebAudio-Analyser) →
`/api/voice/transcribe` → voice-server `/stt` (faster-whisper, warm im RAM).

**iOS-Audio-Gotcha:** Nach `getUserMedia` schaltet iOS in die leise Telefonie-Route.
Loesung im UI: TTS ueber EIN `<audio>`-Element (in der Mikro-Geste entsperrt) +
`navigator.audioSession.type` = `play-and-record` nur beim Zuhoeren, `playback` beim
Antworten.

**Vault-Konventionen** (anpassbar, Dummy in `setup/dummy-vault/`):
`03-strategy/current-priorities.md` (Sektionen `### Hot`, `### Business (Top 3)`,
offene `- [ ]`-Punkte) · `03-strategy/open-loops.md` (Tabelle unter `## Wartend auf`)
· `07-intelligence/briefe/README.md` (Tabelle unter `## Offen`) · `04-projects/*/README.md`
· `08-resources/prompts/*.md` · Wikilinks `[[...]]` bilden den Wissensgraph.

## Warum zero-dependency?

Ein Node-Prozess, kein Framework, Single-File-UI. Ergebnis: nichts zu bauen, nichts
zu updaten, laeuft in Jahren noch. Der Python-Teil (Voice) ist der einzige mit
Dependencies — isoliert im eigenen Venv und eigenen Prozess.

## Sicherheit

- Server bindet an 0.0.0.0 fuer LAN/Tailnet-Zugriff — Zugangsschutz ist Netzwerk-Sache
  (Empfehlung: Tailscale serve, NICHT oeffentlich funneln).
- voice-server bindet nur 127.0.0.1.
- Secrets liegen ausschliesslich im Personal Layer bzw. in per Config referenzierten
  Dateien ausserhalb des Repos.
