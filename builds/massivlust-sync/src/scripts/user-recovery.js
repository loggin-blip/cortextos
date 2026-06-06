import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { Readable } from 'stream';

const USER_EMAIL = process.argv[2];
if (!USER_EMAIL) {
  console.error('Usage: node user-recovery.js user@massivlust.no');
  process.exit(1);
}

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function makeDrive(email, scopes = ['https://www.googleapis.com/auth/drive']) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key, scopes, email);
  return google.drive({ version: 'v3', auth });
}

function makeGmail(email) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/gmail.modify'], email);
  return google.gmail({ version: 'v1', auth });
}

const ALEX_EMAIL = 'alex@massivlust.no';
const userDrive = makeDrive(USER_EMAIL, ['https://www.googleapis.com/auth/drive.readonly']);
const userGmail = makeGmail(USER_EMAIL);
const sharedDrive = makeDrive(ALEX_EMAIL);

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

const SUBFOLDER_STRUCTURE = ['00 Oversikt', '01 Avvik', '02 Bilder', '03 Mail', '04 Dokumenter', '05 Sjekklister', '06 HMS', '07 Oppfølging'];

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
        results.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId });
      }
      extractAttachments(part, results);
    }
  }
  return results;
}

function buildSearchVariations(name) {
  const variations = [name];
  const words = name.split(/\s+/);
  if (words.length > 1) { variations.push(words[0]); if (words.length > 2) variations.push(words.slice(0, 2).join(' ')); }
  const noSuffix = name.replace(/\s+(skole|barnehage|vgs|sykehjem|svømmehall|sentrumsbygg)\s*$/i, '').trim();
  if (noSuffix !== name) variations.push(noSuffix);
  return [...new Set(variations)];
}

async function checkFileExists(name, parentId) {
  const res = await withBackoff(() => sharedDrive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id,name)',
  }), `check ${name}`);
  return res.data.files?.length > 0;
}

async function uploadToDrive(fileName, mimeType, buffer, parentId) {
  const res = await withBackoff(() => sharedDrive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType, body: Readable.from(buffer) },
    supportsAllDrives: true, fields: 'id,name',
  }), `upload ${fileName}`);
  return res.data;
}

async function downloadAndUpload(fileId, fileName, mimeType, parentId) {
  const res = await withBackoff(() => userDrive.files.get(
    { fileId, alt: 'media' }, { responseType: 'arraybuffer' },
  ), `download ${fileName}`);
  const buffer = Buffer.from(res.data);
  return await uploadToDrive(fileName, mimeType, buffer, parentId);
}

const dateFolderCache = {};
async function getOrCreateDateFolder(parentId, dateStr) {
  const key = `${parentId}:${dateStr}`;
  if (dateFolderCache[key]) return dateFolderCache[key];
  const res = await withBackoff(() => sharedDrive.files.list({
    q: `'${parentId}' in parents and name = '${dateStr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id)',
  }), `dateFolder ${dateStr}`);
  if (res.data.files?.length > 0) { dateFolderCache[key] = res.data.files[0].id; return res.data.files[0].id; }
  const folder = await withBackoff(() => sharedDrive.files.create({
    requestBody: { name: dateStr, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    supportsAllDrives: true, fields: 'id',
  }), `mkdir ${dateStr}`);
  dateFolderCache[key] = folder.data.id;
  return folder.data.id;
}

async function getSubfolders(rootId) {
  const items = await withBackoff(() => sharedDrive.files.list({
    q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id,name)',
  }), 'list subfolders');
  const map = {};
  for (const f of (items.data.files || [])) map[f.name] = f.id;
  return map;
}

async function processGmailForProject(project, subfolderIds) {
  const variations = buildSearchVariations(project.name);
  const queries = variations.map(v => `"${v}"`).join(' OR ');
  const query = `(${queries}) has:attachment newer_than:24m`;

  const messages = [];
  let pageToken = null;
  do {
    const res = await withBackoff(() => userGmail.users.messages.list({
      userId: 'me', q: query, maxResults: 100, pageToken,
    }), 'gmail list');
    messages.push(...(res.data.messages || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  let uploaded = 0, skipped = 0, failed = 0, found = 0;

  for (const msg of messages) {
    try {
      const full = await withBackoff(() => userGmail.users.messages.get({
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
          if (targetFolder === '02 Bilder' && targetId) targetId = await getOrCreateDateFolder(targetId, dateStr);
          if (!targetId) { skipped++; continue; }

          const exists = await checkFileExists(att.filename, targetId);
          if (exists) { skipped++; continue; }

          const res = await withBackoff(() => userGmail.users.messages.attachments.get({
            userId: 'me', messageId: msg.id, id: att.attachmentId,
          }), `att ${msg.id}`);
          const data = Buffer.from(res.data.data, 'base64url');
          await uploadToDrive(att.filename, att.mimeType, data, targetId);
          uploaded++;
          console.log(`  [UPLOAD] ${att.filename} → ${targetFolder}`);
        } catch (err) { failed++; console.error(`  [FAIL] ${att.filename}: ${err.message}`); }
      }
    } catch (err) {
      if (err.code === 429 || err.status === 429) { console.warn('  [RATE] 30s pause'); await delay(30000); }
      else console.error(`  [ERROR] msg ${msg.id}: ${err.message}`);
    }
  }

  return { messages: messages.length, found, uploaded, skipped, failed };
}

async function processMyDriveForProject(project, subfolderIds) {
  const variations = buildSearchVariations(project.name);
  const nameConditions = variations.map(v => `name contains '${v}'`).join(' or ');
  const query = `(${nameConditions}) and trashed = false and 'me' in owners and mimeType != 'application/vnd.google-apps.folder'`;

  let files = [];
  try {
    let pageToken = null;
    do {
      const res = await withBackoff(() => userDrive.files.list({
        q: query, pageSize: 100, pageToken, corpora: 'user',
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
      }), 'drive search');
      files.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.error(`  [DRIVE] Search error: ${err.message}`);
    return { files: 0, copied: 0, skipped: 0, failed: 0 };
  }

  let copied = 0, skipped = 0, failed = 0;

  for (const f of files) {
    try {
      const targetFolder = classifyAttachment(f.name, '');
      const targetId = subfolderIds[targetFolder] || subfolderIds['04 Dokumenter'];
      if (!targetId) { skipped++; continue; }

      const exists = await checkFileExists(f.name, targetId);
      if (exists) { skipped++; continue; }

      await downloadAndUpload(f.id, f.name, f.mimeType, targetId);
      copied++;
      console.log(`  [COPY] ${f.name} → ${targetFolder}`);
    } catch (err) { failed++; console.error(`  [COPY-FAIL] ${f.name}: ${err.message}`); }
  }

  return { files: files.length, copied, skipped, failed };
}

async function main() {
  const userSlug = USER_EMAIL.split('@')[0];
  console.log(`=== Full Recovery for ${USER_EMAIL} ===`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const { data: projects } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id')
    .eq('archived', false);

  console.log(`Active projects: ${projects.length}\n`);

  const allStats = [];

  for (const project of projects) {
    if (!project.drive_root_folder_id) {
      console.log(`[SKIP] ${project.name} — no Drive folder`);
      continue;
    }

    console.log(`\n--- ${project.name} ---`);
    const subfolderIds = await getSubfolders(project.drive_root_folder_id);

    const gmailStats = await processGmailForProject(project, subfolderIds);
    console.log(`  Gmail: ${gmailStats.messages} msgs, ${gmailStats.found} atts, ${gmailStats.uploaded} uploaded, ${gmailStats.skipped} skipped, ${gmailStats.failed} failed`);

    const driveStats = await processMyDriveForProject(project, subfolderIds);
    console.log(`  Drive: ${driveStats.files} files found, ${driveStats.copied} copied, ${driveStats.skipped} skipped, ${driveStats.failed} failed`);

    allStats.push({
      project: project.name,
      gmail: gmailStats,
      drive: driveStats,
    });
  }

  const totals = {
    gmail_uploaded: allStats.reduce((s, p) => s + p.gmail.uploaded, 0),
    gmail_skipped: allStats.reduce((s, p) => s + p.gmail.skipped, 0),
    gmail_failed: allStats.reduce((s, p) => s + p.gmail.failed, 0),
    drive_copied: allStats.reduce((s, p) => s + p.drive.copied, 0),
    drive_skipped: allStats.reduce((s, p) => s + p.drive.skipped, 0),
    drive_failed: allStats.reduce((s, p) => s + p.drive.failed, 0),
  };

  await supabase.from('massivlust_sync_runs').insert({
    source: `gmail_recovery_${userSlug}`,
    status: (totals.gmail_failed + totals.drive_failed) === 0 ? 'success' : 'partial',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: allStats.reduce((s, p) => s + p.gmail.found, 0),
    rows_upserted: totals.gmail_uploaded,
    rows_skipped: totals.gmail_skipped,
    rows_failed: totals.gmail_failed,
    payload: { user: USER_EMAIL, projects: allStats, totals },
  });

  await supabase.from('massivlust_sync_runs').insert({
    source: `drive_recovery_${userSlug}`,
    status: totals.drive_failed === 0 ? 'success' : 'partial',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: allStats.reduce((s, p) => s + p.drive.files, 0),
    rows_upserted: totals.drive_copied,
    rows_skipped: totals.drive_skipped,
    rows_failed: totals.drive_failed,
    payload: { user: USER_EMAIL, projects: allStats, totals },
  });

  console.log(`\n=== SUMMARY for ${USER_EMAIL} ===`);
  for (const s of allStats) {
    if (s.gmail.uploaded + s.gmail.skipped + s.drive.copied + s.drive.skipped > 0) {
      console.log(`  ${s.project}: gmail=${s.gmail.uploaded}up/${s.gmail.skipped}skip, drive=${s.drive.copied}cp/${s.drive.skipped}skip`);
    }
  }
  console.log(`\nTOTALS: gmail ${totals.gmail_uploaded} uploaded ${totals.gmail_skipped} skipped ${totals.gmail_failed} failed | drive ${totals.drive_copied} copied ${totals.drive_skipped} skipped ${totals.drive_failed} failed`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
