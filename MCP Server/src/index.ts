/**
 * Entry point for the CDP Browser MCP Server v5.
 *
 * Wires together all extracted modules:
 *  - Configuration (env vars → typed config)
 *  - CDP client (WebSocket connection to the browser)
 *  - Health monitor (ping/pong + auto-reconnect)
 *  - Domain manager (lazy CDP domain enablement)
 *  - Snapshot cache (incremental/diff snapshots)
 *  - Tool registry (registration + dispatch)
 *  - MCP SDK server (STDIO transport)
 *
 * Startup optimizations:
 *  - No browser discovery at startup (lazy on first tool call)
 *  - Synchronous tool registration (no async)
 *  - STDIO transport started immediately
 *  - Startup time logged to stderr for benchmarking
 */

const startTime = performance.now();

import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { CDPClient } from './connection/cdp-client.js';
import { DomainManager } from './connection/domain-manager.js';
import { TabSessionService } from './connection/tab-session-service.js';
import { SessionManager } from './session/session-manager.js';
import { TabOwnership } from './session/tab-ownership.js';
import { ModalStateManager } from './session/modal-state.js';
import { HealthMonitor } from './connection/health-monitor.js';
import { SnapshotCache } from './snapshot/cache.js';
import { ToolRegistry } from './tools/registry.js';
import { preprocessToolCall } from './tools/dispatch.js';
import { defineTool, success } from './tools/base-tool.js';
import { wrapError } from './utils/error-handler.js';
import type { ServerContext } from './types.js';

// Tool modules
import { registerTabsTools } from './tools/tabs.js';
import { registerPageTools } from './tools/page.js';
import { registerInteractTools } from './tools/interact.js';
import { registerExecuteTools } from './tools/execute.js';
import { registerObserveTools } from './tools/observe.js';
import { registerEmulateTools } from './tools/emulate.js';
import { registerStorageTools } from './tools/storage.js';
import { registerInterceptTools } from './tools/intercept.js';
import { registerCleanupTools } from './tools/cleanup.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerDebugTools } from './tools/debug.js';
import { registerFormTools } from './tools/form.js';

// ─── Bootstrap ──────────────────────────────────────────────────────

const VERSION = '5.0.0-alpha.1';

const config = loadConfig();

const cdpClient = new CDPClient({ commandTimeout: config.globalTimeout });

// Lazy initialization: HealthMonitor is created but doesn't discover browsers
const healthMonitor = new HealthMonitor(cdpClient, {
  cdpHost: config.cdpHost,
  cdpPort: config.cdpPort,
  preferredProfile: config.autoConnectProfile,
});

const domainManager = new DomainManager();
const tabSessionService = new TabSessionService();
const snapshotCache = new SnapshotCache();
const registry = new ToolRegistry();

// Wire auto-reconnect: when the WebSocket drops, let HealthMonitor retry
// and clear domain state since all sessions are invalidated
cdpClient.on('disconnected', () => {
  domainManager.clearAll();
  snapshotCache.clear();
  tabSessionService.clear();
  healthMonitor.onDisconnect().catch(() => {
    // Reconnect failed — next tool call will trigger autoConnect
  });
});

// ─── Server Context (DI container) ──────────────────────────────────

const ctx: ServerContext = {
  config,
  cdpClient,
  healthMonitor,
  domainManager,
  sendCommand: (method, params, sessionId) =>
    cdpClient.send(method, params ?? {}, sessionId),
  tabSessions: tabSessionService,
  sessions: new SessionManager(),
  tabOwnership: new TabOwnership(),
  modalStates: new ModalStateManager(),
  processSessionId: randomUUID(),
  snapshotCache,
  elementResolvers: new Map(),
};

// ─── Auto-connect with mutex (P0-2) ────────────────────────────────

let connectPromise: Promise<void> | null = null;

async function ensureConnected(): Promise<void> {
  if (cdpClient.isConnected) return;
  if (connectPromise) return connectPromise;

  connectPromise = healthMonitor.autoConnect();
  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

// ─── Demo Tools ─────────────────────────────────────────────────────

registry.register(
  defineTool({
    name: 'ping',
    description: 'Health check. Returns server version and connection status.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () =>
      success(
        `pong — CDP Browser MCP v${VERSION}\nConnected: ${cdpClient.isConnected}`,
      ),
  }),
);

registry.register(
  defineTool({
    name: 'status',
    description: 'Server status: connection, config, sessions.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const lines = [
        `## CDP Browser MCP Server v${VERSION}`,
        `Connected: ${cdpClient.isConnected}`,
        `Default timeout: ${config.globalTimeout}ms`,
        `Default cleanup: ${config.defaultCleanupStrategy}`,
        `Session TTL: ${config.sessionTTL}ms`,
        `Registered tools: ${registry.size}`,
      ];
      return success(lines.join('\n'));
    },
  }),
);

// ─── Register All Tool Modules ──────────────────────────────────────

registerTabsTools(registry, ctx);
registerPageTools(registry, ctx);
registerInteractTools(registry, ctx);
registerExecuteTools(registry, ctx);
registerObserveTools(registry, ctx);
registerEmulateTools(registry, ctx);
registerStorageTools(registry, ctx);
registerInterceptTools(registry, ctx);
registerCleanupTools(registry, ctx);
registerBrowserTools(registry, ctx);
registerDebugTools(registry, ctx);
registerFormTools(registry, ctx);

// ─── MCP Server─────────────────────────────────────────────────────

const server = new Server(
  { name: 'cdp-browser', version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: registry.list(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  // Auto-connect on first tool call
  // P0-1 (cycle 2): browser tool is exempt — it needs to work when NOT connected
  // P0-4: Surface connection errors for browser-dependent tools instead of swallowing
  const CONNECT_EXEMPT_TOOLS = new Set(['ping', 'status', 'browser']);
  if (!CONNECT_EXEMPT_TOOLS.has(name)) {
    try {
      await ensureConnected();
    } catch (err) {
      return wrapError(err).toToolResult();
    }
  }

  try {
    // P0-1: Preprocess — session routing, tab claiming, modal checks
    const args = await preprocessToolCall(ctx, name, rawArgs ?? {});
    return await registry.dispatch(name, args, ctx);
  } catch (err) {
    return wrapError(err).toToolResult();
  }
});

// ─── Start ──────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

const elapsed = performance.now() - startTime;
process.stderr.write(`CDP Browser MCP v${VERSION} started in ${elapsed.toFixed(0)}ms\n`);
