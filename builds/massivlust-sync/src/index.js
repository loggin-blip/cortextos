import cron from 'node-cron';
import { logger } from './logger.js';

const JOBS = {
  'tripletex-timer':      () => import('./jobs/tripletex-timer.js'),
  'tripletex-fakturaer':  () => import('./jobs/tripletex-fakturaer.js'),
  'tripletex-employees':  () => import('./jobs/tripletex-employees.js'),
  'tripletex-projects':   () => import('./jobs/tripletex-projects.js'),
  'gmail-korrespondanse': () => import('./jobs/gmail-korrespondanse.js'),
  'drive-folders':        () => import('./jobs/drive-folders.js'),
  'drive-bilder':         () => import('./jobs/drive-bilder.js'),
  'drive-ifc':            () => import('./jobs/drive-ifc.js'),
  'calendar-events':      () => import('./jobs/calendar-events.js'),
  'progress-aggregator':  () => import('./jobs/progress-aggregator.js'),
  'continuous-classify':  () => import('./jobs/continuous-classify.js'),
};

const CRON_SCHEDULE = {
  'tripletex-timer':      '*/15 * * * *',
  'tripletex-fakturaer':  '0 */2 * * *',
  'tripletex-employees':  '0 6 * * *',
  'tripletex-projects':   '0 6 * * *',
  'gmail-korrespondanse': '*/5 * * * *',
  'drive-folders':        '*/30 * * * *',
  'drive-bilder':         '*/10 * * * *',
  'drive-ifc':            '*/10 * * * *',
  'calendar-events':      '*/15 * * * *',
  'progress-aggregator':  '*/5 * * * *',
  'continuous-classify':  '0 */4 * * *',
};

async function runJob(name, opts = {}) {
  logger.info({ job: name, ...opts }, 'Starting job');
  const start = Date.now();
  try {
    const mod = await JOBS[name]();
    const result = await mod.run(opts);
    logger.info({ job: name, duration: Date.now() - start, ...result }, 'Job completed');
    return result;
  } catch (err) {
    logger.error({ job: name, duration: Date.now() - start, err }, 'Job failed');
    throw err;
  }
}

const args = process.argv.slice(2);
const mode = args.find(a => a.startsWith('--mode='))?.split('=')[1] || 'daemon';
const source = args.find(a => a.startsWith('--source='))?.split('=')[1];
const dryRun = args.includes('--dry-run');

if (mode === 'backfill') {
  const jobNames = source ? [source] : Object.keys(JOBS);
  logger.info({ jobs: jobNames, dryRun }, 'Backfill mode');

  for (const name of jobNames) {
    if (!JOBS[name]) {
      logger.error({ name }, 'Unknown job');
      continue;
    }
    try {
      await runJob(name, { mode: 'backfill', dryRun });
    } catch {
      // logged inside runJob
    }
  }

  process.exit(0);
} else {
  logger.info('Starting daemon with cron schedules');

  for (const [name, schedule] of Object.entries(CRON_SCHEDULE)) {
    cron.schedule(schedule, () => {
      runJob(name).catch(() => {});
    }, { timezone: 'Europe/Oslo' });
    logger.info({ job: name, schedule }, 'Cron registered');
  }

  logger.info('All crons registered. Daemon running.');
}
