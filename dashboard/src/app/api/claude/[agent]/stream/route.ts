import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';
import chokidar from 'chokidar';

export const dynamic = 'force-dynamic';

const ANSI_RE =
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[\?]?[0-9;]*[a-zA-Z]/g;

function clean(str: string): string {
  return str
    .replace(ANSI_RE, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\r/g, '');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
) {
  const { agent } = await params;

  if (!/^[\w-]+$/.test(agent)) {
    return new Response('Invalid agent name', { status: 400 });
  }

  const logFile = path.join(CTX_ROOT, 'logs', agent, 'stdout.log');
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // controller closed
        }
      };

      send({ type: 'connected', agent });

      // Send last ~60 KB of history
      let position = 0;
      try {
        const stat = fs.statSync(logFile);
        const histStart = Math.max(0, stat.size - 60_000);
        const len = stat.size - histStart;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(logFile, 'r');
        fs.readSync(fd, buf, 0, len, histStart);
        fs.closeSync(fd);
        const lines = clean(buf.toString('utf8')).split('\n');
        for (const line of lines) {
          if (line) send({ type: 'line', text: line });
        }
        position = stat.size;
      } catch {
        // log file doesn't exist yet — start watching from 0
      }

      send({ type: 'history_end' });

      // Watch for new bytes
      const watcher = chokidar.watch(logFile, {
        usePolling: false,
        awaitWriteFinish: false,
        ignoreInitial: true,
      });

      watcher.on('add', () => {
        // file just created — reset position
        position = 0;
      });

      watcher.on('change', () => {
        try {
          const stat = fs.statSync(logFile);
          if (stat.size <= position) return;
          const len = stat.size - position;
          const buf = Buffer.alloc(len);
          const fd = fs.openSync(logFile, 'r');
          fs.readSync(fd, buf, 0, len, position);
          fs.closeSync(fd);
          position = stat.size;
          const lines = clean(buf.toString('utf8')).split('\n');
          for (const line of lines) {
            if (line) send({ type: 'line', text: line });
          }
        } catch {
          // file temporarily unavailable
        }
      });

      // Keepalive ping every 20 s
      const ping = setInterval(() => send({ type: 'ping' }), 20_000);

      request.signal.addEventListener('abort', () => {
        clearInterval(ping);
        watcher.close();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
