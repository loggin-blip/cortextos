import { searchProjects } from '../lib/tripletex.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

function fuzzyMatch(ttName, dbName) {
  const a = ttName.toLowerCase().replace(/[^a-zæøå0-9]/g, '');
  const b = dbName.toLowerCase().replace(/[^a-zæøå0-9]/g, '');
  return a === b || a.includes(b) || b.includes(a);
}

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'tripletex_projects' });

  try {
    const ttProjects = await searchProjects({ isClosed: false });
    logger.info({ count: ttProjects.length }, 'Fetched Tripletex projects');

    const { data: existing } = await supabase
      .from('massivlust_projects')
      .select('id, name, tripletex_project_id');

    let upserted = 0, skipped = 0, failed = 0;

    for (const tt of ttProjects) {
      try {
        if (tt.isInternal) { skipped++; continue; }

        const match = (existing || []).find(e =>
          e.tripletex_project_id === String(tt.id) ||
          fuzzyMatch(tt.name, e.name)
        );

        if (!match) {
          logger.info({ ttId: tt.id, name: tt.name }, 'No matching project in Supabase — skipping');
          skipped++;
          continue;
        }

        if (dryRun) {
          logger.info({ ttId: tt.id, supabaseId: match.id, name: tt.name }, 'DRY-RUN would update');
          upserted++;
          continue;
        }

        const { error } = await supabase
          .from('massivlust_projects')
          .update({ tripletex_project_id: String(tt.id) })
          .eq('id', match.id);

        if (error) throw error;
        upserted++;
      } catch (err) {
        failed++;
        logger.error({ err, ttId: tt.id }, 'Project sync failed');
      }
    }

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: ttProjects.length,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
    });

    return { upserted, skipped, failed, total: ttProjects.length };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
