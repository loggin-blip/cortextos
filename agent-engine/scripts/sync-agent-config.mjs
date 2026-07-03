#!/usr/bin/env node
/**
 * sync-agent-config.mjs — speil per-agent config.json + mandat-.md → Supabase.
 *
 * Leser cortextOS-org-filene (config.json, GOALS/GUARDRAILS/MEMORY.md) og
 * UPSERT-er normalisert, UI-klar config inn i `massivlust_agent_config`.
 * Normaliseringen (humanisering av approval-kategorier + cron-uttrykk) skjer
 * HER, slik at dashboard-komponenten leser ferdig-tygd data — ingen
 * hardkodet data i UI, alt utledes fra de ekte kildefilene.
 *
 * Kjør:  node scripts/sync-agent-config.mjs
 * Krever: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY i .env.local
 *
 * Dette er config-delen av docs/KICKOFF_STUDIO_AGENT_MIRROR.md (seksjon 3b).
 * Heartbeat/tasks/bus-messages krever runtime-state og kjøres på Studio-maskinen.
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const ORG_DIR = join(homedir(), 'cortextos', 'orgs', 'massivlust', 'agents');

// Allow-list — hold i sync med src/lib/agent-display.ts (MASSIVLUST_AGENTS).
const ALLOW = new Set([
  'kaptein-massivlust',
  'ml-prosjektleder',
  'massivlust-team',
  'massivlust-dev',
  'martin-thorvaldsen-venedik',
]);

// Agenter som brukes på Massivlust-siden, men fysisk bor i en annen org på Studio.
// De speiles med org_id='massivlust' så de dukker opp og kan styres i flåten her.
// (Max 2026-06-26: kun ks-avvik av westside-agentene er i bruk på massivlust-siden.)
const EXTRA_AGENTS = [
  { agentId: 'ks-avvik', dir: join(homedir(), 'cortextos', 'orgs', 'westside-hq', 'agents', 'ks-avvik') },
];

// ── env ──────────────────────────────────────────────────────────────────
function loadEnv() {
  const out = {};
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// ── humanisering ───────────────────────────────────────────────────────────
const APPROVAL_LABELS = {
  'external-comms': 'Ekstern kommunikasjon (mail/meldinger ut av huset)',
  financial: 'Økonomiske handlinger (faktura, betaling, tilbud)',
  deployment: 'Endringer i drift / deploy',
  'data-deletion': 'Sletting av data',
  'data-write': 'Skriving til delte systemer',
};

function humanizeApproval(cat) {
  return (
    APPROVAL_LABELS[cat] ??
    cat.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  );
}

const DAY_NAMES = ['søndager', 'mandager', 'tirsdager', 'onsdager', 'torsdager', 'fredager', 'lørdager'];

function humanizeCron(expr) {
  if (!expr || typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, , , dow] = parts;
  const hh = String(hour).padStart(2, '0');
  const mm = String(min).padStart(2, '0');
  const time = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `kl ${hh}:${mm}` : '';
  let day;
  if (dow === '*') day = 'Daglig';
  else if (dow === '1-5') day = 'Hverdager';
  else if (dow === '6,0' || dow === '0,6') day = 'Helg';
  else if (/^\d$/.test(dow)) day = DAY_NAMES[Number(dow)]?.replace(/^\w/, (c) => c.toUpperCase()) ?? `Ukedag ${dow}`;
  else day = `(${dow})`;
  return [day, time].filter(Boolean).join(' ');
}

function humanizeInterval(iv) {
  if (!iv || typeof iv !== 'string') return null;
  const m = iv.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return iv;
  const n = Number(m[1]);
  const unit = { s: 'sekund', m: 'minutt', h: 'time', d: 'dag' }[m[2].toLowerCase()];
  if (n === 1) return `Hver ${unit}`;
  // "time" → "4. time", andre → "hvert 4. minutt"
  return unit === 'time' ? `Hver ${n}. time` : `Hvert ${n}. ${unit}`;
}

/** Beskriver når en cron-jobb går — uansett om den bruker `cron` eller `interval`. */
function humanizeSchedule(c) {
  if (c.cron) return humanizeCron(c.cron);
  if (c.interval) return humanizeInterval(c.interval);
  return null;
}

function prettifyName(name) {
  return String(name || '')
    .replace(/^_+/, '')
    .replace(/[-_]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Fullt RÅTT mandat-innhold (kun normaliser linjeskift + cap) — så Oppførsel-fanen
 *  kan redigere den ekte fil-teksten, ikke et heading-strippet sammendrag. */
function rawMd(text, max = 20000) {
  if (!text) return null;
  const clean = text.replace(/\r/g, '').replace(/\s+$/, '');
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + '\n\n… (kuttet — filen er lengre på Studio)';
}

async function readMaybe(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// ── per agent ────────────────────────────────────────────────────────────
async function buildRow(agentId, dirOverride) {
  const dir = dirOverride || join(ORG_DIR, agentId);
  const cfgRaw = await readMaybe(join(dir, 'config.json'));
  if (!cfgRaw) return null;
  let cfg;
  try {
    cfg = JSON.parse(cfgRaw);
  } catch (e) {
    console.error(`  ⚠ ${agentId}: ugyldig config.json — hopper over (${e.message})`);
    return null;
  }

  const always = cfg.approval_rules?.always_ask ?? [];
  const approvalRules = Array.isArray(always)
    ? always.map((cat) => ({ trigger: cat, description: humanizeApproval(cat) }))
    : [];

  // Speil ALLE jobber (Max 2026-06-26: «vis» de flyttede). Tagg `active` så UI kan
  // skille ekte jobber fra note-markører (flyttet til Gemini/PM2) og heartbeats.
  // `name` = rått navn (kreves for delete_cron/update_cron herfra).
  const crons = Array.isArray(cfg.crons)
    ? cfg.crons
        .filter((c) => c && (c.name || c.cron || c.interval)) // dropp helt tomme
        .map((c) => {
          const isNote = c.type === 'note';
          const isHeartbeat = /heartbeat/i.test(c.name || '');
          return {
            name: c.name || null,
            schedule: humanizeSchedule(c),
            description: prettifyName(c.name),
            active: !isNote && !isHeartbeat && !!(c.cron || c.interval),
            note: isNote ? (c.prompt || null) : null,
            cron: c.cron || null, // rå cron for redigering
            prompt: typeof c.prompt === 'string' ? c.prompt.slice(0, 2000) : null, // hva jobben gjør
          };
        })
    : [];

  const [goals, guardrails, memory] = await Promise.all([
    readMaybe(join(dir, 'GOALS.md')),
    readMaybe(join(dir, 'GUARDRAILS.md')),
    readMaybe(join(dir, 'MEMORY.md')),
  ]);

  const config = {
    agent_id: agentId,
    org_id: 'massivlust',
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : null,
    day_mode_start: cfg.day_mode_start ?? null,
    day_mode_end: cfg.day_mode_end ?? null,
    communication_style: cfg.communication_style ?? null,
    model: cfg.model ?? null,
    approval_rules: approvalRules,
    crons,
    max_session_seconds: Number.isFinite(cfg.max_session_seconds) ? cfg.max_session_seconds : null,
    max_crashes_per_day: Number.isFinite(cfg.max_crashes_per_day) ? cfg.max_crashes_per_day : null,
    goals: rawMd(goals),
    guardrails: rawMd(guardrails),
    learned: rawMd(memory),
    source_file: join(dir, 'config.json'),
    updated_at: new Date().toISOString(),
  };

  // Registry-rad: identiteten som gjør at agenten dukker opp i flåten. Insertes
  // kun hvis ny (ignoreDuplicates) — clobrer ikke de fint-seedede navnene/emojiene.
  const reg = {
    agent_id: agentId,
    org_id: 'massivlust',
    display_name: cfg.display_name || prettifyName(agentId),
    emoji: cfg.emoji || '🤖',
    role: cfg.role || (cfg.owner ? `Agent · eier ${cfg.owner}` : 'Agent'),
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : true,
    source: 'sync',
  };

  return { config, reg };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const env = await loadEnv();
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('✖ Mangler SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY i .env.local');
    process.exit(1);
  }
  if (!existsSync(ORG_DIR)) {
    console.error(`✖ Fant ikke org-mappa: ${ORG_DIR}`);
    console.error('  (config-filene ligger ikke på denne maskinen — kjør på Studio.)');
    process.exit(1);
  }

  // ALLE agent-mapper med config.json (ikke en hardkodet liste) → nye agenter
  // (KS, avvik, onboarding) dukker opp automatisk når mappa deres finnes.
  const dirs = (await readdir(ORG_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const built = (await Promise.all([
    ...dirs.map((d) => buildRow(d)),
    ...EXTRA_AGENTS.map((e) => buildRow(e.agentId, e.dir)),
  ])).filter(Boolean);
  if (!built.length) {
    console.error('✖ Ingen gyldige config-rader bygget.');
    process.exit(1);
  }
  const rows = built.map((b) => b.config);
  const regRows = built.map((b) => b.reg);
  console.log(`🔄 Speiler ${rows.length} agent(er): ${rows.map((r) => r.agent_id).join(', ')}\n`);

  const db = createClient(url, key, { auth: { persistSession: false } });

  // 1) Registry FØRST (insert-if-new) — så loaderne ser agenten.
  const regRes = await db.from('massivlust_agents').upsert(regRows, { onConflict: 'agent_id', ignoreDuplicates: true });
  if (regRes.error) console.error('  ⚠ registry-upsert:', regRes.error.message);

  // 2) Config (full upsert).
  const { error } = await db.from('massivlust_agent_config').upsert(rows, { onConflict: 'agent_id' });
  if (error) {
    console.error('✖ Config-upsert feilet:', error.message);
    process.exit(1);
  }

  for (const r of rows) {
    console.log(
      `  ✓ ${r.agent_id.padEnd(28)} på=${r.enabled} · ${r.crons.length} jobb · ${r.approval_rules.length} godkjenn-regler · modell=${r.model}`,
    );
  }
  console.log(`\n✅ ${rows.length} agent(er) speilet (registry + config).`);
}

main().catch((e) => {
  console.error('✖ Uventet feil:', e);
  process.exit(1);
});
