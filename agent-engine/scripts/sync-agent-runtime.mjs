#!/usr/bin/env node
/**
 * sync-agent-runtime.mjs — speil agentenes LIVE runtime-tilstand → Supabase.
 *
 * Statistikk-fanen i Agent Studio trenger sanntids-puls per agent. cortextOS-
 * runtimen skriver dette under ctxRoot (`~/.cortextos/<instance>/state/<agent>/`):
 *   • heartbeat.json       → agentens egen status-tekst + mode + last_heartbeat (ferskhet)
 *   • context_status.json  → kontekst-vindu fyllingsgrad (% av 200k) — «hvor full er hjernen»
 *   • .crash_count_today   → «YYYY-MM-DD:N» siste krasj-dato + antall
 *   • cron-state.json      → per-cron last_fire (sparsomt — kun agenter med intern cron-loop)
 *
 * Tokens/kost speiles IKKE her: state/usage-collectoren er ikke schedulert
 * (usage-latest.json sist generert 2026-05-16), så tallene ville løyet. Når
 * collectoren kjører igjen kan en `tokens`-snapshot legges til med `as_of`.
 *
 * Kjør:  node scripts/sync-agent-runtime.mjs
 * Krever: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY i .env.local. Kjøres på Studio (run-tick.sh).
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const ORG_DIR = join(homedir(), 'cortextos', 'orgs', 'massivlust', 'agents');
const INSTANCE = process.env.CTX_INSTANCE_ID || 'default';
const STATE_DIR = join(homedir(), '.cortextos', INSTANCE, 'state');

// Hold i sync med EXTRA_AGENTS i sync-agent-config.mjs.
const EXTRA_AGENTS = ['ks-avvik'];

function loadEnv() {
  const out = {};
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

async function readJsonSafe(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

/** Bygg én runtime-rad for en agent fra state-filene. Returnerer null om agenten ikke har state. */
async function buildRow(agentId) {
  const dir = join(STATE_DIR, agentId);
  if (!existsSync(dir)) return null;

  const hb = await readJsonSafe(join(dir, 'heartbeat.json'));
  const ctx = await readJsonSafe(join(dir, 'context_status.json'));
  const cronState = await readJsonSafe(join(dir, 'cron-state.json'));

  // .crash_count_today: «YYYY-MM-DD:N». Tom/manglende → 0.
  let crashes = 0, crashDate = null;
  try {
    const raw = (await readFile(join(dir, '.crash_count_today'), 'utf8')).trim();
    const m = raw.match(/^(\d{4}-\d{2}-\d{2}):(\d+)$/);
    if (m) { crashDate = m[1]; crashes = parseInt(m[2], 10) || 0; }
  } catch { /* ingen krasj-fil = 0 */ }

  // Ingen heartbeat OG ingen kontekst = agenten har aldri kjørt → hopp over.
  if (!hb && !ctx && !cronState && !crashDate) return null;

  return {
    agent_id: agentId,
    org_id: 'massivlust',
    heartbeat_status: hb?.status ?? null,
    heartbeat_at: hb?.last_heartbeat ?? null,
    mode: hb?.mode ?? null,
    current_task: hb?.current_task || null,
    context_pct: typeof ctx?.used_percentage === 'number' ? ctx.used_percentage : null,
    context_window: typeof ctx?.context_window_size === 'number' ? ctx.context_window_size : null,
    context_at: ctx?.written_at ?? null,
    crashes_today: crashes,
    crash_date: crashDate,
    crons: Array.isArray(cronState?.crons) ? cronState.crons : null,
    tokens: null, // usage-collector ikke schedulert — se filtopp.
    updated_at: new Date().toISOString(),
  };
}

async function main() {
  const env = loadEnv();
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('✖ Mangler SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  if (!existsSync(ORG_DIR)) { console.error(`✖ Fant ikke ${ORG_DIR} — kjør på Studio`); process.exit(1); }

  const dirs = (await readdir(ORG_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name);
  const agentIds = [...new Set([...dirs, ...EXTRA_AGENTS])];

  const db = createClient(url, key, { auth: { persistSession: false } });
  const rows = [];
  for (const agentId of agentIds) {
    const row = await buildRow(agentId);
    if (row) rows.push(row);
  }
  if (!rows.length) { console.log('✓ Ingen runtime-state funnet.'); return; }

  const { error } = await db.from('massivlust_agent_runtime').upsert(rows, { onConflict: 'agent_id' });
  if (error) { console.error(`✖ Upsert feilet — ${error.message}`); process.exit(1); }

  for (const r of rows) {
    console.log(`  ✓ ${r.agent_id.padEnd(28)} ctx ${r.context_pct ?? '—'}% · ${r.mode ?? '—'} · krasj ${r.crashes_today}${r.crash_date ? ` (${r.crash_date})` : ''}`);
  }
  console.log(`\n✅ ${rows.length} agent(er) runtime-speilet.`);
}

main().catch((e) => { console.error('✖ Uventet feil:', e); process.exit(1); });
