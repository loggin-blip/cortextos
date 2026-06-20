import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { Readable } from 'stream';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const IMPERSONATE = process.env.GOOGLE_IMPERSONATE_EMAIL || 'alex@massivlust.no';
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function getDriveClient() {
  const auth = new google.auth.JWT(
    SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive'],
    IMPERSONATE,
  );
  return google.drive({ version: 'v3', auth });
}

function getGmailClient() {
  const auth = new google.auth.JWT(
    SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/gmail.modify'],
    IMPERSONATE,
  );
  return google.gmail({ version: 'v1', auth });
}

const drive = getDriveClient();
const gmail = getGmailClient();

const SUBFOLDER_STRUCTURE = [
  '00 Oversikt',
  '01 Avvik',
  '02 Bilder',
  '03 Mail',
  '04 Dokumenter',
  '05 Sjekklister',
  '06 HMS',
  '07 Oppfølging',
];

const OPPFOLGING_SUBS = ['Før oppstart', 'I oppstart', 'Under veis', 'Etter avsluttet'];

async function createDriveFolder(name, parentId) {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    supportsAllDrives: true,
    fields: 'id,name',
  });
  return res.data;
}

async function uploadToDrive(fileName, mimeType, buffer, parentId) {
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    supportsAllDrives: true,
    fields: 'id,name',
  });
  return res.data;
}

async function checkFileExists(name, parentId) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: 'files(id,name)',
  });
  return res.data.files?.length > 0;
}

async function getAttachment(messageId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return Buffer.from(res.data.data, 'base64url');
}

function classifyAttachment(fileName, subject) {
  const fn = (fileName || '').toLowerCase();
  const subj = (subject || '').toLowerCase();

  if (fn.endsWith('.ifc')) return '04 Dokumenter';
  if (/\.(jpg|jpeg|png|heic|heif|gif|bmp|webp)$/.test(fn)) return '02 Bilder';
  if (/\.(pdf)$/.test(fn) && /(ks|kontroll|sjekkliste)/.test(fn + ' ' + subj)) return '05 Sjekklister';
  if (/\.(pdf)$/.test(fn) && /avvik/.test(fn + ' ' + subj)) return '01 Avvik';
  if (/\.(pdf)$/.test(fn) && /(hms|sha|ruh)/.test(fn + ' ' + subj)) return '06 HMS';
  return '04 Dokumenter';
}

function extractAttachments(payload, results = []) {
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.filename && part.body?.attachmentId) {
        results.push({
          filename: part.filename,
          mimeType: part.mimeType,
          attachmentId: part.body.attachmentId,
          size: part.body.size || 0,
        });
      }
      extractAttachments(part, results);
    }
  }
  return results;
}

async function createProjectStructure(projectName) {
  console.log(`[MKDIR] Creating folder structure for: ${projectName}`);
  const root = await createDriveFolder(projectName, SHARED_DRIVE_ID);
  console.log(`[MKDIR] Root: ${root.id} — ${root.name}`);

  const subfolderIds = {};
  for (const sub of SUBFOLDER_STRUCTURE) {
    const folder = await createDriveFolder(sub, root.id);
    subfolderIds[sub] = folder.id;
    console.log(`[MKDIR]   ${sub}: ${folder.id}`);
  }

  for (const oppSub of OPPFOLGING_SUBS) {
    const folder = await createDriveFolder(oppSub, subfolderIds['07 Oppfølging']);
    console.log(`[MKDIR]     07/${oppSub}: ${folder.id}`);
  }

  return { rootId: root.id, subfolderIds };
}

async function searchGmailForProject(projectName, searchVariations) {
  const queries = searchVariations.map(v => `"${v}"`).join(' OR ');
  const query = `(${queries}) has:attachment newer_than:24m`;

  console.log(`[GMAIL] Searching: ${query}`);
  const messages = [];
  let pageToken = null;

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
      pageToken,
    });
    const ids = res.data.messages || [];
    messages.push(...ids);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`[GMAIL] Found ${messages.length} messages for ${projectName}`);
  return messages;
}

async function processProject(project, existingFolderId) {
  const stats = {
    project: project.name,
    project_id: project.id,
    drive_root_id: null,
    folders_created: 0,
    attachments_found: 0,
    attachments_uploaded: 0,
    attachments_skipped: 0,
    attachments_failed: 0,
    errors: [],
  };

  let rootId = existingFolderId;
  let subfolderIds = {};

  if (!rootId) {
    const structure = await createProjectStructure(project.name);
    rootId = structure.rootId;
    subfolderIds = structure.subfolderIds;
    stats.folders_created = SUBFOLDER_STRUCTURE.length + OPPFOLGING_SUBS.length + 1;

    await supabase
      .from('massivlust_projects')
      .update({ drive_root_folder_id: rootId })
      .eq('id', project.id);
    console.log(`[DB] Updated drive_root_folder_id for ${project.name}`);
  } else {
    const items = await drive.files.list({
      q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id,name)',
    });
    for (const f of (items.data.files || [])) {
      subfolderIds[f.name] = f.id;
    }
    const missing = SUBFOLDER_STRUCTURE.filter(s => !subfolderIds[s]);
    for (const sub of missing) {
      const folder = await createDriveFolder(sub, rootId);
      subfolderIds[sub] = folder.id;
      stats.folders_created++;
      console.log(`[MKDIR] Added missing subfolder ${sub}: ${folder.id}`);
    }
  }

  stats.drive_root_id = rootId;

  const variations = buildSearchVariations(project.name);
  const messages = await searchGmailForProject(project.name, variations);

  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const headers = full.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const emailDate = new Date(date);
      const dateStr = emailDate.toISOString().slice(0, 10);

      const attachments = extractAttachments(full.data.payload || {});
      stats.attachments_found += attachments.length;

      for (const att of attachments) {
        try {
          const targetFolder = classifyAttachment(att.filename, subject);
          let targetId = subfolderIds[targetFolder] || subfolderIds['04 Dokumenter'];

          if (targetFolder === '02 Bilder' && targetId) {
            const dateFolderId = await getOrCreateDateFolder(targetId, dateStr);
            targetId = dateFolderId;
          }

          if (!targetId) {
            console.log(`[SKIP] No target folder for ${att.filename}`);
            stats.attachments_skipped++;
            continue;
          }

          const exists = await checkFileExists(att.filename, targetId);
          if (exists) {
            stats.attachments_skipped++;
            continue;
          }

          const data = await getAttachment(msg.id, att.attachmentId);
          await uploadToDrive(att.filename, att.mimeType, data, targetId);
          stats.attachments_uploaded++;
          console.log(`[UPLOAD] ${att.filename} → ${targetFolder} (${project.name})`);
        } catch (err) {
          stats.attachments_failed++;
          stats.errors.push(`${att.filename}: ${err.message}`);
          console.error(`[ERROR] ${att.filename}: ${err.message}`);
        }
      }

      if (stats.attachments_uploaded % 10 === 0 && stats.attachments_uploaded > 0) {
        await delay(1000);
      }
    } catch (err) {
      if (err.code === 429 || err.status === 429) {
        console.warn(`[RATE] Rate limited — pausing 30s`);
        await delay(30000);
      } else {
        stats.errors.push(`msg ${msg.id}: ${err.message}`);
        console.error(`[ERROR] msg ${msg.id}: ${err.message}`);
      }
    }
  }

  await logSyncRun(project.name, stats);
  return stats;
}

const dateFolderCache = {};
async function getOrCreateDateFolder(parentId, dateStr) {
  const key = `${parentId}:${dateStr}`;
  if (dateFolderCache[key]) return dateFolderCache[key];

  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${dateStr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: 'files(id)',
  });

  if (res.data.files?.length > 0) {
    dateFolderCache[key] = res.data.files[0].id;
    return res.data.files[0].id;
  }

  const folder = await createDriveFolder(dateStr, parentId);
  dateFolderCache[key] = folder.id;
  return folder.id;
}

function buildSearchVariations(name) {
  const variations = [name];
  const words = name.split(/\s+/);
  if (words.length > 1) {
    variations.push(words[0]);
    if (words.length > 2) variations.push(words.slice(0, 2).join(' '));
  }
  const noSuffix = name.replace(/\s+(skole|barnehage|vgs|sykehjem|svømmehall|sentrumsbygg)\s*$/i, '').trim();
  if (noSuffix !== name) variations.push(noSuffix);
  return [...new Set(variations)];
}

async function logSyncRun(projectName, stats) {
  const slug = projectName.toLowerCase().replace(/[^a-zæøå0-9]+/g, '_');
  await supabase.from('massivlust_sync_runs').insert({
    source: `gmail_recovery_${slug}`,
    status: stats.attachments_failed === 0 ? 'success' : 'partial',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    rows_in: stats.attachments_found,
    rows_upserted: stats.attachments_uploaded,
    rows_skipped: stats.attachments_skipped,
    rows_failed: stats.attachments_failed,
    payload: stats,
  });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const TARGET_PROJECTS = [
  'Alvsbyhus', 'Enghave Brygge', 'Hommersåk Skole', 'Jessheim VGS',
  'Kiwi Sandved', 'Kvernevik Skole', 'Mule Sykehjem',
  'Nøkkeland Svømmehall', 'Sagatangen', 'Bortelid sentrumsbygg',
];

async function main() {
  console.log('=== Gmail/Drive Recovery Script ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Projects: ${TARGET_PROJECTS.length}`);

  const { data: projects } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id');

  const projectMap = {};
  for (const p of projects) {
    projectMap[p.name] = p;
  }

  const allStats = [];

  for (const projName of TARGET_PROJECTS) {
    const dbProject = projectMap[projName];
    if (!dbProject) {
      console.error(`[SKIP] Project not found in DB: ${projName}`);
      continue;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing: ${projName} (${dbProject.id})`);
    if (dbProject.drive_root_folder_id) {
      console.log(`[INFO] Already has Drive folder: ${dbProject.drive_root_folder_id}`);
    }
    console.log('='.repeat(60));

    try {
      const stats = await processProject(dbProject, dbProject.drive_root_folder_id);
      allStats.push(stats);
      console.log(`[DONE] ${projName}: ${stats.attachments_uploaded} uploaded, ${stats.attachments_skipped} skipped, ${stats.attachments_failed} failed`);
    } catch (err) {
      console.error(`[FATAL] ${projName}: ${err.message}`);
      allStats.push({ project: projName, error: err.message });
    }
  }

  console.log('\n=== FINAL REPORT ===');
  let totalUploaded = 0, totalFound = 0, totalSkipped = 0, totalFailed = 0;
  for (const s of allStats) {
    if (s.error) {
      console.log(`  ${s.project}: FATAL ERROR — ${s.error}`);
    } else {
      console.log(`  ${s.project}: ${s.attachments_uploaded} uploaded, ${s.attachments_skipped} skipped, ${s.attachments_failed} failed (${s.attachments_found} found)`);
      totalUploaded += s.attachments_uploaded;
      totalFound += s.attachments_found;
      totalSkipped += s.attachments_skipped;
      totalFailed += s.attachments_failed;
    }
  }
  console.log(`\nTOTALS: ${totalFound} found, ${totalUploaded} uploaded, ${totalSkipped} skipped, ${totalFailed} failed`);
  console.log(`Finished: ${new Date().toISOString()}`);

  console.log(JSON.stringify({ summary: allStats, totals: { totalFound, totalUploaded, totalSkipped, totalFailed } }));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
