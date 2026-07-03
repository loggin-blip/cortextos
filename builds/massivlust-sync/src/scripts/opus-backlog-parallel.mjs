/**
 * Opus parallel reclassification — concurrency=10 worker pool.
 * Uses spawn (async, non-blocking) instead of execSync.
 * source=pipeline_opus_parallel
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Singleton PID lock ────────────────────────────────────────────────────────
const PID_FILE = '/tmp/opus-backlog.pid';
function acquireLock() {
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
      process.kill(pid, 0); // throws ESRCH if dead
      console.error(`[LOCK] PID ${pid} is alive — exiting.`);
      process.exit(0);
    } catch {
      unlinkSync(PID_FILE); // stale — delete and continue
    }
  }
  writeFileSync(PID_FILE, String(process.pid));
}
function releaseLock() {
  try {
    if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE);
  } catch {}
}
process.on('exit', releaseLock);
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
process.on('SIGINT',  () => { releaseLock(); process.exit(0); });
process.on('uncaughtException', (err) => {
  log(`[UNCAUGHT] ${err.message}`);
  releaseLock(); process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log(`[UNHANDLED] ${reason instanceof Error ? reason.message : String(reason)}`);
  releaseLock(); process.exit(1);
});

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';
const MODEL = 'claude-opus-4-7';
const MODEL_FALLBACK = 'claude-sonnet-4-6';
const MIN_CONFIDENCE = 0.92;
const LOG_FILE = '/tmp/opus-parallel.log';
const DRIVE_TIMEOUT_MS = 25000;

const args = process.argv.slice(2);
const TEST_MODE = args.includes('--test');
const TEST_LIMIT = 50;
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '10');

let rateLimitHits = 0;
let rateLimitBackoffMs = 500;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// No hard deadline for daytime run — bridge controls stop via kill
function pastDeadline() { return false; }

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT:${label}`)), ms)),
  ]);
}

// Async non-blocking claude call via spawn
function callClaudeAsync(prompt, model) {
  return new Promise((resolve) => {
    const proc = spawn('/opt/homebrew/bin/claude', [
      '--print', '--model', model, '--output-format', 'json', '--dangerously-skip-permissions',
    ]);

    let out = '';
    let err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });

    const killer = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 90000);

    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();

    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) {
        const lower = (out + err).toLowerCase();
        if (lower.includes('rate') || lower.includes('429') || lower.includes('overload') || lower.includes('capacity')) {
          rateLimitHits++;
          rateLimitBackoffMs = Math.min(rateLimitBackoffMs * 2, 30000);
          log(`[RATE-LIMIT] hit #${rateLimitHits} — backoff now ${rateLimitBackoffMs}ms`);
        }
        resolve(null);
        return;
      }
      try {
        let text = out.trim();
        try {
          const env = JSON.parse(text);
          if (env.is_error) { resolve(null); return; }
          if (env.result) text = env.result;
        } catch {}
        text = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        const i = text.indexOf('{');
        if (i < 0) { resolve(null); return; }
        resolve(JSON.parse(text.slice(i, text.lastIndexOf('}') + 1)));
      } catch {
        resolve(null);
      }
    });

    proc.on('error', () => { clearTimeout(killer); resolve(null); });
  });
}

async function callClaudeWithBackoff(prompt, model) {
  if (rateLimitBackoffMs > 500) await delay(Math.min(rateLimitBackoffMs, 30000));
  let result = await callClaudeAsync(prompt, model);
  if (!result && rateLimitHits === 0) {
    await delay(1500);
    result = await callClaudeAsync(prompt, MODEL_FALLBACK);
  }
  if (result) rateLimitBackoffMs = Math.max(rateLimitBackoffMs / 2, 500);
  return result;
}

async function getPdfText(drive, fileId, mimeType) {
  try {
    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await withTimeout(
        drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' }),
        DRIVE_TIMEOUT_MS, 'exportDoc'
      );
      return Buffer.from(res.data).toString('utf8', 0, 8000);
    }
    const res = await withTimeout(
      drive.files.get({ fileId, supportsAllDrives: true, alt: 'media' }, { responseType: 'arraybuffer' }),
      DRIVE_TIMEOUT_MS, 'getPdfMedia'
    );
    return Buffer.from(res.data).toString('utf8', 0, 8000).replace(/[^\x20-\x7E\xA0-\xFF\n\r]/g, ' ');
  } catch { return null; }
}

function buildPrompt(file, projects) {
  const sug = (() => {
    try {
      const raw = typeof file.v2_suggestions === 'string' ? JSON.parse(file.v2_suggestions) : file.v2_suggestions;
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  })();
  const topProjects = sug.slice(0, 3).map(s => {
    const p = projects.find(p => p.id === s.project_id || p.name === s.project_name);
    return p ? `  • ${p.name} (${p.id})` : null;
  }).filter(Boolean).join('\n') || '  (ingen)';

  return `Du er klassifiseringsagent for Massivlust AS (norsk massivtre/CLT-byggefirma).

Fil: ${file.file_name}
Type: ${file.mime_type}
Mappe: ${file.current_drive_folder_path || file.current_drive_folder_name || 'ukjent'}
${file.gmail_subject ? `E-post emne: "${file.gmail_subject}"` : ''}
${file.gmail_from ? `Fra: ${file.gmail_from}` : ''}

Topp prosjekt-kandidater:
${topProjects}

PROSJEKTER: ${projects.map(p => p.name).slice(0, 15).join(', ')}...

${file._text ? `INNHOLD:\n${file._text.slice(0, 4000)}` : '[Ingen tekst — bruk filnavn og kontekst]'}

OPPGAVE: Klassifiser for Massivlust AS.
- Prosjektdokument (kontrakt, KS, avvik, tegning, tilbud, faktura, HMS) → is_personal=false, project_id fra kandidater
- Bransjerelatert uten prosjekt → is_personal=false, project_id=null
- Privat (bank, NAV, helse, forsikring, kvittering privat) → is_personal=true, project_id=null

Returner KUN JSON:
{"is_personal": true/false, "project_id": "<uuid eller null>", "confidence": 0.0-1.0, "reason": "<15-25 ord>"}`;
}

async function processFile(file, drive, projects, stats) {
  stats.attempted++;
  try {
    const isPdf = file.mime_type === 'application/pdf'
      || file.mime_type?.startsWith('text/')
      || file.mime_type === 'application/vnd.google-apps.document';
    if (isPdf && file.drive_file_id) {
      file._text = await getPdfText(drive, file.drive_file_id, file.mime_type);
    }

    const prompt = buildPrompt(file, projects);
    const result = await callClaudeWithBackoff(prompt, MODEL);

    const update = {
      v2_model: MODEL,
      v2_confidence: result?.confidence ?? null,
      v2_is_personal: result?.is_personal ?? null,
      v2_project_id: result?.project_id ?? null,
      v2_processed_at: new Date().toISOString(),
    };

    let finalStatus = 'needs_review';
    if (result && result.confidence >= MIN_CONFIDENCE) {
      update.status = result.is_personal ? 'personal' : 'classified';
      finalStatus = update.status;
    }

    await supabase.from('massivlust_unclassified_files').update(update).eq('id', file.id);

    stats.processed++;
    if (finalStatus === 'classified') stats.classified++;
    else if (finalStatus === 'personal') stats.personal++;
    else if (result) stats.lowConf++;
    else stats.unsure++;
  } catch (err) {
    log(`[ERR] ${file.file_name}: ${err.message?.slice(0, 80)}`);
    stats.errors++;
    try {
      await supabase.from('massivlust_unclassified_files')
        .update({ v2_model: MODEL, v2_processed_at: new Date().toISOString() })
        .eq('id', file.id);
    } catch {}
  }
}

async function processWithConcurrency(items, concurrency, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function run(drive, projects, stats) {
  let offset = 0;
  const BATCH_FETCH = 100;

  while (true) {
    if (pastDeadline()) { log('06:00 DEADLINE'); break; }
    if (TEST_MODE && stats.attempted >= TEST_LIMIT) { log(`TEST LIMIT ${TEST_LIMIT} reached`); break; }

    const fetchLimit = TEST_MODE
      ? Math.min(BATCH_FETCH, TEST_LIMIT - stats.attempted)
      : BATCH_FETCH;

    const { data: files, error } = await supabase
      .from('massivlust_unclassified_files')
      .select(`id, file_name, drive_file_id, source_type, mime_type,
        current_drive_folder_name, current_drive_folder_path,
        gmail_subject, gmail_from, v2_suggestions`)
      .eq('status', 'needs_review')
      .order('id', { ascending: true })
      .range(offset, offset + fetchLimit - 1);

    if (error) { log(`DB error: ${error.message}`); break; }
    if (!files?.length) { log('Queue empty — done'); break; }

    await processWithConcurrency(files, CONCURRENCY, (f) => processFile(f, drive, projects, stats));

    offset += files.length;

    const elapsedMin = (Date.now() - stats.startTime) / 60000;
    const rate = stats.attempted / Math.max(elapsedMin, 0.01);
    log(`[PROGRESS] ${stats.attempted} attempted (${stats.processed} ok) | ${rate.toFixed(1)}/min | classified=${stats.classified} personal=${stats.personal} lowConf=${stats.lowConf} err=${stats.errors} rl=${rateLimitHits}`);

    if (pastDeadline()) break;
  }
}

async function main() {
  acquireLock();
  log(`=== OPUS PARALLEL — concurrency=${CONCURRENCY} ${TEST_MODE ? 'TEST(50)' : 'FULL'} | PID=${process.pid} ===`);

  const drive = makeDrive();
  const { data: projectRows } = await supabase.from('massivlust_projects').select('id, name, address');
  const projects = projectRows || [];
  log(`Loaded ${projects.length} projects`);

  const { count: totalNR } = await supabase
    .from('massivlust_unclassified_files')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'needs_review');
  log(`needs_review: ${totalNR}`);

  const stats = { processed: 0, attempted: 0, classified: 0, personal: 0, lowConf: 0, unsure: 0, errors: 0, startTime: Date.now() };

  await run(drive, projects, stats);

  const elapsedMin = (Date.now() - stats.startTime) / 60000;
  const rate = stats.processed / Math.max(elapsedMin, 0.01);

  log('\n=== FERDIG ===');
  log(`Behandlet:    ${stats.processed}`);
  log(`Klassifisert: ${stats.classified}`);
  log(`Personlig:    ${stats.personal}`);
  log(`Lav konf:     ${stats.lowConf}`);
  log(`Feil:         ${stats.errors}`);
  log(`Rate:         ${rate.toFixed(1)} filer/min`);
  log(`Rate-limits:  ${rateLimitHits}`);
  log(`Tid:          ${elapsedMin.toFixed(1)} min`);

  try {
    await supabase.from('massivlust_sync_runs').insert({
      source: 'pipeline_opus_parallel',
      status: stats.errors < 10 ? 'success' : 'partial',
      started_at: new Date(stats.startTime).toISOString(),
      ended_at: new Date().toISOString(),
      rows_in: totalNR || 0,
      rows_upserted: stats.classified + stats.personal,
      rows_failed: stats.errors,
      org_id: 'massivlust',
    });
  } catch {}

  const finalMsg = `OPUS PARALLEL ${TEST_MODE ? 'TEST' : 'FERDIG'} (pipeline_opus_parallel)

Behandlet: ${stats.processed} | Rate: ${rate.toFixed(1)}/min
Klassifisert (≥0.92): ${stats.classified}
Personlig (≥0.92): ${stats.personal}
Lav konf: ${stats.lowConf}
Feil: ${stats.errors}
Rate-limits: ${rateLimitHits}
Tid: ${elapsedMin.toFixed(1)} min
Concurrency: ${CONCURRENCY}`;

  try {
    const { execSync } = await import('child_process');
    execSync(`cortextos bus send-message bridge normal ${JSON.stringify(finalMsg)} 1781612216278-bridge-7ij2z`, { encoding: 'utf-8' });
  } catch {}
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  releaseLock(); process.exit(1);
});
