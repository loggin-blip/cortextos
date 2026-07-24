import { existsSync, openSync, readSync, closeSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Read the last `maxBytes` bytes of a file synchronously without loading
 * the whole file into memory. Returns "" for missing files, unreadable
 * files, or any I/O error.
 *
 * Extracted from AgentProcess.tailStdoutLog() so watchdog scanners can
 * share the same bounded-window read primitive.
 */
export function tailFile(path: string, maxBytes: number): string {
  try {
    if (!existsSync(path)) return '';
    const stats = statSync(path);
    if (stats.size === 0) return '';
    const start = Math.max(0, stats.size - maxBytes);
    const len = stats.size - start;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, start);
      return buf.toString('utf-8', 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Read the last non-empty JSONL entry from a file by scanning up to 8 KB
 * from EOF. Returns `null` if the file is missing, empty, or the last line
 * fails to JSON.parse. Also returns the file's mtime for staleness checks.
 *
 * Used by AgentWatchdog to correlate the tail of stdout with the most
 * recent outbound/inbound message activity — a compact-stall diagnosis
 * hinges on comparing the two.
 */
export function readLastJsonlLine(
  path: string,
): { line: string; parsed: unknown; mtime: number } | null {
  try {
    if (!existsSync(path)) return null;
    const stats = statSync(path);
    if (stats.size === 0) return null;

    const tail = tailFile(path, 8192);
    if (!tail) return null;

    // Split on newline, drop trailing empty entries, take the last non-empty
    // token. JSONL is line-delimited so this is always the most recent full
    // entry unless the writer crashed mid-line.
    const lines = tail.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const line = lines[lines.length - 1];
    try {
      const parsed = JSON.parse(line);
      return { line, parsed, mtime: stats.mtimeMs };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Read the tail of an agent's stdout across a single rotation boundary.
 * Reads `<baseDir>/<name>/stdout.log` (up to `maxBytes`) plus, if present,
 * `<baseDir>/<name>/stdout.log.1` — concatenated with the rotated file
 * first so pattern scans see the older bytes first. Missing files are
 * silently ignored (returns "" if neither exists).
 *
 * Rotation-aware because usage-limit stack traces often straddle the
 * rotation boundary — the pattern may live in log.1 while log.0 has
 * nothing but "Compacting…" spam.
 */
export function readLogTailAcrossRotation(
  baseDir: string,
  name: string,
  maxBytes: number,
): string {
  const logPath = join(baseDir, name, 'stdout.log');
  const rotatedPath = join(baseDir, name, 'stdout.log.1');

  const rotatedTail = existsSync(rotatedPath) ? tailFile(rotatedPath, maxBytes) : '';
  const currentTail = existsSync(logPath) ? tailFile(logPath, maxBytes) : '';

  if (!rotatedTail && !currentTail) return '';
  return rotatedTail + currentTail;
}
