import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { Readable } from 'stream';
import { supabase } from '../supabase.js';
import { matchProject } from '../lib/project-matcher.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const SA_KEY = JSON.parse(readFileSync(config.google.saKeyPath, 'utf8'));
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';
const ALEX_EMAIL = 'alex@massivlust.no';

const UKLASSIFISERT_USER = {
  alex:    '1_QIpTXeIjNAnRIgrU7CiJ_Dl1wTa2lKb',
  mathias: '1kdsGcJwczh6n2KSHZWBn0FVElF0EdO6P',
  sondre:  '1wTSnETjnbe6OtxXKrdWCX9UxD6VnXXbP',
  eivind:  '1QFFhz9wy2WkLv8N5pcqgjMOi0KHy1G2w',
  vegard:  '1pxHKMoBhmFyvMP-usDqJlvNQfReOMH67',
  martin:  '1Bn6puMGhTYkVoeByUm5cFnRKKZUDUu9X',
};

const HARD_SKIP_PATTERNS = [
  /^WP_\d{8}_\d+/i,
  /^FB_IMG_/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i,
  /newsletter|nyhetsbrev/i,
  /^hms[_-]?(mal|template)/i,
  /^screenshot_\d{8}/i,
  /^IMG-\d{8}-WA\d+/i,
  /^image\d*\.(png|jpg|jpeg)$/i,
  /^\d{8}_\d{6}\.(jpg|jpeg|png|heic|gif|bmp|webp)$/i,
];

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function withBackoff(fn, label = '') {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      if ((err.code === 429 || err.status === 429) && attempt < 8) {
        const wait = Math.min(2000 * Math.pow(2, attempt), 60000);
        attempt++;
        logger.warn({ label, attempt, waitSec: wait / 1000 }, 'Rate limited, backing off');
        await delay(wait);
      } else { throw err; }
    }
  }
}

function makeDrive(email, scopes = ['https://www.googleapis.com/auth/drive']) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key, scopes, email);
  return google.drive({ version: 'v3', auth });
}

function makeGmail(email) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/gmail.modify'], email);
  return google.gmail({ version: 'v1', auth });
}

function classifyToSubfolder(fileName, subject) {
  const fn = (fileName || '').toLowerCase();
  const subj = (subject || '').toLowerCase();
  if (fn.endsWith('.ifc')) return '04 Dokumenter';
  if (/\.(jpg|jpeg|png|heic|heif|gif|bmp|webp)$/.test(fn)) return '02 Bilder';
  if (/\.pdf$/.test(fn) && /(ks|kontroll|sjekkliste)/.test(fn + ' ' + subj)) return '05 Sjekklister';
  if (/\.pdf$/.test(fn) && /avvik/.test(fn + ' ' + subj)) return '01 Avvik';
  if (/\.pdf$/.test(fn) && /(hms|sha|ruh)/.test(fn + ' ' + subj)) return '06 HMS';
  return '04 Dokumenter';
}

function shouldHardSkip(fileName) {
  return HARD_SKIP_PATTERNS.some(re => re.test(fileName));
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

function getHeaderValue(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return '';
}

async function loadProjects() {
  const { data, error } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id, address, archived')
    .not('drive_root_folder_id', 'is', null)
    .eq('org_id', 'massivlust');

  if (error) throw new Error(`Failed to load projects: ${error.message}`);
  return data || [];
}

async function getSyncStates() {
  const { data, error } = await supabase
    .from('massivlust_employee_sync_state')
    .select('*')
    .eq('org_id', 'massivlust');

  if (error) throw new Error(`Failed to load sync states: ${error.message}`);
  return data || [];
}

async function updateSyncState(id, updates) {
  const { error } = await supabase
    .from('massivlust_employee_sync_state')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) logger.error({ error, id }, 'Failed to update sync state');
}

async function classifyFile({ fileName, subject, body, fromEmail, projects }) {
  const matchText = `${fileName} ${subject} ${body}`.slice(0, 2000);
  const result = await matchProject(matchText);

  if (result.project_id && result.confidence >= 0.3) {
    const project = projects.find(p => p.id === result.project_id);
    return { project, confidence: result.confidence, method: 'name_match', auto_classified: true };
  }

  if (fromEmail) {
    const senderResult = await classifyBySender(fromEmail, projects);
    if (senderResult) return senderResult;
  }

  return { project: null, confidence: result.confidence, method: 'unclassified', auto_classified: false };
}

let _senderCache = null;

async function buildSenderCache() {
  if (_senderCache) return;
  _senderCache = new Map();
  const { data } = await supabase
    .from('massivlust_korrespondanse')
    .select('fra_epost, project_id')
    .not('project_id', 'is', null);

  const freq = {};
  for (const row of (data || [])) {
    const sender = (row.fra_epost || '').toLowerCase().trim();
    if (!sender) continue;
    if (!freq[sender]) freq[sender] = {};
    freq[sender][row.project_id] = (freq[sender][row.project_id] || 0) + 1;
  }

  for (const [sender, projects] of Object.entries(freq)) {
    const total = Object.values(projects).reduce((a, b) => a + b, 0);
    const sorted = Object.entries(projects).sort((a, b) => b[1] - a[1]);
    const [topId, topCount] = sorted[0];
    const pct = (topCount / total) * 100;
    if (pct >= 60) _senderCache.set(sender, { projectId: topId, pct });
  }
}

async function classifyBySender(fromEmail, projects) {
  await buildSenderCache();
  const email = (fromEmail.match(/<([^>]+)>/) || [])[1] || fromEmail.toLowerCase().trim();
  const entry = _senderCache.get(email);
  if (!entry) return null;
  const project = projects.find(p => p.id === entry.projectId);
  if (!project) return null;
  return { project, confidence: 0.65, method: 'sender_frequency', auto_classified: true };
}

const _subfolderCache = {};

async function getSubfolders(drive, rootId) {
  if (_subfolderCache[rootId]) return _subfolderCache[rootId];
  const res = await withBackoff(() => drive.files.list({
    q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id,name)',
  }), `subfolders ${rootId}`);
  const map = {};
  for (const f of (res.data.files || [])) map[f.name] = f.id;
  _subfolderCache[rootId] = map;
  return map;
}

const _dateFolderCache = {};

async function getOrCreateDateFolder(drive, parentId, dateStr) {
  const key = `${parentId}:${dateStr}`;
  if (_dateFolderCache[key]) return _dateFolderCache[key];
  const res = await withBackoff(() => drive.files.list({
    q: `'${parentId}' in parents and name = '${dateStr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id)',
  }), `dateFolder ${dateStr}`);
  if (res.data.files?.length > 0) { _dateFolderCache[key] = res.data.files[0].id; return res.data.files[0].id; }
  const folder = await withBackoff(() => drive.files.create({
    requestBody: { name: dateStr, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    supportsAllDrives: true, fields: 'id',
  }), `mkdir ${dateStr}`);
  _dateFolderCache[key] = folder.data.id;
  return folder.data.id;
}

async function checkFileExists(drive, name, parentId) {
  const res = await withBackoff(() => drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id)',
  }), `check ${name}`);
  return res.data.files?.length > 0;
}

async function uploadToDrive(drive, fileName, mimeType, buffer, parentId) {
  const res = await withBackoff(() => drive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType, body: Readable.from(buffer) },
    supportsAllDrives: true, fields: 'id,name',
  }), `upload ${fileName}`);
  return res.data;
}

async function processAndUpload({ sharedDrive, fileName, mimeType, buffer, classification, subject, emailDate, gmailMeta, source, userSlug }) {
  const { project } = classification;

  if (!project) {
    const userFolderId = UKLASSIFISERT_USER[userSlug];
    if (!userFolderId) return 'no_folder';

    const exists = await checkFileExists(sharedDrive, fileName, userFolderId);
    if (exists) return 'skipped_existing';

    await uploadToDrive(sharedDrive, fileName, mimeType, buffer, userFolderId);

    await supabase.from('massivlust_unclassified_files').insert({
      source_type: source,
      source_user: `${userSlug}@massivlust.no`,
      file_name: fileName,
      mime_type: mimeType,
      gmail_message_id: gmailMeta?.messageId || null,
      gmail_subject: gmailMeta?.subject || null,
      gmail_from: gmailMeta?.from || null,
      gmail_date: gmailMeta?.date || null,
      classifier_method: classification.method,
      classifier_confidence: classification.confidence,
      classifier_suggestion: classification.suggestion || null,
      status: 'needs_review',
    }).then(() => {}).catch(err => logger.warn({ err, fileName }, 'Failed to log unclassified'));

    return 'uploaded_unclassified';
  }

  if (!project.drive_root_folder_id) return 'no_drive_folder';

  const subfolderIds = await getSubfolders(sharedDrive, project.drive_root_folder_id);
  const targetSubfolder = classifyToSubfolder(fileName, subject);
  let targetId = subfolderIds[targetSubfolder] || subfolderIds['04 Dokumenter'];
  if (!targetId) return 'no_subfolder';

  if (targetSubfolder === '02 Bilder' && emailDate) {
    const dateStr = emailDate.toISOString().slice(0, 10);
    targetId = await getOrCreateDateFolder(sharedDrive, targetId, dateStr);
  }

  const exists = await checkFileExists(sharedDrive, fileName, targetId);
  if (exists) return 'skipped_existing';

  await uploadToDrive(sharedDrive, fileName, mimeType, buffer, targetId);
  return 'uploaded';
}

async function syncGmailForEmployee(email, syncState, projects, sharedDrive) {
  const userSlug = email.split('@')[0];
  const gmail = makeGmail(email);
  const stats = { processed: 0, classified: 0, unclassified: 0, skipped: 0, failed: 0 };

  let messages = [];
  const cursor = syncState.last_cursor;

  if (cursor?.historyId) {
    try {
      let pageToken = null;
      do {
        const res = await withBackoff(() => gmail.users.history.list({
          userId: 'me',
          startHistoryId: String(cursor.historyId),
          historyTypes: ['messageAdded'],
          pageToken,
        }), `history ${email}`);
        const histories = res.data.history || [];
        for (const h of histories) {
          for (const added of (h.messagesAdded || [])) {
            messages.push(added.message);
          }
        }
        pageToken = res.data.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (err.code === 404 || err.response?.status === 404) {
        logger.warn({ email }, 'History expired, falling back to date query');
        const since = new Date(syncState.last_synced_at);
        const afterEpoch = Math.floor(since.getTime() / 1000);
        const refs = await withBackoff(() => gmail.users.messages.list({
          userId: 'me', q: `has:attachment after:${afterEpoch}`, maxResults: 500,
        }), `gmail search ${email}`);
        messages = refs.data.messages || [];
      } else {
        throw err;
      }
    }
  } else {
    const since = new Date(syncState.last_synced_at);
    const afterEpoch = Math.floor(since.getTime() / 1000);
    let pageToken = null;
    do {
      const res = await withBackoff(() => gmail.users.messages.list({
        userId: 'me', q: `has:attachment after:${afterEpoch}`, maxResults: 500, pageToken,
      }), `gmail list ${email}`);
      messages.push(...(res.data.messages || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  if (messages.length === 0) {
    logger.info({ email, source: 'gmail' }, 'No new messages');
    return stats;
  }

  logger.info({ email, count: messages.length }, 'Gmail messages to process');

  for (const msg of messages) {
    try {
      const full = await withBackoff(() => gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'full',
      }), `msg ${msg.id}`);

      const headers = full.data.payload?.headers || [];
      const subject = getHeaderValue(headers, 'Subject');
      const from = getHeaderValue(headers, 'From');
      const date = getHeaderValue(headers, 'Date');
      const emailDate = date ? new Date(date) : new Date();
      const body = extractPlainText(full.data.payload || {});

      const attachments = extractAttachments(full.data.payload || {});
      if (attachments.length === 0) continue;

      for (const att of attachments) {
        if (shouldHardSkip(att.filename)) { stats.skipped++; continue; }

        try {
          const attRes = await withBackoff(() => gmail.users.messages.attachments.get({
            userId: 'me', messageId: msg.id, id: att.attachmentId,
          }), `att ${att.filename}`);
          const buffer = Buffer.from(attRes.data.data, 'base64url');

          const classification = await classifyFile({
            fileName: att.filename, subject, body, fromEmail: from, projects,
          });

          const result = await processAndUpload({
            sharedDrive, fileName: att.filename, mimeType: att.mimeType, buffer,
            classification, subject, emailDate,
            gmailMeta: { messageId: msg.id, subject, from, date: emailDate.toISOString() },
            source: 'gmail', userSlug,
          });

          stats.processed++;
          if (result === 'uploaded') stats.classified++;
          else if (result === 'uploaded_unclassified') stats.unclassified++;
          else if (result === 'skipped_existing') stats.skipped++;
        } catch (err) {
          stats.failed++;
          logger.error({ err: err.message, file: att.filename, email }, 'Attachment processing failed');
        }
      }

      if (stats.processed % 50 === 0 && stats.processed > 0) await delay(1000);
    } catch (err) {
      if (err.code === 429 || err.status === 429) {
        logger.warn({ email }, 'Gmail rate limit — 30s pause');
        await delay(30000);
      } else {
        stats.failed++;
        logger.error({ err: err.message, msgId: msg.id, email }, 'Gmail message failed');
      }
    }
  }

  const profile = await withBackoff(() => gmail.users.getProfile({ userId: 'me' }), `profile ${email}`);
  await updateSyncState(syncState.id, {
    last_synced_at: new Date().toISOString(),
    last_cursor: { historyId: profile.data.historyId },
    last_run_status: stats.failed === 0 ? 'success' : 'partial',
    last_run_files_processed: stats.processed,
    last_run_files_classified: stats.classified,
    last_run_error: null,
  });

  return stats;
}

async function syncDriveForEmployee(email, syncState, projects, sharedDrive) {
  const userSlug = email.split('@')[0];
  const userDrive = makeDrive(email, ['https://www.googleapis.com/auth/drive.readonly']);
  const stats = { processed: 0, classified: 0, unclassified: 0, skipped: 0, failed: 0 };

  let files = [];
  const cursor = syncState.last_cursor;

  if (cursor?.pageToken) {
    let pageToken = cursor.pageToken;
    let newStartPageToken = null;
    do {
      const res = await withBackoff(() => userDrive.changes.list({
        pageToken,
        pageSize: 100,
        fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,parents,size))',
        includeRemoved: false,
      }), `changes ${email}`);
      for (const change of (res.data.changes || [])) {
        if (change.file && change.file.mimeType !== 'application/vnd.google-apps.folder') {
          files.push(change.file);
        }
      }
      pageToken = res.data.nextPageToken;
      newStartPageToken = res.data.newStartPageToken;
    } while (pageToken);

    if (files.length === 0) {
      await updateSyncState(syncState.id, {
        last_synced_at: new Date().toISOString(),
        last_cursor: { pageToken: newStartPageToken || cursor.pageToken },
        last_run_status: 'success',
        last_run_files_processed: 0,
        last_run_files_classified: 0,
        last_run_error: null,
      });
      logger.info({ email, source: 'drive' }, 'No new changes');
      return stats;
    }
  } else {
    const since = new Date(syncState.last_synced_at).toISOString();
    let pageToken = null;
    do {
      const res = await withBackoff(() => userDrive.files.list({
        q: `modifiedTime > '${since}' and 'me' in owners and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
        pageSize: 100, pageToken, corpora: 'user',
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,size)',
      }), `drive list ${email}`);
      files.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  logger.info({ email, count: files.length }, 'Drive files to process');

  for (const file of files) {
    if (shouldHardSkip(file.name)) { stats.skipped++; continue; }

    try {
      let inShared = false;
      try {
        const meta = await withBackoff(() => userDrive.files.get({
          fileId: file.id, fields: 'driveId', supportsAllDrives: true,
        }), `driveCheck ${file.id}`);
        inShared = meta.data.driveId === SHARED_DRIVE_ID;
      } catch { /* not accessible = not in shared */ }

      if (inShared) { stats.skipped++; continue; }

      let buffer;
      try {
        const dlRes = await withBackoff(() => userDrive.files.get(
          { fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' },
        ), `download ${file.name}`);
        buffer = Buffer.from(dlRes.data);
      } catch (err) {
        if (err.message?.includes('Use Export')) { stats.skipped++; continue; }
        throw err;
      }

      const classification = await classifyFile({
        fileName: file.name, subject: '', body: '', fromEmail: '', projects,
      });

      const result = await processAndUpload({
        sharedDrive, fileName: file.name, mimeType: file.mimeType, buffer,
        classification, subject: '', emailDate: file.modifiedTime ? new Date(file.modifiedTime) : null,
        gmailMeta: null, source: 'drive', userSlug,
      });

      stats.processed++;
      if (result === 'uploaded') stats.classified++;
      else if (result === 'uploaded_unclassified') stats.unclassified++;
      else if (result === 'skipped_existing') stats.skipped++;
    } catch (err) {
      if (err.code === 429 || err.status === 429) {
        logger.warn({ email }, 'Drive rate limit — 30s pause');
        await delay(30000);
      } else {
        stats.failed++;
        logger.error({ err: err.message, file: file.name, email }, 'Drive file failed');
      }
    }
  }

  const startTokenRes = await withBackoff(() => userDrive.changes.getStartPageToken(), `startToken ${email}`);
  await updateSyncState(syncState.id, {
    last_synced_at: new Date().toISOString(),
    last_cursor: { pageToken: startTokenRes.data.startPageToken },
    last_run_status: stats.failed === 0 ? 'success' : 'partial',
    last_run_files_processed: stats.processed,
    last_run_files_classified: stats.classified,
    last_run_error: null,
  });

  return stats;
}

let _running = false;

export async function run({ dryRun = false } = {}) {
  if (_running) {
    logger.warn('Continuous classify already running, skipping');
    return { skipped: true };
  }
  _running = true;

  const runId = await syncRuns.start({ source: 'continuous_classify' });

  try {
    const projects = await loadProjects();
    const syncStates = await getSyncStates();
    const sharedDrive = makeDrive(ALEX_EMAIL);

    logger.info({ projectCount: projects.length, employeeCount: new Set(syncStates.map(s => s.employee_email)).size }, 'Starting continuous classify');

    await buildSenderCache();

    const totals = { processed: 0, classified: 0, unclassified: 0, skipped: 0, failed: 0 };

    for (const state of syncStates) {
      try {
        logger.info({ email: state.employee_email, source: state.source, lastSynced: state.last_synced_at }, 'Syncing employee');

        let stats;
        if (state.source === 'gmail') {
          stats = await syncGmailForEmployee(state.employee_email, state, projects, sharedDrive);
        } else {
          stats = await syncDriveForEmployee(state.employee_email, state, projects, sharedDrive);
        }

        totals.processed += stats.processed;
        totals.classified += stats.classified;
        totals.unclassified += stats.unclassified;
        totals.skipped += stats.skipped;
        totals.failed += stats.failed;

        logger.info({ email: state.employee_email, source: state.source, ...stats }, 'Employee sync complete');
      } catch (err) {
        totals.failed++;
        logger.error({ err: err.message, email: state.employee_email, source: state.source }, 'Employee sync failed');
        await updateSyncState(state.id, {
          last_run_status: 'error',
          last_run_error: err.message,
        });
      }
    }

    await syncRuns.complete(runId, {
      status: totals.failed === 0 ? 'success' : 'partial',
      rows_in: totals.processed + totals.skipped,
      rows_upserted: totals.classified,
      rows_skipped: totals.skipped + totals.unclassified,
      rows_failed: totals.failed,
      payload: totals,
    });

    logger.info(totals, 'Continuous classify complete');
    return totals;
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  } finally {
    _running = false;
  }
}
