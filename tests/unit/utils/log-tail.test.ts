import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { tailFile, readLastJsonlLine, readLogTailAcrossRotation } from '../../../src/utils/log-tail';

describe('log-tail utilities', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-log-tail-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('tailFile', () => {
    it('returns empty string when file does not exist', () => {
      expect(tailFile(join(testDir, 'missing.log'), 1024)).toBe('');
    });

    it('returns empty string for an empty file', () => {
      const p = join(testDir, 'empty.log');
      writeFileSync(p, '', 'utf-8');
      expect(tailFile(p, 1024)).toBe('');
    });

    it('returns full content when file is smaller than maxBytes', () => {
      const p = join(testDir, 'small.log');
      writeFileSync(p, 'hello world\n', 'utf-8');
      expect(tailFile(p, 1024)).toBe('hello world\n');
    });

    it('returns only the last maxBytes when file is larger', () => {
      const p = join(testDir, 'large.log');
      const content = 'a'.repeat(500) + 'TAIL_MARKER';
      writeFileSync(p, content, 'utf-8');
      const tail = tailFile(p, 20);
      expect(tail.length).toBe(20);
      expect(tail).toContain('TAIL_MARKER');
    });
  });

  describe('readLastJsonlLine', () => {
    it('returns null when file does not exist', () => {
      expect(readLastJsonlLine(join(testDir, 'missing.jsonl'))).toBeNull();
    });

    it('returns null for empty file', () => {
      const p = join(testDir, 'empty.jsonl');
      writeFileSync(p, '', 'utf-8');
      expect(readLastJsonlLine(p)).toBeNull();
    });

    it('returns null when last line is malformed JSON', () => {
      const p = join(testDir, 'bad.jsonl');
      writeFileSync(p, '{"ok":true}\nnot json here\n', 'utf-8');
      expect(readLastJsonlLine(p)).toBeNull();
    });

    it('returns parsed object for a valid JSONL file', () => {
      const p = join(testDir, 'good.jsonl');
      writeFileSync(
        p,
        '{"first":1}\n{"timestamp":"2026-07-23T00:00:00Z","text":"hi"}\n',
        'utf-8',
      );
      const res = readLastJsonlLine(p);
      expect(res).not.toBeNull();
      const parsed = res!.parsed as { timestamp: string; text: string };
      expect(parsed.timestamp).toBe('2026-07-23T00:00:00Z');
      expect(parsed.text).toBe('hi');
    });

    it('handles files without trailing newline', () => {
      const p = join(testDir, 'no-newline.jsonl');
      writeFileSync(p, '{"a":1}\n{"a":2}', 'utf-8');
      const res = readLastJsonlLine(p);
      expect(res).not.toBeNull();
      expect((res!.parsed as { a: number }).a).toBe(2);
    });
  });

  describe('readLogTailAcrossRotation', () => {
    it('returns empty string when neither log exists', () => {
      expect(readLogTailAcrossRotation(testDir, 'ghost', 1024)).toBe('');
    });

    it('returns content of stdout.log when only current exists', () => {
      const dir = join(testDir, 'alice');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'stdout.log'), 'current only\n', 'utf-8');
      expect(readLogTailAcrossRotation(testDir, 'alice', 1024)).toBe('current only\n');
    });

    it('concatenates rotated log first, then current log', () => {
      const dir = join(testDir, 'bob');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'stdout.log.1'), 'ROTATED\n', 'utf-8');
      writeFileSync(join(dir, 'stdout.log'), 'CURRENT\n', 'utf-8');
      const combined = readLogTailAcrossRotation(testDir, 'bob', 1024);
      expect(combined).toBe('ROTATED\nCURRENT\n');
    });
  });
});
