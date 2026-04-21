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

  /** Remove the session mapping for a tab (e.g. on tab close). */
  detach(tabId: string, cdpClient?: CDPClient): void {
    const sessionId = this.sessions.get(tabId);
    if (sessionId) {
      this.enabledDomains.delete(sessionId);
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
  }

  /** Number of active tab sessions. */
  get size(): number {
    return this.sessions.size;
  }
}
