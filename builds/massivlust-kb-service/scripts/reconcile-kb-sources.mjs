/**
 * Reconcile kb_sources ↔ ChromaDB.
 * Reads all unique filenames from ChromaDB, finds which drive_file_ids
 * are missing from kb_sources, backfills from massivlust_unclassified_files.
 * NEVER re-embeds — only writes metadata rows.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync } from 'fs';

const run = promisify(execFile);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const KB_PYTHON = process.env.KB_PYTHON || '/Users/max/cortextos/knowledge-base/venv/bin/python';

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

// Get all unique filenames + chunk counts from ChromaDB via Python
async function getChromaFiles() {
  const pyScript = `
import chromadb, pathlib, json
from collections import Counter
c = chromadb.PersistentClient(path=str(pathlib.Path.home()/".mmrag"/"chromadb"))
col = c.get_collection("massivlust-docs")
total = col.count()
# Paginate all metadata
all_fns = []
batch = 5000
offset = 0
while offset < total:
    res = col.get(limit=batch, offset=offset, include=["metadatas"])
    for m in res["metadatas"]:
        fn = (m or {}).get("filename", "")
        if fn:
            all_fns.append(fn)
    offset += batch

counts = Counter(all_fns)
print(json.dumps({"total_chunks": total, "unique_files": len(counts), "files": dict(counts)}))
`;
  const { stdout } = await run(KB_PYTHON, ['-c', pyScript], { timeout: 120000, maxBuffer: 50_000_000 });
  return JSON.parse(stdout);
}

async function main() {
  log('=== RECONCILE kb_sources <-> ChromaDB ===');

  // 1. Get all ChromaDB files
  log('Henter alle filnavn fra ChromaDB...');
  const chromaData = await getChromaFiles();
  log(`ChromaDB: ${chromaData.total_chunks} chunks, ${chromaData.unique_files} unike filer`);

  // Parse driveFileId from staged_basename format: <driveFileId>___<name>
  const chromaMap = new Map(); // driveFileId -> {staged_basename, chunk_count}
  for (const [fn, count] of Object.entries(chromaData.files)) {
    const sep = fn.indexOf('___');
    if (sep < 0) continue;
    const driveId = fn.slice(0, sep);
    if (!chromaMap.has(driveId) || chromaMap.get(driveId).chunk_count < count) {
      chromaMap.set(driveId, { staged_basename: fn, chunk_count: count });
    }
  }
  log(`Unike drive_file_ids i ChromaDB: ${chromaMap.size}`);

  // 2. Get all drive_file_ids already in kb_sources
  log('Henter eksisterende kb_sources...');
  const existingIds = new Set();
  let page = 0;
  while (true) {
    const { data } = await supabase.from('massivlust_kb_sources')
      .select('drive_file_id').eq('org_id', 'massivlust')
      .not('drive_file_id', 'is', null)
      .range(page * 1000, page * 1000 + 999);
    if (!data?.length) break;
    for (const r of data) existingIds.add(r.drive_file_id);
    page++;
  }
  log(`kb_sources eksisterende: ${existingIds.size} unike drive_file_ids`);

  // 3. Find gap: in ChromaDB but not in kb_sources
  const missingIds = [...chromaMap.keys()].filter(id => !existingIds.has(id));
  log(`Gap: ${missingIds.length} filer i ChromaDB men ikke i kb_sources`);

  // 4. Look up metadata from massivlust_unclassified_files for the missing IDs
  log('Slår opp metadata fra massivlust_unclassified_files...');
  const toBackfill = [];
  const CHUNK_SIZE = 500;
  for (let i = 0; i < missingIds.length; i += CHUNK_SIZE) {
    const chunk = missingIds.slice(i, i + CHUNK_SIZE);
    const { data } = await supabase.from('massivlust_unclassified_files')
      .select('drive_file_id, file_name, mime_type, current_drive_folder_id, web_view_link, v2_project_id')
      .in('drive_file_id', chunk);
    for (const f of data || []) {
      const chromaEntry = chromaMap.get(f.drive_file_id);
      toBackfill.push({
        org_id: 'massivlust',
        collection: 'massivlust-docs',
        source_type: 'drive',
        staged_basename: chromaEntry.staged_basename,
        drive_file_id: f.drive_file_id,
        parent_folder_id: f.current_drive_folder_id || null,
        web_view_link: f.web_view_link || null,
        thread_id: null,
        project_id: f.v2_project_id || null,
        title: f.file_name || null,
        mime_type: f.mime_type || null,
        access_scope: 'project',
        chunk_count: chromaEntry.chunk_count,
        ingested_at: new Date().toISOString(),
      });
    }
  }
  log(`Kan backfille (finnes i unclassified_files): ${toBackfill.length}`);
  const noMetadata = missingIds.length - toBackfill.length;
  log(`Ingen metadata i unclassified_files: ${noMetadata} (mulig gmail/bilder/annet)`);

  // 5. Upsert backfill rows in batches
  let backfilled = 0;
  for (let i = 0; i < toBackfill.length; i += 200) {
    const batch = toBackfill.slice(i, i + 200);
    const { error } = await supabase.from('massivlust_kb_sources')
      .upsert(batch, { onConflict: 'drive_file_id,org_id', ignoreDuplicates: false });
    if (error) { log(`Upsert feil: ${error.message}`); }
    else { backfilled += batch.length; log(`Backfillet ${backfilled}/${toBackfill.length}...`); }
  }

  // 6. Count typed PDFs missing from ChromaDB (real ingest gap)
  log('\nFinner typede PDF-er som MANGLER i ChromaDB...');
  const chromaPdfIds = new Set([...chromaMap.keys()]);
  let typedMissingCount = 0;
  for (let i = 0; i < 5000; i += 500) {
    const { data } = await supabase.from('massivlust_unclassified_files')
      .select('drive_file_id')
      .eq('mime_type', 'application/pdf')
      .not('document_type', 'is', null)
      .not('drive_file_id', 'is', null)
      .range(i, i + 499);
    if (!data?.length) break;
    for (const f of data) {
      if (!chromaPdfIds.has(f.drive_file_id)) typedMissingCount++;
    }
  }
  log(`Typede PDF-er som mangler i ChromaDB (ekte ingest-gap): ${typedMissingCount}`);

  const summary = {
    chroma_chunks: chromaData.total_chunks,
    chroma_unique_files: chromaData.unique_files,
    kb_sources_before: existingIds.size,
    gap_total: missingIds.length,
    backfilled,
    no_metadata: noMetadata,
    typed_pdfs_missing_from_chroma: typedMissingCount,
  };
  log('\n=== RESULTAT ===');
  log(JSON.stringify(summary, null, 2));
  writeFileSync('/tmp/reconcile-result.json', JSON.stringify(summary, null, 2));
  return summary;
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
