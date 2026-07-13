import { createClient } from '@supabase/supabase-js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';

const run = promisify(execFile);

// ── config ───────────────────────────────────────────────────────────────────
const KB_PYTHON = process.env.KB_PYTHON || path.join(os.homedir(), 'cortextos/knowledge-base/venv/bin/python');
// Lokal vektor-søk: Ollama bge-m3 + ChromaDB — gratis, ingen Gemini-kvote, privat
const KB_LOCAL_QUERY = process.env.KB_LOCAL_QUERY || path.join(os.homedir(), 'cortextos/knowledge-base/scripts/local_query.py');
// Kanonisk collection-skjema (MÅ matche dashbordets indeksering + buss-mapping)
export const COLLECTION_DOCS = process.env.KB_COLLECTION_DOCS || 'massivlust-docs';
export const COLLECTION_SENSITIVE = process.env.KB_COLLECTION_SENSITIVE || 'massivlust-sensitive';
// Images collection — populated by image session; READ ONLY from this service
const KB_DB_DOCS   = process.env.KB_DB_DOCS   || path.join(os.homedir(), '.mmrag', 'chromadb');
const KB_DB_IMAGES = process.env.KB_DB_IMAGES || path.join(os.homedir(), '.mmrag', 'chromadb-images');
export const COLLECTION_IMAGES = process.env.KB_COLLECTION_IMAGES || 'massivlust-images';

// Lokal query-planlegger (Ollama, samme infra som søket). Gratis/privat — ingen sky.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const PLANNER_MODEL = process.env.KB_PLANNER_MODEL || 'qwen2.5:7b';
const PHOTO_CATS = new Set(['avvik', 'ks', 'fremdrift', 'leveranse']);
const ALL_CATS = ['avvik', 'ks', 'fremdrift', 'leveranse', 'pdf'];

// Gemini-nøkkel: env eller ~/.mmrag/config.json (mmrag leser den selv, men vi
// setter env så subprosessen garantert har den)
function ensureGeminiKey() {
  if (process.env.GEMINI_API_KEY) return;
  const cfg = path.join(os.homedir(), '.mmrag', 'config.json');
  if (existsSync(cfg)) {
    try { process.env.GEMINI_API_KEY = JSON.parse(readFileSync(cfg, 'utf8')).gemini_api_key; } catch { /* noop */ }
  }
}
ensureGeminiKey();

let _db = null;
function db() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY mangler');
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

export function kbAvailable() {
  return existsSync(KB_PYTHON) && existsSync(KB_LOCAL_QUERY);
}

// ── query-planlegger (lokal qwen via Ollama) ─────────────────────────────────
// Distinkte prosjektnavn fra bilde-collectionen (samme strenger som i innholdet,
// så prosjekt-boost matcher). Caches per prosess.
let _projects = null;
async function distinctProjects() {
  if (_projects) return _projects;
  const py = `
import json, pathlib, chromadb
ps = set()
try:
    c = chromadb.PersistentClient(path=str(pathlib.Path.home()/'.mmrag'/'chromadb-images')).get_collection('massivlust-images')
    for m in c.get(include=['metadatas'])['metadatas']:
        p = (m or {}).get('project')
        if p: ps.add(p)
except Exception:
    pass
print(json.dumps(sorted(ps)))
`;
  try {
    const { stdout } = await run(KB_PYTHON, ['-c', py], { timeout: 30_000, maxBuffer: 4_000_000 });
    _projects = JSON.parse(stdout);
  } catch { _projects = []; }
  return _projects;
}

function projectMentioned(proj, question) {
  const q = question.toLowerCase();
  // minst ett signifikant ord fra prosjektnavnet må faktisk stå i spørsmålet
  return proj.toLowerCase().split(/[^a-zæøå0-9]+/).some((w) => w.length >= 3 && q.includes(w));
}

/**
 * Tolker et naturlig-språk-spørsmål til {project, type, query} via lokal qwen.
 * Returnerer null ved feil (→ kaller faller tilbake til ren hybrid).
 */
async function planQuery(question) {
  const projects = await distinctProjects();
  const sys =
    'Du er et søke-planleggingssteg for Massivlust sitt dokument- og bildesøk. ' +
    'Returner KUN JSON med nøklene project, type, query.\n' +
    '- project: EKSAKT prosjektnavn fra lista UNDER, men KUN hvis spørsmålet eksplisitt nevner prosjektet. Ellers null. ALDRI gjett et prosjekt.\n' +
    '- type: en av avvik|ks|fremdrift|leveranse|pdf, KUN hvis tydelig (feil/skade/råte/fukt→avvik; kontroll/sjekkliste/KS→ks; levering→leveranse; faktura/tilbud/kontrakt/rapport/dokument→pdf). Ellers null.\n' +
    '- query: de rene semantiske søkeordene UTEN prosjektnavnet.\n' +
    'Gyldige prosjekter: ' + JSON.stringify(projects);
  const body = {
    model: PLANNER_MODEL, format: 'json', stream: false,
    options: { temperature: 0 },
    messages: [{ role: 'system', content: sys }, { role: 'user', content: question }],
  };
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('planner http ' + res.status);
  const j = await res.json();
  const out = JSON.parse(j.message.content);
  const project = (out.project && projects.includes(out.project) && projectMentioned(out.project, question)) ? out.project : null;
  const type = ALL_CATS.includes(out.type) ? out.type : null;
  const query = (typeof out.query === 'string' && out.query.trim()) ? out.query.trim() : question;
  return { project, type, query };
}

// ── hybrid-algoritme (speiler dashboardets src/lib/kb-search.ts) ──────────────
// VEC_FLOOR tunet for bge-m3 (lokal): relevant ~0.60, urelatert ~0.45.
const VEC_FLOOR = 0.50;
const STOP = new Set(['på','og','med','av','for','til','den','det','som','er','hva','sier','om','en','et','å','har','vi','de','the','of','a','kan','du','jeg','vår','våre','noe','alle','i','går','morgen']);
const SYN = [['tegning','tegninger','drawing','drawings'],['installasjon','installation'],['kontroll','control'],['rapport','report'],['møte','meeting'],['avtale','kontrakt','agreement','contract'],['regnskap','accounts'],['bygg','bygning','building'],['sjekkliste','checklist'],['faktura','invoice'],['tilbud','offer','quote'],['bestilling','order']];

const termsOf = (q) => [...new Set(q.toLowerCase().normalize('NFC').split(/[^a-zæøå0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
function expandTerms(base) {
  const original = new Set(base), all = new Set(base);
  for (const t of base) for (const g of SYN) if (g.some((m) => t.includes(m) || m.includes(t))) g.forEach((m) => all.add(m));
  return { all: [...all], original };
}
// NFC+NFD — filnavn kan være NFD (macOS/Drive); ILIKE bommer ellers på æ/ø/å
const ilikeForms = (t) => { const a = t.normalize('NFC'), b = t.normalize('NFD'); return a === b ? [a] : [a, b]; };

async function vectorQuery(question, filters = {}) {
  // local_query.py handles dual-collection (docs + images) internally.
  // KB_DB_IMAGES / KB_IMAGES_COLLECTION passed via env so script picks them up.
  // filters.{project,type} → chroma where-filter på bilde-sporet (planleggeren).
  const env = { ...process.env, KB_IMAGES_PATH: KB_DB_IMAGES, KB_IMAGES_COLLECTION: COLLECTION_IMAGES };
  const args = [KB_LOCAL_QUERY, question, '--db-path', KB_DB_DOCS, '--collection', COLLECTION_DOCS];
  if (filters.project) args.push('--where-project', filters.project);
  if (filters.type) args.push('--where-type', filters.type);
  const { stdout } = await run(
    KB_PYTHON,
    args,
    { timeout: 60_000, maxBuffer: 20_000_000, env },
  );
  const parsed = JSON.parse(stdout);
  return (parsed.results ?? []).map((r) => ({
    content:    r.content ?? '',
    similarity: r.similarity ?? 0,
    filename:   r.filename ?? '',
    type:       r.type ?? 'text',
  }));
}

/**
 * Hybrid-søk med identitet-gating + lokal query-planlegger.
 * identity = { email, role }. TJENESTEN avgjør collections/scope.
 */
export async function hybridSearch({ question, identity, k = 8 }) {
  if (!identity || !identity.role) throw new Error('identity (med role) er påkrevd');
  const canSeeSensitive = identity.role === 'controller' || identity.role === 'admin';
  const collections = canSeeSensitive ? [COLLECTION_DOCS, COLLECTION_SENSITIVE] : [COLLECTION_DOCS];
  const allowedScopes = canSeeSensitive ? ['project', 'sensitive'] : ['project'];
  void collections;

  // 0) PLANLEGG (lokal qwen): tolk setning → {project, type, query}. Feiler trygt.
  const plan = await planQuery(question).catch(() => null);
  const effectiveQ = plan?.query || question;
  const catIntent = !!(plan?.type && PHOTO_CATS.has(plan.type)); // foto-kategori → IKKE la PDF-titler dominere

  // 1) vektor (lokal). Bruk planleggerens rene query + filtrer bilde-sporet på project/type.
  const vecAll = await vectorQuery(effectiveQ, { project: plan?.project, type: plan?.type }).catch(() => []);

  // 2) filnavn/tittel-treff — HOPP OVER ved foto-kategori-intensjon (ellers drukner foto).
  //    Bruker original question her så prosjektnavn fortsatt matcher dok-titler ved dok-søk.
  let titleRows = [];
  if (!catIntent) {
    const base = termsOf(question);
    const { all: expanded, original: _orig } = expandTerms(base);
    void _orig;
    if (expanded.length) {
      const orStr = expanded.flatMap((t) => ilikeForms(t).map((f) => `title.ilike.%${f.replace(/[%,()]/g, '')}%`)).join(',');
      const { data } = await db()
        .from('massivlust_kb_sources')
        .select('staged_basename, title, source_type, drive_file_id, parent_folder_id, web_view_link, thread_id, mime_type, access_scope, project_id')
        .eq('org_id', 'massivlust')
        .in('access_scope', allowedScopes)
        .or(orStr);
      titleRows = data ?? [];
    }
  }

  // 3) score
  const filterActive = !!(plan?.project || catIntent);
  const score = new Map(), contentByBn = new Map();
  for (const r of vecAll) {
    // bilde-treff fra et where-filtrert søk er forhåndskvalifisert (rett prosjekt+kategori)
    // → ikke kutt dem på VEC_FLOOR; de kan ha moderat similarity men er relevante.
    const floor = (filterActive && r.type === 'image') ? 0.25 : VEC_FLOOR;
    if (r.similarity >= floor) score.set(r.filename, Math.max(score.get(r.filename) ?? 0, r.similarity));
    if (!contentByBn.has(r.filename)) contentByBn.set(r.filename, r);
  }
  if (titleRows.length) {
    const { all: expanded, original } = expandTerms(termsOf(question));
    for (const t of titleRows) {
      const tl = (t.title || '').toLowerCase().normalize('NFC');
      const om = [...original].filter((x) => tl.includes(x)).length;
      const sm = expanded.filter((x) => !original.has(x) && tl.includes(x)).length;
      score.set(t.staged_basename, Math.max(score.get(t.staged_basename) ?? 0, 0.8 + 0.08 * om + 0.03 * sm));
    }
  }

  // 4) metadata for kandidater
  const meta = new Map(titleRows.map((t) => [t.staged_basename, t]));
  const missing = [...score.keys()].filter((bn) => !meta.has(bn));
  if (missing.length) {
    const { data } = await db()
      .from('massivlust_kb_sources')
      .select('staged_basename, title, source_type, drive_file_id, parent_folder_id, web_view_link, thread_id, mime_type, access_scope, project_id')
      .in('staged_basename', missing);
    for (const r of data ?? []) meta.set(r.staged_basename, r);
  }

  // 4b) PLANLEGGER-REVEKTING (additive boosts — kan aldri fjerne treff):
  //     - prosjekt nevnt → boost treff som matcher prosjektet (innhold/tittel)
  //     - foto-kategori → boost treff hvis innhold er tagget [type]
  if (plan?.project) {
    const pl = plan.project.toLowerCase();
    for (const bn of [...score.keys()]) {
      const hay = ((contentByBn.get(bn)?.content || '') + ' ' + (meta.get(bn)?.title || '')).toLowerCase();
      if (hay.includes(pl)) score.set(bn, score.get(bn) + 0.25);
    }
  }
  if (catIntent) {
    const tag = '[' + plan.type;
    for (const bn of [...score.keys()]) {
      if ((contentByBn.get(bn)?.content || '').toLowerCase().startsWith(tag)) score.set(bn, score.get(bn) + 0.1);
    }
  }

  const ranked = [...score.entries()]
    .filter(([bn]) => allowedScopes.includes(meta.get(bn)?.access_scope ?? 'project')) // forsvar i dybden
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([bn, sc]) => {
      const m = meta.get(bn), hit = contentByBn.get(bn), type = hit?.type ?? 'file';
      return {
        title: m?.title ?? (bn.split('__').slice(1).join('__') || 'Dokument'),
        score: Math.round(Math.min(1, sc) * 100) / 100,
        type,
        sourceType: m?.source_type ?? 'drive',
        driveFileId: m?.drive_file_id ?? null,
        parentFolderId: m?.parent_folder_id ?? null,
        webViewLink: m?.web_view_link ?? null,
        threadId: m?.thread_id ?? null,
        isImage: type === 'image' || (m?.mime_type ?? '').startsWith('image/'),
        sensitive: m?.access_scope === 'sensitive',
        snippet: (hit?.content ?? '').replace(/\s+/g, ' ').slice(0, 280),
      };
    });

  return { results: ranked, plan: plan ?? null };
}
