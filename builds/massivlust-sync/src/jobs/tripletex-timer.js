import { searchTimeEntries } from '../lib/tripletex.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'tripletex_timer' });

  try {
    const opts = {};
    if (mode === 'backfill') {
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      opts.dateFrom = twoYearsAgo.toISOString().slice(0, 10);
      opts.dateTo = new Date().toISOString().slice(0, 10);
    } else {
      const cursor = await syncRuns.getLastCursor('tripletex_timer');
      if (cursor?.dateFrom) {
        opts.dateFrom = cursor.dateFrom;
      } else {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        opts.dateFrom = weekAgo.toISOString().slice(0, 10);
      }
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      opts.dateTo = tomorrow.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });

      if (opts.dateFrom >= opts.dateTo) {
        logger.info({ dateFrom: opts.dateFrom, dateTo: opts.dateTo }, 'No date window — skipping');
        await syncRuns.complete(runId, { status: 'success', rows_in: 0, rows_upserted: 0, cursor: { dateFrom: opts.dateFrom } });
        return { upserted: 0, skipped: 0, failed: 0, total: 0 };
      }
    }

    const entries = await searchTimeEntries(opts);
    logger.info({ count: entries.length, mode }, 'Fetched time entries');

    const { data: employees } = await supabase
      .from('massivlust_employees')
      .select('id, tripletex_employee_id');
    const empMap = new Map((employees || []).map(e => [String(e.tripletex_employee_id), e.id]));

    const { data: projects } = await supabase
      .from('massivlust_projects')
      .select('id, tripletex_project_id');
    const projMap = new Map((projects || []).map(p => [String(p.tripletex_project_id), p.id]));

    let upserted = 0, skipped = 0, failed = 0;

    for (const entry of entries) {
      try {
        const employeeId = empMap.get(String(entry.employee?.id));
        const projectId = entry.project ? projMap.get(String(entry.project.id)) : null;

        if (!employeeId) {
          skipped++;
          continue;
        }

        const row = {
          tripletex_entry_id: String(entry.id),
          employee_id: employeeId,
          montor_navn: `${entry.employee.firstName} ${entry.employee.lastName}`,
          project_id: projectId,
          dato: entry.date,
          timer: entry.hours,
          beskrivelse: entry.comment || null,
          org_id: 'massivlust',
          tripletex_synced_at: new Date().toISOString(),
        };

        if (dryRun) {
          logger.info({ row }, 'DRY-RUN would upsert');
          upserted++;
          continue;
        }

        // Two-step link: if an agent (Jensen dagrapport) already inserted this
        // timer entry, it has null tripletex_entry_id. Match on
        // (employee_id, dato, project_id) and UPDATE that row instead of
        // creating a duplicate. Otherwise fall through to onConflict upsert.
        let findQuery = supabase
          .from('massivlust_timer')
          .select('id')
          .eq('employee_id', employeeId)
          .eq('dato', entry.date)
          .is('tripletex_entry_id', null);
        findQuery = projectId
          ? findQuery.eq('project_id', projectId)
          : findQuery.is('project_id', null);
        const { data: existing, error: findErr } = await findQuery.maybeSingle();
        if (findErr) throw findErr;

        if (existing) {
          const { error } = await supabase
            .from('massivlust_timer')
            .update(row)
            .eq('id', existing.id);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from('massivlust_timer')
            .upsert(row, { onConflict: 'tripletex_entry_id' });
          if (error) throw error;
        }
        upserted++;
      } catch (err) {
        failed++;
        logger.error({ err, entryId: entry.id }, 'Time entry upsert failed');
      }
    }

    const newCursor = { dateFrom: new Date().toISOString().slice(0, 10) };
    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: entries.length,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
      cursor: newCursor,
    });

    return { upserted, skipped, failed, total: entries.length };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
