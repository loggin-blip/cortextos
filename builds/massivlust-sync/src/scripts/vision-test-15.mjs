/**
 * Vision test: 15 images from Drive via claude CLI JSON stdin.
 * Read-only — no DB writes, no moves, no deletes.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const SA_KEY = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json', 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALEX_EMAIL = 'alex@massivlust.no';

function makeDrive() {
  const auth = new google.auth.JWT(SA_KEY.client_email, null, SA_KEY.private_key,
    ['https://www.googleapis.com/auth/drive'], ALEX_EMAIL);
  return google.drive({ version: 'v3', auth });
}

async function downloadToBase64(drive, fileId) {
  const res = await drive.files.get(
    { fileId, supportsAllDrives: true, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data).toString('base64');
}

function getMediaType(mimeType) {
  if (mimeType?.includes('png')) return 'image/png';
  if (mimeType?.includes('gif')) return 'image/gif';
  if (mimeType?.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

function analyzeWithVision(b64, mediaType, fileName, folderPath) {
  const prompt = {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
      { type: 'text', text: `Du ser på et bilde fra Massivlust AS sitt Google Drive.
Filnavn: ${fileName}
Mappesti: ${folderPath || 'ukjent'}

Beskriv konkret:
1. Hva viser bildet? (byggeplass, rom, detalj, dokument-foto, privat, annet?)
2. Er det profesjonelt/jobbrelert eller privat?
3. Prosjekt-hint: ser du stedsnavn, prosjektnummer, bygg-type?
4. Forslag til kategori: KS-foto, avvik-dokumentasjon, framdrifts-foto, privat, annet?

Svar kort og konkret — maks 5 setninger.` }
    ]
  };

  const result = spawnSync(
    '/opt/homebrew/bin/claude',
    ['--print', '--model', 'claude-opus-4-7', '--dangerously-skip-permissions', '--output-format', 'json'],
    { input: JSON.stringify(prompt), encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
  );

  if (result.error || result.status !== 0) {
    return { error: result.error?.message || result.stderr?.slice(0, 100) };
  }
  try {
    const j = JSON.parse(result.stdout.trim());
    return { answer: j.result, cost: j.total_cost_usd };
  } catch {
    return { error: 'parse fail', raw: result.stdout.slice(0, 200) };
  }
}

async function fetchImages(filter, label, limit) {
  let q = supabase
    .from('massivlust_unclassified_files')
    .select('id, file_name, drive_file_id, mime_type, current_drive_folder_path, current_drive_folder_name')
    .like('mime_type', 'image/%')
    .not('drive_file_id', 'is', null)
    .limit(limit * 4); // fetch extra, skip empties

  if (filter === 'ks') {
    q = q.or('current_drive_folder_path.ilike.%KS%,current_drive_folder_path.ilike.%avvik%,current_drive_folder_path.ilike.%kontroll%,current_drive_folder_name.ilike.%KS%,current_drive_folder_name.ilike.%avvik%');
  } else if (filter === 'prosjekt_bilder') {
    q = q.or('current_drive_folder_path.ilike.%Prosjekter%Bilder%,current_drive_folder_path.ilike.%prosjekt%bilde%,current_drive_folder_path.ilike.%# Prosjekter%');
  } else if (filter === 'mindisk') {
    q = q.or('current_drive_folder_path.ilike.%Min disk%,current_drive_folder_name.ilike.%Min disk%').not('current_drive_folder_path', 'ilike', '%Google Foto%').not('current_drive_folder_path', 'ilike', '%Google Photos%');
  }

  const { data, error } = await q;
  if (error) { console.error(`DB error (${label}): ${error.message}`); return []; }
  return (data || []).slice(0, limit);
}

async function main() {
  const drive = makeDrive();
  const results = [];
  const totalCost = { usd: 0 };

  const groups = [
    { filter: 'ks', label: 'KS/avvik', count: 5 },
    { filter: 'prosjekt_bilder', label: '# Prosjekter/.../Bilder', count: 5 },
    { filter: 'mindisk', label: 'Min disk rot', count: 5 },
  ];

  for (const group of groups) {
    console.log(`\nFetching ${group.count} images: ${group.label}...`);
    const files = await fetchImages(group.filter, group.label, group.count);
    console.log(`  Got ${files.length} candidates`);

    for (const file of files) {
      process.stdout.write(`  Analysing: ${file.file_name}... `);
      try {
        const b64 = await downloadToBase64(drive, file.drive_file_id);
        const mediaType = getMediaType(file.mime_type);
        const vision = analyzeWithVision(b64, mediaType, file.file_name, file.current_drive_folder_path || file.current_drive_folder_name);

        results.push({
          group: group.label,
          file_name: file.file_name,
          folder: file.current_drive_folder_path || file.current_drive_folder_name || 'ukjent',
          vision_answer: vision.answer || vision.error,
          cost_usd: vision.cost ?? null,
          error: !!vision.error,
        });

        if (vision.cost) totalCost.usd += vision.cost;
        console.log(`done (cost: $${vision.cost?.toFixed(4) ?? '?'})`);
      } catch (err) {
        console.log(`FAILED: ${err.message?.slice(0, 80)}`);
        results.push({ group: group.label, file_name: file.file_name, error: true, vision_answer: err.message });
      }
    }
  }

  console.log('\n\n=== VISION TEST RESULTS ===');
  console.log(`Total cost: $${totalCost.usd.toFixed(4)}`);
  console.log(`Successful: ${results.filter(r => !r.error).length}/15\n`);

  for (const r of results) {
    console.log(`[${r.group}] ${r.file_name}`);
    console.log(`  Mappe: ${r.folder}`);
    console.log(`  Vision: ${r.vision_answer}`);
    console.log(`  Kostnad: $${r.cost_usd?.toFixed(4) ?? 'N/A'}`);
    console.log();
  }

  // Write JSON report
  const reportPath = '/tmp/vision-test-results.json';
  writeFileSync(reportPath, JSON.stringify({ results, totalCost: totalCost.usd, mechanism: 'claude-cli-json-stdin', model: 'claude-opus-4-7' }, null, 2));
  console.log(`Full report: ${reportPath}`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
