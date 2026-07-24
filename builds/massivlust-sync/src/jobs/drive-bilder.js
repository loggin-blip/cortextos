import * as drive from '../lib/google-drive.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

const TARGET_KINDS = ['bilder', 'avvik', 'ks'];

async function scanFolderRecursive(folderId, projectId, folderKind, pathFull, results) {
  const items = await drive.searchFiles(
    `'${folderId}' in parents and trashed=false`
  );

  for (const item of items) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      await scanFolderRecursive(item.id, projectId, folderKind, `${pathFull}/${item.name}`, results);
    } else if (item.mimeType?.startsWith('image/')) {
      results.push({ file: item, projectId, folderKind, pathFull });
    }
  }
}

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'drive_bilder' });

  try {
    const { data: folders } = await supabase
      .from('massivlust_drive_folders')
      .select('drive_folder_id, project_id, folder_kind, name, path_full')
      .in('folder_kind', TARGET_KINDS)
      .not('project_id', 'is', null);

    if (!folders || folders.length === 0) {
      logger.warn('No target folders found — run drive-folders backfill first');
      await syncRuns.complete(runId, {
        status: 'success',
        rows_in: 0, rows_upserted: 0, rows_skipped: 0, rows_failed: 0,
      });
      return { upserted: 0, skipped: 0, failed: 0, total: 0 };
    }

    logger.info({ folderCount: folders.length, kinds: TARGET_KINDS }, 'Scanning folders for images recursively');

    const imageResults = [];
    for (const folder of folders) {
      await scanFolderRecursive(
        folder.drive_folder_id,
        folder.project_id,
        folder.folder_kind,
        folder.path_full,
        imageResults,
      );
      logger.info({ folder: folder.path_full, images: imageResults.length }, 'Folder scanned');
    }

    logger.info({ totalImages: imageResults.length }, 'Total images found across all folders');

    const { data: existingRows, error: fetchErr } = await supabase
      .from('massivlust_ks_bilder')
      .select('drive_file_id, dato, prosjekt_id, omrade');
    if (fetchErr) throw fetchErr;
    const existingMap = new Map((existingRows || []).map(r => [r.drive_file_id, r]));

    let upserted = 0, skipped = 0, failed = 0;

    for (const { file, projectId, folderKind } of imageResults) {
      try {
        const dato = file.modifiedTime ? file.modifiedTime.slice(0, 10) : new Date().toISOString().slice(0, 10);
        const existing = existingMap.get(file.id);
        if (existing && existing.dato === dato && existing.prosjekt_id === projectId && existing.omrade === folderKind) {
          skipped++;
          continue;
        }

        const row = {
          drive_file_id: file.id,
          prosjekt_id: projectId,
          omrade: folderKind,
          dato,
          bilde_url: `https://drive.google.com/file/d/${file.id}/view`,
          org_id: 'massivlust',
          drive_synced_at: new Date().toISOString(),
        };

        if (dryRun) {
          logger.info({ fileId: file.id, name: file.name }, 'DRY-RUN');
          upserted++;
          continue;
        }

        const { error } = await supabase
          .from('massivlust_ks_bilder')
          .upsert(row, { onConflict: 'drive_file_id' });

        if (error) throw error;
        upserted++;
      } catch (err) {
        failed++;
        logger.error({ err, fileId: file.id }, 'Drive image upsert failed');
      }
    }

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: imageResults.length,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
    });

    return { upserted, skipped, failed, total: imageResults.length };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
