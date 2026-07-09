// Jarvis OS — Werkzeuge des KI-Kerns: der Kern kann HANDELN, nicht nur antworten.
// Konfiguration in config.assistant (personal/config.json); ohne Konfiguration
// stehen nur die Vault-Werkzeuge bereit. Jede Ausfuehrung wird in
// memoryDir/actions.log protokolliert.
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from '../core/config.mjs';
import { read } from './vault.mjs';
import { actions } from './actions.mjs';

const A = CFG.assistant || {};
const appToken = () => {
  if (!A.appApi?.envFile) return null;
  return read(A.appApi.envFile).match(/APP_TOKEN=([^\s"']+)/)?.[1] || null;
};

async function appGet(p) {
  const token = appToken();
  if (!A.appApi?.url || !token) return { error: 'App-API nicht konfiguriert' };
  const r = await fetch(`${A.appApi.url}${p}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return r.json();
}

// ---------- Google Calendar (Refresh-Token aus Datei) ----------
async function googleAccessToken() {
  const f = A.googleTokenFile;
  if (!f || !fs.existsSync(f)) return null;
  const { refresh_token, client_id, client_secret } = JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
  });
  if (!r.ok) return null;
  return (await r.json()).access_token;
}

async function calendarInsert({ titel, datum, uhrzeit, dauer_minuten, ort }) {
  const at = await googleAccessToken();
  if (!at) return { error: 'Google-Kalender nicht konfiguriert' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(datum)) || !/^\d{2}:\d{2}$/.test(String(uhrzeit)))
    return { error: 'datum als YYYY-MM-DD und uhrzeit als HH:MM angeben' };
  // Ende lokal rechnen (Wandzeit + Dauer — keine UTC-Verschiebung)
  const [h, m] = String(uhrzeit).split(':').map(Number);
  const endMin = h * 60 + m + (Number(dauer_minuten) || 60);
  const endzeit = `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
  const body = {
    summary: String(titel).slice(0, 200),
    location: ort ? String(ort).slice(0, 200) : undefined,
    start: { dateTime: `${datum}T${uhrzeit}:00`, timeZone: 'Europe/Berlin' },
    end: { dateTime: `${datum}T${endzeit}:00`, timeZone: 'Europe/Berlin' },
  };
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(A.calendarId || 'primary')}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return r.ok ? { ok: true, termin: j.summary, start: j.start?.dateTime, link: j.htmlLink } : { error: j.error?.message || `HTTP ${r.status}` };
}

// ---------- Werkzeug-Definitionen (Ollama-Tools-Schema) ----------
// ---------- Web-Zugriff (bei Bedarf): DuckDuckGo-Suche + Seiten-Lesen, 0 €, kein Key ----------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const stripTags = (h) => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function webSearch(a) {
  const q = String(a?.frage || a?.query || '').slice(0, 200);
  if (q.length < 2) return { error: 'Suchbegriff fehlt' };
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) return { error: `Suche fehlgeschlagen (HTTP ${r.status})` };
  const html = await r.text();
  const results = [];
  for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g)) {
    let url = m[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:/.test(url) || /duckduckgo\.com/.test(url)) continue;  // Werbe-/interne Links raus
    results.push({ titel: stripTags(m[2]).slice(0, 120), url, auszug: stripTags(m[3] || '').slice(0, 240) });
    if (results.length >= 5) break;
  }
  return results.length ? { ergebnisse: results } : { error: 'Keine Treffer' };
}

async function webRead(a) {
  const url = String(a?.url || '');
  if (!/^https?:\/\//.test(url)) return { error: 'Ungueltige URL' };
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const type = r.headers.get('content-type') || '';
  if (!type.includes('html') && !type.includes('text')) return { error: 'Kein Text-Inhalt (' + type.split(';')[0] + ')' };
  const text = stripTags(await r.text());
  return { url, text: text.slice(0, 4000) };
}

const defs = [
  { name: 'tagesplan_heute', description: 'Liest das heutige Briefing: Top-Prioritaeten, Termine, offene Punkte. Nutze dies fuer Fragen wie "Was steht heute an?"', params: {}, run: () => appGet('/app/heute'), needs: 'app' },
  { name: 'termine', description: 'Listet Kalender-Termine. range: "heute", "woche" oder "monat".', params: { range: { type: 'string', description: 'heute | woche | monat' } }, run: (a) => appGet(`/app/termine?range=${encodeURIComponent(a?.range || 'woche')}`), needs: 'app' },
  { name: 'leads_offen', description: 'Listet neue/offene Kundenanfragen (Leads) von der Website.', params: {}, run: () => appGet('/app/leads'), needs: 'app' },
  { name: 'kunden_suchen', description: 'Sucht Kunden nach Name.', params: { name: { type: 'string', description: 'Suchbegriff (Teil des Namens)' } }, run: (a) => appGet(`/app/kunden?q=${encodeURIComponent(a?.name || '')}`), needs: 'app' },
  { name: 'offene_briefe', description: 'Listet offene Briefe/Post mit Deadlines.', params: {}, run: () => appGet('/app/briefe'), needs: 'app' },
  { name: 'open_loops', description: 'Listet offene Loops (wartende Aufgaben/Entscheidungen).', params: {}, run: () => appGet('/app/loops'), needs: 'app' },
  { name: 'termin_anlegen', description: 'Legt einen Termin im Google-Kalender an. Vorher beim Nutzer bestaetigen, wenn Datum/Zeit nicht eindeutig genannt wurden.', params: { titel: { type: 'string' }, datum: { type: 'string', description: 'YYYY-MM-DD' }, uhrzeit: { type: 'string', description: 'HH:MM (24h)' }, dauer_minuten: { type: 'number', description: 'Standard 60' }, ort: { type: 'string' } }, run: calendarInsert, needs: 'google' },
  { name: 'inbox_merken', description: 'Speichert eine Notiz/Idee in der Inbox des Nutzers.', params: { text: { type: 'string' } }, run: (a) => actions.capture({ text: a?.text }), needs: null },
  { name: 'telegram_push', description: 'Schickt dem Nutzer eine Nachricht aufs Handy (Telegram).', params: { nachricht: { type: 'string' } }, run: (a) => actions.push({ message: a?.nachricht }), needs: 'telegram' },
  { name: 'web_suche', description: 'Sucht im Internet (DuckDuckGo). NUR nutzen, wenn die Frage aktuelle oder externe Infos braucht, die nicht in der Wissensbasis stehen (z. B. aktuelle Preise, Nachrichten, Oeffnungszeiten, Gesetzesaenderungen). Liefert Titel, URL und Auszug der Top-Treffer.', params: { frage: { type: 'string', description: 'Suchanfrage' } }, run: webSearch, needs: null },
  { name: 'webseite_lesen', description: 'Laedt eine Webseite und liefert ihren Textinhalt (max. 4000 Zeichen). Nutze dies nach web_suche, um einen Treffer im Detail zu lesen.', params: { url: { type: 'string', description: 'Vollstaendige URL (https://...)' } }, run: webRead, needs: null },
];

function available() {
  return defs.filter((d) =>
    d.needs === null
    || (d.needs === 'app' && A.appApi?.url)
    || (d.needs === 'google' && A.googleTokenFile)
    || (d.needs === 'telegram' && CFG.telegram?.notifyUrl));
}

export function toolSchemas() {
  return available().map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: { type: 'object', properties: d.params, required: Object.keys(d.params).filter((k) => !['dauer_minuten', 'ort', 'range'].includes(k)) },
    },
  }));
}

export async function runTool(name, args) {
  const d = available().find((x) => x.name === name);
  if (!d) return { error: `Unbekanntes Werkzeug: ${name}` };
  let parsed = args;
  if (typeof args === 'string') { try { parsed = JSON.parse(args); } catch { parsed = {}; } }
  let result;
  try { result = await d.run(parsed || {}); } catch (e) { result = { error: String(e).slice(0, 200) }; }
  try {
    fs.appendFileSync(path.join(CFG.memoryDir, 'actions.log'),
      JSON.stringify({ ts: new Date().toISOString(), tool: name, args: parsed, ok: !result?.error }) + '\n');
  } catch {}
  return result;
}
