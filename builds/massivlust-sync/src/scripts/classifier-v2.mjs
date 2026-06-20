import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { google } from 'googleapis';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = process.argv.includes('--dry-run');
const DRY_RUN_LIMIT = DRY_RUN ? parseInt(process.argv[process.argv.indexOf('--dry-run') + 1] || '50') : 0;
const DUAL_RUN = process.argv.includes('--dual');
const MODE = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'unclassified';
const BRIDGE_MSG_ID = process.argv.includes('--bridge-msg') ? process.argv[process.argv.indexOf('--bridge-msg') + 1] : null;
const RESUME = process.argv.includes('--resume');
const BATCH_SIZE = 30;
const PAGE_SIZE = 500;
const AUTO_PAUSE_THRESHOLD = 500;

const GEMINI_KEY = process.argv.find(a => a.startsWith('AIza')) || process.env.GEMINI_API_KEY;
const GEMINI_EMBED_URL = GEMINI_KEY ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}` : '';
const GEMINI_FLASH_URL = GEMINI_KEY ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}` : '';

if (DUAL_RUN && !GEMINI_KEY) { console.error('Dual run requires GEMINI_API_KEY'); process.exit(1); }

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Hard-skip rules
// ---------------------------------------------------------------------------
const PERSONAL_DOMAINS = [
  'facebook.com', 'facebookmail.com', 'linkedin.com', 'twitter.com', 'instagram.com',
  'spotify.com', 'netflix.com', 'apple.com', 'google.com', 'youtube.com',
  'skatteetaten.no', 'nav.no', 'altinn.no', 'dnb.no', 'nordea.no', 'sbanken.no',
  'sparebanken.no', 'sr-bank.no', 'handelsbanken.no', 'klarna.com', 'vipps.no',
  'posten.no', 'postnord.no', 'bring.no', 'finn.no', 'prisjakt.no',
  'noreply', 'no-reply', 'donotreply', 'mailer-daemon', 'postmaster',
  'newsletter', 'campaign', 'mailchimp.com', 'sendgrid.net', 'hubspot.com',
  'notifications', 'updates@', 'info@', 'support@',
  'info.skoleplattform.no', 'mail.poweroffice.net',
];

const PERSONAL_FILE_PATTERNS = [
  /^\d{8}_\d{6}\.(jpg|jpeg|mp4|mov|heic|png)$/i,
  /^IMG_\d{4}\.(jpg|jpeg|png|heic)$/i,
  /^IMAG\d{4}\.(jpg|jpeg|png)$/i,
  /^DSC[_-]?\d{4,}\.(jpg|jpeg|png|nef|raw)$/i,
  /^P\d{7,}\.(jpg|jpeg)$/i,
  /^Screenshot/i,
  /^\._/,
];

const SKIP_MIME_TYPES = [
  'video/mp4', 'video/quicktime', 'video/x-msvideo',
  'audio/mpeg', 'audio/mp4', 'audio/ogg',
];

function hardSkip(file) {
  const fn = file.file_name || '';
  const mime = file.mime_type || '';
  const from = (file.gmail_from || '').toLowerCase();
  const subject = (file.gmail_subject || '').toLowerCase();

  if (file.source_type === 'drive' && PERSONAL_FILE_PATTERNS.some(p => p.test(fn)))
    return { skip: true, reason: 'personal_photo_pattern' };
  if (fn.startsWith('._')) return { skip: true, reason: 'macos_resource_fork' };
  if (SKIP_MIME_TYPES.some(m => mime.startsWith(m))) return { skip: true, reason: 'media_file' };
  if (from) {
    const domain = from.includes('@') ? from.split('@').pop().replace('>', '') : '';
    if (PERSONAL_DOMAINS.some(pd => domain.includes(pd) || from.includes(pd)))
      return { skip: true, reason: `personal_sender:${domain}` };
  }
  if (subject && /^(your|din|ditt|order|bestilling|kvittering|receipt|password|passord|verify|bekreft)/i.test(subject))
    return { skip: true, reason: 'personal_subject' };
  return { skip: false };
}

// ---------------------------------------------------------------------------
// Gemini embedding (rate-limited) — for dual/dry-run modes
// ---------------------------------------------------------------------------
async function getEmbedding(text) {
  const res = await rateLimitedEmbed(GEMINI_EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 2000) }] } }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.embedding.values;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function loadOrCreateProjectEmbeddings(projects) {
  const { data: existing } = await supabase.from('project_embeddings').select('project_id, embedding');
  const existingMap = new Map((existing || []).map(e => [e.project_id, e.embedding]));
  const embeddings = [];
  for (const p of projects) {
    if (existingMap.has(p.id)) {
      embeddings.push({ ...p, embedding: existingMap.get(p.id) });
      continue;
    }
    const desc = [p.name, p.address || '', `Massivlust AS massivtre montasje prosjekt${p.archived ? ' (arkivert)' : ''}`].filter(Boolean).join('. ');
    const emb = await getEmbedding(desc);
    await supabase.from('project_embeddings').upsert({ project_id: p.id, description: desc, embedding: emb });
    embeddings.push({ ...p, embedding: emb });
    console.log(`  Embedded project: ${p.name}`);
    await delay(100);
  }
  return embeddings;
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
function makeRateLimiter(label, maxPerMin) {
  const log = [];
  return async function limitedFetch(url, opts, retries = 3) {
    const now = Date.now();
    while (log.length > 0 && log[0] < now - 60000) log.shift();
    if (log.length >= maxPerMin) {
      const waitMs = log[0] + 60000 - now + 1500;
      console.log(`  [RATE:${label}] window full (${log.length}/${maxPerMin} in 60s) — waiting ${(waitMs / 1000).toFixed(0)}s`);
      await delay(waitMs);
      while (log.length > 0 && log[0] < Date.now() - 60000) log.shift();
    }
    log.push(Date.now());
    const res = await fetch(url, opts);
    if (res.status === 429) {
      if (retries <= 0) return res;
      const body = await res.text();
      const retryMatch = body.match(/retry in ([\d.]+)s/i);
      const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 5 : 65;
      console.warn(`  [RATE:${label}] 429 — server says wait ${waitSec - 5}s, sleeping ${waitSec}s (retries left: ${retries - 1})`);
      await delay(waitSec * 1000);
      while (log.length > 0 && log[0] < Date.now() - 60000) log.shift();
      return limitedFetch(url, opts, retries - 1);
    }
    return res;
  };
}
const rateLimitedEmbed = makeRateLimiter('embed', 15);
const rateLimitedFlash = makeRateLimiter('flash', 15);

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------
function extractJson(raw) {
  try { return JSON.parse(raw); } catch {}
  let text = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const braceIdx = text.indexOf('{');
  if (braceIdx > 0) text = text.slice(braceIdx);
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace >= 0) text = text.slice(0, lastBrace + 1);
  return JSON.parse(text);
}

function extractJsonArray(raw) {
  try { const p = JSON.parse(raw); if (Array.isArray(p)) return p; } catch {}
  // Strip all code fences and surrounding text — find the JSON array between [ and ]
  let text = raw;
  // Remove code fence markers anywhere in the text
  text = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const i = text.indexOf('[');
  if (i < 0) return null;
  text = text.slice(i);
  // Find matching closing bracket by counting depth
  let depth = 0;
  let end = -1;
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '[') depth++;
    else if (text[k] === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return null;
  text = text.slice(0, end + 1);
  try { const p = JSON.parse(text); if (Array.isArray(p)) return p; } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Single-file classification prompts (for dual/dry-run)
// ---------------------------------------------------------------------------
function buildClassifyPrompt(file, topCandidates) {
  const signals = [];
  signals.push(`Filnavn: ${file.file_name}`);
  signals.push(`Type: ${file.mime_type || 'ukjent'}`);
  signals.push(`Kilde: ${file.source_type}`);
  signals.push(`Bruker: ${file.source_user}`);
  if (file.gmail_subject) signals.push(`E-post emne: ${file.gmail_subject}`);
  if (file.gmail_from) signals.push(`E-post fra: ${file.gmail_from}`);
  if (file.gmail_date) signals.push(`E-post dato: ${file.gmail_date}`);

  const candidateList = topCandidates.map((c, i) =>
    `${i + 1}. ${c.name} (ID: ${c.id}, adresse: ${c.address || 'ukjent'}, similarity: ${c.similarity.toFixed(3)})`
  ).join('\n');

  return `Classify this file for Massiv Lust AS (timber construction company).

File:
${signals.join('\n')}

Project candidates:
${candidateList}

Return ONLY a JSON object:
{"project_id":"<uuid or null>","project_name":"<name or null>","confidence":<0.0-1.0>,"is_personal":<true/false>,"reason":"<brief>"}

Rules:
- confidence > 0.85 = certain match to a project above
- 0.5-0.85 = possible match
- < 0.5 = unknown
- is_personal=true for private photos, personal docs, tax, bank, social media, airline tickets, sick leave (sykmelding), NAV correspondence
- Files related to timber (massivtre), CLT, construction, montage are NOT personal
- .ifc/.pln/.dwg = project-related (BIM/CAD)
- Invoices (faktura) from suppliers TO Massivlust = likely project-related
- Sick leave certificates, personal HR docs = personal`;
}

async function classifyWithGemini(file, topCandidates) {
  const prompt = buildClassifyPrompt(file, topCandidates);
  const res = await rateLimitedFlash(GEMINI_FLASH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1, maxOutputTokens: 200,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            project_id: { type: 'STRING', nullable: true },
            project_name: { type: 'STRING', nullable: true },
            confidence: { type: 'NUMBER' },
            is_personal: { type: 'BOOLEAN' },
            reason: { type: 'STRING' },
          },
          required: ['confidence', 'is_personal', 'reason'],
        },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini Flash failed: ${res.status} ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  try { return extractJson(raw); } catch {
    console.warn(`  [WARN:gemini] Parse failed: ${raw.slice(0, 80)}`);
    return { project_id: null, confidence: 0, is_personal: false, reason: 'parse_error' };
  }
}

function classifyWithHaiku(file, topCandidates) {
  const prompt = buildClassifyPrompt(file, topCandidates);
  try {
    const result = execSync(
      `echo ${JSON.stringify(prompt)} | claude --print --model claude-haiku-4-5-20251001 --output-format json 2>/dev/null`,
      { timeout: 30000, maxBuffer: 1024 * 64 }
    ).toString().trim();
    const parsed = JSON.parse(result);
    const text = parsed.result || result;
    return extractJson(text);
  } catch (err) {
    console.warn(`  [WARN:haiku] ${err.message?.slice(0, 80)}`);
    return { project_id: null, confidence: 0, is_personal: false, reason: 'haiku_error' };
  }
}

// ---------------------------------------------------------------------------
// Batch classification (for full run — no embeddings needed)
// ---------------------------------------------------------------------------
function buildBatchPrompt(batch, projects) {
  const projectList = projects.map((p, i) =>
    `${i + 1}. ${p.name} (ID: ${p.id}${p.address ? ', ' + p.address : ''}${p.archived ? ' ARKIVERT' : ''})`
  ).join('\n');

  const fileList = batch.map((f, i) => {
    const parts = [`[${i + 1}] ${f.file_name}`];
    if (f.source_type) parts.push(f.source_type);
    if (f.source_user) parts.push(f.source_user);
    if (f.gmail_subject) parts.push(`emne: "${f.gmail_subject}"`);
    if (f.gmail_from) parts.push(`fra: ${f.gmail_from}`);
    if (f.mime_type && !['application/octet-stream', 'application/pdf'].includes(f.mime_type))
      parts.push(f.mime_type);
    return parts.join(' | ');
  }).join('\n');

  return `Classify ${batch.length} files for Massiv Lust AS (massivtre/CLT timber construction, Norway).

PROJECTS:
${projectList}

FILES:
${fileList}

Return ONLY a JSON array, one object per file in order:
[{"index":1,"project_id":"<uuid or null>","confidence":<0.0-1.0>,"is_personal":<true|false>,"reason":"<10-20 words>"},...]

Rules:
- confidence > 0.85 = certain project match (filename/subject clearly references project name or address)
- 0.5-0.85 = likely match based on context clues
- < 0.5 = cannot determine project
- is_personal=true ONLY for: private photos, tax (skatt), bank, sick leave (sykmelding), NAV, personal insurance, airline tickets, social media
- Supplier invoices (faktura) TO Massivlust = project-related, NOT personal
- .ifc/.pln/.dwg = project-related (BIM/CAD)
- Technical drawings, montage docs, timber/CLT specs = project-related
- When work-related but no project match: project_id=null, confidence=0.3, is_personal=false`;
}

function classifyBatchWithHaiku(batch, projects) {
  const prompt = buildBatchPrompt(batch, projects);
  const tmpFile = join(tmpdir(), `clf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  writeFileSync(tmpFile, prompt);
  try {
    const raw = execSync(
      `cat "${tmpFile}" | claude --print --model claude-haiku-4-5-20251001 --output-format json`,
      { timeout: 180000, maxBuffer: 1024 * 1024, encoding: 'utf-8' }
    ).trim();

    if (!raw) { console.warn('  [WARN:batch] Empty response from claude CLI'); return null; }

    let text = raw;
    try {
      const envelope = JSON.parse(raw);
      if (envelope.result) text = envelope.result;
      if (envelope.is_error) { console.warn(`  [WARN:batch] CLI error: ${text.slice(0, 100)}`); return null; }
    } catch {}

    const arr = extractJsonArray(text);
    if (!arr) console.warn(`  [WARN:batch] Could not extract array from: ${text.slice(0, 150)}...`);
    return arr;
  } catch (err) {
    const stderr = err.stderr?.toString?.()?.slice(0, 200) || '';
    console.warn(`  [WARN:batch] execSync failed: ${err.message?.slice(0, 100)} stderr: ${stderr}`);
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------
function sendProgressPing(stats, total, startTime) {
  const elapsed = (Date.now() - startTime) / 1000;
  const done = stats.total;
  const rate = done / Math.max(1, elapsed);
  const etaMin = Math.round((total - done) / rate / 60);

  const ping = {
    done, total,
    hard_skipped: stats.hard_skipped,
    auto_classified: stats.classified,
    suggested: stats.suggested,
    personal: stats.personal,
    unknown: stats.unknown,
    errors: stats.errors,
    haiku_batches: stats.haiku_calls,
    cost_so_far_usd: `$${(stats.haiku_calls * 0.008).toFixed(2)}`,
    eta: `~${etaMin}min`,
  };

  console.log(`\n  === PING ${done}/${total} === ${JSON.stringify(ping)}\n`);

  if (BRIDGE_MSG_ID) {
    try {
      const escaped = JSON.stringify(ping).replace(/'/g, "'\\''");
      execSync(`cortextos bus send-message bridge normal '${escaped}' ${BRIDGE_MSG_ID}`, { timeout: 10000 });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Categorize result
// ---------------------------------------------------------------------------
function categorize(result) {
  const confidence = result.confidence || 0;
  const isPersonal = result.is_personal || false;
  if (isPersonal) return { method: 'personal', projectId: null, confidence, isPersonal };
  if (confidence >= 0.85 && result.project_id) return { method: 'auto_classified', projectId: result.project_id, confidence, isPersonal };
  if (confidence >= 0.5 && result.project_id) return { method: 'suggested', projectId: result.project_id, confidence, isPersonal };
  return { method: 'unknown', projectId: null, confidence, isPersonal };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
function makeStats(model) {
  return {
    model, total: 0, hard_skipped: 0, classified: 0, suggested: 0, personal: 0, unknown: 0, errors: 0,
    by_method: {}, by_project: {},
    examples: { hard_skip: [], classified: [], suggested: [], personal: [], unknown: [] },
    gemini_calls: 0, haiku_calls: 0, embed_calls: 0,
  };
}

async function embedAndRank(file, projectEmbeddings, stats) {
  const signalParts = [file.file_name];
  if (file.gmail_subject) signalParts.push(file.gmail_subject);
  if (file.gmail_from) signalParts.push(file.gmail_from);
  const fileEmbedding = await getEmbedding(signalParts.join(' '));
  stats.embed_calls++;
  const candidates = projectEmbeddings.map(p => ({
    ...p, similarity: cosineSimilarity(fileEmbedding, p.embedding),
  })).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  return { candidates };
}

function recordSkip(stats, file, skip) {
  stats.total++;
  stats.hard_skipped++;
  const key = `skip:${skip.reason.split(':')[0]}`;
  stats.by_method[key] = (stats.by_method[key] || 0) + 1;
  if (stats.examples.hard_skip.length < 5)
    stats.examples.hard_skip.push({ file: file.file_name, reason: skip.reason, user: file.source_user });
}

function recordResult(stats, file, result, cat) {
  stats.total++;
  stats[cat.method === 'auto_classified' ? 'classified' : cat.method]++;
  stats.by_method[cat.method] = (stats.by_method[cat.method] || 0) + 1;
  if (cat.method === 'auto_classified') {
    const pName = result.project_name || result.reason?.slice(0, 30) || 'unknown';
    stats.by_project[pName] = (stats.by_project[pName] || 0) + 1;
  }
  const bucket = cat.method === 'auto_classified' ? 'classified' : cat.method;
  if (stats.examples[bucket]?.length < 5)
    stats.examples[bucket].push({
      file: file.file_name, project: result.project_name || result.project_id,
      confidence: cat.confidence, reason: result.reason,
      user: file.source_user, source: file.source_type, subject: file.gmail_subject,
    });
}

function buildSummary(stats) {
  return {
    model: stats.model, total: stats.total, hard_skipped: stats.hard_skipped,
    auto_classified: stats.classified, suggested: stats.suggested,
    personal: stats.personal, unknown: stats.unknown, errors: stats.errors,
    gemini_calls: stats.gemini_calls, haiku_calls: stats.haiku_calls, embed_calls: stats.embed_calls,
  };
}

function printReport(stats) {
  const report = { summary: buildSummary(stats), by_method: stats.by_method, by_project: stats.by_project, examples: stats.examples };
  console.log('\n' + '='.repeat(60));
  console.log(`CLASSIFIER V2 REPORT (${stats.model})`);
  console.log('='.repeat(60));
  console.log(JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------------------
// Full batch run — Haiku, no per-file embeddings
// ---------------------------------------------------------------------------
async function fullRunBatch(projects) {
  console.log('\n=== FULL BATCH RUN (Haiku, batch mode) ===\n');

  const { count } = await supabase
    .from('massivlust_unclassified_files')
    .select('*', { count: 'exact', head: true })
    .is('v2_method', null);

  const totalFiles = count || 0;
  console.log(`Unprocessed: ${totalFiles}`);
  if (!totalFiles) { console.log('Nothing to process.'); return; }

  // Preflight: test Haiku batch with 3 files
  console.log('\n--- Preflight test (3 files) ---');
  const { data: testFiles } = await supabase
    .from('massivlust_unclassified_files')
    .select('*').is('v2_method', null).limit(3);

  if (testFiles?.length) {
    const nonSkipped = testFiles.filter(f => !hardSkip(f).skip);
    if (nonSkipped.length > 0) {
      const testResult = classifyBatchWithHaiku(nonSkipped, projects);
      if (!testResult || !Array.isArray(testResult)) {
        console.error('PREFLIGHT FAILED — Haiku batch returned no valid array. Aborting.');
        return;
      }
      console.log(`Preflight OK: ${testResult.length} results for ${nonSkipped.length} files`);
      console.log(`  Sample: ${JSON.stringify(testResult[0])}`);
    } else {
      console.log('Preflight: all 3 test files were hard-skipped, skipping Haiku test');
    }
  }

  console.log('\n--- Starting full run ---\n');

  const stats = makeStats('haiku');
  const startTime = Date.now();
  let lastPingAt = 0;
  let consecutiveEmpty = 0;

  while (true) {
    const { data: page, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('*')
      .is('v2_method', null)
      .order('id')
      .limit(PAGE_SIZE);

    if (error) { console.error(`  [DB ERROR] ${error.message}`); break; }
    if (!page?.length) {
      if (++consecutiveEmpty >= 2) break;
      continue;
    }
    consecutiveEmpty = 0;

    // Hard-skip pass — batch DB update
    const toProcess = [];
    const skipIds = { personal: [], rule: [] };

    for (const file of page) {
      const skip = hardSkip(file);
      if (skip.skip) {
        recordSkip(stats, file, skip);
        const bucket = skip.reason.includes('personal') ? 'personal' : 'rule';
        skipIds[bucket].push(file.id);
      } else {
        toProcess.push(file);
      }
    }

    // Batch update hard-skips
    const now = new Date().toISOString();
    if (skipIds.personal.length) {
      await supabase.from('massivlust_unclassified_files')
        .update({ v2_method: 'hard_skip', v2_confidence: 0, v2_is_personal: true, v2_model: 'rule', v2_processed_at: now })
        .in('id', skipIds.personal);
    }
    if (skipIds.rule.length) {
      await supabase.from('massivlust_unclassified_files')
        .update({ v2_method: 'hard_skip', v2_confidence: 0, v2_is_personal: false, v2_model: 'rule', v2_processed_at: now })
        .in('id', skipIds.rule);
    }

    // Classify in batches
    for (let b = 0; b < toProcess.length; b += BATCH_SIZE) {
      const batch = toProcess.slice(b, b + BATCH_SIZE);
      let results = classifyBatchWithHaiku(batch, projects);

      if (!results || results.length !== batch.length) {
        console.warn(`  [RETRY] Batch: got ${results?.length ?? 'null'}, expected ${batch.length}. Retrying...`);
        await delay(2000);
        results = classifyBatchWithHaiku(batch, projects);
      }

      if (!results || results.length !== batch.length) {
        console.warn(`  [INDIVIDUAL] Batch failed 2x. Processing ${batch.length} individually...`);
        for (const file of batch) {
          const single = classifyBatchWithHaiku([file], projects);
          const result = single?.[0] || { project_id: null, confidence: 0, is_personal: false, reason: 'failed' };
          stats.haiku_calls++;
          const cat = categorize(result);
          recordResult(stats, file, result, cat);
          await supabase.from('massivlust_unclassified_files').update({
            v2_method: cat.method, v2_confidence: cat.confidence, v2_project_id: cat.projectId,
            v2_is_personal: cat.isPersonal, v2_model: 'haiku', v2_processed_at: new Date().toISOString(),
          }).eq('id', file.id);
        }
        continue;
      }

      stats.haiku_calls++;

      for (let j = 0; j < batch.length; j++) {
        const file = batch[j];
        const r = results[j] || { project_id: null, confidence: 0, is_personal: false, reason: 'missing' };
        const cat = categorize(r);
        recordResult(stats, file, r, cat);

        await supabase.from('massivlust_unclassified_files').update({
          v2_method: cat.method, v2_confidence: cat.confidence, v2_project_id: cat.projectId,
          v2_is_personal: cat.isPersonal, v2_model: 'haiku', v2_processed_at: new Date().toISOString(),
        }).eq('id', file.id);
      }
    }

    console.log(`  ... ${stats.total}/${totalFiles} processed (auto:${stats.classified} sug:${stats.suggested} pers:${stats.personal} unk:${stats.unknown} skip:${stats.hard_skipped} err:${stats.errors})`);

    // Pause checkpoint: stop after 500 auto-classified, send sample for review
    if (!RESUME && stats.classified >= AUTO_PAUSE_THRESHOLD) {
      console.log(`\n  === PAUSE: ${stats.classified} auto-classified reached (threshold: ${AUTO_PAUSE_THRESHOLD}) ===`);
      console.log('  Querying 30 random auto-classified samples...');

      const { data: samples } = await supabase
        .from('massivlust_unclassified_files')
        .select('file_name, gmail_subject, gmail_from, source_user, v2_project_id, v2_confidence, v2_method')
        .eq('v2_method', 'auto_classified')
        .order('v2_processed_at', { ascending: false })
        .limit(100);

      // Pick 30 random from the 100 most recent
      const shuffled = (samples || []).sort(() => Math.random() - 0.5).slice(0, 30);

      // Resolve project names
      const projectMap = new Map(projects.map(p => [p.id, p.name]));
      const sampleRows = shuffled.map(s => ({
        file: s.file_name,
        subject: s.gmail_subject || '-',
        from: s.gmail_from || s.source_user,
        project: projectMap.get(s.v2_project_id) || s.v2_project_id,
        confidence: s.v2_confidence,
      }));

      const pauseReport = {
        status: 'PAUSED_FOR_REVIEW',
        auto_classified_so_far: stats.classified,
        total_processed: stats.total,
        sample_count: sampleRows.length,
        samples: sampleRows,
        resume_command: 'node src/scripts/classifier-v2.mjs --bridge-msg <id> --resume',
        stats: buildSummary(stats),
      };

      console.log('\n  PAUSE REPORT:');
      console.log(JSON.stringify(pauseReport, null, 2));

      if (BRIDGE_MSG_ID) {
        const msg = JSON.stringify(pauseReport).replace(/'/g, "'\\''");
        try { execSync(`cortextos bus send-message bridge normal '${msg}' ${BRIDGE_MSG_ID}`, { timeout: 10000 }); } catch {}
      }

      console.log('\n  Exiting. Restart with --resume after approval.');
      return stats;
    }

    if (stats.total - lastPingAt >= 2000) {
      sendProgressPing(stats, totalFiles, startTime);
      lastPingAt = stats.total - (stats.total % 2000);
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 60000);
  console.log(`\n  COMPLETED in ${elapsed} minutes`);
  printReport(stats);

  if (BRIDGE_MSG_ID) {
    const fin = JSON.stringify({
      status: 'PHASE_1_COMPLETE', ...buildSummary(stats),
      elapsed_minutes: elapsed,
      cost_estimate_usd: `$${(stats.haiku_calls * 0.008).toFixed(2)}`,
    }).replace(/'/g, "'\\''");
    try { execSync(`cortextos bus send-message bridge normal '${fin}' ${BRIDGE_MSG_ID}`, { timeout: 10000 }); } catch {}
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Single-model dry-run processing (existing flow with embeddings)
// ---------------------------------------------------------------------------
async function processFiles(files, projectEmbeddings, model) {
  console.log(`\nProcessing ${files.length} files with ${model}...`);
  const stats = makeStats(model);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const skip = hardSkip(file);
      if (skip.skip) { recordSkip(stats, file, skip); continue; }

      const { candidates } = await embedAndRank(file, projectEmbeddings, stats);
      const result = model === 'gemini' ? await classifyWithGemini(file, candidates) : classifyWithHaiku(file, candidates);
      if (model === 'gemini') stats.gemini_calls++;
      if (model === 'haiku') stats.haiku_calls++;

      const cat = categorize(result);
      recordResult(stats, file, result, cat);

      await supabase.from('massivlust_unclassified_files').update({
        v2_method: cat.method, v2_confidence: cat.confidence, v2_project_id: cat.projectId,
        v2_is_personal: cat.isPersonal, v2_model: model, v2_processed_at: new Date().toISOString(),
        v2_suggestions: JSON.stringify(candidates.map(c => ({ project_id: c.id, name: c.name, similarity: Math.round(c.similarity * 1000) / 1000 }))),
      }).eq('id', file.id);

      if ((i + 1) % 10 === 0) console.log(`  ... ${i + 1}/${files.length} processed`);
    } catch (err) {
      stats.errors++;
      console.error(`  [ERROR] ${file.file_name}: ${err.message}`);
    }
  }
  printReport(stats);
  return stats;
}

// ---------------------------------------------------------------------------
// Dual-model dry-run (Gemini + Haiku comparison)
// ---------------------------------------------------------------------------
async function dualProcessFiles(files, projectEmbeddings) {
  console.log(`\n=== DUAL DRY-RUN: Gemini Flash vs Claude Haiku on ${files.length} files ===\n`);

  const geminiStats = makeStats('gemini');
  const haikuStats = makeStats('haiku');
  const comparisons = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const skip = hardSkip(file);
      if (skip.skip) { recordSkip(geminiStats, file, skip); recordSkip(haikuStats, file, skip); continue; }

      const { candidates } = await embedAndRank(file, projectEmbeddings, geminiStats);

      let geminiResult;
      try { geminiResult = await classifyWithGemini(file, candidates); geminiStats.gemini_calls++; }
      catch (err) { geminiResult = { project_id: null, confidence: 0, is_personal: false, reason: `error:${err.message.slice(0, 50)}` }; geminiStats.errors++; }

      const haikuResult = classifyWithHaiku(file, candidates);
      haikuStats.haiku_calls++;

      const geminiCat = categorize(geminiResult);
      const haikuCat = categorize(haikuResult);
      recordResult(geminiStats, file, geminiResult, geminiCat);
      recordResult(haikuStats, file, haikuResult, haikuCat);

      const agree = geminiCat.method === haikuCat.method &&
        (geminiCat.projectId === haikuCat.projectId || (!geminiCat.projectId && !haikuCat.projectId));
      comparisons.push({
        file: file.file_name, user: file.source_user, source: file.source_type, subject: file.gmail_subject,
        gemini: { method: geminiCat.method, project: geminiResult.project_name, confidence: geminiCat.confidence, reason: geminiResult.reason, is_personal: geminiResult.is_personal },
        haiku: { method: haikuCat.method, project: haikuResult.project_name, confidence: haikuCat.confidence, reason: haikuResult.reason, is_personal: haikuResult.is_personal },
        agree,
      });

      if ((i + 1) % 10 === 0) console.log(`  ... ${i + 1}/${files.length} processed (both models)`);
    } catch (err) { geminiStats.errors++; haikuStats.errors++; console.error(`  [ERROR] ${file.file_name}: ${err.message}`); }
  }

  const disagreements = comparisons.filter(c => !c.agree);
  const agreementRate = comparisons.length > 0 ? ((comparisons.length - disagreements.length) / comparisons.length * 100).toFixed(1) : 0;
  const report = {
    dual_run: true, agreement_rate: `${agreementRate}%`, total_compared: comparisons.length, disagreements_count: disagreements.length,
    gemini_summary: buildSummary(geminiStats), haiku_summary: buildSummary(haikuStats),
    disagreements: disagreements.slice(0, 15),
    cost_estimate: {
      gemini_flash_22k: `$${(geminiStats.gemini_calls > 0 ? (22242 / geminiStats.total * geminiStats.gemini_calls * 0.00015) : 0).toFixed(2)}`,
      claude_haiku_22k: `$${(haikuStats.haiku_calls > 0 ? (22242 / haikuStats.total * haikuStats.haiku_calls * 0.0004) : 0).toFixed(2)}`,
      embeddings_22k: `$${(22242 * 0.000002).toFixed(2)}`,
    },
    recommendation: '',
  };
  const geminiAutoRate = geminiStats.classified / Math.max(1, geminiStats.total - geminiStats.hard_skipped);
  const haikuAutoRate = haikuStats.classified / Math.max(1, haikuStats.total - haikuStats.hard_skipped);
  if (haikuAutoRate > geminiAutoRate * 1.2) report.recommendation = `Haiku wins: ${(haikuAutoRate * 100).toFixed(0)}% auto vs Gemini ${(geminiAutoRate * 100).toFixed(0)}%.`;
  else if (geminiAutoRate >= haikuAutoRate * 0.9) report.recommendation = `Gemini matches Haiku at lower cost.`;
  else report.recommendation = `Mixed — review disagreements.`;

  console.log('\n' + '='.repeat(60));
  console.log('DUAL DRY-RUN COMPARISON REPORT');
  console.log('='.repeat(60));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------------------
// Audit mode — scan Drive project folders, verify file placement with Haiku
// ---------------------------------------------------------------------------

function makeDriveClient() {
  const saKeyPath = process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json';
  const saKey = JSON.parse(readFileSync(saKeyPath, 'utf8'));
  const auth = new google.auth.JWT(saKey.client_email, null, saKey.private_key,
    ['https://www.googleapis.com/auth/drive.readonly'], 'alex@massivlust.no');
  return google.drive({ version: 'v3', auth });
}

async function listFilesInFolder(drive, folderId, projectId, projectName) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, parents)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of res.data.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const sub = await listFilesInFolder(drive, f.id, projectId, projectName);
        files.push(...sub);
      } else {
        files.push({
          drive_file_id: f.id,
          file_name: f.name,
          mime_type: f.mimeType,
          current_drive_folder_id: folderId,
          current_project_id: projectId,
          current_project_name: projectName,
        });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

function buildAuditBatchPrompt(batch, projects) {
  const projectList = projects.map((p, i) =>
    `${i + 1}. ${p.name} (ID: ${p.id}${p.address ? ', ' + p.address : ''}${p.archived ? ' ARKIVERT' : ''})`
  ).join('\n');

  const fileList = batch.map((f, i) => {
    const parts = [`[${i + 1}] ${f.file_name}`];
    parts.push(`currently in: ${f.current_project_name}`);
    if (f.mime_type && !['application/octet-stream', 'application/pdf'].includes(f.mime_type))
      parts.push(f.mime_type);
    return parts.join(' | ');
  }).join('\n');

  return `AUDIT: Verify file placement for Massiv Lust AS (massivtre/CLT timber construction, Norway).
Each file is ALREADY sorted into a project folder. Your job: does each file belong in its current project?

PROJECTS:
${projectList}

FILES (with current project):
${fileList}

Return ONLY a JSON array, one object per file in order:
[{"index":1,"correct_project_id":"<uuid or null>","confidence":<0.0-1.0>,"matches_current":<true|false>,"reason":"<10-20 words>"},...]

Rules:
- matches_current=true if the file likely belongs in its current project
- matches_current=false if the file clearly belongs in a DIFFERENT project (set correct_project_id to that project)
- If filename is too generic to verify (IMG_xxxx, scan001.pdf), set confidence < 0.3, matches_current=true
- confidence > 0.7 = strong evidence for/against placement
- 0.3-0.7 = partial evidence
- < 0.3 = insufficient info to judge`;
}

async function auditRunBatch(projects) {
  console.log('\n=== AUDIT MODE (Haiku, verify existing placements) ===\n');

  const drive = makeDriveClient();

  console.log('Scanning Drive project folders...');
  let allFiles = [];
  for (const p of projects) {
    try {
      const files = await listFilesInFolder(drive, p.drive_root_folder_id, p.id, p.name);
      console.log(`  ${p.name}: ${files.length} files`);
      allFiles.push(...files);
    } catch (err) {
      console.warn(`  [WARN] ${p.name}: ${err.message?.slice(0, 80)}`);
    }
  }

  // Resume: skip files already audited
  if (RESUME) {
    const { data: existing } = await supabase.from('massivlust_audit_moves').select('file_name');
    const done = new Set((existing || []).map(e => e.file_name));
    const before = allFiles.length;
    allFiles = allFiles.filter(f => !done.has(f.file_name));
    console.log(`Resume: ${before} total, ${done.size} already audited, ${allFiles.length} remaining`);
  }

  const totalFiles = allFiles.length;
  console.log(`\nTotal files to audit: ${totalFiles}`);
  if (!totalFiles) { console.log('Nothing to audit.'); return; }

  const stats = {
    total: 0, verified: 0, suspect: 0, unsure: 0, errors: 0,
    haiku_calls: 0,
    suspects: [],
    by_project: {},
  };
  const startTime = Date.now();
  let lastPingAt = 0;

  for (let offset = 0; offset < allFiles.length; offset += BATCH_SIZE) {
    const batch = allFiles.slice(offset, offset + BATCH_SIZE);

    const prompt = buildAuditBatchPrompt(batch, projects);
    const tmpFile = join(tmpdir(), `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
    writeFileSync(tmpFile, prompt);
    let results = null;
    try {
      const raw = execSync(
        `cat "${tmpFile}" | claude --print --model claude-haiku-4-5-20251001 --output-format json`,
        { timeout: 300000, maxBuffer: 1024 * 1024, encoding: 'utf-8' }
      ).trim();
      let text = raw;
      try { const env = JSON.parse(raw); if (env.result) text = env.result; if (env.is_error) text = null; } catch {}
      if (text) results = extractJsonArray(text);
    } catch (err) {
      console.warn(`  [WARN:audit] batch failed: ${err.message?.slice(0, 100)}`);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }

    if (!results || results.length !== batch.length) {
      if (results?.length !== batch.length) {
        console.warn(`  [RETRY] Audit batch: got ${results?.length ?? 'null'}, expected ${batch.length}. Retrying...`);
        await delay(2000);
      }
      const tmpFile2 = join(tmpdir(), `audit-${Date.now()}-retry.txt`);
      writeFileSync(tmpFile2, prompt);
      try {
        const raw2 = execSync(
          `cat "${tmpFile2}" | claude --print --model claude-haiku-4-5-20251001 --output-format json`,
          { timeout: 300000, maxBuffer: 1024 * 1024, encoding: 'utf-8' }
        ).trim();
        let text2 = raw2;
        try { const env2 = JSON.parse(raw2); if (env2.result) text2 = env2.result; } catch {}
        if (text2) results = extractJsonArray(text2);
      } catch {} finally { try { unlinkSync(tmpFile2); } catch {} }
    }

    stats.haiku_calls++;

    for (let j = 0; j < batch.length; j++) {
      const file = batch[j];
      const r = results?.[j] || { correct_project_id: null, confidence: 0, matches_current: true, reason: 'failed' };
      stats.total++;

      let auditStatus;
      if (r.matches_current && r.confidence >= 0.3) {
        auditStatus = 'verified';
        stats.verified++;
      } else if (!r.matches_current && r.confidence >= 0.5) {
        auditStatus = 'suspect';
        stats.suspect++;
        if (stats.suspects.length < 100) {
          stats.suspects.push({
            file: file.file_name,
            current_project: file.current_project_name,
            suggested_project_id: r.correct_project_id,
            suggested_project: projects.find(p => p.id === r.correct_project_id)?.name || r.correct_project_id,
            confidence: r.confidence,
            reason: r.reason,
          });
        }
      } else {
        auditStatus = 'unsure';
        stats.unsure++;
      }

      const projKey = file.current_project_name;
      if (!stats.by_project[projKey]) stats.by_project[projKey] = { verified: 0, suspect: 0, unsure: 0 };
      stats.by_project[projKey][auditStatus]++;

      await supabase.from('massivlust_audit_moves').upsert({
        id: crypto.randomUUID(),
        file_id: null,
        file_name: file.file_name,
        from_folder_id: file.current_drive_folder_id,
        to_folder_id: r.correct_project_id ? (projects.find(p => p.id === r.correct_project_id)?.drive_root_folder_id || null) : null,
        ai_confidence: r.confidence,
        ai_model: 'haiku',
        ai_reason: r.reason,
        moved_at: new Date().toISOString(),
      });
    }

    if (stats.total % 500 < BATCH_SIZE) {
      console.log(`  ... ${stats.total}/${totalFiles} audited (verified:${stats.verified} suspect:${stats.suspect} unsure:${stats.unsure} err:${stats.errors})`);
    }

    if (stats.total - lastPingAt >= 2000) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = stats.total / elapsed;
      const remaining = totalFiles - stats.total;
      const eta = Math.round(remaining / rate / 60);
      const ping = { mode: 'audit', done: stats.total, total: totalFiles, verified: stats.verified, suspect: stats.suspect, unsure: stats.unsure, errors: stats.errors, haiku_batches: stats.haiku_calls, cost_so_far_usd: `$${(stats.haiku_calls * 0.008).toFixed(2)}`, eta: `~${eta}min` };
      console.log(`\n  === AUDIT PING ${stats.total}/${totalFiles} === ${JSON.stringify(ping)}\n`);
      if (BRIDGE_MSG_ID) {
        const msg = JSON.stringify(ping).replace(/'/g, "'\\''");
        try { execSync(`cortextos bus send-message bridge normal '${msg}' ${BRIDGE_MSG_ID}`, { timeout: 10000 }); } catch {}
      }
      lastPingAt = stats.total - (stats.total % 2000);
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 60000);
  console.log(`\n  AUDIT COMPLETED in ${elapsed} minutes`);

  const report = {
    status: 'AUDIT_COMPLETE', total: stats.total, verified: stats.verified, suspect: stats.suspect, unsure: stats.unsure,
    errors: stats.errors, haiku_calls: stats.haiku_calls, elapsed_minutes: elapsed,
    cost_estimate_usd: `$${(stats.haiku_calls * 0.008).toFixed(2)}`,
    by_project: stats.by_project,
    suspect_samples: stats.suspects.slice(0, 30),
  };
  console.log('\n' + '='.repeat(60));
  console.log('AUDIT REPORT');
  console.log('='.repeat(60));
  console.log(JSON.stringify(report, null, 2));

  if (BRIDGE_MSG_ID) {
    const msg = JSON.stringify(report).replace(/'/g, "'\\''");
    try { execSync(`cortextos bus send-message bridge normal '${msg}' ${BRIDGE_MSG_ID}`, { timeout: 10000 }); } catch {}
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Smart Classifier v2 ===');
  console.log(`Mode: ${DRY_RUN ? `DRY-RUN (${DRY_RUN_LIMIT} files)` : 'FULL'} | Dual: ${DUAL_RUN} | Scope: ${MODE}`);
  console.log('');

  const { data: projects } = await supabase
    .from('massivlust_projects')
    .select('id, name, drive_root_folder_id, address, archived')
    .not('drive_root_folder_id', 'is', null);
  console.log(`Projects: ${projects.length}`);

  if (DRY_RUN) {
    // Dry-run modes need embeddings
    console.log('Loading project embeddings...');
    const projectEmbeddings = await loadOrCreateProjectEmbeddings(projects);
    console.log(`Embeddings ready: ${projectEmbeddings.length}`);

    const { data: existingPersonal } = await supabase.from('personal_senders').select('pattern');
    if (!existingPersonal?.length) {
      const seeds = PERSONAL_DOMAINS.filter(d => !d.includes('@')).map(d => ({ pattern: d, pattern_type: 'domain', reason: 'initial_seed' }));
      await supabase.from('personal_senders').upsert(seeds, { onConflict: 'pattern' });
    }

    const users = ['alex@massivlust.no', 'mathias@massivlust.no', 'martin@massivlust.no'];
    const perUser = Math.ceil(DRY_RUN_LIMIT / users.length);
    let files = [];
    for (const user of users) {
      const { data } = await supabase.from('massivlust_unclassified_files').select('*')
        .is('v2_method', null).eq('status', 'needs_review').eq('source_user', user).limit(perUser);
      files.push(...(data || []));
    }
    const { data: gmailFiles } = await supabase.from('massivlust_unclassified_files').select('*')
      .is('v2_method', null).eq('status', 'needs_review').eq('source_type', 'gmail').limit(15);
    const seen = new Set(files.map(f => f.id));
    for (const gf of (gmailFiles || [])) { if (!seen.has(gf.id)) { files.push(gf); seen.add(gf.id); } }
    files = files.slice(0, DRY_RUN_LIMIT);

    if (DUAL_RUN) return await dualProcessFiles(files, projectEmbeddings);
    return await processFiles(files, projectEmbeddings, 'haiku');
  }

  if (MODE === 'audit') return await auditRunBatch(projects);

  // Full run — batched Haiku, no per-file embeddings
  return await fullRunBatch(projects);
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
