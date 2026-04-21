/**
 * Tab management tool — list, search, create, close, activate, inspect.
 *
 * Extracted from server.js handleTabs* handlers.
 */

import type { ServerContext, ToolResult } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';
import { Errors } from '../utils/error-handler.js';

// ─── Action Handlers ────────────────────────────────────────────────

async function handleList(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const sessionId = args._agentSessionId as string | undefined;
  let showAll = args.showAll as boolean | undefined;

  const targets = (await ctx.sendCommand('Target.getTargets', {
    filter: [{ type: 'page' }],
  })) as { targetInfos: Array<Record<string, unknown>> };

  const tabs = targets.targetInfos ?? [];
  if (!tabs.length) return ok('No open tabs found.');

  // Issue #23: If session has 0 owned tabs, auto-enable showAll
  let autoShowAll = false;
  if (!showAll && sessionId) {
    const ownedCount = tabs.filter(
      (t) => ctx.tabOwnership.getLock(t.targetId as string)?.sessionId === sessionId,
    ).length;
    if (ownedCount === 0) {
      showAll = true;
      autoShowAll = true;
    }
  }

  const lines = tabs.map((t, i) => {
    const targetId = t.targetId as string;
    const title = t.title as string;
    const url = t.url as string;

    const lock = ctx.tabOwnership.getLock(targetId);
    const lockTag =
      lock?.sessionId && lock.sessionId !== sessionId
        ? ` [locked by: ${lock.sessionId.substring(0, 8)}…]`
        : '';
    return `${i + 1}. [${targetId}]${lockTag}\n   ${title}\n   ${url}`;
  });

  const prefix = autoShowAll
    ? '(No session-owned tabs — showing all browser tabs automatically)\n\n'
    : '';

  return ok(`${prefix}${tabs.length} tab(s):\n\n${lines.join('\n\n')}`);
}

async function handleFind(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const query = args.query as string | undefined;
  if (!query) return fail("Provide 'query' to search tabs.");

  const q = query.toLowerCase();
  const targets = (await ctx.sendCommand('Target.getTargets', {
    filter: [{ type: 'page' }],
  })) as { targetInfos: Array<Record<string, unknown>> };

  const tabs = targets.targetInfos ?? [];
  const hits = tabs.filter((t) => {
    const title = (t.title as string).toLowerCase();
    const url = (t.url as string).toLowerCase();
    return title.includes(q) || url.includes(q);
  });

  if (!hits.length) return ok(`No tabs matching "${query}".`);

  const sessionId = args._agentSessionId as string | undefined;
  const lines = hits.map((t) => {
    const targetId = t.targetId as string;
    const title = t.title as string;
    const url = t.url as string;

    const lock = ctx.tabOwnership.getLock(targetId);
    const lockTag =
      lock?.sessionId && lock.sessionId !== sessionId
        ? ` [locked by: ${lock.sessionId.substring(0, 8)}…]`
        : '';
    return `[${targetId}]${lockTag} ${title}\n   ${url}`;
  });

  return ok(`${hits.length} match(es):\n\n${lines.join('\n\n')}`);
}

async function handleNew(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const url = (args.url as string) || 'about:blank';
  const background =
    args.activate === false || args.activate === undefined;

  // Phase 1: Create the tab with about:blank (no URL yet)
  const createParams: Record<string, unknown> = { url: 'about:blank', background };

  // Issue #11: Profile-aware tab creation — resolve profile name to browserContextId
  if (args.profile) {
    const profileInput = (args.profile as string).trim().toLowerCase();

    try {
      // Get all browser contexts (each profile has its own context)
      const { browserContextIds } = (await ctx.sendCommand(
        'Target.getBrowserContexts',
        {},
      )) as { browserContextIds: string[] };

      // Get all tabs to map browserContextId to profile names
      const { targetInfos } = (await ctx.sendCommand('Target.getTargets', {
        filter: [{ type: 'page' }],
      })) as { targetInfos: Array<Record<string, unknown>> };

      // Build a map of contextId → tab info for identification
      const contextTabs = new Map<string, Array<Record<string, unknown>>>();
      for (const t of targetInfos ?? []) {
        const ctxId = t.browserContextId as string | undefined;
        if (ctxId) {
          if (!contextTabs.has(ctxId)) contextTabs.set(ctxId, []);
          contextTabs.get(ctxId)!.push(t);
        }
      }

      // Also get discovered profile metadata from the filesystem
      const { discoverBrowserInstances } = await import(
        '../connection/browser-discovery.js'
      );
      const instances = discoverBrowserInstances();
      const profileMap = new Map<
        string,
        { name: string; email?: string; directory: string }
      >();
      for (const inst of instances) {
        for (const p of inst.profiles) {
          profileMap.set(p.directory.toLowerCase(), p);
        }
      }

      // Try to match the profile input against known context IDs
      let matchedContextId: string | null = null;

      // Collect available profiles for error reporting
      const available: string[] = [];

      // All context IDs from tabs (includes the default browser context)
      const allContextIds = new Set<string>();
      for (const t of targetInfos ?? []) {
        const ctxId = t.browserContextId as string | undefined;
        if (ctxId) allContextIds.add(ctxId);
      }
      for (const cid of browserContextIds) allContextIds.add(cid);

      for (const ctxId of allContextIds) {
        const tabs = contextTabs.get(ctxId) ?? [];
        // Try to identify profile name from discovered metadata or tab URLs
        let label = ctxId.substring(0, 12) + '…';
        let matched = false;

        // Match by direct context ID
        if (ctxId.toLowerCase().startsWith(profileInput)) {
          matched = true;
        }

        // Match by profile directory name, display name, or email
        for (const [dir, pInfo] of profileMap) {
          // Check if any tab in this context belongs to this profile
          // We match by checking if the profile directory matches common patterns
          if (
            dir === profileInput ||
            pInfo.name.toLowerCase() === profileInput ||
            pInfo.email?.toLowerCase() === profileInput
          ) {
            // Verify this profile has tabs in this context by checking
            // if the context has any tabs at all (heuristic)
            if (tabs.length > 0) {
              matchedContextId = ctxId;
              matched = true;
            }
            label = `${pInfo.name}${pInfo.email ? ` (${pInfo.email})` : ''} [${pInfo.directory}]`;
          } else {
            label = `${pInfo.name}${pInfo.email ? ` (${pInfo.email})` : ''} [${pInfo.directory}]`;
          }
        }

        if (matched && !matchedContextId) {
          matchedContextId = ctxId;
        }
        available.push(`  ${label} — ${tabs.length} tab(s) — context: ${ctxId}`);
      }

      if (!matchedContextId) {
        return fail(
          `Profile "${args.profile}" not found.\n\n` +
            `Available profiles/contexts:\n${available.join('\n')}\n\n` +
            'Provide a profile name, email, directory name, or context ID prefix.',
        );
      }

      createParams.browserContextId = matchedContextId;
    } catch (err) {
      return fail(
        `Failed to resolve profile "${args.profile}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Phase 1: Create tab at about:blank
  const result = (await ctx.sendCommand(
    'Target.createTarget',
    createParams,
  )) as { targetId: string };
  const targetId = result.targetId;

  // Register ownership so tabs.list shows the tab immediately
  const session = args._agentSession as
    | { tabIds: Set<string> }
    | undefined;
  const sessionId = args._agentSessionId as string | undefined;
  if (session && sessionId) {
    session.tabIds.add(targetId);
    ctx.tabOwnership.lock(targetId, sessionId, true, 'created');
  }

  // Phase 2: Attach CDP session to the new tab
  const { sessionId: cdpSessionId } = (await ctx.sendCommand(
    'Target.attachToTarget',
    { targetId, flatten: true },
  )) as { sessionId: string };

  // Phase 3: Enable required domains before navigating
  await Promise.all([
    ctx.sendCommand('Page.enable', {}, cdpSessionId).catch(() => {}),
    ctx.sendCommand('Runtime.enable', {}, cdpSessionId).catch(() => {}),
    ctx.sendCommand('Network.enable', {}, cdpSessionId).catch(() => {}),
    ctx.sendCommand('DOM.enable', {}, cdpSessionId).catch(() => {}),
  ]);

  // Phase 4: Navigate to the actual URL (skip if about:blank)
  if (url !== 'about:blank') {
    const navResult = (await ctx.sendCommand(
      'Page.navigate',
      { url },
      cdpSessionId,
    )) as { errorText?: string };

    if (navResult.errorText) {
      return fail(
        `Tab created [${targetId}] but navigation failed: ${navResult.errorText}`,
      );
    }

    // Phase 5: Wait for load
    try {
      await ctx.sendCommand(
        'Runtime.evaluate',
        {
          expression: `new Promise(resolve => {
            if (document.readyState === 'complete') return resolve(true);
            window.addEventListener('load', () => resolve(true), { once: true });
          })`,
          awaitPromise: true,
          returnByValue: true,
        },
        cdpSessionId,
      );
    } catch {
      // Best-effort wait — don't fail the whole operation
    }
  }

  return ok(
    `New tab: [${targetId}]\nURL: ${url}${background ? '' : ' (activated)'}`,
  );
}

async function handleClose(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tabId = args.tabId as string | undefined;
  if (!tabId) return fail("Provide 'tabId' to close.");

  const lock = ctx.tabOwnership.getLock(tabId);
  const sessionId = args._agentSessionId as string | undefined;
  if (lock?.sessionId && lock.sessionId !== sessionId) {
    return fail(
      `Tab [${tabId}] is locked by another session. Cannot close.`,
    );
  }

  // Detach CDP session if attached, then close the target
  ctx.tabOwnership.release(tabId);
  await ctx.sendCommand('Target.closeTarget', { targetId: tabId });
  return ok('Tab closed.');
}

async function handleActivate(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tabId = args.tabId as string | undefined;
  if (!tabId) return fail("Provide 'tabId' to activate.");

  await ctx.sendCommand('Target.activateTarget', { targetId: tabId });
  return ok('Tab activated (brought to foreground).');
}

async function handleInfo(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tabId = args.tabId as string | undefined;
  if (!tabId) return fail("Provide 'tabId'.");

  const targets = (await ctx.sendCommand('Target.getTargets', {
    filter: [{ type: 'page' }],
  })) as { targetInfos: Array<Record<string, unknown>> };

  const tab = targets.targetInfos?.find(
    (t) => t.targetId === tabId,
  );
  if (!tab) return fail('Tab not found.');

  const contextId = tab.browserContextId
    ? `\nProfile context: ${tab.browserContextId}`
    : '';

  return ok(
    `Tab: ${tab.title}\nURL: ${tab.url}\nID: ${tab.targetId}` +
      contextId +
      '\nSession: connected',
  );
}

// ─── Action Dispatch ────────────────────────────────────────────────

const ACTIONS: Record<
  string,
  (ctx: ServerContext, args: Record<string, unknown>) => Promise<ToolResult>
> = {
  list: handleList,
  find: handleFind,
  new: handleNew,
  close: handleClose,
  activate: handleActivate,
  info: handleInfo,
};

// ─── Registration ───────────────────────────────────────────────────

export function registerTabsTools(
  registry: ToolRegistry,
  ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'tabs',
      description: [
        'Tab management. The server auto-connects to your browser — no need to call browser.connect() first. Just use any tool and it works.',
        '',
        "Default cleanup is 'detach' — tabs stay open after your session ends. You don't need to set cleanupStrategy unless you want tabs auto-closed.",
        '',
        'Use showAll: true to see ALL browser tabs, not just ones you created this session.',
        '',
        'Operations:',
        '- list: List all open browser tabs with their IDs, URLs, and titles',
        '- find: Search tabs by title or URL substring (requires: query)',
        '- new: Open a new tab (optional: url — defaults to about:blank, activate — bring to foreground, default: false, profile — create in specific Chrome profile by name/email/directory)',
        '- close: Close a specific tab (requires: tabId)',
        '- activate: Bring a tab to the foreground (requires: tabId)',
        '- info: Get detailed info about a tab including URL, title, and connection status (requires: tabId)',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'find', 'new', 'close', 'activate', 'info'],
            description: 'Tab action to perform.',
          },
          query: {
            type: 'string',
            description: "Search text for 'find' action.",
          },
          tabId: {
            type: 'string',
            description: 'Tab ID for close/activate/info.',
          },
          url: {
            type: 'string',
            description: "URL for 'new' action.",
          },
          activate: {
            type: 'boolean',
            description:
              'Bring new tab to foreground (default: false — opens in background without stealing focus).',
          },
          profile: {
            type: 'string',
            description:
              "Create tab in a specific Chrome profile (by name, email, or directory e.g. 'Work', 'mansha@gmail.com', 'Profile 7'). Requires the profile to have at least one open tab for context resolution.",
          },
          showAll: {
            type: 'boolean',
            description:
              'Show all browser tabs, not just session-owned ones (for list action).',
          },
          sessionId: {
            type: 'string',
            description:
              'Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID.',
          },
          cleanupStrategy: {
            type: 'string',
            enum: ['close', 'detach', 'none'],
            description:
              "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session.",
          },
          exclusive: {
            type: 'boolean',
            description:
              'Lock tab to this session (default: true). Set false to allow shared access.',
          },
        },
        required: ['action'],
      },
      handler: async (
        _ctx: ServerContext,
        params: Record<string, unknown>,
      ): Promise<ToolResult> => {
        const action = params.action as string;
        const handler = ACTIONS[action];
        if (!handler) {
          return fail(
            `Unknown tabs action: "${action}". ` +
              `Available: ${Object.keys(ACTIONS).join(', ')}`,
          );
        }
        return handler(ctx, params);
      },
    }),
  );
}
