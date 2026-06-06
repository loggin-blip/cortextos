import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { Readable } from 'stream';

// ── Setup (same pattern as user-recovery.js) ──────────────────────────────────

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ALEX_EMAIL = 'alex@massivlust.no';
const MATHIAS_EMAIL = 'mathias@massivlust.no';

function makeDrive(email, scopes = ['https://www.googleapis.com/auth/drive']) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key, scopes, email);
  return google.drive({ version: 'v3', auth });
}

function makeGmail(email) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/gmail.modify'], email);
  return google.gmail({ version: 'v1', auth });
}

function makeCalendar(email) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/calendar.readonly'], email);
  return google.calendar({ version: 'v3', auth });
}

function makeSheets(email) {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly'], email);
  return google.sheets({ version: 'v4', auth });
}

const alexDrive = makeDrive(ALEX_EMAIL);
const alexDriveRead = makeDrive(ALEX_EMAIL, ['https://www.googleapis.com/auth/drive.readonly']);
const alexGmail = makeGmail(ALEX_EMAIL);
const mathiasCal = makeCalendar(MATHIAS_EMAIL);

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function withBackoff(fn, label = '') {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      if ((err.code === 429 || err.status === 429) && attempt < 8) {
        const wait = Math.min(2000 * Math.pow(2, attempt), 60000);
        attempt++;
        console.warn(`  [BACKOFF] ${label} — 429, attempt ${attempt}, waiting ${wait / 1000}s`);
        await delay(wait);
      } else { throw err; }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getSubfolders(rootId) {
  const res = await withBackoff(() => alexDrive.files.list({
    q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id,name)',
  }), 'list subfolders');
  const map = {};
  for (const f of (res.data.files || [])) map[f.name] = f.id;
  return map;
}

async function checkFileExists(name, parentId) {
  const res = await withBackoff(() => alexDrive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id,name)',
  }), `check ${name}`);
  return res.data.files?.length > 0 ? res.data.files[0] : null;
}

async function uploadToDrive(fileName, mimeType, buffer, parentId) {
  const res = await withBackoff(() => alexDrive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType, body: Readable.from(buffer) },
    supportsAllDrives: true, fields: 'id,name,webViewLink',
  }), `upload ${fileName}`);
  return res.data;
}

async function copyFileToDrive(sourceFileId, newName, parentId) {
  const res = await withBackoff(() => alexDrive.files.copy({
    fileId: sourceFileId,
    requestBody: { name: newName, parents: [parentId] },
    supportsAllDrives: true,
    fields: 'id,name,webViewLink',
  }), `copy ${sourceFileId}`);
  return res.data;
}

async function getOrCreateFolder(parentId, folderName) {
  const existing = await withBackoff(() => alexDrive.files.list({
    q: `'${parentId}' in parents and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id,name)',
  }), `find folder ${folderName}`);
  if (existing.data.files?.length > 0) return existing.data.files[0];
  const created = await withBackoff(() => alexDrive.files.create({
    requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    supportsAllDrives: true, fields: 'id,name',
  }), `mkdir ${folderName}`);
  return created.data;
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

function getPlainTextBody(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = getPlainTextBody(part);
      if (text) return text;
    }
  }
  return null;
}

function getHtmlBody(payload) {
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const html = getHtmlBody(part);
      if (html) return html;
    }
  }
  return null;
}

// ── Results tracking ──────────────────────────────────────────────────────────

const results = {
  task1: { status: 'pending', details: {} },
  task2: { status: 'pending', details: {} },
  task3: { status: 'pending', details: {} },
  task4: { status: 'pending', details: {} },
  task5: { status: 'pending', details: {} },
};

// ── Task 1: Bortelid sentrumsbygg 2024.xlsx ───────────────────────────────────

async function task1_bortelid_xlsx() {
  console.log('\n' + '='.repeat(70));
  console.log('TASK 1: Bortelid sentrumsbygg 2024.xlsx');
  console.log('='.repeat(70));

  const FILE_ID = '1V8-mv4RjxXQknFVfBW24Rjr4m0NtgBeY';

  // Step 1: Look up Bortelid project in Supabase (check both archived and active)
  console.log('[1.1] Looking up Bortelid project in massivlust_projects...');
  const { data: projects, error: projErr } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id, archived')
    .ilike('name', '%bortelid%');

  if (projErr) {
    console.error(`  [ERROR] Supabase query failed: ${projErr.message}`);
    results.task1 = { status: 'failed', details: { error: projErr.message } };
    return;
  }

  if (!projects || projects.length === 0) {
    console.log('  [SKIP] No Bortelid project found in massivlust_projects');
    results.task1 = { status: 'skipped', details: { reason: 'no project found' } };
    return;
  }

  const project = projects[0];
  console.log(`  Found: "${project.name}" (archived=${project.archived}, drive_root=${project.drive_root_folder_id || 'NONE'})`);

  if (!project.drive_root_folder_id) {
    console.log('  [SKIP] No drive_root_folder_id — cannot determine target folder');
    results.task1 = { status: 'skipped', details: { reason: 'no drive_root_folder_id', project: project.name } };
    return;
  }

  // Step 2: Get subfolders, find "00 Oversikt"
  console.log('[1.2] Getting project subfolders...');
  const subfolders = await getSubfolders(project.drive_root_folder_id);
  console.log(`  Subfolders: ${Object.keys(subfolders).join(', ') || 'none'}`);

  const oversiktId = subfolders['00 Oversikt'];
  if (!oversiktId) {
    console.log('  [WARN] No "00 Oversikt" subfolder — creating it...');
    const created = await getOrCreateFolder(project.drive_root_folder_id, '00 Oversikt');
    subfolders['00 Oversikt'] = created.id;
  }
  const targetFolderId = subfolders['00 Oversikt'];
  console.log(`  Target folder: 00 Oversikt (${targetFolderId})`);

  // Step 3: Check if file already exists in target
  console.log('[1.3] Checking if file already exists in target folder...');
  const existing = await checkFileExists('Bortelid sentrumsbygg 2024.xlsx', targetFolderId);
  if (existing) {
    console.log(`  [SKIP] File already exists: ${existing.name} (${existing.id})`);
  } else {
    // Copy the file from Shared Drive to the project subfolder
    console.log('[1.3] Copying file to 00 Oversikt...');
    try {
      const copied = await copyFileToDrive(FILE_ID, 'Bortelid sentrumsbygg 2024.xlsx', targetFolderId);
      console.log(`  [COPIED] ${copied.name} → ${copied.webViewLink}`);
    } catch (err) {
      console.error(`  [ERROR] Copy failed: ${err.message}`);
      // File might be a Google Sheet (uploaded as xlsx) — try it still for sheet reading
    }
  }

  // Step 4: Export as xlsx and read sheet/tab names using Sheets API
  console.log('[1.4] Reading sheet/tab names...');
  try {
    // The file might be a Google Sheets file or an uploaded xlsx.
    // Try Sheets API first (works for Google Sheets)
    const sheets = makeSheets(ALEX_EMAIL);
    const meta = await withBackoff(() => sheets.spreadsheets.get({
      spreadsheetId: FILE_ID,
      fields: 'sheets.properties(title,sheetId,index)',
    }), 'sheets meta');

    const tabNames = meta.data.sheets?.map(s => s.properties.title) || [];
    console.log(`  Sheet tabs (${tabNames.length}): ${tabNames.join(', ')}`);
    results.task1 = { status: 'success', details: { project: project.name, tabs: tabNames, fileId: FILE_ID } };
  } catch (sheetsErr) {
    console.log(`  [INFO] Sheets API failed (likely uploaded xlsx, not native Sheet): ${sheetsErr.message?.slice(0, 80)}`);
    // Try downloading as xlsx and reading with a basic parser
    try {
      console.log('  Downloading xlsx binary to inspect...');
      const dlRes = await withBackoff(() => alexDriveRead.files.get(
        { fileId: FILE_ID, alt: 'media' }, { responseType: 'arraybuffer' },
      ), 'download xlsx');
      const buf = Buffer.from(dlRes.data);
      // Simple xlsx sheet name extraction: look for "xl/workbook.xml" entry in the zip
      // xlsx files are zips — sheet names are in xl/workbook.xml as <sheet name="..." />
      const xmlStr = buf.toString('utf8', 0, Math.min(buf.length, 500000));
      const sheetNameMatches = [...xmlStr.matchAll(/<sheet\s+name="([^"]+)"/g)];
      if (sheetNameMatches.length > 0) {
        const names = sheetNameMatches.map(m => m[1]);
        console.log(`  Sheet tabs (${names.length}): ${names.join(', ')}`);
        results.task1 = { status: 'success', details: { project: project.name, tabs: names, fileId: FILE_ID } };
      } else {
        console.log('  [WARN] Could not parse sheet names from binary');
        results.task1 = { status: 'partial', details: { project: project.name, fileId: FILE_ID, note: 'copied but could not read tabs' } };
      }
    } catch (dlErr) {
      console.error(`  [ERROR] Download failed: ${dlErr.message?.slice(0, 80)}`);
      results.task1 = { status: 'partial', details: { project: project.name, fileId: FILE_ID, note: 'copied but download for tab read failed' } };
    }
  }
}

// ── Task 2: Fremdriftsplan from Carsten Hovind ────────────────────────────────

async function task2_carsten_fremdriftsplan() {
  console.log('\n' + '='.repeat(70));
  console.log('TASK 2: Fremdriftsplan from Carsten Hovind');
  console.log('='.repeat(70));

  // Step 1: Search alex@ Gmail
  const query = 'from:carsten@massivtre.as subject:Fremdriftsplan has:attachment newer_than:3m';
  console.log(`[2.1] Gmail search: ${query}`);

  const messages = [];
  let pageToken = null;
  try {
    do {
      const res = await withBackoff(() => alexGmail.users.messages.list({
        userId: 'me', q: query, maxResults: 100, pageToken,
      }), 'gmail list carsten');
      messages.push(...(res.data.messages || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.error(`  [ERROR] Gmail search failed: ${err.message}`);
    results.task2 = { status: 'failed', details: { error: err.message } };
    return;
  }

  console.log(`  Found ${messages.length} matching messages`);

  if (messages.length === 0) {
    console.log('  [SKIP] No messages from Carsten with Fremdriftsplan attachment in last 3 months');
    results.task2 = { status: 'skipped', details: { reason: 'no matching emails' } };
    return;
  }

  // Step 2: Load all projects for matching
  const { data: allProjects } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id, archived');

  const projectList = allProjects || [];
  console.log(`  Loaded ${projectList.length} projects for matching`);

  let totalUploaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  const uploadedFiles = [];

  for (const msg of messages) {
    try {
      const full = await withBackoff(() => alexGmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'full',
      }), `msg ${msg.id}`);

      const headers = full.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      console.log(`\n  [MSG] Subject: "${subject}" | Date: ${date}`);

      const attachments = extractAttachments(full.data.payload || {});
      console.log(`  Attachments: ${attachments.length} — ${attachments.map(a => a.filename).join(', ')}`);

      // Step 3: For each attachment, determine project from subject
      for (const att of attachments) {
        // Try to match project name in subject or filename
        let matchedProject = null;
        const searchText = (subject + ' ' + att.filename).toLowerCase();
        for (const proj of projectList) {
          const projWords = proj.name.toLowerCase().split(/\s+/);
          // Match if any significant word (>3 chars) from project name appears
          if (projWords.some(w => w.length > 3 && searchText.includes(w))) {
            matchedProject = proj;
            break;
          }
        }

        if (!matchedProject) {
          console.log(`    [WARN] Could not match "${att.filename}" to a project from subject/filename`);
          console.log(`    Subject keywords: ${subject}`);
          totalSkipped++;
          continue;
        }

        if (!matchedProject.drive_root_folder_id) {
          console.log(`    [SKIP] Project "${matchedProject.name}" has no drive_root_folder_id`);
          totalSkipped++;
          continue;
        }

        console.log(`    Matched project: "${matchedProject.name}"`);

        // Get or create "00 Oversikt" subfolder
        const subfolders = await getSubfolders(matchedProject.drive_root_folder_id);
        let oversiktId = subfolders['00 Oversikt'];
        if (!oversiktId) {
          const created = await getOrCreateFolder(matchedProject.drive_root_folder_id, '00 Oversikt');
          oversiktId = created.id;
        }

        // Check if already exists
        const existing = await checkFileExists(att.filename, oversiktId);
        if (existing) {
          console.log(`    [SKIP] "${att.filename}" already exists in 00 Oversikt`);
          totalSkipped++;
          continue;
        }

        // Download attachment from Gmail and upload to Drive
        try {
          const attData = await withBackoff(() => alexGmail.users.messages.attachments.get({
            userId: 'me', messageId: msg.id, id: att.attachmentId,
          }), `att ${att.filename}`);
          const buffer = Buffer.from(attData.data.data, 'base64url');

          const uploaded = await uploadToDrive(att.filename, att.mimeType, buffer, oversiktId);
          console.log(`    [UPLOADED] ${att.filename} → ${matchedProject.name}/00 Oversikt (${uploaded.webViewLink})`);
          totalUploaded++;
          uploadedFiles.push({ file: att.filename, project: matchedProject.name, link: uploaded.webViewLink });
        } catch (uploadErr) {
          console.error(`    [FAIL] Upload of ${att.filename}: ${uploadErr.message}`);
          totalFailed++;
        }
      }
    } catch (err) {
      console.error(`  [ERROR] Processing msg ${msg.id}: ${err.message}`);
      totalFailed++;
    }
  }

  console.log(`\n  [SUMMARY] Uploaded: ${totalUploaded}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`);
  results.task2 = {
    status: totalUploaded > 0 ? 'success' : (totalSkipped > 0 ? 'skipped' : 'failed'),
    details: { messages: messages.length, uploaded: totalUploaded, skipped: totalSkipped, failed: totalFailed, files: uploadedFiles },
  };
}

// ── Task 3: Montasjeplan 16b from Vegard (Google Keep) ────────────────────────

async function task3_montasjeplan_16b() {
  console.log('\n' + '='.repeat(70));
  console.log('TASK 3: Montasjeplan 16b from Vegard (Google Keep)');
  console.log('='.repeat(70));

  // Google Keep has no public API — search Gmail for Keep share notifications
  const queries = [
    'from:keep-shares subject:"Montasjeplan 16b"',
    'from:keep-noreply@google.com subject:"Montasjeplan 16b"',
    'from:keep subject:"Montasjeplan"',
    '"Montasjeplan 16b" (from:vegard OR from:keep)',
  ];

  let foundContent = false;
  const keepResults = [];

  for (const q of queries) {
    console.log(`[3.1] Gmail search: ${q}`);
    try {
      const res = await withBackoff(() => alexGmail.users.messages.list({
        userId: 'me', q, maxResults: 20,
      }), `gmail keep ${q.slice(0, 30)}`);

      const msgs = res.data.messages || [];
      console.log(`  Found ${msgs.length} messages`);

      for (const msg of msgs) {
        const full = await withBackoff(() => alexGmail.users.messages.get({
          userId: 'me', id: msg.id, format: 'full',
        }), `msg ${msg.id}`);

        const headers = full.data.payload?.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        const plainBody = getPlainTextBody(full.data.payload || {});
        const htmlBody = getHtmlBody(full.data.payload || {});

        console.log(`\n  [MSG] Subject: "${subject}"`);
        console.log(`  From: ${from} | Date: ${date}`);
        if (plainBody) {
          console.log(`  Body (plain, first 500 chars):\n${plainBody.slice(0, 500)}`);
        } else if (htmlBody) {
          // Strip HTML tags for readability
          const stripped = htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          console.log(`  Body (stripped HTML, first 500 chars):\n${stripped.slice(0, 500)}`);
        }

        // Extract any links
        const linkMatches = (htmlBody || plainBody || '').match(/https?:\/\/[^\s"<]+/g) || [];
        if (linkMatches.length > 0) {
          console.log(`  Links found: ${linkMatches.join(', ')}`);
        }

        keepResults.push({ subject, from, date, hasBody: !!(plainBody || htmlBody), links: linkMatches });
        foundContent = true;
      }
    } catch (err) {
      console.log(`  [ERROR] ${err.message?.slice(0, 80)}`);
    }
  }

  // Try to determine what "16b" refers to
  console.log('\n[3.2] Attempting to match "16b" to a project...');
  const { data: projects16b } = await supabase
    .from('massivlust_projects')
    .select('id, name')
    .or('name.ilike.%16b%,name.ilike.%16 b%');

  if (projects16b && projects16b.length > 0) {
    console.log(`  Possible project matches for "16b": ${projects16b.map(p => p.name).join(', ')}`);
  } else {
    console.log('  No direct project match for "16b" — could be a building/element number');
    // Search broader
    const { data: allProj } = await supabase
      .from('massivlust_projects')
      .select('id, name')
      .eq('archived', false);
    if (allProj) {
      console.log(`  Active projects: ${allProj.map(p => p.name).join(', ')}`);
    }
  }

  if (!foundContent) {
    console.log('\n  [INFO] No Keep share notifications found in alex@ Gmail.');
    console.log('  Google Keep content is not accessible via API.');
    console.log('  ACTION REQUIRED: Ask Vegard to share the Keep note as a Google Doc or PDF.');
  }

  results.task3 = {
    status: foundContent ? 'partial' : 'skipped',
    details: {
      note: 'Google Keep API not available — searched Gmail for share notifications',
      keepResults,
      actionRequired: !foundContent ? 'Ask Vegard to export Keep note to Doc/PDF' : undefined,
    },
  };
}

// ── Task 4: Bentsebrua files from adevold@gmail.com ───────────────────────────

async function task4_bentsebrua() {
  console.log('\n' + '='.repeat(70));
  console.log('TASK 4: Bentsebrua files (historical)');
  console.log('='.repeat(70));

  const FILES = [
    { id: '1aIu9gReuhetwuIGaK98efA8-Bz4lvl4H', name: 'Bentsebrua skole Fremdriftplan Råbygg.pdf', mime: 'application/pdf' },
    { id: '1xYp08d4v5PY1vAZcNj6t7AYv8bs4Alsp', name: 'Leveranseplan.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ];

  const HISTORICAL_FOLDER_NAME = 'Historisk — Bentsebrua';

  // Step 1: Find or create the historical folder under Shared Drive root
  console.log(`[4.1] Getting or creating "${HISTORICAL_FOLDER_NAME}" under Shared Drive root...`);
  const histFolder = await getOrCreateFolder(SHARED_DRIVE_ID, HISTORICAL_FOLDER_NAME);
  console.log(`  Folder: ${histFolder.name} (${histFolder.id})`);

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const copiedFiles = [];

  for (const file of FILES) {
    console.log(`\n[4.2] Processing: ${file.name}`);

    // Check if already exists
    const existing = await checkFileExists(file.name, histFolder.id);
    if (existing) {
      console.log(`  [SKIP] Already exists: ${existing.name}`);
      skipped++;
      continue;
    }

    // Copy from alex@ Drive (shared from external) to Shared Drive historical folder
    try {
      const copiedFile = await copyFileToDrive(file.id, file.name, histFolder.id);
      console.log(`  [COPIED] ${copiedFile.name} → ${HISTORICAL_FOLDER_NAME} (${copiedFile.webViewLink})`);
      copied++;
      copiedFiles.push({ name: copiedFile.name, link: copiedFile.webViewLink });
    } catch (copyErr) {
      console.log(`  [WARN] Copy failed (${copyErr.message?.slice(0, 60)}), trying download+upload...`);
      try {
        // Fallback: download from alex Drive and upload to Shared Drive
        const dlRes = await withBackoff(() => alexDriveRead.files.get(
          { fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' },
        ), `download ${file.name}`);
        const buffer = Buffer.from(dlRes.data);
        const uploaded = await uploadToDrive(file.name, file.mime, buffer, histFolder.id);
        console.log(`  [UPLOADED] ${uploaded.name} → ${HISTORICAL_FOLDER_NAME} (${uploaded.webViewLink})`);
        copied++;
        copiedFiles.push({ name: uploaded.name, link: uploaded.webViewLink });
      } catch (dlErr) {
        console.error(`  [FAIL] Could not copy or download: ${dlErr.message}`);
        failed++;
      }
    }
  }

  console.log(`\n  [SUMMARY] Copied: ${copied}, Skipped: ${skipped}, Failed: ${failed}`);
  console.log('  [NOTE] Bentsebrua is NOT an active project — filed as historical reference');

  results.task4 = {
    status: copied > 0 ? 'success' : (skipped > 0 ? 'skipped' : 'failed'),
    details: { folder: HISTORICAL_FOLDER_NAME, copied, skipped, failed, files: copiedFiles },
  };
}

// ── Task 5: Bortelid Statusmøte Gemini notes ─────────────────────────────────

async function task5_gemini_notes() {
  console.log('\n' + '='.repeat(70));
  console.log('TASK 5: Bortelid Statusmøte Gemini notes');
  console.log('='.repeat(70));

  const GEMINI_DOC_ID = '1QGJ2L_x4sxf9JPUIX5Zk-vHKo_QEHXslG09QLo2Se2k';

  // Step 1: Search mathias@ Calendar for the event
  console.log('[5.1] Searching mathias@ Calendar for "Statusmøte Montasje Bortelid" (around April 2025)...');
  try {
    const timeMin = new Date('2025-03-01').toISOString();
    const timeMax = new Date('2025-06-01').toISOString();

    const events = await withBackoff(() => mathiasCal.events.list({
      calendarId: 'primary',
      timeMin, timeMax,
      q: 'Statusmøte Montasje Bortelid',
      singleEvents: true,
      orderBy: 'startTime',
      fields: 'items(id,summary,description,start,end,attachments,htmlLink,creator)',
    }), 'calendar search');

    const items = events.data.items || [];
    console.log(`  Found ${items.length} matching events`);

    for (const ev of items) {
      console.log(`  Event: "${ev.summary}" | ${ev.start?.dateTime || ev.start?.date}`);
      if (ev.description) console.log(`  Description (first 200): ${ev.description.slice(0, 200)}`);
      if (ev.attachments?.length > 0) {
        console.log(`  Attachments: ${ev.attachments.map(a => `${a.title} (${a.fileId})`).join(', ')}`);
      }
    }
  } catch (calErr) {
    console.log(`  [WARN] Calendar search error: ${calErr.message?.slice(0, 80)}`);
  }

  // Step 2: Read the Gemini notes doc content
  console.log(`\n[5.2] Reading Gemini notes doc (${GEMINI_DOC_ID})...`);
  let docContent = '';
  try {
    // Export as text/plain using Drive API
    // Try with alex@ first (might have access via Shared Drive), then mathias@
    let exportRes;
    try {
      exportRes = await withBackoff(() => alexDriveRead.files.export({
        fileId: GEMINI_DOC_ID,
        mimeType: 'text/plain',
      }), 'export doc alex');
    } catch {
      console.log('  [INFO] alex@ cannot access doc, trying mathias@...');
      const mathiasDrive = makeDrive(MATHIAS_EMAIL, ['https://www.googleapis.com/auth/drive.readonly']);
      exportRes = await withBackoff(() => mathiasDrive.files.export({
        fileId: GEMINI_DOC_ID,
        mimeType: 'text/plain',
      }), 'export doc mathias');
    }

    docContent = typeof exportRes.data === 'string' ? exportRes.data : String(exportRes.data);
    console.log(`  Doc length: ${docContent.length} chars`);
    console.log(`  Content summary (first 500 chars):\n${docContent.slice(0, 500)}`);
    console.log('  ...');
    if (docContent.length > 500) {
      console.log(`  (last 200 chars): ${docContent.slice(-200)}`);
    }
  } catch (docErr) {
    console.error(`  [ERROR] Could not read Gemini doc: ${docErr.message}`);
    results.task5 = { status: 'failed', details: { error: docErr.message, docId: GEMINI_DOC_ID } };
    return;
  }

  if (!docContent || docContent.trim().length === 0) {
    console.log('  [WARN] Doc is empty');
    results.task5 = { status: 'partial', details: { note: 'doc was empty', docId: GEMINI_DOC_ID } };
    return;
  }

  // Step 3: Find Bortelid project and its "07 Oppfølging" subfolder
  console.log('\n[5.3] Looking up Bortelid project for upload...');
  const { data: bortelidProjects } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id, archived')
    .ilike('name', '%bortelid%');

  const bortelid = bortelidProjects?.[0];
  if (!bortelid || !bortelid.drive_root_folder_id) {
    console.log('  [SKIP] No Bortelid project with drive_root_folder_id');
    results.task5 = {
      status: 'partial',
      details: { note: 'doc read but no project folder to upload to', docLength: docContent.length, docId: GEMINI_DOC_ID },
    };
    return;
  }

  const subfolders = await getSubfolders(bortelid.drive_root_folder_id);
  let oppfolgingId = subfolders['07 Oppfølging'];
  if (!oppfolgingId) {
    console.log('  [INFO] Creating "07 Oppfølging" subfolder...');
    const created = await getOrCreateFolder(bortelid.drive_root_folder_id, '07 Oppfølging');
    oppfolgingId = created.id;
  }

  // Step 4: Upload the text content as a file
  const fileName = 'Statusmøte Montasje Bortelid — Gemini Notes.txt';
  console.log(`\n[5.4] Uploading "${fileName}" to 07 Oppfølging...`);

  const existing = await checkFileExists(fileName, oppfolgingId);
  if (existing) {
    console.log(`  [SKIP] File already exists: ${existing.name}`);
    results.task5 = {
      status: 'success',
      details: { note: 'already uploaded', docLength: docContent.length, docId: GEMINI_DOC_ID },
    };
    return;
  }

  try {
    const buffer = Buffer.from(docContent, 'utf8');
    const uploaded = await uploadToDrive(fileName, 'text/plain', buffer, oppfolgingId);
    console.log(`  [UPLOADED] ${uploaded.name} → 07 Oppfølging (${uploaded.webViewLink})`);
    results.task5 = {
      status: 'success',
      details: {
        project: bortelid.name,
        docLength: docContent.length,
        docId: GEMINI_DOC_ID,
        uploadedLink: uploaded.webViewLink,
      },
    };
  } catch (upErr) {
    console.error(`  [FAIL] Upload failed: ${upErr.message}`);
    results.task5 = { status: 'failed', details: { error: upErr.message, docId: GEMINI_DOC_ID } };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();
  console.log('=== FETCH PLAN FILES — Wave C ===');
  console.log(`Started: ${startedAt}`);
  console.log(`SA: ${SA_KEY.client_email}`);
  console.log(`Shared Drive: ${SHARED_DRIVE_ID}\n`);

  // Run all 5 tasks sequentially
  try { await task1_bortelid_xlsx(); } catch (err) {
    console.error(`\n[TASK 1 FATAL] ${err.message}`);
    results.task1 = { status: 'failed', details: { error: err.message } };
  }

  try { await task2_carsten_fremdriftsplan(); } catch (err) {
    console.error(`\n[TASK 2 FATAL] ${err.message}`);
    results.task2 = { status: 'failed', details: { error: err.message } };
  }

  try { await task3_montasjeplan_16b(); } catch (err) {
    console.error(`\n[TASK 3 FATAL] ${err.message}`);
    results.task3 = { status: 'failed', details: { error: err.message } };
  }

  try { await task4_bentsebrua(); } catch (err) {
    console.error(`\n[TASK 4 FATAL] ${err.message}`);
    results.task4 = { status: 'failed', details: { error: err.message } };
  }

  try { await task5_gemini_notes(); } catch (err) {
    console.error(`\n[TASK 5 FATAL] ${err.message}`);
    results.task5 = { status: 'failed', details: { error: err.message } };
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const endedAt = new Date().toISOString();

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  for (const [task, res] of Object.entries(results)) {
    const emoji = res.status === 'success' ? 'OK' : res.status === 'partial' ? 'PARTIAL' : res.status === 'skipped' ? 'SKIP' : 'FAIL';
    console.log(`  ${task}: [${emoji}] ${JSON.stringify(res.details)}`);
  }

  // ── Log sync run to Supabase ────────────────────────────────────────────────
  const successCount = Object.values(results).filter(r => r.status === 'success').length;
  const failCount = Object.values(results).filter(r => r.status === 'failed').length;
  const overallStatus = failCount === 0 ? (successCount > 0 ? 'success' : 'partial') : 'partial';

  try {
    await supabase.from('massivlust_sync_runs').insert({
      source: 'wave_c_planfiles',
      status: overallStatus,
      started_at: startedAt,
      ended_at: endedAt,
      rows_in: 5,
      rows_upserted: successCount,
      rows_skipped: Object.values(results).filter(r => r.status === 'skipped').length,
      rows_failed: failCount,
      payload: results,
    });
    console.log(`\n[SUPABASE] Sync run logged (source=wave_c_planfiles, status=${overallStatus})`);
  } catch (sbErr) {
    console.error(`\n[SUPABASE] Failed to log sync run: ${sbErr.message}`);
  }

  console.log(`\nFinished: ${endedAt}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
