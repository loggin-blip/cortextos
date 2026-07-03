#!/usr/bin/env node
/**
 * engine-heartbeat.mjs — skriv «motoren lever»-tidsstempel til Supabase.
 *
 * Kjøres SIST i run-tick.sh hvert minutt. Dashbordet leser `massivlust_engine_health`
 * og viser om motoren svarer (sist tikk < ~3 min siden = grønn). Hvis Studio er nede
 * stopper tidsstempelet, og dashbordet kan si fra at køede endringer ikke kjøres.
 */

import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

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

async function main() {
  const env = loadEnv();
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('✖ Mangler SUPABASE-creds'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const now = new Date().toISOString();
  const { error } = await db.from('massivlust_engine_health').upsert(
    { id: 'agent-engine', last_tick: now, host: hostname(), updated_at: now },
    { onConflict: 'id' },
  );
  if (error) { console.error('✖ heartbeat-upsert:', error.message); process.exit(1); }
  console.log(`💓 heartbeat ${now}`);
}

main().catch((e) => { console.error('✖ Uventet feil:', e); process.exit(1); });
