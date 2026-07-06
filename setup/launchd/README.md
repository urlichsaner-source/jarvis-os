# Autostart via launchd (macOS)

Zwei Dienste: Deck-Server (Node) + Voice-Server (Python). Templates anpassen
(`__ROOT__` = absoluter Pfad zum Repo, `__HOME__` = Home-Verzeichnis, Prefix nach Wunsch):

```bash
sed -e "s|__ROOT__|$HOME/jarvis-os|g" -e "s|__HOME__|$HOME|g" \
  setup/launchd/jarvis-os-server.plist.template > ~/Library/LaunchAgents/com.jarvis-os.server.plist
sed -e "s|__ROOT__|$HOME/jarvis-os|g" -e "s|__HOME__|$HOME|g" \
  setup/launchd/jarvis-os-voice.plist.template > ~/Library/LaunchAgents/com.jarvis-os.voice.plist
launchctl load ~/Library/LaunchAgents/com.jarvis-os.server.plist
launchctl load ~/Library/LaunchAgents/com.jarvis-os.voice.plist
```

**macOS-TCC-Gotcha:** Liegt der Vault in `~/Desktop`/`~/Documents`, braucht der
Node-/Python-Prozess Vollzugriff („Full Disk Access") — sonst haengt der Start still.
Repo und Voice-Modelle direkt ins Home-Verzeichnis zu legen vermeidet das Problem.
