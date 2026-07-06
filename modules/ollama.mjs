// Jarvis OS — KI-Kern: Ollama (lokal) + Vault-Wissenszugriff + Memory-Engine.
// Memory: jede Gespraechsrunde wird persistent in memoryDir/history.jsonl gesichert
// und beim naechsten Start als Kontext wieder angeboten (/api/memory/recent).
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from '../core/config.mjs';
import { read, searchVault } from './vault.mjs';

const OLLAMA = CFG.ollamaUrl;
const MEMORY_FILE = path.join(CFG.memoryDir, 'history.jsonl');

export function memoryAppend(q, a) {
  try { fs.appendFileSync(MEMORY_FILE, JSON.stringify({ ts: new Date().toISOString(), q, a }) + '\n'); } catch {}
}
export function memoryRecent(n = 6) {
  try {
    const lines = fs.readFileSync(MEMORY_FILE, 'utf8').trim().split('\n');
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export async function ollamaModels() {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 2500);
    const [tags, ps] = await Promise.all([
      fetch(`${OLLAMA}/api/tags`, { signal: c.signal }).then((r) => r.json()),
      fetch(`${OLLAMA}/api/ps`, { signal: c.signal }).then((r) => r.json()).catch(() => ({ models: [] })),
    ]);
    clearTimeout(t);
    return { ok: true, models: (tags.models || []).map((m) => ({ name: m.name, size: Math.round(m.size / 1e9 * 10) / 10 })), running: (ps.models || []).map((m) => m.name) };
  } catch { return { ok: false, models: [], running: [] }; }
}

// Frage → Wissenszugriff (Vault-grep) → Kontext + Verlauf → Ollama-Chat-Stream als SSE
const STOP = new Set(['was', 'ist', 'das', 'der', 'die', 'und', 'ein', 'eine', 'einen', 'einem', 'einer', 'für', 'fuer', 'auf', 'mit', 'von', 'wie', 'wer', 'wann', 'wo', 'ueber', 'über', 'antworte', 'antwort', 'satz', 'saetzen', 'sätzen', 'kurz', 'bitte', 'mir', 'mich', 'mein', 'meine', 'projekt', 'weißt', 'weisst', 'gibt', 'sind', 'haben', 'kann', 'soll', 'sollen', 'noch', 'auch', 'zum', 'zur', 'den', 'dem', 'des', 'bei', 'aus', 'als', 'oder', 'nicht']);
export async function ollamaAsk(req, res) {
  let body = ''; for await (const ch of req) body += ch;
  const { model, q, history, voice } = JSON.parse(body || '{}');
  const question = String(q || '').slice(0, 600);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    // 1) Wissenszugriff: markante Woerter der Frage im Vault suchen (GROSSBUCHSTABEN-Begriffe zuerst)
    const words = [...new Set(question.replace(/[^\wäöüÄÖÜß-]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase())))]
      .sort((a, b) => {
        const score = (w) => (w === w.toUpperCase() && /[A-ZÄÖÜ]/.test(w) ? 100 : 0) + (/^[A-ZÄÖÜ]/.test(w) ? 10 : 0) + w.length;
        return score(b) - score(a);
      }).slice(0, 4);
    const seen = new Map();
    for (const w of words) {
      for (const h of await searchVault(w)) {
        if (!seen.has(h.file)) seen.set(h.file, h);
        if (seen.size >= 6) break;
      }
      if (seen.size >= 6) break;
    }
    const sources = [...seen.values()];
    send('sources', sources.map((s) => ({ file: s.file, text: s.text })));
    const context = sources.map((s) => `[${s.file}]\n${read(path.join(CFG.vaultPath, s.file)).slice(0, 1100)}`).join('\n\n').slice(0, 6000);
    // 2) Ollama-Chat-Stream (Persona aus der Config, Sprech-Modus, Verlauf)
    const system = `${CFG.persona || 'Du bist ein lokaler KI-Assistent.'} Antworte in der Sprache der Frage, kurz und konkret.${voice ? ` Deine Antwort wird LAUT VORGELESEN: sprich natuerlich in kurzen fliessenden Saetzen, keine Listen, keine Aufzaehlungszeichen, kein Markdown, keine Emojis, keine Dateipfade — maximal 4 Saetze, ausser ${CFG.userName} bittet um mehr.` : ''}${context ? `\n\nKontext aus der Wissensbasis:\n---\n${context}\n---` : ''}`;
    const messages = [
      { role: 'system', content: system },
      ...(Array.isArray(history) ? history.slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 1500) })) : []),
      { role: 'user', content: question },
    ];
    const or = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', body: JSON.stringify({ model: model || CFG.defaultModel, messages, stream: true }) });
    if (!or.ok || !or.body) { send('error', { msg: 'Ollama nicht erreichbar (' + OLLAMA + ')' }); return res.end(); }
    let buf = '', answer = '';
    for await (const chunk of or.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.message?.content) { answer += j.message.content; send('token', { t: j.message.content }); }
          if (j.done) send('done', { total: j.eval_count });
        } catch {}
      }
    }
    if (answer) memoryAppend(question, answer.slice(0, 2000));
  } catch (e) { send('error', { msg: String(e).slice(0, 200) }); }
  res.end();
}
