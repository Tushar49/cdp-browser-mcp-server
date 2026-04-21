import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../../session/session-manager.js';

describe('SessionManager', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager();
  });

  describe('getOrCreate()', () => {
    it('creates new session with correct defaults', () => {
      const session = mgr.getOrCreate('s1', 'detach');

      expect(session.id).toBe('s1');
      expect(session.cleanupStrategy).toBe('detach');
      expect(session.tabIds).toBeInstanceOf(Set);
      expect(session.tabIds.size).toBe(0);
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.lastActivity).toBeGreaterThan(0);
    });

    it('returns existing session on second call', () => {
      const s1 = mgr.getOrCreate('s1', 'detach');
      const s2 = mgr.getOrCreate('s1', 'detach');

      expect(s1).toBe(s2);
      expect(mgr.size).toBe(1);
    });

    it('uses provided cleanupStrategy over default for new sessions', () => {
      const session = mgr.getOrCreate('s1', 'detach', 'close');
      expect(session.cleanupStrategy).toBe('close');
    });

    it('sticky updates cleanupStrategy on existing session', () => {
      mgr.getOrCreate('s1', 'detach');
      const session = mgr.getOrCreate('s1', 'detach', 'close');
      expect(session.cleanupStrategy).toBe('close');
    });

    it('does not overwrite cleanupStrategy when not explicitly provided on existing session', () => {
      mgr.getOrCreate('s1', 'detach', 'close');
      const session = mgr.getOrCreate('s1', 'detach');
      expect(session.cleanupStrategy).toBe('close');
    });
  });

  describe('touch()', () => {
    it('updates lastActivity timestamp', async () => {
      const session = mgr.getOrCreate('s1', 'detach');
      const before = session.lastActivity;

      // Small delay so timestamp differs
      await new Promise(r => setTimeout(r, 10));
      mgr.touch('s1');

      expect(session.lastActivity).toBeGreaterThan(before);
    });

    it('does nothing for nonexistent session', () => {
      expect(() => mgr.touch('nonexistent')).not.toThrow();
    });
  });

  describe('sweepStale()', () => {
    it('removes sessions past TTL', async () => {
      mgr.getOrCreate('s1', 'detach');
      // Manually set lastActivity to the past
      const session = mgr.get('s1')!;
      session.lastActivity = Date.now() - 500_000;

      const callback = vi.fn(async () => {});
      const swept = await mgr.sweepStale(100_000, callback);

      expect(swept).toBe(1);
      expect(mgr.size).toBe(0);
    });

    it('keeps sessions within TTL', async () => {
      mgr.getOrCreate('s1', 'detach');

      const callback = vi.fn(async () => {});
      const swept = await mgr.sweepStale(999_999_999, callback);

      expect(swept).toBe(0);
      expect(mgr.size).toBe(1);
    });

    it('calls cleanup callback for expired sessions', async () => {
      mgr.getOrCreate('s1', 'detach');
      const session = mgr.get('s1')!;
      session.lastActivity = Date.now() - 500_000;

      const callback = vi.fn(async () => {});
      await mgr.sweepStale(100_000, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(session);
    });

    it('skips sessions with cleanupStrategy "none"', async () => {
      mgr.getOrCreate('s1', 'none');
      const session = mgr.get('s1')!;
      session.lastActivity = Date.now() - 500_000;

      const callback = vi.fn(async () => {});
      const swept = await mgr.sweepStale(100_000, callback);

      expect(swept).toBe(0);
      expect(callback).not.toHaveBeenCalled();
      expect(mgr.size).toBe(1);
    });
  });

  describe('end()', () => {
    it('removes specific session', async () => {
      mgr.getOrCreate('s1', 'detach');
      mgr.getOrCreate('s2', 'detach');

      const callback = vi.fn(async () => {});
      const ended = await mgr.end('s1', callback);

      expect(ended).toBeDefined();
      expect(ended!.id).toBe('s1');
      expect(mgr.size).toBe(1);
      expect(mgr.get('s1')).toBeUndefined();
      expect(mgr.get('s2')).toBeDefined();
    });

    it('returns undefined for nonexistent session', async () => {
      const callback = vi.fn(async () => {});
      const result = await mgr.end('nope', callback);

      expect(result).toBeUndefined();
      expect(callback).not.toHaveBeenCalled();
    });

    it('calls cleanup callback', async () => {
      const s = mgr.getOrCreate('s1', 'detach');
      const callback = vi.fn(async () => {});

      await mgr.end('s1', callback);
      expect(callback).toHaveBeenCalledWith(s);
    });
  });

  describe('size', () => {
    it('returns correct count', () => {
      expect(mgr.size).toBe(0);

      mgr.getOrCreate('s1', 'detach');
      expect(mgr.size).toBe(1);

      mgr.getOrCreate('s2', 'detach');
      expect(mgr.size).toBe(2);

      mgr.delete('s1');
      expect(mgr.size).toBe(1);
    });
  });

  describe('list()', () => {
    it('returns all active sessions', () => {
      mgr.getOrCreate('s1', 'detach');
      mgr.getOrCreate('s2', 'close');

      const list = mgr.list();
      expect(list).toHaveLength(2);
      expect(list.map(s => s.id).sort()).toEqual(['s1', 's2']);
    });
  });

  describe('resetAll()', () => {
    it('removes all sessions and calls cleanup for each', async () => {
      mgr.getOrCreate('s1', 'detach');
      mgr.getOrCreate('s2', 'close');

      const callback = vi.fn(async () => {});
      const count = await mgr.resetAll(callback);

      expect(count).toBe(2);
      expect(mgr.size).toBe(0);
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });
});
