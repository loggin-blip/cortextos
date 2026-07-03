import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'fs';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const ALEX_EMAIL = 'alex@massivlust.no';
const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive.readonly'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// 25 random audit_moves rows (pre-fetched)
const MOVES = [
  { file_name: 'RIBtre - Tegninger.zip', to_folder_id: '16TUhsnw3zTX2iLLt-nMfdNbSu91dZ8yL' },
  { file_name: 'Tilbud Jessheim VGS (1).pdf', to_folder_id: '1svFLblqT-W9OsxvtUX_358dPyZKmU9c_' },
  { file_name: 'Fremdriftsplan — Råbygg_VG54.xlsx', to_folder_id: '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn' },
  { file_name: 'Mule rigg uke 28 - Oppstart Massivtre.pdf', to_folder_id: '1aMTcAEg123oEsjYAG_EcQFaFCLFETpoh' },
  { file_name: 'image003.jpg', to_folder_id: '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn' },
  { file_name: '2026-05-28_Odin_20260528_102432_file_415.jpg', to_folder_id: '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn' },
  { file_name: 'Ulsåk Barnehage_project base point.zip', to_folder_id: '1d2YSW25GCh450V2dboojaY-m2LHMqm0Z' },
  { file_name: 'Sjekkliste — I oppstart — Ullsåk', to_folder_id: '1d2YSW25GCh450V2dboojaY-m2LHMqm0Z' },
  { file_name: 'Stål- Jessheim VGS- RIB.xlsx', to_folder_id: '1svFLblqT-W9OsxvtUX_358dPyZKmU9c_' },
  { file_name: 'Sjekkliste — Etter avsluttet — Breivikveien 14', to_folder_id: '1zcZg9fCWBloQPgcw0n_u6j83XQlBE7cY' },
  { file_name: 'Outlook-hcwejedw.png', to_folder_id: '1DUNPypVGT2pmlrZ0vpYyng0fBQ3xe0CF' },
  { file_name: 'KS Verksgata 54.pdf', to_folder_id: '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn' },
  { file_name: 'Jessheim VGS_ML_10102025.ifc', to_folder_id: '1svFLblqT-W9OsxvtUX_358dPyZKmU9c_' },
  { file_name: 'Avvik VG-R403 19.05.2026 — Beskrivelse', to_folder_id: '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn' },
  { file_name: '2.03-Phase III - IV-2026.05.07..pdf', to_folder_id: '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn' },
  { file_name: 'Nøkkelland skruer.xlsx', to_folder_id: '16TUhsnw3zTX2iLLt-nMfdNbSu91dZ8yL' },
  { file_name: 'Sjekkliste — Under veis — Roan', to_folder_id: '15nFEtN3moG9RPzVIjS3eNQndi8sylCgj' },
  { file_name: 'Sjekkliste — Etter avsluttet — Verksgata 54', to_folder_id: '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn' },
  { file_name: 'Nøkkeland RIBtre.ifc', to_folder_id: '16TUhsnw3zTX2iLLt-nMfdNbSu91dZ8yL' },
  { file_name: 'image013.png', to_folder_id: '1s_w0qmZFvVwIC8ugMOHtU9HmetpOk5I_' },
  { file_name: 'Meddelelse 28 trinn 2 Vedl 28-1 3401-04-Frieda-Fasmer-Sykehjem-RIB.ifc', to_folder_id: '1aMTcAEg123oEsjYAG_EcQFaFCLFETpoh' },
  { file_name: 'Bemanningsliste — Ullsåk Barnehage', to_folder_id: '1d2YSW25GCh450V2dboojaY-m2LHMqm0Z' },
  { file_name: '0033_001.pdf', to_folder_id: '1s_w0qmZFvVwIC8ugMOHtU9HmetpOk5I_' },
  { file_name: '2026-05-28_Odin_20260528_174139_file_424.jpg', to_folder_id: '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn' },
  { file_name: 'Roan Barnehage - preliminary IFC_30042026.ifc', to_folder_id: '15nFEtN3moG9RPzVIjS3eNQndi8sylCgj' },
];

const VG54_FOLDER_A = '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn';
const VG54_FOLDER_B = '1uveyJJtcVU6koVijosOEOYWPoqN3oWKe';

async function searchFile(drive, name) {
  const safeName = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name = '${safeName}' AND trashed = false`,
    driveId: SHARED_DRIVE_ID,
    corpora: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: 'files(id, name, parents)',
  });
  return res.data.files || [];
}

async function listFolderContents(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents AND trashed = false`,
    driveId: SHARED_DRIVE_ID,
    corpora: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: 'files(id, name, mimeType)',
    pageSize: 100,
    orderBy: 'name',
  });
  return res.data.files || [];
}

async function getFolderName(drive, folderId) {
  try {
    const res = await drive.files.get({ fileId: folderId, supportsAllDrives: true, fields: 'name' });
    return res.data.name;
  } catch { return folderId; }
}

async function main() {
  const drive = makeDrive();
  const results = [];

  console.log('=== SPOT CHECK: 25 moves ===\n');
  for (const move of MOVES) {
    try {
      const files = await searchFile(drive, move.file_name);
      if (!files.length) {
        console.log(`  [NOT_FOUND] ${move.file_name}`);
        results.push({ name: move.file_name, status: 'NOT_FOUND' });
      } else {
        const matches = files.filter(f => f.parents?.includes(move.to_folder_id));
        if (matches.length > 0) {
          console.log(`  [OK] ${move.file_name}`);
          results.push({ name: move.file_name, status: 'OK' });
        } else {
          const actualParents = files.map(f => f.parents?.join(',') || 'none').join(' | ');
          console.log(`  [WRONG_PLACE] ${move.file_name} | actual parents: ${actualParents}`);
          results.push({ name: move.file_name, status: 'WRONG_PLACE', expected: move.to_folder_id, actual: actualParents });
        }
      }
    } catch (err) {
      console.log(`  [ERROR] ${move.file_name}: ${err.message}`);
      results.push({ name: move.file_name, status: 'ERROR', error: err.message });
    }
    await delay(300);
  }

  const ok = results.filter(r => r.status === 'OK').length;
  const notFound = results.filter(r => r.status === 'NOT_FOUND').length;
  const wrong = results.filter(r => r.status === 'WRONG_PLACE').length;
  const errors = results.filter(r => r.status === 'ERROR').length;
  console.log(`\nSUMMARY: ${ok}/25 correct | ${notFound} not found | ${wrong} wrong place | ${errors} errors`);

  console.log('\n=== VG54 FOLDER A (10H0_XR44h4jLy9nYQqnCdvImO4oezDGn) ===');
  const nameA = await getFolderName(drive, VG54_FOLDER_A);
  console.log(`Folder name: ${nameA}`);
  const contentsA = await listFolderContents(drive, VG54_FOLDER_A);
  console.log(`${contentsA.length} items:`);
  contentsA.slice(0, 30).forEach(f => console.log(`  ${f.name} [${f.mimeType?.split('/').pop()}]`));
  if (contentsA.length > 30) console.log(`  ... and ${contentsA.length - 30} more`);

  console.log('\n=== VG54 FOLDER B (1uveyJJtcVU6koVijosOEOYWPoqN3oWKe) ===');
  const nameB = await getFolderName(drive, VG54_FOLDER_B);
  console.log(`Folder name: ${nameB}`);
  const contentsB = await listFolderContents(drive, VG54_FOLDER_B);
  console.log(`${contentsB.length} items:`);
  contentsB.slice(0, 30).forEach(f => console.log(`  ${f.name} [${f.mimeType?.split('/').pop()}]`));
  if (contentsB.length > 30) console.log(`  ... and ${contentsB.length - 30} more`);
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
