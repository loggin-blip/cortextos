#!/usr/bin/env node
/**
 * agent-activity-backfill.mjs — ENGANGS: les en agents EKTE Claude-transcript,
 * kjør de siste verktøy-kallene gjennom SAMME humanizer som hooken, og skriv dem
 * til `massivlust_agent_activity`. Gir ekte aktivitet i pulsen uten å restarte
 * agenten — og validerer humaniseringen på virkelige kall.
 *
 * Bruk:  node agent-activity-backfill.mjs <agent> [maxRader=60]
 * Kjøres på Studio. Creds fra ~/cortextos/agent-engine/.env.local.
 */

import fs from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

const AGENT = process.argv[2] || 'kjoreplan';
const MAX = Math.max(1, Number(process.argv[3]) || 60);
const ENGINE_ENV = join(homedir(), 'cortextos', 'agent-engine', '.env.local');

function resolveProjectDir(agent) {
  const base = join(homedir(), '.claude', 'projects');
  const candidates = [
    `-Users-max-cortextos-orgs-massivlust-agents-${agent}`,
    `-Users-max-cortextos-orgs-westside-hq-agents-${agent}`,
  ];
  for (const c of candidates) { const p = join(base, c); if (fs.existsSync(p)) return p; }
  try {
    const hit = fs.readdirSync(base).find((dd) => dd.endsWith(`agents-${agent}`));
    if (hit) return join(base, hit);
  } catch {}
  return join(base, candidates[0]);
}
const PROJECT_DIR = resolveProjectDir(AGENT);
if (!fs.existsSync(PROJECT_DIR)) { console.error(`Ingen transcript-mappe for ${AGENT}`); process.exit(0); }

function loadEnv(path) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch {}
  return out;
}
function hashId(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); }

// ── seksjon + humanizer (speil av hooken) ────────────────────────────────────
const CRON_LABELS = {
  'drive-watch': 'Sjekker Drive for nye filer', 'heartbeat': 'Heartbeat-sjekk',
  'tx-monitor': 'T-X-overvåking', 't-x-monitor': 'T-X-overvåking',
  'ukerollup': 'Ukentlig oppsummering', 'uke-rollup': 'Ukentlig oppsummering',
  'morgenrapport': 'Morgenrapport', 'kveldsrapport': 'Kveldsrapport',
};
const cronLabel = (n) => CRON_LABELS[n.toLowerCase()] || n.replace(/[-_]+/g, ' ');
function deriveRun(text) {
  const cron = text.match(/^\[CRON FIRED\s+([^\]]+)\]\s*([a-z0-9_.-]+)\s*:\s*([\s\S]*)$/i);
  if (cron) {
    const name = cron[2].trim();
    return { run_id: `${name}:${cron[1].trim()}`, run_kind: /heartbeat/i.test(name) ? 'heartbeat' : 'cron', run_label: cronLabel(name) };
  }
  if (/^You are starting a new session/i.test(text)) return { run_id: 'session-start', run_kind: 'oppstart', run_label: 'Starter ny økt' };
  if (/^SESSION CONTINUATION/i.test(text)) return { run_id: 'continuation', run_kind: 'oppstart', run_label: 'Tilbake online' };
  const clean = text.replace(/\s+/g, ' ').trim();
  return { run_id: `task:${hashId(clean.slice(0, 200))}`, run_kind: 'oppgave', run_label: clean.slice(0, 72) + (clean.length > 72 ? '…' : '') };
}
function fileWord(p) {
  const b = basename(String(p || '')) || 'en fil';
  if (/\.ifc$/i.test(b)) return { verb: 'åpnet', noun: `IFC-modellen ${b}` };
  if (/\.pdf$/i.test(b)) return { verb: 'leste', noun: `PDF-en ${b}` };
  if (/\.(xlsx?|csv)$/i.test(b)) return { verb: 'åpnet', noun: `regnearket ${b}` };
  return { verb: 'leste', noun: b };
}
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
function humanTerm(q) {
  if (!q || typeof q !== 'string') return null;
  const s = q.trim();
  if (!s || s.length > 50) return null;
  if (/[=<>'"]|sharedwithme|modifiedtime|parentid|mimetype|trashed|\bcontains\b|\band\b|\bor\b/i.test(s)) return null;
  return s;
}
function bashLabel(d) {
  if (!d) return 'kjørte en kommando';
  const s = d.toLowerCase();
  if (/inbox/.test(s)) return 'sjekket innboksen';
  if (/heartbeat/.test(s) && /memory/.test(s)) return 'oppdaterte hukommelse og puls';
  if (/memory/.test(s)) return 'oppdaterte hukommelsen';
  if (/heartbeat/.test(s)) return 'oppdaterte pulsen';
  if (/draft/.test(s)) return 'ordnet utkast';
  if (/\bt-?x\b/.test(s) || /tx status/.test(s)) return 'beregnet T-X-status';
  if (/task/.test(s) && /(create|start)/.test(s)) return 'opprettet en oppgave';
  return lowerFirst(d);
}
const AGENT_SHORT = {
  'kaptein-massivlust': 'Kaptein', 'kjoreplan': 'Kjøreplan', 'ks-avvik': 'KS & Avvik',
  'massivlust-team': 'Jensen', 'ml-prosjektleder': 'Prosjektleder',
  'eivind-massivlust': 'Eivind', 'vegard-massivlust': 'Vegard', 'martin-thorvaldsen-venedik': 'Martin',
};
function agentShort(id) { return AGENT_SHORT[id] || String(id).replace(/-massivlust$/, '').replace(/-/g, ' '); }
function gist(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t || /\$\(|`|^[/~]|^\$\{/.test(t)) return '';
  return t.length > 56 ? t.slice(0, 56) + '…' : t;
}
function detailOf(tool, input) {
  if (!input) return null;
  if (input.command) return String(input.command).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (input.file_path) return String(input.file_path);
  if (input.query) return String(input.query).slice(0, 300);
  if (input.pattern) return String(input.pattern);
  if (input.url) return String(input.url);
  if (input.description) return String(input.description);
  return null;
}
function busHuman(cmd) {
  if (/cortextos\s+bus\s+log-event/.test(cmd)) return null;
  const sm = cmd.match(/bus\s+send-message\s+([a-z0-9_.-]+)\s+\S+\s+(['"])([\s\S]*?)\2/i);
  if (sm) { const g = gist(sm[3]); return { kind: 'message', text: g ? `meldte til ${agentShort(sm[1])}: «${g}»` : `meldte til ${agentShort(sm[1])}` }; }
  const tg = cmd.match(/bus\s+send-telegram\s+\S+\s+(['"])([\s\S]*?)\1/i);
  if (tg) { const g = gist(tg[2]); return { kind: 'telegram', text: g ? `meldte på Telegram: «${g}»` : 'meldte på Telegram' }; }
  if (/bus\s+send-message|bridge/.test(cmd)) return { kind: 'message', text: 'sendte en melding til en annen agent' };
  if (/bus\s+(update-heartbeat|self-restart)/.test(cmd)) return { kind: 'think', text: 'oppdaterte pulsen' };
  return undefined;
}
function mcpHuman(name, input) {
  const l = name.toLowerCase();
  const rawQ = input && (input.query || input.q || input.search || input.keyword);
  const term = humanTerm(rawQ);
  if (l.includes('drive')) {
    if (/search/.test(l)) {
      if (term) return { kind: 'search', text: `søkte i Drive etter «${term}»` };
      if (/sharedwithme/i.test(String(rawQ))) return { kind: 'search', text: 'sjekket om noen har delt nye filer i Drive' };
      if (/parentid|in parents/i.test(String(rawQ))) return { kind: 'read', text: 'så gjennom en Drive-mappe' };
      return { kind: 'search', text: 'lette etter nye filer i Drive' };
    }
    if (/(read|download|get_file)/.test(l)) return { kind: 'read', text: 'leste en fil i Drive' };
    if (/(list|recent)/.test(l)) return { kind: 'read', text: 'så på nylige Drive-filer' };
    if (/create|upload/.test(l)) return { kind: 'write', text: 'la en fil i Drive' };
    return { kind: 'read', text: 'jobbet i Drive' };
  }
  if (l.includes('gmail')) {
    if (/search/.test(l)) return { kind: 'mail', text: term ? `søkte i Gmail etter «${term}»` : 'sjekket innboksen' };
    if (/get_thread|read/.test(l)) return { kind: 'mail', text: 'leste en e-posttråd' };
    if (/draft/.test(l)) return { kind: 'mail', text: 'skrev et e-postutkast' };
    return { kind: 'mail', text: 'jobbet i Gmail' };
  }
  if (l.includes('calendar')) {
    if (/create/.test(l)) return { kind: 'calendar', text: 'la inn en kalenderhendelse' };
    return { kind: 'calendar', text: 'sjekket kalenderen' };
  }
  if (l.includes('tripletex')) return { kind: 'tripletex', text: 'sjekket Tripletex' };
  if (l.includes('supabase')) return { kind: 'read', text: 'slo opp i databasen' };
  if (/(_kb|mmrag|rag|knowledge)/.test(l)) return { kind: 'kb', text: term ? `spurte hjernen om «${term}»` : 'spurte hjernen' };
  const parts = name.split('__');
  const service = (parts[1] || 'verktøy').replace(/^claude_ai_/, '').replace(/_/g, ' ');
  const action = (parts[2] || '').replace(/_/g, ' ');
  return { kind: 'think', text: `brukte ${service}${action ? ` (${action})` : ''}` };
}
function humanize(tool, input) {
  input = input || {};
  switch (tool) {
    case 'Read': { const f = fileWord(input.file_path); return { kind: 'read', text: `${f.verb} ${f.noun}` }; }
    case 'Write': return { kind: 'write', text: `skrev ${basename(String(input.file_path || 'en fil'))}` };
    case 'Edit': case 'MultiEdit': return { kind: 'write', text: `endret ${basename(String(input.file_path || 'en fil'))}` };
    case 'Grep': return { kind: 'search', text: input.pattern ? `søkte etter «${input.pattern}»` : 'søkte i filer' };
    case 'Glob': return { kind: 'search', text: input.pattern ? `lette etter filer (${input.pattern})` : 'lette etter filer' };
    case 'WebSearch': return { kind: 'search', text: input.query ? `søkte på nettet: ${input.query}` : 'søkte på nettet' };
    case 'WebFetch': { let h = ''; try { h = new URL(input.url).host; } catch {} return { kind: 'read', text: h ? `hentet ${h}` : 'hentet en nettside' }; }
    case 'Task': return { kind: 'think', text: 'startet en deloppgave' };
    case 'TodoWrite': return null;
    case 'Bash': {
      const cmd = String(input.command || '');
      const bus = busHuman(cmd);
      if (bus !== undefined) return bus;
      if (/telegram|sendMessage/i.test(cmd)) return { kind: 'telegram', text: 'sendte en Telegram-melding' };
      return { kind: 'think', text: bashLabel(input.description ? String(input.description).trim() : '') };
    }
    default:
      if (tool && tool.startsWith('mcp__')) return mcpHuman(tool, input);
      return { kind: 'think', text: `brukte ${tool || 'et verktøy'}` };
  }
}

// ── walk transcript ──────────────────────────────────────────────────────────
const files = fs.readdirSync(PROJECT_DIR).filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f, t: fs.statSync(join(PROJECT_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
if (!files.length) { console.error('Ingen transcript funnet'); process.exit(1); }
const T = join(PROJECT_DIR, files[0].f);
const lines = fs.readFileSync(T, 'utf8').split('\n');

let run = { run_id: null, run_kind: 'aktivitet', run_label: 'Aktivitet' };
const rows = [];
for (const line of lines) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.type === 'user' && o.message && typeof o.message.content === 'string') {
    const t = o.message.content;
    if (!t.startsWith('Caveat')) run = deriveRun(t);
    continue;
  }
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    const ts = o.timestamp || new Date().toISOString();
    for (const block of o.message.content) {
      if (block.type !== 'tool_use') continue;
      const h = humanize(block.name, block.input);
      if (!h || !h.text) continue;
      rows.push({
        org_id: 'massivlust', agent_id: AGENT, ts,
        run_id: run.run_id, run_kind: run.run_kind, run_label: run.run_label,
        kind: h.kind, text: h.text, tool: block.name,
        raw: { file: block.input?.file_path, query: block.input?.query || block.input?.pattern, detail: detailOf(block.name, block.input) },
      });
    }
  }
}

const recent = rows.slice(-MAX);
console.log(`Fant ${rows.length} steg i transcript; skriver de siste ${recent.length}.`);

const env = loadEnv(ENGINE_ENV);
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('Mangler Supabase-creds'); process.exit(1); }
const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/massivlust_agent_activity', {
  method: 'POST',
  headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
  body: JSON.stringify(recent),
});
console.log(`Supabase: ${res.status} ${res.statusText}`);
// vis en smakebit
for (const r of recent.slice(-12)) console.log(`  ${r.ts.slice(11, 16)}  [${r.run_label}]  ${r.text}`);
