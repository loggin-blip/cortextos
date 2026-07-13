/**
 * PDF text classifier — reads PDF text via Drive + classifies with claude CLI.
 * Writes: v2_project_id, v2_confidence, v2_model, document_type, document_type_confidence.
 * source=pipeline_pdf_text
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';

// ── Singleton PID lock with liveness check ───────────────────────────────────
const PID_FILE = '/tmp/pdf-classify.pid';
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
const MODEL = 'claude-sonnet-4-6';
const MODEL_FALLBACK = 'claude-haiku-4-5-20251001';
const MIN_CONFIDENCE = 0.92;
const LOG_FILE = './secrets/pdf-classify.log';
const DRIVE_TIMEOUT_MS = 25000;
const SOURCE = 'pipeline_pdf_text';

const args = process.argv.slice(2);
const TEST_MODE = args.includes('--test');
const TEST_LIMIT = 50;
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '10');

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
      return Buffer.from(res.data).toString('utf8', 0, 8000);
    }
    const res = await withTimeout(
      drive.files.get({ fileId, supportsAllDrives: true, alt: 'media' }, { responseType: 'arraybuffer' }),
      DRIVE_TIMEOUT_MS, 'getPdfMedia');
    return Buffer.from(res.data).toString('utf8', 0, 8000).replace(/[^\x20-\x7E\xA0-\xFF\n\r\t]/g, ' ').replace(/\s{3,}/g, '  ');
  } catch { return null; }
}

function buildPrompt(file, projects, textContent) {
  const sug = (() => {
    try {
      const raw = typeof file.v2_suggestions === 'string' ? JSON.parse(file.v2_suggestions) : file.v2_suggestions;
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  })();

  const topCandidates = sug.slice(0, 3).map(s => {
    const p = projects.find(p => p.id === s.project_id || p.name === s.project_name);
    if (!p) return null;
    const lines = [`  • ${p.name} (id: ${p.id})`];
    if (p.address) lines.push(`    Adresse: ${p.address}`);
    if (p.oppdragsgiver || p.customer) lines.push(`    Oppdragsgiver/kunde: ${p.oppdragsgiver || p.customer}`);
    if (p.oppdragsgiver_kontakt || p.customer_contact) lines.push(`    Kontakt: ${p.oppdragsgiver_kontakt || p.customer_contact}`);
    if (p.leverandor) lines.push(`    Leverandør: ${p.leverandor}`);
    if (p.pl_name) lines.push(`    PL: ${p.pl_name}`);
    if (p.tripletex_project_id) lines.push(`    P-nr: ${p.tripletex_project_id}`);
    return lines.join('\n');
  }).filter(Boolean).join('\n') || '  (ingen kandidater)';

  const allProjectNames = projects.map(p => p.name).join(', ');

  return `Du er klassifiseringsagent for Massivlust AS (norsk massivtre/CLT-byggefirma).

DOKUMENT:
Fil: ${file.file_name}
Mappe: ${file.current_drive_folder_path || file.current_drive_folder_name || 'ukjent'}${file.gmail_subject ? `\nE-post emne: "${file.gmail_subject}"` : ''}${file.gmail_from ? `\nFra: ${file.gmail_from}` : ''}

TOPP PROSJEKT-KANDIDATER (basert på mappe og metadata):
${topCandidates}

ALLE MASSIVLUST-PROSJEKTER: ${allProjectNames}

DOKUMENTTEKST (side 1-2):
${textContent ? textContent.slice(0, 6000) : '[Ingen tekst tilgjengelig — bruk filnavn, mappe og kontekst]'}

RESONNERING — tenk steg for steg:
1. Hva slags dokument er dette? (faktura, tegning, KS-rapport, sertifikat, brev osv.)
2. Hvilke ledetråder finnes i teksten? (adresse, prosjektnr/P-nr, kundenavn, leverandørnavn, dato, stedsnavn)
3. Stemmer noen ledetråd med topp-kandidatenes adresse, oppdragsgiver, leverandør eller P-nr?
4. Er dokumentet privat (bank, NAV, helse, forsikring, privatperson)? Eller firma-bredt uten prosjekttilknytning (sertifikat, HMS-plan, mal)?

KLASSIFIKASJONSREGLER:
- Klar kobling til et prosjekt (adresse, navn, P-nr, leverandør) → project_id satt, confidence 0.85+
- Firma-bredt uten prosjekt (sertifikater, generelle maler) → is_personal=false, project_id=null
- Privat dokument → is_personal=true, project_id=null
- Usikker/ingen ledetråd → project_id=null, confidence <0.7

Dokumenttype (velg ÉN): faktura | KS | avvik | tegning | tilbud | kontrakt | HMS | dagrapport | rapport | sertifikat | brev | epost | NS-standard | annet

Returner KUN JSON (ingen tekst utenfor JSON):
{"is_personal":false,"project_id":"<uuid eller null>","confidence":0.0-1.0,"doc_type":"<type>","doc_type_confidence":0.0-1.0,"reason":"<maks 15 ord: hvilken ledetråd avgjorde>"}`;
}

function callClaudeAsync(prompt, model) {
  return new Promise(resolve => {
    const proc = spawn('/opt/homebrew/bin/claude', [
      '--print', '--model', model, '--dangerously-skip-permissions', '--output-format', 'json'
    ]);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const killer = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 90000);
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
        parsed._model = model;
        if (parsed._cost && rateLimitBackoffMs > 0) rateLimitBackoffMs = Math.max(rateLimitBackoffMs / 2, 0);
        resolve(parsed);
      } catch { resolve(null); }
    });
    proc.on('error', () => { clearTimeout(killer); resolve(null); });
  });
}

async function callWithBackoff(prompt) {
  if (rateLimitBackoffMs > 0) await delay(rateLimitBackoffMs);
  let r = await callClaudeAsync(prompt, MODEL);
  if (!r) { await delay(2000); r = await callClaudeAsync(prompt, MODEL_FALLBACK); }
  return r;
}

async function processFile(file, drive, projects, stats) {
  stats.attempted++;
  try {
    const text = file.drive_file_id ? await getPdfText(drive, file.drive_file_id, file.mime_type) : null;
    const result = await callWithBackoff(buildPrompt(file, projects, text));

    const update = {
      v2_model: result?._model || MODEL,
      v2_confidence: result?.confidence ?? null,
      v2_is_personal: result?.is_personal ?? null,
      v2_project_id: result?.project_id ?? null,
      v2_processed_at: new Date().toISOString(),
      document_type: result?.doc_type ?? null,
      document_type_confidence: result?.doc_type_confidence ?? null,
      document_type_method: SOURCE,
    };
    if (result?.confidence >= MIN_CONFIDENCE) update.status = result.is_personal ? 'personal' : 'classified';

    await supabase.from('massivlust_unclassified_files').update(update).eq('id', file.id);

    stats.processed++;
    stats.totalCost += result?._cost || 0;
    const st = update.status;
    if (st === 'classified') stats.classified++;
    else if (st === 'personal') stats.personal++;
    else if (result) stats.lowConf++;
    else stats.noResult++;
    if (result?.doc_type) stats.docTypes[result.doc_type] = (stats.docTypes[result.doc_type] || 0) + 1;
  } catch (err) {
    log(`[ERR] ${file.file_name}: ${err.message?.slice(0, 80)}`);
    stats.errors++;
    try { await supabase.from('massivlust_unclassified_files').update({ v2_model: MODEL, v2_processed_at: new Date().toISOString() }).eq('id', file.id); } catch {}
  }
}

async function processWithConcurrency(items, concurrency, fn) {
  let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; await fn(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function main() {
  acquireLock();
  log(`=== PDF CLASSIFY — concurrency=${CONCURRENCY} ${TEST_MODE ? `TEST(${TEST_LIMIT})` : 'FULL'} | PID=${process.pid} ===`);

  const drive = makeDrive();
  const { data: projectRows } = await supabase.from('massivlust_projects').select('id, name, address, customer, customer_contact, oppdragsgiver, oppdragsgiver_kontakt, leverandor, leverandor_kontakt, pl_name, tripletex_project_id');
  const projects = projectRows || [];
  log(`Projects: ${projects.length}`);

  const { count: totalPDFs } = await supabase
    .from('massivlust_unclassified_files')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'needs_review').eq('mime_type', 'application/pdf');
  log(`needs_review PDFs: ${totalPDFs}`);

  const stats = { attempted: 0, processed: 0, classified: 0, personal: 0, lowConf: 0, noResult: 0, errors: 0, totalCost: 0, docTypes: {}, startTime: Date.now() };
  let offset = 0;

  while (true) {
    if (TEST_MODE && stats.attempted >= TEST_LIMIT) { log(`TEST LIMIT reached`); break; }
    const fetchLimit = TEST_MODE ? Math.min(100, TEST_LIMIT - stats.attempted) : 100;

    const { data: files, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, drive_file_id, mime_type, current_drive_folder_name, current_drive_folder_path, gmail_subject, gmail_from, v2_suggestions')
      .eq('status', 'needs_review').eq('mime_type', 'application/pdf')
      .order('id', { ascending: true }).range(offset, offset + fetchLimit - 1);

    if (error) { log(`DB error: ${error.message}`); break; }
    if (!files?.length) { log('Queue empty'); break; }

    await processWithConcurrency(files, CONCURRENCY, f => processFile(f, drive, projects, stats));
    offset += files.length;

    const elapsed = (Date.now() - stats.startTime) / 60000;
    log(`[PROGRESS] ${stats.attempted} attempted | ${(stats.attempted/Math.max(elapsed,0.01)).toFixed(1)}/min | classified=${stats.classified} personal=${stats.personal} lowConf=${stats.lowConf} err=${stats.errors} $${stats.totalCost.toFixed(2)}`);

    // Progress report to bridge every ~1000 files
    if (!TEST_MODE && Math.floor(stats.attempted / 1000) > Math.floor((stats.attempted - files.length) / 1000)) {
      const progressMsg = `PDF CLASSIFY FREMDRIFT @${stats.attempted} (${SOURCE})

Behandlet: ${stats.attempted}/${totalPDFs} | Rate: ${(stats.attempted/Math.max(elapsed,0.01)).toFixed(1)} PDF/min
Klassifisert ≥0.92: ${stats.classified} | Personlig: ${stats.personal} | Lav konf: ${stats.lowConf} | Feil: ${stats.errors}
Kostnad: $${stats.totalCost.toFixed(3)} totalt | $${(stats.totalCost/Math.max(stats.processed,1)).toFixed(3)}/PDF | ${elapsed.toFixed(1)} min`;
      try { const { execSync } = await import('child_process'); execSync(`cortextos bus send-message bridge normal ${JSON.stringify(progressMsg)} 1781983099426-bridge-gvzbs`, { encoding: 'utf-8' }); } catch {}
    }
  }

  const elapsed = (Date.now() - stats.startTime) / 60000;
  const rate = stats.attempted / Math.max(elapsed, 0.01);
  log(`\n=== FERDIG === rate=${rate.toFixed(1)}/min cost=$${stats.totalCost.toFixed(3)} per=$${(stats.totalCost/Math.max(stats.processed,1)).toFixed(3)}`);
  log(`dok-typer: ${JSON.stringify(stats.docTypes)}`);

  try { await supabase.from('massivlust_sync_runs').insert({ source: SOURCE, status: 'success', started_at: new Date(stats.startTime).toISOString(), ended_at: new Date().toISOString(), rows_in: totalPDFs || 0, rows_upserted: stats.classified + stats.personal, rows_failed: stats.errors, org_id: 'massivlust' }); } catch {}

  const msg = `PDF CLASSIFY ${TEST_MODE ? 'TEST' : 'FERDIG'} (${SOURCE})

Behandlet: ${stats.processed}/${TEST_MODE ? TEST_LIMIT : totalPDFs} | Rate: ${rate.toFixed(1)} PDF/min
Klassifisert ≥0.92: ${stats.classified} | Personlig: ${stats.personal} | Lav konf: ${stats.lowConf} | Feil: ${stats.errors}
Kostnad: $${stats.totalCost.toFixed(3)} totalt | $${(stats.totalCost/Math.max(stats.processed,1)).toFixed(3)}/PDF | ${elapsed.toFixed(1)} min
Dok-typer: ${Object.entries(stats.docTypes).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}(${v})`).join(', ')||'ingen'}`;

  try { const { execSync } = await import('child_process'); execSync(`cortextos bus send-message bridge normal ${JSON.stringify(msg)} 1781983099426-bridge-gvzbs`, { encoding: 'utf-8' }); log('Rapport sendt.'); } catch (e) { log(`Bridge feilet: ${e.message?.slice(0,80)}`); }
}

main().catch(err => { log(`Fatal: ${err.message}`); releaseLock(); process.exit(1); });
