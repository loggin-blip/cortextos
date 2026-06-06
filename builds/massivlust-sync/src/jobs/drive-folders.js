import * as drive from '../lib/google-drive.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

const SHARED_DRIVE_ID = '0AHjodo-_rO2AUk9PVA';

const FOLDER_KIND_MAP = {
  '00': null,
  '01': 'avvik',
  '02': 'bilder',
  '03': 'annet',
  '04': 'dokumenter',
  '05': 'ks',
  '06': 'annet',
  '07': 'annet',
};

function classifyFolder(name) {
  const prefix = name.slice(0, 2);
  return FOLDER_KIND_MAP[prefix] || null;
}

function normalize(s) {
  return s.toLowerCase()
    .replace(/å/g, 'a').replace(/æ/g, 'ae').replace(/ø/g, 'o')
    .replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function matchFolderToProject(folderName, projects) {
  const fNorm = normalize(folderName);
  const fRaw = folderName.toLowerCase().replace(/[^a-zæøå0-9]/g, '');
  let best = null;
  let bestScore = 0;

  for (const p of projects) {
    const pNorm = normalize(p.name);
    const pRaw = p.name.toLowerCase().replace(/[^a-zæøå0-9]/g, '');
    const pFirst = normalize(p.name.split(/\s+/)[0]);
    let score = 0;

    if (fRaw === pRaw || fNorm === pNorm) {
      score = 100;
    } else if (fRaw.includes(pRaw) || pRaw.includes(fRaw)) {
      score = 80;
    } else if (fNorm.includes(pNorm) || pNorm.includes(fNorm)) {
      score = 70;
    } else if (pFirst.length >= 4 && fNorm.includes(pFirst)) {
      score = 60;
    } else {
      const dist1 = editDistance(fNorm, pFirst);
      if (pFirst.length >= 4 && dist1 <= Math.ceil(pFirst.length * 0.3)) {
        score = 55 - dist1 * 5;
      } else {
        const shorter = fNorm.length <= pNorm.length ? fNorm : pNorm;
        const longer = fNorm.length <= pNorm.length ? pNorm : fNorm;
        const dist = editDistance(shorter, longer.slice(0, shorter.length + 2));
        const maxLen = Math.max(shorter.length, 1);
        if (dist <= Math.ceil(maxLen * 0.25)) {
          score = 50 - dist * 5;
        }
      }
    }

    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }

  if (best) {
    logger.info({ folder: folderName, project: best.name, score: bestScore }, 'Folder→project match');
  }

  return bestScore >= 40 ? best : null;
}

async function discoverTree(folderId, parentDriveId, parentPath, projects, results, inheritedProjectId = null) {
  const items = await drive.listFolderFull(folderId);
  const folders = items.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

  for (const folder of folders) {
    const fullPath = parentPath ? `${parentPath}/${folder.name}` : folder.name;
    const kind = classifyFolder(folder.name);
    const isTopLevel = parentDriveId === SHARED_DRIVE_ID;

    let projectId = inheritedProjectId;
    let isProjectRoot = false;
    if (isTopLevel) {
      const projectMatch = matchFolderToProject(folder.name, projects);
      if (projectMatch) {
        projectId = projectMatch.id;
        isProjectRoot = true;
      }
    }

    results.push({
      drive_folder_id: folder.id,
      name: folder.name,
      parent_drive_id: parentDriveId,
      project_id: projectId,
      is_project_root: isProjectRoot,
      folder_kind: kind,
      path_full: fullPath,
      web_view_link: folder.webViewLink || null,
      last_synced_at: new Date().toISOString(),
      org_id: 'massivlust',
    });

    if (isTopLevel && folder.name.toLowerCase() === 'arkiv') continue;

    await discoverTree(folder.id, folder.id, fullPath, projects, results, projectId);
  }
}

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'drive_folders' });

  try {
    const { data: projects } = await supabase
      .from('massivlust_projects')
      .select('id, name');

    const results = [];

    if (mode === 'backfill') {
      await discoverTree(SHARED_DRIVE_ID, SHARED_DRIVE_ID, '', projects || [], results);
    } else {
      const cursor = await syncRuns.getLastCursor('drive_folders');
      const pageToken = cursor?.pageToken || await drive.getStartPageToken();

      const changes = await drive.listChanges(pageToken);
      const changedFolders = (changes.changes || [])
        .filter(c => !c.removed && c.file?.mimeType === 'application/vnd.google-apps.folder')
        .map(c => c.file);

      for (const folder of changedFolders) {
        const parentId = folder.parents?.[0] || null;
        const isTopLevel = parentId === SHARED_DRIVE_ID;
        const kind = classifyFolder(folder.name);
        let projectMatch = null;
        if (isTopLevel) {
          projectMatch = matchFolderToProject(folder.name, projects || []);
        }

        results.push({
          drive_folder_id: folder.id,
          name: folder.name,
          parent_drive_id: parentId,
          project_id: projectMatch?.id || null,
          is_project_root: isTopLevel && projectMatch != null,
          folder_kind: kind,
          path_full: folder.name,
          web_view_link: null,
          last_synced_at: new Date().toISOString(),
          org_id: 'massivlust',
        });
      }

      if (changes.newStartPageToken) {
        var newPageToken = changes.newStartPageToken;
      }
    }

    logger.info({ count: results.length, mode }, 'Drive folders discovered');

    let upserted = 0, skipped = 0, failed = 0;

    for (const row of results) {
      if (dryRun) {
        logger.info({ name: row.name, path: row.path_full, kind: row.folder_kind }, 'DRY-RUN');
        upserted++;
        continue;
      }

      const { error } = await supabase
        .from('massivlust_drive_folders')
        .upsert(row, { onConflict: 'drive_folder_id' });

      if (error) {
        failed++;
        logger.error({ error, name: row.name }, 'Folder upsert failed');
      } else {
        upserted++;
      }
    }

    const projectRoots = results.filter(r => r.is_project_root);
    if (!dryRun) {
      for (const root of projectRoots) {
        const { error } = await supabase
          .from('massivlust_projects')
          .update({ drive_root_folder_id: root.drive_folder_id })
          .eq('id', root.project_id);

        if (error) {
          logger.error({ error, projectId: root.project_id }, 'Failed to set drive_root_folder_id');
        }
      }
    }

    // For incremental: resolve project_id from parent chain
    if (mode !== 'backfill' && !dryRun) {
      const unmatched = results.filter(r => !r.project_id && r.parent_drive_id);
      for (const row of unmatched) {
        const { data: parent } = await supabase
          .from('massivlust_drive_folders')
          .select('project_id')
          .eq('drive_folder_id', row.parent_drive_id)
          .single();

        if (parent?.project_id) {
          await supabase
            .from('massivlust_drive_folders')
            .update({ project_id: parent.project_id })
            .eq('drive_folder_id', row.drive_folder_id);
        }
      }
    }

    const unmatchedFolders = results.filter(r => !r.project_id && r.parent_drive_id === SHARED_DRIVE_ID && r.name.toLowerCase() !== 'arkiv');
    const matchedProjectIds = new Set(projectRoots.map(r => r.project_id));
    const unmatchedProjects = (projects || []).filter(p => !matchedProjectIds.has(p.id));

    for (const f of unmatchedFolders) {
      logger.warn({ folder: f.name }, 'NO MATCH — Drive folder has no matching project in Supabase');
    }
    for (const p of unmatchedProjects) {
      logger.warn({ project: p.name }, 'NO MATCH — project has no Drive folder');
    }

    const cursorData = newPageToken ? { pageToken: newPageToken } : null;
    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: results.length,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
      cursor: cursorData,
      payload: {
        project_roots: projectRoots.map(r => ({ name: r.name, project_id: r.project_id })),
        unmatched_folders: unmatchedFolders.map(r => r.name),
        unmatched_projects: unmatchedProjects.map(p => p.name),
      },
    });

    return { upserted, skipped, failed, total: results.length, projectRoots, unmatchedFolders, unmatchedProjects, results };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
