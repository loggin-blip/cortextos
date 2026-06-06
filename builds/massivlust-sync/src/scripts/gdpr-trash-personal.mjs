import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';
const MIN_CONFIDENCE = 0.92;
const BATCH_LIMIT = 100;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

async function trashFile(drive, fileId) {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}

async function upsertPersonalSender(email) {
  if (!email) return;
  const clean = email.replace(/^.*</, '').replace(/>.*$/, '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return;

  const { data: existing } = await supabase
    .from('massivlust_personal_senders')
    .select('id, hit_count')
    .eq('sender_email', clean)
    .maybeSingle();

  if (existing) {
    await supabase.from('massivlust_personal_senders')
      .update({ hit_count: existing.hit_count + 1, last_seen_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    await supabase.from('massivlust_personal_senders')
      .insert({ sender_email: clean });
  }
}

async function main() {
  console.log(`=== GDPR TRASH PERSONAL FILES (conf >= ${MIN_CONFIDENCE}) ===`);
  const drive = makeDrive();

  const { data: files, error } = await supabase
    .from('massivlust_unclassified_files')
    .select('id, file_name, drive_file_id, source_type, gmail_from, v2_confidence, v2_suggestions')
    .eq('v2_model', 'sonnet-4-6')
    .eq('v2_is_personal', true)
    .gte('v2_confidence', MIN_CONFIDENCE)
    .neq('status', 'trashed')
    .limit(BATCH_LIMIT);

  if (error) { console.error(`DB error: ${error.message}`); return; }
  if (!files?.length) { console.log('No personal files ready for GDPR trash.'); return; }
  console.log(`${files.length} personal files eligible for trash`);

  let trashed = 0;
  let dbOnly = 0;
  let failed = 0;

  for (const file of files) {
    try {
      if (file.source_type === 'drive' && file.drive_file_id) {
        await trashFile(drive, file.drive_file_id);
        trashed++;
        console.log(`  [TRASHED] ${file.file_name} (Drive)`);
      } else {
        dbOnly++;
        console.log(`  [DB-ONLY] ${file.file_name} (${file.source_type})`);
      }

      await supabase.from('massivlust_unclassified_files')
        .update({ status: 'trashed' })
        .eq('id', file.id);

      await upsertPersonalSender(file.gmail_from);
      await delay(200);
    } catch (err) {
      if (err.message?.includes('File not found')) {
        await supabase.from('massivlust_unclassified_files')
          .update({ status: 'trashed' })
          .eq('id', file.id);
        trashed++;
        console.log(`  [ALREADY-GONE] ${file.file_name}`);
      } else {
        console.error(`  [ERROR] ${file.file_name}: ${err.message}`);
        failed++;
      }
      await delay(500);
    }
  }

  console.log(`\n=== DONE: trashed ${trashed}, db-only ${dbOnly}, failed ${failed} ===`);

  if (trashed + dbOnly > 0) {
    await supabase.from('massivlust_sync_runs').insert({
      source: 'gdpr_trash_personal',
      status: failed === 0 ? 'success' : 'partial',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      rows_in: files.length,
      rows_upserted: trashed + dbOnly,
      rows_failed: failed,
      org_id: 'massivlust',
    });
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
