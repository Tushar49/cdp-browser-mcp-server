/**
 * Shared per-tab CDP session management.
 *
 * P1-1 fix: Centralises Target.attachToTarget calls so that
 * every tool module reuses the same CDP session for a given tab
 * instead of each one calling attachToTarget independently.
 *
 * Also lazily enables CDP domains per-session via DomainManager.
 */

import type { CDPClient } from './cdp-client.js';

export class TabSessionService {
  /** tabId (targetId) → CDP sessionId */
  private sessions = new Map<string, string>();

  /** CDP sessionId → set of domains already enabled */
  private enabledDomains = new Map<string, Set<string>>();

  /** OOP iframe child sessions: parentSessionId → Map<childTargetId, { sessionId, url }> */
  private childSessions = new Map<string, Map<string, { sessionId: string; url: string }>>();

  /** Reverse map: childSessionId → parentSessionId (for fast lookup) */
  private childToParent = new Map<string, string>();

  /** uid → childSessionId routing for cross-frame element resolution */
  private refSessionRouting = new Map<string, Map<number, string>>();

  /**
   * Get (or create) a CDP session for a tab.
   *
   * If we already have a session for this tabId, returns it.
   * Otherwise calls Target.attachToTarget with flatten: true.
   */
  async getSession(cdpClient: CDPClient, tabId: string): Promise<string> {
    // Check the CDPClient's own session pool first, then our map
    const pooled = cdpClient.getPooledSession(tabId);
    if (pooled) {
      this.sessions.set(tabId, pooled);
      return pooled;
    }

    const existing = this.sessions.get(tabId);
    if (existing) return existing;

    const result = await cdpClient.send('Target.attachToTarget', {
      targetId: tabId,
      flatten: true,
    }) as { sessionId: string };

    const sessionId = result.sessionId;
    this.sessions.set(tabId, sessionId);
    cdpClient.poolSession(tabId, sessionId);

    // Enable auto-attach for OOP (cross-origin) iframe discovery
    try {
      await cdpClient.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }, sessionId);
    } catch {
      // Older Chrome versions may not support auto-attach on page sessions
    }

    return sessionId;
  }

  /**
   * Ensure a CDP domain is enabled for a tab's session.
   * Skips if the domain was already enabled in this session.
   */
  async ensureDomain(
    cdpClient: CDPClient,
    tabId: string,
    domain: string,
  ): Promise<void> {
    const sessionId = await this.getSession(cdpClient, tabId);

    let domains = this.enabledDomains.get(sessionId);
    if (!domains) {
      domains = new Set();
      this.enabledDomains.set(sessionId, domains);
    }

    if (domains.has(domain)) return;

    await cdpClient.send(`${domain}.enable`, {}, sessionId);
    domains.add(domain);

    // Domain manager already tracks via ensureDomain if needed externally
  }

  /**
   * Enable Target.setAutoAttach on a tab session to discover OOP iframes.
   */
  async setupAutoAttach(cdpClient: CDPClient, tabId: string): Promise<void> {
    const sessionId = await this.getSession(cdpClient, tabId);
    try {
      await cdpClient.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }, sessionId);
    } catch {
      // Older Chrome versions may not support auto-attach on page sessions
    }
  }

  /** Track a child session (OOP iframe) under a parent session. */
  addChildSession(parentSessionId: string, childTargetId: string, childSessionId: string, url: string): void {
    let frames = this.childSessions.get(parentSessionId);
    if (!frames) {
      frames = new Map();
      this.childSessions.set(parentSessionId, frames);
    }
    frames.set(childTargetId, { sessionId: childSessionId, url });
    this.childToParent.set(childSessionId, parentSessionId);
  }

  /** Remove a child session when an OOP iframe detaches. */
  removeChildSession(parentSessionId: string, childTargetIdOrSessionId: string): void {
    const frames = this.childSessions.get(parentSessionId);
    if (!frames) return;

    // Try matching by targetId first, then by sessionId
    if (frames.has(childTargetIdOrSessionId)) {
      const info = frames.get(childTargetIdOrSessionId)!;
      this.childToParent.delete(info.sessionId);
      frames.delete(childTargetIdOrSessionId);
    } else {
      for (const [tid, info] of frames) {
        if (info.sessionId === childTargetIdOrSessionId) {
          this.childToParent.delete(info.sessionId);
          frames.delete(tid);
          break;
        }
      }
    }
  }

  /** Get all child sessions (OOP iframes) for a parent session. */
  getChildSessions(parentSessionId: string): Map<string, { sessionId: string; url: string }> {
    return this.childSessions.get(parentSessionId) ?? new Map();
  }

  /** Store uid → childSessionId routing for cross-frame element interaction. */
  setRefRouting(parentSessionId: string, routing: Map<number, string>): void {
    this.refSessionRouting.set(parentSessionId, routing);
  }

  /** Get the child session that owns a given uid (for cross-frame commands). */
  getRefSession(parentSessionId: string, uid: number): string | undefined {
    return this.refSessionRouting.get(parentSessionId)?.get(uid);
  }

  /** Find the parent session ID for a child session. */
  getParentSession(childSessionId: string): string | undefined {
    return this.childToParent.get(childSessionId);
  }

  /** Remove the session mapping for a tab (e.g. on tab close). */
  detach(tabId: string, cdpClient?: CDPClient): void {
    const sessionId = this.sessions.get(tabId);
    if (sessionId) {
      this.enabledDomains.delete(sessionId);
      // Clean up child sessions for this tab
      const children = this.childSessions.get(sessionId);
      if (children) {
        for (const info of children.values()) {
          this.childToParent.delete(info.sessionId);
        }
        this.childSessions.delete(sessionId);
      }
      this.refSessionRouting.delete(sessionId);
      cdpClient?.unpoolSession(tabId);
    }
    this.sessions.delete(tabId);
  }

  /** Check if a tab has an active session. */
  has(tabId: string): boolean {
    return this.sessions.has(tabId);
  }

  /** Get the raw session ID for a tab (or undefined). */
  get(tabId: string): string | undefined {
    return this.sessions.get(tabId);
  }

  /** Clear all sessions (e.g. on browser disconnect). */
  clear(): void {
    this.sessions.clear();
    this.enabledDomains.clear();
    this.childSessions.clear();
    this.childToParent.clear();
    this.refSessionRouting.clear();
  }

  /** Iterate over all [tabId, sessionId] pairs. */
  entries(): IterableIterator<[string, string]> {
    return this.sessions.entries();
  }

  /** Number of active tab sessions. */
  get size(): number {
    return this.sessions.size;
  }
}
