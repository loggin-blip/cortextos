import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const DOMAIN = 'massivlust.no';

const KEYWORDS = ['fremdrift', 'framdrift', 'gantt', 'milepel', 'milepæl', 'montasje', 'sekvens', 'schedule', 'tidsplan'];

async function listWorkspaceUsers() {
  console.log('[ADMIN] Listing Workspace users...');
  try {
    const auth = new google.auth.JWT(
      SA_KEY.client_email, null, SA_KEY.private_key,
      ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
      `alex@${DOMAIN}`,
    );
    const admin = google.admin({ version: 'directory_v1', auth });
    const res = await admin.users.list({ domain: DOMAIN, maxResults: 200 });
    const users = (res.data.users || []).map(u => ({
      email: u.primaryEmail,
      name: u.name?.fullName || u.primaryEmail,
      suspended: u.suspended,
      isAdmin: u.isAdmin,
    }));
    console.log(`[ADMIN] Found ${users.length} Workspace users`);
    return users;
  } catch (err) {
    console.error(`[ADMIN] Cannot list users: ${err.message}`);
    console.log('[ADMIN] Falling back to known massivlust.no emails');
    return [
      { email: 'alex@massivlust.no', name: 'Alexander Lien' },
      { email: 'mathias@massivlust.no', name: 'Mathias Rønnestad' },
      { email: 'sondre@massivlust.no', name: 'Sondre Langdalen Bjøntegaard' },
    ];
  }
}

function getDriveForUser(email) {
  const auth = new google.auth.JWT(
    SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive.readonly'],
    email,
  );
  return google.drive({ version: 'v3', auth });
}

function getGmailForUser(email) {
  const auth = new google.auth.JWT(
    SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/gmail.modify'],
    email,
  );
  return google.gmail({ version: 'v1', auth });
}

async function searchUserDrive(email) {
  const drive = getDriveForUser(email);
  const nameConditions = KEYWORDS.map(k => `name contains '${k}'`).join(' or ');
  const query = `(${nameConditions}) and trashed = false`;

  const files = [];
  let pageToken = null;
  try {
    do {
      const res = await drive.files.list({
        q: query, pageSize: 100, pageToken,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,owners)',
        corpora: 'user',
      });
      files.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.error(`[DRIVE] ${email}: ${err.message}`);
    return { error: err.message, files: [] };
  }
  return { files };
}

async function searchUserGmail(email) {
  const gmail = getGmailForUser(email);
  const fileKeywords = KEYWORDS.map(k => `filename:${k}`).join(' OR ');
  const query = `(${fileKeywords}) has:attachment newer_than:24m`;

  const results = [];
  try {
    const messages = [];
    let pageToken = null;
    do {
      const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100, pageToken });
      messages.push(...(res.data.messages || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    for (const msg of messages) {
      try {
        const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
        const headers = full.data.payload?.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        const attachments = extractAttachmentNames(full.data.payload || {});
        const planAtts = attachments.filter(a => KEYWORDS.some(k => a.filename.toLowerCase().includes(k)));
        for (const att of planAtts) {
          results.push({ filename: att.filename, mimeType: att.mimeType, subject, from, date });
        }
      } catch (err) {
        if (err.code !== 429) console.error(`[GMAIL] ${email} msg ${msg.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[GMAIL] ${email}: ${err.message}`);
    return { error: err.message, results: [] };
  }
  return { results };
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

async function main() {
  console.log('=== Plan Search — All Workspace Users ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const users = await listWorkspaceUsers();
  const activeUsers = users.filter(u => !u.suspended);
  console.log(`\nActive users: ${activeUsers.map(u => u.email).join(', ')}\n`);

  for (const user of activeUsers) {
    if (user.email === 'alex@massivlust.no') {
      console.log(`\n[SKIP] ${user.email} — already searched in previous run`);
      continue;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Searching: ${user.name} (${user.email})`);
    console.log('='.repeat(60));

    // Test DWD by trying Drive access
    console.log(`[DWD-TEST] Testing impersonation for ${user.email}...`);

    const driveResult = await searchUserDrive(user.email);
    if (driveResult.error) {
      console.log(`[DWD] FAILED for ${user.email}: ${driveResult.error}`);
      console.log(`[DWD] Cannot impersonate this user — DWD scope may need expansion`);
      continue;
    }

    // Filter to recent files (2025+) and non-folders
    const recentFiles = driveResult.files.filter(f =>
      f.modifiedTime?.slice(0, 4) >= '2025' &&
      !f.mimeType?.includes('folder') &&
      !f.mimeType?.includes('shortcut') &&
      !f.name?.startsWith('._')
    );

    console.log(`[DRIVE] ${user.email}: ${driveResult.files.length} total, ${recentFiles.length} recent (2025+)`);
    for (const f of recentFiles) {
      console.log(JSON.stringify({
        source: 'drive', user: user.email, name: f.name,
        mimeType: f.mimeType, modifiedTime: f.modifiedTime?.slice(0, 10),
        webViewLink: f.webViewLink,
      }));
    }

    const gmailResult = await searchUserGmail(user.email);
    if (gmailResult.error) {
      console.log(`[GMAIL] FAILED for ${user.email}: ${gmailResult.error}`);
    } else {
      console.log(`[GMAIL] ${user.email}: ${gmailResult.results.length} plan attachments`);
      for (const r of gmailResult.results) {
        console.log(JSON.stringify({
          source: 'gmail', user: user.email, filename: r.filename,
          subject: r.subject?.slice(0, 80), from: r.from?.slice(0, 60), date: r.date?.slice(0, 30),
        }));
      }
    }
  }

  console.log(`\nFinished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
