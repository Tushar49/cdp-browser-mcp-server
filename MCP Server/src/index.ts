/**
 * Entry point for the CDP Browser MCP Server v5.
 *
 * Wires together all extracted modules:
 *  - Configuration (env vars → typed config)
 *  - CDP client (WebSocket connection to the browser)
 *  - Health monitor (ping/pong + auto-reconnect)
 *  - Tool registry (registration + dispatch)
 *  - MCP SDK server (STDIO transport)
 */

import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { CDPClient } from './connection/cdp-client.js';
import { HealthMonitor } from './connection/health-monitor.js';
import { ToolRegistry } from './tools/registry.js';
import { defineTool, success } from './tools/base-tool.js';
import type { ServerContext } from './types.js';

// ─── Bootstrap ──────────────────────────────────────────────────────

const VERSION = '5.0.0-alpha.1';

const config = loadConfig();

const cdpClient = new CDPClient({ commandTimeout: config.globalTimeout });

const healthMonitor = new HealthMonitor(cdpClient, {
  cdpHost: config.cdpHost,
  cdpPort: config.cdpPort,
  preferredProfile: config.autoConnectProfile,
});

const registry = new ToolRegistry();

// Wire auto-reconnect: when the WebSocket drops, let HealthMonitor retry
cdpClient.on('disconnected', () => {
  healthMonitor.onDisconnect().catch(() => {
    // Reconnect failed — next tool call will trigger autoConnect
  });
});

// ─── Server Context (DI container) ──────────────────────────────────

const ctx: ServerContext = {
  config,
  cdpClient,
  healthMonitor,
  sendCommand: (method, params, sessionId) =>
    cdpClient.send(method, params ?? {}, sessionId),
  sessions: new Map(),
  tabLocks: new Map(),
  processSessionId: randomUUID(),
};

// ─── Auto-connect ───────────────────────────────────────────────────

async function ensureConnected(): Promise<void> {
  if (cdpClient.isConnected) return;
  await healthMonitor.autoConnect();
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

// ─── MCP Server ─────────────────────────────────────────────────────

const server = new Server(
  { name: 'cdp-browser', version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: registry.list(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Auto-connect on first tool call (best-effort — some tools work without a browser)
  try {
    await ensureConnected();
  } catch {
    // Connection failed — still dispatch; tools like ping/status work offline
  }

  return registry.dispatch(name, args ?? {}, ctx);
});

// ─── Start ──────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
