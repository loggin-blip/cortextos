import { google } from 'googleapis';
import { readFileSync, createWriteStream } from 'fs';
import { config } from '../config.js';

let _drive = null;
const _driveClients = {};

function getClient() {
  if (_drive) return _drive;

  const keyFile = JSON.parse(readFileSync(config.google.saKeyPath, 'utf8'));
  const auth = new google.auth.JWT(
    keyFile.client_email,
    null,
    keyFile.private_key,
    ['https://www.googleapis.com/auth/drive.readonly'],
    config.google.impersonateEmail,
  );
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

export function getDriveClient(impersonateEmail, scopes = ['https://www.googleapis.com/auth/drive']) {
  const key = `${impersonateEmail}:${scopes.join(',')}`;
  if (_driveClients[key]) return _driveClients[key];

  const keyFile = JSON.parse(readFileSync(config.google.saKeyPath, 'utf8'));
  const auth = new google.auth.JWT(
    keyFile.client_email,
    null,
    keyFile.private_key,
    scopes,
    impersonateEmail,
  );
  _driveClients[key] = google.drive({ version: 'v3', auth });
  return _driveClients[key];
}

export async function moveFile(drive, fileId, fromParentId, toParentId) {
  const res = await drive.files.update({
    fileId,
    addParents: toParentId,
    removeParents: fromParentId,
    supportsAllDrives: true,
    fields: 'id,name,parents',
  });
  return res.data;
}

export async function listChanges(pageToken) {
  const drive = getClient();
  const res = await drive.changes.list({
    pageToken,
    pageSize: 100,
    fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,parents))',
    includeRemoved: false,
  });
  return res.data;
}

export async function getStartPageToken() {
  const drive = getClient();
  const res = await drive.changes.getStartPageToken();
  return res.data.startPageToken;
}

export async function searchFiles(query) {
  const drive = getClient();
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: query,
      pageSize: 100,
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,size)',
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

export async function downloadFile(fileId, destPath) {
  const drive = getClient();
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' },
  );

  return new Promise((resolve, reject) => {
    const ws = createWriteStream(destPath);
    res.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

export async function getFile(fileId) {
  const drive = getClient();
  const res = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,modifiedTime,parents,size',
  });
  return res.data;
}

export async function listFolder(folderId) {
  return searchFiles(`'${folderId}' in parents and trashed=false`);
}

export async function listFolderFull(folderId) {
  const drive = getClient();
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      pageSize: 100,
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,webViewLink)',
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}
