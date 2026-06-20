import { searchInvoices, searchOrders } from '../lib/tripletex.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'tripletex_fakturaer' });

  try {
    const invoices = await searchInvoices();
    logger.info({ count: invoices.length }, 'Fetched Tripletex invoices');

    const { data: projects } = await supabase
      .from('massivlust_projects')
      .select('id, tripletex_project_id, customer');
    const projByCustomer = new Map();
    for (const p of (projects || [])) {
      if (p.customer) projByCustomer.set(p.customer.toLowerCase(), p.id);
    }

    let upserted = 0, skipped = 0, failed = 0;

    for (const inv of invoices) {
      try {
        const customerName = inv.customer?.name?.toLowerCase();
        const projectId = customerName ? projByCustomer.get(customerName) : null;

        if (!projectId) {
          skipped++;
          continue;
        }

        const row = {
          tripletex_ref: String(inv.id),
          project_id: projectId,
          milepael: `Faktura #${inv.invoiceNumber}`,
          belop_nok: inv.amount,
          status: inv.amountOutstanding === 0 ? 'betalt' : 'sendt',
          sendt_dato: inv.invoiceDate,
          org_id: 'massivlust',
          tripletex_synced_at: new Date().toISOString(),
          tripletex_payload: inv,
        };

        if (dryRun) {
          logger.info({ row }, 'DRY-RUN would upsert');
          upserted++;
          continue;
        }

        const { error } = await supabase
          .from('massivlust_fakturaer')
          .upsert(row, { onConflict: 'tripletex_ref' });

        if (error) throw error;
        upserted++;
      } catch (err) {
        failed++;
        logger.error({ err, invId: inv.id }, 'Invoice upsert failed');
      }
    }

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: invoices.length,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
    });

    return { upserted, skipped, failed, total: invoices.length };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
