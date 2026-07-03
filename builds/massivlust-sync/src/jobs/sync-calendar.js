import { logger } from '../logger.js';

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://ml.wdacrm.com';
const CRON_SECRET = process.env.CRON_SECRET;

export async function run() {
  if (!CRON_SECRET) {
    logger.error('CRON_SECRET not set — skipping sync-calendar');
    return { ok: false, error: 'CRON_SECRET missing' };
  }

  const url = `${DASHBOARD_URL}/api/cron/sync-calendar`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    logger.error({ status: res.status, body }, 'sync-calendar POST failed');
    return { ok: false, status: res.status, ...body };
  }

  logger.info({ ...body }, 'sync-calendar OK');
  return { ok: true, ...body };
}
