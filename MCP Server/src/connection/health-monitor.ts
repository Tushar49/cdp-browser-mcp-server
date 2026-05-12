/**
 * HealthMonitor — connection health checking and auto-reconnection.
 *
 * Responsibilities:
 *  1. Periodic WebSocket ping/pong health checks (from server.js `startHealthCheck`)
 *  2. Auto-reconnect on unexpected disconnect (Fix 1)
 *  3. Lazy auto-connect on first tool call (Fix 8)
 */

import WebSocket from 'ws';
import type { CDPClient } from './cdp-client.js';
import {
  discoverBrowserInstances,
  resolveWsUrl,
  resolveWsUrlAsync,
  findBestInstance,
} from './browser-discovery.js';
import { ActionableError } from '../utils/error-handler.js';

// ─── Types ──────────────────────────────────────────────────────────

export type HealthStatus =
  | 'disconnected'
  | 'connected'
  | 'unhealthy'
  | 'dead'
  | 'error';

export interface HealthState {
  status: HealthStatus;
  lastPing: number | null;
  lastPong: number | null;
  failures: number;
}

export interface HealthMonitorOptions {
  /** Ping interval in ms (default 30 000). */
  pingIntervalMs?: number;
  /** Pong timeout in ms — if no pong within this window, count a failure (default 5 000). */
  pongTimeoutMs?: number;
  /** Consecutive missed pongs before declaring the connection dead (default 2). */
  maxMissedPongs?: number;
  /** Max auto-reconnect attempts before giving up (default 5). */
  maxReconnectAttempts?: number;
  /** Base delay between reconnect attempts in ms (default 1 000). Exponential back-off applied. */
  reconnectBaseDelayMs?: number;
  /** CDP host for fallback URL resolution (default '127.0.0.1'). */
  cdpHost?: string;
  /** CDP port for fallback URL resolution (default 9222). */
  cdpPort?: number;
  /** Override User Data dir (e.g. from `browser.connect`). */
  overrideUserDataDir?: string | null;
  /** Preferred Chrome profile for auto-connect (from CDP_PROFILE env). */
  preferredProfile?: string;
}

// ─── HealthMonitor ──────────────────────────────────────────────────

export class HealthMonitor {
  private client: CDPClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private connectPromise: Promise<void> | null = null;
  /** Last known good WebSocket URL for instant reconnect. */
  private lastGoodWsUrl: string | null = null;

  /** When true, onDisconnect() skips auto-reconnect (P1-4: browser.connect race). */
  suppressAutoReconnect = false;

  // Options (with defaults)
  private pingIntervalMs: number;
  private pongTimeoutMs: number;
  private maxMissedPongs: number;
  private maxReconnectAttempts: number;
  private reconnectBaseDelayMs: number;
  private cdpHost: string;
  private cdpPort: number;
  private overrideUserDataDir: string | null;
  private preferredProfile: string;

  // Observable health state
  readonly health: HealthState = {
    status: 'disconnected',
    lastPing: null,
    lastPong: null,
    failures: 0,
  };

  constructor(client: CDPClient, opts: HealthMonitorOptions = {}) {
    this.client = client;
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 5_000;
    this.maxMissedPongs = opts.maxMissedPongs ?? 2;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs ?? 1_000;
    this.cdpHost = opts.cdpHost ?? '127.0.0.1';
    this.cdpPort = opts.cdpPort ?? 9222;
    this.overrideUserDataDir = opts.overrideUserDataDir ?? null;
    this.preferredProfile = opts.preferredProfile ?? '';
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Start the periodic health-check timer. */
  start(): void {
    this.stop();
    this.health.status = 'connected';
    this.health.failures = 0;

    this.timer = setInterval(() => this._ping(), this.pingIntervalMs);
  }

  /** Stop the health-check timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.health.status = 'disconnected';
  }

  /** Called when a connection succeeds — resets the reconnect counter. */
  onConnected(): void {
    this.reconnectAttempts = 0;
    this.start();
  }

  // ── Auto-reconnect ─────────────────────────────────────────────

  /**
   * Called when the WebSocket closes unexpectedly.
   * Attempts to reconnect with exponential back-off.
   *
   * @returns `true` if reconnection succeeded, `false` otherwise.
   */
  async onDisconnect(): Promise<boolean> {
    this.stop();

    // P1-4: browser.connect suppresses auto-reconnect during switch
    if (this.suppressAutoReconnect) return false;

    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay =
        this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts - 1);

      await this._sleep(delay);

      try {
        const { wsUrl } = await resolveWsUrlAsync(
          this.overrideUserDataDir,
          this.cdpHost,
          this.cdpPort,
        );
        await this.client.connect(wsUrl);
        this.lastGoodWsUrl = wsUrl;
        this.onConnected();
        return true;
      } catch {
        // Next attempt
      }
    }

    return false;
  }

  /**
   * Auto-connect: discover a browser and connect.
   * Called lazily on first tool invocation or explicitly at startup
   * when `CDP_PROFILE` is set.
   */
  async autoConnect(): Promise<void> {
    // Already connected — nothing to do
    if (this.client.isConnected) return;

    // P0-2: Connection mutex — wait for in-flight connect
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this._doAutoConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /** Internal auto-connect implementation. */
  private async _doAutoConnect(): Promise<void> {
    // Strategy 1: Try last known good connection
    if (this.lastGoodWsUrl) {
      try {
        await this.client.connect(this.lastGoodWsUrl);
        this.onConnected();
        return;
      } catch { /* try next strategy */ }
    }

    // Strategy 2: Probe common debugging ports via HTTP /json/version
    const COMMON_PORTS = [this.cdpPort, 9222, 9229, 9333, 9515];
    const uniquePorts = [...new Set(COMMON_PORTS)];
    for (const port of uniquePorts) {
      try {
        const resp = await fetch(`http://${this.cdpHost}:${port}/json/version`, {
          signal: AbortSignal.timeout(2000),
        });
        const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) {
          await this.client.connect(data.webSocketDebuggerUrl);
          this.lastGoodWsUrl = data.webSocketDebuggerUrl;
          this.onConnected();
          return;
        }
      } catch { continue; }
    }

    // Strategy 3: File-based discovery (DevToolsActivePort)
    const instances = discoverBrowserInstances();
    if (instances.length > 0) {
      const best = this.preferredProfile
        ? findBestInstance(instances, this.preferredProfile)
        : instances[0];
      if (best) {
        try {
          await this.client.connect(best.wsUrl);
          this.lastGoodWsUrl = best.wsUrl;
          this.overrideUserDataDir = best.userDataDir;
          this.onConnected();
          return;
        } catch { /* fall through to error */ }
      }
    }

    // All strategies failed — throw actionable error
    throw new ActionableError(
      'Could not find any browser with remote debugging enabled.',
      `To fix, do ONE of these:\n` +
      `  1. Chrome/Edge: Go to chrome://flags → search "remote debugging" → Enable → Relaunch\n` +
      `  2. Or launch with flag: chrome --remote-debugging-port=9222\n` +
      `  3. Or set CDP_PORT env var if using a non-standard port\n\n` +
      `The server will auto-connect once debugging is enabled. No manual connect needed.`,
    );
  }

  /** Update the override directory (e.g. after `browser.connect`). */
  setOverrideUserDataDir(dir: string | null): void {
    this.overrideUserDataDir = dir;
  }

  // ── Internal ────────────────────────────────────────────────────

  private _ping(): void {
    const socket = this.client.rawSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.health.status = 'disconnected';
      return;
    }

    this.health.lastPing = Date.now();
    let pongReceived = false;

    const pongHandler = (): void => {
      pongReceived = true;
      this.health.lastPong = Date.now();
      this.health.failures = 0;
      this.health.status = 'connected';
    };

    socket.once('pong', pongHandler);

    try {
      socket.ping();
    } catch {
      this.health.status = 'error';
      return;
    }

    setTimeout(() => {
      if (!pongReceived) {
        this.health.failures++;
        this.health.status = 'unhealthy';
        socket.removeListener('pong', pongHandler);

        if (this.health.failures >= this.maxMissedPongs) {
          this.health.status = 'dead';
          this.client.terminate();
        }
      }
    }, this.pongTimeoutMs);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
