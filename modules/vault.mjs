// Jarvis OS — Vault-Modul: der Markdown-Vault IST die Datenbank.
// Parser fuer Prioritaeten, Loops, Briefe, Skills, Projekte + Wissensgraph + Volltext-Suche.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { CFG } from '../core/config.mjs';

const VAULT = CFG.vaultPath;
export const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
export const sh = (cmd, args, opts = {}) => new Promise((res) => {
  execFile(cmd, args, { timeout: opts.timeout || 30000, cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => res({ ok: !err, code: err?.code ?? 0, out: (stdout || '') + (stderr ? '\n' + stderr : '') }));
});
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso + 'T00:00:00')) / 86400000);

export function parsePriorities() {
  const text = read(path.join(VAULT, '03-strategy/current-priorities.md'));
  const items = [];
  for (const sec of ['### Hot', '### Business (Top 3)']) {
    const i = text.indexOf(sec);
    if (i === -1) continue;
    const block = text.slice(i, text.indexOf('\n### ', i + 5) === -1 ? undefined : text.indexOf('\n### ', i + 5));
    for (const m of block.matchAll(/^- \[ \] (.+)$/gm)) {
      items.push(m[1].replace(/\*\*/g, '').replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').slice(0, 140));
    }
  }
  return items.slice(0, 6);
}

export function parseLoops() {
  const text = read(path.join(VAULT, '03-strategy/open-loops.md'));
  const i = text.indexOf('## Wartend auf');
  const block = i === -1 ? '' : text.slice(i, text.indexOf('\n## ', i + 5) === -1 ? undefined : text.indexOf('\n## ', i + 5));
  const rows = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('|') || line.includes('---') || /\|\s*Loop\s*\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    const dm = line.match(/\| (\d{4}-\d{2}-\d{2}) \|/);
    if (dm && cells[1]) rows.push({ text: cells[1].replace(/\*\*/g, '').slice(0, 110), since: dm[1], days: daysSince(dm[1]) });
  }
  rows.sort((a, b) => b.days - a.days);
  return { total: rows.length, old14: rows.filter((r) => r.days > 14).length, oldest: rows.slice(0, 6) };
}

export function parseBriefe() {
  const text = read(path.join(VAULT, '07-intelligence/briefe/README.md'));
  const i = text.indexOf('## Offen');
  const block = i === -1 ? '' : text.slice(i, text.indexOf('## Erledigt'));
  const rows = block.split('\n').filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('Absender') && !l.includes('_(keine'));
  return { open: rows.length };
}

export function parseSkills() {
  const out = [];
  for (const [dir, source] of [[path.join(VAULT, '.claude/skills'), 'vault'], [path.join(os.homedir(), '.claude/skills'), 'global']]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const fm = read(path.join(dir, n, 'SKILL.md')).slice(0, 800);
      const desc = fm.match(/^description:\s*(.+)$/m)?.[1] || '';
      if (fm) out.push({ name: n, source, description: desc.split('Trigger')[0].slice(0, 160) });
    }
  }
  return out;
}

export function parseProjects() {
  const dir = path.join(VAULT, '04-projects');
  const out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const rp = path.join(dir, n, 'README.md');
    if (!fs.existsSync(rp)) continue;
    const text = read(rp);
    out.push({
      name: n,
      title: text.match(/^# (.+)$/m)?.[1]?.slice(0, 60) || n,
      status: text.match(/^> Status:\s*(.+)$/m)?.[1]?.slice(0, 90) || null,
      updated: (() => { try { return fs.statSync(rp).mtime.toISOString().slice(0, 10); } catch { return null; } })(),
    });
  }
  return out.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

export function parsePrompts() {
  const dir = path.join(VAULT, '08-resources/prompts');
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch {}
  return files.map((f) => {
    const text = read(path.join(dir, f));
    return { name: f, title: text.match(/^# (.+)$/m)?.[1] || f, content: text.slice(0, 12000) };
  });
}

// ---------- Wissensgraph (Wikilinks) ----------
const GRAPH_IGNORE = new RegExp(CFG.graphIgnore || 'node_modules|\\/\\.[^/]+\\/');
export function graph() {
  const files = [];
  (function walk(dir) {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (GRAPH_IGNORE.test(p + (e.isDirectory() ? '/' : ''))) continue;
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p); }
      else if (e.name.endsWith('.md')) files.push(p);
    }
  })(VAULT);
  // READMEs nach Elternordner benennen — sonst kollabieren alle Projekt-READMEs zu EINEM Knoten
  const nodeId = (f) => {
    const base = path.basename(f, '.md').toLowerCase();
    return base === 'readme' ? `${path.basename(path.dirname(f)).toLowerCase()}/readme` : base;
  };
  const nodeName = (f) => {
    const base = path.basename(f, '.md');
    return base.toLowerCase() === 'readme' ? path.basename(path.dirname(f)) : base;
  };
  const linkTarget = (raw) => {
    const parts = raw.trim().toLowerCase().split('/').filter(Boolean);
    const last = parts.pop();
    return last === 'readme' && parts.length ? `${parts.pop()}/readme` : last;
  };
  const nodes = new Map();
  for (const f of files) {
    const id = nodeId(f);
    if (!nodes.has(id)) nodes.set(id, { id, name: nodeName(f), path: f.replace(VAULT + '/', ''), folder: f.replace(VAULT + '/', '').split('/')[0], out: [] });
  }
  for (const f of files) {
    const id = nodeId(f);
    for (const m of read(f).matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g)) {
      const target = linkTarget(m[1]);
      if (nodes.has(target) && target !== id) nodes.get(id).out.push(target);
    }
  }
  const deg = {};
  for (const n of nodes.values()) for (const t of n.out) { deg[n.id] = (deg[n.id] || 0) + 1; deg[t] = (deg[t] || 0) + 1; }
  const keep = [...nodes.values()].filter((n) => deg[n.id]);
  const keepSet = new Set(keep.map((n) => n.id));
  const edges = [];
  for (const n of keep) for (const t of new Set(n.out)) if (keepSet.has(t)) edges.push([n.id, t]);
  return { vault: VAULT, nodes: keep.map((n) => ({ id: n.id, name: n.name, path: n.path, folder: n.folder, deg: deg[n.id] })), edges };
}

// ---------- Volltext-Suche ----------
export async function searchVault(q) {
  q = String(q || '').slice(0, 80);
  if (q.length < 2) return [];
  const r = await sh('grep', ['-rinF', '--include=*.md', '--exclude-dir=node_modules', '-m', '2', q, '.'], { cwd: VAULT, timeout: 10000 });
  const hits = [];
  for (const line of r.out.split('\n')) {
    const m = line.match(/^\.\/([^:]+):(\d+):(.*)$/);
    if (!m || GRAPH_IGNORE.test(m[1])) continue;
    hits.push({ file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) });
    if (hits.length >= 40) break;
  }
  return hits;
}
