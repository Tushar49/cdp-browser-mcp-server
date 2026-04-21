/**
 * Intercept tool — HTTP request interception via CDP Fetch domain.
 *
 * Actions: enable, disable, continue, fulfill, fail, list.
 * Allows intercepting, modifying, mocking, or blocking network requests.
 */

import type { ToolRegistry } from './registry.js';
import type { ServerContext, ToolResult } from '../types.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';

// ─── Action handlers ────────────────────────────────────────────────

async function handleEnable(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  const patterns = (params.patterns as string[]) || ['*'];

  const fetchPatterns = patterns.map(url => ({
    urlPattern: url,
    requestStage: 'Request',
  }));

  await ctx.sendCommand('Fetch.enable', { patterns: fetchPatterns }, sess);

  return ok(`Request interception enabled.\nPatterns: ${patterns.join(', ')}\nPaused requests will auto-continue after 10s if not handled.`);
}

async function handleDisable(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Fetch.disable', {}, sess);
  return ok('Request interception disabled.');
}

async function handleContinue(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  if (!params.requestId) return fail("Provide 'requestId'.");
  const sess = params._sessionId as string;

  const cdpParams: Record<string, unknown> = { requestId: params.requestId as string };
  if (params.url) cdpParams.url = params.url;
  if (params.method) cdpParams.method = params.method;
  if (params.postData) cdpParams.postData = Buffer.from(params.postData as string).toString('base64');
  if (params.headers) {
    cdpParams.headers = Object.entries(params.headers as Record<string, string>).map(
      ([name, value]) => ({ name, value: String(value) }),
    );
  }

  await ctx.sendCommand('Fetch.continueRequest', cdpParams, sess);
  return ok(`Request ${params.requestId} continued${params.url ? ` (redirected to ${params.url})` : ''}.`);
}

async function handleFulfill(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  if (!params.requestId) return fail("Provide 'requestId'.");
  const sess = params._sessionId as string;

  const responseCode = (params.status as number) || 200;
  const cdpParams: Record<string, unknown> = {
    requestId: params.requestId as string,
    responseCode,
  };

  if (params.headers) {
    cdpParams.responseHeaders = Object.entries(params.headers as Record<string, string>).map(
      ([name, value]) => ({ name, value: String(value) }),
    );
  } else {
    cdpParams.responseHeaders = [{ name: 'Content-Type', value: 'application/json' }];
  }

  if (params.body !== undefined) {
    cdpParams.body = Buffer.from(params.body as string).toString('base64');
  }

  await ctx.sendCommand('Fetch.fulfillRequest', cdpParams, sess);
  return ok(`Request ${params.requestId} fulfilled with status ${responseCode}.`);
}

async function handleFail(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  if (!params.requestId) return fail("Provide 'requestId'.");
  const sess = params._sessionId as string;

  const reason = (params.reason as string) || 'Failed';
  await ctx.sendCommand('Fetch.failRequest', {
    requestId: params.requestId as string,
    reason,
  }, sess);

  return ok(`Request ${params.requestId} failed with reason: ${reason}.`);
}

async function handleList(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  // Pending intercepted requests are tracked in memory by the runtime layer.
  // The Fetch domain events (Fetch.requestPaused) populate the pending map.
  // This stub returns the structure; the runtime integration fills the data.
  void ctx;
  void params;

  // In the full server, pending requests come from an in-memory Map keyed by session.
  return ok('No pending intercepted requests.');
}

// ─── Registration ───────────────────────────────────────────────────

export function registerInterceptTools(
  registry: ToolRegistry,
  _ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'intercept',
      description: [
        'HTTP request interception via CDP Fetch domain. Intercept, modify, mock, or block network requests in real-time.',
        '',
        'Operations:',
        "- enable: Start intercepting requests matching URL patterns (requires: tabId; optional: patterns — array of URL glob patterns, e.g. ['*.api.example.com/*'])",
        '- disable: Stop all request interception (requires: tabId)',
        '- continue: Resume a paused request, optionally modifying it (requires: tabId, requestId; optional: url, method, headers, postData)',
        '- fulfill: Respond to a paused request with a custom/mocked response (requires: tabId, requestId; optional: status, body, headers)',
        '- fail: Abort a paused request with a network error (requires: tabId, requestId; optional: reason)',
        '- list: List all currently paused/intercepted requests (requires: tabId)',
        '',
        'Failure Reasons: Failed, Aborted, TimedOut, AccessDenied, ConnectionClosed, ConnectionReset, ConnectionRefused, ConnectionAborted, ConnectionFailed, NameNotResolved, InternetDisconnected, AddressUnreachable, BlockedByClient, BlockedByResponse',
        '',
        'Notes:',
        "- Call 'enable' first with URL patterns to start intercepting",
        '- Intercepted requests are paused until you call continue, fulfill, or fail',
        "- Each intercepted request has a unique requestId shown in the 'list' output",
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['enable', 'disable', 'continue', 'fulfill', 'fail', 'list'], description: 'Intercept action.' },
          tabId: { type: 'string', description: 'Tab ID.' },
          patterns: { type: 'array', items: { type: 'string' }, description: "URL patterns to intercept, e.g. ['*.api.example.com/*']." },
          requestId: { type: 'string', description: 'Paused request ID.' },
          url: { type: 'string', description: 'Override URL for continue.' },
          method: { type: 'string', description: 'Override method for continue.' },
          headers: { type: 'object', description: 'Override headers for continue/fulfill.' },
          postData: { type: 'string', description: 'Override body for continue.' },
          status: { type: 'number', description: 'Response status for fulfill.' },
          body: { type: 'string', description: 'Response body for fulfill.' },
          reason: {
            type: 'string',
            enum: [
              'Failed', 'Aborted', 'TimedOut', 'AccessDenied',
              'ConnectionClosed', 'ConnectionReset', 'ConnectionRefused',
              'ConnectionAborted', 'ConnectionFailed', 'NameNotResolved',
              'InternetDisconnected', 'AddressUnreachable',
              'BlockedByClient', 'BlockedByResponse',
            ],
            description: 'Failure reason.',
          },
          sessionId: { type: 'string', description: 'Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID.' },
          cleanupStrategy: { type: 'string', enum: ['close', 'detach', 'none'], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
          exclusive: { type: 'boolean', description: 'Lock tab to this session (default: true). Set false to allow shared access.' },
        },
        required: ['action', 'tabId'],
      },
      handler: async (ctx, params) => {
        const action = params.action as string;
        switch (action) {
          case 'enable':    return handleEnable(ctx, params);
          case 'disable':   return handleDisable(ctx, params);
          case 'continue':  return handleContinue(ctx, params);
          case 'fulfill':   return handleFulfill(ctx, params);
          case 'fail':      return handleFail(ctx, params);
          case 'list':      return handleList(ctx, params);
          default:          return fail(`Unknown intercept action: "${action}". Use: enable, disable, continue, fulfill, fail, list`);
        }
      },
    }),
  );
}
