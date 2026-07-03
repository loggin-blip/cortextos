import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

const PATTERNS = [
  { type: 'ferie', re: /(^|[^a-zæøå])(sommer|vinter|høst|påske|jule)?ferie([^a-zæøå]|$)/i },
  { type: 'syk',   re: /(^|[^a-zæøå])(syk|sykemeldt|sykefravær|sykdom)([^a-zæøå]|$)/i },
  { type: 'avspasering', re: /avspaser/i },
  { type: 'permisjon', re: /permisjon/i },
  { type: 'annet', re: /ikke\s*på\s*jobb|fridag|(^|[^a-zæøå])fri\s+dag/i },
];

const EXCLUDE = /sykehjem|frist|trening/i;

const MIN_DURATION_MS = 20 * 3600 * 1000;

function classify(summary) {
  if (!summary) return null;
  if (EXCLUDE.test(summary)) return null;
  for (const { type, re } of PATTERNS) {
    if (re.test(summary)) return type;
  }
  return null;
}

const OSLO_TZ = 'Europe/Oslo';
const dateFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: OSLO_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function toOsloDate(ts) {
  return dateFmt.format(new Date(ts));
}

function endDateInclusive(startTs, endTs, allDay) {
  let end = new Date(endTs);
  if (allDay) {
    end = new Date(end.getTime() - 86400000);
  }
  const startDay = toOsloDate(startTs);
  const endDay = toOsloDate(end);
  return endDay < startDay ? startDay : endDay;
}

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'calendar_fravar' });

  try {
    const now = new Date();
    const from = new Date(now.getTime() - 365 * 86400000).toISOString();
    const to = new Date(now.getTime() + 365 * 86400000).toISOString();

    const { data: events, error: fetchErr } = await supabase
      .from('massivlust_calendar_events')
      .select('event_id, summary, start_time, end_time, all_day, employee_email')
      .gte('start_time', from)
      .lte('start_time', to)
      .not('employee_email', 'is', null);
    if (fetchErr) throw fetchErr;

    logger.info({ count: events.length, from, to }, 'Calendar events fetched');

    const { data: persons } = await supabase
      .from('shared_persons')
      .select('id, email');
    const personByEmail = new Map(
      (persons || [])
        .filter((p) => p.email)
        .map((p) => [p.email.toLowerCase(), p.id]),
    );

    const candidates = [];
    const seenKey = new Set();

    for (const ev of events) {
      const type = classify(ev.summary);
      if (!type) continue;

      const durMs = new Date(ev.end_time).getTime() - new Date(ev.start_time).getTime();
      if (!ev.all_day && durMs < MIN_DURATION_MS) continue;

      const personId = personByEmail.get(ev.employee_email?.toLowerCase());
      if (!personId) continue;

      const startDato = toOsloDate(ev.start_time);
      const sluttDato = endDateInclusive(ev.start_time, ev.end_time, ev.all_day);

      const key = `${personId}|${type}|${startDato}|${sluttDato}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);

      candidates.push({
        montor_person_id: personId,
        type,
        start_dato: startDato,
        slutt_dato: sluttDato,
        source: 'calendar',
        source_ref: `calendar-${ev.event_id}`,
        notes: ev.summary,
      });
    }

    logger.info({ candidates: candidates.length }, 'Absence candidates classified');

    if (dryRun) {
      for (const c of candidates.slice(0, 10)) {
        logger.info({ row: c }, 'DRY-RUN would insert absence');
      }
      await syncRuns.complete(runId, {
        status: 'success',
        rows_in: events.length,
        rows_upserted: candidates.length,
        rows_skipped: 0,
        rows_failed: 0,
      });
      return { upserted: candidates.length, skipped: 0, failed: 0, total: candidates.length, dryRun: true };
    }

    const { error: delErr } = await supabase
      .from('fravar')
      .delete()
      .eq('source', 'calendar');
    if (delErr) throw delErr;

    let upserted = 0, failed = 0;
    for (const row of candidates) {
      const { error } = await supabase.from('fravar').insert(row);
      if (error) {
        failed++;
        logger.error({ err: error.message, row }, 'Absence insert failed');
      } else {
        upserted++;
      }
    }

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: events.length,
      rows_upserted: upserted,
      rows_skipped: 0,
      rows_failed: failed,
    });

    return { upserted, failed, total: candidates.length };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
