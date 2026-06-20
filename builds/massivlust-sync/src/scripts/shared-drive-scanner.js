import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { Readable } from 'stream';

// --- Args ---
const DRIVE_ID = process.argv[2];
const DRIVE_NAME = process.argv[3];
if (!DRIVE_ID || !DRIVE_NAME) {
  console.error('Usage: node shared-drive-scanner.js <shared-drive-id> <shared-drive-name>');
  console.error('');
  console.error('Known drives:');
  console.error('  0AJ3pg2woKsE8Uk9PVA  FrenzyFjords');
  console.error('  0AIC-gus1hNsLUk9PVA  "Massiv Lust AS"');
  console.error('  0AIIIp5UC97pCUk9PVA  "Mathias og Alex"');
  process.exit(1);
}

// Target Shared Drive — never copy FROM here
const TARGET_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';

// --- Setup ---
const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ALEX_EMAIL = 'alex@massivlust.no';

function makeDrive(email, scopes = ['https://www.googleapis.com/auth/drive']) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key, scopes, email);
  return google.drive({ version: 'v3', auth });
}

// Single Drive client using alex@ for both read and write
const drive = makeDrive(ALEX_EMAIL);

// --- Backoff ---
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function withBackoff(fn, label = '') {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      if ((err.code === 429 || err.status === 429) && attempt < 8) {
        const wait = Math.min(2000 * Math.pow(2, attempt), 60000);
        attempt++;
        console.warn(`[BACKOFF] ${label} -- 429, attempt ${attempt}, waiting ${wait / 1000}s`);
        await delay(wait);
      } else { throw err; }
    }
  }
}

// --- Classification (same rules as user-recovery.js) ---
function classifyFile(fileName) {
  const fn = (fileName || '').toLowerCase();
  if (fn.endsWith('.ifc')) return '04 Dokumenter';
  if (/\.(jpg|jpeg|png|heic|heif|gif|bmp|webp)$/.test(fn)) return '02 Bilder';
  if (/\.pdf$/.test(fn) && /(ks|kontroll|sjekkliste)/.test(fn)) return '05 Sjekklister';
  if (/\.pdf$/.test(fn) && /avvik/.test(fn)) return '01 Avvik';
  if (/\.pdf$/.test(fn) && /(hms|sha|ruh)/.test(fn)) return '06 HMS';
  return '04 Dokumenter';
}

// --- Project name matching ---
function buildSearchVariations(name) {
  const variations = [name.toLowerCase()];
  const words = name.split(/\s+/);
  if (words.length > 1) {
    variations.push(words[0].toLowerCase());
    if (words.length > 2) {
      variations.push(words.slice(0, 2).join(' ').toLowerCase());
    }
  }
  // Strip common suffixes
  const noSuffix = name.replace(/\s+(skole|barnehage|vgs|sykehjem|svommehall|sentrumsbygg)\s*$/i, '').trim();
  if (noSuffix.toLowerCase() !== name.toLowerCase()) {
    variations.push(noSuffix.toLowerCase());
  }
  return [...new Set(variations)];
}

function matchFileToProject(fileName, projectVariationsMap) {
  const fnLower = fileName.toLowerCase();
  // Try longest (most specific) variations first — full name, then 2-word, then 1-word
  let bestMatch = null;
  let bestLen = 0;
  for (const [projectId, { variations, project }] of projectVariationsMap.entries()) {
    for (const v of variations) {
      if (v.length > bestLen && fnLower.includes(v)) {
        bestMatch = project;
        bestLen = v.length;
      }
    }
  }
  return bestMatch;
}

// --- Drive helpers ---
async function listAllFilesInDrive(driveId) {
  console.log(`[SCAN] Listing all files in Shared Drive: ${DRIVE_NAME} (${driveId})`);
  const allFiles = [];
  let pageToken = null;
  let pages = 0;

  do {
    const res = await withBackoff(() => drive.files.list({
      corpora: 'drive',
      driveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: "mimeType != 'application/vnd.google-apps.folder' and trashed = false",
      pageSize: 1000,
      pageToken,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,driveId,parents)',
    }), `list page ${pages}`);

    const files = res.data.files || [];
    allFiles.push(...files);
    pageToken = res.data.nextPageToken;
    pages++;
    if (pages % 5 === 0) console.log(`  ... ${allFiles.length} files so far (page ${pages})`);
  } while (pageToken);

  console.log(`[SCAN] Found ${allFiles.length} files across ${pages} pages`);
  return allFiles;
}

async function getSubfolders(rootId) {
  const items = await withBackoff(() => drive.files.list({
    q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: 'files(id,name)',
  }), `subfolders ${rootId}`);
  const map = {};
  for (const f of (items.data.files || [])) map[f.name] = f.id;
  return map;
}

async function checkFileExists(name, parentId) {
  const res = await withBackoff(() => drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: 'files(id,name)',
  }), `check ${name}`);
  return res.data.files?.length > 0;
}

async function copyFileToDrive(sourceFileId, fileName, targetFolderId) {
  // Use Drive copy API — avoids download+upload, preserves metadata, faster
  const res = await withBackoff(() => drive.files.copy({
    fileId: sourceFileId,
    requestBody: {
      name: fileName,
      parents: [targetFolderId],
    },
    supportsAllDrives: true,
    fields: 'id,name',
  }), `copy ${fileName}`);
  return res.data;
}

// --- Main ---
async function main() {
  const startedAt = new Date().toISOString();
  console.log(`=== Shared Drive Scanner: ${DRIVE_NAME} ===`);
  console.log(`Drive ID: ${DRIVE_ID}`);
  console.log(`Target: Massivlust Prosjekter (${TARGET_DRIVE_ID})`);
  console.log(`Started: ${startedAt}\n`);

  // Skip if someone passes the target drive as source
  if (DRIVE_ID === TARGET_DRIVE_ID) {
    console.error('[ERROR] Cannot scan the target drive as source. Aborting.');
    process.exit(1);
  }

  // 1. Fetch active projects from Supabase
  const { data: projects, error: projErr } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id')
    .eq('archived', false);

  if (projErr) {
    console.error(`[ERROR] Supabase projects query failed: ${projErr.message}`);
    process.exit(1);
  }

  const activeProjects = projects.filter(p => p.drive_root_folder_id);
  console.log(`Active projects with Drive folders: ${activeProjects.length}`);
  for (const p of activeProjects) {
    console.log(`  - ${p.name} (${p.drive_root_folder_id})`);
  }
  console.log('');

  // Build project variations map for matching
  const projectVariationsMap = new Map();
  for (const project of activeProjects) {
    const variations = buildSearchVariations(project.name);
    projectVariationsMap.set(project.id, { variations, project });
  }

  // 2. List all files in the source Shared Drive
  const allFiles = await listAllFilesInDrive(DRIVE_ID);

  // 3. Filter out files that are actually in the target drive (safety check)
  const sourceFiles = allFiles.filter(f => f.driveId !== TARGET_DRIVE_ID);
  if (sourceFiles.length !== allFiles.length) {
    console.log(`[INFO] Filtered out ${allFiles.length - sourceFiles.length} files that belong to target drive`);
  }

  // 4. Match files to projects and copy
  let totalFound = sourceFiles.length;
  let matched = 0;
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const projectStats = {};

  // Cache subfolders per project to avoid repeated lookups
  const subfolderCache = {};

  for (const file of sourceFiles) {
    const project = matchFileToProject(file.name, projectVariationsMap);
    if (!project) continue;

    matched++;
    const projectName = project.name;

    if (!projectStats[projectName]) {
      projectStats[projectName] = { matched: 0, copied: 0, skipped: 0, failed: 0 };
    }
    projectStats[projectName].matched++;

    try {
      // Get subfolders for this project (cached)
      if (!subfolderCache[project.drive_root_folder_id]) {
        subfolderCache[project.drive_root_folder_id] = await getSubfolders(project.drive_root_folder_id);
      }
      const subfolderIds = subfolderCache[project.drive_root_folder_id];

      // Classify into subfolder
      const targetSubfolder = classifyFile(file.name);
      const targetFolderId = subfolderIds[targetSubfolder] || subfolderIds['04 Dokumenter'];

      if (!targetFolderId) {
        console.warn(`  [WARN] No subfolder ${targetSubfolder} for project ${projectName}, skipping ${file.name}`);
        skipped++;
        projectStats[projectName].skipped++;
        continue;
      }

      // Check if file already exists in target
      const exists = await checkFileExists(file.name, targetFolderId);
      if (exists) {
        skipped++;
        projectStats[projectName].skipped++;
        continue;
      }

      // Copy file
      await copyFileToDrive(file.id, file.name, targetFolderId);
      copied++;
      projectStats[projectName].copied++;
      console.log(`  [COPY] ${file.name} -> ${projectName}/${targetSubfolder}`);
    } catch (err) {
      failed++;
      projectStats[projectName].failed++;
      console.error(`  [FAIL] ${file.name} -> ${projectName}: ${err.message}`);
    }
  }

  // 5. Log sync run to Supabase
  const endedAt = new Date().toISOString();
  const driveSafeSlug = DRIVE_NAME.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const status = failed === 0 ? 'success' : 'partial';

  await supabase.from('massivlust_sync_runs').insert({
    source: `shared_drive_scan_${driveSafeSlug}`,
    status,
    started_at: startedAt,
    ended_at: endedAt,
    rows_in: totalFound,
    rows_upserted: copied,
    rows_skipped: skipped,
    rows_failed: failed,
    payload: {
      drive_id: DRIVE_ID,
      drive_name: DRIVE_NAME,
      total_files: totalFound,
      matched,
      copied,
      skipped,
      failed,
      project_breakdown: projectStats,
    },
  });

  // 6. Print summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`SUMMARY: ${DRIVE_NAME} (${DRIVE_ID})`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Total files in drive:   ${totalFound}`);
  console.log(`Matched to projects:    ${matched}`);
  console.log(`Copied:                 ${copied}`);
  console.log(`Skipped (already exist):${skipped}`);
  console.log(`Failed:                 ${failed}`);
  console.log('');

  if (Object.keys(projectStats).length > 0) {
    console.log('Per project:');
    for (const [name, stats] of Object.entries(projectStats)) {
      console.log(`  ${name}: ${stats.matched} matched, ${stats.copied} copied, ${stats.skipped} skipped, ${stats.failed} failed`);
    }
  } else {
    console.log('No files matched any active project.');
  }

  console.log(`\nStatus: ${status}`);
  console.log(`Finished: ${endedAt}`);
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
