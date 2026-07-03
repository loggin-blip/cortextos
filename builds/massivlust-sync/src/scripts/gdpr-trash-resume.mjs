/**
 * Phase 4 RESUME: Steg 3 only — trash remaining personal Drive files.
 * Belt-and-suspenders: writes reversibility log to BOTH Supabase table AND secrets/ file.
 * Collects permission errors into separate report.
 * Skips files already processed (status != 'personal').
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, appendFileSync, writeFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';
const BATCH_SIZE = 50;

// Durable log files (appended across runs)
const DURABLE_LOG = './secrets/gdpr-trash-log-2026-06-15.jsonl';
const PERMISSION_ERR_FILE = './secrets/gdpr-permission-errors-2026-06-15.jsonl';
const SUMMARY_FILE = '/tmp/gdpr-trash-resume-summary.json';

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Hard stop at 06:00 Oslo (CEST = UTC+2)
function pastDeadline() {
  const now = new Date();
  const oslo = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Oslo' }));
  return oslo.getHours() >= 6 && oslo.getDate() >= 16; // 06:00+ on June 16
}

function log(msg) {
  const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
  console.log(line);
}

const DRIVE_TIMEOUT_MS = 25000;

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

// Wraps any promise with a hard timeout so Drive API hangs don't stall the loop
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT:${label} after ${ms}ms`)), ms)),
  ]);
}

async function getFileMeta(drive, fileId) {
  try {
    const res = await withTimeout(
      drive.files.get({ fileId, supportsAllDrives: true, fields: 'id, name, parents, trashed' }),
      DRIVE_TIMEOUT_MS, 'getFileMeta'
    );
    return res.data;
  } catch (err) {
    if (err.code === 404 || err.message?.includes('File not found')) return { notFound: true };
    if (err.code === 403 || err.message?.toLowerCase().includes('permission')) return { permissionDenied: true, message: err.message };
    if (err.message?.startsWith('TIMEOUT:')) return { timedOut: true, message: err.message };
    throw err;
  }
}

async function writeReversibilityLog(entry) {
  // 1. Durable file (primary)
  appendFileSync(DURABLE_LOG, JSON.stringify(entry) + '\n');

  // 2. Supabase table (secondary)
  try {
    await supabase.from('massivlust_gdpr_trash_log').insert({
      file_id: entry.file_id,
      db_id: entry.db_id || null,
      file_name: entry.file_name || null,
      current_parent: entry.current_parent || null,
      trashed_at: entry.trashed_at,
    });
  } catch {
    // file log is primary — supabase failure is non-fatal
  }
}

async function main() {
  log('=== PHASE 4 RESUME: Steg 3 (trash remaining) ===');

  const drive = makeDrive();

  const { count: startCount } = await supabase
    .from('massivlust_unclassified_files')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'personal')
    .eq('source_type', 'drive');
  log(`Remaining personal drive files: ${startCount}`);

  let trashed = 0;
  let alreadyGone = 0;
  let permissionErrors = 0;
  let otherFailed = 0;
  const permissionErrorList = [];

  while (true) {
    // Hard stop at 06:00 Oslo
    if (pastDeadline()) { log('06:00 OSLO DEADLINE — avslutter rent.'); break; }

    // Always fetch from offset 0 — rows drop out as status changes
    const { data: files, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, drive_file_id, source_type')
      .eq('status', 'personal')
      .eq('source_type', 'drive')  // NEVER touch gmail
      .not('drive_file_id', 'is', null)
      .limit(BATCH_SIZE);

    if (error) { log(`DB error: ${error.message}`); break; }
    if (!files?.length) { log('No more files to trash.'); break; }

    for (const file of files) {
      try {
        const meta = await getFileMeta(drive, file.drive_file_id);

        if (meta.timedOut) {
          log(`  [TIMEOUT] ${file.file_name} — Drive API hung, skipping`);
          await supabase.from('massivlust_unclassified_files').update({ status: 'needs_review' }).eq('id', file.id);
          otherFailed++;
          await delay(2000);
          continue;
        }

        if (meta.permissionDenied) {
          permissionErrors++;
          const errEntry = { file_id: file.drive_file_id, db_id: file.id, file_name: file.file_name, error: meta.message };
          permissionErrorList.push(errEntry);
          appendFileSync(PERMISSION_ERR_FILE, JSON.stringify(errEntry) + '\n');
          // Mark needs_review so it drops out of 'personal' query and doesn't loop
          await supabase.from('massivlust_unclassified_files').update({ status: 'needs_review' }).eq('id', file.id);
          log(`  [PERM-ERR] ${file.file_name}`);
          await delay(200);
          continue;
        }

        if (meta.notFound) {
          await supabase.from('massivlust_unclassified_files').update({ status: 'trashed' }).eq('id', file.id);
          alreadyGone++;
          continue;
        }

        if (meta.trashed) {
          await supabase.from('massivlust_unclassified_files').update({ status: 'trashed' }).eq('id', file.id);
          alreadyGone++;
          continue;
        }

        const currentParent = meta.parents?.[0] || null;
        const trashedAt = new Date().toISOString();

        // Write reversibility log BEFORE trashing — belt and suspenders
        await writeReversibilityLog({
          file_id: file.drive_file_id,
          db_id: file.id,
          file_name: file.file_name,
          current_parent: currentParent,
          trashed_at: trashedAt,
        });

        // Trash via Drive API (with timeout)
        await withTimeout(
          drive.files.update({ fileId: file.drive_file_id, requestBody: { trashed: true }, supportsAllDrives: true }),
          DRIVE_TIMEOUT_MS, 'trashFile'
        );

        // Mark in DB — verify it succeeded
        const { error: dbErr } = await supabase.from('massivlust_unclassified_files').update({ status: 'trashed' }).eq('id', file.id);
        if (dbErr) {
          log(`  [DB-ERR] ${file.file_name}: ${dbErr.message} — retrying`);
          await delay(1000);
          const { error: retryErr } = await supabase.from('massivlust_unclassified_files').update({ status: 'trashed' }).eq('id', file.id);
          if (retryErr) log(`  [DB-ERR-FINAL] ${file.file_name}: ${retryErr.message}`);
        }

        trashed++;
        if (trashed % 100 === 0) {
          log(`  Progress: ${trashed} trashed, ${permissionErrors} perm-errors, ${otherFailed} other-failed`);
        }
        await delay(150);
      } catch (err) {
        const isPermErr = err.code === 403 || err.message?.toLowerCase().includes('permission');
        log(`  [${isPermErr ? 'PERM-ERR' : 'ERROR'}] ${file.file_name}: ${err.message?.slice(0, 100)}`);
        if (isPermErr) {
          permissionErrors++;
          const errEntry = { file_id: file.drive_file_id, db_id: file.id, file_name: file.file_name, error: err.message };
          permissionErrorList.push(errEntry);
          appendFileSync(PERMISSION_ERR_FILE, JSON.stringify(errEntry) + '\n');
        } else {
          otherFailed++;
        }
        // Always mark non-personal so it drops out of the query — prevents infinite loop
        await supabase.from('massivlust_unclassified_files').update({ status: 'needs_review' }).eq('id', file.id);
        await delay(500);
      }
    }

    await delay(300);
  }

  // Final counts
  const { count: supabaseLogCount } = await supabase
    .from('massivlust_gdpr_trash_log')
    .select('id', { count: 'exact', head: true });

  log('\n=== FASE 4 STEG 3 FERDIG ===');
  log(`Trashet denne run: ${trashed}`);
  log(`Allerede borte/trashed: ${alreadyGone}`);
  log(`Permission-feil (uberørt): ${permissionErrors}`);
  log(`Andre feil: ${otherFailed}`);
  log(`Supabase massivlust_gdpr_trash_log total: ${supabaseLogCount}`);
  log(`Durable fil-logg: ${DURABLE_LOG}`);
  log(`Permission-feil rapport: ${PERMISSION_ERR_FILE}`);

  const summary = {
    run_at: new Date().toISOString(),
    trashed_this_run: trashed,
    already_gone: alreadyGone,
    permission_errors: permissionErrors,
    other_failed: otherFailed,
    supabase_log_total: supabaseLogCount,
    durable_log: DURABLE_LOG,
    permission_error_file: PERMISSION_ERR_FILE,
  };
  writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));

  await supabase.from('massivlust_sync_runs').insert({
    source: 'gdpr_phase4_trash_resume',
    status: (otherFailed === 0 && permissionErrors < 300) ? 'success' : 'partial',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: startCount || 0,
    rows_upserted: trashed + alreadyGone,
    rows_failed: permissionErrors + otherFailed,
    org_id: 'massivlust',
  });

  const msg = `FASE 4 STEG 3 FERDIG

Trashet til papirkurv: ${trashed}
Allerede borte (Drive): ${alreadyGone}
Permission-feil (urørt, rapport skrevet): ${permissionErrors}
Andre feil: ${otherFailed}

Reverserings-logg:
  Supabase massivlust_gdpr_trash_log: ${supabaseLogCount} entries totalt
  Durable fil: ${DURABLE_LOG}

Permission-feil rapport: ${PERMISSION_ERR_FILE}
${permissionErrorList.slice(0,5).map(e => '  • ' + e.file_name).join('\n')}${permissionErrors > 5 ? '\n  ... og ' + (permissionErrors - 5) + ' til' : ''}

Alt trashet via papirkurv — ingen permanent sletting. Gmail-filer urørt.`;

  try {
    execSync(`cortextos bus send-message bridge normal ${JSON.stringify(msg)} 1781556712584-bridge-j4kmy`, { encoding: 'utf-8' });
    log('Bridge rapport sendt.');
  } catch (e) {
    log(`Bridge send feilet: ${e.message?.slice(0, 80)}`);
  }

  return summary;
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
