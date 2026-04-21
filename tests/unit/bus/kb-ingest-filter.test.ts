import { describe, it, expect } from 'vitest';
import type { Event } from '../../../src/types/index.js';
import {
  shouldIngestToKB,
  classifyDecision,
  parsePolicy,
  type KbIngestPolicy,
} from '../../../src/bus/kb-ingest-filter.js';

const basePolicy: KbIngestPolicy = {
  version: '1.0',
  denylist: [
    'heartbeat/heartbeat',
    'heartbeat/agent_heartbeat',
    'message/agent_message_sent',
    'message/telegram_sent',
    'action/session_start',
    'task/task_created',
  ],
  allowlist: [
    'action/decision_made',
    'action/approval_created',
    'action/approval_resolved',
    'action/merge_applied',
    'action/theta_wave_completed',
  ],
  grayZonePolicy: {
    'task/task_completed': { minResultLen: 20, requiredFields: ['result'] },
    'task/task_blocked': { requiredFields: ['blocker_reason'] },
  },
  patterns: {
    allowlistPrefixes: ['action/L_'],
  },
  default: 'deny',
};

function makeEvent(
  category: Event['category'],
  event: string,
  metadata: Record<string, unknown> = {},
): Event {
  return {
    id: 'evt-1',
    agent: 'nordflo-dev',
    org: 'westside-hq',
    timestamp: '2026-04-21T08:00:00Z',
    category,
    event,
    severity: 'info',
    metadata,
  };
}

describe('shouldIngestToKB', () => {
  it('denies heartbeat events (auto-emit noise)', () => {
    expect(
      shouldIngestToKB(makeEvent('heartbeat', 'heartbeat'), basePolicy),
    ).toBe(false);
    expect(
      shouldIngestToKB(makeEvent('heartbeat', 'agent_heartbeat'), basePolicy),
    ).toBe(false);
  });

  it('denies inter-agent message metadata', () => {
    expect(
      shouldIngestToKB(
        makeEvent('message', 'agent_message_sent', {
          to: 'kaptein',
          priority: 'normal',
        }),
        basePolicy,
      ),
    ).toBe(false);
  });

  it('allows explicit decision events', () => {
    expect(
      shouldIngestToKB(makeEvent('action', 'decision_made'), basePolicy),
    ).toBe(true);
  });

  it('allows approval lifecycle events', () => {
    expect(
      shouldIngestToKB(makeEvent('action', 'approval_created'), basePolicy),
    ).toBe(true);
    expect(
      shouldIngestToKB(makeEvent('action', 'approval_resolved'), basePolicy),
    ).toBe(true);
  });

  describe('gray-zone: task/task_completed', () => {
    it('denies when result is missing', () => {
      expect(
        shouldIngestToKB(makeEvent('task', 'task_completed', {}), basePolicy),
      ).toBe(false);
    });

    it('denies when result is shorter than minResultLen', () => {
      expect(
        shouldIngestToKB(
          makeEvent('task', 'task_completed', { result: 'done' }),
          basePolicy,
        ),
      ).toBe(false);
    });

    it('allows when result is substantial', () => {
      expect(
        shouldIngestToKB(
          makeEvent('task', 'task_completed', {
            result:
              'Completed nordflo WF5 debug after DB revert and Switch rule fix',
          }),
          basePolicy,
        ),
      ).toBe(true);
    });

    it('denies when result is non-string (e.g. null)', () => {
      expect(
        shouldIngestToKB(
          makeEvent('task', 'task_completed', { result: null }),
          basePolicy,
        ),
      ).toBe(false);
    });
  });

  describe('gray-zone: task/task_blocked', () => {
    it('denies when blocker_reason is missing', () => {
      expect(
        shouldIngestToKB(makeEvent('task', 'task_blocked', {}), basePolicy),
      ).toBe(false);
    });

    it('allows when blocker_reason is present', () => {
      expect(
        shouldIngestToKB(
          makeEvent('task', 'task_blocked', {
            blocker_reason: 'waiting on Max approval',
          }),
          basePolicy,
        ),
      ).toBe(true);
    });

    it('denies when blocker_reason is empty string', () => {
      expect(
        shouldIngestToKB(
          makeEvent('task', 'task_blocked', { blocker_reason: '' }),
          basePolicy,
        ),
      ).toBe(false);
    });
  });

  describe('pattern-based allowlist', () => {
    it('allows action/L_* events via prefix match', () => {
      expect(
        shouldIngestToKB(
          makeEvent('action', 'L_011_cron_gap_feedback_loop'),
          basePolicy,
        ),
      ).toBe(true);
      expect(
        shouldIngestToKB(
          makeEvent('action', 'L_042_new_finding'),
          basePolicy,
        ),
      ).toBe(true);
    });

    it('does not allow random action events just because they contain L_', () => {
      // Prefix is "action/L_" — a stray "look_up" should NOT match
      expect(
        shouldIngestToKB(makeEvent('action', 'look_up'), basePolicy),
      ).toBe(false);
    });
  });

  describe('default fallback', () => {
    it('default-denies unknown events', () => {
      expect(
        shouldIngestToKB(
          makeEvent('action', 'never_seen_before'),
          basePolicy,
        ),
      ).toBe(false);
    });

    it('respects default: allow when configured', () => {
      const permissive: KbIngestPolicy = { ...basePolicy, default: 'allow' };
      expect(
        shouldIngestToKB(
          makeEvent('action', 'never_seen_before'),
          permissive,
        ),
      ).toBe(true);
    });

    it('denylist wins over default:allow', () => {
      const permissive: KbIngestPolicy = { ...basePolicy, default: 'allow' };
      expect(
        shouldIngestToKB(makeEvent('heartbeat', 'heartbeat'), permissive),
      ).toBe(false);
    });
  });
});

describe('classifyDecision', () => {
  it('tags denylist hits', () => {
    const res = classifyDecision(
      makeEvent('heartbeat', 'heartbeat'),
      basePolicy,
    );
    expect(res).toEqual({ allow: false, decision: 'deny_listed' });
  });

  it('tags allowlist hits', () => {
    const res = classifyDecision(
      makeEvent('action', 'decision_made'),
      basePolicy,
    );
    expect(res).toEqual({ allow: true, decision: 'allow_listed' });
  });

  it('tags gray-zone pass', () => {
    const res = classifyDecision(
      makeEvent('task', 'task_completed', {
        result: 'A sufficiently long task result describing what was done',
      }),
      basePolicy,
    );
    expect(res).toEqual({ allow: true, decision: 'gray_zone' });
  });

  it('tags gray-zone fail', () => {
    const res = classifyDecision(
      makeEvent('task', 'task_completed', { result: 'nope' }),
      basePolicy,
    );
    expect(res).toEqual({ allow: false, decision: 'gray_zone' });
  });

  it('tags default fallback', () => {
    const res = classifyDecision(
      makeEvent('action', 'brand_new_event'),
      basePolicy,
    );
    expect(res).toEqual({ allow: false, decision: 'default_fallback' });
  });

  it('tags L_* prefix as allow_listed', () => {
    const res = classifyDecision(
      makeEvent('action', 'L_099_hypothetical'),
      basePolicy,
    );
    expect(res).toEqual({ allow: true, decision: 'allow_listed' });
  });
});

describe('parsePolicy', () => {
  it('accepts minimal valid policy', () => {
    const raw = JSON.stringify({
      version: '1.0',
      denylist: [],
      allowlist: [],
      default: 'deny',
    });
    const p = parsePolicy(raw);
    expect(p.version).toBe('1.0');
    expect(p.default).toBe('deny');
    expect(p.grayZonePolicy).toEqual({});
  });

  it('rejects missing version', () => {
    const raw = JSON.stringify({ denylist: [], allowlist: [], default: 'deny' });
    expect(() => parsePolicy(raw)).toThrow(/version/);
  });

  it('rejects invalid default', () => {
    const raw = JSON.stringify({
      version: '1.0',
      denylist: [],
      allowlist: [],
      default: 'sometimes',
    });
    expect(() => parsePolicy(raw)).toThrow(/default/);
  });

  it('preserves grayZonePolicy and patterns', () => {
    const raw = JSON.stringify({
      version: '1.0',
      denylist: [],
      allowlist: [],
      grayZonePolicy: { 'task/task_completed': { minResultLen: 30 } },
      patterns: { allowlistPrefixes: ['action/L_'] },
      default: 'deny',
    });
    const p = parsePolicy(raw);
    expect(p.grayZonePolicy['task/task_completed'].minResultLen).toBe(30);
    expect(p.patterns?.allowlistPrefixes).toEqual(['action/L_']);
  });
});

describe('spec-alignment smoke test', () => {
  // Mirrors the impact claim in the spec: ~91% reduction when denylist
  // captures auto-emit categories. Build a sample stream representative of
  // fleet event-distribution and verify ~9% pass rate.
  it('filters ~91% of a representative event mix', () => {
    const events: Event[] = [
      // Auto-emit noise (should deny)
      ...Array(50).fill(0).map(() => makeEvent('heartbeat', 'heartbeat')),
      ...Array(30).fill(0).map(() => makeEvent('message', 'agent_message_sent', { to: 'x' })),
      ...Array(20).fill(0).map(() => makeEvent('message', 'telegram_sent', { to: 'user' })),
      ...Array(5).fill(0).map(() => makeEvent('action', 'session_start')),
      ...Array(5).fill(0).map(() => makeEvent('task', 'task_created', { title: 'x' })),

      // Real signal (should allow)
      ...Array(4).fill(0).map(() => makeEvent('action', 'decision_made')),
      ...Array(2).fill(0).map(() => makeEvent('action', 'approval_created')),
      ...Array(2).fill(0).map(() =>
        makeEvent('task', 'task_completed', {
          result: 'Substantive task result longer than twenty characters',
        }),
      ),
    ];

    const allowed = events.filter((e) => shouldIngestToKB(e, basePolicy)).length;
    const total = events.length;
    const allowRate = allowed / total;

    // 8/118 = ~6.8%; denylist removes ~110 of 118 items. Well within the
    // "~9% or lower" target from the spec.
    expect(total).toBe(118);
    expect(allowed).toBe(8);
    expect(allowRate).toBeLessThan(0.1);
  });
});
