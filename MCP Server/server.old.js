#!/usr/bin/env node

/**
 * CDP Browser Automation — MCP Server
 *
 * Lightweight MCP server that connects to Chrome via DevTools Protocol.
 * Uses a SINGLE browser-level WebSocket and creates CDP sessions per tab
 * ON DEMAND — does NOT call Network.enable or enumerate all targets.
 *
 * Requires Chrome with remote debugging enabled:
 *   chrome://flags/#enable-remote-debugging  → Enabled, then restart Chrome
 *   OR  --remote-debugging-port=9222  launch flag
 *
 * Environment variables:
 *   CDP_PORT       Chrome debugging port     (default: 9222)
 *   CDP_HOST       Chrome debugging host     (default: 127.0.0.1)
 *   CDP_TIMEOUT    Command timeout in ms     (default: 30000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { readFileSync } from "fs";
import { join } from "path";

const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = process.env.CDP_PORT || "9222";
const CDP_TIMEOUT = parseInt(process.env.CDP_TIMEOUT || "30000");

// ─── Browser Connection ─────────────────────────────────────────────

let browserWs = null;
let nextId = 1;
const callbacks = new Map();
const activeSessions = new Map(); // targetId → sessionId
const enabledDomains = new Map(); // sessionId → Set<domain>

function getWsUrl() {
  const userDataPaths = [
    process.env.CDP_USER_DATA,
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
  ].filter(Boolean);

  for (const udPath of userDataPaths) {
    try {
      const content = readFileSync(join(udPath, "DevToolsActivePort"), "utf8");
      const lines = content.trim().split("\n");
      return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    } catch { /* try next */ }
  }
  return `ws://${CDP_HOST}:${CDP_PORT}/devtools/browser/`;
}

function connectBrowser() {
  if (browserWs?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const wsUrl = getWsUrl();
    browserWs = new WebSocket(wsUrl, { perMessageDeflate: false });
    browserWs.once("open", resolve);
    browserWs.once("error", () =>
      reject(new Error(
        `Cannot connect to Chrome. Make sure Chrome is running with remote debugging ` +
        `enabled (chrome://flags → #enable-remote-debugging → Enabled → Relaunch).`
      ))
    );
    browserWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== undefined) {
        const cb = callbacks.get(msg.id);
        if (cb) {
          callbacks.delete(msg.id);
          msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result);
        }
      }
    });
    browserWs.on("close", () => {
      for (const { reject: rej } of callbacks.values()) rej(new Error("Browser WebSocket closed"));
      callbacks.clear();
      activeSessions.clear();
      enabledDomains.clear();
      browserWs = null;
    });
  });
}

async function cdp(method, params = {}, sessionId = undefined) {
  await connectBrowser();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      callbacks.delete(id);
      reject(new Error(`${method}: timed out (${CDP_TIMEOUT}ms)`));
    }, CDP_TIMEOUT);
    callbacks.set(id, {
      resolve(r) { clearTimeout(timer); resolve(r); },
      reject(e) { clearTimeout(timer); reject(e); },
    });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    browserWs.send(JSON.stringify(msg));
  });
}

/** Like cdp() but with 2-minute timeout for heavy operations like Runtime.enable on Gmail */
async function cdpLong(method, params = {}, sessionId = undefined) {
  await connectBrowser();
  const id = nextId++;
  const longTimeout = 120000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      callbacks.delete(id);
      reject(new Error(`${method}: timed out (${longTimeout}ms)`));
    }, longTimeout);
    callbacks.set(id, {
      resolve(r) { clearTimeout(timer); resolve(r); },
      reject(e) { clearTimeout(timer); reject(e); },
    });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    browserWs.send(JSON.stringify(msg));
  });
}

// ─── Per-Tab Session Management ─────────────────────────────────────

async function getTabSession(tabId) {
  const existing = activeSessions.get(tabId);
  if (existing) {
    try {
      await cdp("Runtime.evaluate", { expression: "1", returnByValue: true }, existing);
      return existing;
    } catch {
      activeSessions.delete(tabId);
      enabledDomains.delete(existing);
    }
  }

  const { sessionId } = await cdp("Target.attachToTarget", {
    targetId: tabId,
    flatten: true,
  });

  // Try evaluating without Runtime.enable first (faster on heavy tabs like Gmail).
  // Runtime.enable forces Chrome to enumerate all execution contexts which can be slow.
  try {
    await cdp("Runtime.evaluate", { expression: "1", returnByValue: true }, sessionId);
    // Works without enable — great, skip it
  } catch {
    // Fallback: enable Runtime with a generous 2-minute timeout
    await cdpLong("Runtime.enable", {}, sessionId);
  }

  activeSessions.set(tabId, sessionId);
  enabledDomains.set(sessionId, new Set(["Runtime"]));
  return sessionId;
}

async function ensureDomain(sessionId, domain) {
  // Some domains (Input, Target) don't have .enable methods — skip them
  const NO_ENABLE = new Set(["Input", "Target", "Browser"]);
  const domains = enabledDomains.get(sessionId) || new Set();
  if (domains.has(domain) || NO_ENABLE.has(domain)) return;
  await cdp(`${domain}.enable`, {}, sessionId);
  domains.add(domain);
  enabledDomains.set(sessionId, domains);
}

async function detachTab(tabId) {
  const sessionId = activeSessions.get(tabId);
  if (!sessionId) return;
  try { await cdp("Target.detachFromTarget", { sessionId }); } catch { /* ok */ }
  activeSessions.delete(tabId);
  enabledDomains.delete(sessionId);
}

// ─── Tab Listing ────────────────────────────────────────────────────

async function getTabs() {
  await connectBrowser();
  const { targetInfos } = await cdp("Target.getTargets", { filter: [{ type: "page" }] });
  return targetInfos || [];
}

// ─── Helpers ────────────────────────────────────────────────────────

function ok(t) {
  return { content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] };
}
function fail(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tool Definitions ───────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_tabs",
    description: "List all open browser tabs with IDs, titles, and URLs. Lightweight — one CDP call, no per-tab connection.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_tab",
    description: "Search for tabs by title or URL substring (case-insensitive).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search in tab titles and URLs." },
      },
      required: ["query"],
    },
  },
  {
    name: "new_tab",
    description: "Open a new browser tab, optionally navigating to a URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open. Defaults to about:blank." },
      },
    },
  },
  {
    name: "close_tab",
    description: "Close a browser tab by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID from list_tabs or find_tab." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "activate_tab",
    description: "Bring a tab to the foreground / make it the active tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID from list_tabs or find_tab." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "navigate",
    description: "Navigate a tab to a URL. Waits for the page to finish loading.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        url: { type: "string", description: "URL to navigate to." },
      },
      required: ["tabId", "url"],
    },
  },
  {
    name: "screenshot",
    description: "Take a screenshot of a tab. Returns the image directly.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        fullPage: { type: "boolean", description: "Capture entire page. Default: false." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "evaluate",
    description: "Execute JavaScript in a tab and return the result.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        expression: { type: "string", description: "JavaScript expression to evaluate." },
      },
      required: ["tabId", "expression"],
    },
  },
  {
    name: "get_content",
    description: "Get the text content or HTML of a page or element.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        selector: { type: "string", description: 'CSS selector. Defaults to "body".' },
        html: { type: "boolean", description: "Return innerHTML instead of innerText. Default: false." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "click",
    description: "Click an element by CSS selector. Scrolls into view, sends realistic mouse events.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        selector: { type: "string", description: "CSS selector of element to click." },
      },
      required: ["tabId", "selector"],
    },
  },
  {
    name: "type_text",
    description: "Type text into an input, textarea, or contenteditable element.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        selector: { type: "string", description: "CSS selector of input element." },
        text: { type: "string", description: "Text to type." },
        clear: { type: "boolean", description: "Clear existing content before typing. Default: true." },
      },
      required: ["tabId", "selector", "text"],
    },
  },
  {
    name: "select_option",
    description: "Select an option from a <select> dropdown by value or visible text.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        selector: { type: "string", description: "CSS selector of the <select> element." },
        value: { type: "string", description: "Option value or visible text to select." },
      },
      required: ["tabId", "selector", "value"],
    },
  },
  {
    name: "wait_for",
    description: "Wait for an element to appear or text to be present on the page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        selector: { type: "string", description: "CSS selector to wait for." },
        text: { type: "string", description: "Text to wait for on the page." },
        timeout: { type: "number", description: "Max wait in ms. Default: 10000." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "get_tab_info",
    description: "Get detailed info about a tab — URL, title, CDP session status.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string", description: "Tab ID." } },
      required: ["tabId"],
    },
  },
  {
    name: "disconnect_tab",
    description: "Detach the debugger from a tab, freeing its CDP session.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string", description: "Tab ID." } },
      required: ["tabId"],
    },
  },
];

// ─── Tool Handlers ──────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {

    case "list_tabs": {
      const tabs = await getTabs();
      if (tabs.length === 0) return ok("No open tabs found.");
      const lines = tabs.map((t, i) => {
        const c = activeSessions.has(t.targetId) ? " [connected]" : "";
        return `${i + 1}. [${t.targetId}]${c}\n   Title: ${t.title}\n   URL: ${t.url}`;
      });
      return ok(`${tabs.length} open tab(s):\n\n${lines.join("\n\n")}`);
    }

    case "find_tab": {
      const q = args.query.toLowerCase();
      const tabs = await getTabs();
      const hits = tabs.filter((t) =>
        t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)
      );
      if (hits.length === 0) return ok(`No tabs matching "${args.query}".`);
      const lines = hits.map((t) => {
        const c = activeSessions.has(t.targetId) ? " [connected]" : "";
        return `[${t.targetId}]${c} ${t.title}\n   ${t.url}`;
      });
      return ok(`${hits.length} matching tab(s):\n\n${lines.join("\n\n")}`);
    }

    case "new_tab": {
      const url = args.url || "about:blank";
      const { targetId } = await cdp("Target.createTarget", { url });
      return ok(`New tab opened:\n  ID: ${targetId}\n  URL: ${url}`);
    }

    case "close_tab": {
      await detachTab(args.tabId);
      await cdp("Target.closeTarget", { targetId: args.tabId });
      return ok("Tab closed.");
    }

    case "activate_tab": {
      await cdp("Target.activateTarget", { targetId: args.tabId });
      return ok("Tab activated.");
    }

    case "get_tab_info": {
      const tabs = await getTabs();
      const tab = tabs.find((t) => t.targetId === args.tabId);
      if (!tab) return fail(`Tab not found: ${args.tabId}`);
      return ok(
        `Tab: ${tab.title}\nURL: ${tab.url}\nID: ${tab.targetId}\n` +
        `CDP Session: ${activeSessions.has(args.tabId) ? "active" : "not connected"}`
      );
    }

    case "disconnect_tab": {
      await detachTab(args.tabId);
      return ok("Detached from tab.");
    }

    case "navigate": {
      const sess = await getTabSession(args.tabId);
      await ensureDomain(sess, "Page");
      const result = await cdp("Page.navigate", { url: args.url }, sess);
      if (result.errorText) return fail(`Navigation failed: ${result.errorText}`);
      const start = Date.now();
      while (Date.now() - start < 30000) {
        try {
          const r = await cdp("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sess);
          if (r.result.value === "complete") break;
        } catch { /* page transitioning */ }
        await sleep(500);
      }
      return ok(`Navigated to ${args.url}`);
    }

    case "screenshot": {
      const sess = await getTabSession(args.tabId);
      await ensureDomain(sess, "Page");
      const params = { format: "png" };
      if (args.fullPage) {
        const m = await cdp("Page.getLayoutMetrics", {}, sess);
        const { width, height } = m.cssContentSize || m.contentSize;
        params.clip = { x: 0, y: 0, width, height, scale: 1 };
      }
      const { data } = await cdp("Page.captureScreenshot", params, sess);
      return { content: [{ type: "image", data, mimeType: "image/png" }] };
    }

    case "evaluate": {
      const sess = await getTabSession(args.tabId);
      const result = await cdp("Runtime.evaluate", {
        expression: args.expression, returnByValue: true, awaitPromise: true, generatePreview: true,
      }, sess);
      if (result.exceptionDetails) {
        return fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation error");
      }
      const v = result.result;
      if (v.type === "undefined") return ok("undefined");
      if (v.value !== undefined) return ok(typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2));
      return ok(v.description || String(v));
    }

    case "get_content": {
      const sess = await getTabSession(args.tabId);
      const sel = args.selector || "body";
      const prop = args.html ? "innerHTML" : "innerText";
      const result = await cdp("Runtime.evaluate", {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'Element not found: ' + ${JSON.stringify(sel)}; return el.${prop}; })()`,
        returnByValue: true,
      }, sess);
      return ok(result.result.value ?? "(empty)");
    }

    case "click": {
      const sess = await getTabSession(args.tabId);
      await ensureDomain(sess, "Input");
      const pos = await cdp("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(args.selector)});
          if (!el) return { error: 'Element not found: ' + ${JSON.stringify(args.selector)} };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName.toLowerCase(), label: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 60) };
        })()`,
        returnByValue: true,
      }, sess);
      const p = pos.result.value;
      if (p.error) return fail(p.error);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }, sess);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 }, sess);
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }, sess);
      return ok(`Clicked <${p.tag}> "${p.label}" at (${Math.round(p.x)}, ${Math.round(p.y)})`);
    }

    case "type_text": {
      const sess = await getTabSession(args.tabId);
      await ensureDomain(sess, "Input");
      const clearCode = args.clear !== false
        ? `if ('value' in el) { el.value = ''; } else if (el.isContentEditable) { el.textContent = ''; } el.dispatchEvent(new Event('input', { bubbles: true }));`
        : "";
      const focused = await cdp("Runtime.evaluate", {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return { error: 'Element not found: ' + ${JSON.stringify(args.selector)} }; el.scrollIntoView({ block: 'center' }); el.focus(); ${clearCode} return { ok: true }; })()`,
        returnByValue: true,
      }, sess);
      if (focused.result.value?.error) return fail(focused.result.value.error);
      await cdp("Input.insertText", { text: args.text }, sess);
      await cdp("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(args.selector)})?.dispatchEvent(new Event('change', { bubbles: true }))`,
      }, sess);
      const display = args.text.length > 80 ? args.text.slice(0, 80) + "…" : args.text;
      return ok(`Typed "${display}" into ${args.selector}`);
    }

    case "select_option": {
      const sess = await getTabSession(args.tabId);
      const result = await cdp("Runtime.evaluate", {
        expression: `(() => {
          const sel = document.querySelector(${JSON.stringify(args.selector)});
          if (!sel) return { error: 'Element not found: ' + ${JSON.stringify(args.selector)} };
          if (sel.tagName !== 'SELECT') return { error: 'Element is not a <select>' };
          let opt = Array.from(sel.options).find(o => o.value === ${JSON.stringify(args.value)});
          if (!opt) opt = Array.from(sel.options).find(o => o.textContent.trim() === ${JSON.stringify(args.value)});
          if (!opt) return { error: 'Option not found: ' + ${JSON.stringify(args.value)} + '. Available: ' + Array.from(sel.options).map(o => o.textContent.trim()).join(', ') };
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { selected: opt.textContent.trim(), value: opt.value };
        })()`,
        returnByValue: true,
      }, sess);
      const r = result.result.value;
      if (r.error) return fail(r.error);
      return ok(`Selected "${r.selected}" (value: ${r.value})`);
    }

    case "wait_for": {
      if (!args.selector && !args.text) return fail('Provide either "selector" or "text".');
      const sess = await getTabSession(args.tabId);
      const timeout = args.timeout || 10000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const expr = args.selector
          ? `!!document.querySelector(${JSON.stringify(args.selector)})`
          : `document.body.innerText.includes(${JSON.stringify(args.text)})`;
        const result = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, sess);
        if (result.result.value === true)
          return ok(`Found ${args.selector || `"${args.text}"`} (${Date.now() - start}ms)`);
        await sleep(500);
      }
      return fail(`Timed out after ${timeout}ms waiting for ${args.selector || `"${args.text}"`}`);
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

// ─── MCP Server Setup ───────────────────────────────────────────────

const server = new Server(
  { name: "cdp-browser", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleTool(request.params.name, request.params.arguments || {});
  } catch (e) {
    return fail(e.message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
