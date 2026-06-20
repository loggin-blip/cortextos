import { describe, it, expect } from 'vitest';
import {
  shouldEmitLine,
  splitChunk,
  TerminalStreamer,
  BATCH_WINDOW_MS,
  MIN_SEND_INTERVAL_MS,
  MAX_MESSAGE_CHARS,
} from '../src/pty/terminal-stream.js';

describe('terminal-stream filter — shouldEmitLine', () => {
  describe('drops noise', () => {
    it('drops empty lines', () => {
      expect(shouldEmitLine('')).toBe(false);
      expect(shouldEmitLine('   ')).toBe(false);
      expect(shouldEmitLine('\t\t')).toBe(false);
    });

    it('drops Anthropic cost / usage telemetry lines', () => {
      expect(shouldEmitLine('Tokens: in:1234 out:567')).toBe(false);
      expect(shouldEmitLine('  Tokens: in:42 out:100')).toBe(false);
      expect(shouldEmitLine('Total tokens: 4567')).toBe(false);
      expect(shouldEmitLine('$0.12 session cost')).toBe(false);
      expect(shouldEmitLine('Cost: $1.45')).toBe(false);
      expect(shouldEmitLine('Session cost: $3.21')).toBe(false);
    });

    it('drops cache hit/miss telemetry', () => {
      expect(shouldEmitLine('cache_read_input_tokens: 1234')).toBe(false);
      expect(shouldEmitLine('cache_creation_input_tokens: 100')).toBe(false);
      expect(shouldEmitLine('cache hit: 99%')).toBe(false);
      expect(shouldEmitLine('Cache miss on this turn')).toBe(false);
      expect(shouldEmitLine('cached tokens: 500')).toBe(false);
    });

    it('drops burn-rate / context banner lines', () => {
      expect(shouldEmitLine('Usage: 42%')).toBe(false);
      expect(shouldEmitLine('Context: 71%')).toBe(false);
    });

    it('drops braille spinner glyph lines', () => {
      // Common ora spinner glyphs.
      expect(shouldEmitLine('⠋ thinking...')).toBe(false);
      expect(shouldEmitLine('⠙ working')).toBe(false);
      expect(shouldEmitLine('⠹')).toBe(false);
      // Whole braille range:
      expect(shouldEmitLine('⣿ done')).toBe(false);
    });

    it('drops pure-ANSI lines (no visible text after stripping)', () => {
      expect(shouldEmitLine('\x1b[2K\x1b[1A')).toBe(false);
      expect(shouldEmitLine('\x1b[0m')).toBe(false);
    });
  });

  describe('keeps signal', () => {
    it('keeps tool invocation lines', () => {
      expect(shouldEmitLine('● Bash(ls -la)')).toBe(true);
      expect(shouldEmitLine('  ⎿  Running Read(/tmp/foo.txt)')).toBe(true);
      expect(shouldEmitLine('Calling Edit on /src/foo.ts')).toBe(true);
    });

    it('keeps tool result / output lines', () => {
      expect(shouldEmitLine('  File written: /tmp/output.json (1234 bytes)')).toBe(true);
      expect(shouldEmitLine('   42 files matched pattern')).toBe(true);
    });

    it('keeps error and warning lines', () => {
      expect(shouldEmitLine('ERROR: connection refused')).toBe(true);
      expect(shouldEmitLine('WARN: deprecated API used')).toBe(true);
      expect(shouldEmitLine('Error: file not found')).toBe(true);
    });

    it('keeps rate-limit notices from Anthropic API', () => {
      expect(shouldEmitLine('429: rate limit exceeded — retry in 60s')).toBe(true);
      expect(shouldEmitLine('Anthropic API: rate_limit_error')).toBe(true);
    });

    it('keeps MCP server errors / connection issues', () => {
      expect(shouldEmitLine('MCP server claude_ai_Supabase failed to connect')).toBe(true);
      expect(shouldEmitLine('mcp: tool call returned error')).toBe(true);
    });

    it('keeps assistant text lines', () => {
      expect(shouldEmitLine("I'll start by reading the file.")).toBe(true);
      expect(shouldEmitLine('Let me check the config.')).toBe(true);
    });

    it('keeps bus command output', () => {
      expect(shouldEmitLine('msg_abc123')).toBe(true);
      expect(shouldEmitLine("ACK'd msg_xyz789")).toBe(true);
    });

    it("keeps lines containing '$' that are NOT cost telemetry", () => {
      // Random dollar sign in code or filenames shouldn't trigger the cost filter.
      expect(shouldEmitLine('echo $HOME')).toBe(true);
      expect(shouldEmitLine("const price = '$5.00';")).toBe(true);
    });

    it('strips ANSI before deciding (visible text survives)', () => {
      expect(shouldEmitLine('\x1b[31mERROR: boom\x1b[0m')).toBe(true);
      expect(shouldEmitLine('\x1b[1mBold text\x1b[0m')).toBe(true);
    });
  });
});

describe('terminal-stream splitChunk', () => {
  it('splits on newlines and carries unterminated tail', () => {
    const r1 = splitChunk('line one\nline two\nincomplete');
    expect(r1.lines).toEqual(['line one', 'line two']);
    expect(r1.tail).toBe('incomplete');

    const r2 = splitChunk(' tail finished\n');
    // 'incomplete' + ' tail finished' should compose at the call site —
    // splitChunk itself only sees what's handed in.
    expect(r2.lines).toEqual([' tail finished']);
    expect(r2.tail).toBe('');
  });

  it('normalizes CRLF to LF', () => {
    const r = splitChunk('a\r\nb\r\nc\r\n');
    expect(r.lines).toEqual(['a', 'b', 'c']);
    expect(r.tail).toBe('');
  });

  it('collapses spinner-style \\r redraws (keeps the last segment of a CR group)', () => {
    // A spinner emits: `⠋ wait\r⠙ wait\r⠹ wait\n`. We want to drop the whole
    // line as it's still a spinner — the LAST segment is braille so the
    // filter rejects it.
    const r = splitChunk('⠋ wait\r⠙ wait\r⠹ wait\n');
    expect(r.lines).toEqual([]);
  });

  it('keeps the last CR segment when it is real signal', () => {
    // `\rprogress: 100% done\n` — final segment is meaningful text.
    const r = splitChunk('progress: 10%\rprogress: 100% done\n');
    expect(r.lines).toEqual(['progress: 100% done']);
  });

  it('drops noise lines while keeping signal lines in the same chunk', () => {
    const r = splitChunk(
      'Tokens: in:123 out:45\n' +
      'ERROR: something failed\n' +
      'cache hit: 99%\n' +
      'Calling Read(/tmp/foo)\n',
    );
    expect(r.lines).toEqual([
      'ERROR: something failed',
      'Calling Read(/tmp/foo)',
    ]);
  });
});

describe('terminal-stream constants (sanity check, prevents accidental tuning regressions)', () => {
  it('batches inside 1s and rate-limits at 1s per chat (TG Bot API safety)', () => {
    expect(BATCH_WINDOW_MS).toBeLessThanOrEqual(MIN_SEND_INTERVAL_MS);
    expect(MIN_SEND_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
  });

  it('caps message body well under Telegram 4096-char hard limit', () => {
    // 4000 leaves room for the ```\n ... \n``` wrapper.
    expect(MAX_MESSAGE_CHARS).toBeLessThanOrEqual(4096);
  });
});

describe('TerminalStreamer batching + rate-limit behavior', () => {
  /**
   * Minimal fake of just the sendMessage surface TerminalStreamer uses.
   * Records each (chatId, text) and resolves immediately.
   */
  function makeFakeApi() {
    const sent: Array<{ chatId: string | number; text: string }> = [];
    const api = {
      sendMessage: async (chatId: string | number, text: string) => {
        sent.push({ chatId, text });
        return { ok: true };
      },
    };
    return { api: api as any, sent };
  }

  async function tick(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  it('batches lines arriving within the window into a single message', async () => {
    const { api, sent } = makeFakeApi();
    const s = new TerminalStreamer(api, '12345', 'test-agent', () => {});

    s.push('line one\n');
    s.push('line two\n');
    s.push('line three\n');

    // Nothing sent yet — still inside the batch window.
    expect(sent.length).toBe(0);

    // Wait long enough for the batch flush to fire.
    await tick(BATCH_WINDOW_MS + 50);

    expect(sent.length).toBe(1);
    expect(sent[0].chatId).toBe('12345');
    // Triple-backtick wrapped, joined by newlines.
    expect(sent[0].text.startsWith('```\n')).toBe(true);
    expect(sent[0].text.endsWith('\n```')).toBe(true);
    expect(sent[0].text).toContain('line one');
    expect(sent[0].text).toContain('line two');
    expect(sent[0].text).toContain('line three');

    s.dispose();
  });

  it('filters out drop-pattern lines before sending', async () => {
    const { api, sent } = makeFakeApi();
    const s = new TerminalStreamer(api, '12345', 'test-agent', () => {});

    s.push('Tokens: in:1 out:2\n');         // dropped
    s.push('ERROR: real signal\n');           // kept
    s.push('cache hit: 50%\n');               // dropped

    await tick(BATCH_WINDOW_MS + 50);

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('ERROR: real signal');
    expect(sent[0].text).not.toContain('Tokens:');
    expect(sent[0].text).not.toContain('cache hit');

    s.dispose();
  });

  it('does not send when all lines in the batch are filtered noise', async () => {
    const { api, sent } = makeFakeApi();
    const s = new TerminalStreamer(api, '12345', 'test-agent', () => {});

    s.push('Tokens: in:1 out:2\n');
    s.push('cache hit\n');
    s.push('Cost: $0.05\n');

    await tick(BATCH_WINDOW_MS + 50);

    expect(sent.length).toBe(0);
    s.dispose();
  });

  it('truncates very large bursts to MAX_MESSAGE_CHARS keeping the tail', async () => {
    const { api, sent } = makeFakeApi();
    const s = new TerminalStreamer(api, '12345', 'test-agent', () => {});

    // Build a giant burst — many distinct lines, each ~100 chars.
    const big = Array.from({ length: 200 }, (_, i) => `line ${i.toString().padStart(4, '0')} ${'x'.repeat(90)}`).join('\n');
    s.push(big + '\n');

    await tick(BATCH_WINDOW_MS + 50);

    expect(sent.length).toBe(1);
    // The wrapped message length should be just over MAX_MESSAGE_CHARS (wrapper + marker).
    expect(sent[0].text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS + 20);
    expect(sent[0].text).toContain('[...truncated]');
    // The tail (most recent lines) is preserved — `line 0199` should land.
    expect(sent[0].text).toContain('line 0199');
    // The head should be gone.
    expect(sent[0].text).not.toContain('line 0000');

    s.dispose();
  });

  it('dispose drops pending work and stops timers', async () => {
    const { api, sent } = makeFakeApi();
    const s = new TerminalStreamer(api, '12345', 'test-agent', () => {});

    s.push('line that would otherwise flush\n');
    s.dispose();

    await tick(BATCH_WINDOW_MS + 50);
    expect(sent.length).toBe(0);
  });

  it('never throws into the caller on TG send failure', async () => {
    const failingApi = {
      sendMessage: async () => {
        throw new Error('telegram down');
      },
    };
    const errs: string[] = [];
    const s = new TerminalStreamer(failingApi as any, '12345', 'test-agent', (m) => errs.push(m));

    expect(() => s.push('boom\n')).not.toThrow();

    await tick(BATCH_WINDOW_MS + 100);
    // Error surfaces via the log function, not as a thrown exception.
    expect(errs.some((m) => m.includes('sendMessage failed'))).toBe(true);

    s.dispose();
  });

  it('rate-limits bursts to MIN_SEND_INTERVAL_MS per chat (no Bot API flood)', async () => {
    const { api, sent } = makeFakeApi();
    const s = new TerminalStreamer(api, '12345', 'test-agent', () => {});

    // First burst.
    s.push('first burst\n');
    await tick(BATCH_WINDOW_MS + 50);
    expect(sent.length).toBe(1);

    // Second burst immediately after the first send — must NOT send until
    // MIN_SEND_INTERVAL_MS has elapsed since lastSendAt.
    s.push('second burst\n');
    await tick(BATCH_WINDOW_MS + 50);
    // We're now ~550-600ms past the first send; the rate-limit drain timer
    // should have armed but not fired.
    expect(sent.length).toBe(1);

    // Wait out the rest of the rate-limit window.
    await tick(MIN_SEND_INTERVAL_MS);
    expect(sent.length).toBe(2);
    expect(sent[1].text).toContain('second burst');

    s.dispose();
  });

  it('coalesces lines arriving close together into one batch (no per-line spam)', async () => {
    // Stronger guarantee than the basic batching test: even if pushes are
    // staggered across hundreds of ms inside the batch window, we still
    // emit ONE message (not one per push). This is the load-bearing
    // anti-spam property that protects the Bot API rate limit.
    const { api, sent } = makeFakeApi();
    const s = new TerminalStreamer(api, '12345', 'test-agent', () => {});

    // Five staggered pushes, all inside the batch window.
    s.push('first\n');
    await tick(50);
    s.push('second\n');
    await tick(50);
    s.push('third\n');
    await tick(50);
    s.push('fourth\n');
    await tick(50);
    s.push('fifth\n');

    // Flush at end of batch window.
    await tick(BATCH_WINDOW_MS + 50);

    expect(sent.length).toBe(1);
    for (const line of ['first', 'second', 'third', 'fourth', 'fifth']) {
      expect(sent[0].text).toContain(line);
    }

    s.dispose();
  });
});
