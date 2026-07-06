// Jarvis OS — HTTP-Server (zero-dependency, Node >= 18).
// Start: node server/server.mjs · Konfiguration: personal/config.json (sonst Dummy-Modus).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, ROOT, PERSONAL } from '../core/config.mjs';
import { read, sh, parsePriorities, parseLoops, parseBriefe, parseSkills, parseProjects, parsePrompts, graph, searchVault } from '../modules/vault.mjs';
import { analytics } from '../modules/analytics.mjs';
import { ollamaModels, ollamaAsk, memoryRecent } from '../modules/ollama.mjs';
import { jobs, services, recommendations, actions } from '../modules/actions.mjs';

const UI = path.join(ROOT, 'ui');
const VAULT = CFG.vaultPath;
const VOICE_SRV = CFG.voiceServer.url;
process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;

// ---------- Voice-Proxys (warmer voice-server: STT + TTS) ----------
async function voiceTranscribe(req, res) {
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const chunks = []; let size = 0;
  for await (const ch of req) { size += ch.length; if (size > 15e6) return json(413, { error: 'Aufnahme zu gross' }); chunks.push(ch); }
  if (!size) return json(400, { error: 'Kein Audio' });
  try {
    const r = await fetch(`${VOICE_SRV}/stt`, { method: 'POST', body: Buffer.concat(chunks), signal: AbortSignal.timeout(90000) });
    if (r.ok) return json(200, await r.json());
    return json(502, { error: `voice-server HTTP ${r.status}` });
  } catch { return json(503, { error: 'voice-server nicht erreichbar (Port 5690) — setup/setup.sh ausfuehren' }); }
}
async function voiceTts(req, res) {
  let body = ''; for await (const ch of req) body += ch;
  try {
    const r = await fetch(`${VOICE_SRV}/tts`, { method: 'POST', body, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`voice-server HTTP ${r.status}`);
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    return res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'TTS nicht verfuegbar: ' + String(e).slice(0, 120) }));
  }
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CFG.port}`);
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  try {
    if (url.pathname === '/api/config') {
      return json(200, { userName: CFG.userName, title: CFG.title, personal: PERSONAL, defaultModel: CFG.defaultModel, launchdPrefix: CFG.launchdPrefix });
    }
    if (url.pathname === '/api/state') {
      const [jobList, ...logs] = await Promise.all([
        jobs(),
        ...(CFG.workRepos || [VAULT]).slice(0, 2).map((repo) => sh('git', ['log', '--oneline', '-5'], { cwd: repo })),
      ]);
      const state = {
        generatedAt: new Date().toISOString(),
        top: parsePriorities(), loops: parseLoops(), briefe: parseBriefe(),
        jobs: jobList, skills: parseSkills(), projects: parseProjects(),
        commits: { vault: (logs[0]?.out || '').trim().split('\n').filter(Boolean), wp: (logs[1]?.out || '').trim().split('\n').filter(Boolean) },
      };
      state.recommendations = recommendations(state);
      // Neueste KI-Tagesanalyse einblenden (falls der Tages-Task laeuft)
      try {
        const ed = path.join(VAULT, '07-intelligence/empfehlungen');
        const latest = fs.readdirSync(ed).filter((f) => f.endsWith('.md')).sort().pop();
        if (latest) state.aiRecs = { date: latest.replace('.md', ''), text: read(path.join(ed, latest)).slice(0, 1600) };
      } catch {}
      return json(200, state);
    }
    if (url.pathname === '/api/analytics') return json(200, await analytics());
    if (url.pathname === '/api/prompts') return json(200, parsePrompts());
    if (url.pathname === '/api/graph') return json(200, graph());
    if (url.pathname === '/api/ollama/models') return json(200, await ollamaModels());
    if (url.pathname === '/api/ollama/ask' && req.method === 'POST') return ollamaAsk(req, res);
    if (url.pathname === '/api/memory/recent') return json(200, memoryRecent(6));
    if (url.pathname === '/api/voice/transcribe' && req.method === 'POST') return voiceTranscribe(req, res);
    if (url.pathname === '/api/voice/tts' && req.method === 'POST') return voiceTts(req, res);
    if (url.pathname === '/api/search') return json(200, await searchVault(url.searchParams.get('q')));
    if (url.pathname === '/api/services') return json(200, await services());
    // Aufnahme-Studio (Stimm-Training): Proxy zum voice-server
    if (url.pathname === '/api/record/status') {
      try { return json(200, await (await fetch(`${VOICE_SRV}/record/status`)).json()); }
      catch { return json(503, { error: 'voice-server nicht erreichbar' }); }
    }
    if (url.pathname === '/api/record' && req.method === 'POST') {
      const chunks = []; for await (const ch of req) chunks.push(ch);
      try {
        const r = await fetch(`${VOICE_SRV}/record?${url.searchParams}`, { method: 'POST', body: Buffer.concat(chunks), signal: AbortSignal.timeout(30000) });
        return json(r.status, await r.json());
      } catch { return json(503, { error: 'voice-server nicht erreichbar' }); }
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { name, payload } = JSON.parse(body || '{}');
      if (!actions[name]) return json(400, { ok: false, out: 'Unbekannte Aktion' });
      return json(200, await actions[name](payload));
    }
    // Statische UI-Assets (Whitelist, kein Traversal)
    const STATIC = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'text/javascript', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' };
    if (STATIC[url.pathname]) {
      const fp = path.join(UI, path.basename(url.pathname));
      if (fs.existsSync(fp)) { res.writeHead(200, { 'Content-Type': STATIC[url.pathname] }); return res.end(fs.readFileSync(fp)); }
    }
    if (url.pathname === '/stimme') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(read(path.join(UI, 'stimme.html')));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(read(path.join(UI, 'index.html')));
    }
    json(404, { error: 'not found' });
  } catch (e) {
    json(500, { error: String(e).slice(0, 300) });
  }
});
server.listen(CFG.port, '0.0.0.0', () => console.log(`Jarvis OS läuft auf http://localhost:${CFG.port}${PERSONAL ? '' : ' (Dummy-Modus)'}`));
