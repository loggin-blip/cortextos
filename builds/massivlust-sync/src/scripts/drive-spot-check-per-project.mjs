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

const PROJECTS = [
  { name: 'Verksgata 54', to_folder_id: '10H0_XR44h4jLy9nYQqnCdvImO4oezDGn', samples: [
    { file_name: 'Fremdriftsplan — Råbygg_VG54.xlsx', from_folder_id: '14KSooybMELRTRgrok3OIJFgeTX_bapGt' },
    { file_name: 'KS Verksgata 54.pdf', from_folder_id: '14KSooybMELRTRgrok3OIJFgeTX_bapGt' },
    { file_name: 'Sjekkliste — Etter avsluttet — Verksgata 54', from_folder_id: '1onT2uyqPi_XXyMdbXflLhBkMwGK4kSSD' },
    { file_name: 'Avvik VG-R403 19.05.2026 — Beskrivelse', from_folder_id: '1pziYrbW_lDQeHM_QsdWCEsc_Yhh0zh0s' },
    { file_name: 'Kontrakt Faktureringsplan Verksgata 54.pdf', from_folder_id: '1ubslJiFbECE86p1Op_ZChsEtWlHBAt4O' },
  ]},
  { name: 'Bortelid sentrumsbygg', to_folder_id: '1s_w0qmZFvVwIC8ugMOHtU9HmetpOk5I_', samples: [
    { file_name: 'Sjekkliste — I oppstart — Bortelid sentrumsbygg', from_folder_id: '1y5EuAkU56fui2B_RyPFCi1lxyL4t6I-S' },
    { file_name: 'Sjekkliste — Under veis — Bortelid sentrumsbygg', from_folder_id: '1y5EuAkU56fui2B_RyPFCi1lxyL4t6I-S' },
    { file_name: 'Bemanningsliste — Bortelid sentrumsbygg', from_folder_id: '1DtLBmAATyLXKWX3NIxCsguCPbXNSOXF-' },
    { file_name: 'Bortelid sentrumsbygg 2024.pdf', from_folder_id: '1y5EuAkU56fui2B_RyPFCi1lxyL4t6I-S' },
    { file_name: 'P20-055-P-00-01 v2 180325.ifc', from_folder_id: '1eZRGxEVqL9vWOfAA-EwBEy0J75iGaKLI' },
  ]},
  { name: 'Breivikveien 14', to_folder_id: '1zcZg9fCWBloQPgcw0n_u6j83XQlBE7cY', samples: [
    { file_name: 'Sjekkliste — Etter avsluttet — Breivikveien 14', from_folder_id: '15vh89RrkLByF3mKKY1Rhm0zC_k9uPPQu' },
    { file_name: 'Sjekkliste — I oppstart — Breivikveien 14', from_folder_id: '1ud_NTeFJ3oy-YugJtLu4Qjrb6ueA2paV' },
    { file_name: 'P24-150-P-00-01 110226.ifc', from_folder_id: '1qE1BELwJmtrIFqTU8iYWV1URWuq_x7ra' },
    { file_name: 'Breivikveien KS.pdf', from_folder_id: '1ud_NTeFJ3oy-YugJtLu4Qjrb6ueA2paV' },
    { file_name: 'Bemanningsliste — Breivikveien 14', from_folder_id: '15vh89RrkLByF3mKKY1Rhm0zC_k9uPPQu' },
  ]},
  { name: 'Roan barnehage', to_folder_id: '15nFEtN3moG9RPzVIjS3eNQndi8sylCgj', samples: [
    { file_name: 'Roan Barnehage - preliminary IFC_30042026.ifc', from_folder_id: '1LVilYDS1AyLSe2SUiShBj89tOkocW7N7' },
    { file_name: 'Roan Barnehage - installation drawings_14052026.pdf', from_folder_id: '1MBrc7Ifs5-Gw4Eo8SP_NlpIQyMCLobnh' },
    { file_name: 'Sjekkliste — Under veis — Roan', from_folder_id: '11N522hrOee7huhPuwx0pn_MsuJmm93Dh' },
    { file_name: 'Bemanningsliste — Roan barnehage', from_folder_id: '1MBrc7Ifs5-Gw4Eo8SP_NlpIQyMCLobnh' },
    { file_name: 'Roan Barnehage - preliminary IFC_09042026.ifc', from_folder_id: '1LVilYDS1AyLSe2SUiShBj89tOkocW7N7' },
  ]},
  { name: 'Kvernevik Skole', to_folder_id: '1dTru_d97_XG1qi61CeWPH0VcvV8OA4tH', samples: [
    { file_name: 'Tilbud Kvernevik_Massivtre.pdf', from_folder_id: '1z1vtj1hN1o9RdIjr5kA50QbEuCbZ0ntF' },
    { file_name: 'KVERNEVIK_SKOLE_RIBtre.ifc', from_folder_id: '1z1vtj1hN1o9RdIjr5kA50QbEuCbZ0ntF' },
    { file_name: 'Riggplan Skolebygg fase rev 2.pdf', from_folder_id: '1z1vtj1hN1o9RdIjr5kA50QbEuCbZ0ntF' },
    { file_name: 'Mengdeoppsett til UE for prising montasje.xlsx', from_folder_id: '1z1vtj1hN1o9RdIjr5kA50QbEuCbZ0ntF' },
    { file_name: 'KVERNEVIK_SKOLE_RIBtre_fase.ifc', from_folder_id: '1z1vtj1hN1o9RdIjr5kA50QbEuCbZ0ntF' },
  ]},
  { name: 'Enghave Brygge', to_folder_id: '1DUNPypVGT2pmlrZ0vpYyng0fBQ3xe0CF', samples: [
    { file_name: 'Adressebok.pdf', from_folder_id: '1MzfanAcNRoMADWyOBWdiHjGqeNMxHhrC' },
    { file_name: 'KUN MANUS – FOLIO:KADER KADER.pdf', from_folder_id: '1MzfanAcNRoMADWyOBWdiHjGqeNMxHhrC' },
    { file_name: 'Bank Norwegian - 30 sek - opdateret til pre ppm.pdf', from_folder_id: '1YBe-nu6uFJQ0Lfy3hN0V8GAcRZdYOxRi' },
    { file_name: 'Outlook-hcwejedw.png', from_folder_id: '1MzfanAcNRoMADWyOBWdiHjGqeNMxHhrC' },
    { file_name: 'FjordlandFlere_PPM_200126.pdf', from_folder_id: '1YBe-nu6uFJQ0Lfy3hN0V8GAcRZdYOxRi' },
  ]},
  { name: 'Ullsåk barnehage', to_folder_id: '1d2YSW25GCh450V2dboojaY-m2LHMqm0Z', samples: [
    { file_name: 'Ulsåk Barnehage_project base point.zip', from_folder_id: '1HFEwsrmFU3k2QtFGrX_IODCgn_sHm4q7' },
    { file_name: 'Sjekkliste — I oppstart — Ullsåk', from_folder_id: '1HFEwsrmFU3k2QtFGrX_IODCgn_sHm4q7' },
    { file_name: 'Bemanningsliste — Ullsåk Barnehage', from_folder_id: '1d2YSW25GCh450V2dboojaY-m2LHMqm0Z' },
    { file_name: 'Ulsåk Barnehage_260305_superstructure.ifc', from_folder_id: '1HFEwsrmFU3k2QtFGrX_IODCgn_sHm4q7' },
    { file_name: 'UB- Oppdragsbekreftelse.pdf', from_folder_id: '1d2YSW25GCh450V2dboojaY-m2LHMqm0Z' },
  ]},
  { name: 'Jessheim VGS', to_folder_id: '1svFLblqT-W9OsxvtUX_358dPyZKmU9c_', samples: [
    { file_name: 'Tilbud Jessheim VGS (1).pdf', from_folder_id: '1PmKpUtyDxyCGanAOVJo4zQ8Kfc0PE3rf' },
    { file_name: 'Jessheim VGS_ML_10102025.ifc', from_folder_id: '1PmKpUtyDxyCGanAOVJo4zQ8Kfc0PE3rf' },
    { file_name: 'Stål- Jessheim VGS- RIB.xlsx', from_folder_id: '1PmKpUtyDxyCGanAOVJo4zQ8Kfc0PE3rf' },
    { file_name: 'Tilbud Jessheim VGS.pdf', from_folder_id: '1PmKpUtyDxyCGanAOVJo4zQ8Kfc0PE3rf' },
    { file_name: '03 037023_ÏKSNEVADVGS_RIB #6.ifc', from_folder_id: '1PmKpUtyDxyCGanAOVJo4zQ8Kfc0PE3rf' },
  ]},
  { name: 'Mule Sykehjem', to_folder_id: '1aMTcAEg123oEsjYAG_EcQFaFCLFETpoh', samples: [
    { file_name: 'Mule rigg uke 28 - Oppstart Massivtre.pdf', from_folder_id: '1kS2NLtbjJhNLsdeSwXF4Z1J1nRnx2-vX' },
    { file_name: 'Mule sykehjem - Splitkon 251205.ifc', from_folder_id: '1kS2NLtbjJhNLsdeSwXF4Z1J1nRnx2-vX' },
    { file_name: 'Mule Sykehjem Allrom.ifc', from_folder_id: '1kS2NLtbjJhNLsdeSwXF4Z1J1nRnx2-vX' },
    { file_name: 'Meddelelse 28 trinn 2 Vedl 28-1 3401-04-Frieda-Fasmer-Sykehjem-RIB.ifc', from_folder_id: '1kS2NLtbjJhNLsdeSwXF4Z1J1nRnx2-vX' },
    { file_name: 'Tilbud Mule_Splitkon.pdf', from_folder_id: '1kS2NLtbjJhNLsdeSwXF4Z1J1nRnx2-vX' },
  ]},
  { name: 'Nøkkeland Svømmehall', to_folder_id: '16TUhsnw3zTX2iLLt-nMfdNbSu91dZ8yL', samples: [
    { file_name: 'Nøkkeland RIBtre.ifc', from_folder_id: '1SyAyYgtvHCeKqzLPQl044TWbOy3jV1df' },
    { file_name: 'RIBtre - Tegninger.zip', from_folder_id: '1SyAyYgtvHCeKqzLPQl044TWbOy3jV1df' },
    { file_name: 'Nøkkelland skruer.xlsx', from_folder_id: '1SyAyYgtvHCeKqzLPQl044TWbOy3jV1df' },
    { file_name: '2026 Tilbud Nøkkeland Svømmehall_Massiv Lust AS.pdf', from_folder_id: '1SyAyYgtvHCeKqzLPQl044TWbOy3jV1df' },
    { file_name: 'Nøkkeland svømmehall - liste festemidler.pdf', from_folder_id: '14jnSZ7xMrBdXfPwYFa8flcixC4wdV_qm' },
  ]},
  { name: 'Kiwi Sandved', to_folder_id: '1a5wyQCuW5F6zdmXb8z1B6Yk3mjSXo7hp', samples: [
    { file_name: 'P25-157-v1-001-Komplett.pdf', from_folder_id: '14jnSZ7xMrBdXfPwYFa8flcixC4wdV_qm' },
    { file_name: 'P25-157-v1-001.ifc', from_folder_id: '14jnSZ7xMrBdXfPwYFa8flcixC4wdV_qm' },
    { file_name: 'Modell 16.03.2026 V2.ifc', from_folder_id: '14jnSZ7xMrBdXfPwYFa8flcixC4wdV_qm' },
  ]},
];

async function checkFile(drive, file_name, to_folder_id) {
  const safeName = file_name.replace(/'/g, "\\'");
  try {
    const res = await drive.files.list({
      q: `name = '${safeName}' AND trashed = false`,
      driveId: SHARED_DRIVE_ID,
      corpora: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id, name, parents)',
    });
    const files = res.data.files || [];
    if (!files.length) return { status: 'NOT_FOUND' };
    const inDest = files.filter(f => f.parents?.includes(to_folder_id));
    if (inDest.length) return { status: 'OK' };
    // Check if still in from_folder (not moved)
    const parents = [...new Set(files.flatMap(f => f.parents || []))];
    return { status: 'WRONG_PLACE', actual_parents: parents };
  } catch (err) {
    return { status: 'ERROR', error: err.message?.slice(0, 80) };
  }
}

async function getFolderName(drive, folderId) {
  try {
    const res = await drive.files.get({ fileId: folderId, supportsAllDrives: true, fields: 'name' });
    return res.data.name;
  } catch { return '(unknown)'; }
}

async function main() {
  const drive = makeDrive();
  const summary = [];

  for (const project of PROJECTS) {
    const destName = await getFolderName(drive, project.to_folder_id);
    console.log(`\n=== ${project.name} → folder: "${destName}" ===`);
    let ok = 0, wrong = 0, notFound = 0, errors = 0;
    const issues = [];

    for (const sample of project.samples) {
      const result = await checkFile(drive, sample.file_name, project.to_folder_id);
      if (result.status === 'OK') {
        ok++;
        console.log(`  [OK]          ${sample.file_name}`);
      } else if (result.status === 'NOT_FOUND') {
        notFound++;
        console.log(`  [NOT_FOUND]   ${sample.file_name}`);
        issues.push(`NOT_FOUND: ${sample.file_name}`);
      } else if (result.status === 'WRONG_PLACE') {
        wrong++;
        const inFrom = result.actual_parents?.includes(sample.from_folder_id);
        const note = inFrom ? '(still in from_folder)' : `(parents: ${result.actual_parents?.slice(0,2).join(',')})`;
        console.log(`  [WRONG_PLACE] ${sample.file_name} ${note}`);
        issues.push(`WRONG: ${sample.file_name} ${note}`);
      } else {
        errors++;
        console.log(`  [ERROR]       ${sample.file_name}: ${result.error}`);
      }
      await delay(300);
    }

    const n = project.samples.length;
    console.log(`  → ${ok}/${n} correct`);
    summary.push({ project: project.name, ok, wrong, notFound, errors, n, destFolder: destName, issues });
  }

  console.log('\n\n=== SUMMARY PER PROJECT ===');
  for (const s of summary) {
    console.log(`${s.project}: ${s.ok}/${s.n} OK | wrong:${s.wrong} notFound:${s.notFound} err:${s.errors} | dest="${s.destFolder}"`);
    if (s.issues.length) s.issues.forEach(i => console.log(`    ${i}`));
  }
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
