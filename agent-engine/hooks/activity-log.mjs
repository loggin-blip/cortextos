#!/usr/bin/env node
/**
 * agent-activity-hook.mjs — Claude Code PostToolUse-hook som speiler ETT verktøy-
 * steg → `massivlust_agent_activity` i klartekst. Drivkraften bak «Bak kulissene»-
 * pulsen i dashbordet.
 *
 * Kjøres av hver agent (settings.json → hooks.PostToolUse) etter HVERT verktøy-kall.
 * Claude Code sender hook-input som JSON på stdin:
 *   { session_id, transcript_path, cwd, tool_name, tool_input, tool_response, ... }
 *
 * Hva den gjør:
 *   1) Finner hvilken «kjøring» steget hører til (seksjon) ved å lese transcript-
 *      halen for siste bruker-prompt. Cron/heartbeat har formatet
 *      `[CRON FIRED <ts>] <navn>: …` → ren seksjons-tittel. Ekte oppgave → egen.
 *   2) Oversetter verktøy-kallet til en klartekst-setning (regelbasert).
 *   3) Skriver raden til Supabase (fetch, kort timeout) + lokal jsonl-backup.
 *
 * Robust: leser stdin helt, fanger ALLE feil, og avslutter ALLTID med exit 0 —
 * en logge-hook skal aldri kunne stoppe eller bremse en agent nevneverdig.
 *
 * Creds: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY fra ~/cortextos/agent-engine/.env.local.
 */

import fs from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

const ENGINE_ENV = join(homedir(), 'cortextos', 'agent-engine', '.env.local');

// ── env-loader (samme mønster som sync-scriptene) ────────────────────────────
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

function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}

// ── seksjon: hvilken kjøring hører steget til ────────────────────────────────
const CRON_LABELS = {
  'drive-watch': 'Sjekker Drive for nye filer',
  'heartbeat': 'Heartbeat-sjekk',
  'tx-monitor': 'T-X-overvåking',
  't-x-monitor': 'T-X-overvåking',
  'ukerollup': 'Ukentlig oppsummering',
  'uke-rollup': 'Ukentlig oppsummering',
  'morgenrapport': 'Morgenrapport',
  'kveldsrapport': 'Kveldsrapport',
};
function cronLabel(name) {
  return CRON_LABELS[name.toLowerCase()] || name.replace(/[-_]+/g, ' ');
}

function deriveRun(text) {
  const cron = text.match(/^\[CRON FIRED\s+([^\]]+)\]\s*([a-z0-9_.-]+)\s*:\s*([\s\S]*)$/i);
  if (cron) {
    const ts = cron[1].trim();
    const name = cron[2].trim();
    const kind = /heartbeat/i.test(name) ? 'heartbeat' : 'cron';
    return { run_id: `${name}:${ts}`, run_kind: kind, run_label: cronLabel(name) };
  }
  if (/^You are starting a new session/i.test(text)) {
    return { run_id: 'session-start', run_kind: 'oppstart', run_label: 'Starter ny økt' };
  }
  const clean = text.replace(/\s+/g, ' ').trim();
  const short = clean.slice(0, 72) + (clean.length > 72 ? '…' : '');
  return { run_id: `task:${hashId(clean.slice(0, 200))}`, run_kind: 'oppgave', run_label: short };
}

function currentRun(transcriptPath) {
  try {
    const size = fs.statSync(transcriptPath).size;
    const readLen = Math.min(size, 96 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'user' && o.message && typeof o.message.content === 'string') {
        const t = o.message.content;
        if (t.startsWith('Caveat')) continue;     // lokal-kommando-støy
        return deriveRun(t);
      }
    }
  } catch {}
  return { run_id: null, run_kind: 'aktivitet', run_label: 'Aktivitet' };
}

// ── humanisering: verktøy-kall → klartekst ───────────────────────────────────
function fileWord(p) {
  const b = basename(String(p || '')) || 'en fil';
  if (/\.ifc$/i.test(b)) return { verb: 'åpnet', noun: `IFC-modellen ${b}` };
  if (/\.pdf$/i.test(b)) return { verb: 'leste', noun: `PDF-en ${b}` };
  if (/\.(xlsx?|csv)$/i.test(b)) return { verb: 'åpnet', noun: `regnearket ${b}` };
  return { verb: 'leste', noun: b };
}

function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

// Returner søke-strengen KUN hvis den er menneske-lesbar (ikke teknisk filter-syntaks).
function humanTerm(q) {
  if (!q || typeof q !== 'string') return null;
  const s = q.trim();
  if (!s || s.length > 50) return null;
  if (/[=<>'"]|sharedwithme|modifiedtime|parentid|mimetype|trashed|\bcontains\b|\band\b|\bor\b/i.test(s)) return null;
  return s;
}

// Engelske bash-beskrivelser → klartekst for de vanligste rutine-stegene.
function bashLabel(d) {
  if (!d) return 'kjørte en kommando';
  const s = d.toLowerCase();
  if (/inbox/.test(s)) return 'sjekket innboksen';
  if (/heartbeat/.test(s) && /memory/.test(s)) return 'oppdaterte hukommelse og puls';
  if (/memory/.test(s)) return 'oppdaterte hukommelsen';
  if (/heartbeat/.test(s)) return 'oppdaterte pulsen';
  if (/draft/.test(s)) {
    if (/\b(check|poll|pending|get|fetch|list|read)\b/.test(s)) return 'sjekket utkast-køen';
    if (/\b(create|insert|post|write|save|send)\b/.test(s)) return 'opprettet et utkast';
    return 'sjekket utkast-køen';
  }
  if (/calendar/.test(s)) {
    if (/\b(create|add|insert|schedule)\b/.test(s)) return 'la inn en kalenderhendelse';
    return 'sjekket kalenderen';
  }
  if (/^ack\b/.test(s) || /\backn?owledge/.test(s)) return 'kvitterte en melding';
  if (/\b(kurs|kompetanse)\b/.test(s)) return 'sjekket kompetansen';
  if (/\bt-?x\b/.test(s) || /tx status/.test(s)) return 'beregnet T-X-status';
  if (/task/.test(s) && /(create|start)/.test(s)) return 'opprettet en oppgave';
  return lowerFirst(d);
}

// Agent-id → kort visningsnavn (for «meldte til X»).
const AGENT_SHORT = {
  'kaptein-massivlust': 'Kaptein', 'kjoreplan': 'Kjøreplan', 'ks-avvik': 'KS & Avvik',
  'massivlust-team': 'Jensen', 'ml-prosjektleder': 'Prosjektleder',
  'eivind-massivlust': 'Eivind', 'vegard-massivlust': 'Vegard', 'martin-thorvaldsen-venedik': 'Martin',
};
function agentShort(id) { return AGENT_SHORT[id] || String(id).replace(/-massivlust$/, '').replace(/-/g, ' '); }
function gist(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t || /\$\(|`|^[/~]|^\$\{/.test(t)) return ''; // kommando-substitusjon / sti → ikke vis råtekst
  return t.length > 56 ? t.slice(0, 56) + '…' : t;
}

// Redakter hemmeligheter før detalj/desc havner i logg — Supabase service_role,
// publishable keys, bearer-tokens, Anthropic/OpenAI keys, Tripletex tokens.
function redactSecrets(s) {
  if (!s) return s;
  return String(s)
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, 'sb_secret_***')
    .replace(/sb_publishable_[A-Za-z0-9_-]+/g, 'sb_publishable_***')
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt_***')
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***')
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9_.-]{20,}/gi, 'Bearer ***')
    .replace(/(apikey|authorization|token|password|secret|key)["'\s:=]+[A-Za-z0-9_.-]{16,}/gi, '$1=***');
}

// Rå detalj til «klikk for mer» (full input — filsti / kommando / spørring).
function detailOf(tool, input) {
  if (!input) return null;
  if (input.command) return redactSecrets(String(input.command).replace(/\s+/g, ' ').trim().slice(0, 300));
  if (input.file_path) return String(input.file_path);
  if (input.query) return redactSecrets(String(input.query).slice(0, 300));
  if (input.pattern) return String(input.pattern);
  if (input.url) return redactSecrets(String(input.url));
  if (input.description) return redactSecrets(String(input.description));
  return null;
}

// Klartekst for cortextOS bus-kommandoer (agent-melding / telegram / heartbeat).
function busHuman(cmd) {
  if (/cortextos\s+bus\s+log-event/.test(cmd)) return null;                       // intern støy
  const sm = cmd.match(/bus\s+send-message\s+([a-z0-9_.-]+)\s+\S+\s+(['"])([\s\S]*?)\2/i);
  if (sm) { const g = gist(sm[3]); return { kind: 'message', text: g ? `meldte til ${agentShort(sm[1])}: «${g}»` : `meldte til ${agentShort(sm[1])}` }; }
  const tg = cmd.match(/bus\s+send-telegram\s+\S+\s+(['"])([\s\S]*?)\1/i);
  if (tg) { const g = gist(tg[2]); return { kind: 'telegram', text: g ? `meldte på Telegram: «${g}»` : 'meldte på Telegram' }; }
  if (/bus\s+send-message|bridge/.test(cmd)) return { kind: 'message', text: 'sendte en melding til en annen agent' };
  if (/bus\s+(update-heartbeat|self-restart)/.test(cmd)) return { kind: 'think', text: 'oppdaterte pulsen' };
  return undefined; // ikke en bus-kommando
}

function mcpHuman(name, input) {
  const lname = name.toLowerCase();
  const rawQ = input && (input.query || input.q || input.search || input.keyword);
  const term = humanTerm(rawQ);
  if (lname.includes('drive')) {
    if (/search/.test(lname)) {
      if (term) return { kind: 'search', text: `søkte i Drive etter «${term}»` };
      if (/sharedwithme/i.test(String(rawQ))) return { kind: 'search', text: 'sjekket om noen har delt nye filer i Drive' };
      if (/parentid|in parents/i.test(String(rawQ))) return { kind: 'read', text: 'så gjennom en Drive-mappe' };
      return { kind: 'search', text: 'lette etter nye filer i Drive' };
    }
    if (/(read|download|get_file)/.test(lname)) return { kind: 'read', text: 'leste en fil i Drive' };
    if (/(list|recent)/.test(lname)) return { kind: 'read', text: 'så på nylige Drive-filer' };
    if (/create|upload/.test(lname)) return { kind: 'write', text: 'la en fil i Drive' };
    return { kind: 'read', text: 'jobbet i Drive' };
  }
  if (lname.includes('gmail')) {
    if (/search/.test(lname)) return { kind: 'mail', text: term ? `søkte i Gmail etter «${term}»` : 'sjekket innboksen' };
    if (/get_thread|read/.test(lname)) return { kind: 'mail', text: 'leste en e-posttråd' };
    if (/list_drafts?/.test(lname)) return { kind: 'mail', text: 'så på utkast-listen' };
    if (/create_draft/.test(lname)) return { kind: 'mail', text: 'skrev et e-postutkast' };
    if (/draft/.test(lname)) return { kind: 'mail', text: 'jobbet med utkast' };
    if (/label/.test(lname)) return { kind: 'mail', text: 'sorterte e-post' };
    return { kind: 'mail', text: 'jobbet i Gmail' };
  }
  if (lname.includes('calendar')) {
    if (/create/.test(lname)) return { kind: 'calendar', text: 'la inn en kalenderhendelse' };
    if (/update|respond/.test(lname)) return { kind: 'calendar', text: 'oppdaterte kalenderen' };
    return { kind: 'calendar', text: 'sjekket kalenderen' };
  }
  if (lname.includes('tripletex')) return { kind: 'tripletex', text: 'sjekket Tripletex' };
  if (lname.includes('supabase')) return { kind: 'read', text: 'slo opp i databasen' };
  if (/(_kb|mmrag|rag|knowledge)/.test(lname)) return { kind: 'kb', text: term ? `spurte hjernen om «${term}»` : 'spurte hjernen' };
  // generisk MCP-verktøy
  const parts = name.split('__');
  const service = (parts[1] || 'verktøy').replace(/^claude_ai_/, '').replace(/_/g, ' ');
  const action = (parts[2] || '').replace(/_/g, ' ');
  return { kind: 'think', text: `brukte ${service}${action ? ` (${action})` : ''}` };
}

function humanize(tool, input, _resp) {
  input = input || {};
  switch (tool) {
    case 'Read': { const f = fileWord(input.file_path); return { kind: 'read', text: `${f.verb} ${f.noun}` }; }
    case 'Write': return { kind: 'write', text: `skrev ${basename(String(input.file_path || 'en fil'))}` };
    case 'Edit':
    case 'MultiEdit': return { kind: 'write', text: `endret ${basename(String(input.file_path || 'en fil'))}` };
    case 'NotebookEdit': return { kind: 'write', text: 'endret en notebook' };
    case 'Grep': return { kind: 'search', text: input.pattern ? `søkte etter «${input.pattern}»` : 'søkte i filer' };
    case 'Glob': return { kind: 'search', text: input.pattern ? `lette etter filer (${input.pattern})` : 'lette etter filer' };
    case 'WebSearch': return { kind: 'search', text: input.query ? `søkte på nettet: ${input.query}` : 'søkte på nettet' };
    case 'WebFetch': {
      let host = '';
      try { host = new URL(input.url).host; } catch {}
      return { kind: 'read', text: host ? `hentet ${host}` : 'hentet en nettside' };
    }
    case 'Task': return { kind: 'think', text: 'startet en deloppgave' };
    case 'TodoWrite': return null; // intern liste-støy
    case 'Bash': {
      const cmd = String(input.command || '');
      const bus = busHuman(cmd);
      if (bus !== undefined) return bus; // null = hopp over, objekt = klartekst
      if (/telegram|sendMessage/i.test(cmd)) return { kind: 'telegram', text: 'sendte en Telegram-melding' };
      return { kind: 'think', text: bashLabel(input.description ? String(input.description).trim() : '') };
    }
    default:
      if (tool && tool.startsWith('mcp__')) return mcpHuman(tool, input);
      return { kind: 'think', text: `brukte ${tool || 'et verktøy'}` };
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let hook;
  try { hook = JSON.parse(raw); } catch { return; }

  const tool = hook.tool_name || hook.toolName || '';
  const input = hook.tool_input || hook.toolInput || {};
  const resp = hook.tool_response ?? hook.toolResponse;

  const h = humanize(tool, input, resp);
  if (!h || !h.text) return; // hopp over støy

  const agent = process.env.CTX_AGENT_NAME || basename(String(hook.cwd || '')) || 'ukjent';
  const org = process.env.CTX_ORG || 'massivlust';
  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');

  const run = currentRun(hook.transcript_path || '');

  const row = {
    org_id: org,
    agent_id: agent,
    ts: new Date().toISOString(),
    run_id: run.run_id,
    run_kind: run.run_kind,
    run_label: run.run_label,
    kind: h.kind,
    text: h.text,
    tool,
    raw: {
      file: input.file_path,
      query: redactSecrets(input.query || input.pattern),
      desc: redactSecrets(input.description),
      detail: detailOf(tool, input),
    },
  };

  // 1) lokal backup (instant, durabel)
  try {
    const dir = join(ctxRoot, 'state', agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(join(dir, 'activity.jsonl'), JSON.stringify(row) + '\n');
  } catch {}

  // 2) Supabase (nær-sanntid, kort timeout — feiler stille, backup fanger det)
  const env = loadEnv(ENGINE_ENV);
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 1800);
    try {
      await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/massivlust_agent_activity', {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
        signal: ctrl.signal,
      });
    } catch {}
    clearTimeout(to);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
