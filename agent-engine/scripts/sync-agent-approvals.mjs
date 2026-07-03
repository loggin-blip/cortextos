#!/usr/bin/env node
/**
 * sync-agent-approvals.mjs — speil agentenes godkjenn-forespørsler → Supabase.
 *
 * cortextOS har en innebygd approval-mekanisme: en agent kjører
 * `bus/create-approval.sh <tittel> <kategori> [kontekst]` som skriver
 *   ~/.cortextos/<instance>/orgs/<org>/approvals/pending/approval_<epoch>_<rand>.json
 * (status «pending»). Beslutning (`update-approval.sh <id> approved|rejected`)
 * flytter fila til resolved/ OG sender en inbox-melding til agenten → den gjenopptar.
 *
 * Dette speiler pending (+ nylig resolved) inn i dashbordets innboks. Beslutningen
 * skrives tilbake via intent `resolve_approval` → apply-agent-intents kaller
 * samme bus-CLI på Studio (hele loopen, inkl. agent-varsel, bevares).
 *
 * Org-scope: massivlust (alle agenter) + westside-hq FILTRERT til ks-avvik
 * (den eneste westside-agenten massivlust-dashbordet eier — jf. file/config-mirror).
 *
 * Kjør:  node scripts/sync-agent-approvals.mjs
 * Krever: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY i .env.local. Kjøres på Studio (run-tick.sh).
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const INSTANCE = process.env.CTX_INSTANCE_ID || 'default';
const CTX_ROOT = join(homedir(), '.cortextos', INSTANCE);

// Hvilke org-er å scanne + valgfritt agent-filter (kun disse requesting_agent slipper inn).
const SCOPES = [
  { org: 'massivlust', onlyAgents: null },            // alle massivlust-agenter
  { org: 'westside-hq', onlyAgents: new Set(['ks-avvik']) }, // kun ks-avvik
];

const RESOLVED_MAX_AGE_DAYS = 14; // resolved-historikk: behold de siste 14 dagene

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

async function readApprovalsIn(dir) {
  if (!existsSync(dir)) return [];
  let files;
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(await readFile(join(dir, f), 'utf8'))); } catch { /* skip korrupt */ }
  }
  return out;
}

function toRow(a, sourceOrg, stamp) {
  return {
    id: a.id,
    agent_id: a.requesting_agent || 'ukjent',
    org_id: 'massivlust',
    source_org: sourceOrg,
    title: a.title || null,
    category: a.category || null,
    status: a.status || 'pending',
    description: a.description || null,
    requesting_agent: a.requesting_agent || null,
    created_at: a.created_at || null,
    updated_at: a.updated_at || null,
    resolved_at: a.resolved_at || null,
    resolved_by: a.resolved_by || null,
    decided_via: a.status && a.status !== 'pending' ? (a.decided_via || 'studio') : null,
    mirrored_at: stamp,
  };
}

async function main() {
  const env = loadEnv();
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('✖ Mangler SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  if (!existsSync(CTX_ROOT)) { console.error(`✖ Fant ikke ${CTX_ROOT} — kjør på Studio`); process.exit(1); }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const stamp = new Date().toISOString();
  const cutoff = Date.now() - RESOLVED_MAX_AGE_DAYS * 86400_000;

  const rows = [];
  let pendingCount = 0;
  for (const { org, onlyAgents } of SCOPES) {
    const base = join(CTX_ROOT, 'orgs', org, 'approvals');
    const pending = await readApprovalsIn(join(base, 'pending'));
    const resolved = await readApprovalsIn(join(base, 'resolved'));
    for (const a of pending) {
      if (onlyAgents && !onlyAgents.has(a.requesting_agent)) continue;
      rows.push(toRow(a, org, stamp));
      pendingCount++;
    }
    for (const a of resolved) {
      if (onlyAgents && !onlyAgents.has(a.requesting_agent)) continue;
      const t = Date.parse(a.resolved_at || a.updated_at || a.created_at || '');
      if (Number.isFinite(t) && t < cutoff) continue; // for gammel — dropp fra historikk
      rows.push(toRow(a, org, stamp));
    }
  }

  if (rows.length) {
    const { error } = await db.from('massivlust_agent_approvals').upsert(rows, { onConflict: 'id' });
    if (error) { console.error(`✖ Upsert feilet — ${error.message}`); process.exit(1); }
  }

  // Stale-opprydding: pending-rader i speilet som IKKE ble friskt stemplet denne
  // runden = løst direkte på Studio (eller forsvunnet). Fjern dem så innboksen
  // ikke viser spøkelser. Resolved-rader (status != pending) røres ikke.
  const del = await db.from('massivlust_agent_approvals').delete()
    .eq('org_id', 'massivlust').eq('status', 'pending').lt('mirrored_at', stamp);
  if (del.error) console.error(`  ⚠ opprydding feilet — ${del.error.message}`);

  console.log(`✅ ${rows.length} approval(s) speilet (${pendingCount} pending).`);
}

main().catch((e) => { console.error('✖ Uventet feil:', e); process.exit(1); });
