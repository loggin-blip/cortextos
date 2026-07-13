#!/usr/bin/env node
/**
 * enrich-activity-explanations.mjs — fyll inn explanation-kolonnen for aktivitetsrader
 * uten forklaring ved hjelp av lokal Ollama (qwen2.5:3b). Kjøres on-demand eller fra
 * run-tick.sh. Behandler ~10 rader per kjøring; Ollama lastes av etter 1 min idle.
 *
 * Bruker ALDRI Anthropic-API — kun lokal inferens.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'massivlust-enricher'; // qwen2.5:7b + domain primer + few-shot, num_ctx=512
const BATCH_SIZE = 10;
const ORG_ID = 'massivlust';

// System prompt + few-shot er bakt inn i Modelfile.massivlust-enricher — sendes ikke per kall
const SYSTEM_PROMPT = null;

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

const BAD_OUTPUT = /[　-鿿]|[\n\r]|好的|修改|指令|请求|：{1}/;

function isValidExplanation(text) {
  if (!text || text.length === 0) return false;
  if (text.length > 200) return false;
  if (BAD_OUTPUT.test(text)) return false;
  return true;
}

async function ollamaGenerate(prompt) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      ...(SYSTEM_PROMPT ? { system: SYSTEM_PROMPT } : {}),
      prompt,
      stream: false,
      keep_alive: '1m',
      options: { num_predict: 60, temperature: 0.1 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.response ?? '').trim();
}

async function generateWithRetry(prompt, maxRetries = 2) {
  for (let i = 0; i <= maxRetries; i++) {
    const text = await ollamaGenerate(prompt);
    if (isValidExplanation(text)) return text;
    if (i < maxRetries) process.stderr.write(`  ⚠ ugyldig output (forsøk ${i + 1}), prøver igjen…\n`);
  }
  return null; // La explanation stå NULL — neste tikk prøver på nytt
}

function buildPrompt(row, siblings) {
  const ctx = siblings.length
    ? siblings
        .filter((s) => s.id !== row.id)
        .slice(0, 3)
        .map((s) => s.text)
        .join(' / ')
    : '';

  const parts = [
    `Agent: ${row.agent_id}.`,
    `Gjorde: ${row.text}.`,
    row.run_label ? `Del av oppgave: ${row.run_label.slice(0, 120)}.` : '',
    ctx ? `Nærliggende steg: ${ctx.slice(0, 150)}.` : '',
  ].filter(Boolean);

  return parts.join(' ');
}

async function main() {
  const resetAll = process.argv.includes('--reset');
  const env = loadEnv();
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('✖ Mangler SUPABASE-creds i .env.local'); process.exit(1); }

  const db = createClient(url, key, { auth: { persistSession: false } });

  if (resetAll) {
    console.log('→ Nullstiller alle eksisterende forklaringer…');
    const { error } = await db
      .from('massivlust_agent_activity')
      .update({ explanation: null })
      .eq('org_id', ORG_ID)
      .not('explanation', 'is', null);
    if (error) { console.error('✖ Reset-feil:', error.message); process.exit(1); }
    console.log('✔ Nullstilt');
  } else {
    // Nullstill rader som allerede har ugyldig output (CJK/meta-kommentar)
    const { data: dirty } = await db
      .from('massivlust_agent_activity')
      .select('id, explanation')
      .eq('org_id', ORG_ID)
      .not('explanation', 'is', null)
      .limit(200);
    const dirtyIds = (dirty ?? []).filter((r) => !isValidExplanation(r.explanation)).map((r) => r.id);
    if (dirtyIds.length) {
      await db.from('massivlust_agent_activity').update({ explanation: null }).in('id', dirtyIds);
      console.log(`→ Nullstilte ${dirtyIds.length} rader med ugyldig forklaring`);
    }
  }

  // Hent rader uten forklaring
  const { data: rows, error: fetchErr } = await db
    .from('massivlust_agent_activity')
    .select('id, org_id, agent_id, run_id, run_label, kind, text, tool, ts')
    .eq('org_id', ORG_ID)
    .is('explanation', null)
    .order('created_at', { ascending: false })
    .limit(BATCH_SIZE);

  if (fetchErr) { console.error('✖ Fetch-feil:', fetchErr.message); process.exit(1); }
  if (!rows?.length) { console.log('✔ Ingen rader å berike'); return; }

  console.log(`→ Beriker ${rows.length} rader med ${MODEL}…`);

  // Samle unike run_id-er for kontekst-søk
  const runIds = [...new Set(rows.map((r) => r.run_id).filter(Boolean))];
  const siblingMap = new Map();

  if (runIds.length) {
    const { data: siblings } = await db
      .from('massivlust_agent_activity')
      .select('id, run_id, kind, text')
      .eq('org_id', ORG_ID)
      .in('run_id', runIds)
      .order('ts', { ascending: true });

    for (const s of siblings ?? []) {
      if (!siblingMap.has(s.run_id)) siblingMap.set(s.run_id, []);
      siblingMap.get(s.run_id).push(s);
    }
  }

  let ok = 0;
  let fail = 0;

  for (const row of rows) {
    const siblings = row.run_id ? (siblingMap.get(row.run_id) ?? []) : [];
    const prompt = buildPrompt(row, siblings);

    try {
      const explanation = await generateWithRetry(prompt);
      if (!explanation) {
        console.log(`  ⚠ ${row.id.slice(0, 8)} [${row.agent_id}/${row.kind}] → ugyldig etter 3 forsøk, hopper over`);
        fail++;
        continue;
      }
      const { error: patchErr } = await db
        .from('massivlust_agent_activity')
        .update({ explanation })
        .eq('id', row.id);

      if (patchErr) throw new Error(patchErr.message);
      console.log(`  ✔ ${row.id.slice(0, 8)} [${row.agent_id}/${row.kind}] → "${explanation}"`);
      ok++;
    } catch (e) {
      console.error(`  ✖ ${row.id.slice(0, 8)}: ${e.message}`);
      fail++;
    }
  }

  console.log(`\nFerdig: ${ok} beriket, ${fail} feilet`);
}

main().catch((e) => { console.error(e); process.exit(1); });
