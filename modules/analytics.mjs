// Jarvis OS — Analytics: parst Claude-Code-Session-Transcripts (JSONL) + Git-Commits.
// Inkrementeller Cache — Erst-Parse langsam, danach nur geaenderte Dateien.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { CFG } from '../core/config.mjs';
import { sh } from './vault.mjs';

const TRANS_DIR = CFG.transcriptsDir || '';
const CACHE_FILE = path.join(os.homedir(), '.cache/jarvis-os-analytics.json');

async function parseTranscript(file) {
  const days = {};
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const day = (d.timestamp || '').slice(0, 10);
    if (!day) continue;
    const rec = (days[day] ||= { out: 0, inp: 0, cache: 0, tools: 0, errs: 0, user: 0 });
    if (d.type === 'assistant') {
      const u = d.message?.usage;
      if (u) { rec.out += u.output_tokens || 0; rec.inp += u.input_tokens || 0; rec.cache += u.cache_read_input_tokens || 0; }
      if (Array.isArray(d.message?.content)) for (const p of d.message.content) if (p?.type === 'tool_use') rec.tools++;
    } else if (d.type === 'user') {
      const c = d.message?.content;
      if (typeof c === 'string') rec.user++;
      else if (Array.isArray(c)) for (const p of c) {
        if (p?.type === 'tool_result' && p.is_error) rec.errs++;
        else if (p?.type === 'text' && !String(p.text || '').startsWith('<')) rec.user++;
      }
    }
  }
  return days;
}

export async function analytics() {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
  let files = []; try { files = fs.readdirSync(TRANS_DIR).filter((f) => f.endsWith('.jsonl')); } catch {}
  for (const f of files) {
    const st = fs.statSync(path.join(TRANS_DIR, f));
    if (cache[f]?.size === st.size) continue;
    cache[f] = { size: st.size, days: await parseTranscript(path.join(TRANS_DIR, f)) };
  }
  try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch {}
  const agg = {};
  for (const ent of Object.values(cache)) for (const [day, r] of Object.entries(ent.days || {})) {
    const a = (agg[day] ||= { out: 0, inp: 0, cache: 0, tools: 0, errs: 0, user: 0, sessions: 0 });
    for (const k of ['out', 'inp', 'cache', 'tools', 'errs', 'user']) a[k] += r[k];
    a.sessions++;
  }
  const commits = {};
  for (const repo of CFG.workRepos || [CFG.vaultPath]) {
    const r = await sh('git', ['log', '--since=30 days ago', '--format=%cs'], { cwd: repo });
    for (const d of r.out.trim().split('\n').filter((x) => /^\d{4}/.test(x))) commits[d] = (commits[d] || 0) + 1;
  }
  const days = [...Array(30)].map((_, i) => new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10));
  const totals = Object.values(agg).reduce((t, a) => { for (const k in a) t[k] = (t[k] || 0) + a[k]; return t; }, {});
  return { days: days.map((d) => ({ date: d, ...(agg[d] || { out: 0, inp: 0, cache: 0, tools: 0, errs: 0, user: 0, sessions: 0 }), commits: commits[d] || 0 })), totals };
}
