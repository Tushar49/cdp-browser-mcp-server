/**
 * Browser instance management tool — profiles, connect, active.
 *
 * Extracted from server.js handleBrowser* handlers.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { ServerContext, ToolResult } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';
import { Errors } from '../utils/error-handler.js';
import {
  discoverBrowserInstances,
  findBestInstance,
} from '../connection/browser-discovery.js';

// ─── Action Handlers ────────────────────────────────────────────────

async function handleProfiles(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  const instances = discoverBrowserInstances();
  if (!instances.length) {
    return ok(
      'No Chrome instances found with remote debugging enabled.\n' +
        'Launch Chrome with --remote-debugging-port=9222 or enable chrome://flags/#enable-remote-debugging',
    );
  }

  const connectedPort = ctx.cdpClient.isConnected
    ? parseInt(ctx.cdpClient.url?.match(/:(\d+)/)?.[1] ?? '0', 10)
    : null;

  const sections = instances.map((inst) => {
    const connTag = inst.port === connectedPort ? ' [CONNECTED]' : '';
    let section = `${inst.name}${connTag}\n  Port: ${inst.port}\n  User Data: ${inst.userDataDir}`;
    if (inst.profiles.length) {
      section += `\n  Profiles (${inst.profiles.length}):`;
      for (const p of inst.profiles) {
        const email = p.email ? ` (${p.email})` : '';
        section += `\n    ${p.directory}: ${p.name}${email}`;
      }
    }
    return section;
  });

  return ok(
    `Chrome instances: ${instances.length}\n\n${sections.join('\n\n')}`,
  );
}

async function handleConnect(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const instance = args.instance as string | undefined;
  if (!instance) {
    return fail(
      "Provide 'instance' — name (e.g. 'Chrome'), port number (e.g. '9333'), or User Data directory path.",
    );
  }

  // Guard: reject if other agent sessions are active
  const callerSessionId = args._agentSessionId as string | undefined;
  const activeSessions = [...ctx.sessions.entries()].filter(
    ([id]) => id !== callerSessionId,
  );
  const withTabs = activeSessions.filter(([, s]) => s.tabIds.size > 0);
  if (withTabs.length > 0) {
    const ids = withTabs
      .map(
        ([id, s]) =>
          `${id.substring(0, 8)}… (${s.tabIds.size} tabs)`,
      )
      .join(', ');
    return fail(
      `Cannot switch — ${withTabs.length} other session(s) with active tabs: ${ids}. End them first with cleanup.session.`,
    );
  }

  // Find the target instance
  const instances = discoverBrowserInstances();
  const target = findBestInstance(instances, instance.toString());
  if (!target) {
    const available =
      instances
        .map((i) => `${i.name} (port ${i.port})`)
        .join(', ') || 'none found';
    return fail(
      `Chrome instance "${instance}" not found. Available: ${available}`,
    );
  }

  // Check if already connected
  const connectedPort = ctx.cdpClient.isConnected
    ? parseInt(ctx.cdpClient.url?.match(/:(\d+)/)?.[1] ?? '0', 10)
    : null;
  if (target.port === connectedPort) {
    return ok(
      `Already connected to ${target.name} (port ${target.port}).`,
    );
  }

  // Clear caller's session state — tabs from old browser are invalid
  ctx.sessions.clear();
  ctx.tabOwnership.clear();
  ctx.elementResolvers.clear();

  // P1-4: Suppress auto-reconnect during browser switch
  ctx.healthMonitor.suppressAutoReconnect = true;

  // Disconnect current browser
  await ctx.cdpClient.disconnect();

  // Connect to new instance
  try {
    await ctx.cdpClient.connect(target.wsUrl);
    ctx.healthMonitor.onConnected();
  } finally {
    ctx.healthMonitor.suppressAutoReconnect = false;
  }

  return ok(
    `Connected to ${target.name}\nPort: ${target.port}\nUser Data: ${target.userDataDir}\n` +
      `Profiles: ${target.profiles.map((p) => p.name).join(', ') || 'unknown'}`,
  );
}

async function handleActive(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.cdpClient.isConnected) {
    return ok('Not connected to any Chrome instance.');
  }

  let text = `Connected: yes\nWebSocket: ${ctx.cdpClient.url ?? 'unknown'}\n`;
  text += `Health: ${ctx.healthMonitor.health.status}\n`;

  // Show tab count per browserContextId (profile grouping)
  try {
    const result = (await ctx.sendCommand('Target.getTargets', {
      filter: [{ type: 'page' }],
    })) as { targetInfos: Array<Record<string, unknown>> };

    const tabs = result.targetInfos ?? [];
    if (tabs.length) {
      const byContext: Record<string, number> = {};
      for (const t of tabs) {
        const ctxId = (t.browserContextId as string) || 'default';
        byContext[ctxId] = (byContext[ctxId] || 0) + 1;
      }
      text += `\nTabs by profile:\n`;
      for (const [ctxId, count] of Object.entries(byContext)) {
        text += `  ${ctxId.substring(0, 12)}… — ${count} tab(s)\n`;
      }
    }
  } catch {
    /* ok — best-effort */
  }

  return ok(text);
}

// ─── Action Dispatch ────────────────────────────────────────────────

const ACTIONS: Record<
  string,
  (ctx: ServerContext, args: Record<string, unknown>) => Promise<ToolResult>
> = {
  profiles: handleProfiles,
  connect: handleConnect,
  active: handleActive,
};

// ─── Registration ───────────────────────────────────────────────────

export function registerBrowserTools(
  registry: ToolRegistry,
  ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'browser',
      description: [
        'Browser instance management. You rarely need this — the server auto-connects on first tool call.',
        '',
        'Only use this to:',
        '- Switch between Chrome and Edge (connect action)',
        '- List available browser profiles (profiles action)',
        '- Check current connection (active action)',
        '',
        'DO NOT close or restart the browser — the user has important work open.',
        '',
        'Operations:',
        "- profiles: List all detected browser instances with their profiles, ports, and connection status",
        "- connect: Switch to a different browser instance by name, port, or User Data directory path (requires: instance — name like 'Chrome', 'Edge', or 'Brave', or port number, or path to User Data dir)",
        '- active: Show the currently connected browser instance, port, profiles, and WebSocket URL (no parameters)',
        '',
        'Notes:',
        '- All Chromium-based browsers use the same CDP protocol — Chrome, Edge, Brave, Chromium all work',
        '- All profiles within one browser instance share a single debug port — you cannot connect to a specific profile, only to an instance',
        '- Switching instances requires no other active agent sessions (use cleanup.session to end them first)',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['profiles', 'connect', 'active'],
            description: 'Browser action.',
          },
          instance: {
            type: 'string',
            description:
              "Browser instance to connect to — name (e.g. 'Chrome', 'Edge', 'Brave'), port number, or User Data directory path.",
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
            `Unknown browser action: "${action}". ` +
              `Available: ${Object.keys(ACTIONS).join(', ')}`,
          );
        }
        return handler(ctx, params);
      },
    }),
  );
}
