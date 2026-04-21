/**
 * Lazy CDP domain enablement.
 *
 * Instead of enabling ALL CDP domains on connect (Page, DOM, Network,
 * Accessibility, etc.), domains are enabled lazily when first needed.
 * This dramatically reduces the handshake overhead on new tab attach
 * and avoids processing events for unused domains.
 *
 * Each domain is tracked per CDP session (i.e. per tab), and cleared
 * when the tab/session disconnects.
 */

// ─── Types ──────────────────────────────────────────────────────────

type CdpSend = (
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<unknown>;

/** Domains that support `.enable` / `.disable` commands. */
const ENABLEABLE_DOMAINS = new Set([
  'Accessibility',
  'CSS',
  'Console',
  'DOM',
  'DOMDebugger',
  'DOMStorage',
  'Debugger',
  'Fetch',
  'HeapProfiler',
  'Inspector',
  'Log',
  'Network',
  'Overlay',
  'Page',
  'Performance',
  'Profiler',
  'Runtime',
  'Security',
  'ServiceWorker',
  'Target',
]);

// ─── DomainManager ──────────────────────────────────────────────────

export class DomainManager {
  /** sessionId → Set of already-enabled domain names */
  private enabled = new Map<string, Set<string>>();

  /** In-flight enable promises to avoid duplicate concurrent enables */
  private pending = new Map<string, Promise<void>>();

  /**
   * Ensure a CDP domain is enabled for a given session.
   *
   * If the domain was already enabled in this session, this is a no-op
   * (returns immediately without any CDP call). Concurrent calls for the
   * same domain+session are coalesced into a single CDP command.
   *
   * @param cdpSend   The send function to issue CDP commands
   * @param sessionId CDP session ID (target session)
   * @param domain    CDP domain name, e.g. "Page", "Network", "DOM"
   */
  async ensureDomain(
    cdpSend: CdpSend,
    sessionId: string,
    domain: string,
  ): Promise<void> {
    const key = sessionId;

    if (!this.enabled.has(key)) this.enabled.set(key, new Set());
    const domains = this.enabled.get(key)!;

    // Already enabled — fast path
    if (domains.has(domain)) return;

    // Not a domain that supports .enable — just mark it
    if (!ENABLEABLE_DOMAINS.has(domain)) {
      domains.add(domain);
      return;
    }

    // Coalesce concurrent enables for the same domain+session
    const pendingKey = `${key}:${domain}`;
    if (this.pending.has(pendingKey)) {
      return this.pending.get(pendingKey)!;
    }

    const promise = (async () => {
      try {
        await cdpSend(`${domain}.enable`, {}, sessionId);
        domains.add(domain);
      } finally {
        this.pending.delete(pendingKey);
      }
    })();

    this.pending.set(pendingKey, promise);
    return promise;
  }

  /**
   * Ensure multiple domains are enabled in parallel.
   */
  async ensureDomains(
    cdpSend: CdpSend,
    sessionId: string,
    domains: string[],
  ): Promise<void> {
    await Promise.all(
      domains.map((d) => this.ensureDomain(cdpSend, sessionId, d)),
    );
  }

  /**
   * Check if a domain is already enabled for a session (no CDP call).
   */
  isEnabled(sessionId: string, domain: string): boolean {
    return this.enabled.get(sessionId)?.has(domain) ?? false;
  }

  /**
   * Clear all tracked domains for a session.
   * Call this when a tab disconnects or the CDP session is detached.
   */
  clear(sessionId: string): void {
    this.enabled.delete(sessionId);
    // Also clean up any pending enables for this session
    for (const key of this.pending.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.pending.delete(key);
      }
    }
  }

  /**
   * Clear all tracked state (e.g. on full disconnect).
   */
  clearAll(): void {
    this.enabled.clear();
    this.pending.clear();
  }

  /** Debugging stats */
  get stats(): { sessions: number; totalDomains: number } {
    let totalDomains = 0;
    for (const set of this.enabled.values()) totalDomains += set.size;
    return { sessions: this.enabled.size, totalDomains };
  }
}
