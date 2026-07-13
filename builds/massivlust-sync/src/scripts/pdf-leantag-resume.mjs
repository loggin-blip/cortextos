/**
 * PDF lean type-tagger RESUME — picks up where leantag_full stopped.
 * Scope: PDF + status IN (needs_review, classified, business_admin) + no leantag doc_type yet.
 * Processes needs_review first, then classified, then business_admin.
 * Critical: no offset pagination (always re-queries scope), rate-limit retry, count-verified done.
 * source=pipeline_pdf_leantag_resume
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';

// ── Singleton PID lock with liveness check ────────────────────────────────────
const PID_FILE = '/tmp/pdf-leantag-resume.pid';
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
const SOURCE = 'pipeline_pdf_leantag_resume';
const MIN_CONFIDENCE = 0.92;
const LOG_FILE = '/tmp/pdf-leantag-resume.log';
const DRIVE_TIMEOUT_MS = 25000;
const MAX_CONCURRENCY = 2; // Hard cap — reduced per Max request
const BRIDGE_MSG_ID = '1782065334862-bridge-re61m';

// needs_review already done — only classified + business_admin remain
const STATUS_GROUPS = ['classified', 'business_admin'];

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
1. DOKUMENTTYPE — velg ÉN: faktura | tegning | tilbud | kontrakt | KS | avvik | HMS | rapport | sertifikat | FDV | brev | dagrapport | bestilling | kvittering | annet
2. PROSJEKT-HINT — hvis teksten tydelig nevner prosjektnavn, adresse eller P-nummer: skriv det. Ellers null.
3. LEDETRÅD — 1 setning: hva i teksten avgjorde typen.
4. PERSONLIG — true kun hvis privat dokument (bank/helse/NAV/forsikring privatperson).

Returner KUN JSON:
{"doc_type":"<type>","doc_type_confidence":0.0-1.0,"project_guess":"<tekst-hint eller null>","clue":"<1 setning>","is_personal":false,"confidence":0.0-1.0}`;
}

// Try once, returns parsed result or null
function callClaudeOnce(prompt) {
  return new Promise(resolve => {
    const proc = spawn('/opt/homebrew/bin/claude', [
      '--print', '--model', MODEL, '--dangerously-skip-permissions', '--output-format', 'json'
    ]);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const killer = setTimeout(() => { proc.kill('SIGKILL'); resolve({ result: null, rateLimited: false }); }, 60000);
    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();
    proc.on('close', code => {
      clearTimeout(killer);
      if (code !== 0) {
        const lower = (out + err).toLowerCase();
        const rateLimited = lower.includes('rate') || lower.includes('429') || lower.includes('overload');
        resolve({ result: null, rateLimited });
        return;
      }
      try {
        const j = JSON.parse(out.trim());
        let text = (j.result || out).replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        const i = text.indexOf('{');
        if (i < 0) { resolve({ result: null, rateLimited: false }); return; }
        const parsed = JSON.parse(text.slice(i, text.lastIndexOf('}') + 1));
        parsed._cost = j.total_cost_usd;
        resolve({ result: parsed, rateLimited: false });
      } catch { resolve({ result: null, rateLimited: false }); }
    });
    proc.on('error', () => { clearTimeout(killer); resolve({ result: null, rateLimited: false }); });
  });
}

// Call with exponential backoff + retry on rate limit
async function callClaude(prompt) {
  if (rateLimitBackoffMs > 0) {
    log(`[BACKOFF] waiting ${rateLimitBackoffMs}ms before call`);
    await delay(rateLimitBackoffMs);
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const { result, rateLimited } = await callClaudeOnce(prompt);
    if (result) {
      if (rateLimitBackoffMs > 0) rateLimitBackoffMs = Math.max(rateLimitBackoffMs / 2, 0);
      return result;
    }
    if (rateLimited) {
      rateLimitBackoffMs = Math.min((rateLimitBackoffMs || 2000) * 2, 120000);
      log(`[RATE-LIMIT] attempt ${attempt}/3 — backoff ${rateLimitBackoffMs}ms`);
      await delay(rateLimitBackoffMs);
    } else if (attempt < 3) {
      await delay(3000);
    }
  }
  return null;
}

function resolveProjectId(hint, projects) {
  if (!hint) return null;
  const h = hint.toLowerCase();
  return projects.find(p =>
    (p.name && h.includes(p.name.toLowerCase())) ||
    (p.address && p.address.length > 5 && h.includes(p.address.toLowerCase().split(',')[0])) ||
    (p.tripletex_project_id && h.includes(String(p.tripletex_project_id)))
  )?.id || null;
}

async function countRemaining(statuses) {
  const { count } = await supabase
    .from('massivlust_unclassified_files')
    .select('id', { count: 'exact', head: true })
    .eq('mime_type', 'application/pdf')
    .in('status', statuses)
    .or('document_type.is.null,document_type_method.not.like.%leantag%');
  return count || 0;
}

async function processFile(file, drive, projects, stats) {
  stats.attempted++;
  try {
    const rawText = file.drive_file_id ? await getPdfText(drive, file.drive_file_id, file.mime_type) : null;
    const snippet = (rawText || '').slice(0, 250).trim() || null;

    const result = await callClaude(buildPrompt(file, rawText));

    const projectId = result?.project_guess ? resolveProjectId(result.project_guess, projects) : null;

    const suggestions = {
      doc_type: result?.doc_type ?? null,
      project_guess: result?.project_guess ?? null,
      clue: result?.clue ?? null,
      snippet,
      source: SOURCE,
    };

    const update = {
      v2_model: MODEL,
      v2_confidence: result?.confidence ?? null,
      v2_is_personal: result?.is_personal ?? false,
      v2_project_id: projectId ?? file.v2_project_id ?? null,
      v2_processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), // bump so Supabase progress is visible
      document_type: result?.doc_type ?? null,
      document_type_confidence: result?.doc_type_confidence ?? null,
      document_type_method: SOURCE,
      v2_suggestions: JSON.stringify(suggestions),
    };

    // Only change status for needs_review files (leave classified/business_admin as-is)
    if (file.status === 'needs_review') {
      if (result?.confidence >= MIN_CONFIDENCE && projectId) {
        update.status = result.is_personal ? 'personal' : 'classified';
      } else if (result?.is_personal === true && result?.confidence >= MIN_CONFIDENCE) {
        update.status = 'personal';
      }
    }

    await supabase.from('massivlust_unclassified_files').update(update).eq('id', file.id);

    stats.processed++;
    stats.totalCost += result?._cost || 0;
    if (update.status === 'classified') stats.classified++;
    else if (update.status === 'personal') stats.personal++;
    else if (result) stats.typed++;
    else stats.noResult++;
    if (projectId) stats.withProject++;
    if (result?.doc_type) stats.docTypes[result.doc_type] = (stats.docTypes[result.doc_type] || 0) + 1;
  } catch (err) {
    log(`[ERR] ${file.file_name}: ${err.message?.slice(0, 80)}`);
    stats.errors++;
  }
}

async function processWithConcurrency(items, fn) {
  // Worker pool capped at MAX_CONCURRENCY — never spawns more than 3 claude --print
  let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; await fn(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, worker));
}

async function sendBridge(msg) {
  try {
    const { execSync } = await import('child_process');
    execSync(`cortextos bus send-message bridge normal ${JSON.stringify(msg)} ${BRIDGE_MSG_ID}`, { encoding: 'utf-8' });
    log('Bridge rapport sendt.');
  } catch (e) { log(`Bridge feilet: ${e.message?.slice(0, 80)}`); }
}

async function processGroup(statusLabel, drive, projects, stats) {
  log(`--- Starter gruppe: ${statusLabel} ---`);
  let batchCount = 0;

  while (true) {
    // Always re-query from top of unprocessed — no offset drift
    const { data: files, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, drive_file_id, mime_type, current_drive_folder_name, current_drive_folder_path, gmail_subject, gmail_from, status, v2_project_id')
      .eq('mime_type', 'application/pdf')
      .eq('status', statusLabel)
      .or('document_type.is.null,document_type_method.not.like.%leantag%')
      .order('id', { ascending: true })
      .limit(100);

    if (error) { log(`DB error: ${error.message}`); break; }
    if (!files?.length) {
      // Confirm with a fresh count
      const remaining = await countRemaining([statusLabel]);
      if (remaining === 0) {
        log(`Gruppe ${statusLabel} FERDIG — count bekreftet 0`);
        break;
      }
      log(`[WARN] Query tom men count=${remaining} — venter 10s og prøver igjen`);
      await delay(10000);
      continue;
    }

    batchCount += files.length;
    await processWithConcurrency(files, f => processFile(f, drive, projects, stats));

    const elapsed = (Date.now() - stats.startTime) / 60000;
    const rate = (stats.attempted / Math.max(elapsed, 0.01)).toFixed(1);
    log(`[PROGRESS] ${stats.attempted} tot | ${statusLabel} batch+${files.length} | ${rate}/min | typed=${stats.typed} classified=${stats.classified} proj=${stats.withProject} err=${stats.errors} $${stats.totalCost.toFixed(2)}`);

    // Progress bridge every 500
    if (Math.floor(stats.attempted / 500) > Math.floor((stats.attempted - files.length) / 500)) {
      const topTypes = Object.entries(stats.docTypes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(', ');
      await sendBridge(`PDF LEANTAG RESUME — FREMDRIFT @${stats.attempted} (${SOURCE})

Status nå: ${statusLabel} | Rate: ${rate} PDF/min | $${stats.totalCost.toFixed(2)} totalt
Dok-typer: ${topTypes}
Typet: ${stats.typed} | Klassifisert: ${stats.classified} | Med prosjekt: ${stats.withProject} | Feil: ${stats.errors}`);
    }
  }
}

async function main() {
  acquireLock();
  log(`=== PDF LEANTAG RESUME — Haiku MAX_CONCURRENCY=${MAX_CONCURRENCY} | PID=${process.pid} ===`);

  const drive = makeDrive();

  const { data: projectRows } = await supabase.from('massivlust_projects')
    .select('id, name, address, tripletex_project_id');
  const projects = projectRows || [];
  log(`Projects: ${projects.length}`);

  // Log initial scope
  for (const s of STATUS_GROUPS) {
    const { count } = await supabase.from('massivlust_unclassified_files')
      .select('id', { count: 'exact', head: true })
      .eq('mime_type', 'application/pdf').eq('status', s)
      .or('document_type.is.null,document_type_method.not.like.%leantag%');
    log(`Scope ${s}: ${count}`);
  }

  const stats = {
    attempted: 0, processed: 0, classified: 0, personal: 0,
    typed: 0, noResult: 0, withProject: 0,
    errors: 0, totalCost: 0, docTypes: {}, startTime: Date.now(),
  };

  for (const statusGroup of STATUS_GROUPS) {
    await processGroup(statusGroup, drive, projects, stats);
  }

  // Final count verification
  const finalRemaining = await countRemaining(STATUS_GROUPS);
  const elapsed = (Date.now() - stats.startTime) / 60000;
  const rate = (stats.attempted / Math.max(elapsed, 0.01)).toFixed(1);
  const topTypes = Object.entries(stats.docTypes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(', ');

  log(`\n=== FERDIG === gjenstående i scope: ${finalRemaining} | rate=${rate}/min cost=$${stats.totalCost.toFixed(3)}`);
  log(`dok-typer: ${topTypes}`);

  try {
    await supabase.from('massivlust_sync_runs').insert({
      source: SOURCE, status: finalRemaining === 0 ? 'success' : 'partial',
      started_at: new Date(stats.startTime).toISOString(),
      ended_at: new Date().toISOString(),
      rows_in: stats.attempted,
      rows_upserted: stats.typed + stats.classified + stats.personal,
      rows_failed: stats.errors,
      org_id: 'massivlust',
    });
  } catch {}

  await sendBridge(`PDF LEANTAG RESUME FERDIG (${SOURCE})

Behandlet: ${stats.attempted} | Rate: ${rate} PDF/min | ${elapsed.toFixed(1)} min
Gjenstående i scope (count-verifisert): ${finalRemaining}
Dok-typer: ${topTypes}
Typet: ${stats.typed} | Klassifisert: ${stats.classified} | Personlig: ${stats.personal}
Med prosjekt-hint: ${stats.withProject} | Ingen resultat: ${stats.noResult} | Feil: ${stats.errors}
Kostnad: $${stats.totalCost.toFixed(3)} | $${(stats.totalCost / Math.max(stats.processed, 1)).toFixed(4)}/PDF`);
}

main().catch(err => { log(`Fatal: ${err.message}`); releaseLock(); process.exit(1); });
