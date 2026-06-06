import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBED_URL = GEMINI_KEY ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}` : '';
const BRIDGE_MSG_ID = process.argv.find(a => a.startsWith('178'))?.match(/^\d{13}-/) ? process.argv.find(a => a.startsWith('178')) : null;

const STEP = process.argv[2];
if (!['tripletex', 'embed', 'cluster', 'all'].includes(STEP)) {
  console.error('Usage: node project-discovery.mjs <tripletex|embed|cluster|all> [bridge-msg-id]');
  process.exit(1);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tripletex API (self-contained, mirrors lib/tripletex.js)
// ---------------------------------------------------------------------------
const TT_BASE = process.env.TRIPLETEX_API_BASE || 'https://tripletex.no/v2';
let ttSession = null;

async function ttGetSession() {
  if (ttSession && ttSession.expires > Date.now()) return ttSession.token;
  const ct = process.env.TRIPLETEX_CONSUMER_TOKEN;
  const et = process.env.TRIPLETEX_EMPLOYEE_TOKEN;
  if (!ct || !et) throw new Error('Missing TRIPLETEX tokens');
  const d = new Date(); d.setDate(d.getDate() + 2);
  const exp = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });
  const res = await fetch(`${TT_BASE}/token/session/:create?consumerToken=${encodeURIComponent(ct)}&employeeToken=${encodeURIComponent(et)}&expirationDate=${exp}`, { method: 'PUT', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`TT session failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  const token = json.value?.token ?? json.value?.sessionToken;
  if (!token) throw new Error('No session token');
  ttSession = { token, expires: Date.now() + 20 * 3600 * 1000 };
  return token;
}

async function ttGet(path, params = {}) {
  const session = await ttGetSession();
  const url = new URL(`${TT_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const auth = Buffer.from(`0:${session}`).toString('base64');
  const res = await fetch(url.toString(), { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`TT ${path} (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Step A: Tripletex full project fetch
// ---------------------------------------------------------------------------
async function stepTripletex() {
  console.log('\n=== STEP A: Tripletex Full Project Discovery ===\n');

  let allProjects = [];
  let from = 0;
  const fields = 'id,name,number,startDate,endDate,isInternal,isClosed,customer(id,name),projectManager(id,firstName,lastName),description';

  while (true) {
    const data = await ttGet('/project', { count: '1000', from: String(from), fields });
    const values = data.values ?? [];
    allProjects.push(...values);
    console.log(`  Fetched ${values.length} projects (total so far: ${allProjects.length}, fullResultSize: ${data.fullResultSize})`);
    if (allProjects.length >= data.fullResultSize || values.length === 0) break;
    from += values.length;
  }

  console.log(`\nTotal Tripletex projects: ${allProjects.length}`);

  const nonInternal = allProjects.filter(p => !p.isInternal);
  const internal = allProjects.filter(p => p.isInternal);
  console.log(`  Non-internal: ${nonInternal.length}, Internal: ${internal.length}`);

  const byClosed = { open: nonInternal.filter(p => !p.isClosed).length, closed: nonInternal.filter(p => p.isClosed).length };
  console.log(`  Open: ${byClosed.open}, Closed: ${byClosed.closed}`);

  // Get existing projects
  const { data: existing } = await supabase.from('massivlust_projects').select('id, name, tripletex_project_id, archived, status');
  const existingIds = new Set((existing || []).map(e => e.tripletex_project_id).filter(Boolean).map(String));
  const existingNames = new Set((existing || []).map(e => e.name.toLowerCase().replace(/[^a-zæøå0-9]/g, '')));

  let added = 0, skipped = 0, updated = 0;
  const newProjects = [];

  for (const tt of nonInternal) {
    const ttIdStr = String(tt.id);
    const ttNameNorm = tt.name.toLowerCase().replace(/[^a-zæøå0-9]/g, '');

    // Skip if already exists
    if (existingIds.has(ttIdStr)) {
      // Update status if needed
      const match = (existing || []).find(e => String(e.tripletex_project_id) === ttIdStr);
      if (match) {
        const newStatus = tt.isClosed ? 'completed' : 'active';
        if (match.status !== newStatus) {
          // DON'T change active projects' status — only update historical ones
          if (!['active'].includes(match.status) || tt.isClosed) {
            await supabase.from('massivlust_projects').update({
              status: newStatus,
              tripletex_synced_at: new Date().toISOString(),
            }).eq('id', match.id);
            updated++;
          }
        }
      }
      skipped++;
      continue;
    }

    // Fuzzy match by name
    const nameMatch = (existing || []).find(e => {
      const en = e.name.toLowerCase().replace(/[^a-zæøå0-9]/g, '');
      return en === ttNameNorm || en.includes(ttNameNorm) || ttNameNorm.includes(en);
    });

    if (nameMatch) {
      // Link existing project to Tripletex ID
      await supabase.from('massivlust_projects').update({
        tripletex_project_id: tt.id,
        tripletex_synced_at: new Date().toISOString(),
      }).eq('id', nameMatch.id);
      updated++;
      skipped++;
      continue;
    }

    // New historical project — INSERT
    const status = tt.isClosed ? 'completed' : 'active';
    const newProject = {
      id: randomUUID(),
      name: tt.name,
      tripletex_project_id: tt.id,
      status,
      archived: tt.isClosed,
      org_id: 'massivlust',
      start_date: tt.startDate || null,
      end_date: tt.endDate || null,
      customer: tt.customer?.name || null,
      notes: `Auto-discovered from Tripletex. ${tt.description || ''}`.trim(),
      tripletex_synced_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const { error } = await supabase.from('massivlust_projects').insert(newProject);
    if (error) {
      console.warn(`  [WARN] Insert failed for "${tt.name}": ${error.message}`);
    } else {
      added++;
      newProjects.push({ name: tt.name, status, customer: tt.customer?.name, tripletex_id: tt.id, start: tt.startDate, end: tt.endDate });
    }
  }

  console.log(`\nResults: ${added} added, ${updated} updated, ${skipped} skipped`);

  const report = {
    tripletex_total: allProjects.length,
    non_internal: nonInternal.length,
    internal: internal.length,
    open: byClosed.open,
    closed: byClosed.closed,
    new_added: added,
    existing_updated: updated,
    skipped,
    new_projects: newProjects,
  };

  console.log('\n--- Tripletex Discovery Report ---');
  console.log(JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------------------
// Step B: Embed 22k files
// ---------------------------------------------------------------------------
const EMBED_BATCH_SIZE = 50;
const EMBED_RATE_LIMIT_MS = 4500; // ~13 calls/min for free tier

async function getEmbedding(text) {
  const res = await fetch(GEMINI_EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    console.warn('  [429] Rate limited, waiting 60s...');
    await delay(60000);
    return getEmbedding(text);
  }
  if (!res.ok) throw new Error(`Embed failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.embedding?.values || [];
}

async function stepEmbed() {
  console.log('\n=== STEP B: Embedding 22k files ===\n');

  if (!GEMINI_KEY) {
    console.error('No GEMINI_API_KEY — cannot embed. Set GEMINI_API_KEY or provide OpenAI key.');
    return null;
  }

  // Count files needing embeddings
  const { count } = await supabase
    .from('massivlust_unclassified_files')
    .select('*', { count: 'exact', head: true })
    .is('v2_suggestions', null);

  console.log(`Files needing embeddings: ${count}`);

  const PAGE = 500;
  let processed = 0;
  let errors = 0;
  const startTime = Date.now();

  while (true) {
    const { data: batch, error } = await supabase
      .from('massivlust_unclassified_files')
      .select('id, file_name, gmail_subject, gmail_from, source_type')
      .is('v2_suggestions', null)
      .order('id')
      .limit(PAGE);

    if (error) { console.error(`DB error: ${error.message}`); break; }
    if (!batch?.length) break;

    for (const file of batch) {
      try {
        const signalParts = [file.file_name];
        if (file.gmail_subject) signalParts.push(file.gmail_subject);
        if (file.gmail_from) signalParts.push(file.gmail_from);
        const text = signalParts.join(' ').slice(0, 500);

        const embedding = await getEmbedding(text);
        if (!embedding.length) { errors++; continue; }

        await supabase.from('massivlust_unclassified_files').update({
          v2_suggestions: JSON.stringify({ embedding }),
        }).eq('id', file.id);

        processed++;
        if (processed % 100 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = processed / elapsed;
          console.log(`  ... ${processed}/${count} embedded (${rate.toFixed(1)}/sec, errors: ${errors})`);
        }

        await delay(EMBED_RATE_LIMIT_MS);
      } catch (err) {
        errors++;
        if (errors % 10 === 0) console.warn(`  [WARN] ${errors} errors so far: ${err.message?.slice(0, 80)}`);
      }
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 60000);
  console.log(`\nEmbedding complete: ${processed} embedded, ${errors} errors, ${elapsed} min`);
  return { processed, errors, elapsed };
}

// ---------------------------------------------------------------------------
// Step C: Cluster embeddings
// ---------------------------------------------------------------------------
function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function stepCluster() {
  console.log('\n=== STEP C: Clustering embedded files ===\n');

  // Load all projects (including newly discovered)
  const { data: projects } = await supabase.from('massivlust_projects').select('id, name, status, tripletex_project_id');
  console.log(`Projects in DB: ${projects.length}`);

  // Load embedded files
  const { data: files, error } = await supabase
    .from('massivlust_unclassified_files')
    .select('id, file_name, gmail_subject, gmail_from, source_type, v2_suggestions, v2_method')
    .not('v2_suggestions', 'is', null)
    .limit(25000);

  if (error) { console.error(`DB error: ${error.message}`); return; }
  console.log(`Files with embeddings: ${files.length}`);

  // Parse embeddings
  const embedded = [];
  for (const f of files) {
    try {
      const parsed = typeof f.v2_suggestions === 'string' ? JSON.parse(f.v2_suggestions) : f.v2_suggestions;
      if (parsed?.embedding?.length) {
        embedded.push({ ...f, embedding: parsed.embedding });
      }
    } catch {}
  }
  console.log(`Valid embeddings: ${embedded.length}`);

  if (embedded.length < 100) {
    console.log('Too few embeddings for meaningful clustering. Run embed step first.');
    return;
  }

  // Simple hierarchical clustering via nearest-neighbor chains
  // For 22k files, DBSCAN is O(n²) — use project-centroid matching instead
  console.log('\nComputing project centroids from known-classified files...');

  // Get project embeddings from auto/suggested files
  const classified = embedded.filter(f =>
    f.v2_method === 'auto_classified' || f.v2_method === 'suggested'
  );
  console.log(`  Classified files with embeddings: ${classified.length}`);

  // If we have project-embedded files, use them as centroids
  // Otherwise, embed project names directly
  const projectEmbeddings = [];
  for (const p of projects) {
    const embedding = await getEmbedding(p.name);
    if (embedding.length) {
      projectEmbeddings.push({ id: p.id, name: p.name, status: p.status, embedding });
    }
    await delay(EMBED_RATE_LIMIT_MS);
  }
  console.log(`  Project embeddings computed: ${projectEmbeddings.length}`);

  // Assign each file to nearest project
  console.log('\nAssigning files to nearest project...');
  const clusters = {};
  let assigned = 0;

  for (const file of embedded) {
    let bestProject = null;
    let bestSim = -1;

    for (const pe of projectEmbeddings) {
      const sim = cosineSimilarity(file.embedding, pe.embedding);
      if (sim > bestSim) { bestSim = sim; bestProject = pe; }
    }

    if (!bestProject) continue;

    const key = bestProject.id;
    if (!clusters[key]) {
      clusters[key] = {
        project_id: bestProject.id,
        project_name: bestProject.name,
        project_status: bestProject.status,
        count: 0,
        avg_similarity: 0,
        high_confidence: 0,
        examples: [],
      };
    }

    clusters[key].count++;
    clusters[key].avg_similarity += bestSim;
    if (bestSim > 0.7) clusters[key].high_confidence++;
    if (clusters[key].examples.length < 5) {
      clusters[key].examples.push({
        file: file.file_name,
        subject: file.gmail_subject,
        similarity: Math.round(bestSim * 1000) / 1000,
      });
    }
    assigned++;
  }

  // Finalize averages
  for (const c of Object.values(clusters)) {
    c.avg_similarity = Math.round((c.avg_similarity / c.count) * 1000) / 1000;
  }

  const sorted = Object.values(clusters).sort((a, b) => b.count - a.count);
  console.log(`\nClusters formed: ${sorted.length}`);
  console.log(`Files assigned: ${assigned}`);

  // Find orphan clusters (no Tripletex match)
  const ttMatched = sorted.filter(c => {
    const p = projects.find(p => p.id === c.project_id);
    return p?.tripletex_project_id;
  });
  const noTtMatch = sorted.filter(c => {
    const p = projects.find(p => p.id === c.project_id);
    return !p?.tripletex_project_id;
  });

  const report = {
    total_projects: projects.length,
    projects_with_tripletex: projects.filter(p => p.tripletex_project_id).length,
    total_embedded: embedded.length,
    clusters: sorted.length,
    tripletex_matched_clusters: ttMatched.length,
    unmatched_clusters: noTtMatch.length,
    top_clusters: sorted.slice(0, 20),
    unmatched_details: noTtMatch.slice(0, 15),
  };

  console.log('\n' + '='.repeat(60));
  console.log('CLUSTER REPORT');
  console.log('='.repeat(60));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Project Discovery (Task #27) ===');
  console.log(`Step: ${STEP}\n`);

  let ttReport = null;
  let embedReport = null;
  let clusterReport = null;

  if (STEP === 'tripletex' || STEP === 'all') {
    ttReport = await stepTripletex();
  }

  if (STEP === 'embed' || STEP === 'all') {
    embedReport = await stepEmbed();
  }

  if (STEP === 'cluster' || STEP === 'all') {
    clusterReport = await stepCluster();
  }

  // Send combined report
  if (BRIDGE_MSG_ID || STEP === 'all' || STEP === 'cluster') {
    const final = { step: STEP, tripletex: ttReport, embeddings: embedReport, clusters: clusterReport };
    console.log('\n=== FINAL DISCOVERY REPORT ===');
    console.log(JSON.stringify(final, null, 2));

    if (BRIDGE_MSG_ID) {
      const msg = JSON.stringify(final).replace(/'/g, "'\\''");
      try { execSync(`cortextos bus send-message bridge normal '${msg}' ${BRIDGE_MSG_ID}`, { timeout: 10000 }); } catch {}
    }
  }
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
