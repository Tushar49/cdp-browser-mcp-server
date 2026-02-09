#!/usr/bin/env node

/**
 * CDP Browser Automation — MCP Server  v2.0
 *
 * A powerful MCP server for Chrome DevTools Protocol automation.
 * Connects to your LIVE Chrome browser — no separate browser instance.
 *
 * Features:
 *   • Accessibility tree snapshots with uid-based interaction
 *   • Arbitrary JavaScript execution with async/await support
 *   • Console message & network request monitoring
 *   • Keyboard, mouse, form automation
 *   • Device emulation & viewport control
 *   • Large output → temp file management
 *   • Single browser WS, lazy per-tab CDP sessions
 *
 * Setup:  chrome://flags/#enable-remote-debugging → Enabled → Relaunch
 *
 * Env vars:
 *   CDP_PORT     Chrome debugging port    (default: 9222)
 *   CDP_HOST     Chrome debugging host    (default: 127.0.0.1)
 *   CDP_TIMEOUT  Command timeout in ms    (default: 30000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Config ─────────────────────────────────────────────────────────

const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = process.env.CDP_PORT || "9222";
const CDP_TIMEOUT = parseInt(process.env.CDP_TIMEOUT || "30000");
const LONG_TIMEOUT = 120_000;
const MAX_INLINE_LEN = 60_000; // above this → write to temp file
const TEMP_DIR = join(tmpdir(), ".cdp-mcp");

// ─── Temp File Management ───────────────────────────────────────────

function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function writeTempFile(name, content) {
  ensureTempDir();
  const p = join(TEMP_DIR, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function cleanupTempFiles() {
  if (!existsSync(TEMP_DIR)) return 0;
  const files = readdirSync(TEMP_DIR);
  let count = 0;
  for (const f of files) {
    try { unlinkSync(join(TEMP_DIR, f)); count++; } catch { /* ok */ }
  }
  return count;
}

// ─── Browser Connection ─────────────────────────────────────────────

let browserWs = null;
let nextId = 1;
const callbacks = new Map();          // msgId → { resolve, reject }
const activeSessions = new Map();     // targetId → sessionId
const enabledDomains = new Map();     // sessionId → Set<domain>
const consoleLogs = new Map();        // sessionId → [ {level, text, ts} ]
const networkReqs = new Map();        // sessionId → Map<requestId, reqObj>
const eventListeners = new Map();     // sessionId → Set<string> (event names being tracked)

// Domains that don't have a .enable() method
const NO_ENABLE = new Set(["Input", "Target", "Browser", "Accessibility", "DOM", "Emulation"]);

function getWsUrl() {
  const paths = [
    process.env.CDP_USER_DATA,
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
  ].filter(Boolean);
  for (const p of paths) {
    try {
      const c = readFileSync(join(p, "DevToolsActivePort"), "utf8");
      const lines = c.trim().split("\n");
      return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    } catch { /* next */ }
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
        "Cannot connect to Chrome. Enable remote debugging: " +
        "chrome://flags → #enable-remote-debugging → Enabled → Relaunch."
      ))
    );
    browserWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());

      // Handle CDP responses
      if (msg.id !== undefined) {
        const cb = callbacks.get(msg.id);
        if (cb) {
          callbacks.delete(msg.id);
          msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result);
        }
        return;
      }

      // Handle CDP events
      if (msg.method && msg.sessionId) {
        handleEvent(msg.sessionId, msg.method, msg.params);
      }
    });
    browserWs.on("close", () => {
      for (const { reject: r } of callbacks.values()) r(new Error("WebSocket closed"));
      callbacks.clear();
      activeSessions.clear();
      enabledDomains.clear();
      consoleLogs.clear();
      networkReqs.clear();
      eventListeners.clear();
      browserWs = null;
    });
  });
}

function handleEvent(sessionId, method, params) {
  // Console messages
  if (method === "Runtime.consoleAPICalled") {
    const logs = consoleLogs.get(sessionId) || [];
    logs.push({
      level: params.type,
      text: params.args?.map(a => a.value ?? a.description ?? a.type).join(" ") || "",
      ts: Date.now(),
      url: params.stackTrace?.callFrames?.[0]?.url || "",
    });
    // Keep only last 500 per tab
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    consoleLogs.set(sessionId, logs);
  }

  // Exception thrown
  if (method === "Runtime.exceptionThrown") {
    const logs = consoleLogs.get(sessionId) || [];
    logs.push({
      level: "error",
      text: params.exceptionDetails?.exception?.description ||
            params.exceptionDetails?.text || "Unknown exception",
      ts: Date.now(),
      url: params.exceptionDetails?.url || "",
    });
    consoleLogs.set(sessionId, logs);
  }

  // Network requests
  if (method === "Network.requestWillBeSent") {
    const reqs = networkReqs.get(sessionId) || new Map();
    reqs.set(params.requestId, {
      id: params.requestId,
      url: params.request.url,
      method: params.request.method,
      type: params.type || "Other",
      ts: Date.now(),
      status: null,
      mimeType: null,
      size: null,
    });
    // Keep only last 300 per tab
    if (reqs.size > 300) {
      const first = reqs.keys().next().value;
      reqs.delete(first);
    }
    networkReqs.set(sessionId, reqs);
  }
  if (method === "Network.responseReceived") {
    const reqs = networkReqs.get(sessionId);
    if (reqs?.has(params.requestId)) {
      const r = reqs.get(params.requestId);
      r.status = params.response.status;
      r.mimeType = params.response.mimeType;
    }
  }
  if (method === "Network.loadingFinished") {
    const reqs = networkReqs.get(sessionId);
    if (reqs?.has(params.requestId)) {
      reqs.get(params.requestId).size = params.encodedDataLength;
    }
  }
}

async function cdp(method, params = {}, sessionId, timeout = CDP_TIMEOUT) {
  await connectBrowser();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      callbacks.delete(id);
      reject(new Error(`${method}: timed out (${timeout}ms)`));
    }, timeout);
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
  // Reuse existing session if alive
  const existing = activeSessions.get(tabId);
  if (existing) {
    try {
      await cdp("Runtime.evaluate", { expression: "1", returnByValue: true }, existing, 5000);
      return existing;
    } catch {
      activeSessions.delete(tabId);
      enabledDomains.delete(existing);
    }
  }

  const { sessionId } = await cdp("Target.attachToTarget", { targetId: tabId, flatten: true });

  // Try eval without Runtime.enable first (faster on heavy tabs like Gmail)
  try {
    await cdp("Runtime.evaluate", { expression: "1", returnByValue: true }, sessionId, 5000);
  } catch {
    await cdp("Runtime.enable", {}, sessionId, LONG_TIMEOUT);
  }

  activeSessions.set(tabId, sessionId);
  enabledDomains.set(sessionId, new Set(["Runtime"]));
  consoleLogs.set(sessionId, []);
  networkReqs.set(sessionId, new Map());
  return sessionId;
}

async function ensureDomain(sessionId, domain) {
  const domains = enabledDomains.get(sessionId) || new Set();
  if (domains.has(domain) || NO_ENABLE.has(domain)) return;
  try {
    await cdp(`${domain}.enable`, {}, sessionId, 10000);
    domains.add(domain);
    enabledDomains.set(sessionId, domains);
  } catch {
    // Some domains may not support enable — that's fine
    domains.add(domain);
    enabledDomains.set(sessionId, domains);
  }
}

async function enableMonitoring(sessionId, what) {
  const listeners = eventListeners.get(sessionId) || new Set();
  if (what === "console" && !listeners.has("console")) {
    // Runtime events are auto-enabled via Runtime.enable in getTabSession
    listeners.add("console");
  }
  if (what === "network" && !listeners.has("network")) {
    await ensureDomain(sessionId, "Network");
    listeners.add("network");
  }
  eventListeners.set(sessionId, listeners);
}

async function detachTab(tabId) {
  const sid = activeSessions.get(tabId);
  if (!sid) return;
  try { await cdp("Target.detachFromTarget", { sessionId: sid }); } catch { /* ok */ }
  activeSessions.delete(tabId);
  enabledDomains.delete(sid);
  consoleLogs.delete(sid);
  networkReqs.delete(sid);
  eventListeners.delete(sid);
}

// ─── Tab Listing ────────────────────────────────────────────────────

async function getTabs() {
  await connectBrowser();
  const { targetInfos } = await cdp("Target.getTargets", { filter: [{ type: "page" }] });
  return targetInfos || [];
}

// ─── Accessibility Tree / Snapshot ──────────────────────────────────

/**
 * Build a YAML-like accessibility snapshot using JS execution.
 * Maps each visible a11y-relevant element to a uid based on walk order
 * so the LLM can reference elements for click/type/etc.
 */
async function buildSnapshot(sessionId) {
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
  const INTERACTIVE = new Set(["a","button","input","select","textarea","details","summary","option"]);
  const SKIP_TAGS = new Set(["script","style","noscript","template","path","br","wbr","meta","link"]);

  let uidCounter = 0;

  function getRole(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.href) return "link";
    if (tag === "button" || (tag === "input" && el.type === "submit") || (tag === "input" && el.type === "button")) return "button";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      if (t === "file") return "button";
      if (t === "hidden") return null;
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (tag === "svg") return "img";
    if (tag === "video") return "video";
    if (tag === "audio") return "audio";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "aside") return "complementary";
    if (tag === "form") return "form";
    if (tag === "table") return "table";
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") return "rowgroup";
    if (tag === "tr") return "row";
    if (tag === "td") return "cell";
    if (tag === "th") return "columnheader";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "section") return el.getAttribute("aria-label") ? "region" : null;
    if (tag === "dialog") return "dialog";
    if (tag.match(/^h[1-6]$/)) return "heading";
    if (tag === "label") return "label";
    if (tag === "fieldset") return "group";
    if (tag === "legend") return "legend";
    if (tag === "progress") return "progressbar";
    if (tag === "meter") return "meter";
    if (tag === "output") return "status";
    if (tag === "iframe") return "document";
    if (el.getAttribute("tabindex") !== null) return "generic";
    if (el.getAttribute("onclick") || el.getAttribute("data-action")) return "generic";
    return null;
  }

  function getName(el) {
    const label = el.getAttribute && el.getAttribute("aria-label");
    if (label) return label;
    const labelId = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelId) {
      const parts = labelId.split(" ").map(id => {
        const lel = document.getElementById(id);
        return lel ? lel.textContent.trim() : "";
      }).filter(Boolean);
      if (parts.length) return parts.join(" ").substring(0, 100);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "img") return el.alt || el.title || "";
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const id = el.id;
      if (id) {
        const lbl = document.querySelector("label[for=" + JSON.stringify(id) + "]");
        if (lbl) return lbl.textContent.trim().substring(0, 100);
      }
      return el.placeholder || el.title || el.name || "";
    }
    if (tag === "a" || tag === "button" || tag === "option" || tag === "summary" || tag === "label" || tag === "legend") {
      return el.textContent.trim().substring(0, 100);
    }
    if (tag.match(/^h[1-6]$/)) return el.textContent.trim().substring(0, 100);
    if (el.title) return el.title;
    return "";
  }

  function isVisible(el) {
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed" &&
        getComputedStyle(el).position !== "sticky" && el.tagName.toLowerCase() !== "body") return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    if (parseFloat(s.opacity) === 0 && !el.querySelector("[style]")) return false;
    return true;
  }

  function getProps(el) {
    const props = [];
    const tag = el.tagName.toLowerCase();
    if (el.disabled) props.push("disabled");
    if (el.checked) props.push("checked");
    if (el.required) props.push("required");
    if (el.readOnly) props.push("readonly");
    if (el.getAttribute("aria-expanded") === "true") props.push("expanded");
    if (el.getAttribute("aria-expanded") === "false") props.push("collapsed");
    if (el.getAttribute("aria-selected") === "true") props.push("selected");
    if (el.getAttribute("aria-pressed") === "true") props.push("pressed");
    if (el.getAttribute("aria-haspopup")) props.push("haspopup=" + el.getAttribute("aria-haspopup"));
    if (el.getAttribute("aria-current")) props.push("current=" + el.getAttribute("aria-current"));
    if (tag.match(/^h[1-6]$/)) props.push("level=" + tag[1]);
    if (tag === "a" && el.href) props.push("url=" + el.href.substring(0, 80));
    if (tag === "img" && el.src) props.push("src=" + el.src.substring(0, 80));
    if ((tag === "input" || tag === "textarea") && el.value) props.push("value=" + JSON.stringify(el.value.substring(0, 80)));
    if (tag === "option" && el.value) props.push("value=" + el.value.substring(0, 40));
    if (tag === "select") {
      const sel = el.options[el.selectedIndex];
      if (sel) props.push("value=" + JSON.stringify(sel.textContent.trim().substring(0, 40)));
    }
    return props;
  }

  function walk(el, depth) {
    if (!el || !el.tagName) return "";
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return "";
    if (!isVisible(el)) return "";
    if (depth > 20) return "";

    const role = getRole(el);
    const indent = "  ".repeat(depth);
    let output = "";
    let id = null;

    if (role) {
      id = uidCounter++;
      const name = getName(el);
      const props = getProps(el);
      const propStr = props.length ? " [" + props.join(", ") + "]" : "";
      const nameStr = name ? ' "' + name.replace(/[\\\\\\n\\r"]/g, " ").trim().substring(0, 100) + '"' : "";
      output += indent + "- " + role + nameStr + propStr + " [uid=" + id + "]\\n";
    }

    // Walk children
    const children = el.children;
    if (children && children.length > 0) {
      const childDepth = role ? depth + 1 : depth;
      for (let i = 0; i < children.length; i++) {
        output += walk(children[i], childDepth);
      }
    } else if (!role) {
      // Leaf text node — include if meaningful
      const t = el.textContent?.trim();
      if (t && t.length > 0 && t.length <= 300) {
        output += indent + '- text "' + t.replace(/[\\\\\\n\\r"]/g, " ").trim().substring(0, 150) + '"\\n';
      }
    }

    return output;
  }

  const snapshot = walk(document.body, 0);
  return { snapshot, count: uidCounter, url: location.href, title: document.title };
})()`,
    returnByValue: true,
    awaitPromise: false,
  }, sessionId);

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Snapshot failed");
  }
  return result.result.value;
}

/**
 * Resolve a uid to a DOM element by walking the tree the same way as buildSnapshot.
 * Returns JS expression that finds the element.
 */
function uidResolver(uid) {
  return `(() => {
  const SKIP = new Set(["script","style","noscript","template","path","br","wbr","meta","link"]);
  let counter = 0;
  function getRole(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.href) return "link";
    if (tag === "button" || (tag === "input" && el.type === "submit") || (tag === "input" && el.type === "button")) return "button";
    if (tag === "input") { const t = (el.type||"text").toLowerCase(); if(t==="hidden")return null; return "textbox"; }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "img" || tag === "svg") return "img";
    if (tag === "video") return "video";
    if (tag === "audio") return "audio";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "aside") return "complementary";
    if (tag === "form") return "form";
    if (tag === "table") return "table";
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") return "rowgroup";
    if (tag === "tr") return "row";
    if (tag === "td") return "cell";
    if (tag === "th") return "columnheader";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "section") return el.getAttribute("aria-label") ? "region" : null;
    if (tag === "dialog") return "dialog";
    if (tag.match(/^h[1-6]$/)) return "heading";
    if (tag === "label") return "label";
    if (tag === "fieldset") return "group";
    if (tag === "legend") return "legend";
    if (tag === "progress") return "progressbar";
    if (tag === "meter") return "meter";
    if (tag === "output") return "status";
    if (tag === "iframe") return "document";
    if (el.getAttribute("tabindex") !== null) return "generic";
    if (el.getAttribute("onclick") || el.getAttribute("data-action")) return "generic";
    return null;
  }
  function isVis(el) {
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed" &&
        getComputedStyle(el).position !== "sticky" && el.tagName.toLowerCase() !== "body") return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    return true;
  }
  function walk(el, depth) {
    if (!el || !el.tagName) return null;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return null;
    if (!isVis(el)) return null;
    if (depth > 20) return null;
    const role = getRole(el);
    if (role) {
      if (counter === ${uid}) return el;
      counter++;
    }
    for (const child of el.children) {
      const r = walk(child, role ? depth + 1 : depth);
      if (r) return r;
    }
    return null;
  }
  return walk(document.body, 0);
})()`;
}

// ─── Helpers ────────────────────────────────────────────────────────

function ok(t) {
  const text = typeof t === "string" ? t : JSON.stringify(t, null, 2);
  if (text.length > MAX_INLINE_LEN) {
    const file = writeTempFile(`output-${Date.now()}.txt`, text);
    return {
      content: [{ type: "text", text: `Output too large (${text.length} chars). Saved to: ${file}\n\nFirst 2000 chars:\n${text.substring(0, 2000)}` }],
    };
  }
  return { content: [{ type: "text", text }] };
}

function fail(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Tool Definitions ───────────────────────────────────────────────

const TOOLS = [
  // ── Tab Management ──
  {
    name: "tabs",
    description: "Manage browser tabs. Actions: list, find, new, close, activate, info.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "find", "new", "close", "activate", "info"],
          description: "Tab action to perform.",
        },
        query: { type: "string", description: "Search text for 'find' action." },
        tabId: { type: "string", description: "Tab ID for close/activate/info actions." },
        url: { type: "string", description: "URL for 'new' action." },
      },
      required: ["action"],
    },
  },

  // ── Navigation ──
  {
    name: "navigate",
    description: "Navigate a tab to a URL, or go back/forward in history.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        url: { type: "string", description: "URL to navigate to." },
        action: { type: "string", enum: ["goto", "back", "forward", "reload"], description: "Navigation action. Default: goto." },
      },
      required: ["tabId"],
    },
  },

  // ── Snapshot (Accessibility Tree) ──
  {
    name: "snapshot",
    description: "Take an accessibility tree snapshot of the page. Returns a YAML-like tree with uid references for each interactive element. Use uids with click, type, hover etc. Prefer this over screenshot for understanding page structure.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
      },
      required: ["tabId"],
    },
  },

  // ── Screenshot ──
  {
    name: "screenshot",
    description: "Take a screenshot of a tab. Returns PNG image.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        fullPage: { type: "boolean", description: "Capture full scrollable page. Default: false." },
        quality: { type: "number", description: "JPEG quality 0-100. If set, returns JPEG instead of PNG." },
      },
      required: ["tabId"],
    },
  },

  // ── Click ──
  {
    name: "click",
    description: "Click an element. Identify by uid (from snapshot) or CSS selector. Scrolls into view and dispatches real mouse events.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        uid: { type: "number", description: "Element uid from snapshot." },
        selector: { type: "string", description: "CSS selector (alternative to uid)." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button. Default: left." },
        clickCount: { type: "number", description: "Number of clicks. Use 2 for double-click. Default: 1." },
      },
      required: ["tabId"],
    },
  },

  // ── Hover ──
  {
    name: "hover",
    description: "Hover over an element to trigger hover effects, tooltips, dropdowns.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        uid: { type: "number", description: "Element uid from snapshot." },
        selector: { type: "string", description: "CSS selector (alternative to uid)." },
      },
      required: ["tabId"],
    },
  },

  // ── Type Text ──
  {
    name: "type",
    description: "Type text into an element (input, textarea, contenteditable). Identify by uid or selector.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        uid: { type: "number", description: "Element uid from snapshot." },
        selector: { type: "string", description: "CSS selector (alternative to uid)." },
        text: { type: "string", description: "Text to type." },
        clear: { type: "boolean", description: "Clear field before typing. Default: true." },
        submit: { type: "boolean", description: "Press Enter after typing. Default: false." },
      },
      required: ["tabId", "text"],
    },
  },

  // ── Fill Form ──
  {
    name: "fill_form",
    description: "Fill multiple form fields at once. Each field identified by uid or selector.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        fields: {
          type: "array",
          description: "Array of fields to fill: [{uid, selector, value, type}]. type is 'text'|'checkbox'|'radio'|'select'.",
          items: {
            type: "object",
            properties: {
              uid: { type: "number" },
              selector: { type: "string" },
              value: { type: "string" },
              type: { type: "string", enum: ["text", "checkbox", "radio", "select"] },
            },
            required: ["value"],
          },
        },
      },
      required: ["tabId", "fields"],
    },
  },

  // ── Press Key ──
  {
    name: "press_key",
    description: "Press a key or key combination (Enter, Tab, Escape, Ctrl+A, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        key: { type: "string", description: "Key to press: Enter, Tab, Escape, ArrowDown, Backspace, Delete, a, b, etc." },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Ctrl", "Shift", "Alt", "Meta"] },
          description: "Modifier keys to hold during press.",
        },
      },
      required: ["tabId", "key"],
    },
  },

  // ── Select Option ──
  {
    name: "select_option",
    description: "Select an option from a <select> dropdown by value or visible text.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        uid: { type: "number", description: "Element uid from snapshot." },
        selector: { type: "string", description: "CSS selector (alternative to uid)." },
        value: { type: "string", description: "Option value or visible text to select." },
      },
      required: ["tabId", "value"],
    },
  },

  // ── Execute JavaScript ──
  {
    name: "evaluate",
    description: "Execute JavaScript in a tab. Supports async/await and Promises. For complex multi-step operations, use run_script instead.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        expression: { type: "string", description: "JavaScript expression or IIFE to evaluate." },
      },
      required: ["tabId", "expression"],
    },
  },

  // ── Run Script (like Playwright's run_code) ──
  {
    name: "run_script",
    description: "Run a complex JavaScript function body on the page. Wrapped in async IIFE — use 'return' to return results, 'await' for async. More powerful than evaluate — use for multi-step DOM manipulation, complex automation sequences, data extraction, etc.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        code: { type: "string", description: "JavaScript function body. Will be wrapped in (async () => { <your code> })(). Use return for a result." },
      },
      required: ["tabId", "code"],
    },
  },

  // ── Get Content ──
  {
    name: "get_content",
    description: "Get page content as text or HTML, optionally scoped to a CSS selector or uid.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        selector: { type: "string", description: "CSS selector to scope content. Default: body." },
        uid: { type: "number", description: "Element uid to scope content." },
        format: { type: "string", enum: ["text", "html"], description: "Return format. Default: text." },
      },
      required: ["tabId"],
    },
  },

  // ── Wait For ──
  {
    name: "wait_for",
    description: "Wait for a condition: text appearing/disappearing, element existing, or a fixed time.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        text: { type: "string", description: "Text to wait for on the page." },
        textGone: { type: "string", description: "Text to wait to disappear." },
        selector: { type: "string", description: "CSS selector to wait for existence." },
        time: { type: "number", description: "Fixed time to wait in seconds." },
        timeout: { type: "number", description: "Max wait in ms. Default: 10000." },
      },
      required: ["tabId"],
    },
  },

  // ── Console Messages ──
  {
    name: "console",
    description: "Get console messages from a tab. Automatically starts capturing on first call.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        level: { type: "string", enum: ["all", "error", "warning", "log", "info", "debug"], description: "Filter by level. Default: all." },
        clear: { type: "boolean", description: "Clear captured messages after returning. Default: false." },
        last: { type: "number", description: "Return only the last N messages." },
      },
      required: ["tabId"],
    },
  },

  // ── Network Requests ──
  {
    name: "network",
    description: "Get network requests from a tab. Starts monitoring on first call. Shows URLs, methods, status codes, sizes.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        filter: { type: "string", description: "Filter requests by URL substring." },
        clear: { type: "boolean", description: "Clear captured requests after returning. Default: false." },
        last: { type: "number", description: "Return only the last N requests." },
      },
      required: ["tabId"],
    },
  },

  // ── Drag and Drop ──
  {
    name: "drag",
    description: "Drag an element and drop it onto another. Identify source and target by uid or selector.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        sourceUid: { type: "number", description: "Source element uid." },
        sourceSelector: { type: "string", description: "Source CSS selector." },
        targetUid: { type: "number", description: "Target element uid." },
        targetSelector: { type: "string", description: "Target CSS selector." },
      },
      required: ["tabId"],
    },
  },

  // ── Emulate ──
  {
    name: "emulate",
    description: "Emulate device features: viewport size, dark/light mode, geolocation, user agent, CPU throttling.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        viewport: {
          type: "object",
          description: "Viewport: {width, height, deviceScaleFactor, mobile}",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
            deviceScaleFactor: { type: "number" },
            mobile: { type: "boolean" },
          },
        },
        colorScheme: { type: "string", enum: ["dark", "light", "auto"], description: "Emulate color scheme." },
        userAgent: { type: "string", description: "Override user agent string." },
        geolocation: {
          type: "object",
          properties: { latitude: { type: "number" }, longitude: { type: "number" } },
        },
        cpuThrottle: { type: "number", description: "CPU throttle rate. 1 = normal, 4 = 4x slower." },
      },
      required: ["tabId"],
    },
  },

  // ── Cleanup ──
  {
    name: "cleanup",
    description: "Disconnect from tabs and/or clean up temp files.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["disconnect_tab", "disconnect_all", "clean_temp", "status"],
          description: "Cleanup action.",
        },
        tabId: { type: "string", description: "Tab ID for disconnect_tab." },
      },
      required: ["action"],
    },
  },
];

// ─── Key Mapping ────────────────────────────────────────────────────

const KEY_MAP = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  f1: { key: "F1", code: "F1", keyCode: 112 },
  f2: { key: "F2", code: "F2", keyCode: 113 },
  f3: { key: "F3", code: "F3", keyCode: 114 },
  f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 },
  f6: { key: "F6", code: "F6", keyCode: 117 },
  f7: { key: "F7", code: "F7", keyCode: 118 },
  f8: { key: "F8", code: "F8", keyCode: 119 },
  f9: { key: "F9", code: "F9", keyCode: 120 },
  f10: { key: "F10", code: "F10", keyCode: 121 },
  f11: { key: "F11", code: "F11", keyCode: 122 },
  f12: { key: "F12", code: "F12", keyCode: 123 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};

function resolveKey(keyName) {
  const lower = keyName.toLowerCase();
  if (KEY_MAP[lower]) return KEY_MAP[lower];
  // Single character
  if (keyName.length === 1) {
    return {
      key: keyName,
      code: `Key${keyName.toUpperCase()}`,
      keyCode: keyName.toUpperCase().charCodeAt(0),
      text: keyName,
    };
  }
  return { key: keyName, code: keyName, keyCode: 0 };
}

function modifierFlags(modifiers) {
  let flags = 0;
  if (!modifiers) return flags;
  for (const m of modifiers) {
    switch (m.toLowerCase()) {
      case "alt": flags |= 1; break;
      case "ctrl": case "control": flags |= 2; break;
      case "meta": case "cmd": case "command": flags |= 4; break;
      case "shift": flags |= 8; break;
    }
  }
  return flags;
}

// ─── Element Resolution (uid or selector → coordinates) ─────────────

function elementFinderExpr(uid, selector) {
  if (uid !== undefined && uid !== null) {
    return uidResolver(uid);
  }
  if (selector) {
    return `document.querySelector(${JSON.stringify(selector)})`;
  }
  throw new Error("Provide either 'uid' (from snapshot) or 'selector' (CSS).");
}

async function resolveElement(sessionId, uid, selector) {
  const finder = elementFinderExpr(uid, selector);
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = ${finder};
      if (!el) return { error: "Element not found" + ${uid !== undefined ? `" (uid=${uid})"` : JSON.stringify(" (" + (selector || "") + ")")} };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute("aria-label") || el.textContent || "").trim().substring(0, 60),
        w: r.width, h: r.height,
      };
    })()`,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Element resolution failed");
  const v = result.result.value;
  if (v?.error) throw new Error(v.error);
  return v;
}

// ─── Tool Handlers ──────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {

    // ─── Tabs ─────────────────────────────────────────────────
    case "tabs": {
      const action = args.action;

      if (action === "list") {
        const tabs = await getTabs();
        if (!tabs.length) return ok("No open tabs found.");
        const lines = tabs.map((t, i) => {
          const c = activeSessions.has(t.targetId) ? " [connected]" : "";
          return `${i + 1}. [${t.targetId}]${c}\n   ${t.title}\n   ${t.url}`;
        });
        return ok(`${tabs.length} tab(s):\n\n${lines.join("\n\n")}`);
      }

      if (action === "find") {
        if (!args.query) return fail("Provide 'query' to search tabs.");
        const q = args.query.toLowerCase();
        const tabs = await getTabs();
        const hits = tabs.filter(t => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
        if (!hits.length) return ok(`No tabs matching "${args.query}".`);
        const lines = hits.map(t => {
          const c = activeSessions.has(t.targetId) ? " [connected]" : "";
          return `[${t.targetId}]${c} ${t.title}\n   ${t.url}`;
        });
        return ok(`${hits.length} match(es):\n\n${lines.join("\n\n")}`);
      }

      if (action === "new") {
        const url = args.url || "about:blank";
        const { targetId } = await cdp("Target.createTarget", { url });
        return ok(`New tab: [${targetId}]\nURL: ${url}`);
      }

      if (action === "close") {
        if (!args.tabId) return fail("Provide 'tabId' to close.");
        await detachTab(args.tabId);
        await cdp("Target.closeTarget", { targetId: args.tabId });
        return ok("Tab closed.");
      }

      if (action === "activate") {
        if (!args.tabId) return fail("Provide 'tabId' to activate.");
        await cdp("Target.activateTarget", { targetId: args.tabId });
        return ok("Tab activated (brought to foreground).");
      }

      if (action === "info") {
        if (!args.tabId) return fail("Provide 'tabId'.");
        const tabs = await getTabs();
        const tab = tabs.find(t => t.targetId === args.tabId);
        if (!tab) return fail("Tab not found.");
        const connected = activeSessions.has(args.tabId);
        const sid = activeSessions.get(args.tabId);
        const consoleCount = sid ? (consoleLogs.get(sid)?.length || 0) : 0;
        const netCount = sid ? (networkReqs.get(sid)?.size || 0) : 0;
        return ok(
          `Tab: ${tab.title}\nURL: ${tab.url}\nID: ${tab.targetId}\n` +
          `Session: ${connected ? "active" : "not connected"}\n` +
          `Console: ${consoleCount} messages | Network: ${netCount} requests`
        );
      }

      return fail(`Unknown tab action: ${action}`);
    }

    // ─── Navigate ─────────────────────────────────────────────
    case "navigate": {
      const sess = await getTabSession(args.tabId);
      const action = args.action || "goto";

      if (action === "back") {
        const { currentIndex, entries } = await cdp("Page.getNavigationHistory", {}, sess);
        if (currentIndex > 0) {
          await cdp("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id }, sess);
          await sleep(500);
          const r = await cdp("Runtime.evaluate", { expression: "document.title + ' — ' + location.href", returnByValue: true }, sess);
          return ok(`Navigated back → ${r.result.value}`);
        }
        return ok("Already at the beginning of history.");
      }

      if (action === "forward") {
        const { currentIndex, entries } = await cdp("Page.getNavigationHistory", {}, sess);
        if (currentIndex < entries.length - 1) {
          await cdp("Page.navigateToHistoryEntry", { entryId: entries[currentIndex + 1].id }, sess);
          await sleep(500);
          const r = await cdp("Runtime.evaluate", { expression: "document.title + ' — ' + location.href", returnByValue: true }, sess);
          return ok(`Navigated forward → ${r.result.value}`);
        }
        return ok("Already at the end of history.");
      }

      if (action === "reload") {
        await cdp("Page.reload", { ignoreCache: true }, sess);
        const start = Date.now();
        while (Date.now() - start < 15000) {
          try {
            const r = await cdp("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sess, 3000);
            if (r.result.value === "complete") break;
          } catch { /* transitioning */ }
          await sleep(500);
        }
        return ok("Page reloaded.");
      }

      // goto
      if (!args.url) return fail("Provide 'url' for navigation.");
      await ensureDomain(sess, "Page");
      const result = await cdp("Page.navigate", { url: args.url }, sess);
      if (result.errorText) return fail(`Navigation failed: ${result.errorText}`);
      const start = Date.now();
      while (Date.now() - start < 30000) {
        try {
          const r = await cdp("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sess, 3000);
          if (r.result.value === "complete") break;
        } catch { /* page transitioning */ }
        await sleep(500);
      }
      const title = await cdp("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sess);
      return ok(`Navigated to: ${args.url}\nTitle: ${title.result.value}`);
    }

    // ─── Snapshot ─────────────────────────────────────────────
    case "snapshot": {
      const sess = await getTabSession(args.tabId);
      const snap = await buildSnapshot(sess);
      const header = `Page: ${snap.title}\nURL: ${snap.url}\nElements: ${snap.count}\n\n`;
      return ok(header + snap.snapshot);
    }

    // ─── Screenshot ───────────────────────────────────────────
    case "screenshot": {
      const sess = await getTabSession(args.tabId);
      const params = {};
      if (args.quality !== undefined) {
        params.format = "jpeg";
        params.quality = args.quality;
      } else {
        params.format = "png";
      }
      if (args.fullPage) {
        await ensureDomain(sess, "Page");
        const m = await cdp("Page.getLayoutMetrics", {}, sess);
        const { width, height } = m.cssContentSize || m.contentSize;
        params.clip = { x: 0, y: 0, width, height, scale: 1 };
      }
      const { data } = await cdp("Page.captureScreenshot", params, sess);
      return { content: [{ type: "image", data, mimeType: params.format === "jpeg" ? "image/jpeg" : "image/png" }] };
    }

    // ─── Click ────────────────────────────────────────────────
    case "click": {
      const sess = await getTabSession(args.tabId);
      const el = await resolveElement(sess, args.uid, args.selector);
      const button = args.button || "left";
      const clicks = args.clickCount || 1;
      const buttonCode = button === "right" ? 2 : button === "middle" ? 1 : 0;

      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y }, sess);
      await sleep(50);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: el.x, y: el.y, button, clickCount: clicks, buttons: 1 << buttonCode }, sess);
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: el.x, y: el.y, button, clickCount: clicks }, sess);
      return ok(`Clicked <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})`);
    }

    // ─── Hover ────────────────────────────────────────────────
    case "hover": {
      const sess = await getTabSession(args.tabId);
      const el = await resolveElement(sess, args.uid, args.selector);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y }, sess);
      return ok(`Hovering over <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})`);
    }

    // ─── Type ─────────────────────────────────────────────────
    case "type": {
      const sess = await getTabSession(args.tabId);
      const finder = elementFinderExpr(args.uid, args.selector);
      const clearCode = args.clear !== false
        ? `if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); } else if (el.isContentEditable) { el.textContent = ''; }`
        : "";
      const focused = await cdp("Runtime.evaluate", {
        expression: `(() => { const el = ${finder}; if (!el) return {error:"Element not found"}; el.scrollIntoView({block:"center"}); el.focus(); ${clearCode} return {ok:true}; })()`,
        returnByValue: true,
      }, sess);
      if (focused.result.value?.error) return fail(focused.result.value.error);

      await cdp("Input.insertText", { text: args.text }, sess);

      // Fire input/change events
      await cdp("Runtime.evaluate", {
        expression: `(() => { const el = document.activeElement; if(el){el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));} })()`,
      }, sess);

      if (args.submit) {
        const k = resolveKey("Enter");
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k }, sess);
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k }, sess);
      }

      const display = args.text.length > 60 ? args.text.substring(0, 60) + "..." : args.text;
      return ok(`Typed "${display}"${args.submit ? " + Enter" : ""}`);
    }

    // ─── Fill Form ────────────────────────────────────────────
    case "fill_form": {
      const sess = await getTabSession(args.tabId);
      const results = [];
      for (const field of args.fields) {
        const finder = elementFinderExpr(field.uid, field.selector);
        const fieldType = field.type || "text";

        const code = `(() => {
          const el = ${finder};
          if (!el) return { error: "not found" };
          el.scrollIntoView({ block: "center" });
          const type = ${JSON.stringify(fieldType)};
          const val = ${JSON.stringify(field.value)};
          if (type === "checkbox") {
            const wanted = val === "true" || val === "1";
            if (el.checked !== wanted) el.click();
            return { ok: true, value: String(el.checked) };
          }
          if (type === "radio") {
            el.click();
            return { ok: true, value: val };
          }
          if (type === "select") {
            let opt = Array.from(el.options).find(o => o.value === val || o.textContent.trim() === val);
            if (!opt) return { error: "Option not found: " + val };
            el.value = opt.value;
            el.dispatchEvent(new Event('change', {bubbles:true}));
            return { ok: true, value: opt.textContent.trim() };
          }
          // text
          el.focus();
          if ('value' in el) el.value = val; else el.textContent = val;
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          return { ok: true, value: val.substring(0, 40) };
        })()`;

        const r = await cdp("Runtime.evaluate", { expression: code, returnByValue: true }, sess);
        const v = r.result.value;
        results.push({ field: field.uid ?? field.selector, ...(v || { error: "eval failed" }) });
      }
      return ok({ filled: results });
    }

    // ─── Press Key ────────────────────────────────────────────
    case "press_key": {
      const sess = await getTabSession(args.tabId);
      const k = resolveKey(args.key);
      const mods = modifierFlags(args.modifiers);
      await cdp("Input.dispatchKeyEvent", {
        type: "keyDown", key: k.key, code: k.code,
        windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
        modifiers: mods, text: k.text,
      }, sess);
      await cdp("Input.dispatchKeyEvent", {
        type: "keyUp", key: k.key, code: k.code,
        windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
        modifiers: mods,
      }, sess);
      const modStr = args.modifiers?.length ? args.modifiers.join("+") + "+" : "";
      return ok(`Pressed ${modStr}${args.key}`);
    }

    // ─── Select Option ────────────────────────────────────────
    case "select_option": {
      const sess = await getTabSession(args.tabId);
      const finder = elementFinderExpr(args.uid, args.selector);
      const result = await cdp("Runtime.evaluate", {
        expression: `(() => {
          const sel = ${finder};
          if (!sel) return { error: "Element not found" };
          if (sel.tagName !== "SELECT") return { error: "Not a <select> element" };
          let opt = Array.from(sel.options).find(o => o.value === ${JSON.stringify(args.value)});
          if (!opt) opt = Array.from(sel.options).find(o => o.textContent.trim() === ${JSON.stringify(args.value)});
          if (!opt) return { error: "Option not found: " + ${JSON.stringify(args.value)} + ". Available: " + Array.from(sel.options).map(o => o.textContent.trim()).join(", ") };
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { selected: opt.textContent.trim(), value: opt.value };
        })()`,
        returnByValue: true,
      }, sess);
      const v = result.result.value;
      if (v?.error) return fail(v.error);
      return ok(`Selected "${v.selected}" (value: ${v.value})`);
    }

    // ─── Evaluate ─────────────────────────────────────────────
    case "evaluate": {
      const sess = await getTabSession(args.tabId);
      const result = await cdp("Runtime.evaluate", {
        expression: args.expression,
        returnByValue: true,
        awaitPromise: true,
        generatePreview: true,
        userGesture: true,
      }, sess);
      if (result.exceptionDetails) {
        return fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation error");
      }
      const v = result.result;
      if (v.type === "undefined") return ok("undefined");
      if (v.value !== undefined) return ok(typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2));
      return ok(v.description || String(v));
    }

    // ─── Run Script ───────────────────────────────────────────
    case "run_script": {
      const sess = await getTabSession(args.tabId);
      const wrapped = `(async () => { ${args.code} })()`;
      const result = await cdp("Runtime.evaluate", {
        expression: wrapped,
        returnByValue: true,
        awaitPromise: true,
        generatePreview: true,
        userGesture: true,
      }, sess, LONG_TIMEOUT);
      if (result.exceptionDetails) {
        return fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Script error");
      }
      const v = result.result;
      if (v.type === "undefined") return ok("Script completed (no return value).");
      if (v.value !== undefined) return ok(typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2));
      return ok(v.description || "Script completed.");
    }

    // ─── Get Content ──────────────────────────────────────────
    case "get_content": {
      const sess = await getTabSession(args.tabId);
      const prop = args.format === "html" ? "innerHTML" : "innerText";
      let expr;
      if (args.uid !== undefined) {
        const finder = uidResolver(args.uid);
        expr = `(() => { const el = ${finder}; if (!el) return "Element not found (uid=${args.uid})"; return el.${prop}; })()`;
      } else {
        const sel = args.selector || "body";
        expr = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return "Element not found: " + ${JSON.stringify(sel)}; return el.${prop}; })()`;
      }
      const result = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, sess);
      return ok(result.result.value ?? "(empty)");
    }

    // ─── Wait For ─────────────────────────────────────────────
    case "wait_for": {
      // Fixed time wait
      if (args.time) {
        await sleep(args.time * 1000);
        return ok(`Waited ${args.time} seconds.`);
      }

      if (!args.selector && !args.text && !args.textGone) {
        return fail("Provide 'text', 'textGone', 'selector', or 'time'.");
      }

      const sess = await getTabSession(args.tabId);
      const timeout = args.timeout || 10000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        let expr;
        if (args.textGone) {
          expr = `!document.body.innerText.includes(${JSON.stringify(args.textGone)})`;
        } else if (args.text) {
          expr = `document.body.innerText.includes(${JSON.stringify(args.text)})`;
        } else {
          expr = `!!document.querySelector(${JSON.stringify(args.selector)})`;
        }
        const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, sess, 5000);
        if (r.result.value === true) {
          const what = args.textGone ? `"${args.textGone}" disappeared` : args.text ? `"${args.text}" appeared` : `${args.selector} found`;
          return ok(`${what} (${Date.now() - start}ms)`);
        }
        await sleep(300);
      }
      const what = args.textGone || args.text || args.selector;
      return fail(`Timed out (${timeout}ms) waiting for ${what}`);
    }

    // ─── Console ──────────────────────────────────────────────
    case "console": {
      const sess = await getTabSession(args.tabId);
      await enableMonitoring(sess, "console");

      let logs = consoleLogs.get(sess) || [];
      if (args.level && args.level !== "all") {
        logs = logs.filter(l => l.level === args.level);
      }
      if (args.last) {
        logs = logs.slice(-args.last);
      }
      if (args.clear) {
        consoleLogs.set(sess, []);
      }
      if (!logs.length) return ok("No console messages captured yet. Interact with the page to generate console output.");

      const lines = logs.map(l => {
        const ts = new Date(l.ts).toLocaleTimeString();
        return `[${ts}] [${l.level.toUpperCase()}] ${l.text.substring(0, 200)}`;
      });
      return ok(`${logs.length} console message(s):\n\n${lines.join("\n")}`);
    }

    // ─── Network ──────────────────────────────────────────────
    case "network": {
      const sess = await getTabSession(args.tabId);
      await enableMonitoring(sess, "network");

      const reqMap = networkReqs.get(sess) || new Map();
      let reqs = Array.from(reqMap.values());

      if (args.filter) {
        const f = args.filter.toLowerCase();
        reqs = reqs.filter(r => r.url.toLowerCase().includes(f));
      }
      if (args.last) {
        reqs = reqs.slice(-args.last);
      }
      if (args.clear) {
        networkReqs.set(sess, new Map());
      }
      if (!reqs.length) return ok("No network requests captured yet. Navigate or interact to start capturing.");

      const lines = reqs.map(r => {
        const status = r.status || "pending";
        const size = r.size != null ? `${(r.size / 1024).toFixed(1)}KB` : "?";
        return `${r.method} ${status} ${size} ${r.url.substring(0, 120)}`;
      });
      return ok(`${reqs.length} request(s):\n\n${lines.join("\n")}`);
    }

    // ─── Drag ─────────────────────────────────────────────────
    case "drag": {
      const sess = await getTabSession(args.tabId);
      const src = await resolveElement(sess, args.sourceUid, args.sourceSelector);
      const tgt = await resolveElement(sess, args.targetUid, args.targetSelector);

      // Simulate drag: mousedown on source → mousemove to target → mouseup
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: src.x, y: src.y }, sess);
      await sleep(50);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: src.x, y: src.y, button: "left", clickCount: 1 }, sess);
      await sleep(100);

      // Move in steps for smoother drag
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const px = src.x + (tgt.x - src.x) * (i / steps);
        const py = src.y + (tgt.y - src.y) * (i / steps);
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py }, sess);
        await sleep(20);
      }

      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: tgt.x, y: tgt.y, button: "left", clickCount: 1 }, sess);
      return ok(`Dragged <${src.tag}> "${src.label}" → <${tgt.tag}> "${tgt.label}"`);
    }

    // ─── Emulate ──────────────────────────────────────────────
    case "emulate": {
      const sess = await getTabSession(args.tabId);
      const results = [];

      if (args.viewport) {
        const v = args.viewport;
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: v.width || 1280,
          height: v.height || 720,
          deviceScaleFactor: v.deviceScaleFactor || 1,
          mobile: v.mobile || false,
        }, sess);
        results.push(`Viewport: ${v.width || 1280}x${v.height || 720}`);
      }

      if (args.colorScheme) {
        if (args.colorScheme === "auto") {
          await cdp("Emulation.setEmulatedMedia", { features: [] }, sess);
        } else {
          await cdp("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: args.colorScheme }],
          }, sess);
        }
        results.push(`Color scheme: ${args.colorScheme}`);
      }

      if (args.userAgent) {
        await cdp("Emulation.setUserAgentOverride", { userAgent: args.userAgent }, sess);
        results.push(`User agent: ${args.userAgent.substring(0, 60)}`);
      }

      if (args.geolocation) {
        await cdp("Emulation.setGeolocationOverride", {
          latitude: args.geolocation.latitude,
          longitude: args.geolocation.longitude,
          accuracy: 100,
        }, sess);
        results.push(`Geolocation: ${args.geolocation.latitude}, ${args.geolocation.longitude}`);
      }

      if (args.cpuThrottle) {
        await cdp("Emulation.setCPUThrottlingRate", { rate: args.cpuThrottle }, sess);
        results.push(`CPU throttle: ${args.cpuThrottle}x`);
      }

      return ok(results.length ? results.join("\n") : "No emulation changes applied.");
    }

    // ─── Cleanup ──────────────────────────────────────────────
    case "cleanup": {
      if (args.action === "disconnect_tab") {
        if (!args.tabId) return fail("Provide 'tabId'.");
        await detachTab(args.tabId);
        return ok("Detached from tab.");
      }
      if (args.action === "disconnect_all") {
        const ids = [...activeSessions.keys()];
        for (const id of ids) await detachTab(id);
        return ok(`Disconnected from ${ids.length} tab(s).`);
      }
      if (args.action === "clean_temp") {
        const n = cleanupTempFiles();
        return ok(`Cleaned up ${n} temp file(s) from ${TEMP_DIR}`);
      }
      if (args.action === "status") {
        const tabs = await getTabs();
        return ok(
          `Browser tabs: ${tabs.length}\n` +
          `Connected sessions: ${activeSessions.size}\n` +
          `Temp dir: ${TEMP_DIR}\n` +
          `Temp files: ${existsSync(TEMP_DIR) ? readdirSync(TEMP_DIR).length : 0}`
        );
      }
      return fail(`Unknown cleanup action: ${args.action}`);
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

// ─── MCP Server Setup ───────────────────────────────────────────────

const server = new Server(
  { name: "cdp-browser", version: "2.0.0" },
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
