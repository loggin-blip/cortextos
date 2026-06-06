import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const IMPERSONATE = process.env.GOOGLE_IMPERSONATE_EMAIL || 'alex@massivlust.no';
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';

function getDriveClient() {
  const auth = new google.auth.JWT(
    SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive.readonly'],
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

const KEYWORDS = ['fremdrift', 'framdrift', 'plan', 'gantt', 'milepel', 'milepæl', 'montasje', 'sekvens', 'schedule', 'tidsplan'];
const PLAN_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.google-apps.document',
  'application/vnd.ms-project',
];

async function searchDrive(query, corpora = 'drive', driveId = SHARED_DRIVE_ID) {
  const files = [];
  let pageToken = null;
  const params = {
    q: query,
    pageSize: 100,
    fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,owners,webViewLink,parents)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };
  if (corpora === 'drive') {
    params.corpora = 'drive';
    params.driveId = driveId;
  } else if (corpora === 'user') {
    params.corpora = 'user';
  }
  do {
    params.pageToken = pageToken;
    const res = await drive.files.list(params);
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function getFilePath(fileId) {
  const parts = [];
  let currentId = fileId;
  let depth = 0;
  while (currentId && depth < 10) {
    try {
      const res = await drive.files.get({
        fileId: currentId,
        fields: 'id,name,parents',
        supportsAllDrives: true,
      });
      parts.unshift(res.data.name);
      currentId = res.data.parents?.[0];
      if (currentId === SHARED_DRIVE_ID) break;
    } catch {
      break;
    }
    depth++;
  }
  return parts.join('/');
}

async function searchSharedDrive() {
  console.log('[DRIVE] Searching Shared Drive for plan files...');
  const nameConditions = KEYWORDS.map(k => `name contains '${k}'`).join(' or ');
  const query = `(${nameConditions}) and trashed = false`;
  const files = await searchDrive(query, 'drive');
  console.log(`[DRIVE] Found ${files.length} files matching keywords on Shared Drive`);
  return files;
}

async function searchMyDrive() {
  console.log('[MYDRIVE] Searching Alex My Drive for plan files...');
  const nameConditions = KEYWORDS.map(k => `name contains '${k}'`).join(' or ');
  const query = `(${nameConditions}) and trashed = false and 'me' in owners`;
  try {
    const files = await searchDrive(query, 'user');
    console.log(`[MYDRIVE] Found ${files.length} files in Alex My Drive`);
    return files;
  } catch (err) {
    console.error(`[MYDRIVE] Error: ${err.message}`);
    return [];
  }
}

function extractAttachmentNames(payload, results = []) {
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.filename) results.push({ filename: part.filename, mimeType: part.mimeType });
      extractAttachmentNames(part, results);
    }
  }
  return results;
}

async function searchGmail() {
  console.log('[GMAIL] Searching for plan-related attachments...');
  const fileKeywords = KEYWORDS.map(k => `filename:${k}`).join(' OR ');
  const query = `(${fileKeywords}) has:attachment newer_than:24m`;
  console.log(`[GMAIL] Query: ${query}`);

  const messages = [];
  let pageToken = null;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100, pageToken });
    messages.push(...(res.data.messages || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`[GMAIL] Found ${messages.length} messages with plan-related attachments`);

  const results = [];
  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
      const headers = full.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';

      const fullMsg = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const attachments = extractAttachmentNames(fullMsg.data.payload || {});
      const planAttachments = attachments.filter(a => {
        const fn = a.filename.toLowerCase();
        return KEYWORDS.some(k => fn.includes(k));
      });

      for (const att of planAttachments) {
        results.push({ source: 'gmail', filename: att.filename, mimeType: att.mimeType, subject, from, date });
      }
    } catch (err) {
      console.error(`[GMAIL] Error on msg ${msg.id}: ${err.message}`);
    }
  }
  return results;
}

async function main() {
  console.log('=== Plan/Schedule File Search ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const [sharedFiles, myFiles, gmailResults] = await Promise.all([
    searchSharedDrive(),
    searchMyDrive(),
    searchGmail(),
  ]);

  console.log('\n=== SHARED DRIVE RESULTS ===');
  for (const f of sharedFiles) {
    const path = await getFilePath(f.id);
    console.log(JSON.stringify({
      source: 'shared_drive',
      name: f.name,
      path,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      owner: f.owners?.[0]?.emailAddress || 'shared',
      webViewLink: f.webViewLink,
    }));
  }

  console.log('\n=== MY DRIVE RESULTS ===');
  for (const f of myFiles) {
    console.log(JSON.stringify({
      source: 'my_drive',
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      owner: f.owners?.[0]?.emailAddress || 'unknown',
      webViewLink: f.webViewLink,
    }));
  }

  console.log('\n=== GMAIL ATTACHMENT RESULTS ===');
  for (const r of gmailResults) {
    console.log(JSON.stringify(r));
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Shared Drive: ${sharedFiles.length} files`);
  console.log(`My Drive: ${myFiles.length} files`);
  console.log(`Gmail: ${gmailResults.length} attachments`);
  console.log(`Total: ${sharedFiles.length + myFiles.length + gmailResults.length}`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
