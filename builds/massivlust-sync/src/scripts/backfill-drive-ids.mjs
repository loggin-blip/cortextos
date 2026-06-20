import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

async function listAllUserFiles(drive, email) {
  const files = [];
  let pageToken = null;
  let page = 0;

  do {
    const res = await withBackoff(() => drive.files.list({
      q: "'me' in owners and trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      pageSize: 1000,
      pageToken,
      corpora: 'user',
      fields: 'nextPageToken,files(id,name,mimeType,size,parents)',
    }), `list ${email} page ${page}`);

    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
    page++;
    if (page % 5 === 0) console.log(`  [${email}] ${files.length} files listed so far...`);
  } while (pageToken);

  return files;
}

async function backfillUser(email) {
  console.log(`\n=== Backfilling drive_file_id for ${email} ===`);

  const dbFiles = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, file_size, source_type')
      .eq('source_user', email)
      .eq('source_type', 'drive')
      .is('drive_file_id', null)
      .range(from, from + pageSize - 1);
    if (error) { console.error(`DB error: ${error.message}`); return { matched: 0, total: 0 }; }
    dbFiles.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  if (!dbFiles.length) { console.log(`  No files to backfill`); return { matched: 0, total: 0 }; }

  console.log(`  ${dbFiles.length} DB files missing drive_file_id`);

  const drive = makeDrive(email);
  const driveFiles = await listAllUserFiles(drive, email);
  console.log(`  ${driveFiles.length} files found in Drive`);

  const driveByName = new Map();
  for (const f of driveFiles) {
    const key = f.name;
    if (!driveByName.has(key)) driveByName.set(key, []);
    driveByName.get(key).push(f);
  }

  let matched = 0;
  let ambiguous = 0;
  let notFound = 0;
  const batchSize = 50;

  for (let i = 0; i < dbFiles.length; i += batchSize) {
    const batch = dbFiles.slice(i, i + batchSize);
    const updates = [];

    for (const dbFile of batch) {
      const candidates = driveByName.get(dbFile.file_name);
      if (!candidates || candidates.length === 0) { notFound++; continue; }

      let match;
      if (candidates.length === 1) {
        match = candidates[0];
      } else if (dbFile.file_size) {
        match = candidates.find(c => c.size && parseInt(c.size) === dbFile.file_size);
        if (!match) match = candidates[0];
        ambiguous++;
      } else {
        match = candidates[0];
        ambiguous++;
      }

      updates.push({
        id: dbFile.id,
        drive_file_id: match.id,
        current_drive_folder_id: match.parents?.[0] || null,
        updated_at: new Date().toISOString(),
      });
      matched++;
    }

    if (updates.length > 0) {
      for (const upd of updates) {
        const { error: updErr } = await supabase
          .from('massivlust_unclassified_files')
          .update({
            drive_file_id: upd.drive_file_id,
            current_drive_folder_id: upd.current_drive_folder_id,
            updated_at: upd.updated_at,
          })
          .eq('id', upd.id);
        if (updErr) console.warn(`  [WARN] Update failed for ${upd.id}: ${updErr.message}`);
      }
    }

    if ((i + batchSize) % 500 === 0 || i + batchSize >= dbFiles.length) {
      console.log(`  Progress: ${Math.min(i + batchSize, dbFiles.length)}/${dbFiles.length} — matched: ${matched}, notFound: ${notFound}, ambiguous: ${ambiguous}`);
    }
  }

  console.log(`  DONE: ${matched} matched, ${notFound} not found, ${ambiguous} ambiguous (used first match)`);
  return { matched, notFound, ambiguous, total: dbFiles.length };
}

async function main() {
  const started = new Date().toISOString();
  console.log(`=== Drive File ID Backfill ===`);
  console.log(`Started: ${started}`);

  const { data: users } = await supabase
    .from('massivlust_unclassified_files')
    .select('source_user')
    .eq('source_type', 'drive')
    .is('drive_file_id', null)
    .not('source_user', 'is', null);

  const uniqueUsers = [...new Set((users || []).map(u => u.source_user))];
  console.log(`Users with Drive files missing IDs: ${uniqueUsers.join(', ')}`);

  const results = {};
  for (const email of uniqueUsers) {
    results[email] = await backfillUser(email);
  }

  const totalMatched = Object.values(results).reduce((s, r) => s + r.matched, 0);
  const totalNotFound = Object.values(results).reduce((s, r) => s + (r.notFound || 0), 0);

  await supabase.from('massivlust_sync_runs').insert({
    source: 'backfill_drive_ids',
    status: totalNotFound === 0 ? 'success' : 'partial',
    started_at: started,
    ended_at: new Date().toISOString(),
    rows_in: Object.values(results).reduce((s, r) => s + r.total, 0),
    rows_upserted: totalMatched,
    rows_skipped: totalNotFound,
    rows_failed: 0,
    payload: results,
    org_id: 'massivlust',
  });

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total matched: ${totalMatched}`);
  console.log(`Total not found: ${totalNotFound}`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
