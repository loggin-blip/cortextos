/**
 * Terminal stream → Telegram.
 *
 * Mirrors filtered PTY output from an agent's terminal to a designated
 * Telegram chat in near-real-time. Lets an operator see what the agent is
 * actually doing (tool calls, errors, MCP rate limits, etc.) without
 * waiting for the agent to send a polished `bus send-telegram` message.
 *
 * Filtering rules (in `shouldEmitLine`) drop the noise that would make
 * the stream unreadable:
 *   - Anthropic cost/usage telemetry ("Tokens: in:X out:Y", "$0.XX session cost")
 *   - Cache hit/miss telemetry lines
 *   - Spinner / progress redraws (carriage-return overwrites, braille spinners)
 *   - Pure ANSI / whitespace-only lines
 *
 * Everything else passes through: tool invocations, results, errors,
 * warnings, rate-limit notices, bus output, assistant text. (Chain-of-
 * thought reasoning is not in the PTY stream — it stays in the JSONL trace.)
 *
 * Batching: lines that arrive within `BATCH_WINDOW_MS` of each other are
 * coalesced into a single Telegram message wrapped in triple-backticks.
 * Hard cap of one TG message per second per chat — if more bursts queue
 * up the older queue is coalesced + truncated at MAX_MESSAGE_CHARS with a
 * `[...truncated]` marker so we never spam the Bot API limit.
 *
 * This module is observability-only. It must NEVER throw into the PTY
 * data handler, must NEVER block on Telegram failures, and must NEVER
 * mutate the underlying PTY state.
 */

import type { TelegramAPI } from '../telegram/api.js';

/** Batch lines arriving within this window into a single TG message. */
export const BATCH_WINDOW_MS = 500;

/** Minimum interval between outbound TG messages per chat (rate-limit). */
export const MIN_SEND_INTERVAL_MS = 1000;

/** Truncate the final code-block body if it would exceed this many chars. */
export const MAX_MESSAGE_CHARS = 4000;

/** Pattern list for lines we DROP. Easy to extend — add a regex here. */
const DROP_PATTERNS: RegExp[] = [
  // Anthropic cost / usage telemetry. Claude Code prints these between turns.
  /^\s*Tokens:\s*in:/i,
  /^\s*Total tokens:/i,
  /\$\s*\d+\.\d{2,}\s*(session|total|cost|spent|usage)/i,
  /^\s*Cost:\s*\$/i,
  /^\s*Session cost:/i,
  /cache_(read|creation)_input_tokens/i,
  /cache (hit|miss)/i,
  /\bcached tokens?:/i,
  // Burn-rate / usage banners
  /^\s*Usage:\s+\d+%/i,
  /^\s*Context:\s+\d+%/i,
];

/**
 * Spinner / progress glyphs that show up in carriage-return redraws.
 * Braille dots are the standard ora/cli-spinners set.
 */
const SPINNER_GLYPHS = /[⠀-⣿]/; // Braille range covers ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ etc.

/** Inline ANSI stripper — same pattern OutputBuffer uses synchronously. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Decide whether a single line (already ANSI-stripped) should be emitted.
 *
 * Exported for direct unit testing — the filter is the load-bearing piece.
 */
export function shouldEmitLine(rawLine: string): boolean {
  // Strip ANSI defensively in case caller forgot.
  const line = stripAnsi(rawLine).replace(/\r/g, '').trimEnd();

  // Empty / whitespace-only → drop.
  if (line.trim().length === 0) return false;

  // Spinner braille glyphs → drop.
  if (SPINNER_GLYPHS.test(line)) return false;

  // Cost / usage / cache telemetry patterns → drop.
  for (const re of DROP_PATTERNS) {
    if (re.test(line)) return false;
  }

  return true;
}

/**
 * Split a raw PTY chunk into emittable lines.
 *
 * The PTY emits OS-buffered chunks that may be partial lines. We carry the
 * tail of an incomplete line across chunks via `splitChunk` callers in
 * `TerminalStreamer.push`. Carriage-return-only segments (spinner redraws
 * that overwrite the same line without a newline) are collapsed — we only
 * keep the final state of each `\r`-delimited group.
 *
 * Returns the emittable lines plus the unterminated tail (no trailing \n).
 */
export function splitChunk(chunk: string): { lines: string[]; tail: string } {
  // Normalize CRLF → LF, then keep raw \r so we can collapse spinner redraws.
  const normalized = chunk.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  const tail = parts.pop() ?? '';
  const lines: string[] = [];
  for (const part of parts) {
    // For \r-collapsed groups, keep only the last segment (typical spinner pattern).
    const segments = part.split('\r');
    const last = segments[segments.length - 1] ?? '';
    if (shouldEmitLine(last)) {
      lines.push(stripAnsi(last).replace(/\r/g, '').trimEnd());
    }
  }
  return { lines, tail };
}

/**
 * Stream batcher + sender. One instance per (agent, chat) target.
 *
 * Lifecycle: created when an agent starts with `terminal_stream.enabled`,
 * `dispose()`'d when the agent stops. `push(chunk)` is called from the
 * PTY onData handler — must be cheap and never throw.
 */
export class TerminalStreamer {
  private api: TelegramAPI;
  private chatId: string;
  private agentName: string;
  private logErr: (msg: string) => void;

  /** Carry-over tail of last chunk (incomplete line). */
  private tail: string = '';
  /** Lines waiting to be flushed in the next batch window. */
  private pending: string[] = [];
  /** Bursts waiting for the rate-limit window to elapse. */
  private queuedMessages: string[] = [];
  /** Wall-clock of last successful send (for rate limiting). */
  private lastSendAt: number = 0;
  /** Timer that fires the batch flush. */
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timer that drains the rate-limit queue. */
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set true on dispose to drop in-flight work. */
  private disposed: boolean = false;

  constructor(
    api: TelegramAPI,
    chatId: string,
    agentName: string,
    logErr?: (msg: string) => void,
  ) {
    this.api = api;
    this.chatId = chatId;
    this.agentName = agentName;
    this.logErr = logErr ?? ((m) => console.error(`[terminal-stream:${agentName}] ${m}`));
  }

  /**
   * Push a raw PTY data chunk. Never throws, never blocks.
   */
  push(chunk: string): void {
    if (this.disposed) return;
    try {
      const combined = this.tail + chunk;
      const { lines, tail } = splitChunk(combined);
      this.tail = tail;
      if (lines.length === 0) return;
      for (const line of lines) {
        this.pending.push(line);
      }
      this.scheduleBatchFlush();
    } catch (err) {
      // Defensive: filter or splitter should never throw, but if they do
      // we MUST NOT propagate into the PTY data handler.
      this.logErr(`push failed (non-fatal): ${err}`);
    }
  }

  /**
   * Stop the streamer, clear timers, drop queued work.
   * Does NOT flush remaining lines — agent is shutting down and any partial
   * output is best left for the next session.
   */
  dispose(): void {
    this.disposed = true;
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.pending = [];
    this.queuedMessages = [];
  }

  /**
   * Arm the batch flush timer if not already armed.
   */
  private scheduleBatchFlush(): void {
    if (this.batchTimer || this.disposed) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch();
    }, BATCH_WINDOW_MS);
  }

  /**
   * Move pending lines into the outbound queue + try to send.
   */
  private flushBatch(): void {
    if (this.pending.length === 0 || this.disposed) return;
    const body = this.pending.join('\n');
    this.pending = [];
    this.queuedMessages.push(body);
    this.trySend();
  }

  /**
   * Send the next queued message if the rate-limit window has elapsed.
   * Otherwise arm a drain timer for the remaining wait.
   */
  private trySend(): void {
    if (this.disposed || this.queuedMessages.length === 0) return;
    const now = Date.now();
    const elapsed = now - this.lastSendAt;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      if (!this.drainTimer) {
        this.drainTimer = setTimeout(() => {
          this.drainTimer = null;
          this.trySend();
        }, MIN_SEND_INTERVAL_MS - elapsed);
      }
      return;
    }

    // Coalesce all queued bursts into one message — the receiver only cares
    // about seeing the recent stream, not preserving per-burst boundaries.
    const merged = this.queuedMessages.join('\n');
    this.queuedMessages = [];

    const body = this.truncate(merged);
    const message = '```\n' + body + '\n```';
    this.lastSendAt = Date.now();

    // Fire-and-forget. We deliberately do NOT await; the PTY data handler
    // is synchronous and must stay so. Errors are logged, not propagated.
    this.api.sendMessage(this.chatId, message).catch((err) => {
      this.logErr(`sendMessage failed (non-fatal): ${err?.message ?? err}`);
    });

    // If new bursts queued between flushBatch and now, drain them on the
    // next window tick.
    if (this.queuedMessages.length > 0 && !this.drainTimer) {
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        this.trySend();
      }, MIN_SEND_INTERVAL_MS);
    }
  }

  /**
   * Truncate the body to fit inside MAX_MESSAGE_CHARS. Preserves the tail
   * (most recent output) since that's what an operator wants to see first.
   * Reserves room for the truncation marker.
   */
  private truncate(body: string): string {
    if (body.length <= MAX_MESSAGE_CHARS) return body;
    const marker = '[...truncated]\n';
    const keep = body.slice(body.length - (MAX_MESSAGE_CHARS - marker.length));
    return marker + keep;
  }
}
