// Jarvis OS — Config-Layer.
// Laedt personal/config.json (privater Layer) falls vorhanden,
// sonst setup/config.example.json (Dummy-Daten fuer den ersten Start).
// Pfad-Platzhalter: "~" = Home, "$ROOT" = Repo-Wurzel, "$VAULT" = vaultPath.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const personalFile = path.join(ROOT, 'personal/config.json');
const exampleFile = path.join(ROOT, 'setup/config.example.json');
export const PERSONAL = fs.existsSync(personalFile);

const raw = JSON.parse(fs.readFileSync(PERSONAL ? personalFile : exampleFile, 'utf8'));
const expandStr = (v, vault) => v
  .replace(/^~(?=\/|$)/, os.homedir())
  .replace(/\$ROOT/g, ROOT)
  .replace(/\$VAULT/g, vault || '');
const vaultPath = expandStr(raw.vaultPath || '$ROOT/setup/dummy-vault', '');
const deep = (o) => Array.isArray(o) ? o.map(deep)
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deep(v)]))
  : typeof o === 'string' ? expandStr(o, vaultPath) : o;

export const CFG = deep(raw);
CFG.vaultPath = vaultPath;
CFG.port ||= 5677;
CFG.ollamaUrl ||= 'http://localhost:11434';
CFG.defaultModel ||= 'qwen2.5:7b';
CFG.userName ||= 'Commander';
CFG.title ||= 'Command Deck';
CFG.launchdPrefix ||= 'com.jarvis-os.';
CFG.voiceServer = { url: 'http://127.0.0.1:5690', ...(CFG.voiceServer || {}) };
CFG.memoryDir ||= path.join(ROOT, PERSONAL ? 'personal/memory' : 'setup/dummy-memory');
fs.mkdirSync(CFG.memoryDir, { recursive: true });

console.log(`[config] ${PERSONAL ? 'Personal Layer geladen' : 'Beispiel-Config (Dummy-Daten) — personal/config.json anlegen fuer eigene Daten'}`);
console.log(`[config] Vault: ${CFG.vaultPath}`);
