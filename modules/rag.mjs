// Jarvis OS — RAG-Modul: semantische Vault-Suche ueber lokale Embeddings (Ollama).
// Zero-dep: Index = JSON mit Base64-Float32-Vektoren, Brute-Force-Cosine (wenige
// tausend Chunks -> Millisekunden). Index liegt im PRIVATEN Layer (memoryDir).
//
// Indexieren:  node modules/rag.mjs          (inkrementell, nur geaenderte Dateien)
// Nutzung:     ragSearch(frage, k)           (Fallback [] wenn Index/Modell fehlt)
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from '../core/config.mjs';

const INDEX_FILE = path.join(CFG.memoryDir, 'rag-index.json');
const EMBED_MODEL = CFG.embedModel || 'nomic-embed-text';
const IGNORE = new RegExp(CFG.graphIgnore || 'node_modules|\\/\\.[^/]+\\/');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function listMd() {
  const out = [];
  (function walk(dir) {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (IGNORE.test(p + (e.isDirectory() ? '/' : ''))) continue;
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p); }
      else if (e.name.endsWith('.md')) {
        try { out.push({ rel: p.replace(CFG.vaultPath + '/', ''), mtime: fs.statSync(p).mtimeMs }); } catch {}
      }
    }
  })(CFG.vaultPath);
  return out;
}

// Datei -> Chunks: an Ueberschriften trennen, lange Abschnitte an Absaetzen teilen (~900 Zeichen)
function chunkFile(rel) {
  let text = read(path.join(CFG.vaultPath, rel));
  text = text.replace(/^---\n[\s\S]*?\n---\n/, '');           // Frontmatter weg
  const chunks = [];
  const sections = text.split(/\n(?=#{1,3} )/);
  for (const sec of sections) {
    const heading = sec.match(/^#{1,3} (.+)$/m)?.[1]?.slice(0, 80) || '';
    let buf = '';
    for (const para of sec.split(/\n\n+/)) {
      if ((buf + '\n\n' + para).length > 900 && buf.trim().length >= 60) {
        chunks.push({ h: heading, t: buf.trim().slice(0, 1100) });
        buf = para;
      } else buf += (buf ? '\n\n' : '') + para;
    }
    if (buf.trim().length >= 60) chunks.push({ h: heading, t: buf.trim().slice(0, 1100) });
    if (chunks.length >= 60) break;                            // Datei-Cap
  }
  return chunks;
}

async function embed(texts) {
  const r = await fetch(`${CFG.ollamaUrl}/api/embed`, {
    method: 'POST',
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!r.ok) throw new Error('embed HTTP ' + r.status);
  const j = await r.json();
  return j.embeddings || [];
}

const b64 = (arr) => Buffer.from(new Float32Array(arr).buffer).toString('base64');
const unb64 = (s) => new Float32Array(Buffer.from(s, 'base64').buffer, 0, Buffer.from(s, 'base64').length / 4);

export async function ragIndex(log = () => {}) {
  const files = listMd();
  let old = { files: {}, chunks: [] };
  try { old = JSON.parse(read(INDEX_FILE) || '{}'); } catch {}
  const oldByFile = new Map();
  for (const c of old.chunks || []) {
    if (!oldByFile.has(c.f)) oldByFile.set(c.f, []);
    oldByFile.get(c.f).push(c);
  }
  const newFiles = {}, chunks = [];
  let embedded = 0;
  for (const { rel, mtime } of files) {
    newFiles[rel] = mtime;
    if (old.files?.[rel] === mtime && oldByFile.has(rel)) {   // unveraendert -> uebernehmen
      chunks.push(...oldByFile.get(rel));
      continue;
    }
    const cs = chunkFile(rel);
    for (let i = 0; i < cs.length; i += 24) {                 // Batch-Embedding
      const batch = cs.slice(i, i + 24);
      // nomic-embed braucht Task-Praefixe (search_document/search_query) fuer gute Retrieval-Qualitaet
      const vecs = await embed(batch.map((c) => 'search_document: ' + (c.h ? c.h + '\n' + c.t : c.t)));
      batch.forEach((c, k) => { if (vecs[k]) chunks.push({ f: rel, h: c.h, t: c.t, v: b64(vecs[k]) }); });
      embedded += batch.length;
    }
    log(`${rel}: ${cs.length} Chunks`);
  }
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify({ model: EMBED_MODEL, builtAt: new Date().toISOString(), files: newFiles, chunks }));
  CACHE = null;
  return { files: files.length, chunks: chunks.length, embedded };
}

let CACHE = null, CACHE_MTIME = 0;
function loadIndex() {
  let st; try { st = fs.statSync(INDEX_FILE); } catch { return null; }
  if (CACHE && st.mtimeMs === CACHE_MTIME) return CACHE;
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    CACHE = { ...raw, chunks: raw.chunks.map((c) => ({ ...c, vec: unb64(c.v) })) };
    CACHE_MTIME = st.mtimeMs;
    return CACHE;
  } catch { return null; }
}

export function ragStatus() {
  const idx = loadIndex();
  return idx ? { ok: true, chunks: idx.chunks.length, files: Object.keys(idx.files).length, builtAt: idx.builtAt } : { ok: false };
}

export async function ragSearch(q, k = 6) {
  const idx = loadIndex();
  if (!idx || !idx.chunks.length) return [];
  let qv;
  try { [qv] = await embed(['search_query: ' + String(q).slice(0, 500)]); } catch { return []; }
  if (!qv) return [];
  const qf = new Float32Array(qv);
  let qn = 0; for (let i = 0; i < qf.length; i++) qn += qf[i] * qf[i];
  qn = Math.sqrt(qn) || 1;
  const scored = [];
  for (const c of idx.chunks) {
    const v = c.vec; if (v.length !== qf.length) continue;
    let dot = 0, n = 0;
    for (let i = 0; i < v.length; i++) { dot += v[i] * qf[i]; n += v[i] * v[i]; }
    const score = dot / (Math.sqrt(n) * qn || 1);
    if (score >= 0.45) scored.push({ file: c.f, heading: c.h, text: c.t, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// CLI: node modules/rag.mjs  -> Index (neu) aufbauen
if (process.argv[1] && process.argv[1].endsWith('rag.mjs')) {
  ragIndex((m) => console.log(m)).then((r) => {
    console.log(`Index: ${r.files} Dateien, ${r.chunks} Chunks (${r.embedded} neu eingebettet) -> ${INDEX_FILE}`);
  }).catch((e) => { console.error('RAG-Index fehlgeschlagen:', e.message); process.exit(1); });
}
