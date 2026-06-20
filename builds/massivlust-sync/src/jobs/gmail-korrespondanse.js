import * as gmail from '../lib/gmail.js';
import { matchProject } from '../lib/project-matcher.js';
import { supabase } from '../supabase.js';
import * as syncRuns from '../sync-runs.js';
import { logger } from '../logger.js';

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  const runId = await syncRuns.start({ source: 'gmail_korrespondanse' });

  try {
    let messages;
    let newHistoryId;

    if (mode === 'backfill') {
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const after = Math.floor(twoYearsAgo.getTime() / 1000);
      const refs = await gmail.searchMessages(`after:${after}`, 10000);
      messages = refs;
    } else {
      const cursor = await syncRuns.getLastCursor('gmail_korrespondanse');
      if (cursor?.historyId) {
        const result = await gmail.listHistory(cursor.historyId);
        messages = result.messages;
      } else {
        const profile = await gmail.getProfile();
        newHistoryId = profile.historyId;
        const refs = await gmail.searchMessages('newer_than:7d', 200);
        messages = refs;
      }
    }

    logger.info({ count: messages.length, mode }, 'Gmail messages to process');

    let upserted = 0, skipped = 0, failed = 0;

    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    let processed = 0;

    for (const msg of messages) {
      try {
        const full = await gmail.getMessage(msg.id);
        const headers = gmail.parseHeaders(full.payload?.headers || []);
        const body = gmail.extractBody(full.payload || {});

        const fromMatch = headers.from.match(/^(.*?)\s*<(.+?)>/) || [];
        const fraNavn = fromMatch[1]?.trim().replace(/"/g, '') || headers.from;
        const fraEpost = fromMatch[2] || headers.from;

        const matchText = `${headers.subject} ${fraNavn} ${body.slice(0, 200)}`;
        const projectMatch = await matchProject(matchText);

        if (!projectMatch.project_id) {
          skipped++;
          processed++;
          if (processed % 100 === 0) {
            logger.info({ processed, total: messages.length, upserted, skipped, failed }, 'Gmail backfill progress');
          }
          continue;
        }

        const row = {
          gmail_message_id: full.id,
          gmail_thread_id: full.threadId,
          gmail_history_id: Number(full.historyId),
          project_id: projectMatch.project_id,
          dato: new Date(headers.date || full.internalDate).toISOString(),
          retning: fraEpost.includes('massivlust.no') ? 'ut' : 'inn',
          kanal: 'epost',
          fra_navn: fraNavn,
          fra_epost: fraEpost,
          emne: headers.subject,
          innhold: body.slice(0, 5000),
          auto_classified: projectMatch.auto_classified || false,
          project_match_confidence: projectMatch.confidence || 0,
          gmail_synced_at: new Date().toISOString(),
          raw_payload: full,
          org_id: 'massivlust',
        };

        if (dryRun) {
          logger.info({ msgId: full.id, subject: headers.subject, projectId: row.project_id }, 'DRY-RUN would upsert');
          upserted++;
          continue;
        }

        const { error } = await supabase
          .from('massivlust_korrespondanse')
          .upsert(row, { onConflict: 'gmail_message_id' });

        if (error) throw error;
        upserted++;

        processed++;
        if (processed % 100 === 0) {
          logger.info({ processed, total: messages.length, upserted, skipped, failed }, 'Gmail backfill progress');
        }
        if (processed % 50 === 0) await delay(1000);
      } catch (err) {
        failed++;
        if (err.code === 429 || err.status === 429) {
          logger.warn({ processed }, 'Rate limited — pausing 30s');
          await delay(30000);
        }
        logger.error({ err, msgId: msg.id }, 'Gmail upsert failed');
      }
    }

    const profile = await gmail.getProfile();
    const cursor = { historyId: newHistoryId || profile.historyId };

    await syncRuns.complete(runId, {
      status: failed === 0 ? 'success' : 'partial',
      rows_in: messages.length,
      rows_upserted: upserted,
      rows_skipped: skipped,
      rows_failed: failed,
      cursor,
    });

    return { upserted, skipped, failed, total: messages.length };
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}
