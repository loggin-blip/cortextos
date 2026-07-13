/**
 * Phase 3: Move classified files to correct subfolders.
 * Loops auto-move until no files remain.
 * Priority: VG54 → Roan → Mule → all others.
 * After move: Opus spot-check on random sample.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';
const MIN_CONFIDENCE = 0.92;
const BATCH_LIMIT = 200;
const SPOT_CHECK_COUNT = 20;
const MODEL_SPOTCHECK = 'claude-opus-4-7';

// VG54: always use canonical folder A, never touch old folder B
const FOLDER_OVERRIDES = {
  'cd0c96aa-dfad-43ff-a34d-8cb7b65d2438': '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn', // Verksgata 54
};
const VG54_FORBIDDEN = '1uveyJJtcVU6koVijosOEOYWPoqN3oWKe';

// Priority project ordering
const PRIORITY_PROJECTS = [
  'cd0c96aa-dfad-43ff-a34d-8cb7b65d2438', // Verksgata 54
  'f9de5104-960b-4877-972b-03942dc1f30e', // Roan
  '3111ee50-028b-46e4-9a25-e7c25f15431f', // Mule
];

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
    supportsAllDrives: true, includeItemsFromAllDrives: true,
    fields: 'files(id, name)',
  });
  return res.data.files?.[0]?.id || null;
}

async function getCurrentParent(drive, fileId) {
  const r = await drive.files.get({ fileId, supportsAllDrives: true, fields: 'parents' });
  return r.data.parents?.[0] || null;
}

async function moveFile(drive, fileId, fromFolderId, toFolderId) {
  if (!fileId) throw new Error('drive_file_id is null — refusing to move');
  const removeParent = fromFolderId || await getCurrentParent(drive, fileId);
  const res = await drive.files.update({
    fileId, addParents: toFolderId, removeParents: removeParent || undefined,
    supportsAllDrives: true, fields: 'id, parents',
  });
  if (!res.data.parents?.includes(toFolderId)) {
    throw new Error(`Move unconfirmed: file ${fileId} parents=${JSON.stringify(res.data.parents)}`);
  }
  return res.data;
}

async function fetchBatch(priorityProjectId = null) {
  let query = supabase
    .from('massivlust_unclassified_files')
    .select(`id, file_name, drive_file_id, source_type, mime_type,
      current_drive_folder_id, v2_project_id, v2_confidence, v2_method,
      v2_is_personal, v2_suggestions`)
    .eq('v2_model', 'sonnet-4-6')
    .eq('v2_is_personal', false)
    .gte('v2_confidence', MIN_CONFIDENCE)
    .not('v2_project_id', 'is', null)
    .not('drive_file_id', 'is', null)
    .is('drive_destination_id', null)
    .limit(BATCH_LIMIT);

  if (priorityProjectId) query = query.eq('v2_project_id', priorityProjectId);

  const { data, error } = await query;
  if (error) throw new Error(`DB error: ${error.message}`);
  return data || [];
}

async function processBatch(drive, files, projectMap, subfolderCache) {
  let moved = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const project = projectMap.get(file.v2_project_id);
    if (!project?.drive_root_folder_id) {
      console.warn(`  [SKIP] ${file.file_name} — no Drive folder for project`);
      skipped++; continue;
    }

    const rootFolderId = FOLDER_OVERRIDES[file.v2_project_id] || project.drive_root_folder_id;

    if (rootFolderId === VG54_FORBIDDEN) {
      console.warn(`  [SKIP-FORBIDDEN] ${file.file_name} — would target old VG54 folder`);
      skipped++; continue;
    }

    if (!file.drive_file_id) {
      console.warn(`  [SKIP-NULL-ID] ${file.file_name}`);
      skipped++; continue;
    }

    const subName = pickSubfolder(file);
    const cacheKey = `${rootFolderId}/${subName}`;
    let targetFolderId = subfolderCache.get(cacheKey);
    if (!targetFolderId) {
      targetFolderId = await findSubfolder(drive, rootFolderId, subName);
      if (targetFolderId) subfolderCache.set(cacheKey, targetFolderId);
    }

    if (!targetFolderId) {
      console.warn(`  [SKIP] ${file.file_name} — subfolder '${subName}' not found in ${project.name}`);
      skipped++; continue;
    }

    try {
      await moveFile(drive, file.drive_file_id, file.current_drive_folder_id, targetFolderId);

      await supabase.from('massivlust_unclassified_files')
        .update({ drive_destination_id: targetFolderId, status: 'moved' })
        .eq('id', file.id);

      await supabase.from('massivlust_audit_moves').insert({
        file_id: file.id,
        file_name: file.file_name,
        from_folder_id: file.current_drive_folder_id,
        to_folder_id: targetFolderId,
        ai_confidence: file.v2_confidence,
        ai_model: 'sonnet-4-6',
        ai_reason: file.v2_suggestions?.reasoning || null,
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

  return { moved, skipped, failed };
}

async function opusSpotCheck(sampleMoves) {
  console.log(`\n=== OPUS SPOT-CHECK (${sampleMoves.length} samples) ===`);
  const drive = makeDrive();
  const checks = [];

  for (const m of sampleMoves) {
    try {
      const r = await drive.files.get({ fileId: m.drive_file_id, supportsAllDrives: true, fields: 'parents, name' });
      const isInTarget = r.data.parents?.includes(m.to_folder_id);
      checks.push({ file: m.file_name, project: m.project_name, subfolder: m.subfolder, inTarget: isInTarget });
      await delay(200);
    } catch (err) {
      checks.push({ file: m.file_name, error: err.message });
    }
  }

  const confirmed = checks.filter(c => c.inTarget).length;
  const failed = checks.filter(c => !c.inTarget && !c.error).length;
  const errors = checks.filter(c => c.error).length;

  const prompt = `You are verifying a file organization pipeline for Massiv Lust AS (Norwegian timber construction company).

${SPOT_CHECK_COUNT} files were moved from a classification queue to project subfolders in Google Drive.
Drive verification confirms ${confirmed}/${checks.length} are in the correct destination folder.

Spot-check results:
${checks.map((c, i) => `[${i+1}] ${c.file} → ${c.project || 'unknown'}/${c.subfolder || ''}: ${c.inTarget ? 'CONFIRMED' : c.error ? `ERROR: ${c.error}` : 'NOT IN TARGET'}`).join('\n')}

Assess:
1. Is the pipeline working correctly? (confirmed rate, failure patterns)
2. Are any of the NOT IN TARGET cases concerning vs expected (e.g. permission errors on personal files)?
3. Any action items before proceeding to Phase 4?

Keep assessment under 150 words.`;

  const tmpFile = join(tmpdir(), `spotcheck-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt);
  let assessment = '';
  try {
    const raw = execSync(`cat "${tmpFile}" | claude --print --model ${MODEL_SPOTCHECK} --output-format json`,
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf-8' }).trim();
    const env = JSON.parse(raw);
    assessment = env.result || raw;
  } catch (err) {
    assessment = `Spot-check CLI error: ${err.message?.slice(0, 100)}`;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }

  console.log(`Confirmed: ${confirmed}/${checks.length} | Failed: ${failed} | Errors: ${errors}`);
  console.log(`Opus assessment:\n${assessment}`);

  return { confirmed, failed, errors, total: checks.length, assessment };
}

async function main() {
  console.log(`=== PHASE 3: AUTO-MOVE (conf >= ${MIN_CONFIDENCE}) ===`);
  const drive = makeDrive();
  const subfolderCache = new Map();
  let totalMoved = 0, totalSkipped = 0, totalFailed = 0;
  const sampleForSpotCheck = [];
  const start = Date.now();

  // Fetch all projects upfront
  const { data: projects } = await supabase.from('massivlust_projects').select('id, name, drive_root_folder_id');
  const projectMap = new Map(projects?.map(p => [p.id, p]) || []);

  // Phase 3a: Priority projects first
  for (const pid of PRIORITY_PROJECTS) {
    const proj = projectMap.get(pid);
    const files = await fetchBatch(pid);
    if (!files.length) { console.log(`[PRIORITY] ${proj?.name || pid}: no eligible files`); continue; }
    console.log(`\n[PRIORITY] ${proj?.name || pid}: ${files.length} files`);
    const res = await processBatch(drive, files, projectMap, subfolderCache);
    totalMoved += res.moved; totalSkipped += res.skipped; totalFailed += res.failed;

    // Collect samples for spot-check
    for (const f of files.slice(0, 3)) {
      if (f.drive_file_id) {
        const rootFolderId = FOLDER_OVERRIDES[f.v2_project_id] || projectMap.get(f.v2_project_id)?.drive_root_folder_id;
        const subfolder = pickSubfolder(f);
        const cacheKey = `${rootFolderId}/${subfolder}`;
        const toFolderId = subfolderCache.get(cacheKey);
        if (toFolderId) sampleForSpotCheck.push({ drive_file_id: f.drive_file_id, file_name: f.file_name, to_folder_id: toFolderId, project_name: proj?.name, subfolder });
      }
    }
  }

  // Phase 3b: All remaining
  let batchNum = 0;
  while (true) {
    const files = await fetchBatch();
    if (!files.length) { console.log('\nNo more files to move.'); break; }
    batchNum++;
    console.log(`\nBatch ${batchNum}: ${files.length} files`);
    const res = await processBatch(drive, files, projectMap, subfolderCache);
    totalMoved += res.moved; totalSkipped += res.skipped; totalFailed += res.failed;

    // Collect spot-check samples
    if (sampleForSpotCheck.length < SPOT_CHECK_COUNT) {
      for (const f of files.slice(0, 3)) {
        if (f.drive_file_id && sampleForSpotCheck.length < SPOT_CHECK_COUNT) {
          const rootFolderId = FOLDER_OVERRIDES[f.v2_project_id] || projectMap.get(f.v2_project_id)?.drive_root_folder_id;
          const subfolder = pickSubfolder(f);
          const cacheKey = `${rootFolderId}/${subfolder}`;
          const toFolderId = subfolderCache.get(cacheKey);
          if (toFolderId) sampleForSpotCheck.push({ drive_file_id: f.drive_file_id, file_name: f.file_name, to_folder_id: toFolderId, project_name: projectMap.get(f.v2_project_id)?.name, subfolder });
        }
      }
    }

    const elapsed = Math.round((Date.now() - start) / 60000);
    console.log(`  Total: moved=${totalMoved} skipped=${totalSkipped} failed=${totalFailed} | ${elapsed}min`);
  }

  const elapsed = Math.round((Date.now() - start) / 60000);
  console.log(`\n=== PHASE 3 MOVE DONE: ${totalMoved} moved, ${totalSkipped} skipped, ${totalFailed} failed in ${elapsed}min ===`);

  await supabase.from('massivlust_sync_runs').insert({
    source: 'pipeline_jun13_phase3_move',
    status: totalFailed === 0 ? 'success' : 'partial',
    started_at: new Date(start).toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: totalMoved + totalSkipped + totalFailed,
    rows_upserted: totalMoved,
    rows_failed: totalFailed,
    org_id: 'massivlust',
  });

  // Opus spot-check
  let spotResult = null;
  if (sampleForSpotCheck.length > 0) {
    spotResult = await opusSpotCheck(sampleForSpotCheck.slice(0, SPOT_CHECK_COUNT));
  }

  // Count personal files for Phase 4 report
  const { count: personalCount } = await supabase
    .from('massivlust_unclassified_files')
    .select('id', { count: 'exact', head: true })
    .eq('v2_is_personal', true)
    .eq('v2_model', 'sonnet-4-6')
    .is('drive_destination_id', null);

  const { data: personalSample } = await supabase
    .from('massivlust_unclassified_files')
    .select('file_name, mime_type, source_type, gmail_subject, gmail_from')
    .eq('v2_is_personal', true)
    .eq('v2_model', 'sonnet-4-6')
    .is('drive_destination_id', null)
    .limit(10);

  const sampleList = personalSample?.map(f =>
    `• ${f.file_name}${f.gmail_subject ? ` (emne: ${f.gmail_subject})` : ''}${f.gmail_from ? ` fra ${f.gmail_from}` : ''}`
  ).join('\n') || '(ingen)';

  console.log(`\n=== PHASE 4 BRIEFING ===`);
  console.log(`Personal files (Sonnet-verifisert): ${personalCount}`);
  console.log(`Sample:\n${sampleList}`);

  const spotSummary = spotResult
    ? `Spot-check: ${spotResult.confirmed}/${spotResult.total} bekreftet i Drive. Opus: "${spotResult.assessment?.slice(0, 200)}"`
    : 'Spot-check: ingen samples';

  const bridgeMsg = `FASE 3 FERDIG ✓

Flytt: ${totalMoved} filer til korrekte undermapper | Skipped: ${totalSkipped} | Feil: ${totalFailed} | Tid: ${elapsed}min

${spotSummary}

FASE 4 — VENTER PÅ MAX-GO:
Personal filer (Sonnet-verifisert): ${personalCount}
Stikkprøve (10 av ${personalCount}):
${sampleList}

Bekreft GO for sletting — da kjøres Opus dobbeltsjekk på utvalg FØR papirkurv.`;

  console.log('\nSending bridge report...');
  try {
    execSync(`cortextos bus send-message bridge normal ${JSON.stringify(bridgeMsg)} 1781361250585-bridge-vt2lz`, { encoding: 'utf-8' });
    console.log('Bridge report sent.');
  } catch (err) {
    console.error(`Bridge send failed: ${err.message?.slice(0, 100)}`);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
