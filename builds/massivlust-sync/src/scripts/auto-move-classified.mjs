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

function pickSubfolder(file) {
  if (file.mime_type?.startsWith('image/')) return '02 Bilder';
  if (file.source_type === 'gmail') return '03 Mail';
  return '04 Dokumenter';
}

async function findSubfolder(drive, parentId, subName) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents AND name = '${subName}' AND mimeType = 'application/vnd.google-apps.folder' AND trashed = false`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: 'files(id, name)',
  });
  return res.data.files?.[0]?.id || null;
}

async function moveFile(drive, fileId, fromFolderId, toFolderId) {
  await drive.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: fromFolderId || undefined,
    supportsAllDrives: true,
  });
}

async function main() {
  console.log(`=== AUTO-MOVE CLASSIFIED FILES (conf >= ${MIN_CONFIDENCE}) ===`);
  const drive = makeDrive();

  const { data: files, error } = await supabase
    .from('massivlust_unclassified_files')
    .select(`
      id, file_name, drive_file_id, source_type, mime_type,
      current_drive_folder_id,
      v2_project_id, v2_confidence, v2_method, v2_is_personal,
      v2_suggestions
    `)
    .eq('v2_model', 'sonnet-4-6')
    .eq('v2_is_personal', false)
    .gte('v2_confidence', MIN_CONFIDENCE)
    .not('v2_project_id', 'is', null)
    .not('drive_file_id', 'is', null)
    .is('drive_destination_id', null)
    .limit(BATCH_LIMIT);

  if (error) { console.error(`DB error: ${error.message}`); return; }
  if (!files?.length) { console.log('No files ready for auto-move.'); return; }
  console.log(`${files.length} files eligible for auto-move`);

  const projectIds = [...new Set(files.map(f => f.v2_project_id))];
  const { data: projects } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id')
    .in('id', projectIds);

  const projectMap = new Map(projects?.map(p => [p.id, p]) || []);
  const subfolderCache = new Map();

  let moved = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const project = projectMap.get(file.v2_project_id);
    if (!project?.drive_root_folder_id) {
      console.warn(`  [SKIP] ${file.file_name} — project ${file.v2_project_id} has no Drive folder`);
      skipped++;
      continue;
    }

    const subName = pickSubfolder(file);
    const cacheKey = `${project.drive_root_folder_id}/${subName}`;

    let targetFolderId = subfolderCache.get(cacheKey);
    if (!targetFolderId) {
      targetFolderId = await findSubfolder(drive, project.drive_root_folder_id, subName);
      if (targetFolderId) subfolderCache.set(cacheKey, targetFolderId);
    }

    if (!targetFolderId) {
      console.warn(`  [SKIP] ${file.file_name} — subfolder '${subName}' not found in ${project.name}`);
      skipped++;
      continue;
    }

    try {
      await moveFile(drive, file.drive_file_id, file.current_drive_folder_id, targetFolderId);

      await supabase.from('massivlust_unclassified_files')
        .update({ drive_destination_id: targetFolderId, status: 'moved' })
        .eq('id', file.id);

      const reason = file.v2_suggestions?.reasoning || null;
      await supabase.from('massivlust_audit_moves').insert({
        file_id: file.id,
        drive_file_id: file.drive_file_id,
        from_folder_id: file.current_drive_folder_id,
        to_folder_id: targetFolderId,
        to_subfolder: subName,
        ai_confidence: file.v2_confidence,
        ai_model: 'sonnet-4-6',
        ai_reason: reason,
        project_id: file.v2_project_id,
        project_name: project.name,
      });

      moved++;
      console.log(`  [MOVED] ${file.file_name} → ${project.name}/${subName}`);
      await delay(300);
    } catch (err) {
      console.error(`  [ERROR] ${file.file_name}: ${err.message}`);
      failed++;
      await delay(1000);
    }
  }

  console.log(`\n=== DONE: moved ${moved}, skipped ${skipped}, failed ${failed} ===`);

  if (moved > 0) {
    await supabase.from('massivlust_sync_runs').insert({
      source: 'auto_move_classified',
      status: failed === 0 ? 'success' : 'partial',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      rows_in: files.length,
      rows_upserted: moved,
      rows_failed: failed,
      org_id: 'massivlust',
    });
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
