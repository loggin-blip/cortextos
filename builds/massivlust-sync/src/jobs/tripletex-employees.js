import { searchEmployees } from '../lib/tripletex.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'tripletex_employees' });

  try {
    const ttEmployees = await searchEmployees();
    logger.info({ count: ttEmployees.length }, 'Fetched Tripletex employees');

    const { data: existing } = await supabase
      .from('massivlust_employees')
      .select('id, email, full_name, tripletex_employee_id');

    let upserted = 0, skipped = 0, failed = 0;

    for (const tt of ttEmployees) {
      try {
        const ttName = `${tt.firstName} ${tt.lastName}`.toLowerCase();
        const match = (existing || []).find(e =>
          String(e.tripletex_employee_id) === String(tt.id) ||
          (e.email && tt.email && e.email.toLowerCase() === tt.email.toLowerCase()) ||
          (e.full_name && e.full_name.toLowerCase().split(' ')[0] === tt.firstName.toLowerCase() &&
           ttName.includes(e.full_name.toLowerCase().split(' ').pop()))
        );

        if (!match) {
          logger.info({ ttId: tt.id, name: `${tt.firstName} ${tt.lastName}` }, 'No matching employee in Supabase — skipping (manual creation required)');
          skipped++;
          continue;
        }

        if (dryRun) {
          logger.info({ ttId: tt.id, supabaseId: match.id, name: `${tt.firstName} ${tt.lastName}` }, 'DRY-RUN would update');
          upserted++;
          continue;
        }

        const { error } = await supabase
          .from('massivlust_employees')
          .update({
            tripletex_employee_id: String(tt.id),
            full_name: `${tt.firstName} ${tt.lastName}`,
            email: tt.email || match.email,
          })
          .eq('id', match.id);

        if (error) throw error;
        upserted++;
      } catch (err) {
        failed++;
        logger.error({ err, ttId: tt.id }, 'Employee sync failed');
      }
    }

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: ttEmployees.length,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
    });

    return { upserted, skipped, failed, total: ttEmployees.length };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
