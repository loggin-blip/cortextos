/**
 * Telegram message logging and last-sent context caching.
 * Matches the bash send-telegram.sh outbound logging (lines 100-108)
 * and last-sent cache (lines 111-113).
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { logEvent } from '../bus/event.js';
import { resolveEnv } from '../utils/env.js';
import { sourceEnvFile } from '../utils/env.js';
import type { BusPaths, TelegramMessage } from '../types/index.js';

/**
 * Lazy-load SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from cortextOS env files
 * if they are not already present in process.env. This makes the mirror work
 * both inside an agent-PTY (where secrets.env is already sourced) and from a
 * bare `cortextos bus send-telegram` CLI call (where it is not).
 *
 * Search order (first match wins, but does not override existing process.env):
 *   1. {frameworkRoot}/.env             (shared root .env)
 *   2. {frameworkRoot}/orgs/{org}/secrets.env  (per-org shared secrets)
 */
function ensureSupabaseEnvLoaded(): void {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const env = resolveEnv();
    if (env.frameworkRoot) {
      sourceEnvFile(join(env.frameworkRoot, '.env'));
    }
    if (env.frameworkRoot && env.org) {
      sourceEnvFile(join(env.frameworkRoot, 'orgs', env.org, 'secrets.env'));
    }
  } catch { /* never throw — mirror is best-effort */ }
}

/**
 * Mirror a Telegram message (inbound or outbound) to the Supabase
 * `massivlust_agent_messages` table for live dashboard sync.
 *
 * Best-effort: never throws, never blocks the send path. Uses Supabase REST
 * API directly via fetch (no SDK dependency — keeps Cortex runtime slim).
 *
 * Skips silently if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are not set,
 * or if the chat_id is not mapped to an employee in
 * `massivlust_telegram_chat_map`.
 */
export async function mirrorToSupabase(params: {
  chatId: string | number;
  agentName: string;
  direction: 'inbound' | 'outbound';
  text: string;
  messageId?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  ensureSupabaseEnvLoaded();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;

  const chatIdNum = Number(params.chatId);
  if (!Number.isFinite(chatIdNum)) return;

  try {
    // 1. Look up employee_id from telegram_chat_id
    const mapRes = await fetch(
      `${url}/rest/v1/massivlust_telegram_chat_map?select=employee_id&telegram_chat_id=eq.${chatIdNum}&active=eq.true&limit=1`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      },
    );
    if (!mapRes.ok) return;
    const mappingRows = (await mapRes.json()) as Array<{ employee_id: string }>;
    const employeeId = mappingRows?.[0]?.employee_id;
    if (!employeeId) return; // chat not linked — skip

    // 2. Insert message row
    await fetch(`${url}/rest/v1/massivlust_agent_messages`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        employee_id: employeeId,
        agent_id: params.agentName,
        direction: params.direction,
        text: params.text,
        telegram_chat_id: chatIdNum,
        telegram_msg_id: params.messageId ?? null,
        metadata: params.metadata ?? {},
      }),
    });
  } catch {
    // Never throw — mirror must not break message processing
  }
}

/**
 * Optional metadata attached to an outbound Telegram message log entry.
 * Fields are all optional so existing callers that pass nothing still
 * produce the same JSONL shape as before this extension.
 *
 * - `parseMode`: which parse_mode the first send attempt used. "html"
 *   for the default path (Markdown-to-HTML conversion), "none" when the
 *   caller used --plain-text.
 */
export interface OutboundLogMetadata {
  parseMode?: 'html' | 'none';
}

/**
 * Append an outbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/outbound-messages.jsonl
 */
export function logOutboundMessage(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  messageId: number,
  metadata?: OutboundLogMetadata,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  // Only emit metadata fields that were actually set so the base log shape
  // stays unchanged for callers that pass nothing (backwards compat).
  const meta: Record<string, unknown> = {};
  if (metadata?.parseMode !== undefined) meta.parse_mode = metadata.parseMode;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
    chat_id: String(chatId),
    text,
    message_id: messageId,
    ...meta,
  });

  appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n', 'utf-8');

  // Mirror to Supabase for dashboard live-sync. Best-effort, fire-and-forget.
  mirrorToSupabase({
    chatId,
    agentName,
    direction: 'outbound',
    text,
    messageId,
    metadata: meta,
  }).catch(() => { /* swallow — already logged inside */ });
}

/**
 * Append an inbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/inbound-messages.jsonl
 */
export function logInboundMessage(
  ctxRoot: string,
  agentName: string,
  rawMessage: object,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  const entry = JSON.stringify({
    ...rawMessage,
    archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
  });

  appendFileSync(join(logDir, 'inbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * Persist an inbound Telegram message to the daemon's JSONL archive AND
 * emit a `message/telegram_received` bus event so dashboards and
 * experiment cycles can count fleet-wide inbound traffic. Symmetric with
 * `telegram_sent` emitted from the outbound path in `cortextos bus
 * send-telegram`.
 *
 * Wrapped: a logEvent failure (e.g. unwritable analytics dir) must not
 * break message processing — the logged inbound JSONL still goes through.
 */
export function recordInboundTelegram(
  paths: BusPaths,
  ctxRoot: string,
  agentName: string,
  org: string,
  fromName: string,
  msg: TelegramMessage,
  log?: (m: string) => void,
): void {
  const text = (msg.text || msg.caption || '').toString();
  logInboundMessage(ctxRoot, agentName, {
    message_id: msg.message_id,
    from: msg.from?.id,
    from_name: fromName,
    chat_id: msg.chat?.id,
    text,
    timestamp: new Date().toISOString(),
  });

  const hasMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
  try {
    logEvent(paths, agentName, org, 'message', 'telegram_received', 'info', {
      chat_id: String(msg.chat?.id ?? ''),
      message_id: msg.message_id,
      from_id: msg.from?.id,
      from_name: fromName,
      has_media: hasMedia,
      text_chars: text.length,
    });
  } catch (err) {
    log?.(`logEvent(telegram_received) failed: ${err}`);
  }

  // Mirror to Supabase for dashboard live-sync. Best-effort.
  if (msg.chat?.id !== undefined) {
    mirrorToSupabase({
      chatId: msg.chat.id,
      agentName,
      direction: 'inbound',
      text,
      messageId: msg.message_id,
      metadata: { from_name: fromName, has_media: hasMedia },
    }).catch(() => { /* swallow */ });
  }
}

/**
 * Cache the last-sent text for a given chat.
 * Path: {ctxRoot}/state/{agentName}/last-telegram-{chatId}.txt
 */
export function cacheLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
): void {
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `last-telegram-${chatId}.txt`), text, 'utf-8');
}

/**
 * Read the last-sent text for a given chat, or null if not cached.
 */
export function readLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): string | null {
  const filePath = join(ctxRoot, 'state', agentName, `last-telegram-${chatId}.txt`);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last cputime         unlimited
filesize        unlimited
datasize        unlimited
stacksize       7MB


/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last `limit` messages (combined inbound + outbound) for the
 * given agent/chatId, sorts by timestamp, and returns a formatted string.
 * Returns null if no history is available.
 */
export function buildRecentHistory(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  limit: number = 6,
  excludeInboundText?: string,
): string | null {
  const logDir = join(ctxRoot, 'logs', agentName);
  const inboundPath = join(logDir, 'inbound-messages.jsonl');
  const outboundPath = join(logDir, 'outbound-messages.jsonl');
  const chatIdStr = String(chatId);

  interface Entry { ts: string; speaker: string; text: string; }
  const entries: Entry[] = [];

  const readLines = (filePath: string, speaker: string) => {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (!raw) return;
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-(limit * 2));
      for (const line of tail) {
        try {
          const obj = JSON.parse(line);
          if (String(obj.chat_id) !== chatIdStr) continue;
          const text = (obj.text || '').trim();
          if (!text) continue;
          entries.push({ ts: obj.timestamp || obj.archived_at || '', speaker, text });
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  };

  readLines(inboundPath, process.env.ADMIN_USERNAME ?? 'user');
  readLines(outboundPath, agentName);

  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // Drop the trailing inbound entry if it matches the message we're about to
  // inject — otherwise the user sees their current message echoed inside
  // "[Recent conversation:]" AND as the new "[user]:" line below it.
  if (excludeInboundText) {
    const trimmedExclude = excludeInboundText.trim();
    while (entries.length > 0) {
      const last = entries[entries.length - 1];
      if (last.text === trimmedExclude) {
        entries.pop();
      } else {
        break;
      }
    }
  }

  const recent = entries.slice(-limit);

  const formatted = recent.map(e => {
    const preview = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text;
    return '[' + e.speaker + ']: ' + preview;
  });

  return formatted.join('\n');
}
