/**
 * Phase 1: Sonnet classification, no throttle.
 * 1a: needs_review (258 failed/unlocked)
 * 1b: haiku personal safety-gate (2638)
 * source: 'pipeline_jun13_locate'
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BATCH_SIZE = 50;
const MODEL_1A = 'claude-sonnet-4-6';
const MODEL_1B = 'claude-opus-4-7'; // Opus for personal safety gate — highest quality for deletion gating

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

let quotaExceeded = false;

function buildPrompt(files, isPersonalGate = false) {
  const fileList = files.map((f, i) => {
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

  const gateNote = isPersonalGate
    ? '\nSAFETY GATE: These files were previously marked PERSONAL by an earlier model. Re-evaluate carefully — if there is any business/project signal, reclassify accordingly.\n'
    : '';

  return `Classify ${files.length} files for Massiv Lust AS (massivtre/CLT timber construction company, Norway).${gateNote}

PROJECTS (66 total — ONLY these exact UUIDs):
${PROJECT_LIST_TEXT}

CATEGORIES:
1. PROJECT: matches a specific project → set project_id + confidence
2. BUSINESS_ADMIN: work-related, no specific project. Invoices, HMS, accounting, supplier catalogues, CNC programs, HR docs. project_id=null, is_personal=false
3. PERSONAL: genuinely private ONLY: Skoleplattform, Nordea Liv, Google Payments, Norwegian.no, Vy, private insurance, skatt, NAV, sykmelding, private airline tickets, fitness apps, social media. is_personal=true
4. UNKNOWN: insufficient info. project_id=null, is_personal=false

STRICT UUID RULE: Copy-paste UUID exactly. Never construct or approximate. If no match → project_id: null.

CONFIDENCE: >0.85=certain, 0.50-0.85=likely, <0.50=cannot determine. business_admin=0.90.

CRITICAL:
- alex@massivlust.no = CEO. Emails almost always business.
- .ifc/.pln/.dwg/.anc = project files
- Supplier invoices to/from Massivlust = business_admin or project

CONTACTS: ZEROexpo→Tvildemoen(5b925045), Stolp-Larsson→Adventveien 15, Backe→general contractor, Elise/flo.as→Brygghus/Telemark bryggeri

FOLDER: "mappe:" is strong signal. Project name in path → confidence 0.95.

DISAMBIGUATION:
Breivikveien: 14B(bca855da)=default, Hus B(28d307d0), tildekking(bfabfb3b), Tildekking Hus B(277a69fc)
Scannerhall: Gardermoen(dfbae8cd) vs Tillegg(e5e02d3a) vs OSL(284bcfba)
Tvildemoen: main(5b925045) vs Opretting(4fde9c3f) vs Utbedring(6cbf4a0e)

FILES:
${fileList}

Return ONLY a JSON array:
[{"index":1,"project_id":"<uuid or null>","confidence":<0.0-1.0>,"is_personal":<bool>,"category":"<project|business_admin|personal|unknown>","reason":"<15-30 words>"},...]`;
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
  try { const p = JSON.parse(text.slice(0, end + 1)); if (Array.isArray(p)) return p; } catch {}
  return null;
}

function classifyBatch(prompt, model = MODEL_1A) {
  const tmpFile = join(tmpdir(), `p1-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt);
  try {
    const raw = execSync(`cat "${tmpFile}" | claude --print --model ${model} --output-format json`,
      { timeout: 600000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf-8' }).trim();
    if (!raw) return null;
    let text = raw;
    try {
      const env = JSON.parse(raw);
      if (env.result) text = env.result;
      if (env.is_error) {
        if (String(env.result || '').toLowerCase().match(/quota|rate.limit|usage.limit/)) quotaExceeded = true;
        return null;
      }
    } catch {}
    return extractJsonArray(text);
  } catch (err) {
    if (String(err.message || '').toLowerCase().match(/quota|rate.limit|usage.limit/)) quotaExceeded = true;
    console.error(`  CLI error: ${err.message?.slice(0, 100)}`);
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function categorize(result) {
  const confidence = result.confidence || 0;
  const isPersonal = result.is_personal || false;
  const category = result.category || 'unknown';
  let projectId = result.project_id || null;
  if (projectId && !PROJECT_IDS_SET.has(projectId)) { projectId = null; }
  if (isPersonal || category === 'personal') return { method: 'personal', projectId: null, confidence, isPersonal: true, category: 'personal' };
  if (category === 'business_admin') return { method: 'business_admin', projectId: null, confidence, isPersonal: false, category: 'business_admin' };
  if (confidence >= 0.85 && projectId) return { method: 'auto_classified', projectId, confidence, isPersonal: false, category: 'project' };
  if (confidence >= 0.50 && projectId) return { method: 'suggested', projectId, confidence, isPersonal: false, category: 'project' };
  return { method: 'unknown', projectId: null, confidence, isPersonal: false, category: 'unknown' };
}

async function runPhase(phaseName, claimRpc, claimArgs, isPersonalGate, model = MODEL_1A) {
  console.log(`\n=== ${phaseName} ===`);
  let total = 0, errors = 0;
  const stats = { auto_classified: 0, suggested: 0, business_admin: 0, personal: 0, unknown: 0 };
  const rescuedFromPersonal = [];
  const start = Date.now();

  while (true) {
    if (quotaExceeded) { console.log('Quota exceeded — stopping.'); break; }

    const { data: claimed, error: claimErr } = await supabase.rpc(claimRpc, claimArgs);
    if (claimErr) { console.error(`Claim error: ${claimErr.message}`); await delay(5000); continue; }
    if (!claimed?.length) { console.log('No more files.'); break; }

    console.log(`Batch: ${claimed.length} files`);
    const prompt = buildPrompt(claimed, isPersonalGate);
    let results = classifyBatch(prompt, model);
    if (!results || results.length !== claimed.length) {
      await delay(3000);
      results = classifyBatch(prompt, model);
    }
    if (!results || results.length !== claimed.length) {
      console.error('  Batch failed — releasing');
      for (const f of claimed) await supabase.from('massivlust_unclassified_files').update({ v2_method: null }).eq('id', f.id);
      errors += claimed.length;
      await delay(5000);
      continue;
    }

    const saveRows = [];
    for (let j = 0; j < claimed.length; j++) {
      const file = claimed[j];
      const r = results[j] || { project_id: null, confidence: 0, is_personal: false, category: 'unknown', reason: 'missing' };
      const cat = categorize(r);
      const sk = cat.method in stats ? cat.method : 'unknown';
      stats[sk]++;
      if (isPersonalGate && !cat.isPersonal) rescuedFromPersonal.push({ name: file.file_name, cat: cat.method });
      saveRows.push({ id: file.id, method: cat.method, confidence: cat.confidence, project_id: cat.projectId || null, is_personal: cat.isPersonal, category: cat.category, reasoning: r.reason || null });
    }

    const { error: saveErr } = await supabase.rpc('massivlust_save_classifications', { p_rows: saveRows });
    if (saveErr) { console.error(`  Save error: ${saveErr.message}`); errors += claimed.length; continue; }

    // For personal gate: if Sonnet says NOT personal, update status to needs_review so it can be moved
    if (isPersonalGate) {
      const rescued = saveRows.filter(r => !r.is_personal);
      if (rescued.length) {
        await supabase.from('massivlust_unclassified_files')
          .update({ status: 'needs_review' })
          .in('id', rescued.map(r => r.id));
      }
    }

    total += claimed.length;
    const elapsed = Math.round((Date.now() - start) / 60000);
    console.log(`  ${total} done | ${elapsed}min | auto:${stats.auto_classified} sug:${stats.suggested} admin:${stats.business_admin} pers:${stats.personal} unk:${stats.unknown} err:${errors}`);
  }

  const elapsed = Math.round((Date.now() - start) / 60000);
  console.log(`\n${phaseName} DONE: ${total} in ${elapsed}min, ${errors} errors`);
  if (rescuedFromPersonal.length) {
    console.log(`RESCUED FROM PERSONAL: ${rescuedFromPersonal.length} files`);
    rescuedFromPersonal.forEach(f => console.log(`  ${f.cat}: ${f.name}`));
  }

  await supabase.from('massivlust_sync_runs').insert({
    source: 'pipeline_jun13_locate',
    status: errors === 0 ? 'success' : 'partial',
    started_at: new Date(start).toISOString(),
    ended_at: new Date().toISOString(),
    rows_in: total + errors,
    rows_upserted: total,
    rows_failed: errors,
    org_id: 'massivlust',
    notes: phaseName,
  });

  return { total, errors, rescuedFromPersonal: rescuedFromPersonal.length };
}

async function main() {
  console.log('=== PIPELINE PHASE 1 — no throttle ===');

  const r1a = await runPhase('1a: needs_review (258)', 'massivlust_claim_needs_review_batch',
    { p_size: BATCH_SIZE, p_claimer: 'pipeline-jun13-1a' }, false, MODEL_1A);

  if (quotaExceeded) { console.log('Quota hit during 1a — aborting 1b'); process.exit(0); }

  const r1b = await runPhase('1b: haiku personal gate (2638) [OPUS]', 'massivlust_claim_haiku_personal_batch',
    { p_size: BATCH_SIZE, p_claimer: 'pipeline-jun13-1b' }, true, MODEL_1B);

  console.log(`\n=== PHASE 1 COMPLETE ===`);
  console.log(`1a: ${r1a.total} processed, ${r1a.errors} errors`);
  console.log(`1b: ${r1b.total} processed, ${r1b.errors} errors, ${r1b.rescuedFromPersonal} rescued from personal`);
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
