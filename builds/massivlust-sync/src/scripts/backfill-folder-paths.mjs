import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';
const MAX_DEPTH = 5;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function withBackoff(fn, label = '') {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      if ((err.code === 429 || err.status === 429) && attempt < 8) {
        const wait = Math.min(2000 * Math.pow(2, attempt), 60000);
        attempt++;
        console.warn(`[BACKOFF] ${label} — 429, attempt ${attempt}, waiting ${wait / 1000}s`);
        await delay(wait);
      } else { throw err; }
    }
  }
}

function makeDrive(email) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive.readonly'], email);
  return google.drive({ version: 'v3', auth });
}

async function main() {
  console.log('=== Backfill Folder Paths (parent chain) ===');
  const drive = makeDrive(ALEX_EMAIL);

  const folderCache = new Map();

  async function getFolderInfo(folderId) {
    if (folderCache.has(folderId)) return folderCache.get(folderId);
    try {
      const res = await withBackoff(() => drive.files.get({
        fileId: folderId,
        fields: 'name,parents',
        supportsAllDrives: true,
      }), `folder ${folderId}`);
      const info = { name: res.data.name, parents: res.data.parents || [] };
      folderCache.set(folderId, info);
      return info;
    } catch (err) {
      console.warn(`[WARN] Could not get folder ${folderId}: ${err.message}`);
      folderCache.set(folderId, null);
      return null;
    }
  }

  async function buildPath(folderId) {
    const parts = [];
    let currentId = folderId;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (!currentId || currentId === SHARED_DRIVE_ID) break;
      const info = await getFolderInfo(currentId);
      if (!info) break;
      parts.unshift(info.name);
      currentId = info.parents[0] || null;
    }
    return parts.join('/') || null;
  }

  const uniqueFolders = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('current_drive_folder_id')
      .not('current_drive_folder_id', 'is', null)
      .is('current_drive_folder_path', null)
      .range(from, from + pageSize - 1);
    if (error) { console.error(`DB error: ${error.message}`); break; }
    for (const row of (data || [])) {
      if (!uniqueFolders.includes(row.current_drive_folder_id)) {
        uniqueFolders.push(row.current_drive_folder_id);
      }
    }
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`${uniqueFolders.length} unique folder IDs to resolve paths`);

  let resolved = 0;
  let failed = 0;

  for (const folderId of uniqueFolders) {
    const path = await buildPath(folderId);
    if (path) {
      const { error } = await supabase
        .from('massivlust_unclassified_files')
        .update({ current_drive_folder_path: path })
        .eq('current_drive_folder_id', folderId)
        .is('current_drive_folder_path', null);
      if (error) {
        console.warn(`[WARN] Update failed for ${folderId}: ${error.message}`);
        failed++;
      } else {
        resolved++;
      }
    } else {
      failed++;
    }

    if ((resolved + failed) % 100 === 0) {
      console.log(`Progress: ${resolved + failed}/${uniqueFolders.length} — resolved: ${resolved}, failed: ${failed}, cached: ${folderCache.size}`);
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Resolved: ${resolved}/${uniqueFolders.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total API calls cached: ${folderCache.size}`);

  await supabase.from('massivlust_sync_runs').insert({
    source: 'backfill_folder_paths',
    status: failed === 0 ? 'success' : 'partial',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: uniqueFolders.length,
    rows_upserted: resolved,
    rows_failed: failed,
    org_id: 'massivlust',
  });
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
