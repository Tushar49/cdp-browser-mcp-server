/**
 * CDPClient — typed WebSocket client for the Chrome DevTools Protocol.
 *
 * Extracted from the monolithic server.js.  Provides:
 *  • Promise-based `send(method, params?, sessionId?)` with auto-timeout
 *  • Internal message-ID tracking and callback resolution
 *  • Typed EventEmitter for CDP domain events
 *  • Connection-state accessors
 *  • Session pooling: reuses CDP sessions for already-attached targets
 *  • Target caching: avoids redundant Target.getTargets() HTTP calls
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { CDPMessage, CDPEvent, CDPResponse } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface CDPClientOptions {
  /** Per-command timeout in ms (default 30 000). */
  commandTimeout?: number;
  /** How long (ms) to cache Target.getTargets() results (default 2000). */
  targetCacheTTL?: number;
}

interface PendingCallback {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** Cached target list result */
interface TargetCache {
  targets: unknown;
  timestamp: number;
}

// Re-export protocol message types for convenience
export type { CDPMessage, CDPEvent, CDPResponse };

// ─── CDPClient ──────────────────────────────────────────────────────

/**
 * Events emitted by CDPClient:
 *
 *  • `'event'`        — every CDP event  `(event: CDPEvent) => void`
 *  • `'connected'`    — WebSocket opened
 *  • `'disconnected'` — WebSocket closed (possibly unexpectedly)
 *  • `'error'`        — connection-level error
 */
export class CDPClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private callbacks = new Map<number, PendingCallback>();
  private _state: ConnectionState = 'disconnected';
  private defaultTimeout: number;

  // Session pooling: targetId → CDP sessionId (avoid re-attaching)
  private sessionPool = new Map<string, string>();

  // Target caching: avoid redundant Target.getTargets() calls
  private targetCache: TargetCache | null = null;
  private targetCacheTTL: number;

  constructor(opts: CDPClientOptions = {}) {
    super();
    this.defaultTimeout = opts.commandTimeout ?? 30_000;
    this.targetCacheTTL = opts.targetCacheTTL ?? 2_000;
  }

  // ── Accessors ───────────────────────────────────────────────────

  get state(): ConnectionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  /** The underlying WebSocket URL (if connected). */
  get url(): string | null {
    return this.ws?.url ?? null;
  }

  /** Expose raw WebSocket for health-check ping/pong. */
  get rawSocket(): WebSocket | null {
    return this.ws;
  }

  // ── Connect / Disconnect ────────────────────────────────────────

  /**
   * Open a WebSocket connection to the given CDP endpoint.
   * Resolves once the socket is open; rejects on connection error.
   */
  async connect(wsUrl: string): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this._state = 'connecting';

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { perMessageDeflate: false });

      socket.once('open', () => {
        this.ws = socket;
        this._state = 'connected';
        this._attachListeners(socket);
        this.emit('connected');
        resolve();
      });

      socket.once('error', (err: Error) => {
        this._state = 'disconnected';
        reject(
          new Error(
            'Cannot connect to browser. Enable remote debugging:\n' +
              'Chrome: chrome://flags → #enable-remote-debugging → Enabled → Relaunch\n' +
              'Edge: edge://flags → #enable-remote-debugging → Enabled → Relaunch\n' +
              'Brave: brave://flags → #enable-remote-debugging → Enabled → Relaunch\n' +
              `Or launch with --remote-debugging-port=9222\n(${err.message})`,
          ),
        );
      });
    });
  }

  /**
   * Gracefully close the WebSocket.
   * Returns a promise that resolves once the socket is fully closed.
   */
  async disconnect(): Promise<void> {
    const socket = this.ws;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this._cleanup();
      return;
    }

    return new Promise<void>((resolve) => {
      socket.once('close', () => {
        // _cleanup is called by the 'close' listener already
        resolve();
      });
      socket.close();
    });
  }

  /** Forcefully terminate the WebSocket without a graceful close. */
  terminate(): void {
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        /* ok */
      }
    }
    this._cleanup();
  }

  // ── CDP Command ─────────────────────────────────────────────────

  /**
   * Send a CDP command and await its result.
   *
   * @param method    CDP method, e.g. `"Page.navigate"`
   * @param params    Method parameters (optional)
   * @param sessionId CDP session ID for per-tab commands (optional)
   * @param timeout   Override the default command timeout (optional)
   */
  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeout?: number,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`CDPClient: not connected (state=${this._state})`);
    }

    const id = ++this.messageId;
    const timeoutMs = timeout ?? this.defaultTimeout;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`${method}: timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      this.callbacks.set(id, {
        resolve(value: unknown) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(err: Error) {
          clearTimeout(timer);
          reject(err);
        },
      });

      const msg: CDPMessage = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws!.send(JSON.stringify(msg));
    });
  }

  // ── Internal ────────────────────────────────────────────────────

  private _attachListeners(socket: WebSocket): void {
    socket.on('message', (raw: WebSocket.RawData) => {
      let data: CDPResponse | CDPEvent;
      try {
        data = JSON.parse(raw.toString()) as CDPResponse | CDPEvent;
      } catch (err) {
        this.emit('error', new Error(`Malformed CDP frame: ${raw.toString().substring(0, 200)}`));
        return; // Don't crash — skip malformed frame
      }

      // Response to a command we sent
      if ('id' in data && data.id !== undefined) {
        const resp = data as CDPResponse;
        const cb = this.callbacks.get(resp.id);
        if (cb) {
          this.callbacks.delete(resp.id);
          if (resp.error) {
            cb.reject(new Error(resp.error.message));
          } else {
            cb.resolve(resp.result);
          }
        }
        return;
      }

      // CDP event (domain notification)
      const event = data as CDPEvent;
      if (event.method) {
        this.emit('event', event);
      }
    });

    socket.on('close', () => {
      this._cleanup();
      this.emit('disconnected');
    });

    socket.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  /**
   * Reject all pending callbacks and reset internal state.
   * Called on WebSocket close (intentional or not).
   */
  private _cleanup(): void {
    for (const { reject } of this.callbacks.values()) {
      reject(new Error('WebSocket closed'));
    }
    this.callbacks.clear();
    this.sessionPool.clear();
    this.targetCache = null;
    this.ws = null;
    this._state = 'disconnected';
  }

  // ── Session Pooling ────────────────────────────────────────────

  /**
   * Get a cached CDP session ID for a target, or null if not pooled.
   * Avoids redundant Target.attachToTarget calls for already-attached targets.
   */
  getPooledSession(targetId: string): string | null {
    return this.sessionPool.get(targetId) ?? null;
  }

  /**
   * Store a CDP session ID for a target in the pool.
   */
  poolSession(targetId: string, sessionId: string): void {
    this.sessionPool.set(targetId, sessionId);
  }

  /**
   * Remove a session from the pool (e.g. on detach or target close).
   */
  unpoolSession(targetId: string): void {
    this.sessionPool.delete(targetId);
  }

  /** Number of pooled sessions */
  get pooledSessionCount(): number {
    return this.sessionPool.size;
  }

  // ── Target Caching ─────────────────────────────────────────────

  /**
   * Get targets with caching. If a valid cached result exists within
   * the TTL window, returns it without issuing a CDP command.
   * Otherwise fetches fresh targets and caches the result.
   */
  async getTargetsCached(): Promise<unknown> {
    const now = Date.now();
    if (
      this.targetCache &&
      now - this.targetCache.timestamp < this.targetCacheTTL
    ) {
      return this.targetCache.targets;
    }

    const result = await this.send('Target.getTargets');
    this.targetCache = { targets: result, timestamp: Date.now() };
    return result;
  }

  /**
   * Invalidate the target cache (e.g. after creating/closing a tab).
   */
  invalidateTargetCache(): void {
    this.targetCache = null;
  }
}
