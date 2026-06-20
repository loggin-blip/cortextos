import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Event } from '../types/index.js';

/**
 * KB ingest filter — Phase 1 allowlist/denylist shim.
 *
 * Gates which events become KB chunks. The full event log on disk is
 * untouched; this filter only affects the log-event → KB ingest pathway.
 *
 * See `deliverables/kb-log-event-allowlist-v1.md` (westside-hq) for the
 * policy analysis, and `deliverables/kb-ingest-shim-implementation-spec.md`
 * for the design rationale.
 *
 * Default posture: deny unknown events. The allowlist carries events with
 * retrieval value (decisions, approvals, merges, learnings). The denylist
 * carries noisy auto-emitted routing/metadata events. Gray-zone events are
 * evaluated against per-event heuristics (e.g. minimum result length for
 * task_completed).
 */

export interface GrayZoneRule {
  /** Minimum length required on `metadata[field]` (default field: "result"). */
  minResultLen?: number;
  /** Metadata fields that must be present and non-empty. */
  requiredFields?: string[];
}

export interface KbIngestPolicy {
  version: string;
  denylist: string[];
  allowlist: string[];
  grayZonePolicy: Record<string, GrayZoneRule>;
  /** Prefix matching — any "<category>/<event>" starting with one of these is allowed. */
  patterns?: {
    allowlistPrefixes?: string[];
  };
  default: 'allow' | 'deny';
}

/**
 * Load the default policy shipped with the framework.
 * Path: src/bus/kb-ingest-policy.json (same directory as this module).
 */
export function loadDefaultPolicy(): KbIngestPolicy {
  // Resolve relative to the compiled JS location so it works in both
  // ts-node and built-dist modes.
  const here = dirname(fileURLToPath(import.meta.url));
  // In dev (ts-node) we're already in src/bus; in dist we're in dist/bus.
  // The JSON is shipped alongside this module in src/bus — for dist, a
  // build step should copy the JSON next to the compiled JS, or callers
  // can load their own policy file.
  const candidates = [
    join(here, 'kb-ingest-policy.json'),
    join(here, '..', '..', 'src', 'bus', 'kb-ingest-policy.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return parsePolicy(readFileSync(candidate, 'utf-8'));
    }
  }
  throw new Error(
    `kb-ingest-policy.json not found; searched: ${candidates.join(', ')}`,
  );
}

/**
 * Parse a policy JSON string with minimal validation.
 * Throws if required fields are missing or have the wrong shape.
 */
export function parsePolicy(raw: string): KbIngestPolicy {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('kb-ingest-policy: top-level must be an object');
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.version !== 'string') throw new Error('policy.version missing');
  if (!Array.isArray(p.denylist)) throw new Error('policy.denylist missing');
  if (!Array.isArray(p.allowlist)) throw new Error('policy.allowlist missing');
  if (p.default !== 'allow' && p.default !== 'deny') {
    throw new Error('policy.default must be "allow" or "deny"');
  }
  return {
    version: p.version,
    denylist: p.denylist as string[],
    allowlist: p.allowlist as string[],
    grayZonePolicy: (p.grayZonePolicy as Record<string, GrayZoneRule>) ?? {},
    patterns: p.patterns as KbIngestPolicy['patterns'],
    default: p.default,
  };
}

/**
 * Decide whether an event should become a KB chunk.
 *
 * Evaluation order:
 *  1. Denylist exact match → deny
 *  2. Allowlist exact match → allow
 *  3. Prefix match (patterns.allowlistPrefixes) → allow
 *  4. Gray-zone rules (by key) → allow only if metadata passes the rule
 *  5. Fallback to `policy.default`
 */
export function shouldIngestToKB(event: Event, policy: KbIngestPolicy): boolean {
  const key = `${event.category}/${event.event}`;

  if (policy.denylist.includes(key)) return false;
  if (policy.allowlist.includes(key)) return true;

  const prefixMatch = policy.patterns?.allowlistPrefixes?.some((prefix) =>
    key.startsWith(prefix),
  );
  if (prefixMatch) return true;

  const gray = policy.grayZonePolicy[key];
  if (gray) {
    const md = event.metadata ?? {};
    if (gray.minResultLen !== undefined) {
      const result = typeof md.result === 'string' ? md.result : '';
      if (result.length < gray.minResultLen) return false;
    }
    if (gray.requiredFields) {
      for (const field of gray.requiredFields) {
        const value = md[field];
        if (value === undefined || value === null || value === '') return false;
      }
    }
    return true;
  }

  return policy.default === 'allow';
}

/**
 * Classify an event into one of four explicit categories. Useful for
 * observability / debug-logging on each decision without re-deriving the
 * result from a boolean return.
 */
export type IngestDecision = 'allow_listed' | 'deny_listed' | 'gray_zone' | 'default_fallback';

export function classifyDecision(event: Event, policy: KbIngestPolicy): {
  allow: boolean;
  decision: IngestDecision;
} {
  const key = `${event.category}/${event.event}`;

  if (policy.denylist.includes(key)) {
    return { allow: false, decision: 'deny_listed' };
  }
  if (policy.allowlist.includes(key)) {
    return { allow: true, decision: 'allow_listed' };
  }
  const prefixMatch = policy.patterns?.allowlistPrefixes?.some((prefix) =>
    key.startsWith(prefix),
  );
  if (prefixMatch) {
    return { allow: true, decision: 'allow_listed' };
  }
  if (policy.grayZonePolicy[key]) {
    const allow = shouldIngestToKB(event, policy);
    return { allow, decision: 'gray_zone' };
  }
  return { allow: policy.default === 'allow', decision: 'default_fallback' };
}
