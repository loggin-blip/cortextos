/**
 * Lean PDF type-tagger — 100-file review batch.
 * Writes per-file to v2_suggestions: {doc_type, project_guess, clue, snippet, test_batch}
 * Model: claude-haiku-4-5. source=pipeline_pdf_leantag.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';

// ── Singleton PID lock with liveness check ────────────────────────────────────
const PID_FILE = '/tmp/pdf-leantag.pid';
function acquireLock() {
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
      process.kill(pid, 0);
      console.error(`[LOCK] PID ${pid} is alive — exiting.`); process.exit(0);
    } catch { unlinkSync(PID_FILE); }
  }
  writeFileSync(PID_FILE, String(process.pid));
}
function releaseLock() {
  try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE); } catch {}
}
process.on('exit', releaseLock);
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
process.on('SIGINT',  () => { releaseLock(); process.exit(0); });
process.on('uncaughtException', err => { log(`[UNCAUGHT] ${err.message}`); releaseLock(); process.exit(1); });
process.on('unhandledRejection', r => { log(`[UNHANDLED] ${r instanceof Error ? r.message : String(r)}`); releaseLock(); process.exit(1); });

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';
const MODEL = 'claude-haiku-4-5';
const SOURCE = 'pipeline_pdf_leantag';
const MIN_CONFIDENCE = 0.92;
const LOG_FILE = '/tmp/pdf-leantag.log';
const DRIVE_TIMEOUT_MS = 25000;
const CONCURRENCY = 10;
const BATCH_LIMIT = 100;
const BRIDGE_MSG_ID = '1781997560372-bridge-8pl15';

let rateLimitBackoffMs = 0;
const delay = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`TIMEOUT:${label}`)), ms))]);
}

async function getPdfText(drive, fileId, mimeType) {
  try {
    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await withTimeout(
        drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' }),
        DRIVE_TIMEOUT_MS, 'exportDoc');
      return Buffer.from(res.data).toString('utf8', 0, 6000);
    }
    const res = await withTimeout(
      drive.files.get({ fileId, supportsAllDrives: true, alt: 'media' }, { responseType: 'arraybuffer' }),
      DRIVE_TIMEOUT_MS, 'getPdfMedia');
    return Buffer.from(res.data).toString('utf8', 0, 6000)
      .replace(/[^\x20-\x7E\xA0-\xFF\n\r\t]/g, ' ')
      .replace(/\s{3,}/g, '  ');
  } catch { return null; }
}

function buildPrompt(file, textContent) {
  return `Du er dokumentklassifiserer for Massivlust AS (norsk massivtre/CLT-byggefirma).

Fil: ${file.file_name}
Mappe: ${file.current_drive_folder_path || file.current_drive_folder_name || 'ukjent'}${file.gmail_subject ? `\nE-post emne: "${file.gmail_subject}"` : ''}${file.gmail_from ? `\nFra: ${file.gmail_from}` : ''}

TEKST (side 1-2):
${textContent ? textContent.slice(0, 5000) : '[Ingen tekst — bruk filnavn og mappe]'}

OPPGAVE:
1. DOKUMENTTYPE — velg ÉN: faktura | tegning | tilbud | kontrakt | KS | avvik | HMS | rapport | sertifikat | FDV | brev | dagrapport | annet
2. PROSJEKT-HINT — hvis teksten tydelig nevner prosjektnavn, adresse, P-nummer: skriv det. Ellers null.
3. LEDETRÅD — 1 setning: hva i teksten avgjorde typen? (f.eks. "Har fakturanr og mva-beløp", "Tegningstittel og revisjonsboks", "Ingen tekst — kun filnavn")
4. PERSONLIG — true kun hvis privat dokument (bank/helse/NAV/forsikring privatperson)

Returner KUN JSON:
{"doc_type":"<type>","doc_type_confidence":0.0-1.0,"project_guess":"<tekst-hint eller null>","clue":"<1 setning>","is_personal":false,"confidence":0.0-1.0}`;
}

function callClaudeAsync(prompt) {
  return new Promise(resolve => {
    const proc = spawn('/opt/homebrew/bin/claude', [
      '--print', '--model', MODEL, '--dangerously-skip-permissions', '--output-format', 'json'
    ]);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const killer = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 60000);
    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();
    proc.on('close', code => {
      clearTimeout(killer);
      if (code !== 0) {
        const lower = (out + err).toLowerCase();
        if (lower.includes('rate') || lower.includes('429') || lower.includes('overload')) {
          rateLimitBackoffMs = Math.min((rateLimitBackoffMs || 1000) * 2, 30000);
          log(`[RATE-LIMIT] backoff ${rateLimitBackoffMs}ms`);
        }
        resolve(null); return;
      }
      try {
        const j = JSON.parse(out.trim());
        let text = (j.result || out).replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        const i = text.indexOf('{');
        if (i < 0) { resolve(null); return; }
        const parsed = JSON.parse(text.slice(i, text.lastIndexOf('}') + 1));
        parsed._cost = j.total_cost_usd;
        if (parsed._cost && rateLimitBackoffMs > 0) rateLimitBackoffMs = Math.max(rateLimitBackoffMs / 2, 0);
        resolve(parsed);
      } catch { resolve(null); }
    });
    proc.on('error', () => { clearTimeout(killer); resolve(null); });
  });
}

async function callWithBackoff(prompt) {
  if (rateLimitBackoffMs > 0) await delay(rateLimitBackoffMs);
  return callClaudeAsync(prompt);
}

async function processFile(file, drive, stats, rawTextStore) {
  stats.attempted++;
  try {
    const rawText = file.drive_file_id ? await getPdfText(drive, file.drive_file_id, file.mime_type) : null;
    const snippet = (rawText || '').slice(0, 250).trim() || null;
    rawTextStore[file.id] = snippet;

    const result = await callWithBackoff(buildPrompt(file, rawText));

    const suggestions = {
      doc_type: result?.doc_type ?? null,
      project_guess: result?.project_guess ?? null,
      clue: result?.clue ?? null,
      snippet,
      test_batch: 'leantag100',
    };

    const update = {
      v2_model: MODEL,
      v2_confidence: result?.confidence ?? null,
      v2_is_personal: result?.is_personal ?? false,
      v2_processed_at: new Date().toISOString(),
      document_type: result?.doc_type ?? null,
      document_type_confidence: result?.doc_type_confidence ?? null,
      document_type_method: SOURCE,
      v2_suggestions: JSON.stringify(suggestions),
    };

    await supabase.from('massivlust_unclassified_files').update(update).eq('id', file.id);

    stats.processed++;
    stats.totalCost += result?._cost || 0;
    if (result) stats.typed++; else stats.noResult++;
    if (result?.doc_type) stats.docTypes[result.doc_type] = (stats.docTypes[result.doc_type] || 0) + 1;
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
  async function worker() { while (idx < items.length) { const i = idx++; await fn(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function sendBridge(msg) {
  try {
    const { execSync } = await import('child_process');
    execSync(`cortextos bus send-message bridge normal ${JSON.stringify(msg)} ${BRIDGE_MSG_ID}`, { encoding: 'utf-8' });
    log('Bridge rapport sendt.');
  } catch (e) { log(`Bridge feilet: ${e.message?.slice(0, 80)}`); }
}

async function main() {
  acquireLock();
  log(`=== PDF LEANTAG 100 — Haiku concurrency=${CONCURRENCY} | PID=${process.pid} ===`);

  const drive = makeDrive();
  const { data: files, error } = await supabase
    .from('massivlust_unclassified_files')
    .select('id, file_name, drive_file_id, mime_type, current_drive_folder_name, current_drive_folder_path, gmail_subject, gmail_from')
    .eq('status', 'needs_review').eq('mime_type', 'application/pdf')
    .order('id', { ascending: true }).range(0, BATCH_LIMIT - 1);

  if (error) { log(`DB error: ${error.message}`); releaseLock(); process.exit(1); }
  log(`Fetched ${files?.length || 0} PDFs`);

  const stats = {
    attempted: 0, processed: 0, typed: 0, noResult: 0,
    errors: 0, totalCost: 0, docTypes: {}, startTime: Date.now(),
  };
  const rawTextStore = {};

  await processWithConcurrency(files, CONCURRENCY, f => processFile(f, drive, stats, rawTextStore));

  const elapsed = (Date.now() - stats.startTime) / 60000;
  const rate = (stats.attempted / Math.max(elapsed, 0.01)).toFixed(1);
  const topTypes = Object.entries(stats.docTypes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(', ');

  log(`=== FERDIG 100 === rate=${rate}/min cost=$${stats.totalCost.toFixed(4)} per=$${(stats.totalCost / Math.max(stats.processed, 1)).toFixed(4)}`);
  log(`dok-typer: ${topTypes}`);

  try {
    await supabase.from('massivlust_sync_runs').insert({
      source: SOURCE, status: 'success',
      started_at: new Date(stats.startTime).toISOString(),
      ended_at: new Date().toISOString(),
      rows_in: BATCH_LIMIT, rows_upserted: stats.typed,
      rows_failed: stats.errors, org_id: 'massivlust',
    });
  } catch {}

  const finalMsg = `PDF LEANTAG 100 FERDIG (${SOURCE})

Behandlet: ${stats.attempted}/100 | Rate: ${rate} PDF/min | ${elapsed.toFixed(1)} min
Dok-typer: ${topTypes}
Typet: ${stats.typed} | Ingen resultat: ${stats.noResult} | Feil: ${stats.errors}
Kostnad: $${stats.totalCost.toFixed(4)} totalt | $${(stats.totalCost / Math.max(stats.processed, 1)).toFixed(4)}/PDF

Alle 100 har v2_suggestions={doc_type, project_guess, clue, snippet, test_batch:'leantag100'} + v2_model=claude-haiku-4-5.
Klar for din gjennomgang — gi GO når du vil skalere.`;

  await sendBridge(finalMsg);
}

main().catch(err => { log(`Fatal: ${err.message}`); releaseLock(); process.exit(1); });
