// Jarvis OS — KI-Kern: Ollama (lokal) + Vault-Wissenszugriff + Memory-Engine.
// Memory: jede Gespraechsrunde wird persistent in memoryDir/history.jsonl gesichert
// und beim naechsten Start als Kontext wieder angeboten (/api/memory/recent).
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from '../core/config.mjs';
import { read, searchVault } from './vault.mjs';
import { ragSearch } from './rag.mjs';
import { toolSchemas, runTool } from './tools.mjs';

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
    // Embedding-Modelle (nomic, bge, minilm ...) koennen nicht chatten -> nicht ins Dropdown
    const chatModels = (tags.models || []).filter((m) => !/embed|bge|minilm/i.test(m.name));
    chatModels.sort((a, b) => (a.name === CFG.defaultModel ? -1 : b.name === CFG.defaultModel ? 1 : 0));
    return { ok: true, models: chatModels.map((m) => ({ name: m.name, size: Math.round(m.size / 1e9 * 10) / 10 })), running: (ps.models || []).map((m) => m.name) };
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
    // 1) Wissenszugriff — hybrid: semantisch (RAG-Embeddings) zuerst, Stichwort-grep ergaenzt.
    //    Faellt der RAG-Index/das Embedding-Modell aus, traegt grep allein (wie frueher).
    let ragHits = [];
    try { ragHits = await ragSearch(question, 6); } catch {}
    const words = [...new Set(question.replace(/[^\wäöüÄÖÜß-]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase())))]
      .sort((a, b) => {
        const score = (w) => (w === w.toUpperCase() && /[A-ZÄÖÜ]/.test(w) ? 100 : 0) + (/^[A-ZÄÖÜ]/.test(w) ? 10 : 0) + w.length;
        return score(b) - score(a);
      }).slice(0, 4);
    const seen = new Map();
    for (const h of ragHits) if (!seen.has(h.file)) seen.set(h.file, { file: h.file, text: h.text.slice(0, 160) });
    for (const w of words) {
      if (seen.size >= 8) break;
      for (const h of await searchVault(w)) {
        if (!seen.has(h.file)) seen.set(h.file, h);
        if (seen.size >= 8) break;
      }
    }
    const sources = [...seen.values()].slice(0, 8);
    send('sources', sources.map((s) => ({ file: s.file, text: s.text })));
    // Kontext: RAG liefert die TREFFENDEN Abschnitte, grep-only-Dateien den Dateianfang
    const ragFiles = new Set(ragHits.map((h) => h.file));
    const parts = ragHits.map((h) => `[${h.file}${h.heading ? ' › ' + h.heading : ''}]\n${h.text}`);
    for (const s of sources) {
      if (ragFiles.has(s.file)) continue;
      parts.push(`[${s.file}]\n${read(path.join(CFG.vaultPath, s.file)).slice(0, 900)}`);
      if (parts.length >= 8) break;
    }
    const context = parts.join('\n\n').slice(0, 5200);
    // 2) Ollama-Chat mit WERKZEUGEN (der Kern kann handeln) + Verlauf + Persona
    const tools = toolSchemas();
    const heute = new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' });
    const system = `${CFG.persona || 'Du bist ein lokaler KI-Assistent.'} Heute ist ${heute}. Antworte in der Sprache der Frage, kurz und konkret.`
      + (tools.length ? ` Du kannst mit deinen Werkzeugen echte Aktionen ausfuehren (Kalender, Anfragen, Notizen, Push). Nutze sie, wenn die Frage aktuelle Daten braucht oder eine Aktion verlangt. Bei anlegenden/sendenden Aktionen: wenn der Auftrag eindeutig ist, fuehre direkt aus und bestaetige kurz; bei fehlenden Angaben (z.B. Datum) frag nach statt zu raten.` : '')
      + (voice ? ` Deine Antwort wird LAUT VORGELESEN: sprich natuerlich in kurzen fliessenden Saetzen, keine Listen, keine Aufzaehlungszeichen, kein Markdown, keine Emojis, keine Dateipfade — maximal 4 Saetze, ausser ${CFG.userName} bittet um mehr.` : '')
      + (context ? `\n\nKontext aus der Wissensbasis:\n---\n${context}\n---` : '');
    const messages = [
      { role: 'system', content: system },
      ...(Array.isArray(history) ? history.slice(-6).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 1500) })) : []),
      { role: 'user', content: question },
    ];
    let answer = '', evalCount = 0;
    for (let round = 0; round < 5; round++) {
      const or = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({ model: model || CFG.defaultModel, messages, tools: tools.length ? tools : undefined, stream: false, keep_alive: '30m' }),
      });
      if (!or.ok) { send('error', { msg: 'Ollama nicht erreichbar (' + OLLAMA + ')' }); return res.end(); }
      const j = await or.json();
      evalCount += j.eval_count || 0;
      const msg = j.message || {};
      if (msg.tool_calls?.length) {
        messages.push(msg);
        for (const tc of msg.tool_calls.slice(0, 4)) {
          const name = tc.function?.name;
          send('tool', { name, args: tc.function?.arguments });
          const result = await runTool(name, tc.function?.arguments);
          send('tool_done', { name, ok: !result?.error });
          messages.push({ role: 'tool', content: JSON.stringify(result).slice(0, 5000) });
        }
        continue; // naechste Runde: Kern verarbeitet die Werkzeug-Ergebnisse
      }
      answer = msg.content || '';
      break;
    }
    if (answer) send('token', { t: answer });
    send('done', { total: evalCount });
    if (answer) memoryAppend(question, answer.slice(0, 2000));
  } catch (e) { send('error', { msg: String(e).slice(0, 200) }); }
  res.end();
}
