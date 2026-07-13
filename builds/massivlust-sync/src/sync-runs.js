import { supabase } from './supabase.js';
import { logger } from './logger.js';
import { hostname } from 'os';

const _startTimes = new Map();

export async function start({ source }) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('massivlust_sync_runs')
    .insert({ source, status: 'running', started_at: now, host: hostname(), org_id: 'massivlust' })
    .select('id')
    .single();
  if (error) {
    logger.error({ error, source }, 'Failed to create sync_run');
    throw error;
  }
  _startTimes.set(data.id, Date.now());
  return data.id;
}

export async function complete(runId, result) {
  const startMs = _startTimes.get(runId);
  const durationMs = startMs ? Date.now() - startMs : null;
  _startTimes.delete(runId);

  const { error } = await supabase
    .from('massivlust_sync_runs')
    .update({
      status: result.status,
      rows_in: result.rows_in || 0,
      rows_upserted: result.rows_upserted || 0,
      rows_skipped: result.rows_skipped || 0,
      rows_failed: result.rows_failed || 0,
      cursor: result.cursor || null,
      error_message: result.error_message || null,
      payload: result.payload || null,
      ended_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) logger.error({ error, runId }, 'Failed to complete sync_run');
}

export async function getLastCursor(source) {
  const { data } = await supabase
    .from('massivlust_sync_runs')
    .select('cursor')
    .eq('source', source)
    .in('status', ['success', 'partial'])
    .not('cursor', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.cursor || null;
}
