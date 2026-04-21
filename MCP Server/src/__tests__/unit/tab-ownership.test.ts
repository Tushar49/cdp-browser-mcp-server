import { describe, it, expect, beforeEach } from 'vitest';
import { TabOwnership } from '../../session/tab-ownership.js';

describe('TabOwnership', () => {
  let tabs: TabOwnership;

  beforeEach(() => {
    tabs = new TabOwnership();
  });

  describe('lock()', () => {
    it('stores lock with correct fields', () => {
      tabs.lock('tab1', 'sess1', true, 'created');

      const lock = tabs.getLock('tab1');
      expect(lock).toBeDefined();
      expect(lock!.sessionId).toBe('sess1');
      expect(lock!.exclusive).toBe(true);
      expect(lock!.origin).toBe('created');
      expect(lock!.lockedAt).toBeGreaterThan(0);
    });
  });

  describe('canAccess()', () => {
    it('returns true for owner', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      expect(tabs.canAccess('tab1', 'sess1')).toBe(true);
    });

    it('returns false for non-owner when exclusive', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      expect(tabs.canAccess('tab1', 'sess2')).toBe(false);
    });

    it('returns true for non-owner when requesting non-exclusive access', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      expect(tabs.canAccess('tab1', 'sess2', false)).toBe(true);
    });

    it('returns true for unowned tab', () => {
      expect(tabs.canAccess('unowned-tab', 'any-session')).toBe(true);
    });
  });

  describe('release()', () => {
    it('removes lock', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      expect(tabs.getLock('tab1')).toBeDefined();

      tabs.release('tab1');
      expect(tabs.getLock('tab1')).toBeUndefined();
    });

    it('does nothing for nonexistent tab', () => {
      expect(() => tabs.release('no-such-tab')).not.toThrow();
    });
  });

  describe('releaseSession()', () => {
    it('releases all session tabs and returns tab IDs', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      tabs.lock('tab2', 'sess1', true, 'created');
      tabs.lock('tab3', 'sess2', true, 'created');

      const released = tabs.releaseSession('sess1');
      expect(released.sort()).toEqual(['tab1', 'tab2']);
      expect(tabs.getLock('tab1')).toBeUndefined();
      expect(tabs.getLock('tab2')).toBeUndefined();
      expect(tabs.getLock('tab3')).toBeDefined(); // unaffected
    });

    it('returns empty array when session has no locks', () => {
      const released = tabs.releaseSession('nonexistent');
      expect(released).toEqual([]);
    });
  });

  describe('claimIfUnowned()', () => {
    it('claims unowned tab', () => {
      const result = tabs.claimIfUnowned('tab1', 'sess1');
      expect(result).toBe(true);
      expect(tabs.getLock('tab1')).toBeDefined();
      expect(tabs.getLock('tab1')!.sessionId).toBe('sess1');
      expect(tabs.getLock('tab1')!.origin).toBe('claimed');
    });

    it('does NOT override existing lock from another session', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      const result = tabs.claimIfUnowned('tab1', 'sess2');

      expect(result).toBe(false);
      expect(tabs.getLock('tab1')!.sessionId).toBe('sess1'); // unchanged
    });

    it('returns true for own tab without overwriting', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      const result = tabs.claimIfUnowned('tab1', 'sess1');
      expect(result).toBe(true);
    });

    it('allows non-exclusive claim on another session tab', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      const result = tabs.claimIfUnowned('tab1', 'sess2', false);
      expect(result).toBe(true);
      // Original lock should remain
      expect(tabs.getLock('tab1')!.sessionId).toBe('sess1');
    });
  });

  describe('getSessionTabs()', () => {
    it('returns all tabs for a session', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      tabs.lock('tab2', 'sess1', true, 'claimed');
      tabs.lock('tab3', 'sess2', true, 'created');

      const sessionTabs = tabs.getSessionTabs('sess1');
      expect(sessionTabs.sort()).toEqual(['tab1', 'tab2']);
    });
  });

  describe('size', () => {
    it('returns correct count', () => {
      expect(tabs.size).toBe(0);

      tabs.lock('tab1', 'sess1', true, 'created');
      expect(tabs.size).toBe(1);

      tabs.lock('tab2', 'sess1', true, 'created');
      expect(tabs.size).toBe(2);

      tabs.release('tab1');
      expect(tabs.size).toBe(1);
    });
  });

  describe('listLocks()', () => {
    it('returns all locks when showAll is true', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      tabs.lock('tab2', 'sess2', true, 'created');

      const all = tabs.listLocks(undefined, true);
      expect(all.size).toBe(2);
    });

    it('returns only session locks when filtered', () => {
      tabs.lock('tab1', 'sess1', true, 'created');
      tabs.lock('tab2', 'sess2', true, 'created');

      const filtered = tabs.listLocks('sess1');
      expect(filtered.size).toBe(1);
      expect(filtered.has('tab1')).toBe(true);
    });
  });
});
