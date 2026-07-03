import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

export async function run({ dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'team_preferanser' });

  try {
    const now = new Date();
    const sixMonthsAgo = new Date(
      now.getFullYear(),
      now.getMonth() - 6,
      now.getDate(),
    )
      .toISOString()
      .slice(0, 10);

    let allTimer = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('massivlust_timer')
        .select('employee_id, project_id, dato')
        .gte('dato', sixMonthsAgo)
        .not('employee_id', 'is', null)
        .not('project_id', 'is', null)
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allTimer = allTimer.concat(data);
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    logger.info({ rows: allTimer.length }, 'Fetched timer entries (6 mnd)');

    const empIds = [...new Set(allTimer.map((t) => t.employee_id))];
    if (empIds.length === 0) {
      await syncRuns.complete(runId, {
        status: 'success',
        rows_in: 0,
        rows_upserted: 0,
      });
      return { upserted: 0, failed: 0, pairs: 0 };
    }

    const { data: emps } = await supabase
      .from('massivlust_employees')
      .select('id, email')
      .in('id', empIds);
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
      if (!e.email) continue;
      const pid = personByEmail.get(e.email.toLowerCase());
      if (pid) empIdToPerson.set(e.id, pid);
    }

    const dayProjectEmp = new Map();
    for (const row of allTimer) {
      const pid = empIdToPerson.get(row.employee_id);
      if (!pid) continue;
      const key = `${row.dato}|${row.project_id}`;
      if (!dayProjectEmp.has(key)) dayProjectEmp.set(key, new Set());
      dayProjectEmp.get(key).add(pid);
    }

    const pairMap = new Map();
    for (const [key, personSet] of dayProjectEmp.entries()) {
      const [dato, projectId] = key.split('|');
      const list = [...personSet].sort();
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const pairKey = `${list[i]}|${list[j]}`;
          const prev = pairMap.get(pairKey) || {
            days: 0,
            lastProject: null,
            lastDate: null,
          };
          prev.days++;
          if (!prev.lastDate || dato > prev.lastDate) {
            prev.lastDate = dato;
            prev.lastProject = projectId;
          }
          pairMap.set(pairKey, prev);
        }
      }
    }

    logger.info({ pairs: pairMap.size }, 'Computed team pair stats');

    let upserted = 0,
      failed = 0;

    if (!dryRun) {
      const { error: delErr } = await supabase
        .from('team_preferanser')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
      if (delErr) throw delErr;

      const rows = [];
      for (const [pairKey, stats] of pairMap.entries()) {
        const [a, b] = pairKey.split('|');
        rows.push({
          montor_a_person_id: a,
          montor_b_person_id: b,
          jobbet_sammen_dager: stats.days,
          siste_prosjekt_id: stats.lastProject,
          siste_dato: stats.lastDate,
        });
      }

      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const { error } = await supabase.from('team_preferanser').insert(chunk);
        if (error) {
          failed += chunk.length;
          logger.error({ error: error.message }, 'team_preferanser chunk failed');
        } else {
          upserted += chunk.length;
        }
      }
    } else {
      logger.info({ pairs: pairMap.size }, 'DRY-RUN would upsert pairs');
      upserted = pairMap.size;
    }

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: dayProjectEmp.size,
      rows_upserted: upserted,
      rows_skipped: 0,
      rows_failed: failed,
    });

    return { upserted, failed, pairs: pairMap.size };
  } catch (err) {
    await syncRuns.complete(runId, {
      status: 'error',
      error_message: err.message,
    });
    throw err;
  }
}
