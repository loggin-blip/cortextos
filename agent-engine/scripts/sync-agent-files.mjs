#!/usr/bin/env node
/**
 * sync-agent-files.mjs — speil agentenes fil-TRE + kjerne-innhold → Supabase.
 *
 * Dashbordet (VPS) kan ikke lese Studio-filene direkte. Dette scriptet gir
 * Kontekst-fanen i Agent Studio noe å vise:
 *   • MANIFEST for ALLE .md/.json i agent-mappa (sti + størrelse) → hele tre-strukturen.
 *   • INNHOLD kun for rot-«hjerne»-filene (IDENTITY/SOUL/GOALS/GUARDRAILS/… + config.json) —
 *     det er den faktiske konteksten/atferden. Undermappe-filer (avvik/, local/, memory/,
 *     knowledge-sources/) er arbeidsprodukt → vises i treet, men innhold speiles ikke (lett mirror).
 *
 * GOALS.md/GUARDRAILS.md merkes `editable` (redigeres via update_markdown-handleren).
 *
 * Kjør:  node scripts/sync-agent-files.mjs
 * Krever: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY i .env.local. Kjøres på Studio (run-tick.sh).
 */

import { readFile, readdir, stat } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, relative, basename, dirname, extname } from 'path';
import { createClient } from '@supabase/supabase-js';

const ORG_DIR = join(homedir(), 'cortextos', 'orgs', 'massivlust', 'agents');

// Hold i sync med EXTRA_AGENTS i sync-agent-config.mjs.
const EXTRA_AGENTS = [
  { agentId: 'ks-avvik', dir: join(homedir(), 'cortextos', 'orgs', 'westside-hq', 'agents', 'ks-avvik') },
];

const SKIP_DIRS = new Set(['.claude', '.git', 'node_modules', '.cache', 'dist']);
const KEEP_EXT = new Set(['.md', '.json']);
const MAX_DEPTH = 3;       // rot=0; dypere enn dette ignoreres
const MAX_FILES = 400;     // tak per agent (runaway-vakt)
const CONTENT_MAX = 20000; // tak per speilet fil-innhold
const EDITABLE = new Set(['GOALS.md', 'GUARDRAILS.md']); // kun rot-nivå

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

/** Rekursivt: samle alle .md/.json-stier under `root` (dybde-begrenset). */
async function walk(root, dir = root, depth = 0, acc = []) {
  if (depth > MAX_DEPTH || acc.length >= MAX_FILES) return acc;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(root, full, depth + 1, acc);
    } else if (KEEP_EXT.has(extname(e.name).toLowerCase())) {
      acc.push(full);
    }
  }
  return acc;
}

async function buildRows(agentId, dir, stamp) {
  if (!existsSync(dir)) return [];
  const files = await walk(dir);
  const rows = [];
  for (const full of files) {
    const path = relative(dir, full);
    const name = basename(full);
    const d = dirname(path);
    const parentDir = d === '.' ? '' : d;
    const ext = extname(name).toLowerCase().replace('.', '') || null;
    let size = null;
    try { size = (await stat(full)).size; } catch { /* ignore */ }
    // Innhold: kun rot-nivå-filer (agentens «hjerne»). Undermapper = manifest.
    let content = null;
    if (parentDir === '') {
      const raw = await readFile(full, 'utf8').catch(() => null);
      if (raw != null) content = raw.length > CONTENT_MAX ? raw.slice(0, CONTENT_MAX) + '\n\n… (kuttet — filen er lengre på Studio)' : raw;
    }
    rows.push({
      agent_id: agentId,
      org_id: 'massivlust',
      path,
      name,
      dir: parentDir,
      ext,
      size_bytes: size,
      content,
      editable: parentDir === '' && EDITABLE.has(name),
      updated_at: stamp,
    });
  }
  return rows;
}

async function main() {
  const env = loadEnv();
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('✖ Mangler SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  if (!existsSync(ORG_DIR)) { console.error(`✖ Fant ikke ${ORG_DIR} — kjør på Studio`); process.exit(1); }

  const dirs = (await readdir(ORG_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => ({ agentId: d.name, dir: join(ORG_DIR, d.name) }));
  const all = [...dirs, ...EXTRA_AGENTS];

  const db = createClient(url, key, { auth: { persistSession: false } });
  let total = 0;

  for (const { agentId, dir } of all) {
    // Felles tidsstempel for hele agentens batch → robust stale-opprydding uten
    // skjør sti-quoting: alle nåværende rader får `stamp`, eldre rader slettes.
    const stamp = new Date().toISOString();
    const rows = await buildRows(agentId, dir, stamp);
    if (!rows.length) continue;

    // Upsert nåværende filer.
    const { error } = await db.from('massivlust_agent_files').upsert(rows, { onConflict: 'agent_id,path' });
    if (error) { console.error(`  ⚠ ${agentId}: upsert feilet — ${error.message}`); continue; }

    // Slett rader fra forrige sync som ikke ble rørt denne gangen (slettede/flyttede filer).
    const del = await db.from('massivlust_agent_files').delete()
      .eq('agent_id', agentId).lt('updated_at', stamp);
    if (del.error) console.error(`  ⚠ ${agentId}: opprydding feilet — ${del.error.message}`);

    const withContent = rows.filter((r) => r.content != null).length;
    console.log(`  ✓ ${agentId.padEnd(28)} ${rows.length} filer (${withContent} med innhold)`);
    total += rows.length;
  }

  console.log(`\n✅ ${total} filer speilet for ${all.length} agent(er).`);
}

main().catch((e) => { console.error('✖ Uventet feil:', e); process.exit(1); });
