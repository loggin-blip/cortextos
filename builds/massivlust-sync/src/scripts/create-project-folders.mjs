import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';
const ALEX_EMAIL = 'alex@massivlust.no';

const SUBFOLDERS = [
  '01 Avvik',
  '02 Bilder',
  '03 Mail',
  '04 Dokumenter',
  '05 Sjekklister',
  '06 HMS',
];

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

async function createFolder(drive, name, parentId) {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    supportsAllDrives: true,
    fields: 'id, name',
  });
  return res.data;
}

async function main() {
  console.log('=== Create Project Folders in Shared Drive ===');
  const drive = makeDrive();

  const { data: projects, error } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id')
    .is('drive_root_folder_id', null)
    .not('name', 'is', null)
    .order('name');

  if (error) { console.error(`DB error: ${error.message}`); return; }
  console.log(`${projects.length} projects without Drive folders`);

  let created = 0;
  let failed = 0;

  for (const project of projects) {
    try {
      console.log(`\nCreating folder: ${project.name}`);
      const root = await createFolder(drive, project.name, SHARED_DRIVE_ID);
      console.log(`  Root: ${root.id}`);

      for (const sub of SUBFOLDERS) {
        const sf = await createFolder(drive, sub, root.id);
        console.log(`    ${sub}: ${sf.id}`);
        await delay(200);
      }

      const { error: updateErr } = await supabase
        .from('massivlust_projects')
        .update({ drive_root_folder_id: root.id })
        .eq('id', project.id);

      if (updateErr) {
        console.warn(`  [WARN] DB update failed: ${updateErr.message}`);
        failed++;
      } else {
        console.log(`  DB updated ✓`);
        created++;
      }

      await delay(500);
    } catch (err) {
      console.error(`  [ERROR] ${project.name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Created: ${created}/${projects.length}`);
  console.log(`Failed: ${failed}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
