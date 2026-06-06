import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const IMPERSONATE = 'alex@massivlust.no';
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';

function makeAuth(email, scopes) {
  return new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key, scopes, email);
}

const drive = google.drive({ version: 'v3', auth: makeAuth(IMPERSONATE, ['https://www.googleapis.com/auth/drive.readonly']) });
const gmail = google.gmail({ version: 'v1', auth: makeAuth(IMPERSONATE, ['https://www.googleapis.com/auth/gmail.modify']) });

const USERS_TO_SCAN = ['alex@massivlust.no', 'mathias@massivlust.no', 'sondre@massivlust.no'];

async function section1_workspaceUsers() {
  console.log('\n========== 1. WORKSPACE USER MAPPING ==========');

  // Try Admin SDK
  try {
    const admin = google.admin({ version: 'directory_v1', auth: makeAuth(IMPERSONATE, ['https://www.googleapis.com/auth/admin.directory.user.readonly']) });
    const res = await admin.users.list({ domain: 'massivlust.no', maxResults: 200 });
    const users = res.data.users || [];
    console.log(`[ADMIN] ${users.length} Workspace users found:`);
    for (const u of users) {
      console.log(JSON.stringify({
        email: u.primaryEmail,
        name: u.name?.fullName,
        suspended: u.suspended,
        isAdmin: u.isAdmin,
        aliases: u.aliases || [],
        orgUnitPath: u.orgUnitPath,
        creationTime: u.creationTime,
        lastLoginTime: u.lastLoginTime,
      }));
    }
  } catch (err) {
    console.log(`[ADMIN] Admin SDK FAILED: ${err.message}`);
    console.log('[ADMIN] ACTION REQUIRED: Enable Admin SDK at https://console.developers.google.com/apis/api/admin.googleapis.com/overview?project=376814176456');
    console.log('[ADMIN] Also ensure DWD includes scope: https://www.googleapis.com/auth/admin.directory.user.readonly');
  }

  // Verify how we know external emails
  console.log('\n[EVIDENCE] External email evidence:');
  console.log('Checking massivlust_employees table for email sources...');
  // This will be supplemented by the Supabase query run separately

  // Try impersonating known names to discover accounts
  const testEmails = ['eivind@massivlust.no', 'vegard@massivlust.no', 'martin@massivlust.no',
                       'eivind.smedal@massivlust.no', 'vegard.broen@massivlust.no'];
  console.log('\n[DWD-PROBE] Testing if PLs have @massivlust.no accounts:');
  for (const email of testEmails) {
    try {
      const testDrive = google.drive({ version: 'v3', auth: makeAuth(email, ['https://www.googleapis.com/auth/drive.readonly']) });
      await testDrive.about.get({ fields: 'user' });
      console.log(`  ${email}: EXISTS (impersonation succeeded)`);
    } catch (err) {
      if (err.message?.includes('Not Authorized') || err.message?.includes('invalid_grant')) {
        console.log(`  ${email}: DOES NOT EXIST (${err.message.slice(0, 80)})`);
      } else {
        console.log(`  ${email}: ERROR: ${err.message.slice(0, 100)}`);
      }
    }
  }
}

async function section2_allSharedDrives() {
  console.log('\n========== 2. ALL SHARED DRIVES ==========');
  try {
    const drives = [];
    let pageToken = null;
    do {
      const res = await drive.drives.list({ pageSize: 100, pageToken, fields: 'nextPageToken,drives(id,name,createdTime)' });
      drives.push(...(res.data.drives || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    console.log(`[DRIVES] ${drives.length} Shared Drives found:`);
    for (const d of drives) {
      // Count files
      try {
        const count = await drive.files.list({
          corpora: 'drive', driveId: d.id,
          q: 'trashed = false',
          fields: 'files(id)', pageSize: 1,
          supportsAllDrives: true, includeItemsFromAllDrives: true,
        });
        console.log(JSON.stringify({ id: d.id, name: d.name, createdTime: d.createdTime }));
      } catch (err) {
        console.log(JSON.stringify({ id: d.id, name: d.name, error: err.message?.slice(0, 80) }));
      }
    }
  } catch (err) {
    console.log(`[DRIVES] Error listing drives: ${err.message}`);
  }

  // Google Groups
  console.log('\n[GROUPS] Checking Google Groups:');
  try {
    const admin = google.admin({ version: 'directory_v1', auth: makeAuth(IMPERSONATE, ['https://www.googleapis.com/auth/admin.directory.group.readonly']) });
    const res = await admin.groups.list({ domain: 'massivlust.no', maxResults: 200 });
    const groups = res.data.groups || [];
    console.log(`  ${groups.length} groups found:`);
    for (const g of groups) {
      console.log(JSON.stringify({ email: g.email, name: g.name, membersCount: g.directMembersCount }));
    }
  } catch (err) {
    console.log(`  Groups API FAILED: ${err.message.slice(0, 100)}`);
  }
}

async function section3_sharedFromExternal() {
  console.log('\n========== 3. SHARED/EXTERNAL FILES ==========');

  // Search for files shared with massivlust users from external owners
  const planKeywords = ['fremdrift', 'framdrift', 'gantt', 'milepel', 'milepæl', 'tidsplan', 'schedule', 'montasjeplan', 'leveranseplan'];

  for (const email of USERS_TO_SCAN) {
    console.log(`\n[SHARED] Searching files shared with ${email} from external owners...`);
    const userDrive = google.drive({ version: 'v3', auth: makeAuth(email, ['https://www.googleapis.com/auth/drive.readonly']) });

    for (const kw of planKeywords) {
      try {
        const res = await userDrive.files.list({
          q: `name contains '${kw}' and trashed = false and not 'me' in owners`,
          pageSize: 50, corpora: 'user',
          fields: 'files(id,name,mimeType,modifiedTime,owners,sharingUser,webViewLink)',
        });
        for (const f of (res.data.files || [])) {
          console.log(JSON.stringify({
            user: email, keyword: kw, name: f.name, mimeType: f.mimeType,
            modifiedTime: f.modifiedTime?.slice(0, 10),
            owner: f.owners?.[0]?.emailAddress,
            sharedBy: f.sharingUser?.emailAddress,
            webViewLink: f.webViewLink,
          }));
        }
      } catch (err) {
        if (!err.message?.includes('Rate')) console.error(`  [ERROR] ${email}/${kw}: ${err.message.slice(0, 80)}`);
      }
    }
  }
}

async function section4_contentSearch() {
  console.log('\n========== 4. FULLTEXT CONTENT SEARCH ==========');

  const fullTextTerms = ['fremdriftsplan', 'Gantt', 'milepæl', 'leveranseplan', 'tidsplan', 'montasjeplan'];

  // Search Shared Drive with fullText
  console.log('[FULLTEXT] Searching Shared Drive content...');
  for (const term of fullTextTerms) {
    try {
      const res = await drive.files.list({
        q: `fullText contains '${term}' and trashed = false`,
        corpora: 'drive', driveId: SHARED_DRIVE_ID,
        pageSize: 50,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = res.data.files || [];
      if (files.length > 0) {
        console.log(`  "${term}": ${files.length} files`);
        for (const f of files) {
          console.log(JSON.stringify({ term, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime?.slice(0, 10), webViewLink: f.webViewLink }));
        }
      } else {
        console.log(`  "${term}": 0 files`);
      }
    } catch (err) {
      console.log(`  "${term}": ERROR ${err.message.slice(0, 80)}`);
    }
  }

  // Also search each user's personal drive fulltext
  for (const email of USERS_TO_SCAN) {
    console.log(`\n[FULLTEXT] ${email} personal Drive:`);
    const userDrive = google.drive({ version: 'v3', auth: makeAuth(email, ['https://www.googleapis.com/auth/drive.readonly']) });
    for (const term of fullTextTerms) {
      try {
        const res = await userDrive.files.list({
          q: `fullText contains '${term}' and trashed = false`,
          pageSize: 50, corpora: 'user',
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
        });
        const files = res.data.files || [];
        if (files.length > 0) {
          console.log(`  "${term}": ${files.length} files`);
          for (const f of files) {
            console.log(JSON.stringify({ user: email, term, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime?.slice(0, 10), webViewLink: f.webViewLink }));
          }
        }
      } catch (err) {
        // skip rate limit noise
      }
    }
  }

  // Sheets: check headers of plan-named sheets
  console.log('\n[SHEETS] Checking structure of plan-related Google Sheets...');
  try {
    const res = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.spreadsheet' and (name contains 'plan' or name contains 'fremdrift' or name contains 'montasje' or name contains 'gantt') and trashed = false`,
      corpora: 'drive', driveId: SHARED_DRIVE_ID,
      pageSize: 50,
      fields: 'files(id,name,modifiedTime,webViewLink)',
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const sheets = google.sheets({ version: 'v4', auth: makeAuth(IMPERSONATE, ['https://www.googleapis.com/auth/spreadsheets.readonly']) });
    for (const f of (res.data.files || [])) {
      try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: f.id, fields: 'sheets.properties.title' });
        const tabNames = meta.data.sheets?.map(s => s.properties.title) || [];
        console.log(JSON.stringify({ name: f.name, tabs: tabNames, webViewLink: f.webViewLink }));
      } catch (err) {
        console.log(JSON.stringify({ name: f.name, error: err.message?.slice(0, 60) }));
      }
    }
  } catch (err) {
    console.log(`  Error: ${err.message.slice(0, 80)}`);
  }
}

async function section5_gmailDepth() {
  console.log('\n========== 5. GMAIL DEPTH SEARCH ==========');

  const queries = [
    { label: 'subject:fremdriftsplan', q: 'subject:fremdriftsplan' },
    { label: 'subject:tidsplan', q: 'subject:tidsplan' },
    { label: 'subject:montasjeplan', q: 'subject:montasjeplan' },
    { label: 'subject:Gantt', q: 'subject:Gantt' },
    { label: 'body:fremdriftsplan', q: '"fremdriftsplan"' },
    { label: 'body:tidsplan+prosjekt', q: '"tidsplan" prosjekt' },
    { label: 'body:Gantt', q: '"Gantt"' },
    { label: 'body:montasjeplan', q: '"montasjeplan"' },
    { label: 'body:leveranseplan', q: '"leveranseplan"' },
    { label: 'in:drafts+plan', q: 'in:drafts (fremdrift OR tidsplan OR montasjeplan OR Gantt)' },
    { label: 'in:trash+plan', q: 'in:trash (fremdrift OR tidsplan OR montasjeplan OR Gantt) has:attachment' },
  ];

  for (const email of USERS_TO_SCAN) {
    console.log(`\n[GMAIL] ${email}:`);
    const userGmail = google.gmail({ version: 'v1', auth: makeAuth(email, ['https://www.googleapis.com/auth/gmail.modify']) });

    for (const { label, q } of queries) {
      try {
        const res = await userGmail.users.messages.list({ userId: 'me', q, maxResults: 10 });
        const count = res.data.resultSizeEstimate || 0;
        const msgs = res.data.messages || [];
        if (count > 0) {
          console.log(`  ${label}: ${count} results`);
          for (const msg of msgs.slice(0, 3)) {
            const full = await userGmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
            const headers = full.data.payload?.headers || [];
            console.log(JSON.stringify({
              user: email, query: label,
              subject: headers.find(h => h.name === 'Subject')?.value?.slice(0, 80),
              from: headers.find(h => h.name === 'From')?.value?.slice(0, 60),
              date: headers.find(h => h.name === 'Date')?.value?.slice(0, 30),
            }));
          }
        } else {
          console.log(`  ${label}: 0`);
        }
      } catch (err) {
        console.log(`  ${label}: ERROR ${err.message.slice(0, 60)}`);
      }
    }

    // Check labels
    console.log(`\n  [LABELS] ${email}:`);
    try {
      const labelsRes = await userGmail.users.labels.list({ userId: 'me' });
      const labels = (labelsRes.data.labels || []).filter(l => l.type === 'user');
      console.log(`  ${labels.length} custom labels: ${labels.map(l => l.name).join(', ')}`);
    } catch (err) {
      console.log(`  Labels error: ${err.message.slice(0, 60)}`);
    }
  }
}

async function section6_calendar() {
  console.log('\n========== 6. CALENDAR SEARCH ==========');

  const calKeywords = ['montasje', 'fremdrift', 'planlegging', 'statusmøte', 'leveranse', 'Gantt', 'tidsplan'];

  for (const email of USERS_TO_SCAN) {
    console.log(`\n[CAL] ${email}:`);
    const cal = google.calendar({ version: 'v3', auth: makeAuth(email, ['https://www.googleapis.com/auth/calendar.readonly']) });

    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    try {
      const events = await cal.events.list({
        calendarId: 'primary',
        timeMin: twoYearsAgo.toISOString(),
        maxResults: 2500,
        singleEvents: true,
        orderBy: 'startTime',
        fields: 'items(id,summary,description,start,end,attachments,htmlLink)',
      });

      const allEvents = events.data.items || [];
      const planEvents = allEvents.filter(e => {
        const text = ((e.summary || '') + ' ' + (e.description || '')).toLowerCase();
        return calKeywords.some(k => text.includes(k.toLowerCase()));
      });

      console.log(`  ${allEvents.length} total events, ${planEvents.length} plan-related`);

      const withAttachments = planEvents.filter(e => e.attachments?.length > 0);
      console.log(`  ${withAttachments.length} with attachments`);

      for (const e of planEvents.slice(0, 10)) {
        console.log(JSON.stringify({
          user: email,
          summary: e.summary?.slice(0, 80),
          date: e.start?.dateTime?.slice(0, 10) || e.start?.date,
          hasAttachment: (e.attachments?.length || 0) > 0,
          attachments: e.attachments?.map(a => a.title),
          descExcerpt: e.description?.slice(0, 100),
        }));
      }
    } catch (err) {
      console.log(`  Calendar error: ${err.message.slice(0, 80)}`);
    }
  }
}

async function main() {
  console.log('=== FULL KARTLEGGING ===');
  console.log(`Started: ${new Date().toISOString()}\n`);
  console.log(`SA: ${SA_KEY.client_email}`);
  console.log(`Project: ${SA_KEY.project_id}`);

  await section1_workspaceUsers();
  await section2_allSharedDrives();
  await section3_sharedFromExternal();
  await section4_contentSearch();
  await section5_gmailDepth();
  await section6_calendar();

  console.log(`\n=== KARTLEGGING FERDIG ===`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
