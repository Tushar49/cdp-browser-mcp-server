/**
 * Agent session lifecycle management.
 *
 * Extracted from server.js `agentSessions` Map and related logic:
 *  - getOrCreate   — lazy session creation in handleTool
 *  - touch         — lastActivity bump on every tool call
 *  - sweepStale    — periodic TTL cleanup (was sweepStaleSessions)
 *  - end           — explicit session termination (handleCleanupSession)
 *  - resetAll      — wipe all sessions (handleCleanupReset / browser.connect)
 */

import type { CleanupStrategy } from '../types.js';

// ─── Public Types ───────────────────────────────────────────────────

export interface AgentSession {
  id: string;
  createdAt: number;
  lastActivity: number;
  cleanupStrategy: CleanupStrategy;
  tabIds: Set<string>;
}

// ─── SessionManager ─────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, AgentSession>();

  /**
   * Get an existing session or create a new one.
   *
   * Mirrors the handleTool logic:
   *  1. If sessionId already exists → update lastActivity, optionally
   *     update cleanupStrategy (sticky).
   *  2. Otherwise → create a new session with the given (or default)
   *     cleanup strategy.
   */
  getOrCreate(
    sessionId: string,
    defaultStrategy: CleanupStrategy,
    cleanupStrategy?: CleanupStrategy,
  ): AgentSession {
    const now = Date.now();
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        createdAt: now,
        lastActivity: now,
        cleanupStrategy: cleanupStrategy ?? defaultStrategy,
        tabIds: new Set(),
      };
      this.sessions.set(sessionId, session);
    } else {
      session.lastActivity = now;
      // Sticky update — only overwrite when caller explicitly provides one
      if (cleanupStrategy) {
        session.cleanupStrategy = cleanupStrategy;
      }
    }

    return session;
  }

  /** Bump lastActivity timestamp. */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  /** Look up a session by ID. */
  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Sweep expired sessions whose lastActivity exceeds `ttl` ms.
   *
   * Mirrors sweepStaleSessions() from server.js:
   *  - Sessions with cleanupStrategy === 'none' are skipped (persist indefinitely).
   *  - The `onCleanup` callback handles per-tab detach/close logic so
   *    SessionManager stays transport-agnostic.
   *
   * @returns Number of sessions swept.
   */
  async sweepStale(
    ttl: number,
    onCleanup: (session: AgentSession) => Promise<void>,
  ): Promise<number> {
    const now = Date.now();
    let swept = 0;

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > ttl) {
        // "none" strategy → persist indefinitely, skip sweep entirely
        if (session.cleanupStrategy === 'none') continue;

        await onCleanup(session);
        session.tabIds.clear();
        this.sessions.delete(id);
        swept++;
      }
    }

    return swept;
  }

  /** Return all active sessions as an array. */
  list(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Explicitly end a single session.
   *
   * Mirrors handleCleanupSession() — the `onCleanup` callback performs
   * the actual tab detach/close, then this method clears the session.
   */
  async end(
    sessionId: string,
    onCleanup: (session: AgentSession) => Promise<void>,
  ): Promise<AgentSession | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    await onCleanup(session);
    session.tabIds.clear();
    this.sessions.delete(sessionId);
    return session;
  }

  /**
   * Terminate every session.
   *
   * Mirrors handleCleanupReset() and browser.connect — the callback
   * handles per-tab cleanup, then all sessions are wiped.
   *
   * @returns Number of sessions that were active.
   */
  async resetAll(
    onCleanup: (session: AgentSession) => Promise<void>,
  ): Promise<number> {
    const count = this.sessions.size;

    for (const [, session] of this.sessions) {
      await onCleanup(session);
      session.tabIds.clear();
    }
    this.sessions.clear();

    return count;
  }

  /** Delete a session without running any cleanup callback. */
  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Clear all sessions without running cleanup callbacks. */
  clear(): void {
    this.sessions.clear();
  }

  /** Number of active sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Iterate sessions (for listing / inspection). */
  entries(): IterableIterator<[string, AgentSession]> {
    return this.sessions.entries();
  }
}
