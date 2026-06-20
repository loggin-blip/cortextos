import { listEvents, TEAM_CALENDARS } from '../lib/google-calendar.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'calendar_events' });

  try {
    const cursor = await syncRuns.getLastCursor('calendar_events');
    const syncTokens = cursor?.syncTokens || {};

    let upserted = 0, skipped = 0, failed = 0;
    let totalIn = 0;
    const newSyncTokens = { ...syncTokens };

    const { data: employees } = await supabase
      .from('massivlust_employees')
      .select('id, email');
    const emailToId = new Map((employees || []).map(e => [e.email?.toLowerCase(), e.id]));

    for (const email of TEAM_CALENDARS) {
      try {
        const opts = {};
        if (mode === 'backfill' || !syncTokens[email]) {
          const sixMonthsAgo = new Date();
          sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
          const yearAhead = new Date();
          yearAhead.setFullYear(yearAhead.getFullYear() + 1);
          opts.timeMin = sixMonthsAgo.toISOString();
          opts.timeMax = yearAhead.toISOString();
        } else {
          opts.syncToken = syncTokens[email];
        }

        const result = await listEvents(email, opts);
        totalIn += result.events.length;
        if (result.syncToken) newSyncTokens[email] = result.syncToken;

        logger.info({ email, count: result.events.length }, 'Calendar events fetched');

        for (const event of result.events) {
          try {
            if (event.status === 'cancelled') { skipped++; continue; }

            const row = {
              calendar_id: email,
              event_id: event.id,
              employee_email: email,
              employee_id: emailToId.get(email.toLowerCase()) || null,
              summary: event.summary || null,
              description: event.description?.slice(0, 2000) || null,
              location: event.location || null,
              start_time: event.start?.dateTime || event.start?.date,
              end_time: event.end?.dateTime || event.end?.date || null,
              all_day: !!event.start?.date,
              status: event.status || null,
              attendees: event.attendees || null,
              raw_payload: event,
              last_synced_at: new Date().toISOString(),
              org_id: 'massivlust',
            };

            if (dryRun) {
              logger.info({ eventId: event.id, summary: event.summary }, 'DRY-RUN');
              upserted++;
              continue;
            }

            const { error } = await supabase
              .from('massivlust_calendar_events')
              .upsert(row, { onConflict: 'calendar_id,event_id' });

            if (error) throw error;
            upserted++;
          } catch (err) {
            failed++;
            logger.error({ err, eventId: event.id }, 'Calendar event upsert failed');
          }
        }
      } catch (err) {
        logger.error({ err, email }, 'Calendar sync failed for user');
        failed++;
      }
    }

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: totalIn,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
      cursor: { syncTokens: newSyncTokens },
    });

    return { upserted, skipped, failed, total: totalIn };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
