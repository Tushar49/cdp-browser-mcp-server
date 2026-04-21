/**
 * Storage tool — cookie and browser storage management.
 *
 * Actions: get_cookies, set_cookie, delete_cookies, clear_cookies, clear_data, quota.
 * Delegates to CDP Network and Storage domains.
 */

import type { ToolRegistry } from './registry.js';
import type { ServerContext, ToolResult } from '../types.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';

// ─── Action handlers ────────────────────────────────────────────────

async function handleGetCookies(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);

  const cdpParams: Record<string, unknown> = {};
  const urls = params.urls as string[] | undefined;
  if (urls?.length) cdpParams.urls = urls;

  const result = (await ctx.sendCommand('Network.getCookies', cdpParams, sess)) as Record<string, unknown>;
  const cookies = (result.cookies ?? []) as Array<Record<string, unknown>>;

  if (!cookies.length) return ok('No cookies found.');

  const lines = cookies.map(c => {
    const flags = [c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite].filter(Boolean).join(', ');
    const exp = (c.expires as number) > 0 ? new Date((c.expires as number) * 1000).toISOString() : 'session';
    const val = c.value as string;
    return `${c.name}=${val.substring(0, 60)}${val.length > 60 ? '...' : ''}\n  Domain: ${c.domain} | Path: ${c.path} | Expires: ${exp} | ${flags}`;
  });
  return ok(`${cookies.length} cookie(s):\n\n${lines.join('\n\n')}`);
}

async function handleSetCookie(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  if (!params.name || params.value === undefined) return fail("Provide 'name' and 'value'.");
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);

  const cookieParams: Record<string, unknown> = {
    name: params.name as string,
    value: params.value as string,
  };
  if (params.domain) cookieParams.domain = params.domain;
  if (params.path) cookieParams.path = params.path;
  if (params.secure !== undefined) cookieParams.secure = params.secure;
  if (params.httpOnly !== undefined) cookieParams.httpOnly = params.httpOnly;
  if (params.sameSite) cookieParams.sameSite = params.sameSite;
  if (params.expires) cookieParams.expires = params.expires;

  // If no domain, get from current page
  if (!cookieParams.domain && !cookieParams.url) {
    const urlResult = (await ctx.sendCommand('Runtime.evaluate', {
      expression: 'location.href', returnByValue: true,
    }, sess)) as Record<string, unknown>;
    const r = urlResult.result as Record<string, unknown>;
    cookieParams.url = r.value as string;
  }

  const result = (await ctx.sendCommand('Network.setCookie', cookieParams, sess)) as Record<string, unknown>;
  const val = params.value as string;
  return ok(result.success ? `Cookie set: ${params.name}=${val.substring(0, 40)}` : 'Failed to set cookie.');
}

async function handleDeleteCookies(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);

  const cdpParams: Record<string, unknown> = {};
  if (params.name) cdpParams.name = params.name;
  if (params.domain) cdpParams.domain = params.domain;
  if (params.url) cdpParams.url = params.url;

  if (!cdpParams.name) return fail("Provide 'name' to delete specific cookies.");

  // CDP requires at least url or domain
  if (!cdpParams.url && !cdpParams.domain) {
    const r = (await ctx.sendCommand('Runtime.evaluate', {
      expression: 'location.origin', returnByValue: true,
    }, sess)) as Record<string, unknown>;
    const origin = ((r.result as Record<string, unknown>)?.value as string) || '';
    if (origin && origin !== 'null') {
      cdpParams.url = origin;
      try { cdpParams.domain = new URL(origin).hostname; } catch { /* ok */ }
    }
  }

  await ctx.sendCommand('Network.deleteCookies', cdpParams, sess);
  return ok(`Deleted cookies matching: ${params.name}${params.domain ? ` (domain: ${params.domain})` : ''}`);
}

async function handleClearCookies(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);
  await ctx.sendCommand('Network.clearBrowserCookies', {}, sess);
  return ok('All cookies cleared.');
}

async function handleClearData(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;

  let origin = params.origin as string | undefined;
  if (!origin) {
    const r = (await ctx.sendCommand('Runtime.evaluate', {
      expression: 'location.origin', returnByValue: true,
    }, sess)) as Record<string, unknown>;
    origin = (r.result as Record<string, unknown>).value as string;
  }

  const storageTypes = params.types === 'all'
    ? 'cookies,local_storage,indexeddb,cache_storage,service_workers'
    : ((params.types as string) || 'local_storage,indexeddb,cache_storage');

  await ctx.sendCommand('Storage.clearDataForOrigin', { origin, storageTypes }, sess);
  return ok(`Cleared storage for ${origin}: ${storageTypes}`);
}

async function handleQuota(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;

  const r = (await ctx.sendCommand('Runtime.evaluate', {
    expression: 'location.origin', returnByValue: true,
  }, sess)) as Record<string, unknown>;
  const origin = (r.result as Record<string, unknown>).value as string;

  const quotaResult = (await ctx.sendCommand('Storage.getUsageAndQuota', { origin }, sess)) as Record<string, unknown>;
  const usage = quotaResult.usage as number;
  const quota = quotaResult.quota as number;
  const usageBreakdown = quotaResult.usageBreakdown as Array<{ storageType: string; usage: number }> | undefined;

  const fmt = (b: number): string => {
    if (b > 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
    if (b > 1048576) return `${(b / 1048576).toFixed(2)} MB`;
    if (b > 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  };

  let text = `Storage for ${origin}:\n  Usage: ${fmt(usage)} / ${fmt(quota)} (${(usage / quota * 100).toFixed(2)}%)`;
  if (usageBreakdown?.length) {
    text += '\n\nBreakdown:';
    for (const { storageType, usage: u } of usageBreakdown) {
      if (u > 0) text += `\n  ${storageType}: ${fmt(u)}`;
    }
  }
  return ok(text);
}

// ─── Registration ───────────────────────────────────────────────────

export function registerStorageTools(
  registry: ToolRegistry,
  _ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'storage',
      description: [
        'Cookie and storage management: get, set, and delete cookies, clear browser storage, and check storage quota.',
        '',
        'Operations:',
        '- get_cookies: Retrieve cookies (requires: tabId; optional: urls — filter by URLs)',
        '- set_cookie: Set a cookie (requires: tabId, name, value; optional: domain, path, secure, httpOnly, sameSite[None|Lax|Strict], expires — epoch seconds)',
        '- delete_cookies: Delete specific cookies by name (requires: tabId, name; optional: url, domain, path)',
        '- clear_cookies: Clear all cookies for the browser profile (requires: tabId)',
        "- clear_data: Clear browser storage for an origin (requires: tabId; optional: origin, types — comma-separated: 'cookies,local_storage,indexeddb,cache_storage' or 'all')",
        "- quota: Check storage quota usage for the current page's origin (requires: tabId)",
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get_cookies', 'set_cookie', 'delete_cookies', 'clear_cookies', 'clear_data', 'quota'], description: 'Storage action.' },
          tabId: { type: 'string', description: 'Tab ID.' },
          urls: { type: 'array', items: { type: 'string' }, description: 'URLs for get_cookies.' },
          name: { type: 'string', description: 'Cookie name.' },
          value: { type: 'string', description: 'Cookie value.' },
          domain: { type: 'string', description: 'Cookie domain.' },
          path: { type: 'string', description: 'Cookie path.' },
          secure: { type: 'boolean', description: 'Secure flag.' },
          httpOnly: { type: 'boolean', description: 'HttpOnly flag.' },
          sameSite: { type: 'string', enum: ['None', 'Lax', 'Strict'], description: 'SameSite attribute.' },
          expires: { type: 'number', description: 'Expiry as epoch seconds.' },
          url: { type: 'string', description: 'URL for delete_cookies.' },
          origin: { type: 'string', description: 'Origin for clear_data.' },
          types: { type: 'string', description: "Storage types: 'cookies,local_storage,indexeddb,cache_storage' or 'all'." },
          sessionId: { type: 'string', description: 'Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID.' },
          cleanupStrategy: { type: 'string', enum: ['close', 'detach', 'none'], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
          exclusive: { type: 'boolean', description: 'Lock tab to this session (default: true). Set false to allow shared access.' },
        },
        required: ['action', 'tabId'],
      },
      handler: async (ctx, params) => {
        const action = params.action as string;
        switch (action) {
          case 'get_cookies':     return handleGetCookies(ctx, params);
          case 'set_cookie':      return handleSetCookie(ctx, params);
          case 'delete_cookies':  return handleDeleteCookies(ctx, params);
          case 'clear_cookies':   return handleClearCookies(ctx, params);
          case 'clear_data':      return handleClearData(ctx, params);
          case 'quota':           return handleQuota(ctx, params);
          default:                return fail(`Unknown storage action: "${action}". Use: get_cookies, set_cookie, delete_cookies, clear_cookies, clear_data, quota`);
        }
      },
    }),
  );
}
