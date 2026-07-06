// Jarvis OS — Action-Layer: One-Click-Aktionen ueber bestehende Rails
// (Shell-Scripts, launchd, Push-Endpoint, Claude-Headless-Runs, Quick-Capture).
// Alles Personen-/Firmen-spezifische kommt aus der Config — der Core bleibt neutral.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CFG, PERSONAL } from '../core/config.mjs';
import { read, sh } from './vault.mjs';

const VAULT = CFG.vaultPath;
const PREFIX = CFG.launchdPrefix;

// ---------- launchd-Jobs ----------
export async function jobs() {
  const list = await sh('launchctl', ['list']);
  const running = {};
  const re = new RegExp('^(\\S+)\\s+(\\S+)\\s+(' + PREFIX.replace(/\./g, '\\.') + '\\S+)');
  for (const line of list.out.split('\n')) {
    const m = line.match(re);
    if (m) running[m[3]] = { pid: m[1] === '-' ? null : m[1], lastExit: m[2] === '-' ? null : Number(m[2]) };
  }
  const agents = [];
  const laDir = path.join(process.env.HOME, 'Library/LaunchAgents');
  let files = []; try { files = fs.readdirSync(laDir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.plist')); } catch {}
  for (const f of files) {
    const label = f.replace('.plist', '');
    const xml = read(path.join(laDir, f));
    const keepAlive = /KeepAlive/.test(xml);
    const hour = xml.match(/Hour<\/key>\s*<integer>(\d+)/)?.[1];
    const minute = xml.match(/Minute<\/key>\s*<integer>(\d+)/)?.[1];
    const weekday = xml.match(/Weekday<\/key>\s*<integer>(\d+)/)?.[1];
    const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const schedule = keepAlive ? 'immer aktiv' : hour != null ? `${weekday != null ? wd[weekday] + ' ' : 'tgl. '}${hour.padStart(2, '0')}:${(minute || '0').padStart(2, '0')}` : 'manuell';
    const logPath = xml.match(/StandardOutPath<\/key>\s*<string>([^<]+)/)?.[1];
    let logTail = null, logAge = null;
    if (logPath && fs.existsSync(logPath)) {
      const lines = read(logPath).trim().split('\n');
      logTail = lines.slice(-2).join(' · ').slice(0, 160);
      logAge = Math.floor((Date.now() - fs.statSync(logPath).mtimeMs) / 3600000);
    }
    agents.push({ label: label.replace(PREFIX, ''), schedule, ...(running[label] || { pid: null, lastExit: null }), logTail, logAgeH: logAge });
  }
  return agents.sort((a, b) => a.label.localeCompare(b.label));
}

// ---------- Dienste-Monitor (aus Config) ----------
export async function services() {
  const ping = async (url) => {
    try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 2500);
      const r = await fetch(url, { signal: c.signal }); clearTimeout(t); return r.status < 500; } catch { return false; }
  };
  const defs = CFG.services || [{ name: 'Ollama', url: CFG.ollamaUrl + '/', hint: 'lokaler KI-Kern' }];
  const results = await Promise.all(defs.map((s) => ping(s.url)));
  return [{ name: 'Jarvis OS', ok: true, hint: `Port ${CFG.port}` },
    ...defs.map((s, i) => ({ name: s.name, ok: results[i], hint: s.hint || '' }))];
}

// ---------- Empfehlungs-Engine (Regeln) ----------
export function recommendations(state) {
  const recs = [];
  if (state.loops.old14 > 0) recs.push({ level: 'warn', text: `${state.loops.old14} Loops älter als 14 Tage — Review würde aufräumen` });
  for (const j of state.jobs) {
    if (j.lastExit !== null && j.lastExit !== 0 && !j.pid) recs.push({ level: 'error', text: `Job „${j.label}" zuletzt fehlgeschlagen (Exit ${j.lastExit})` });
  }
  const backup = state.jobs.find((j) => j.label === 'vault-backup');
  if (backup && backup.logAgeH !== null && backup.logAgeH > 26) recs.push({ level: 'warn', text: `Vault-Backup lief seit ${backup.logAgeH} h nicht — Log prüfen` });
  if (state.briefe.open > 0) recs.push({ level: 'info', text: `${state.briefe.open} Brief(e) offen — Deadlines im Briefe-Index prüfen` });
  if (!PERSONAL) recs.push({ level: 'info', text: 'Dummy-Modus aktiv — personal/config.json anlegen für eigene Daten (siehe docs/)' });
  if (!recs.length) recs.push({ level: 'ok', text: 'Alles grün — keine Auffälligkeiten' });
  return recs;
}

// ---------- Claude-Headless-Runs (Prompts aus Config) ----------
const CLAUDE_BIN = CFG.claudeBin || path.join(process.env.HOME, '.local/bin/claude');
const RUNS = {};
const taskDef = (name) => {
  const t = (CFG.claudeTasks || {})[name];
  if (!t) return null;
  const date = new Date().toISOString().slice(0, 10);
  return { cwd: t.cwd || VAULT, file: t.file.replace('{date}', date), prompt: t.prompt };
};

export function claudeStatus() {
  return Object.entries(RUNS).map(([task, r]) => {
    let alive = false; try { process.kill(r.pid, 0); alive = true; } catch {}
    const exists = fs.existsSync(r.file);
    return { task, alive, startedAt: r.startedAt, file: r.file.replace(VAULT + '/', ''),
      preview: exists ? read(r.file).slice(-400) : null, done: !alive && exists };
  });
}

// ---------- Aktionen ----------
export const actions = {
  async backup() {
    if (!CFG.actions?.backupScript) return { ok: false, out: 'Kein backupScript in der Config' };
    return sh('/bin/bash', [CFG.actions.backupScript], { timeout: 120000 });
  },
  async tsc() {
    const dirs = CFG.actions?.tscDirs || [];
    if (!dirs.length) return { ok: false, out: 'Keine tscDirs in der Config' };
    let out = '';
    for (const p of dirs) {
      const r = await sh('npx', ['tsc', '--noEmit'], { cwd: p, timeout: 240000 });
      out += `── ${p}: ${r.ok ? '✓ sauber' : '✗ Fehler'}\n${r.ok ? '' : r.out.slice(0, 1500) + '\n'}`;
      if (!r.ok) return { ok: false, out };
    }
    return { ok: true, out };
  },
  async 'preview-start'() {
    if (!CFG.actions?.previewScript) return { ok: false, out: 'Kein previewScript in der Config' };
    spawn('/bin/bash', [CFG.actions.previewScript], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, out: 'Preview startet — URL erscheint in ~30-60 s (Status-Button)' };
  },
  async 'preview-status'() {
    const url = read('/tmp/cf_tunnel.log').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    const expo = await sh('/usr/bin/pgrep', ['-f', 'expo start --web']);
    const cf = await sh('/usr/bin/pgrep', ['-f', 'cloudflared tunnel']);
    const running = expo.ok && cf.ok;
    return { ok: true, out: running && url ? `LÄUFT → ${url}` : running ? 'startet noch — gleich nochmal prüfen' : 'nicht aktiv', url: running ? url : null };
  },
  async push(payload) {
    const tg = CFG.telegram;
    if (!tg?.envFile || !tg?.notifyUrl) return { ok: false, out: 'Telegram nicht konfiguriert (config.telegram)' };
    const token = read(tg.envFile).match(/NOTIFY_TOKEN=([^\s"']+)/)?.[1];
    if (!token) return { ok: false, out: 'NOTIFY_TOKEN nicht gefunden' };
    const msg = String(payload?.message || '').slice(0, 800);
    if (!msg) return { ok: false, out: 'Leere Nachricht' };
    const r = await fetch(tg.notifyUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Notify-Token': token },
      body: JSON.stringify({ title: CFG.title, message: msg }),
    });
    return { ok: r.ok, out: r.ok ? '✓ Push gesendet' : `Fehler HTTP ${r.status}` };
  },
  async capture(payload) {
    const text = String(payload?.text || '').slice(0, 500).trim();
    if (!text) return { ok: false, out: 'Leerer Text' };
    const p = path.join(VAULT, '00-inbox/capture.md');
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    let content = read(p);
    const entry = `- [${stamp}] ${text}\n`;
    content = content.includes('## Ideen') ? content.replace('## Ideen\n', `## Ideen\n${entry}`) : content + '\n' + entry;
    fs.writeFileSync(p, content);
    return { ok: true, out: '✓ In Inbox erfasst' };
  },
  async 'job-run'(payload) {
    const label = String(payload?.label || '');
    if (!/^[a-z0-9-]+$/.test(label)) return { ok: false, out: 'Ungültiges Label' };
    const r = await sh('launchctl', ['kickstart', `gui/501/${PREFIX}${label}`]);
    return { ok: r.ok, out: r.ok ? `✓ ${label} gestartet` : r.out.slice(0, 200) };
  },
  async 'claude-run'(payload) {
    const task = String(payload?.task || '');
    const t = taskDef(task);
    if (!t) return { ok: false, out: 'Unbekannter Task (config.claudeTasks)' };
    const running = RUNS[task] && (() => { try { process.kill(RUNS[task].pid, 0); return true; } catch { return false; } })();
    if (running) return { ok: false, out: `„${task}" läuft bereits seit ${RUNS[task].startedAt}` };
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    const fd = fs.openSync(t.file, 'w');
    const child = spawn(CLAUDE_BIN, ['-p', t.prompt], { cwd: t.cwd, detached: true, stdio: ['ignore', fd, fd] });
    child.unref(); fs.closeSync(fd);
    RUNS[task] = { pid: child.pid, file: t.file, startedAt: new Date().toLocaleTimeString('de-DE') };
    return { ok: true, out: `✓ KI-Task „${task}" gestartet (dauert 1-3 Min) → ${t.file.replace(VAULT + '/', '')}` };
  },
  async 'claude-status'() {
    const s = claudeStatus();
    if (!s.length) return { ok: true, out: 'Keine KI-Tasks gestartet' };
    return { ok: true, out: s.map((r) => `${r.task}: ${r.alive ? '⏳ läuft seit ' + r.startedAt : '✓ fertig'} → ${r.file}${r.done && r.preview ? '\n---\n' + r.preview : ''}`).join('\n\n') };
  },
};
