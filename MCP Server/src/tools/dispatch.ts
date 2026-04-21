/**
 * Central preprocessing layer that runs before every tool handler.
 *
 * Mirrors the session routing, tab claiming, and modal-check logic
 * that lived in server.js handleTool() but was missing from the v5
 * registry-based dispatch.
 *
 * P0-1 fix: Without this, tools never receive _agentSessionId or
 * _agentSession — session isolation and tab locking are broken.
 */

import type { ServerContext } from '../types.js';
import type { CleanupStrategy } from '../types.js';
import { Errors } from '../utils/error-handler.js';

/** Timestamp of the last stale-session sweep. */
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Preprocess a tool call: resolve agent session, claim tab locks,
 * check modal blockers, and inject internal fields.
 */
export async function preprocessToolCall(
  ctx: ServerContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // 1. Resolve or create agent session
  const sessionId = (args.sessionId as string) || ctx.processSessionId;
  const cleanupStrategy = (args.cleanupStrategy as CleanupStrategy) || undefined;
  const session = ctx.sessions.getOrCreate(
    sessionId,
    ctx.config.defaultCleanupStrategy,
    cleanupStrategy,
  );
  ctx.sessions.touch(sessionId);

  // 2. Sweep stale sessions periodically (non-blocking)
  const now = Date.now();
  if (now - lastSweep > SWEEP_INTERVAL_MS) {
    lastSweep = now;
    ctx.sessions.sweepStale(ctx.config.sessionTTL, async (expired) => {
      // Release tab locks for expired session
      ctx.tabOwnership.releaseSession(expired.id);
    }).catch(() => { /* best-effort sweep */ });
  }

  // 3. If tabId provided, claim tab lock if unowned
  const tabId = args.tabId as string | undefined;
  if (tabId) {
    const exclusive = args.exclusive !== false;
    const claimed = ctx.tabOwnership.claimIfUnowned(tabId, sessionId, exclusive);
    if (!claimed && !ctx.tabOwnership.canAccess(tabId, sessionId, exclusive ? undefined : false)) {
      const lock = ctx.tabOwnership.getLock(tabId);
      throw Errors.tabLocked(tabId, lock?.sessionId ?? 'another session');
    }
    // Add to session's tab set
    session.tabIds.add(tabId);
  }

  // 4. Check modal state blocking
  if (tabId && ctx.modalStates) {
    const action = args.action as string | undefined;
    const blocked = ctx.modalStates.checkBlocked(tabId, toolName, action);
    if (blocked) throw blocked;
  }

  // 5. Inject internal fields for tools
  args._agentSessionId = sessionId;
  args._agentSession = session;

  return args;
}
