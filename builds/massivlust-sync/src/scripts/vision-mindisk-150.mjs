/**
 * Vision pattern scan: ~150 images from "Min disk%" folders (excl. Google Foto).
 * Finds patterns: % private vs work, folder clusters, EXIF signals for bulk rules.
 * Read-only — no DB writes, no moves, no deletes.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Singleton PID lock ──────────────────────────────────────────────────────
const PID_FILE = '/tmp/vision-mindisk.pid';
function acquireLock() {
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
      process.kill(pid, 0);
      console.error(`[LOCK] PID ${pid} alive — exiting.`); process.exit(0);
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
process.on('unhandledRejection', r => { log(`[UNHANDLED] ${r instanceof Error ? r.message : r}`); releaseLock(); process.exit(1); });

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';
const MODEL = 'claude-opus-4-7';
const CONCURRENCY = 5;
const MAX_IMAGES = 150;
const MAX_PER_FOLDER = 8;
const LOG_FILE = '/tmp/vision-mindisk.log';

function log(msg) {
  const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), ms))]);
}

async function getExifAndDownload(drive, fileId) {
  // Fetch metadata + EXIF in one call
  const metaRes = await withTimeout(
    drive.files.get({ fileId, supportsAllDrives: true, fields: 'id,name,size,imageMediaMetadata' }),
    20000
  );
  const exif = metaRes.data.imageMediaMetadata || {};
  const sizeMB = parseInt(metaRes.data.size || 0) / 1024 / 1024;

  // Skip files > 8MB (too large, slow)
  if (sizeMB > 8) return { exif, b64: null, skipped: 'too_large' };

  const mediaRes = await withTimeout(
    drive.files.get({ fileId, supportsAllDrives: true, alt: 'media' }, { responseType: 'arraybuffer' }),
    25000
  );
  return { exif, b64: Buffer.from(mediaRes.data).toString('base64'), sizeMB };
}

function getMediaType(mimeType) {
  if (mimeType?.includes('png')) return 'image/png';
  if (mimeType?.includes('gif')) return 'image/gif';
  if (mimeType?.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

function callVision(b64, mediaType, fileName, folderPath, exif) {
  const exifStr = exif.cameraModel ? `Kamera: ${exif.cameraModel}` : '';
  const gpsStr = exif.location?.latitude ? `GPS: ${exif.location.latitude.toFixed(4)},${exif.location.longitude.toFixed(4)}` : '';

  const prompt = {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
      { type: 'text', text: `Klassifiser dette bildet fra Massivlust AS sitt Google Drive. Svar KUN med JSON.

Filnavn: ${fileName}
Mappesti: ${folderPath || 'ukjent'}
${exifStr}
${gpsStr}

JSON-format (kun dette, ingen annen tekst):
{"category":"privat|byggeplass|dokument-foto|firma-asset|cnc-fil|annet","is_private":true|false,"project_hint":"prosjektnavn eller null","confidence":0.0-1.0,"reason":"maks 15 ord"}` }
    ]
  };

  return new Promise((resolve) => {
    const proc = spawn('/opt/homebrew/bin/claude', [
      '--print', '--model', MODEL, '--dangerously-skip-permissions', '--output-format', 'json'
    ]);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const killer = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 90000);
    proc.stdin.write(JSON.stringify(prompt), 'utf8');
    proc.stdin.end();
    proc.on('close', code => {
      clearTimeout(killer);
      if (code !== 0) { resolve(null); return; }
      try {
        const j = JSON.parse(out.trim());
        let text = j.result || out;
        text = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        const i = text.indexOf('{');
        if (i < 0) { resolve({ raw: text.slice(0, 100), cost: j.total_cost_usd }); return; }
        const parsed = JSON.parse(text.slice(i, text.lastIndexOf('}') + 1));
        parsed._cost = j.total_cost_usd;
        resolve(parsed);
      } catch { resolve(null); }
    });
    proc.on('error', () => { clearTimeout(killer); resolve(null); });
  });
}

async function processWithConcurrency(items, concurrency, fn) {
  let idx = 0;
  const results = new Array(items.length).fill(null);
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function folderPrefix(path, depth = 3) {
  if (!path) return 'unknown';
  return path.split('/').slice(0, depth).join('/');
}

async function main() {
  acquireLock();
  log(`=== VISION MINDISK 150 — concurrency=${CONCURRENCY} | PID=${process.pid} ===`);

  const drive = makeDrive();

  // Fetch candidates — spread across folders
  log('Fetching candidates from DB...');
  const { data: allCandidates, error } = await supabase
    .from('massivlust_unclassified_files')
    .select('id, file_name, drive_file_id, mime_type, current_drive_folder_path, current_drive_folder_name')
    .eq('status', 'needs_review')
    .like('mime_type', 'image/%')
    .ilike('current_drive_folder_path', 'Min disk%')
    .not('current_drive_folder_path', 'ilike', 'Min disk%Google Foto%')
    .not('current_drive_folder_path', 'ilike', 'Min disk%Google Photos%')
    .not('drive_file_id', 'is', null)
    .order('current_drive_folder_path', { ascending: true })
    .limit(2000);

  if (error) { log(`DB error: ${error.message}`); releaseLock(); process.exit(1); }
  log(`Candidates: ${allCandidates.length} total`);

  // Spread: max MAX_PER_FOLDER per folder prefix, then shuffle, take MAX_IMAGES
  const folderCounts = new Map();
  const selected = [];
  for (const f of allCandidates) {
    const prefix = folderPrefix(f.current_drive_folder_path || '', 4);
    const count = folderCounts.get(prefix) || 0;
    if (count < MAX_PER_FOLDER) {
      selected.push(f);
      folderCounts.set(prefix, count + 1);
      if (selected.length >= MAX_IMAGES) break;
    }
  }
  log(`Selected: ${selected.length} images across ${folderCounts.size} folder prefixes`);

  // Process with concurrency
  const startTime = Date.now();
  let done = 0;
  const visionResults = [];

  await processWithConcurrency(selected, CONCURRENCY, async (file, idx) => {
    try {
      const { exif, b64, skipped, sizeMB } = await getExifAndDownload(drive, file.drive_file_id);

      if (skipped || !b64) {
        const r = {
          idx, file_name: file.file_name, folder: file.current_drive_folder_path,
          category: 'skip', reason: skipped || 'no_data', exif,
          _cost: 0, error: false
        };
        visionResults.push(r);
        done++;
        if (done % 10 === 0) log(`Progress: ${done}/${selected.length}`);
        return;
      }

      const mediaType = getMediaType(file.mime_type);
      const vision = await callVision(b64, mediaType, file.file_name, file.current_drive_folder_path, exif);

      const r = {
        idx, file_name: file.file_name, folder: file.current_drive_folder_path,
        exif_camera: exif.cameraModel || null,
        exif_gps: exif.location?.latitude ? `${exif.location.latitude.toFixed(4)},${exif.location.longitude.toFixed(4)}` : null,
        category: vision?.category || 'error',
        is_private: vision?.is_private ?? null,
        project_hint: vision?.project_hint || null,
        confidence: vision?.confidence || null,
        reason: vision?.reason || vision?.raw || 'no_response',
        _cost: vision?._cost || 0,
        error: !vision
      };
      visionResults.push(r);
      done++;
      if (done % 10 === 0) {
        const elapsed = (Date.now() - startTime) / 60000;
        log(`Progress: ${done}/${selected.length} | ${(done/elapsed).toFixed(1)}/min | $${visionResults.reduce((s,r) => s + (r._cost||0), 0).toFixed(2)} spent`);
      }
    } catch (err) {
      visionResults.push({ idx, file_name: file.file_name, folder: file.current_drive_folder_path, category: 'error', reason: err.message?.slice(0,80), _cost: 0, error: true });
      done++;
    }
  });

  const elapsed = (Date.now() - startTime) / 60000;
  const totalCost = visionResults.reduce((s, r) => s + (r._cost || 0), 0);

  // ── Pattern analysis ──────────────────────────────────────────────────────
  const ok = visionResults.filter(r => !r.error && r.category !== 'skip');
  const privateCount = ok.filter(r => r.is_private === true).length;
  const workCount    = ok.filter(r => r.is_private === false).length;
  const errorCount   = visionResults.filter(r => r.error).length;
  const skipCount    = visionResults.filter(r => r.category === 'skip').length;

  // Folder-level clustering
  const folderStats = new Map();
  for (const r of ok) {
    const prefix = folderPrefix(r.folder || '', 4);
    if (!folderStats.has(prefix)) folderStats.set(prefix, { total: 0, private: 0, work: 0 });
    const s = folderStats.get(prefix);
    s.total++;
    if (r.is_private === true) s.private++;
    else s.work++;
  }

  // Folders where ALL images are private (bulk-mark candidates)
  const allPrivateFolders = [...folderStats.entries()]
    .filter(([, s]) => s.total >= 2 && s.private === s.total)
    .sort((a, b) => b[1].total - a[1].total);

  // Folders where ALL images are work
  const allWorkFolders = [...folderStats.entries()]
    .filter(([, s]) => s.total >= 2 && s.work === s.total)
    .sort((a, b) => b[1].total - a[1].total);

  // Camera models
  const cameras = new Map();
  for (const r of visionResults) {
    if (r.exif_camera) {
      cameras.set(r.exif_camera, (cameras.get(r.exif_camera) || 0) + 1);
    }
  }

  // Project hints
  const projects = new Map();
  for (const r of ok) {
    if (r.project_hint && r.project_hint !== 'null') {
      projects.set(r.project_hint, (projects.get(r.project_hint) || 0) + 1);
    }
  }

  log('\n========== PATTERN ANALYSIS ==========');
  log(`Total analysed: ${done} | OK: ${ok.length} | Skip: ${skipCount} | Errors: ${errorCount}`);
  log(`Privat: ${privateCount}/${ok.length} (${Math.round(privateCount/ok.length*100)}%) | Arbeid: ${workCount}/${ok.length} (${Math.round(workCount/ok.length*100)}%)`);
  log(`Kostnad: $${totalCost.toFixed(2)} total | $${(totalCost/ok.length).toFixed(3)}/bilde | ${elapsed.toFixed(1)} min`);
  log(`\nFOLDERS WHERE ALL = PRIVAT (${allPrivateFolders.length} mapper → bulk-mark kandidater):`);
  for (const [f, s] of allPrivateFolders.slice(0, 15)) log(`  ${s.total}/${s.total} privat: ${f}`);
  log(`\nFOLDERS WHERE ALL = ARBEID (${allWorkFolders.length} mapper):`);
  for (const [f, s] of allWorkFolders.slice(0, 10)) log(`  ${s.total}/${s.total} arbeid: ${f}`);
  log(`\nKAMERA-MODELLER (EXIF):`);
  for (const [cam, n] of [...cameras.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10)) log(`  ${n}x ${cam}`);
  log(`\nPROSJEKT-HINT FRA VISION:`);
  for (const [p, n] of [...projects.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10)) log(`  ${n}x ${p}`);

  // Save full results
  const report = {
    summary: { total: done, ok: ok.length, private: privateCount, work: workCount, errors: errorCount, skipped: skipCount, totalCostUsd: totalCost, avgCostPerImage: totalCost/Math.max(ok.length,1), elapsedMin: elapsed },
    patterns: {
      allPrivateFolders: allPrivateFolders.map(([f,s]) => ({ folder: f, ...s })),
      allWorkFolders: allWorkFolders.map(([f,s]) => ({ folder: f, ...s })),
      cameras: Object.fromEntries(cameras),
      projectHints: Object.fromEntries(projects),
    },
    results: visionResults,
  };
  const reportPath = '/tmp/vision-mindisk-results.json';
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`\nFull report: ${reportPath}`);

  // Send to bridge
  const privatePercent = Math.round(privateCount/Math.max(ok.length,1)*100);
  const msg = `VISION MINDISK 150 — MØNSTRE FUNNET

Analysert: ${done} bilder | OK: ${ok.length} | Skip (for store/ingen data): ${skipCount} | Feil: ${errorCount}
Fordeling: ${privatePercent}% PRIVAT (${privateCount}) | ${100-privatePercent}% ARBEID (${workCount})
Kostnad: $${totalCost.toFixed(2)} totalt | $${(totalCost/Math.max(ok.length,1)).toFixed(3)}/bilde | ${elapsed.toFixed(1)} min

BULK-MARK PRIVAT (alle bilder = privat i mappa):
${allPrivateFolders.slice(0,8).map(([f,s]) => `  ${s.total}/${s.total}: ${f}`).join('\n') || '  (ingen funnet)'}

BULK-MARK ARBEID:
${allWorkFolders.slice(0,5).map(([f,s]) => `  ${s.total}/${s.total}: ${f}`).join('\n') || '  (ingen funnet)'}

KAMERA-MØNSTRE (EXIF):
${[...cameras.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([c,n]) => `  ${n}x ${c}`).join('\n') || '  (ingen EXIF)'}

Full JSON-rapport: ${reportPath}`;

  try {
    const { execSync } = await import('child_process');
    execSync(`cortextos bus send-message bridge normal ${JSON.stringify(msg)} 1781979019152-bridge-trn8n`, { encoding: 'utf-8' });
    log('Bridge-rapport sendt.');
  } catch (e) { log(`Bridge send feilet: ${e.message?.slice(0,80)}`); }
}

main().catch(err => { log(`Fatal: ${err.message}`); releaseLock(); process.exit(1); });
