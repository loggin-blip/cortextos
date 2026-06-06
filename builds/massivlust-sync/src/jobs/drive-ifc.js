import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as drive from '../lib/google-drive.js';
import { parseIfc } from '../lib/ifc-runner.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

const KNOWN_FILES = {
  '1KcBc5qqU6G2yvybt02WLDC48ohnILC7Z': 'Roan barnehage',
  '1pEG-TKLqQ8RSIRdnt9E2tGmBN0OaRF62': 'Roan barnehage',
  '1ZqrqHBpv4ydloKWm1Oubz57D0k-bMufT': 'Verksgata 54',
  '1oMyU9ODiLgiFZLeo1oOhn6_qwHoaEace': 'Verksgata 54',
  '178IQGPzaaqwohlLMLncqR9gXkmW8ZLI2': 'Jessheim VGS',
};

function matchFileToProject(file, projects) {
  if (KNOWN_FILES[file.id]) {
    const name = KNOWN_FILES[file.id].toLowerCase();
    const match = projects.find(p => p.name.toLowerCase() === name);
    if (match) return match.id;
  }

  const fileName = (file.name || '').toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const p of projects) {
    const pName = p.name.toLowerCase().replace(/[^a-zæøå0-9]/g, '');
    const fNorm = fileName.replace(/[^a-zæøå0-9]/g, '');
    if (fNorm.includes(pName) && pName.length > bestLen) {
      best = p;
      bestLen = pName.length;
    }
  }
  return best?.id || null;
}

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'drive_ifc' });

  try {
    const ifcFiles = await drive.searchFiles("name contains '.ifc' and trashed=false");
    logger.info({ count: ifcFiles.length }, 'Found IFC files on Drive');

    const { data: projects } = await supabase
      .from('massivlust_projects')
      .select('id, name');

    let upserted = 0, skipped = 0, failed = 0;
    const parseResults = [];

    for (const file of ifcFiles) {
      try {
        const projectId = matchFileToProject(file, projects || []);

        if (!projectId) {
          skipped++;
          continue;
        }

        if (mode !== 'backfill') {
          const { data: lastRun } = await supabase
            .from('massivlust_sync_runs')
            .select('payload')
            .eq('source', 'drive_ifc')
            .eq('status', 'success')
            .order('ended_at', { ascending: false })
            .limit(1)
            .single();

          const lastParsed = lastRun?.payload?.parsed_files || {};
          if (lastParsed[file.id] && lastParsed[file.id] >= file.modifiedTime) {
            skipped++;
            continue;
          }
        }

        const tmpDir = await mkdtemp(join(tmpdir(), 'ifc-'));
        const localPath = join(tmpDir, file.name);

        try {
          await drive.downloadFile(file.id, localPath);
          logger.info({ name: file.name, size: file.size }, 'Downloaded IFC');

          const result = await parseIfc(localPath, projectId);
          parseResults.push({ fileId: file.id, name: file.name, projectId, ...result });

          if (dryRun) {
            logger.info({ name: file.name, elements: result.total, projectId }, 'DRY-RUN parsed');
            upserted += result.total;
            continue;
          }

          for (const el of result.elementer) {
            const { error } = await supabase
              .from('massivlust_prosjekt_elementer')
              .upsert({
                project_id: el.project_id,
                element_kode: el.element_kode,
                type: el.type,
                status: el.status || 'planlagt',
                vekt_kg: el.vekt_kg,
                areal_m2: el.areal_m2,
                leverandor: el.leverandor,
                notes: el.notes,
                org_id: 'massivlust',
                updated_at: new Date().toISOString(),
              }, { onConflict: 'project_id,element_kode' });

            if (error) {
              failed++;
              logger.error({ error, el: el.element_kode }, 'Element upsert failed');
            } else {
              upserted++;
            }
          }
        } finally {
          await rm(tmpDir, { recursive: true, force: true });
        }
      } catch (err) {
        failed++;
        logger.error({ err, fileId: file.id, name: file.name }, 'IFC file processing failed');
      }
    }

    const parsedFiles = {};
    for (const r of parseResults) {
      parsedFiles[r.fileId] = new Date().toISOString();
    }

    const totalElements = parseResults.reduce((s, r) => s + r.total, 0);
    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: totalElements,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
      payload: { parsed_files: parsedFiles, results: parseResults },
    });

    return { upserted, skipped, failed, total: ifcFiles.length, parseResults };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
