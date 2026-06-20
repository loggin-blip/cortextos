import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const USER_EMAIL = process.argv[2];
if (!USER_EMAIL) {
  console.error('Usage: node smart-recovery.js user@massivlust.no');
  process.exit(1);
}
const userSlug = USER_EMAIL.split('@')[0];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';
const ALEX_EMAIL = 'alex@massivlust.no';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const UKLASSIFISERT_ROOT = '14jmBrqICN7bgQWWwudo83QbHjgNWJCzl';
const UKLASSIFISERT_USER = {
  alex:    '1_QIpTXeIjNAnRIgrU7CiJ_Dl1wTa2lKb',
  mathias: '1kdsGcJwczh6n2KSHZWBn0FVElF0EdO6P',
  sondre:  '1wTSnETjnbe6OtxXKrdWCX9UxD6VnXXbP',
  eivind:  '1QFFhz9wy2WkLv8N5pcqgjMOi0KHy1G2w',
  vegard:  '1pxHKMoBhmFyvMP-usDqJlvNQfReOMH67',
  martin:  '1Bn6puMGhTYkVoeByUm5cFnRKKZUDUu9X',
};

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function makeDrive(email, scopes = ['https://www.googleapis.com/auth/drive']) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key, scopes, email);
  return google.drive({ version: 'v3', auth });
}

function makeGmail(email) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/gmail.modify'], email);
  return google.gmail({ version: 'v1', auth });
}

const userDrive = makeDrive(USER_EMAIL, ['https://www.googleapis.com/auth/drive.readonly']);
const userGmail = makeGmail(USER_EMAIL);
const sharedDrive = makeDrive(ALEX_EMAIL);

// ---------------------------------------------------------------------------
// Backoff + utils
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// File / folder classification (filename + subject -> subfolder)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Project name variations for matching
// ---------------------------------------------------------------------------
function buildSearchVariations(name) {
  const variations = [name.toLowerCase()];
  const words = name.split(/\s+/);
  if (words.length > 1) {
    variations.push(words[0].toLowerCase());
    if (words.length > 2) variations.push(words.slice(0, 2).join(' ').toLowerCase());
  }
  const noSuffix = name.replace(/\s+(skole|barnehage|vgs|sykehjem|svømmehall|sentrumsbygg)\s*$/i, '').trim();
  if (noSuffix.toLowerCase() !== name.toLowerCase()) variations.push(noSuffix.toLowerCase());
  return [...new Set(variations)];
}

// ---------------------------------------------------------------------------
// Gmail / attachment helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------
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
  }), `subfolders ${rootId}`);
  const map = {};
  for (const f of (items.data.files || [])) map[f.name] = f.id;
  return map;
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

async function isFileInSharedDrive(fileId) {
  try {
    const res = await withBackoff(() => userDrive.files.get({
      fileId,
      fields: 'id,driveId',
      supportsAllDrives: true,
    }), `driveCheck ${fileId}`);
    return res.data.driveId === SHARED_DRIVE_ID;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLASSIFICATION PIPELINE
// ---------------------------------------------------------------------------
// Each method returns { project, confidence, method } or null

// Cache: project variations map built once
let projectVariationsMap = null;
let projectAddressMap = null;

function buildProjectMaps(projects) {
  projectVariationsMap = new Map();
  projectAddressMap = new Map();
  for (const p of projects) {
    const variations = buildSearchVariations(p.name);
    projectVariationsMap.set(p.id, { variations, project: p });
    // If the project has an address field, add it
    if (p.address) {
      projectAddressMap.set(p.id, { address: p.address.toLowerCase(), project: p });
    }
  }
}

// --- Method 1: Direct name match ---
function classifyByNameMatch(fileName, subject, body) {
  const haystack = `${fileName} ${subject} ${body}`.toLowerCase();
  let bestMatch = null;
  let bestLen = 0;
  let matchType = 'full'; // full or partial

  for (const [, { variations, project }] of projectVariationsMap) {
    for (let i = 0; i < variations.length; i++) {
      const v = variations[i];
      if (v.length > bestLen && haystack.includes(v)) {
        bestMatch = project;
        bestLen = v.length;
        matchType = i === 0 ? 'full' : 'partial';
      }
    }
  }

  if (bestMatch) {
    return {
      project: bestMatch,
      confidence: matchType === 'full' ? 90 : 70,
      method: 'name_match',
      detail: `${matchType} match (len=${bestLen})`,
    };
  }
  return null;
}

// --- Method 2: Thread context (Gmail only) ---
async function classifyByThreadContext(threadId) {
  if (!threadId) return null;
  try {
    const thread = await withBackoff(() => userGmail.users.threads.get({
      userId: 'me', id: threadId, format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'To'],
    }), `thread ${threadId}`);

    const messages = thread.data.messages || [];
    for (const msg of messages) {
      const headers = msg.payload?.headers || [];
      const subject = getHeaderValue(headers, 'Subject');
      const result = classifyByNameMatch('', subject, '');
      if (result && result.confidence >= 70) {
        return {
          project: result.project,
          confidence: 75,
          method: 'thread_context',
          detail: `project found in thread message subject: "${subject.substring(0, 60)}"`,
        };
      }
    }
  } catch (err) {
    // Non-fatal: thread fetch might fail for various reasons
    console.warn(`  [WARN] Thread ${threadId} fetch failed: ${err.message}`);
  }
  return null;
}

// --- Method 3: Sender frequency mapping (from Supabase) ---
let senderProjectCache = null;

async function buildSenderProjectCache() {
  if (senderProjectCache) return;
  senderProjectCache = new Map();
  try {
    // Get sender->project distribution from classified emails
    const { data, error } = await supabase
      .from('massivlust_korrespondanse')
      .select('fra_epost, project_id')
      .not('project_id', 'is', null);

    if (error) {
      console.warn(`[WARN] Sender cache query failed: ${error.message}`);
      return;
    }

    // Build frequency table: sender -> { projectId: count }
    const freqTable = {};
    for (const row of (data || [])) {
      const sender = (row.fra_epost || '').toLowerCase().trim();
      if (!sender) continue;
      if (!freqTable[sender]) freqTable[sender] = {};
      freqTable[sender][row.project_id] = (freqTable[sender][row.project_id] || 0) + 1;
    }

    // For each sender, compute dominant project and percentage
    for (const [sender, projects] of Object.entries(freqTable)) {
      const total = Object.values(projects).reduce((a, b) => a + b, 0);
      const sorted = Object.entries(projects).sort((a, b) => b[1] - a[1]);
      const [topProjectId, topCount] = sorted[0];
      const pct = (topCount / total) * 100;
      if (pct >= 60) {
        senderProjectCache.set(sender, { projectId: topProjectId, pct, total });
      }
    }
    console.log(`[INIT] Sender frequency cache: ${senderProjectCache.size} senders with dominant projects`);
  } catch (err) {
    console.warn(`[WARN] Sender cache build failed: ${err.message}`);
  }
}

function classifyBySenderFrequency(fromEmail, projects) {
  if (!senderProjectCache || !fromEmail) return null;
  const sender = fromEmail.toLowerCase().trim();
  // Extract just the email address if "Name <email>" format
  const emailMatch = sender.match(/<([^>]+)>/);
  const cleanEmail = emailMatch ? emailMatch[1] : sender;

  const entry = senderProjectCache.get(cleanEmail);
  if (!entry) return null;

  const project = projects.find(p => p.id === entry.projectId);
  if (!project) return null;

  return {
    project,
    confidence: 65,
    method: 'sender_frequency',
    detail: `sender ${cleanEmail} → ${project.name} (${entry.pct.toFixed(0)}% of ${entry.total} emails)`,
  };
}

// --- Method 4: NOT IMPLEMENTED ---
// Logged once at startup, not per-file
function classifyByMethod4() { return null; }

// --- Method 5: NOT IMPLEMENTED ---
function classifyByMethod5() { return null; }

// --- Method 6: File content search (PDF text extraction) ---
async function classifyByFileContent(buffer, mimeType, fileName) {
  // Only attempt for PDF files. We do a simple text extraction from the raw PDF buffer.
  // PDFs with embedded text have readable strings. We search for project names/addresses.
  if (!mimeType || !mimeType.includes('pdf')) return null;

  try {
    // Extract ASCII/UTF-8 text from PDF buffer (naive but effective for text-based PDFs)
    const rawText = extractTextFromPdfBuffer(buffer);
    if (!rawText || rawText.length < 20) return null;

    const textLower = rawText.toLowerCase();

    // Check for project names (full name first, then partial)
    for (const [, { variations, project }] of projectVariationsMap) {
      // Full name match in content = high confidence
      if (textLower.includes(variations[0])) {
        return {
          project,
          confidence: 80,
          method: 'file_content',
          detail: `project name "${project.name}" found in PDF text`,
        };
      }
    }

    // Check for project addresses in content
    for (const [, { address, project }] of projectAddressMap) {
      if (address && textLower.includes(address)) {
        return {
          project,
          confidence: 80,
          method: 'file_content',
          detail: `project address "${address}" found in PDF text`,
        };
      }
    }
  } catch (err) {
    // Non-fatal
    console.warn(`  [WARN] PDF text extraction failed for ${fileName}: ${err.message}`);
  }

  return null;
}

/**
 * Naive PDF text extraction: find text between BT/ET operators and
 * decode parenthesized strings. Works for most text-based PDFs.
 * For scanned PDFs this returns nothing — which is expected.
 */
function extractTextFromPdfBuffer(buffer) {
  const raw = buffer.toString('latin1');
  const chunks = [];

  // Strategy 1: Extract parenthesized text strings Tj/TJ operators
  const parenRegex = /\(([^)]{2,})\)/g;
  let m;
  while ((m = parenRegex.exec(raw)) !== null) {
    const decoded = m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .replace(/\\([()])/g, '$1');
    // Filter out binary garbage: if >30% non-printable, skip
    const printable = decoded.replace(/[^\x20-\x7E\xC0-\xFFÀ-ɏ]/g, '');
    if (printable.length > decoded.length * 0.7 && printable.length >= 3) {
      chunks.push(printable);
    }
  }

  // Strategy 2: Extract hex-encoded strings <hex>
  const hexRegex = /<([0-9a-fA-F]{4,})>/g;
  while ((m = hexRegex.exec(raw)) !== null) {
    try {
      const hex = m[1];
      let text = '';
      for (let i = 0; i < hex.length; i += 2) {
        const charCode = parseInt(hex.substring(i, i + 2), 16);
        if (charCode >= 32 && charCode <= 126) text += String.fromCharCode(charCode);
      }
      if (text.length >= 3) chunks.push(text);
    } catch { /* skip malformed hex */ }
  }

  return chunks.join(' ');
}

// --- Method 7: NOT IMPLEMENTED ---
function classifyByMethod7() { return null; }

// --- Method 8: NOT IMPLEMENTED ---
function classifyByMethod8() { return null; }

// ---------------------------------------------------------------------------
// Master classifier: runs methods in priority order, returns first confident hit
// ---------------------------------------------------------------------------
async function classifyFile({
  fileName,
  subject = '',
  body = '',
  fromEmail = '',
  threadId = null,
  buffer = null,
  mimeType = '',
  projects,
  source, // 'gmail' or 'drive'
}) {
  const results = [];

  // Method 1: Direct name match (filename, subject, body)
  const m1 = classifyByNameMatch(fileName, subject, body);
  if (m1) results.push(m1);
  if (m1 && m1.confidence >= 60) return m1;

  // Method 2: Thread context (Gmail only)
  if (source === 'gmail' && threadId) {
    const m2 = await classifyByThreadContext(threadId);
    if (m2) results.push(m2);
    if (m2 && m2.confidence >= 60) return m2;
  }

  // Method 3: Sender frequency
  if (fromEmail) {
    const m3 = classifyBySenderFrequency(fromEmail, projects);
    if (m3) results.push(m3);
    if (m3 && m3.confidence >= 60) return m3;
  }

  // Method 4: NOT IMPLEMENTED
  classifyByMethod4();

  // Method 5: NOT IMPLEMENTED
  classifyByMethod5();

  // Method 6: File content search
  if (buffer && mimeType) {
    const m6 = await classifyByFileContent(buffer, mimeType, fileName);
    if (m6) results.push(m6);
    if (m6 && m6.confidence >= 60) return m6;
  }

  // Method 7: NOT IMPLEMENTED
  classifyByMethod7();

  // Method 8: NOT IMPLEMENTED
  classifyByMethod8();

  // Method 9: Fallback — Uklassifisert
  const bestResult = results.length > 0
    ? results.reduce((best, r) => r.confidence > best.confidence ? r : best, results[0])
    : null;

  return {
    project: null,
    confidence: bestResult?.confidence || 0,
    method: 'unclassified',
    detail: bestResult
      ? `best attempt: ${bestResult.method} (confidence=${bestResult.confidence}, project="${bestResult.project?.name}")`
      : 'no method produced any match',
    suggestion: bestResult?.project?.name || null,
    suggestedMethod: bestResult?.method || null,
  };
}

// ---------------------------------------------------------------------------
// Stats tracking
// ---------------------------------------------------------------------------
const stats = {
  totalFiles: 0,
  byMethod: {},
  byProject: {},
  unclassified: 0,
  skippedExisting: 0,
  uploadedCount: 0,
  failedCount: 0,
};

function recordStat(method, projectName) {
  stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
  if (projectName) {
    stats.byProject[projectName] = (stats.byProject[projectName] || 0) + 1;
  } else {
    stats.unclassified++;
  }
}

// ---------------------------------------------------------------------------
// Process a single classified file: upload to correct destination
// ---------------------------------------------------------------------------
async function uploadClassifiedFile({
  fileName,
  mimeType,
  buffer,
  classification,
  subfolderCache,
  subject = '',
  emailDate = null,
  gmailMeta = null, // { messageId, subject, from, date }
  source,
}) {
  stats.totalFiles++;
  const { project, method } = classification;

  if (!project) {
    // Upload to Uklassifisert
    const userFolderId = UKLASSIFISERT_USER[userSlug] || UKLASSIFISERT_ROOT;

    const exists = await checkFileExists(fileName, userFolderId);
    if (exists) {
      stats.skippedExisting++;
      return 'skipped_existing';
    }

    await uploadToDrive(fileName, mimeType, buffer, userFolderId);
    stats.uploadedCount++;
    recordStat('unclassified', null);

    // Log to Supabase unclassified table
    try {
      await supabase.from('massivlust_unclassified_files').insert({
        source_type: source,
        source_user: USER_EMAIL,
        file_name: fileName,
        mime_type: mimeType,
        gmail_message_id: gmailMeta?.messageId || null,
        gmail_subject: gmailMeta?.subject || null,
        gmail_from: gmailMeta?.from || null,
        gmail_date: gmailMeta?.date || null,
        classifier_method: classification.suggestedMethod || 'none',
        classifier_confidence: classification.confidence,
        classifier_suggestion: classification.suggestion || null,
        status: 'needs_review',
      });
    } catch (err) {
      console.warn(`  [WARN] Failed to log unclassified file to Supabase: ${err.message}`);
    }

    console.log(`  [UNCLASSIFIED] ${fileName} → Uklassifisert/${userSlug}/ (${classification.detail})`);
    return 'uploaded_unclassified';
  }

  // Classified file: upload to project subfolder
  if (!project.drive_root_folder_id) {
    console.warn(`  [WARN] ${project.name} has no drive folder, skipping ${fileName}`);
    stats.failedCount++;
    return 'no_drive_folder';
  }

  // Get subfolders for this project (cached)
  if (!subfolderCache[project.drive_root_folder_id]) {
    subfolderCache[project.drive_root_folder_id] = await getSubfolders(project.drive_root_folder_id);
  }
  const subfolderIds = subfolderCache[project.drive_root_folder_id];

  const targetSubfolder = classifyToSubfolder(fileName, subject);
  let targetId = subfolderIds[targetSubfolder] || subfolderIds['04 Dokumenter'];

  if (!targetId) {
    console.warn(`  [WARN] No subfolder ${targetSubfolder} for ${project.name}, skipping ${fileName}`);
    stats.failedCount++;
    return 'no_subfolder';
  }

  // Date subfolder for images
  if (targetSubfolder === '02 Bilder' && emailDate) {
    const dateStr = emailDate.toISOString().slice(0, 10);
    targetId = await getOrCreateDateFolder(targetId, dateStr);
  }

  const exists = await checkFileExists(fileName, targetId);
  if (exists) {
    stats.skippedExisting++;
    return 'skipped_existing';
  }

  await uploadToDrive(fileName, mimeType, buffer, targetId);
  stats.uploadedCount++;
  recordStat(method, project.name);

  console.log(`  [${method.toUpperCase()}:${classification.confidence}] ${fileName} → ${project.name}/${targetSubfolder}`);
  return 'uploaded';
}

// ---------------------------------------------------------------------------
// Process Gmail: ALL attachments, no project filter
// ---------------------------------------------------------------------------
async function processGmail(projects) {
  console.log('\n========== GMAIL SCAN ==========');
  const query = 'has:attachment newer_than:24m';
  console.log(`Search query: ${query}`);

  // Collect all message IDs
  const messages = [];
  let pageToken = null;
  do {
    const res = await withBackoff(() => userGmail.users.messages.list({
      userId: 'me', q: query, maxResults: 100, pageToken,
    }), 'gmail list');
    messages.push(...(res.data.messages || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`Found ${messages.length} messages with attachments`);

  const subfolderCache = {};
  let processed = 0;

  for (const msg of messages) {
    try {
      const full = await withBackoff(() => userGmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'full',
      }), `msg ${msg.id}`);

      const headers = full.data.payload?.headers || [];
      const subject = getHeaderValue(headers, 'Subject');
      const from = getHeaderValue(headers, 'From');
      const date = getHeaderValue(headers, 'Date');
      const emailDate = date ? new Date(date) : new Date();
      const body = extractPlainText(full.data.payload || {});
      const threadId = full.data.threadId;

      const attachments = extractAttachments(full.data.payload || {});
      if (attachments.length === 0) continue;

      for (const att of attachments) {
        try {
          // Download attachment first (needed for content-based classification)
          const attRes = await withBackoff(() => userGmail.users.messages.attachments.get({
            userId: 'me', messageId: msg.id, id: att.attachmentId,
          }), `att ${msg.id}/${att.filename}`);
          const buffer = Buffer.from(attRes.data.data, 'base64url');

          // Run classification pipeline
          const classification = await classifyFile({
            fileName: att.filename,
            subject,
            body,
            fromEmail: from,
            threadId,
            buffer,
            mimeType: att.mimeType,
            projects,
            source: 'gmail',
          });

          // Upload to correct destination
          await uploadClassifiedFile({
            fileName: att.filename,
            mimeType: att.mimeType,
            buffer,
            classification,
            subfolderCache,
            subject,
            emailDate,
            gmailMeta: {
              messageId: msg.id,
              subject,
              from,
              date: emailDate.toISOString(),
            },
            source: 'gmail',
          });
        } catch (err) {
          stats.failedCount++;
          console.error(`  [FAIL] ${att.filename}: ${err.message}`);
        }
      }

      processed++;
      if (processed % 50 === 0) {
        console.log(`  ... processed ${processed}/${messages.length} messages`);
      }
    } catch (err) {
      if (err.code === 429 || err.status === 429) {
        console.warn('  [RATE] Gmail rate limit — 30s pause');
        await delay(30000);
      } else {
        console.error(`  [ERROR] msg ${msg.id}: ${err.message}`);
      }
    }
  }

  console.log(`Gmail scan complete: ${processed} messages processed`);
}

// ---------------------------------------------------------------------------
// Process Drive: ALL files owned by user
// ---------------------------------------------------------------------------
async function processDrive(projects) {
  console.log('\n========== DRIVE SCAN ==========');
  const query = "'me' in owners and trashed = false and mimeType != 'application/vnd.google-apps.folder'";

  const files = [];
  let pageToken = null;
  do {
    const res = await withBackoff(() => userDrive.files.list({
      q: query, pageSize: 100, pageToken, corpora: 'user',
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,parents)',
    }), 'drive list');
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`Found ${files.length} files in ${USER_EMAIL}'s Drive`);

  const subfolderCache = {};
  let processed = 0;

  for (const file of files) {
    try {
      // Skip files already in Shared Drive
      const inShared = await isFileInSharedDrive(file.id);
      if (inShared) {
        stats.skippedExisting++;
        continue;
      }

      // Download file for classification
      let buffer = null;
      try {
        const dlRes = await withBackoff(() => userDrive.files.get(
          { fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' },
        ), `download ${file.name}`);
        buffer = Buffer.from(dlRes.data);
      } catch (err) {
        // Some files (Google Docs etc) can't be downloaded directly
        if (err.message?.includes('Use Export')) {
          // Skip Google Workspace native files — they can't be uploaded as-is
          console.log(`  [SKIP] ${file.name} — Google Workspace file (not exportable)`);
          continue;
        }
        console.warn(`  [WARN] Could not download ${file.name}: ${err.message}`);
        stats.failedCount++;
        continue;
      }

      // Run classification pipeline
      const classification = await classifyFile({
        fileName: file.name,
        subject: '',
        body: '',
        fromEmail: '',
        threadId: null,
        buffer,
        mimeType: file.mimeType,
        projects,
        source: 'drive',
      });

      // Upload to correct destination
      await uploadClassifiedFile({
        fileName: file.name,
        mimeType: file.mimeType,
        buffer,
        classification,
        subfolderCache,
        source: 'drive',
      });

      processed++;
      if (processed % 50 === 0) {
        console.log(`  ... processed ${processed}/${files.length} files`);
      }
    } catch (err) {
      if (err.code === 429 || err.status === 429) {
        console.warn('  [RATE] Drive rate limit — 30s pause');
        await delay(30000);
      } else {
        stats.failedCount++;
        console.error(`  [ERROR] ${file.name}: ${err.message}`);
      }
    }
  }

  console.log(`Drive scan complete: ${processed} files processed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = new Date().toISOString();
  console.log(`=== Smart Recovery for ${USER_EMAIL} ===`);
  console.log(`Started: ${startedAt}`);
  console.log(`User slug: ${userSlug}`);
  console.log(`Uklassifisert folder: ${UKLASSIFISERT_USER[userSlug] || UKLASSIFISERT_ROOT}`);
  console.log('');

  // 1. Load active projects from Supabase
  const { data: projects, error: projErr } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id, address, archived')
    .not('drive_root_folder_id', 'is', null);

  if (projErr) {
    console.error(`[FATAL] Failed to load projects: ${projErr.message}`);
    process.exit(1);
  }

  const activeProjects = projects;
  console.log(`Projects with Drive folders: ${activeProjects.length} (${activeProjects.filter(p => !p.archived).length} active, ${activeProjects.filter(p => p.archived).length} archived)`);
  for (const p of activeProjects) {
    console.log(`  - ${p.name}${p.archived ? ' [archived]' : ''} (${p.drive_root_folder_id})`);
  }

  // 2. Build project maps for classification
  buildProjectMaps(activeProjects);

  // 3. Build sender frequency cache from Supabase
  await buildSenderProjectCache();

  // Log not-implemented methods once so the gap is visible
  console.log('');
  console.log('[PIPELINE] Implemented: method 1 (name_match), 2 (thread_context), 3 (sender_frequency), 6 (file_content), 9 (unclassified)');
  console.log('[PIPELINE] NOT IMPLEMENTED: method 4, 5, 7, 8 — skipped in classification');

  // 4. Process Gmail
  await processGmail(activeProjects);

  // 5. Process Drive
  await processDrive(activeProjects);

  // 6. Log sync run to Supabase
  const endedAt = new Date().toISOString();
  const overallStatus = stats.failedCount === 0 ? 'success' : 'partial';

  await supabase.from('massivlust_sync_runs').insert({
    source: `smart_recovery_${userSlug}`,
    status: overallStatus,
    started_at: startedAt,
    ended_at: endedAt,
    rows_in: stats.totalFiles,
    rows_upserted: stats.uploadedCount,
    rows_skipped: stats.skippedExisting,
    rows_failed: stats.failedCount,
    payload: {
      user: USER_EMAIL,
      classification_breakdown: stats.byMethod,
      project_breakdown: stats.byProject,
      unclassified: stats.unclassified,
    },
  });

  // 7. Print summary
  console.log('\n' + '='.repeat(60));
  console.log(`SUMMARY: Smart Recovery for ${USER_EMAIL}`);
  console.log('='.repeat(60));
  console.log(`Total files processed:    ${stats.totalFiles}`);
  console.log(`Uploaded (classified):    ${stats.uploadedCount - stats.unclassified}`);
  console.log(`Uploaded (unclassified):  ${stats.unclassified}`);
  console.log(`Skipped (already exist):  ${stats.skippedExisting}`);
  console.log(`Failed:                   ${stats.failedCount}`);
  console.log('');

  console.log('Files per classification method:');
  for (const [method, count] of Object.entries(stats.byMethod).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${method}: ${count}`);
  }
  console.log('');

  console.log('Files per project:');
  for (const [project, count] of Object.entries(stats.byProject).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${project}: ${count}`);
  }
  if (stats.unclassified > 0) {
    console.log(`  [Uklassifisert]: ${stats.unclassified}`);
  }
  console.log('');

  console.log(`Status: ${overallStatus}`);
  console.log(`Finished: ${endedAt}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
