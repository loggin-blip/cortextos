/**
 * Phase 4: GDPR trash personal Drive files.
 * STEG 1: EXIF GPS safety net — camera files with GPS coords → needs_review
 * STEG 2: Business-named files → needs_review
 * STEG 3: Trash remaining personal Drive files (NOT gmail), log parent before each trash
 *
 * CRITICAL RULES (verbatim from bridge GO):
 *   - NEVER permanent delete — only drive trash (trashed=true)
 *   - NEVER touch source_type='gmail'
 *   - SAVE file_id + current_parent + file_name + trashed_at BEFORE each trash
 *   - Steg 1 rescues camera files with any GPS — conservative/safe
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';
const BATCH_SIZE = 50;

// Camera filename patterns (from bridge GO)
const CAMERA_PATTERN = /^(IMG_|DSC_|IMAG|P_[0-9]|DSCN|GOPR|[0-9]{8}_[0-9]{6})/i;

// Business-name exclusion pattern (from bridge GO)
const BUSINESS_PATTERN = /kontrakt|faktura|tilbud|RIB-|RIG-|\.(ifc)|montasje|sjekkliste|avvik|HMS|tegning|anbud/i;

// Reversibility log — JSONL file, written BEFORE each trash
const LOG_FILE = `/tmp/gdpr-trash-log-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.jsonl`;
const SUMMARY_FILE = '/tmp/gdpr-trash-summary.json';

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
  console.log(line);
}

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

async function getFileMetaForExif(drive, fileId) {
  try {
    const res = await drive.files.get({
      fileId,
      supportsAllDrives: true,
      fields: 'id, name, parents, imageMediaMetadata, trashed',
    });
    return res.data;
  } catch (err) {
    if (err.code === 404 || err.message?.includes('File not found')) return { notFound: true };
    throw err;
  }
}

async function getFileMeta(drive, fileId) {
  try {
    const res = await drive.files.get({
      fileId,
      supportsAllDrives: true,
      fields: 'id, name, parents, trashed',
    });
    return res.data;
  } catch (err) {
    if (err.code === 404 || err.message?.includes('File not found')) return { notFound: true };
    throw err;
  }
}

function writeReversibilityLog(entry) {
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

async function logToSupabase(entry) {
  try {
    await supabase.from('massivlust_gdpr_trash_log').insert(entry);
  } catch {
    // Table may not exist — file log is primary
  }
}

async function step1ExifSafetyNet(drive) {
  log('=== STEG 1: EXIF GPS safety net for camera files ===');

  // Fetch all camera-pattern personal drive files
  let total = 0;
  let rescued = 0;
  let offset = 0;

  while (true) {
    const { data: files, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, drive_file_id, source_type')
      .eq('status', 'personal')
      .eq('source_type', 'drive')
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) { log(`DB error in steg1: ${error.message}`); break; }
    if (!files?.length) break;

    const cameraFiles = files.filter(f => CAMERA_PATTERN.test(f.file_name));
    total += cameraFiles.length;

    for (const file of cameraFiles) {
      if (!file.drive_file_id) continue;

      try {
        const meta = await getFileMetaForExif(drive, file.drive_file_id);
        if (meta.notFound) {
          log(`  [NOT-FOUND] ${file.file_name}`);
          continue;
        }

        const loc = meta.imageMediaMetadata?.location;
        if (loc?.latitude !== undefined && loc?.longitude !== undefined) {
          // Has GPS coords → could be project site photo → needs_review
          await supabase.from('massivlust_unclassified_files')
            .update({ status: 'needs_review' })
            .eq('id', file.id);
          rescued++;
          log(`  [EXIF-RESCUED] ${file.file_name} (lat=${loc.latitude.toFixed(4)}, lng=${loc.longitude.toFixed(4)})`);
        }
        await delay(100);
      } catch (err) {
        log(`  [EXIF-ERR] ${file.file_name}: ${err.message?.slice(0,80)}`);
        await delay(300);
      }
    }

    if (files.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
    await delay(200);
  }

  log(`Steg 1 complete: scanned ${total} camera files, rescued ${rescued} via EXIF GPS`);
  return { cameraScanned: total, exifRescued: rescued };
}

async function step2BusinessNameExclusion() {
  log('=== STEG 2: Business-name exclusion ===');

  let excluded = 0;
  let offset = 0;

  // Specific false-positive from Opus spot-check
  const { error: specificErr } = await supabase
    .from('massivlust_unclassified_files')
    .update({ status: 'needs_review' })
    .eq('status', 'personal')
    .eq('source_type', 'drive')
    .eq('file_name', 'Kontrakt SGA underskrevet 004.jpg');

  if (!specificErr) log('  [EXCLUDED] Kontrakt SGA underskrevet 004.jpg (Opus FP)');

  while (true) {
    const { data: files, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, source_type')
      .eq('status', 'personal')
      .eq('source_type', 'drive')
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) { log(`DB error in steg2: ${error.message}`); break; }
    if (!files?.length) break;

    const businessFiles = files.filter(f => BUSINESS_PATTERN.test(f.file_name));
    if (businessFiles.length > 0) {
      const ids = businessFiles.map(f => f.id);
      await supabase.from('massivlust_unclassified_files')
        .update({ status: 'needs_review' })
        .in('id', ids);
      excluded += businessFiles.length;
      for (const f of businessFiles) log(`  [EXCLUDED] ${f.file_name}`);
    }

    if (files.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
    await delay(100);
  }

  log(`Steg 2 complete: excluded ${excluded} business-named files`);
  return { businessExcluded: excluded };
}

async function step3TrashRemaining(drive) {
  log('=== STEG 3: Trash remaining personal Drive files ===');
  log(`Reversibility log: ${LOG_FILE}`);

  let trashed = 0;
  let alreadyGone = 0;
  let failed = 0;
  let offset = 0;

  while (true) {
    const { data: files, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, drive_file_id, source_type')
      .eq('status', 'personal')
      .eq('source_type', 'drive')  // NEVER touch gmail
      .not('drive_file_id', 'is', null)
      .range(0, BATCH_SIZE - 1);  // Always 0 offset — rows drop out as they're trashed

    if (error) { log(`DB error in steg3: ${error.message}`); break; }
    if (!files?.length) { log('No more files to trash.'); break; }

    for (const file of files) {
      try {
        // CRITICAL: fetch current parent BEFORE trashing
        const meta = await getFileMeta(drive, file.drive_file_id);

        if (meta.notFound) {
          log(`  [ALREADY-GONE] ${file.file_name}`);
          await supabase.from('massivlust_unclassified_files')
            .update({ status: 'trashed' })
            .eq('id', file.id);
          alreadyGone++;
          continue;
        }

        if (meta.trashed) {
          log(`  [ALREADY-TRASHED] ${file.file_name}`);
          await supabase.from('massivlust_unclassified_files')
            .update({ status: 'trashed' })
            .eq('id', file.id);
          alreadyGone++;
          continue;
        }

        const currentParent = meta.parents?.[0] || null;
        const trashedAt = new Date().toISOString();

        // Write reversibility log BEFORE trashing
        const logEntry = {
          file_id: file.drive_file_id,
          db_id: file.id,
          file_name: file.file_name,
          current_parent: currentParent,
          trashed_at: trashedAt,
        };
        writeReversibilityLog(logEntry);
        await logToSupabase(logEntry);

        // Trash via Drive API
        await drive.files.update({
          fileId: file.drive_file_id,
          requestBody: { trashed: true },
          supportsAllDrives: true,
        });

        // Mark in DB
        await supabase.from('massivlust_unclassified_files')
          .update({ status: 'trashed' })
          .eq('id', file.id);

        trashed++;
        if (trashed % 50 === 0) log(`  Progress: ${trashed} trashed, ${failed} failed`);
        await delay(150);
      } catch (err) {
        log(`  [ERROR] ${file.file_name}: ${err.message?.slice(0,100)}`);
        failed++;
        await delay(500);
      }
    }

    await delay(200);
  }

  log(`Steg 3 complete: trashed ${trashed}, already-gone ${alreadyGone}, failed ${failed}`);
  return { trashed, alreadyGone, failed };
}

async function main() {
  log('=== PHASE 4: GDPR TRASH PERSONAL FILES ===');
  log(`Log file: ${LOG_FILE}`);

  const drive = makeDrive();

  // Verify count before starting
  const { count } = await supabase
    .from('massivlust_unclassified_files')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'personal')
    .eq('source_type', 'drive');
  log(`Total personal drive files before: ${count}`);

  const { count: gmailCount } = await supabase
    .from('massivlust_unclassified_files')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'personal')
    .eq('source_type', 'gmail');
  log(`Gmail personal files (NOT TOUCHING): ${gmailCount}`);

  const step1Result = await step1ExifSafetyNet(drive);
  const step2Result = await step2BusinessNameExclusion();

  // Count remaining after exclusions
  const { count: remainingCount } = await supabase
    .from('massivlust_unclassified_files')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'personal')
    .eq('source_type', 'drive');
  log(`Remaining for trash after exclusions: ${remainingCount}`);

  const step3Result = await step3TrashRemaining(drive);

  const summary = {
    run_at: new Date().toISOString(),
    total_drive_personal_before: count,
    gmail_untouched: gmailCount,
    exif_rescued: step1Result.exifRescued,
    business_excluded: step2Result.businessExcluded,
    remaining_before_trash: remainingCount,
    trashed: step3Result.trashed,
    already_gone: step3Result.alreadyGone,
    failed: step3Result.failed,
    reversibility_log: LOG_FILE,
  };

  writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));

  log('\n=== FASE 4 FERDIG ===');
  log(`EXIF-reddet:     ${step1Result.exifRescued}`);
  log(`Ekskludert:      ${step2Result.businessExcluded}`);
  log(`Trashet:         ${step3Result.trashed}`);
  log(`Allerede borte:  ${step3Result.alreadyGone}`);
  log(`Feilet:          ${step3Result.failed}`);
  log(`Reverserings-logg: ${LOG_FILE}`);

  await supabase.from('massivlust_sync_runs').insert({
    source: 'gdpr_phase4_trash',
    status: step3Result.failed === 0 ? 'success' : 'partial',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: count || 0,
    rows_upserted: step3Result.trashed + step3Result.alreadyGone,
    rows_failed: step3Result.failed,
    org_id: 'massivlust',
  });

  // Report to bridge
  const msg = `FASE 4 FERDIG

EXIF-sikkerhetsnett: ${step1Result.exifRescued} kamerafiler reddet (hadde GPS-koordinater → needs_review)
Forretningsnavn ekskludert: ${step2Result.businessExcluded} filer → needs_review
Trashet til papirkurv: ${step3Result.trashed} filer
Allerede borte: ${step3Result.alreadyGone}
Feilet: ${step3Result.failed}

Gmail-filer (urørt): ${gmailCount}

Reverserings-logg skrevet: ${LOG_FILE}
Oppsummering: ${SUMMARY_FILE}

${step3Result.failed > 0 ? '⚠ Det var feil — sjekk log.' : 'Alt gikk bra.'}`;

  try {
    execSync(`cortextos bus send-message bridge normal ${JSON.stringify(msg)} 1781552872320`, { encoding: 'utf-8' });
    log('Bridge rapport sendt.');
  } catch (e) {
    log(`Bridge send feilet: ${e.message?.slice(0,80)}`);
  }

  return summary;
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
