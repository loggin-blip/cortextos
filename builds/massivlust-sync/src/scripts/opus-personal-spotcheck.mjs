/**
 * Opus 500-file spot-check on drive-personal deletion candidates.
 * READ-ONLY — no deletions, no DB writes except result log.
 * Reports: confirmed personal / false positives / unsure.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BATCH_SIZE = 25;
const SAMPLE_SIZE = 500;
const MODEL = 'claude-opus-4-8';
const MODEL_FALLBACK = 'claude-opus-4-7';
const RESULT_FILE = '/tmp/opus-spotcheck-result.json';
const LOG_FILE = '/tmp/opus-spotcheck.log';

const PROJECTS = [
  'Adventveien 15','Adventveien 24','Alvsbyhus','Betsegaten','Birger Aaneruds vei 7',
  'Bortelid sentrumsbygg','Breivikveien 14B','Breivikveien Hus B','Breivikveien tildekking og adkomst',
  'Brevik prosjekt','Brygghus','Bunnsvill og søylefotbeslag','Djupadalskroken 55','Enghave Brygge',
  'Fjordstasjon','Gardeveien 32','Grensen 17/19','Hartmannsvei','Hommersåk Skole','Hunndalen',
  'Hyen Skole','Isfjorden','Jessheim VGS','Kiwi Sandved','Kjærnesstranda 15','Klemmetsrud',
  'Klyngetun Mollandsmarki','Kvernevik Skole','Lavik','Loddefjorden behandlingssenter',
  'Lumber','Lund Torv','Montasje Åfarnes','Mule Sykehjem','Nøkkeland Svømmehall',
  'Norges toppidrettssenter NHS','OSL Gardermoen','PR60049 Kaupanger','Reguleringsarbeid Resaland',
  'Resaland påbygg','Roan barnehage','Royal Rør','Sagatangen','Scannerhall Gardermoen',
  'Selvaag Prosjekt','Slottet Eiendom','Strømsbu sag','Sunndal Barnehage','Telemark bryggeri',
  'Tildekking Hus B','Tillegg Scannerhall Gardermoen','Tredalen speiderleir','Trollhaugen 9B',
  'Tvildemoen','Tvildemoen Opretting','Ullerud Sykehjem','Ulsåk Barnehage',
  'Utbedringsarbeider Tvildemoen','Valle kulturhus','VAM Vest-Agder-Museet',
  'Vennersborgveien 8G','Verksgata 54','Vetleskog AS','Villa Hvidsten','Voss brannstasjon','Vossabia',
];

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
}

function buildPrompt(files) {
  const list = files.map((f, i) => {
    const parts = [`[${i+1}] ${f.file_name}`];
    if (f.mime_type) parts.push(f.mime_type);
    if (f.source_type) parts.push('source:'+f.source_type);
    if (f.gmail_subject) parts.push('emne: "'+f.gmail_subject+'"');
    if (f.gmail_from) parts.push('fra: '+f.gmail_from);
    if (f.current_drive_folder_path) parts.push('mappe: "'+f.current_drive_folder_path+'"');
    else if (f.current_drive_folder_name) parts.push('mappe: "'+f.current_drive_folder_name+'"');
    return parts.join(' | ');
  }).join('\n');

  return `You are doing a DELETION SAFETY CHECK for Massiv Lust AS (Norwegian massivtre/CLT timber construction company).

These ${files.length} files are candidates for PERMANENT DELETION because they were classified as PERSONAL (private) content belonging to the company's CEO (alex@massivlust.no) — NOT business files.

PROJECTS (${PROJECTS.length} active): ${PROJECTS.slice(0,10).join(', ')} ... and ${PROJECTS.length-10} more.

GENUINELY PERSONAL (safe to delete): private photos/videos, personal banking/insurance emails, fitness apps, social media, verification codes, private shopping receipts, family content, private travel, NAV/skatt personal docs.

FALSE POSITIVE (would be WRONG to delete): project drawings, supplier emails, construction photos with project context, CLT/timber specs, subcontractor documents, site photos, HMS docs, invoices/offers to/from Massivlust, employee work documents.

For each file, judge: is this GENUINELY PERSONAL or a potential FALSE POSITIVE (business content)?

FILES:
${list}

Return ONLY a JSON array, one entry per file:
[{"index":1,"verdict":"personal"|"false_positive"|"unsure","confidence":0.0-1.0,"reason":"<10-20 words>"},...]`;
}

function callOpus(prompt, model) {
  const tmpFile = join(tmpdir(), `spotcheck-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt);
  try {
    const raw = execSync(`cat "${tmpFile}" | claude --print --model ${model} --output-format json`,
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf-8' }).trim();
    let text = raw;
    try {
      const env = JSON.parse(raw);
      if (env.is_error) throw new Error(env.result || 'model error');
      if (env.result) text = env.result;
    } catch (e) { if (e.message !== 'model error') text = raw; else throw e; }
    // Extract JSON array
    text = text.replace(/```json\s*/gi,'').replace(/```/g,'').trim();
    const i = text.indexOf('[');
    if (i < 0) return null;
    let sub = text.slice(i), depth = 0, end = -1;
    for (let k = 0; k < sub.length; k++) {
      if (sub[k]==='[') depth++;
      else if (sub[k]===']') { depth--; if (depth===0) { end=k; break; } }
    }
    if (end < 0) return null;
    return JSON.parse(sub.slice(0, end+1));
  } catch (err) {
    log(`CLI error (${model}): ${err.message?.slice(0,100)}`);
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function main() {
  log(`=== OPUS SPOT-CHECK ${SAMPLE_SIZE} drive-personal files ===`);

  // Fetch 500 random drive-personal candidates
  const { data: files, error } = await supabase
    .from('massivlust_unclassified_files')
    .select('id, file_name, mime_type, source_type, gmail_subject, gmail_from, current_drive_folder_name, current_drive_folder_path, v2_suggestions')
    .eq('v2_is_personal', true)
    .eq('source_type', 'drive')
    .eq('v2_model', 'sonnet-4-6')
    .is('drive_destination_id', null)
    .limit(SAMPLE_SIZE * 3); // oversample then random-pick

  if (error) { log('DB error: ' + error.message); process.exit(1); }

  // Random sample
  const shuffled = (files || []).sort(() => Math.random() - 0.5).slice(0, SAMPLE_SIZE);
  log(`Sampled ${shuffled.length} files from ${files?.length} candidates`);

  const results = { personal: [], false_positive: [], unsure: [], errors: [] };
  const falsePositives = [];
  const unsures = [];

  for (let i = 0; i < shuffled.length; i += BATCH_SIZE) {
    const batch = shuffled.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i/BATCH_SIZE)+1;
    const totalBatches = Math.ceil(shuffled.length/BATCH_SIZE);
    log(`Batch ${batchNum}/${totalBatches}: ${batch.length} files`);

    const prompt = buildPrompt(batch);
    let verdicts = callOpus(prompt, MODEL);
    if (!verdicts) {
      log(`  ${MODEL} failed, trying fallback ${MODEL_FALLBACK}`);
      verdicts = callOpus(prompt, MODEL_FALLBACK);
    }

    if (!verdicts || verdicts.length !== batch.length) {
      log(`  Batch failed — marking ${batch.length} as errors`);
      results.errors.push(...batch.map(f => f.file_name));
      await delay(3000);
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const file = batch[j];
      const v = verdicts[j] || { verdict: 'unsure', confidence: 0, reason: 'missing' };
      const verdict = v.verdict || 'unsure';

      if (verdict === 'false_positive') {
        results.false_positive.push(file.file_name);
        falsePositives.push({ file: file.file_name, reason: v.reason, confidence: v.confidence });
        log(`  [FALSE_POS] ${file.file_name} — ${v.reason}`);
      } else if (verdict === 'unsure') {
        results.unsure.push(file.file_name);
        unsures.push({ file: file.file_name, reason: v.reason, confidence: v.confidence });
      } else {
        results.personal.push(file.file_name);
      }
    }

    const pct = Math.round(((i+batch.length)/shuffled.length)*100);
    log(`  Progress: personal=${results.personal.length} fp=${results.false_positive.length} unsure=${results.unsure.length} err=${results.errors.length} | ${pct}%`);
    await delay(500);
  }

  const total = shuffled.length;
  const fpRate = (results.false_positive.length / total * 100).toFixed(1);

  log(`\n=== RESULTS ===`);
  log(`Confirmed personal: ${results.personal.length}/${total} (${(results.personal.length/total*100).toFixed(1)}%)`);
  log(`FALSE POSITIVES: ${results.false_positive.length}/${total} (${fpRate}%)`);
  log(`Unsure: ${results.unsure.length}/${total}`);
  log(`Errors: ${results.errors.length}/${total}`);
  log(`\nFalse positive threshold: ${fpRate < 2 ? 'LOW (<2%) — safe to proceed with deletion' : 'HIGH (≥2%) — full re-verification needed'}`);

  if (falsePositives.length > 0) {
    log('\nFALSE POSITIVES DETAIL:');
    for (const fp of falsePositives) log(`  • ${fp.file} (${fp.confidence.toFixed(2)}) — ${fp.reason}`);
  }
  if (unsures.length > 0) {
    log('\nUNSURE DETAIL (first 20):');
    for (const u of unsures.slice(0,20)) log(`  ? ${u.file} — ${u.reason}`);
  }

  const resultObj = {
    run_at: new Date().toISOString(),
    sample_size: total,
    model: MODEL,
    confirmed_personal: results.personal.length,
    false_positives: results.false_positive.length,
    fp_rate_pct: parseFloat(fpRate),
    unsure: results.unsure.length,
    errors: results.errors.length,
    false_positives_detail: falsePositives,
    unsure_detail: unsures,
  };
  writeFileSync(RESULT_FILE, JSON.stringify(resultObj, null, 2));
  log(`\nResults saved to ${RESULT_FILE}`);

  return resultObj;
}

main().then(r => {
  const fpRate = r.fp_rate_pct;
  const recommendation = fpRate < 2
    ? `FP-rate ${fpRate}% — UNDER 2%. Trygt å gå videre med sletting av de 4785 (minus ${r.false_positives} Opus-flaggede).`
    : `FP-rate ${fpRate}% — OVER 2%. Anbefaler full Opus-verifisering av hele bunken før sletting.`;

  const fpList = r.false_positives_detail.slice(0,15).map(f => `  • ${f.file} — ${f.reason}`).join('\n');
  const unsureList = r.unsure_detail.slice(0,5).map(f => `  ? ${f.file} — ${f.reason}`).join('\n');

  const msg = `OPUS STIKKPRØVE FERDIG (${r.sample_size} filer, ${r.model})

RESULTATER:
✓ Bekreftet privat: ${r.confirmed_personal}/${r.sample_size}
✗ FALSE POSITIVES: ${r.false_positives}/${r.sample_size} (${r.fp_rate_pct}%)
? Usikre: ${r.unsure}/${r.sample_size}
⚠ Feil (batch-feil): ${r.errors}/${r.sample_size}

${recommendation}

${r.false_positives > 0 ? 'FALSE POSITIVES:\n' + fpList : 'Ingen false positives funnet.'}

${r.unsure > 0 ? 'USIKRE (topp 5):\n' + unsureList : ''}

Full logg: /tmp/opus-spotcheck.log
JSON-resultat: /tmp/opus-spotcheck-result.json`;

  try {
    execSync(`cortextos bus send-message bridge normal ${JSON.stringify(msg)} 1781444475569-bridge-v3lkn`, { encoding: 'utf-8' });
    console.log('Bridge report sent.');
  } catch (e) {
    console.error('Bridge send failed:', e.message?.slice(0,80));
  }
}).catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
