import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { Readable } from 'stream';

const PROJECT_NAME = process.argv[2];
if (!PROJECT_NAME) {
  console.error('Usage: node gmail-drive-recovery-single.js "Project Name"');
  process.exit(1);
}

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
  '00 Oversikt', '01 Avvik', '02 Bilder', '03 Mail',
  '04 Dokumenter', '05 Sjekklister', '06 HMS', '07 Oppfølging',
];
const OPPFOLGING_SUBS = ['Før oppstart', 'I oppstart', 'Under veis', 'Etter avsluttet'];

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function withBackoff(fn, label = '') {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if ((err.code === 429 || err.status === 429) && attempt < 8) {
        const wait = Math.min(2000 * Math.pow(2, attempt), 60000);
        attempt++;
        console.warn(`[BACKOFF] ${label} — 429, attempt ${attempt}, waiting ${wait / 1000}s`);
        await delay(wait);
      } else {
        throw err;
      }
    }
  }
}

async function createDriveFolder(name, parentId) {
  const res = await withBackoff(() => drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    supportsAllDrives: true,
    fields: 'id,name',
  }), `mkdir ${name}`);
  return res.data;
}

async function uploadToDrive(fileName, mimeType, buffer, parentId) {
  const res = await withBackoff(() => drive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType, body: Readable.from(buffer) },
    supportsAllDrives: true,
    fields: 'id,name',
  }), `upload ${fileName}`);
  return res.data;
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

async function getAttachment(messageId, attachmentId) {
  const res = await withBackoff(() => gmail.users.messages.attachments.get({
    userId: 'me', messageId, id: attachmentId,
  }), `att ${messageId}`);
  return Buffer.from(res.data.data, 'base64url');
}

function classifyAttachment(fileName, subject) {
  const fn = (fileName || '').toLowerCase();
  const subj = (subject || '').toLowerCase();
  if (fn.endsWith('.ifc')) return '04 Dokumenter';
  if (/\.(jpg|jpeg|png|heic|heif|gif|bmp|webp)$/.test(fn)) return '02 Bilder';
  if (/\.pdf$/.test(fn) && /(ks|kontroll|sjekkliste)/.test(fn + ' ' + subj)) return '05 Sjekklister';
  if (/\.pdf$/.test(fn) && /avvik/.test(fn + ' ' + subj)) return '01 Avvik';
  if (/\.pdf$/.test(fn) && /(hms|sha|ruh)/.test(fn + ' ' + subj)) return '06 HMS';
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

const dateFolderCache = {};
async function getOrCreateDateFolder(parentId, dateStr) {
  const key = `${parentId}:${dateStr}`;
  if (dateFolderCache[key]) return dateFolderCache[key];
  const res = await withBackoff(() => drive.files.list({
    q: `'${parentId}' in parents and name = '${dateStr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id)',
  }), `dateFolder ${dateStr}`);
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

async function createProjectStructure(projectName) {
  console.log(`[MKDIR] Creating folder structure for: ${projectName}`);
  const root = await createDriveFolder(projectName, SHARED_DRIVE_ID);
  console.log(`[MKDIR] Root: ${root.id}`);
  const subfolderIds = {};
  for (const sub of SUBFOLDER_STRUCTURE) {
    const folder = await createDriveFolder(sub, root.id);
    subfolderIds[sub] = folder.id;
  }
  for (const oppSub of OPPFOLGING_SUBS) {
    await createDriveFolder(oppSub, subfolderIds['07 Oppfølging']);
  }
  return { rootId: root.id, subfolderIds };
}

async function main() {
  console.log(`[${PROJECT_NAME}] Starting recovery — ${new Date().toISOString()}`);

  const { data: projects } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id')
    .eq('name', PROJECT_NAME)
    .limit(1);

  if (!projects?.length) {
    console.error(`[${PROJECT_NAME}] NOT FOUND in DB`);
    process.exit(1);
  }

  const dbProject = projects[0];
  let rootId = dbProject.drive_root_folder_id;
  let subfolderIds = {};

  if (!rootId) {
    const structure = await createProjectStructure(PROJECT_NAME);
    rootId = structure.rootId;
    subfolderIds = structure.subfolderIds;
    await supabase.from('massivlust_projects')
      .update({ drive_root_folder_id: rootId })
      .eq('id', dbProject.id);
    console.log(`[${PROJECT_NAME}] Drive folder created: ${rootId}`);
  } else {
    console.log(`[${PROJECT_NAME}] Using existing folder: ${rootId}`);
    const items = await withBackoff(() => drive.files.list({
      q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id,name)',
    }), 'list subfolders');
    for (const f of (items.data.files || [])) subfolderIds[f.name] = f.id;
    for (const sub of SUBFOLDER_STRUCTURE) {
      if (!subfolderIds[sub]) {
        const folder = await createDriveFolder(sub, rootId);
        subfolderIds[sub] = folder.id;
      }
    }
  }

  const variations = buildSearchVariations(PROJECT_NAME);
  const queries = variations.map(v => `"${v}"`).join(' OR ');
  const query = `(${queries}) has:attachment newer_than:24m`;
  console.log(`[${PROJECT_NAME}] Gmail search: ${query}`);

  const messages = [];
  let pageToken = null;
  do {
    const res = await withBackoff(() => gmail.users.messages.list({
      userId: 'me', q: query, maxResults: 100, pageToken,
    }), 'gmail list');
    messages.push(...(res.data.messages || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`[${PROJECT_NAME}] Found ${messages.length} messages`);

  let uploaded = 0, skipped = 0, failed = 0, found = 0;

  for (const msg of messages) {
    try {
      const full = await withBackoff(() => gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'full',
      }), `msg ${msg.id}`);

      const headers = full.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const emailDate = new Date(date);
      const dateStr = emailDate.toISOString().slice(0, 10);

      const attachments = extractAttachments(full.data.payload || {});
      found += attachments.length;

      for (const att of attachments) {
        try {
          const targetFolder = classifyAttachment(att.filename, subject);
          let targetId = subfolderIds[targetFolder] || subfolderIds['04 Dokumenter'];

          if (targetFolder === '02 Bilder' && targetId) {
            targetId = await getOrCreateDateFolder(targetId, dateStr);
          }

          if (!targetId) { skipped++; continue; }

          const exists = await checkFileExists(att.filename, targetId);
          if (exists) { skipped++; continue; }

          const data = await getAttachment(msg.id, att.attachmentId);
          await uploadToDrive(att.filename, att.mimeType, data, targetId);
          uploaded++;
          console.log(`[${PROJECT_NAME}] UPLOAD ${att.filename} → ${targetFolder}`);
        } catch (err) {
          failed++;
          console.error(`[${PROJECT_NAME}] FAIL ${att.filename}: ${err.message}`);
        }
      }
    } catch (err) {
      if (err.code === 429 || err.status === 429) {
        console.warn(`[${PROJECT_NAME}] Rate limited on msg fetch — waiting 30s`);
        await delay(30000);
      } else {
        console.error(`[${PROJECT_NAME}] ERROR msg ${msg.id}: ${err.message}`);
      }
    }
  }

  const slug = PROJECT_NAME.toLowerCase().replace(/[^a-zæøå0-9]+/g, '_');
  await supabase.from('massivlust_sync_runs').insert({
    source: `gmail_recovery_${slug}`,
    status: failed === 0 ? 'success' : 'partial',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: found,
    rows_upserted: uploaded,
    rows_skipped: skipped,
    rows_failed: failed,
    payload: { project: PROJECT_NAME, project_id: dbProject.id, drive_root_id: rootId },
  });

  console.log(`[${PROJECT_NAME}] DONE: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed (${found} found)`);
}

main().catch(err => {
  console.error(`[${PROJECT_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
