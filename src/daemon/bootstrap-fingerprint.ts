/**
 * Bootstrap fingerprint cache.
 *
 * Records the mtime of the bootstrap files an agent reads on session start.
 * On --continue restarts, compare the current fingerprint against the stored
 * one — if nothing has changed, the agent's startup prompt can tell it to
 * skip re-reading bootstrap files (they're already in context from the
 * preserved conversation history).
 *
 * Expected saving: ~10-15k tokens per --continue restart per agent when the
 * agent's bootstrap files haven't changed since last session.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files whose mtime is hashed to form the bootstrap fingerprint.
 * Ordering matters — keep stable so the hash is comparable across sessions.
 */
const BOOTSTRAP_FILES = [
  'AGENTS.md',
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'GOALS.md',
  'MEMORY.md',
];

export interface BootstrapFingerprint {
  /** ISO timestamp of when this fingerprint was written. */
  generated_at: string;
  /** Map of filename (relative to agent dir) to mtime-ms. Missing files are omitted. */
  files: Record<string, number>;
  /** YYYY-MM-DD of when the agent last ran (to detect date-rollover). */
  date: string;
}

/**
 * Compute the bootstrap fingerprint for an agent directory.
 * Returns mtime of each BOOTSTRAP_FILE + the agent's daily memory file for today.
 */
export function computeBootstrapFingerprint(agentDir: string): BootstrapFingerprint {
  const files: Record<string, number> = {};

  for (const rel of BOOTSTRAP_FILES) {
    const fullPath = join(agentDir, rel);
    try {
      if (existsSync(fullPath)) {
        files[rel] = Math.floor(statSync(fullPath).mtimeMs);
      }
    } catch {
      // File access error — omit this entry, still record what we can
    }
  }

  // Today's daily memory (if exists) — changes every day
  const today = new Date().toISOString().slice(0, 10);
  const dailyMem = join(agentDir, 'memory', `${today}.md`);
  try {
    if (existsSync(dailyMem)) {
      files[`memory/${today}.md`] = Math.floor(statSync(dailyMem).mtimeMs);
    }
  } catch {
    // non-fatal
  }

  return {
    generated_at: new Date().toISOString(),
    files,
    date: today,
  };
}

/**
 * Read a previously-written fingerprint from state. Returns null if absent or unparseable.
 */
export function readBootstrapFingerprint(stateDir: string): BootstrapFingerprint | null {
  const path = join(stateDir, 'bootstrap-fingerprint.json');
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as BootstrapFingerprint;
    if (!data.files || typeof data.files !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Persist a fingerprint to state.
 */
export function writeBootstrapFingerprint(stateDir: string, fp: BootstrapFingerprint): void {
  const path = join(stateDir, 'bootstrap-fingerprint.json');
  try {
    writeFileSync(path, JSON.stringify(fp, null, 2));
  } catch {
    // non-fatal — next session just re-reads as if fingerprint is missing
  }
}

/**
 * Compare two fingerprints. Returns:
 *   - unchanged: no file-mtime drift AND same date
 *   - changed: list of files that differ (and/or date-rollover)
 *   - missing-prior: no stored fingerprint to compare
 */
export type FingerprintComparison =
  | { status: 'unchanged' }
  | { status: 'changed'; changedFiles: string[]; dateRollover: boolean }
  | { status: 'missing-prior' };

export function compareBootstrapFingerprints(
  current: BootstrapFingerprint,
  stored: BootstrapFingerprint | null,
): FingerprintComparison {
  if (!stored) return { status: 'missing-prior' };

  const changedFiles: string[] = [];
  const dateRollover = current.date !== stored.date;

  // Check each file in current — changed if absent in stored OR mtime differs
  for (const [file, mtime] of Object.entries(current.files)) {
    if (stored.files[file] !== mtime) {
      changedFiles.push(file);
    }
  }
  // Check for files present in stored but missing in current (deleted)
  for (const file of Object.keys(stored.files)) {
    if (!(file in current.files)) {
      changedFiles.push(file);
    }
  }

  if (changedFiles.length === 0 && !dateRollover) {
    return { status: 'unchanged' };
  }
  return { status: 'changed', changedFiles, dateRollover };
}
