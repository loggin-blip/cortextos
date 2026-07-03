/**
 * Phase 2a: Backfill drive_file_id for classified files missing it.
 * Searches Drive by file name + current_drive_folder_id to find the actual file ID.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';
const BATCH = 200;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive.readonly'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

async function lookupDriveFileId(drive, fileName, parentFolderId) {
  const safeName = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // First try: exact name + known parent
  if (parentFolderId) {
    const r = await drive.files.list({
      q: `name = '${safeName}' AND '${parentFolderId}' in parents AND trashed = false`,
      driveId: SHARED_DRIVE_ID, corpora: 'drive',
      supportsAllDrives: true, includeItemsFromAllDrives: true,
      fields: 'files(id)', pageSize: 5,
    });
    if (r.data.files?.length === 1) return r.data.files[0].id;
  }
  // Fallback: name only in shared drive
  const r2 = await drive.files.list({
    q: `name = '${safeName}' AND trashed = false`,
    driveId: SHARED_DRIVE_ID, corpora: 'drive',
    supportsAllDrives: true, includeItemsFromAllDrives: true,
    fields: 'files(id, parents)', pageSize: 5,
  });
  if (r2.data.files?.length === 1) return r2.data.files[0].id;
  // Multiple hits but one matches parent
  if (parentFolderId && r2.data.files?.length > 1) {
    const match = r2.data.files.find(f => f.parents?.includes(parentFolderId));
    if (match) return match.id;
  }
  return null; // ambiguous or not found
}

async function main() {
  console.log('=== PHASE 2a: BACKFILL drive_file_id ===');
  const drive = makeDrive();
  let offset = 0;
  let found = 0, notFound = 0, ambiguous = 0, errors = 0;
  const start = Date.now();

  while (true) {
    const { data: files, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, current_drive_folder_id, source_type')
      .eq('v2_model', 'sonnet-4-6')
      .not('v2_project_id', 'is', null)
      .is('drive_file_id', null)
      .neq('status', 'moved')
      .in('source_type', ['drive', 'gmail'])
      .range(offset, offset + BATCH - 1);

    if (error) { console.error(`DB error: ${error.message}`); break; }
    if (!files?.length) { console.log('No more files.'); break; }

    console.log(`\nBatch at offset ${offset}: ${files.length} files`);

    for (const file of files) {
      try {
        const driveId = await lookupDriveFileId(drive, file.file_name, file.current_drive_folder_id);
        if (driveId) {
          await supabase.from('massivlust_unclassified_files')
            .update({ drive_file_id: driveId })
            .eq('id', file.id);
          found++;
        } else {
          notFound++;
        }
        await delay(150);
      } catch (err) {
        console.error(`  [ERROR] ${file.file_name}: ${err.message?.slice(0, 80)}`);
        errors++;
        await delay(500);
      }
    }

    const elapsed = Math.round((Date.now() - start) / 60000);
    console.log(`  Progress: found:${found} notFound:${notFound} ambiguous:${ambiguous} err:${errors} | ${elapsed}min`);
    offset += files.length;
    if (files.length < BATCH) break;
  }

  const elapsed = Math.round((Date.now() - start) / 60000);
  console.log(`\n=== DONE: ${found} backfilled, ${notFound} not found, ${errors} errors in ${elapsed}min ===`);

  await supabase.from('massivlust_sync_runs').insert({
    source: 'pipeline_jun13_backfill_drive_id',
    status: errors === 0 ? 'success' : 'partial',
    started_at: new Date(start).toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: found + notFound + errors,
    rows_upserted: found,
    rows_failed: errors,
    org_id: 'massivlust',
  });
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
