import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '15');
const PAGE_SIZE = 500;
const MODEL = 'claude-sonnet-4-6';
const MODEL_TAG = 'sonnet-4-6';
const BRIDGE_MSG_ID = process.argv.includes('--bridge-msg') ? process.argv[process.argv.indexOf('--bridge-msg') + 1] : null;
const RESUME = process.argv.includes('--resume');
const TEST_LIMIT = process.argv.includes('--test') ? parseInt(process.argv[process.argv.indexOf('--test') + 1] || '50') : 0;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const PROJECTS = [
  { id: '4c741441-0b17-490c-99b0-2944449e89a0', name: 'Adventveien 15' },
  { id: '34ae8104-74fc-48f9-851d-c9b6ddf6b7ac', name: 'Adventveien 24' },
  { id: 'ff470a1f-51e6-474b-aed3-7bdedf729499', name: 'Alvsbyhus' },
  { id: '906ee2f6-d3ef-4862-a9b8-fad4dd8cace9', name: 'Betsegaten' },
  { id: 'd00623c3-7b86-48d1-a74e-56086edc941a', name: 'Birger Aaneruds vei 7' },
  { id: 'd6367f87-aceb-4278-8322-282f3fc95c5d', name: 'Bortelid sentrumsbygg' },
  { id: 'bca855da-9ad1-438f-97c1-749bbbdc9632', name: 'Breivikveien 14B' },
  { id: '28d307d0-be09-4c87-9ed5-045b0d0af4fc', name: 'Breivikveien Hus B' },
  { id: 'bfabfb3b-b0f9-404d-b96c-965305a5b753', name: 'Breivikveien tildekking og adkomst' },
  { id: '6cca870f-bee1-4444-a295-c940d22de2de', name: 'Brevik prosjekt' },
  { id: '09eedeb7-5c30-4e94-bd7d-c963251c04db', name: 'Brygghus' },
  { id: '0730e74e-7ba2-4870-b84a-c9ea2c1a2af3', name: 'Bunnsvill og søylefotbeslag' },
  { id: '7f2a714e-ce2b-470b-8890-2999e1933996', name: 'Djupadalskroken 55' },
  { id: '107c519f-ce37-416a-bd16-17148e4de657', name: 'Enghave Brygge' },
  { id: '7d0a15bb-8dde-40aa-8772-f4e72c094fa2', name: 'Fjordstasjon' },
  { id: '5ef89fed-1dda-427e-bd85-c893dc8cef39', name: 'Gardeveien 32' },
  { id: '3820e08c-7bd2-4b18-8194-bee62a71c9b0', name: 'Grensen 17/19' },
  { id: '61de61ee-6857-43f7-b3e6-c310ed0e8a49', name: 'Hartmannsvei' },
  { id: 'd479e5c6-4b30-4d11-a185-18772fb23347', name: 'Hommersåk Skole' },
  { id: 'c35431d3-787d-40ec-a443-32b08f70f83a', name: 'Hunndalen' },
  { id: '39bacfe3-a425-46f0-95f9-505ea2abf178', name: 'Hyen Skole' },
  { id: '03483d8d-6b59-41bb-80ac-7f97fa545ac7', name: 'Isfjorden' },
  { id: '6b379c5f-ee7e-4f1e-98f5-dda2180a623c', name: 'Jessheim VGS' },
  { id: 'f8798bf7-86d2-4f72-bfb8-1f6b92b034ba', name: 'Kiwi Sandved' },
  { id: '1817b187-3097-4a31-8bbd-4d7f20db2388', name: 'Kjærnesstranda 15' },
  { id: '0d8fbc0a-38db-48c8-890b-aa4a647a7d57', name: 'Klemmetsrud' },
  { id: 'd75b6496-0264-4f57-b758-4a89ee246bbd', name: 'Klyngetun Mollandsmarki' },
  { id: 'c283df38-58cf-4134-96a0-a7a74fd69b8e', name: 'Kvernevik Skole' },
  { id: '062945cb-50b2-4524-8a9f-a2ced6f72929', name: 'Lavik' },
  { id: '0dd5b8a5-9dc2-41d5-b720-a28be76d4ab8', name: 'Loddefjorden behandlingssenter (P25-077)' },
  { id: '404a17f1-f5a5-4d72-a33e-114edffc74bf', name: 'Lumber' },
  { id: '745a90a7-6c5e-487c-b16c-1c75733d7103', name: 'Lund Torv' },
  { id: '8b349309-ab75-473e-a8a1-99615b0ab92e', name: 'Montasje Åfarnes' },
  { id: '3111ee50-028b-46e4-9a25-e7c25f15431f', name: 'Mule Sykehjem' },
  { id: 'd6d8a4c3-e3e8-40b6-8f3a-58ab4719f8e0', name: 'Nøkkeland Svømmehall' },
  { id: '933f61af-b0ac-4953-be43-d16389bc519f', name: 'Norges toppidrettssenter NHS' },
  { id: '284bcfba-1d6d-4ea5-af8e-cb57ac1b6386', name: 'OSL Gardermoen (P25-095)' },
  { id: '53f7d9b2-3efb-4081-b7e8-d516be2e0efb', name: 'PR60049 Kaupanger' },
  { id: 'aab3dcbc-ad10-423b-8241-66e4c2344043', name: 'Reguleringsarbeid Resaland' },
  { id: '4ce3cd7c-454f-4284-9172-ccedf7cfffb5', name: 'Resaland påbygg.' },
  { id: 'f9de5104-960b-4877-972b-03942dc1f30e', name: 'Roan barnehage' },
  { id: 'b239a30a-8e85-4a7f-a490-430d491f1a4f', name: 'Royal Rør' },
  { id: '8fd520ba-2c71-46a9-9daa-cb8300cb9588', name: 'Sagatangen' },
  { id: 'dfbae8cd-3e0a-4b4d-ab74-185222e2c7a7', name: 'Scannerhall Gardermoen' },
  { id: '2d1e5b29-254c-4333-b7ee-b20c84baed75', name: 'Selvaag Prosjekt' },
  { id: 'dadfe294-a514-47aa-970c-50106f277be9', name: 'Slottet Eiendom' },
  { id: 'a94750e5-32b5-4530-9960-51f9ed940dda', name: 'Strømsbu sag' },
  { id: '6b9ee4df-c0b3-45db-8343-ac5b1291c6f9', name: 'Sunndal Barnehage' },
  { id: 'e29c3999-404f-4c9b-88ed-24624ae5a2c4', name: 'Telemark bryggeri' },
  { id: '277a69fc-a201-4c08-914b-8147bf11aa0c', name: 'Tildekking Hus B' },
  { id: 'e5e02d3a-000e-4e51-a208-7c5a1c5965b5', name: 'Tillegg Scannerhall Gardermoen' },
  { id: 'dcf3e9ed-5690-4cdd-bc4d-3bd92681b4e5', name: 'Tredalen speiderleir (P24-142)' },
  { id: '3524b1ec-e4bf-4210-8058-0c3067ca556f', name: 'Trollhaugen 9B' },
  { id: '5b925045-9299-46b2-bea1-c62491289f3e', name: 'Tvildemoen' },
  { id: '4fde9c3f-cb26-47c7-abdc-0feacc3e36db', name: 'Tvildemoen Opretting' },
  { id: '22cd2558-3ece-4eef-8373-49c636bbbb37', name: 'Ullerud Sykehjem' },
  { id: '82312e64-8988-4ec0-b9fe-e91911d5491b', name: 'Ulsåk Barnehage' },
  { id: '6cbf4a0e-54fa-4daa-8661-96e85360be54', name: 'Utbedringsarbeider Tvildemoen' },
  { id: '2ada20e9-a2be-4e50-a429-a50ccbcf38c2', name: 'Valle kulturhus' },
  { id: 'c6f09263-19d0-4269-bf27-6ee7909458cf', name: 'VAM Vest-Agder-Museet' },
  { id: '81a8a986-760a-4998-b3ca-bec30a785bac', name: 'Vennersborgveien 8G' },
  { id: 'cd0c96aa-dfad-43ff-a34d-8cb7b65d2438', name: 'Verksgata 54' },
  { id: 'be2a8088-0de5-4247-bb7b-3807e0897ca6', name: 'Vetleskog AS' },
  { id: 'b834c88d-5991-406c-ba99-44040b3db1bc', name: 'Villa Hvidsten' },
  { id: '9b72ae12-c35b-405b-8f94-dd212ebda896', name: 'Voss brannstasjon' },
  { id: 'ed735981-1bc6-4af6-b9b5-6737f5c5dce8', name: 'Vossabia' },
];

const PROJECT_LIST_TEXT = PROJECTS.map(p => `${p.id} | ${p.name}`).join('\n');
const PROJECT_IDS_SET = new Set(PROJECTS.map(p => p.id));
const PROJECT_NAME_MAP = new Map(PROJECTS.map(p => [p.id, p.name]));

function buildBatchPrompt(batch) {
  const fileList = batch.map((f, i) => {
    const parts = [`[${i + 1}] ${f.file_name}`];
    if (f.source_type) parts.push(f.source_type);
    if (f.source_user) parts.push(f.source_user);
    if (f.gmail_subject) parts.push(`emne: "${f.gmail_subject}"`);
    if (f.gmail_from) parts.push(`fra: ${f.gmail_from}`);
    if (f.gmail_date) parts.push(`dato: ${new Date(f.gmail_date).toISOString().slice(0, 10)}`);
    if (f.mime_type && !['application/octet-stream', 'application/pdf', 'image/jpeg', 'image/png'].includes(f.mime_type))
      parts.push(f.mime_type);
    const folderCtx = f.current_drive_folder_path || f.current_drive_folder_name;
    if (folderCtx) parts.push(`mappe: "${folderCtx}"`);
    return parts.join(' | ');
  }).join('\n');

  return `Classify ${batch.length} files for Massiv Lust AS (massivtre/CLT timber construction company, Norway).

PROJECTS (66 total — you MUST use ONLY these exact UUIDs):
${PROJECT_LIST_TEXT}

CATEGORIES — each file gets ONE of these:
1. PROJECT: matches a specific project above → set project_id + confidence
2. BUSINESS_ADMIN: work-related but NOT tied to a specific project. Examples: company invoices (faktura/kreditnota), accounting (regnskap), HMS/SHA courses, insurance, supplier catalogues, CNC programs, general business correspondence, equipment orders, HR docs, employee certifications. Set project_id=null, is_personal=false, category="business_admin"
3. PERSONAL: genuinely private items ONLY: Skoleplattform, Nordea Liv, Google Payments, Norwegian.no, Vy, private insurance, personal tax (skatt), NAV, sykmelding, private airline tickets, fitness apps, social media notifications. Set is_personal=true, category="personal"
4. UNKNOWN: insufficient info to classify. Set project_id=null, is_personal=false, category="unknown"

STRICT UUID RULE:
You MUST return ONLY a project_id that appears EXACTLY in the list above. NEVER construct, modify, or approximate a UUID. Copy-paste the UUID character-for-character. If no project matches, return project_id: null.

CONFIDENCE:
- > 0.85 = certain project match (filename/subject/folder clearly references project)
- 0.50–0.85 = likely match based on context clues
- < 0.50 = cannot determine project
- business_admin items: confidence = 0.90 (we're confident about the category even without a project)

CRITICAL — PERSONAL vs BUSINESS:
- alex@massivlust.no = CEO. His emails are ALMOST ALWAYS business. NOT personal.
- Flo AS, Stolp-Larsson AS, HB Byggentreprenør AS, AJ Produkter = customers/suppliers → business
- EcoOnline, HMS-kurs, Samarbeid for Sikkerhet = industry-relevant → business_admin
- Supplier invoices/kreditnota (faktura) TO/FROM Massivlust = business_admin (or project if project is identifiable)
- .ifc/.pln/.dwg/.anc = project-related (BIM/CAD/CNC)
- Technical drawings, montage docs, timber/CLT specs = project-related
- Plan-tegninger (A01, A02, Ø140 etc) = project-related

CONTACT → PROJECT HINTS (sender/contact names that map to projects):
- ZEROexpo, Zero Expo → Tvildemoen (customer/supplier for Tvildemoen projects)
- Tron Meyer → architect, likely Adventveien projects
- Carsten Hovind, carsten@massivlust.no → Massivlust internal, various massivtre projects
- Motek, julie@motek.no → supplier (fasteners/beslag), business_admin unless project mentioned
- Backe, Backe Prosjekt → general contractor, check for specific project reference
- Elise Kristoffersen, elise@flo.as → Flo AS, customer for Brygghus/Telemark bryggeri
- Stolp-Larsson → contact for Adventveien 15

FOLDER PATH CONTEXT:
The "mappe:" field shows the Drive folder path. Use it as a strong signal:
- "Vossabia/05 Sjekklister" → file is IN the Vossabia project folder → confidence 0.95
- "Bortelid Bilder" → Bortelid sentrumsbygg project photos
- "42 Programmer til CNC" or "CNC Programmer" → CNC files, business_admin unless project identifiable
- Numeric-only folders ("01", "05", "12") = month numbers, NOT useful for classification

DISAMBIGUATION — Breivikveien cluster (5 separate projects):
- "Breivikveien 14B" (bca855da) = main project, general correspondence about Breivikveien
- "Breivikveien Hus B" (28d307d0) = ONLY if "Hus B" is explicitly mentioned
- "Breivikveien tildekking og adkomst" (bfabfb3b) = tildekking/presenning/adkomst work
- "Tildekking Hus B" (277a69fc) = tildekking SPECIFICALLY for Hus B
- "Brevik prosjekt" (6cca870f) = different project in Brevik, NOT Breivikveien!
CONFIDENCE for Breivikveien: just "Breivikveien" without specifics → Breivikveien 14B, max conf 0.70. Explicit "Hus B" → 0.85+.

DISAMBIGUATION — Other clusters:
- Scannerhall Gardermoen (dfbae8cd) vs Tillegg Scannerhall (e5e02d3a) vs OSL Gardermoen (284bcfba)
- Tvildemoen (5b925045) vs Tvildemoen Opretting (4fde9c3f) vs Utbedringsarbeider Tvildemoen (6cbf4a0e)
- Resaland påbygg (4ce3cd7c) vs Reguleringsarbeid Resaland (aab3dcbc)
- Use Ulsåk Barnehage (82312e64) for any Ullsåk/Ulsåk reference

FILES:
${fileList}

Return ONLY a JSON array, one object per file in order:
[{"index":1,"project_id":"<exact uuid or null>","confidence":<0.0-1.0>,"is_personal":<true|false>,"category":"<project|business_admin|personal|unknown>","reason":"<15-30 words explaining your reasoning>"},...]`;
}

function extractJsonArray(raw) {
  try { const p = JSON.parse(raw); if (Array.isArray(p)) return p; } catch {}
  let text = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const i = text.indexOf('[');
  if (i < 0) return null;
  text = text.slice(i);
  let depth = 0, end = -1;
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '[') depth++;
    else if (text[k] === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return null;
  text = text.slice(0, end + 1);
  try { const p = JSON.parse(text); if (Array.isArray(p)) return p; } catch {}
  return null;
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const USE_API = !!ANTHROPIC_API_KEY;
const API_MODEL = 'claude-sonnet-4-6-20250514';

async function classifyBatchAPI(batch) {
  const prompt = buildBatchPrompt(batch);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: API_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      console.warn(`  [API 429] Rate limited — waiting 30s`);
      await delay(30000);
      return null;
    }
    console.warn(`  [API ${res.status}] ${body.slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const arr = extractJsonArray(text);
  if (!arr) console.warn(`  [WARN] API: Could not extract array: ${text.slice(0, 150)}...`);
  return arr;
}

function classifyBatchCLI(batch) {
  const prompt = buildBatchPrompt(batch);
  const tmpFile = join(tmpdir(), `sonnet-clf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  writeFileSync(tmpFile, prompt);
  try {
    const raw = execSync(
      `cat "${tmpFile}" | claude --print --model ${MODEL} --output-format json`,
      { timeout: 300000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf-8' }
    ).trim();

    if (!raw) return null;
    let text = raw;
    try {
      const envelope = JSON.parse(raw);
      if (envelope.result) text = envelope.result;
      if (envelope.is_error) { console.warn(`  [WARN] CLI error: ${text.slice(0, 100)}`); return null; }
    } catch {}

    const arr = extractJsonArray(text);
    if (!arr) console.warn(`  [WARN] Could not extract array: ${text.slice(0, 150)}...`);
    return arr;
  } catch (err) {
    const stderr = err.stderr?.toString?.()?.slice(0, 200) || '';
    console.warn(`  [WARN] execSync failed: ${err.message?.slice(0, 100)} stderr: ${stderr}`);
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function classifyBatch(batch) {
  if (USE_API) return classifyBatchAPI(batch);
  return classifyBatchCLI(batch);
}

function categorize(result) {
  const confidence = result.confidence || 0;
  const isPersonal = result.is_personal || false;
  const category = result.category || 'unknown';
  let projectId = result.project_id || null;

  if (projectId && !PROJECT_IDS_SET.has(projectId)) {
    console.warn(`  [UUID-REJECT] Invalid UUID: ${projectId} — setting to null`);
    projectId = null;
  }

  if (isPersonal || category === 'personal') return { method: 'personal', projectId: null, confidence, isPersonal: true, category: 'personal' };
  if (category === 'business_admin') return { method: 'business_admin', projectId: null, confidence, isPersonal: false, category: 'business_admin' };
  if (confidence >= 0.85 && projectId) return { method: 'auto_classified', projectId, confidence, isPersonal: false, category: 'project' };
  if (confidence >= 0.50 && projectId) return { method: 'suggested', projectId, confidence, isPersonal: false, category: 'project' };
  return { method: 'unknown', projectId: null, confidence, isPersonal: false, category: 'unknown' };
}

function sendBridgeMsg(msg) {
  if (!BRIDGE_MSG_ID) return;
  try {
    const escaped = JSON.stringify(msg).replace(/'/g, "'\\''");
    execSync(`cortextos bus send-message bridge normal '${escaped}' ${BRIDGE_MSG_ID}`, { timeout: 10000 });
  } catch {}
}

async function main() {
  console.log('=== SONNET 4.6 RECLASSIFICATION ===');
  console.log(`Batch size: ${BATCH_SIZE} | Resume: ${RESUME} | Test: ${TEST_LIMIT || 'off'}`);
  console.log(`Mode: ${USE_API ? 'Direct API (' + API_MODEL + ')' : 'CLI (claude --print)'}`);
  console.log(`Projects: ${PROJECTS.length}`);

  const { count: totalRaw } = await supabase
    .from('massivlust_unclassified_files')
    .select('*', { count: 'exact', head: true });

  const { count: alreadyDone } = await supabase
    .from('massivlust_unclassified_files')
    .select('*', { count: 'exact', head: true })
    .eq('v2_model', MODEL_TAG);

  const totalFiles = totalRaw - alreadyDone;
  console.log(`Total in DB: ${totalRaw} | Already done: ${alreadyDone} | Remaining: ${totalFiles}`);
  console.log(`Files to process: ${totalFiles}`);
  if (!totalFiles) { console.log('Nothing to process.'); return; }

  const preflight = await classifyBatch([{
    file_name: 'test_preflight.pdf', source_type: 'drive', source_user: 'alex@massivlust.no',
    gmail_subject: null, gmail_from: null, gmail_date: null, mime_type: 'application/pdf',
    current_drive_folder_name: 'Verksgata 54'
  }]);
  if (!preflight || !Array.isArray(preflight)) {
    console.error('PREFLIGHT FAILED — Sonnet returned no valid array. Aborting.');
    return;
  }
  console.log(`Preflight OK: ${JSON.stringify(preflight[0])}`);

  const stats = {
    total: 0, classified: 0, suggested: 0, personal: 0, business_admin: 0, unknown: 0, errors: 0,
    sonnet_calls: 0, uuid_rejects: 0,
    by_project: {},
    examples: { classified: [], suggested: [], personal: [], business_admin: [], unknown: [] },
  };
  const startTime = Date.now();
  let consecutiveEmpty = 0;
  let lastCheckpoint = 0;

  while (true) {
    const { data: page, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('*')
      .neq('v2_model', MODEL_TAG)
      .order('id')
      .limit(PAGE_SIZE);

    if (error) { console.error(`  [DB ERROR] ${error.message}`); break; }
    if (!page?.length) {
      if (++consecutiveEmpty >= 2) break;
      continue;
    }
    consecutiveEmpty = 0;

    for (let b = 0; b < page.length; b += BATCH_SIZE) {
      const batch = page.slice(b, b + BATCH_SIZE);
      let results = await classifyBatch(batch);

      if (!results || results.length !== batch.length) {
        console.warn(`  [RETRY] Got ${results?.length ?? 'null'}, expected ${batch.length}. Retrying...`);
        await delay(3000);
        results = await classifyBatch(batch);
      }

      if (!results || results.length !== batch.length) {
        console.warn(`  [SPLIT] Batch failed 2x. Splitting into individual calls...`);
        for (const file of batch) {
          const single = await classifyBatch([file]);
          const r = single?.[0] || { project_id: null, confidence: 0, is_personal: false, reason: 'failed' };
          stats.sonnet_calls++;
          const cat = categorize(r);
          recordResult(stats, file, r, cat);
          await updateFile(file.id, cat, r.reason);
        }
        continue;
      }

      stats.sonnet_calls++;

      for (let j = 0; j < batch.length; j++) {
        const file = batch[j];
        const r = results[j] || { project_id: null, confidence: 0, is_personal: false, reason: 'missing' };
        const cat = categorize(r);
        recordResult(stats, file, r, cat);
        await updateFile(file.id, cat, r.reason);
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const rate = stats.total / Math.max(1, elapsed);
    const eta = Math.round((totalFiles - stats.total) / Math.max(0.01, rate) / 60);
    console.log(`  ${stats.total}/${totalFiles} (auto:${stats.classified} sug:${stats.suggested} admin:${stats.business_admin} pers:${stats.personal} unk:${stats.unknown} err:${stats.errors}) ~${eta}min left`);

    if (TEST_LIMIT && stats.total >= TEST_LIMIT) {
      console.log(`\n  TEST LIMIT reached (${TEST_LIMIT} files)`);
      break;
    }

    if (stats.total >= 1000 && lastCheckpoint < 1000) {
      checkpoint(stats, totalFiles, startTime, '1K CHECKPOINT');
      lastCheckpoint = 1000;
    }
    if (stats.total >= 5000 && lastCheckpoint < 5000) {
      checkpoint(stats, totalFiles, startTime, '5K CHECKPOINT');
      lastCheckpoint = 5000;
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 60000);
  console.log(`\n=== COMPLETED in ${elapsed} minutes ===`);
  checkpoint(stats, totalFiles, startTime, 'FINAL');

  await supabase.from('massivlust_sync_runs').insert({
    source: 'sonnet_reclassify',
    status: stats.errors === 0 ? 'success' : 'partial',
    started_at: new Date(startTime).toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: totalFiles,
    rows_upserted: stats.total,
    rows_failed: stats.errors,
    org_id: 'massivlust',
  });
}

async function updateFile(id, cat, reason) {
  await supabase.from('massivlust_unclassified_files').update({
    v2_method: cat.method,
    v2_confidence: cat.confidence,
    v2_project_id: cat.projectId,
    v2_is_personal: cat.isPersonal,
    v2_model: MODEL_TAG,
    v2_processed_at: new Date().toISOString(),
    v2_suggestions: { category: cat.category, reasoning: reason || null },
  }).eq('id', id);
}

function recordResult(stats, file, result, cat) {
  stats.total++;
  if (cat.method === 'auto_classified') {
    stats.classified++;
    const pName = PROJECT_NAME_MAP.get(cat.projectId) || 'unknown';
    stats.by_project[pName] = (stats.by_project[pName] || 0) + 1;
  } else if (cat.method === 'suggested') {
    stats.suggested++;
    const pName = PROJECT_NAME_MAP.get(cat.projectId) || 'unknown';
    stats.by_project[pName] = (stats.by_project[pName] || 0) + 1;
  } else {
    stats[cat.method]++;
  }

  if (result.project_id && !PROJECT_IDS_SET.has(result.project_id)) stats.uuid_rejects++;

  const bucket = cat.method === 'auto_classified' ? 'classified' : cat.method;
  if (stats.examples[bucket]?.length < 10)
    stats.examples[bucket].push({
      file: file.file_name, project: PROJECT_NAME_MAP.get(cat.projectId) || result.project_id,
      confidence: cat.confidence, reason: result.reason, category: cat.category,
      user: file.source_user, source: file.source_type, subject: file.gmail_subject,
      folder: file.current_drive_folder_path || file.current_drive_folder_name,
    });
}

function checkpoint(stats, total, startTime, label) {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const rate = stats.total / Math.max(1, elapsed);
  const etaMin = Math.round((total - stats.total) / Math.max(0.01, rate) / 60);
  const costEst = (stats.sonnet_calls * 0.035).toFixed(2);

  const report = {
    status: label,
    processed: stats.total,
    total,
    auto_classified: stats.classified,
    suggested: stats.suggested,
    business_admin: stats.business_admin,
    personal: stats.personal,
    unknown: stats.unknown,
    errors: stats.errors,
    sonnet_calls: stats.sonnet_calls,
    uuid_rejects: stats.uuid_rejects,
    elapsed_seconds: elapsed,
    rate_files_per_sec: Math.round(rate * 100) / 100,
    eta_minutes: etaMin,
    cost_estimate_usd: `~$${costEst}`,
    by_project_top10: Object.entries(stats.by_project).sort((a, b) => b[1] - a[1]).slice(0, 10),
    sample_classified: stats.examples.classified.slice(0, 5),
    sample_business_admin: stats.examples.business_admin.slice(0, 5),
    sample_personal: stats.examples.personal.slice(0, 5),
    sample_unknown: stats.examples.unknown.slice(0, 3),
  };

  console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`);
  console.log(JSON.stringify(report, null, 2));
  sendBridgeMsg(report);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
