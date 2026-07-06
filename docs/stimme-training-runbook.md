# Runbook: Piper auf die eigene Stimme trainieren

> Letzte Aktualisierung: 2026-07-06
> Ziel: `de_DE-personal.onnx` in `~/voice-models/` — der voice-server nimmt sie dann automatisch für Deutsch.

## Ablauf in 3 Schritten

### 1. Aufnehmen (Mac, ~30–45 Min Sprechzeit)

- Studio öffnen: **http://localhost:5677/stimme**
- ~180 Sätze einsprechen. Minimum für brauchbare Qualität: **~150 Sätze**; je mehr, desto besser.
- Fortschritt wird serverseitig gespeichert — jederzeit unterbrechbar.
- Ergebnis liegt in `~/voice-models/dataset-personal/` (LJSpeech-Format: `wavs/*.wav` 22.050 Hz mono + `metadata.csv`).
- Die 6 russischen Sätze im Korpus einfach mitsprechen oder überspringen — sie schaden dem deutschen Training nicht, VOR dem Training aber aus `metadata.csv` löschen (Piper de-Phonemizer kennt kein Kyrillisch). Kommando:
  `grep -v -E '\|[^|]*[а-яА-Я]' metadata.csv > metadata.clean.csv && mv metadata.clean.csv metadata.csv`

### 2. Trainieren (Google Colab, kostenlos, ~4–6 h)

**Fine-Tuning** vom Thorsten-Checkpoint — braucht viel weniger Daten/Zeit als Training von Null.

1. Dataset zippen: `cd ~/voice-models && zip -r dataset-personal.zip dataset-personal`
2. Colab öffnen (GPU-Laufzeit T4): das bewährte Community-Notebook
   **https://colab.research.google.com/github/rmcpantoja/piper/blob/master/notebooks/piper_multilingual_training_notebook.ipynb**
   (deutsche Anleitung im Notebook; Alternative: manuelle Schritte unten)
3. Einstellungen im Notebook:
   - Sprache: `de` · Dataset-Format: **LJSpeech** · Sample-Rate: 22050 · Qualität: **high**
   - **Fine-Tuning aktivieren** und als Basis-Checkpoint Thorsten-high angeben:
     `https://huggingface.co/datasets/rhasspy/piper-checkpoints/tree/main/de/de_DE/thorsten/high` (die `epoch=*.ckpt`-Datei)
   - `dataset-personal.zip` hochladen (oder via Google Drive)
   - Epochen: ~**1000–2000 zusätzliche Steps/bis Loss flach** — bei 150–180 Sätzen reichen meist 2–4 h auf T4. Checkpoint regelmäßig nach Drive sichern (Colab-Timeout!)
4. Export im Notebook: **ONNX exportieren** → ergibt `model.onnx` + `model.onnx.json`

Manuelle Variante (falls Notebook bricht):
```bash
git clone https://github.com/rhasspy/piper && cd piper/src/python
pip install -e . && pip install torchmetrics==0.11.4
python -m piper_train.preprocess --language de --input-dir dataset-personal \
  --output-dir train-personal --dataset-format ljspeech --single-speaker --sample-rate 22050
python -m piper_train --dataset-dir train-personal --accelerator gpu --devices 1 \
  --batch-size 12 --validation-split 0.0 --num-test-examples 0 \
  --quality high --checkpoint-epochs 1 --max_epochs 10000 \
  --resume_from_checkpoint thorsten-high-epoch=XXXX.ckpt
python -m piper_train.export_onnx lightning_logs/version_0/checkpoints/LETZTER.ckpt de_DE-personal.onnx
cp train-personal/config.json de_DE-personal.onnx.json
```

### 3. Einbauen (Mac, 1 Minute)

```bash
# beide Dateien nach ~/voice-models/ legen:
#   de_DE-personal.onnx  +  de_DE-personal.onnx.json
launchctl kickstart -k gui/$(id -u)/com.jarvis-os.voice
tail -5 ~/jarvis-os-voice.log   # muss zeigen: "PERSOENLICHE Stimme aktiv"
```
Fertig — das Command Deck spricht ab sofort mit deiner Stimme (Russisch bleibt Irina).

## Erwartungsmanagement

- 150–180 Sätze Fine-Tune ≈ klar als deine Stimme erkennbar, gelegentlich leichte Artefakte bei seltenen Wörtern.
- Deutlich besser: später auf ~300–500 Sätze aufstocken (Studio einfach weiterbenutzen) und nochmal fein-tunen.
- Referenz: Thorsten-Voice-Datensatz hat >12.000 Sätze — dahin muss man nicht, aber Richtung zeigt Wirkung.
