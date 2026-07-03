import { ttGet } from '../lib/tripletex.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

const ABSENCE_ACTIVITY_IDS = {
  4284907: 'ferie',
  4793245: 'syk',
};

async function fetchAbsenceEntries(dateFrom, dateTo) {
  const params = {
    count: '1000',
    activityId: Object.keys(ABSENCE_ACTIVITY_IDS).join(','),
    dateFrom,
    dateTo,
    fields: 'id,employee(id,firstName,lastName,email),activity(id,name),date,hours',
  };
  const all = [];
  let from = 0;
  while (true) {
    params.from = String(from);
    const data = await ttGet('/timesheet/entry', params);
    const values = data.values ?? [];
    all.push(...values);
    if (all.length >= (data.fullResultSize ?? 0) || values.length === 0) break;
    from += values.length;
  }
  return all;
}

function collapseIntoRanges(entries) {
  const byEmpType = new Map();
  for (const e of entries) {
    const empId = String(e.employee?.id);
    const type = ABSENCE_ACTIVITY_IDS[e.activity?.id];
    if (!empId || !type) continue;
    const key = `${empId}|${type}`;
    if (!byEmpType.has(key)) byEmpType.set(key, []);
    byEmpType.get(key).push({ date: e.date, id: e.id });
  }

  const ranges = [];
  for (const [key, entries] of byEmpType.entries()) {
    const [empId, type] = key.split('|');
    entries.sort((a, b) => a.date.localeCompare(b.date));
    let start = null,
      end = null,
      firstId = null;
    for (const { date, id } of entries) {
      if (!start) {
        start = end = date;
        firstId = id;
        continue;
      }
      const nextDay = new Date(new Date(end + 'T00:00:00Z').getTime() + 86400000)
        .toISOString()
        .slice(0, 10);
      if (date === end || date === nextDay) {
        end = date;
      } else {
        ranges.push({
          employee_tt_id: empId,
          type,
          start_dato: start,
          slutt_dato: end,
          source_ref: `tt-timesheet-${firstId}`,
        });
        start = end = date;
        firstId = id;
      }
    }
    if (start) {
      ranges.push({
        employee_tt_id: empId,
        type,
        start_dato: start,
        slutt_dato: end,
        source_ref: `tt-timesheet-${firstId}`,
      });
    }
  }
  return ranges;
}

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'tripletex_fravar' });

  try {
    const now = new Date();
    const dateFrom =
      mode === 'backfill'
        ? new Date(now.getFullYear() - 1, 0, 1).toISOString().slice(0, 10)
        : new Date(now.getTime() - 60 * 86400000).toISOString().slice(0, 10);
    const dateTo = new Date(now.getFullYear(), now.getMonth() + 6, 0)
      .toISOString()
      .slice(0, 10);

    const entries = await fetchAbsenceEntries(dateFrom, dateTo);
    logger.info(
      { count: entries.length, dateFrom, dateTo },
      'Fetched Tripletex absence timesheet entries',
    );

    const ranges = collapseIntoRanges(entries);
    logger.info({ ranges: ranges.length }, 'Collapsed into date-ranges');

    const { data: emps } = await supabase
      .from('massivlust_employees')
      .select('tripletex_employee_id, email');
    const { data: persons } = await supabase
      .from('shared_persons')
      .select('id, email');

    const personByEmail = new Map(
      (persons || [])
        .filter((p) => p.email)
        .map((p) => [p.email.toLowerCase(), p.id]),
    );
    const empIdToPerson = new Map();
    for (const e of emps || []) {
      if (!e.email || !e.tripletex_employee_id) continue;
      const pid = personByEmail.get(e.email.toLowerCase());
      if (pid) empIdToPerson.set(String(e.tripletex_employee_id), pid);
    }

    let upserted = 0,
      skipped = 0,
      failed = 0;

    if (!dryRun) {
      const { error: delErr } = await supabase
        .from('fravar')
        .delete()
        .eq('source', 'tripletex');
      if (delErr) throw delErr;
    }

    for (const r of ranges) {
      try {
        const personId = empIdToPerson.get(r.employee_tt_id);
        if (!personId) {
          skipped++;
          continue;
        }

        const row = {
          montor_person_id: personId,
          start_dato: r.start_dato,
          slutt_dato: r.slutt_dato,
          type: r.type,
          source: 'tripletex',
          source_ref: r.source_ref,
        };

        if (dryRun) {
          logger.info({ row }, 'DRY-RUN would insert absence');
          upserted++;
          continue;
        }

        const { error } = await supabase.from('fravar').insert(row);
        if (error) throw error;
        upserted++;
      } catch (err) {
        failed++;
        logger.error({ err: err.message, r }, 'Absence insert failed');
      }
    }

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: entries.length,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
    });

    return { upserted, skipped, failed, total: ranges.length };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
