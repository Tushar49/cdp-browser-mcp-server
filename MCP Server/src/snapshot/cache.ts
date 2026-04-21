/**
 * Snapshot caching with incremental diff support.
 *
 * Caches the last accessibility snapshot per tab to:
 *  1. Skip redundant snapshots when the page hasn't changed
 *  2. Support incremental/diff snapshots that show only what changed
 *  3. Reduce CDP round-trips for snapshot-heavy workflows
 *
 * Cache invalidation:
 *  - URL change (navigation detected)
 *  - Manual invalidate() call (e.g. after interaction)
 *  - Time-based staleness (maxAgeMs)
 */

import type { AXNode } from './accessibility.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface CachedSnapshot {
  /** The serialized text snapshot */
  snapshot: string;
  /** The raw AX node tree */
  tree: AXNode[];
  /** The page URL when the snapshot was taken */
  url: string;
  /** Timestamp when the snapshot was captured */
  timestamp: number;
}

export interface SnapshotDiff {
  /** Whether any content changed between cached and new */
  changed: boolean;
  /** Number of lines added */
  added: number;
  /** Number of lines removed */
  removed: number;
  /** Diff lines with +/- prefixes (empty if unchanged) */
  lines: string[];
}

// ─── SnapshotCache ──────────────────────────────────────────────────

export class SnapshotCache {
  private cache = new Map<string, CachedSnapshot>();

  /** Default max age before a cached snapshot is considered stale (10s) */
  private static readonly DEFAULT_MAX_AGE_MS = 10_000;

  /**
   * Store a snapshot for a tab.
   */
  set(tabId: string, snapshot: string, tree: AXNode[], url: string): void {
    this.cache.set(tabId, {
      snapshot,
      tree,
      url,
      timestamp: Date.now(),
    });
  }

  /**
   * Get a cached snapshot if it's still fresh.
   *
   * Returns null if:
   *  - No cached snapshot exists for this tab
   *  - The URL has changed (navigation occurred)
   *  - The snapshot is older than maxAgeMs
   */
  get(
    tabId: string,
    currentUrl: string,
    maxAgeMs: number = SnapshotCache.DEFAULT_MAX_AGE_MS,
  ): CachedSnapshot | null {
    const cached = this.cache.get(tabId);
    if (!cached) return null;

    // URL changed — cache is stale
    if (cached.url !== currentUrl) {
      this.cache.delete(tabId);
      return null;
    }

    // Time-based staleness
    if (Date.now() - cached.timestamp > maxAgeMs) {
      this.cache.delete(tabId);
      return null;
    }

    return cached;
  }

  /**
   * Compute a line-level diff between the cached snapshot and a new one.
   *
   * Uses a simple line-by-line comparison (not a full Myers diff) for speed.
   * This is sufficient for accessibility trees where structural changes are
   * typically localized.
   */
  diff(tabId: string, newSnapshot: string): SnapshotDiff {
    const cached = this.cache.get(tabId);
    if (!cached) {
      // No cache — everything is "added"
      const newLines = newSnapshot.split('\n');
      return {
        changed: true,
        added: newLines.length,
        removed: 0,
        lines: newLines.map((l) => `+ ${l}`),
      };
    }

    if (cached.snapshot === newSnapshot) {
      return { changed: false, added: 0, removed: 0, lines: [] };
    }

    const oldLines = cached.snapshot.split('\n');
    const newLines = newSnapshot.split('\n');
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);

    const diffLines: string[] = [];
    let added = 0;
    let removed = 0;

    // Lines in old but not in new (removed)
    for (const line of oldLines) {
      if (!newSet.has(line)) {
        diffLines.push(`- ${line}`);
        removed++;
      }
    }

    // Lines in new but not in old (added)
    for (const line of newLines) {
      if (!oldSet.has(line)) {
        diffLines.push(`+ ${line}`);
        added++;
      }
    }

    return { changed: true, added, removed, lines: diffLines };
  }

  /**
   * Invalidate the cache for a specific tab.
   * Call this after navigation or DOM-mutating interactions.
   */
  invalidate(tabId: string): void {
    this.cache.delete(tabId);
  }

  /**
   * Check if a tab has a cached snapshot (without validating staleness).
   */
  has(tabId: string): boolean {
    return this.cache.has(tabId);
  }

  /**
   * Clear all cached snapshots.
   */
  clear(): void {
    this.cache.clear();
  }

  /** Debugging stats */
  get stats(): { cachedTabs: number } {
    return { cachedTabs: this.cache.size };
  }
}
