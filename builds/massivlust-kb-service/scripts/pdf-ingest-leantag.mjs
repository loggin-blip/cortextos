/**
 * Ingest typed PDFs into ChromaDB via embed-text-pdf.py (local extraction + Gemini embed, no Flash).
 * Scope: mime=application/pdf AND doc_type IS NOT NULL AND doc_type != 'tegning' AND not yet in ChromaDB.
 * Scanned/image-only PDFs → logged as SKIP (needs-flash, utsatt).
 * Idempotent: pre-loads ChromaDB IDs at startup, never re-embeds existing files.
 * 429 backoff: pause+retry, NOT hard stop. Google 100kr cap = hard backstop.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Singleton PID lock with liveness check ────────────────────────────────────
const PID_FILE = '/tmp/pdf-ingest-leantag.pid';
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
const SOURCE = 'pipeline_pdf_leantag_ingest';
const LOG_FILE = '/tmp/pdf-ingest-leantag.log';
const COLLECTION = 'massivlust-docs';
const EMBED_PY = process.env.EMBED_TEXT_PY || `${process.env.HOME}/cortextos/builds/massivlust-kb-service/scripts/embed-text-pdf.py`;
const KB_PYTHON = process.env.KB_PYTHON || `${process.env.HOME}/cortextos/knowledge-base/venv/bin/python`;
const DRIVE_TIMEOUT_MS = 30000;
const BRIDGE_MSG_ID = '1782164881039-bridge-s32d0';
const MAX_FILES = process.env.MAX_FILES ? parseInt(process.env.MAX_FILES) : Infinity;
const MAX_CONCURRENT = process.env.MAX_CONCURRENT ? parseInt(process.env.MAX_CONCURRENT) : 1;

const SKIP_EXTENSIONS = new Set(['.ai', '.eps', '.psd', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.svg', '.indd']);

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function makeDrive() {
  const auth = new google.auth.JWT({
    email: SA_KEY.client_email,
    key: SA_KEY.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
    subject: ALEX_EMAIL,
  });
  return google.drive({ version: 'v3', auth });
}

function cleanName(name) {
  return name.normalize('NFC').replace(/[^a-zA-Z0-9æøåÆØÅ._\- ]/g, '_').slice(0, 80);
}

function stagedBasename(driveFileId, fileName) {
  return `${driveFileId}___${cleanName(fileName)}`;
}

function preCheckFilename(fileName) {
  if (fileName.startsWith('._')) return 'resource-fork (._-prefix)';
  const lower = fileName.toLowerCase();
  for (const ext of SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return `non-PDF extension (${ext})`;
  }
  return null;
}

function preCheckBytes(filePath) {
  try {
    const buf = readFileSync(filePath).slice(0, 4);
    if (buf.toString('ascii') !== '%PDF') return 'not a PDF (bad magic bytes)';
  } catch { return 'unreadable'; }
  return null;
}

async function downloadPdf(drive, fileId, destPath) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`TIMEOUT downloading ${fileId}`)), DRIVE_TIMEOUT_MS);
    drive.files.get({ fileId, supportsAllDrives: true, alt: 'media' }, { responseType: 'stream' }, (err, res) => {
      if (err) { clearTimeout(timeout); return reject(err); }
      const chunks = [];
      res.data.on('data', d => chunks.push(d));
      res.data.on('end', () => { clearTimeout(timeout); writeFileSync(destPath, Buffer.concat(chunks)); resolve(); });
      res.data.on('error', e => { clearTimeout(timeout); reject(e); });
    });
  });
}

function runEmbedder(filePath) {
  return new Promise(resolve => {
    const proc = spawn(KB_PYTHON, [EMBED_PY, filePath, '--collection', COLLECTION], { env: process.env });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const killer = setTimeout(() => { proc.kill('SIGKILL'); resolve({ chunks: 0, cost: 0, quotaHit: false, isPerDay: false, needsFlash: false, dimErr: false, error: 'TIMEOUT', rawOut: '' }); }, 120000);
    proc.on('close', code => {
      clearTimeout(killer);
      const combined = (out + err).toLowerCase();
      const quotaHit = combined.includes('resource_exhausted') || combined.includes('429');
      const isPerDay = combined.includes('perday') || combined.includes('per_day') || combined.includes('per day');
      const needsFlash = out.includes('SKIP (needs-flash)');
      const dimErr = combined.includes('expecting embedding with dimension');
      const addedMatch = out.match(/Added (\d+) chunk/);
      const chunks = addedMatch ? parseInt(addedMatch[1]) : 0;
      const costMatch = out.match(/Cost:\s*\$([0-9.]+)/);
      const cost = costMatch ? parseFloat(costMatch[1]) : 0;

      if (needsFlash) return resolve({ chunks: 0, cost: 0, quotaHit: false, isPerDay: false, needsFlash: true, dimErr: false, error: null, rawOut: '' });
      if (quotaHit) return resolve({ chunks: 0, cost, quotaHit: true, isPerDay, needsFlash: false, dimErr: false, error: null, rawOut: (out + err).slice(0, 600) });
      if (dimErr) return resolve({ chunks: 0, cost, quotaHit: false, isPerDay: false, needsFlash: false, dimErr: true, error: out.match(/expecting embedding with dimension[^\n]*/)?.[0] || 'dim mismatch', rawOut: '' });
      // Stdout success (Added N chunk(s)) wins over any exit code — stderr may have harmless warnings
      if (addedMatch) return resolve({ chunks, cost, quotaHit: false, isPerDay: false, needsFlash: false, dimErr: false, error: null, rawOut: '' });
      if (code !== 0 || code === null) return resolve({ chunks, cost, quotaHit: false, isPerDay: false, needsFlash: false, dimErr: false, error: `exit ${code}: ${err.slice(0, 200)}`, rawOut: '' });
      resolve({ chunks, cost, quotaHit: false, isPerDay: false, needsFlash: false, dimErr: false, error: null, rawOut: '' });
    });
    proc.on('error', e => { clearTimeout(killer); resolve({ chunks: 0, cost: 0, quotaHit: false, isPerDay: false, needsFlash: false, dimErr: false, error: e.message, rawOut: '' }); });
  });
}

async function registerKbSource(file, basename, chunkCount) {
  const row = {
    org_id: 'massivlust', collection: COLLECTION, source_type: 'drive',
    staged_basename: basename, drive_file_id: file.drive_file_id,
    parent_folder_id: file.current_drive_folder_id || null, web_view_link: null,
    thread_id: null, project_id: file.v2_project_id || null,
    title: file.file_name, mime_type: file.mime_type, access_scope: 'project',
    chunk_count: chunkCount, ingested_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('massivlust_kb_sources')
    .upsert(row, { onConflict: 'drive_file_id,org_id' });
  if (error) log(`[WARN] kb_sources upsert failed for ${file.file_name}: ${error.message?.slice(0, 80)}`);
}

async function sendBridge(msg) {
  try {
    const { execSync } = await import('child_process');
    execSync(`cortextos bus send-message bridge normal ${JSON.stringify(msg)} ${BRIDGE_MSG_ID}`, { encoding: 'utf-8' });
    log('Bridge rapport sendt.');
  } catch (e) { log(`Bridge feilet: ${e.message?.slice(0, 60)}`); }
}

async function loadChromaIds() {
  log('Laster ChromaDB-IDer (idempotent scope)...');
  const pyScript = `
import chromadb, pathlib, json
c = chromadb.PersistentClient(path=str(pathlib.Path.home()/'.mmrag'/'chromadb'))
col = c.get_collection('massivlust-docs')
total = col.count()
ids = set()
batch = 5000
offset = 0
while offset < total:
    res = col.get(limit=batch, offset=offset, include=['metadatas'])
    for m in res['metadatas']:
        fn = (m or {}).get('filename', '')
        sep = fn.find('___')
        if sep > 0:
            ids.add(fn[:sep])
    offset += batch
print(json.dumps(list(ids)))
`;
  return new Promise((resolve, reject) => {
    const proc = spawn(KB_PYTHON, ['-c', pyScript]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { process.stderr.write(d); });
    const killer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ChromaDB load TIMEOUT')); }, 180000);
    proc.on('close', code => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(`ChromaDB load exit ${code}`));
      try { resolve(new Set(JSON.parse(out.trim()))); }
      catch (e) { reject(new Error(`ChromaDB parse error: ${e.message}`)); }
    });
    proc.on('error', reject);
  });
}

async function buildQueue(inChroma, inKbSources) {
  log('Bygger kø av filer som skal ingestieres...');
  const queue = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, drive_file_id, mime_type, current_drive_folder_id, v2_project_id, document_type')
      .eq('mime_type', 'application/pdf')
      .not('document_type', 'is', null)
      .not('drive_file_id', 'is', null)
      .neq('document_type', 'tegning')
      .order('id', { ascending: true })
      .range(offset, offset + 499);
    if (error) { log(`DB feil ved kø-bygging: ${error.message}`); break; }
    if (!data?.length) break;
    for (const f of data) {
      // After ChromaDB rebuild: skip only files already in the new (empty) ChromaDB.
      // inKbSources filter disabled — all files need re-embedding into fresh collection.
      if (!inChroma.has(f.drive_file_id)) {
        const skip = preCheckFilename(f.file_name);
        if (skip) { log(`[PRE-SKIP] ${f.file_name} — ${skip}`); continue; }
        queue.push(f);
      }
    }
    offset += data.length;
    if (data.length < 500) break;
  }
  return queue;
}

async function main() {
  acquireLock();
  const isVerify = MAX_FILES < Infinity;
  log(`=== PDF INGEST LEANTAG (text-only) — ${COLLECTION} | PID=${process.pid}${isVerify ? ` | SANITY=${MAX_FILES}` : ` | CONCURRENT=${MAX_CONCURRENT}`} ===`);
  log(`embedder: ${EMBED_PY} | python: ${KB_PYTHON}`);

  if (!existsSync(EMBED_PY) || !existsSync(KB_PYTHON)) {
    log('FATAL: embed-text-pdf.py or python not found'); releaseLock(); process.exit(1);
  }

  const drive = makeDrive();
  const tmpDir = join(tmpdir(), 'pdf-ingest-leantag');
  try { mkdirSync(tmpDir, { recursive: true }); } catch {}

  const { count: totalScope } = await supabase
    .from('massivlust_unclassified_files')
    .select('id', { count: 'exact', head: true })
    .eq('mime_type', 'application/pdf').not('document_type', 'is', null).not('drive_file_id', 'is', null);
  log(`Totalt typede PDFs: ${totalScope}`);

  const inChroma = await loadChromaIds();
  log(`Allerede i ChromaDB: ${inChroma.size}`);

  const inKbSources = new Set();
  let page = 0;
  while (true) {
    const { data } = await supabase.from('massivlust_kb_sources')
      .select('drive_file_id').eq('org_id', 'massivlust').not('drive_file_id', 'is', null)
      .range(page * 1000, page * 1000 + 999);
    if (!data?.length) break;
    for (const r of data) inKbSources.add(r.drive_file_id);
    page++;
  }
  log(`Allerede i kb_sources: ${inKbSources.size}`);

  const fullQueue = await buildQueue(inChroma, inKbSources);
  const queue = isVerify ? fullQueue.slice(0, MAX_FILES) : fullQueue;
  log(`Kø bygget: ${queue.length} filer å ingestere`);

  const stats = { attempted: 0, ingested: 0, skipped: 0, needsFlash: 0, errors: 0, totalChunks: 0, totalCostUSD: 0, startTime: Date.now() };
  let stopped = false;
  let pauseUntil = 0;       // timestamp: workers wait before taking next file
  let consecutiveQuota = 0; // reset on any success

  const BUDGET_LIMIT_USD = 9.3; // ~100 NOK

  async function processFile(file) {
    if (stopped) return;

    // Coordinated backoff: all workers pause until rate-limit window resets
    const now = Date.now();
    if (now < pauseUntil) await new Promise(r => setTimeout(r, pauseUntil - now));
    if (stopped) return;

    const basename = stagedBasename(file.drive_file_id, file.file_name);
    const tmpPath = join(tmpDir, basename.endsWith('.pdf') ? basename : basename + '.pdf');

    try {
      await downloadPdf(drive, file.drive_file_id, tmpPath);

      const bytesSkip = preCheckBytes(tmpPath);
      if (bytesSkip) {
        try { unlinkSync(tmpPath); } catch {}
        log(`[SKIP] ${file.file_name} — ${bytesSkip}`);
        return;
      }

      const { chunks, cost, quotaHit, isPerDay, needsFlash, dimErr, error: mmErr, rawOut } = await runEmbedder(tmpPath);
      try { unlinkSync(tmpPath); } catch {}
      stats.totalCostUSD += cost;
      stats.attempted++;

      // Budget hard stop
      if (stats.totalCostUSD >= BUDGET_LIMIT_USD) {
        stopped = true;
        log(`[BUDSJETT] $${stats.totalCostUSD.toFixed(2)} >= $${BUDGET_LIMIT_USD} — stopper.`);
        await sendBridge(`PDF INGEST BUDSJETT-TAK nådd (${SOURCE})\nKostnad: $${stats.totalCostUSD.toFixed(4)} (~${(stats.totalCostUSD*10.8).toFixed(0)} NOK)\nBehandlet: ${stats.attempted} | Chunks: ${stats.totalChunks}`);
        return;
      }

      if (quotaHit) {
        consecutiveQuota++;
        // Log raw mmrag output for diagnostics
        if (rawOut) log(`[RATE-LIMIT RAW] ${rawOut.replace(/\n/g, ' ').slice(0, 400)}`);

        if (isPerDay) {
          // Daily quota — can't recover today, hard stop
          stopped = true;
          log('[KVOTE DAG] Per-day limit nådd — stopper til i morgen.');
          await sendBridge(`PDF INGEST STOPP — DAGSKVOTE (${SOURCE})\nBehandlet: ${stats.attempted} | Chunks: ${stats.totalChunks}\nKostnad: $${stats.totalCostUSD.toFixed(4)} (~${(stats.totalCostUSD*10.8).toFixed(2)} NOK)\nRåfeil: ${rawOut.slice(0,200)}`);
          return;
        }

        if (consecutiveQuota > 3) {
          // Persistent rate limiting, give up
          stopped = true;
          log(`[RATE-LIMIT] ${consecutiveQuota} consecutive — gir opp.`);
          await sendBridge(`PDF INGEST STOPP — vedvarende 429 (${consecutiveQuota}x) (${SOURCE})\nBehandlet: ${stats.attempted} | Kostnad: $${stats.totalCostUSD.toFixed(4)}\nRåfeil: ${rawOut.slice(0,200)}`);
          return;
        }

        // Rate limit (per-minute) — pause all workers 70s, then continue
        const waitS = 70 * consecutiveQuota; // 70s, 140s, 210s
        log(`[RATE-LIMIT] 429 (hit #${consecutiveQuota}) — alle workers pause ${waitS}s før retry`);
        pauseUntil = Date.now() + waitS * 1000;
        // Re-queue this file by decrementing the shared index (handled by caller)
        return { requeue: true };
      }

      consecutiveQuota = 0; // reset on any non-quota result

      if (needsFlash) {
        log(`[SKIP-FLASH] ${file.file_name} — skannet/bilde-only, utsatt`);
        stats.needsFlash++;
        stats.skipped++;
        return;
      }

      if (dimErr) {
        stopped = true;
        log(`[FATAL] Dimension-mismatch: ${mmErr}`);
        await sendBridge(`PDF INGEST FATAL — DIMENSION MISMATCH\n${mmErr}\nBehandlet: ${stats.attempted}`);
        return;
      }

      if (mmErr) {
        log(`[ERR] ${file.file_name}: ${mmErr}`);
        stats.errors++;
      } else {
        await registerKbSource(file, basename, chunks);
        inChroma.add(file.drive_file_id);
        inKbSources.add(file.drive_file_id);
        stats.ingested++;
        stats.totalChunks += chunks;
        if (chunks === 0) stats.skipped++;
        log(`[OK] ${file.file_name} → ${chunks} chunks | $${cost.toFixed(4)}`);
      }
    } catch (err) {
      try { unlinkSync(tmpPath); } catch {}
      log(`[ERR] ${file.file_name}: ${err.message?.slice(0, 80)}`);
      stats.errors++;
    }

    // Progress every 500
    if (stats.attempted % 500 === 0) {
      const elapsed = (Date.now() - stats.startTime) / 60000;
      const rate = (stats.attempted / Math.max(elapsed, 0.01)).toFixed(1);
      const costNOK = (stats.totalCostUSD * 10.8).toFixed(2);
      await sendBridge(`PDF INGEST FREMDRIFT @${stats.attempted} (${SOURCE})

Rate: ${rate} PDF/min | Chunks: ${stats.totalChunks}
Ingestert: ${stats.ingested} | Hoppet over: ${stats.skipped} | Feil: ${stats.errors}
Kostnad: $${stats.totalCostUSD.toFixed(4)} (~${costNOK} NOK) | Tak: ~100 NOK`);
    }
  }

  // Worker pool with re-queue on rate-limit
  let qIdx = 0;
  async function worker() {
    while (qIdx < queue.length && !stopped) {
      const myIdx = qIdx++;
      const file = queue[myIdx];
      const result = await processFile(file);
      if (result?.requeue) {
        // Put this file back: decrement shared index so another worker retries it
        qIdx = Math.min(qIdx, myIdx);
      }
    }
  }
  const concurrency = Math.min(MAX_CONCURRENT, queue.length);
  await Promise.all(Array.from({ length: Math.max(concurrency, 1) }, worker));

  const elapsed = (Date.now() - stats.startTime) / 60000;
  const rate = (stats.attempted / Math.max(elapsed, 0.01)).toFixed(1);
  const costNOK = (stats.totalCostUSD * 10.8).toFixed(2);
  log(`\n=== FERDIG === attempted=${stats.attempted} ingested=${stats.ingested} chunks=${stats.totalChunks} err=${stats.errors} cost=$${stats.totalCostUSD.toFixed(4)}`);

  if (!isVerify && !stopped) {
    try {
      await supabase.from('massivlust_sync_runs').insert({
        source: SOURCE, status: 'success',
        started_at: new Date(stats.startTime).toISOString(), ended_at: new Date().toISOString(),
        rows_in: stats.attempted, rows_upserted: stats.ingested, rows_failed: stats.errors,
        org_id: 'massivlust',
      });
    } catch {}
  }

  const label = isVerify ? `SANITY (${MAX_FILES})` : (stopped ? 'STOPPET' : 'FERDIG');
  await sendBridge(`PDF INGEST ${label} (tekst-only) (${SOURCE})

Behandlet: ${stats.attempted} | Ingestert: ${stats.ingested} | Chunks: ${stats.totalChunks}
Hoppet over (skannet/utsatt): ${stats.needsFlash} | Andre skip: ${stats.skipped - stats.needsFlash} | Feil: ${stats.errors}
Kostnad: $${stats.totalCostUSD.toFixed(4)} (~${costNOK} NOK)
Rate: ${rate} PDF/min | ${elapsed.toFixed(1)} min | Kø var: ${queue.length}`);

  if (stopped) { releaseLock(); process.exit(0); }
}

main().catch(err => { log(`Fatal: ${err.message}`); releaseLock(); process.exit(1); });
