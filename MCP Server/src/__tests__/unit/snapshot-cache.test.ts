import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SnapshotCache } from '../../snapshot/cache.js';
import type { AXNode } from '../../snapshot/accessibility.js';

function dummyTree(): AXNode[] {
  return [{ role: 'button', name: 'Click', backendNodeId: 1 }];
}

describe('SnapshotCache', () => {
  let cache: SnapshotCache;

  beforeEach(() => {
    cache = new SnapshotCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('set()', () => {
    it('stores snapshot', () => {
      cache.set('tab1', 'snapshot-text', dummyTree(), 'https://example.com');
      expect(cache.has('tab1')).toBe(true);
    });
  });

  describe('get()', () => {
    it('returns cached snapshot when URL matches', () => {
      cache.set('tab1', 'content', dummyTree(), 'https://example.com');
      const result = cache.get('tab1', 'https://example.com');

      expect(result).not.toBeNull();
      expect(result!.snapshot).toBe('content');
      expect(result!.url).toBe('https://example.com');
    });

    it('returns null when URL changed', () => {
      cache.set('tab1', 'content', dummyTree(), 'https://example.com');
      const result = cache.get('tab1', 'https://different.com');

      expect(result).toBeNull();
    });

    it('returns null when maxAge exceeded', () => {
      cache.set('tab1', 'content', dummyTree(), 'https://example.com');

      // Advance time past default maxAge (10s)
      vi.advanceTimersByTime(15_000);

      const result = cache.get('tab1', 'https://example.com');
      expect(result).toBeNull();
    });

    it('returns cached snapshot within maxAge', () => {
      cache.set('tab1', 'content', dummyTree(), 'https://example.com');

      // Advance time but stay within maxAge
      vi.advanceTimersByTime(5_000);

      const result = cache.get('tab1', 'https://example.com');
      expect(result).not.toBeNull();
    });

    it('returns null for nonexistent tab', () => {
      expect(cache.get('nonexistent', 'https://x.com')).toBeNull();
    });

    it('respects custom maxAge', () => {
      cache.set('tab1', 'content', dummyTree(), 'https://example.com');

      vi.advanceTimersByTime(3_000);

      // Custom short maxAge: 2 seconds
      const result = cache.get('tab1', 'https://example.com', 2_000);
      expect(result).toBeNull();
    });
  });

  describe('invalidate()', () => {
    it('clears specific tab', () => {
      cache.set('tab1', 'c1', dummyTree(), 'https://a.com');
      cache.set('tab2', 'c2', dummyTree(), 'https://b.com');

      cache.invalidate('tab1');
      expect(cache.has('tab1')).toBe(false);
      expect(cache.has('tab2')).toBe(true);
    });
  });

  describe('clear()', () => {
    it('clears all cached snapshots', () => {
      cache.set('tab1', 'c1', dummyTree(), 'https://a.com');
      cache.set('tab2', 'c2', dummyTree(), 'https://b.com');

      cache.clear();
      expect(cache.has('tab1')).toBe(false);
      expect(cache.has('tab2')).toBe(false);
      expect(cache.stats.cachedTabs).toBe(0);
    });
  });

  describe('diff()', () => {
    it('detects added lines when no cache exists', () => {
      const diff = cache.diff('tab1', 'line1\nline2');

      expect(diff.changed).toBe(true);
      expect(diff.added).toBe(2);
      expect(diff.removed).toBe(0);
      expect(diff.lines).toContain('+ line1');
      expect(diff.lines).toContain('+ line2');
    });

    it('detects no change when content is identical', () => {
      cache.set('tab1', 'line1\nline2', dummyTree(), 'https://a.com');
      const diff = cache.diff('tab1', 'line1\nline2');

      expect(diff.changed).toBe(false);
      expect(diff.added).toBe(0);
      expect(diff.removed).toBe(0);
      expect(diff.lines).toEqual([]);
    });

    it('detects added and removed lines', () => {
      cache.set('tab1', 'old-line\nshared', dummyTree(), 'https://a.com');
      const diff = cache.diff('tab1', 'shared\nnew-line');

      expect(diff.changed).toBe(true);
      expect(diff.removed).toBe(1); // 'old-line' removed
      expect(diff.added).toBe(1);   // 'new-line' added
      expect(diff.lines).toContain('- old-line');
      expect(diff.lines).toContain('+ new-line');
    });
  });

  describe('stats', () => {
    it('reflects cached tab count', () => {
      expect(cache.stats.cachedTabs).toBe(0);
      cache.set('tab1', 'c', dummyTree(), 'https://a.com');
      expect(cache.stats.cachedTabs).toBe(1);
      cache.set('tab2', 'c', dummyTree(), 'https://b.com');
      expect(cache.stats.cachedTabs).toBe(2);
    });
  });
});
