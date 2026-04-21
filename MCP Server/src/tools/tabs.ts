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
  const showAll = args.showAll as boolean | undefined;

  const targets = (await ctx.sendCommand('Target.getTargets', {
    filter: [{ type: 'page' }],
  })) as { targetInfos: Array<Record<string, unknown>> };

  const tabs = targets.targetInfos ?? [];
  if (!tabs.length) return ok('No open tabs found.');

  const lines = tabs.map((t, i) => {
    const targetId = t.targetId as string;
    const title = t.title as string;
    const url = t.url as string;

    const lock = ctx.tabLocks.get(targetId);
    const lockTag =
      lock?.sessionId && lock.sessionId !== sessionId
        ? ` [locked by: ${lock.sessionId.substring(0, 8)}…]`
        : '';
    return `${i + 1}. [${targetId}]${lockTag}\n   ${title}\n   ${url}`;
  });

  return ok(`${tabs.length} tab(s):\n\n${lines.join('\n\n')}`);
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

    const lock = ctx.tabLocks.get(targetId);
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

  const createParams: Record<string, unknown> = { url, background };

  // Profile-aware tab creation: resolve profile name to browserContextId
  if (args.profile) {
    // Profile resolution will be delegated to a context helper once wired;
    // for now we pass the raw profile hint for future resolution.
    return fail(
      `Profile "${args.profile}" resolution not yet wired in TypeScript module. ` +
        'Use browser.active to see available profiles.',
    );
  }

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
    ctx.tabLocks.set(targetId, { sessionId, origin: 'created' });
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

  const lock = ctx.tabLocks.get(tabId);
  const sessionId = args._agentSessionId as string | undefined;
  if (lock?.sessionId && lock.sessionId !== sessionId) {
    return fail(
      `Tab [${tabId}] is locked by another session. Cannot close.`,
    );
  }

  // Detach CDP session if attached, then close the target
  ctx.tabLocks.delete(tabId);
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
        'Manage browser tabs: list, search, create, close, activate, and inspect tabs.',
        '',
        'Operations:',
        '- list: List all open browser tabs with their IDs, URLs, and titles',
        "- find: Search tabs by title or URL substring (requires: query)",
        "- new: Open a new tab (optional: url — defaults to about:blank, activate — bring to foreground, default: false, profile — create in specific Chrome profile by name/email/directory)",
        '- close: Close a specific tab (requires: tabId)',
        '- activate: Bring a tab to the foreground (requires: tabId)',
        '- info: Get detailed info about a tab including URL, title, and connection status (requires: tabId)',
        '',
        'Agent guidance:',
        "- You don't need to call browser.connect first — the server auto-connects to a running browser",
        "- Default cleanupStrategy is 'detach' — tabs persist after session expiry",
        '- Use showAll: true to see all browser tabs, not just session-owned ones',
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
