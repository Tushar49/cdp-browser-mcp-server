#!/usr/bin/env node

/**
 * CDP Browser Automation — MCP Server  v3.0
 *
 * 9 consolidated tools with ~50 sub-actions for full browser automation.
 *
 * Tools:
 *   tabs      — Tab lifecycle (list, find, new, close, activate, info)
 *   page      — Navigation, snapshot, screenshot, content, wait, PDF, dialog, inject, CSP bypass
 *   interact  — Click, hover, type, fill, select, press, drag, scroll, upload, focus, check
 *   execute   — JS eval, script, call-on-element
 *   observe   — Console, network, request body, performance metrics
 *   emulate   — Viewport, color, UA, geo, CPU, timezone, locale, vision, network, SSL, etc.
 *   storage   — Cookies, localStorage, indexedDB, cache, quota
 *   intercept — HTTP request interception, mocking, blocking via Fetch domain
 *   cleanup   — Disconnect sessions, clean temp files, status
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
const MAX_INLINE_LEN = 60_000;
const TEMP_DIR = join(tmpdir(), ".cdp-mcp");

// ─── Temp File Management ───────────────────────────────────────────

function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function writeTempFile(name, content, encoding = "utf8") {
  ensureTempDir();
  const p = join(TEMP_DIR, name);
  writeFileSync(p, content, encoding);
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
const callbacks = new Map();            // msgId → { resolve, reject }
const activeSessions = new Map();       // targetId → sessionId
const enabledDomains = new Map();       // sessionId → Set<domain>
const consoleLogs = new Map();          // sessionId → [ {level, text, ts} ]
const networkReqs = new Map();          // sessionId → Map<requestId, reqObj>
const eventListeners = new Map();       // sessionId → Set<string>

// v3: Dialog & Fetch interception state
const pendingDialogs = new Map();       // sessionId → [ {type, message, defaultPrompt, url, ts} ]
const pendingFetchRequests = new Map(); // sessionId → Map(requestId → requestInfo)
const fetchRules = new Map();           // sessionId → [ { pattern, action, response } ]
const injectedScripts = new Map();      // sessionId → [ { identifier, description } ]

const NO_ENABLE = new Set(["Input", "Target", "Browser", "Accessibility", "DOM", "Emulation", "Storage"]);

// ─── Network Throttle Presets ───────────────────────────────────────

const NETWORK_PRESETS = {
  offline:  { offline: true,  latency: 0,      downloadThroughput: 0,       uploadThroughput: 0 },
  slow3g:   { offline: false, latency: 2000,   downloadThroughput: 50000,   uploadThroughput: 50000 },
  fast3g:   { offline: false, latency: 562.5,  downloadThroughput: 180000,  uploadThroughput: 84375 },
  slow4g:   { offline: false, latency: 150,    downloadThroughput: 400000,  uploadThroughput: 150000 },
  fast4g:   { offline: false, latency: 50,     downloadThroughput: 1500000, uploadThroughput: 750000 },
  none:     { offline: false, latency: 0,      downloadThroughput: -1,      uploadThroughput: -1 },
};

// ─── WS URL Discovery ───────────────────────────────────────────────

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

// ─── Browser Connection ─────────────────────────────────────────────

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
      if (msg.id !== undefined) {
        const cb = callbacks.get(msg.id);
        if (cb) {
          callbacks.delete(msg.id);
          msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result);
        }
        return;
      }
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
      pendingDialogs.clear();
      pendingFetchRequests.clear();
      fetchRules.clear();
      injectedScripts.clear();
      browserWs = null;
    });
  });
}

// ─── CDP Event Handler ──────────────────────────────────────────────

function handleEvent(sessionId, method, params) {
  // ── Console messages ──
  if (method === "Runtime.consoleAPICalled") {
    const logs = consoleLogs.get(sessionId) || [];
    logs.push({
      level: params.type,
      text: params.args?.map(a => a.value ?? a.description ?? a.type).join(" ") || "",
      ts: Date.now(),
      url: params.stackTrace?.callFrames?.[0]?.url || "",
    });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    consoleLogs.set(sessionId, logs);
  }

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

  // ── Network requests ──
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

  // ── Dialog handling (v3) ──
  if (method === "Page.javascriptDialogOpening") {
    const dialogs = pendingDialogs.get(sessionId) || [];
    dialogs.push({
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPromptText || "",
      url: params.url || "",
      ts: Date.now(),
    });
    pendingDialogs.set(sessionId, dialogs);

    // Auto-accept after 10s if not manually handled
    setTimeout(async () => {
      const current = pendingDialogs.get(sessionId);
      if (current?.length > 0) {
        try {
          await cdp("Page.handleJavaScriptDialog", { accept: true }, sessionId);
          current.shift();
        } catch { /* already handled */ }
      }
    }, 10000);
  }

  // ── Fetch interception (v3) ──
  if (method === "Fetch.requestPaused") {
    const pending = pendingFetchRequests.get(sessionId) || new Map();
    const info = {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      resourceType: params.resourceType,
      ts: Date.now(),
    };

    // Check auto-rules first
    const rules = fetchRules.get(sessionId) || [];
    const matchingRule = rules.find(r => {
      try {
        const re = new RegExp(r.pattern.replace(/\*/g, ".*"), "i");
        return re.test(info.url);
      } catch { return false; }
    });

    if (matchingRule) {
      (async () => {
        try {
          if (matchingRule.action === "block") {
            await cdp("Fetch.failRequest", { requestId: params.requestId, reason: "BlockedByClient" }, sessionId);
          } else if (matchingRule.action === "mock" && matchingRule.response) {
            const r = matchingRule.response;
            await cdp("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: r.status || 200,
              responseHeaders: r.headers || [{ name: "Content-Type", value: "application/json" }],
              body: Buffer.from(r.body || "").toString("base64"),
            }, sessionId);
          } else {
            await cdp("Fetch.continueRequest", { requestId: params.requestId }, sessionId);
          }
        } catch { /* ok */ }
      })();
      return;
    }

    pending.set(params.requestId, info);
    pendingFetchRequests.set(sessionId, pending);

    // Auto-continue after 10s to prevent hangs
    setTimeout(async () => {
      if (pending.has(params.requestId)) {
        try { await cdp("Fetch.continueRequest", { requestId: params.requestId }, sessionId); } catch { /* ok */ }
        pending.delete(params.requestId);
      }
    }, 10000);
  }
}

// ─── CDP Command ────────────────────────────────────────────────────

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
  const existing = activeSessions.get(tabId);
  if (existing) {
    try {
      await cdp("Runtime.evaluate", { expression: "1", returnByValue: true }, existing, 5000);
      return existing;
    } catch {
      // Session may be broken — save state to migrate to new session
      const oldPendingDialogs = pendingDialogs.get(existing);
      activeSessions.delete(tabId);
      enabledDomains.delete(existing);

      // If dialogs are pending, the evaluate may have failed because JS is blocked
      // by a dialog. Return the existing session so the dialog can be handled.
      if (oldPendingDialogs?.length > 0) {
        activeSessions.set(tabId, existing);
        return existing;
      }
    }
  }

  const { sessionId } = await cdp("Target.attachToTarget", { targetId: tabId, flatten: true });

  // Ensure Runtime is enabled for both evaluate and event emission
  try {
    await cdp("Runtime.enable", {}, sessionId, LONG_TIMEOUT);
  } catch { /* some targets don't support it */ }

  activeSessions.set(tabId, sessionId);
  enabledDomains.set(sessionId, new Set(["Runtime"]));
  consoleLogs.set(sessionId, []);
  networkReqs.set(sessionId, new Map());

  // v3: Enable Page domain for dialog handling
  await ensureDomain(sessionId, "Page");

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
    domains.add(domain);
    enabledDomains.set(sessionId, domains);
  }
}

async function enableMonitoring(sessionId, what) {
  const listeners = eventListeners.get(sessionId) || new Set();
  if (what === "console" && !listeners.has("console")) {
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
  pendingDialogs.delete(sid);
  pendingFetchRequests.delete(sid);
  fetchRules.delete(sid);
  injectedScripts.delete(sid);
}

// ─── Tab Listing ────────────────────────────────────────────────────

async function getTabs() {
  await connectBrowser();
  const { targetInfos } = await cdp("Target.getTargets", { filter: [{ type: "page" }] });
  return targetInfos || [];
}

// ─── Accessibility Tree / Snapshot ──────────────────────────────────

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

    const children = el.children;
    if (children && children.length > 0) {
      const childDepth = role ? depth + 1 : depth;
      for (let i = 0; i < children.length; i++) {
        output += walk(children[i], childDepth);
      }
    } else if (!role) {
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

// ─── UID Resolver ───────────────────────────────────────────────────

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
  f1: { key: "F1", code: "F1", keyCode: 112 }, f2: { key: "F2", code: "F2", keyCode: 113 },
  f3: { key: "F3", code: "F3", keyCode: 114 }, f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 }, f6: { key: "F6", code: "F6", keyCode: 117 },
  f7: { key: "F7", code: "F7", keyCode: 118 }, f8: { key: "F8", code: "F8", keyCode: 119 },
  f9: { key: "F9", code: "F9", keyCode: 120 }, f10: { key: "F10", code: "F10", keyCode: 121 },
  f11: { key: "F11", code: "F11", keyCode: 122 }, f12: { key: "F12", code: "F12", keyCode: 123 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};

function resolveKey(keyName) {
  const lower = keyName.toLowerCase();
  if (KEY_MAP[lower]) return KEY_MAP[lower];
  if (keyName.length === 1) {
    return { key: keyName, code: `Key${keyName.toUpperCase()}`, keyCode: keyName.toUpperCase().charCodeAt(0), text: keyName };
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

// ─── Element Resolution ─────────────────────────────────────────────

function elementFinderExpr(uid, selector) {
  if (uid !== undefined && uid !== null) return uidResolver(uid);
  if (selector) return `document.querySelector(${JSON.stringify(selector)})`;
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

/** Resolve uid/selector to a remote JS object ID (for callFunctionOn, etc.) */
async function resolveElementObjectId(sessionId, uid, selector) {
  const finder = elementFinderExpr(uid, selector);
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = ${finder};
      if (!el) throw new Error("Element not found");
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return el;
    })()`,
    returnByValue: false,
  }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Element resolution failed");
  return result.result.objectId;
}

// ─── Tool Definitions (9 tools) ─────────────────────────────────────

const TOOLS = [
  // ── 1. tabs ──
  {
    name: "tabs",
    description: "Manage browser tabs. Actions: list, find, new, close, activate, info.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "find", "new", "close", "activate", "info"], description: "Tab action to perform." },
        query: { type: "string", description: "Search text for 'find' action." },
        tabId: { type: "string", description: "Tab ID for close/activate/info." },
        url: { type: "string", description: "URL for 'new' action." },
      },
      required: ["action"],
    },
  },

  // ── 2. page ──
  {
    name: "page",
    description: "Page-level operations: navigation, snapshot, screenshot, content, wait, PDF export, dialog handling, script injection, CSP bypass. Actions: goto, back, forward, reload, snapshot, screenshot, content, wait, pdf, dialog, inject, bypass_csp.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["goto", "back", "forward", "reload", "snapshot", "screenshot", "content", "wait", "pdf", "dialog", "inject", "bypass_csp"], description: "Page action." },
        tabId: { type: "string", description: "Tab ID." },
        url: { type: "string", description: "URL for goto." },
        ignoreCache: { type: "boolean", description: "Ignore cache on reload." },
        fullPage: { type: "boolean", description: "Full-page screenshot." },
        quality: { type: "number", description: "JPEG quality 0-100." },
        uid: { type: "number", description: "Element uid for screenshot/content." },
        selector: { type: "string", description: "CSS selector for content/wait." },
        format: { type: "string", enum: ["text", "html"], description: "Content format." },
        text: { type: "string", description: "Text to wait for / dialog prompt text." },
        textGone: { type: "string", description: "Text to wait to disappear." },
        time: { type: "number", description: "Wait time in seconds." },
        timeout: { type: "number", description: "Max wait in ms." },
        accept: { type: "boolean", description: "Accept (true) or dismiss (false) dialog." },
        landscape: { type: "boolean", description: "PDF landscape orientation." },
        scale: { type: "number", description: "PDF scale factor." },
        paperWidth: { type: "number", description: "PDF paper width in inches." },
        paperHeight: { type: "number", description: "PDF paper height in inches." },
        margin: { type: "object", description: "PDF margins {top, bottom, left, right} in inches.", properties: { top: { type: "number" }, bottom: { type: "number" }, left: { type: "number" }, right: { type: "number" } } },
        script: { type: "string", description: "Script for inject action." },
        enabled: { type: "boolean", description: "Enable/disable for bypass_csp." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 3. interact ──
  {
    name: "interact",
    description: "Element interaction: click, hover, type, fill form, select option, press key, drag & drop, scroll, file upload, focus, checkbox toggle. Actions: click, hover, type, fill, select, press, drag, scroll, upload, focus, check.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "hover", "type", "fill", "select", "press", "drag", "scroll", "upload", "focus", "check"], description: "Interaction action." },
        tabId: { type: "string", description: "Tab ID." },
        uid: { type: "number", description: "Element uid from snapshot." },
        selector: { type: "string", description: "CSS selector." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button for click." },
        clickCount: { type: "number", description: "Click count (2 = double-click)." },
        text: { type: "string", description: "Text to type." },
        clear: { type: "boolean", description: "Clear field before typing (default: true)." },
        submit: { type: "boolean", description: "Press Enter after typing." },
        fields: { type: "array", description: "Fields for fill: [{uid, selector, value, type}].", items: { type: "object", properties: { uid: { type: "number" }, selector: { type: "string" }, value: { type: "string" }, type: { type: "string", enum: ["text", "checkbox", "radio", "select"] } }, required: ["value"] } },
        value: { type: "string", description: "Value for select action." },
        key: { type: "string", description: "Key for press action." },
        modifiers: { type: "array", items: { type: "string", enum: ["Ctrl", "Shift", "Alt", "Meta"] }, description: "Modifier keys for press." },
        sourceUid: { type: "number", description: "Drag source uid." },
        sourceSelector: { type: "string", description: "Drag source selector." },
        targetUid: { type: "number", description: "Drag target uid." },
        targetSelector: { type: "string", description: "Drag target selector." },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
        amount: { type: "number", description: "Scroll pixels (default: 400)." },
        x: { type: "number", description: "Scroll-to X position." },
        y: { type: "number", description: "Scroll-to Y position." },
        files: { type: "array", items: { type: "string" }, description: "File paths for upload." },
        checked: { type: "boolean", description: "Desired checked state for check action." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 4. execute ──
  {
    name: "execute",
    description: "Execute JavaScript on page. Actions: eval (inline expression), script (async function body), call (function with element argument).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["eval", "script", "call"], description: "Execution mode." },
        tabId: { type: "string", description: "Tab ID." },
        expression: { type: "string", description: "JS expression for eval." },
        code: { type: "string", description: "JS function body for script (wrapped in async IIFE)." },
        function: { type: "string", description: "JS function for call, receives element as arg. E.g. '(el) => el.textContent'" },
        uid: { type: "number", description: "Element uid for call." },
        selector: { type: "string", description: "CSS selector for call." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 5. observe ──
  {
    name: "observe",
    description: "Monitor console messages, network requests, get full request/response bodies, and performance metrics. Actions: console, network, request, performance.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["console", "network", "request", "performance"], description: "Observe action." },
        tabId: { type: "string", description: "Tab ID." },
        level: { type: "string", enum: ["all", "error", "warning", "log", "info", "debug"], description: "Console level filter." },
        filter: { type: "string", description: "Network URL filter." },
        types: { type: "array", items: { type: "string" }, description: "Network resource types filter: xhr, fetch, document, script, stylesheet, image, font, media, websocket, other." },
        clear: { type: "boolean", description: "Clear captured data after returning." },
        last: { type: "number", description: "Return only last N items." },
        requestId: { type: "string", description: "Request ID for full body retrieval." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 6. emulate ──
  {
    name: "emulate",
    description: "Emulate device/environment: viewport, color scheme, user agent, geolocation, CPU throttle, timezone, locale, vision deficiency, auto dark mode, idle state, network conditions, SSL bypass, URL blocking, extra headers. Pass 'reset: true' to clear all.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        viewport: { type: "object", description: "Viewport {width, height, deviceScaleFactor, mobile, touch, landscape}.", properties: { width: { type: "number" }, height: { type: "number" }, deviceScaleFactor: { type: "number" }, mobile: { type: "boolean" }, touch: { type: "boolean" }, landscape: { type: "boolean" } } },
        colorScheme: { type: "string", enum: ["dark", "light", "auto"], description: "Color scheme." },
        userAgent: { type: "string", description: "User agent string." },
        geolocation: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" } } },
        cpuThrottle: { type: "number", description: "CPU throttle rate (1 = normal)." },
        timezone: { type: "string", description: "Timezone, e.g. 'America/New_York'." },
        locale: { type: "string", description: "Locale, e.g. 'fr-FR'." },
        visionDeficiency: { type: "string", enum: ["none", "protanopia", "deuteranopia", "tritanopia", "achromatopsia", "blurredVision"], description: "Vision deficiency simulation." },
        autoDarkMode: { type: "boolean", description: "Auto dark mode." },
        idle: { type: "string", enum: ["active", "locked"], description: "Idle state." },
        networkCondition: { type: "string", enum: ["offline", "slow3g", "fast3g", "slow4g", "fast4g", "none"], description: "Network throttle preset." },
        ignoreSSL: { type: "boolean", description: "Ignore SSL certificate errors." },
        blockUrls: { type: "array", items: { type: "string" }, description: "URLs to block." },
        extraHeaders: { type: "object", description: "Extra HTTP headers." },
        reset: { type: "boolean", description: "Reset all emulation overrides." },
      },
      required: ["tabId"],
    },
  },

  // ── 7. storage ──
  {
    name: "storage",
    description: "Cookie and storage management. Actions: get_cookies, set_cookie, delete_cookies, clear_cookies, clear_data, quota.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get_cookies", "set_cookie", "delete_cookies", "clear_cookies", "clear_data", "quota"], description: "Storage action." },
        tabId: { type: "string", description: "Tab ID." },
        urls: { type: "array", items: { type: "string" }, description: "URLs for get_cookies." },
        name: { type: "string", description: "Cookie name." },
        value: { type: "string", description: "Cookie value." },
        domain: { type: "string", description: "Cookie domain." },
        path: { type: "string", description: "Cookie path." },
        secure: { type: "boolean", description: "Secure flag." },
        httpOnly: { type: "boolean", description: "HttpOnly flag." },
        sameSite: { type: "string", enum: ["None", "Lax", "Strict"], description: "SameSite attribute." },
        expires: { type: "number", description: "Expiry as epoch seconds." },
        url: { type: "string", description: "URL for delete_cookies." },
        origin: { type: "string", description: "Origin for clear_data." },
        types: { type: "string", description: "Storage types: 'cookies,local_storage,indexeddb,cache_storage' or 'all'." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 8. intercept ──
  {
    name: "intercept",
    description: "HTTP request interception via CDP Fetch domain. Intercept, modify, mock, or block requests. Actions: enable, disable, continue, fulfill, fail, list.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["enable", "disable", "continue", "fulfill", "fail", "list"], description: "Intercept action." },
        tabId: { type: "string", description: "Tab ID." },
        patterns: { type: "array", items: { type: "string" }, description: "URL patterns to intercept, e.g. ['*.api.example.com/*']." },
        requestId: { type: "string", description: "Paused request ID." },
        url: { type: "string", description: "Override URL for continue." },
        method: { type: "string", description: "Override method for continue." },
        headers: { type: "object", description: "Override headers for continue/fulfill." },
        postData: { type: "string", description: "Override body for continue." },
        status: { type: "number", description: "Response status for fulfill." },
        body: { type: "string", description: "Response body for fulfill." },
        reason: { type: "string", enum: ["Failed", "Aborted", "TimedOut", "AccessDenied", "ConnectionClosed", "ConnectionReset", "ConnectionRefused", "ConnectionAborted", "ConnectionFailed", "NameNotResolved", "InternetDisconnected", "AddressUnreachable", "BlockedByClient", "BlockedByResponse"], description: "Failure reason." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 9. cleanup ──
  {
    name: "cleanup",
    description: "Disconnect from tabs and/or clean up temp files. Actions: disconnect_tab, disconnect_all, clean_temp, status.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["disconnect_tab", "disconnect_all", "clean_temp", "status"], description: "Cleanup action." },
        tabId: { type: "string", description: "Tab ID for disconnect_tab." },
      },
      required: ["action"],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
//  HANDLER IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════

// ─── Tabs Handlers ──────────────────────────────────────────────────

async function handleTabsList() {
  const tabs = await getTabs();
  if (!tabs.length) return ok("No open tabs found.");
  const lines = tabs.map((t, i) => {
    const c = activeSessions.has(t.targetId) ? " [connected]" : "";
    return `${i + 1}. [${t.targetId}]${c}\n   ${t.title}\n   ${t.url}`;
  });
  return ok(`${tabs.length} tab(s):\n\n${lines.join("\n\n")}`);
}

async function handleTabsFind(args) {
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

async function handleTabsNew(args) {
  const url = args.url || "about:blank";
  const { targetId } = await cdp("Target.createTarget", { url });
  return ok(`New tab: [${targetId}]\nURL: ${url}`);
}

async function handleTabsClose(args) {
  if (!args.tabId) return fail("Provide 'tabId' to close.");
  await detachTab(args.tabId);
  await cdp("Target.closeTarget", { targetId: args.tabId });
  return ok("Tab closed.");
}

async function handleTabsActivate(args) {
  if (!args.tabId) return fail("Provide 'tabId' to activate.");
  await cdp("Target.activateTarget", { targetId: args.tabId });
  return ok("Tab activated (brought to foreground).");
}

async function handleTabsInfo(args) {
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

// ─── Page Handlers ──────────────────────────────────────────────────

async function handlePageGoto(args) {
  if (!args.url) return fail("Provide 'url' for navigation.");
  const sess = await getTabSession(args.tabId);
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

async function handlePageBack(args) {
  const sess = await getTabSession(args.tabId);
  const { currentIndex, entries } = await cdp("Page.getNavigationHistory", {}, sess);
  if (currentIndex > 0) {
    await cdp("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id }, sess);
    await sleep(500);
    const r = await cdp("Runtime.evaluate", { expression: "document.title + ' — ' + location.href", returnByValue: true }, sess);
    return ok(`Navigated back → ${r.result.value}`);
  }
  return ok("Already at the beginning of history.");
}

async function handlePageForward(args) {
  const sess = await getTabSession(args.tabId);
  const { currentIndex, entries } = await cdp("Page.getNavigationHistory", {}, sess);
  if (currentIndex < entries.length - 1) {
    await cdp("Page.navigateToHistoryEntry", { entryId: entries[currentIndex + 1].id }, sess);
    await sleep(500);
    const r = await cdp("Runtime.evaluate", { expression: "document.title + ' — ' + location.href", returnByValue: true }, sess);
    return ok(`Navigated forward → ${r.result.value}`);
  }
  return ok("Already at the end of history.");
}

async function handlePageReload(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Page.reload", { ignoreCache: args.ignoreCache || false }, sess);
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

async function handlePageSnapshot(args) {
  const sess = await getTabSession(args.tabId);
  const snap = await buildSnapshot(sess);
  const header = `Page: ${snap.title}\nURL: ${snap.url}\nElements: ${snap.count}\n\n`;
  return ok(header + snap.snapshot);
}

async function handlePageScreenshot(args) {
  const sess = await getTabSession(args.tabId);
  const params = {};
  if (args.quality !== undefined) {
    params.format = "jpeg";
    params.quality = args.quality;
  } else {
    params.format = "png";
  }

  // Element-level screenshot via uid
  if (args.uid !== undefined) {
    const el = await resolveElement(sess, args.uid);
    const r = el;
    params.clip = { x: r.x - r.w / 2, y: r.y - r.h / 2, width: r.w, height: r.h, scale: 1 };
  } else if (args.fullPage) {
    await ensureDomain(sess, "Page");
    const m = await cdp("Page.getLayoutMetrics", {}, sess);
    const { width, height } = m.cssContentSize || m.contentSize;
    params.clip = { x: 0, y: 0, width, height, scale: 1 };
  }
  const { data } = await cdp("Page.captureScreenshot", params, sess);
  return { content: [{ type: "image", data, mimeType: params.format === "jpeg" ? "image/jpeg" : "image/png" }] };
}

async function handlePageContent(args) {
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

async function handlePageWait(args) {
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
    if (args.textGone) expr = `!document.body.innerText.includes(${JSON.stringify(args.textGone)})`;
    else if (args.text) expr = `document.body.innerText.includes(${JSON.stringify(args.text)})`;
    else expr = `!!document.querySelector(${JSON.stringify(args.selector)})`;
    const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, sess, 5000);
    if (r.result.value === true) {
      const what = args.textGone ? `"${args.textGone}" disappeared` : args.text ? `"${args.text}" appeared` : `${args.selector} found`;
      return ok(`${what} (${Date.now() - start}ms)`);
    }
    await sleep(300);
  }
  return fail(`Timed out (${timeout}ms) waiting for ${args.textGone || args.text || args.selector}`);
}

async function handlePagePdf(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");
  const pdfParams = {
    printBackground: true,
    landscape: args.landscape || false,
    scale: args.scale || 1,
    paperWidth: args.paperWidth || 8.5,
    paperHeight: args.paperHeight || 11,
    marginTop: args.margin?.top ?? 0.4,
    marginBottom: args.margin?.bottom ?? 0.4,
    marginLeft: args.margin?.left ?? 0.4,
    marginRight: args.margin?.right ?? 0.4,
  };
  const { data } = await cdp("Page.printToPDF", pdfParams, sess, LONG_TIMEOUT);
  const buf = Buffer.from(data, "base64");
  ensureTempDir();
  const path = join(TEMP_DIR, `page-${Date.now()}.pdf`);
  writeFileSync(path, buf);
  return ok(`PDF saved to: ${path}\nSize: ${(buf.length / 1024).toFixed(1)} KB`);
}

async function handlePageDialog(args) {
  const sess = await getTabSession(args.tabId);
  const dialogs = pendingDialogs.get(sess) || [];

  if (dialogs.length === 0) {
    return ok("No pending dialog.");
  }

  const dialog = dialogs[0];
  const accept = args.accept !== undefined ? args.accept : true;
  const dialogParams = { accept };
  if (args.text !== undefined) dialogParams.promptText = args.text;

  await cdp("Page.handleJavaScriptDialog", dialogParams, sess);
  dialogs.shift();

  return ok(`Dialog handled: ${dialog.type} "${dialog.message.substring(0, 100)}"\nAction: ${accept ? "accepted" : "dismissed"}${args.text ? ` with text: "${args.text}"` : ""}`);
}

async function handlePageInject(args) {
  if (!args.script) return fail("Provide 'script' to inject.");
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");
  const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: args.script }, sess);
  const scripts = injectedScripts.get(sess) || [];
  scripts.push({ identifier, description: args.script.substring(0, 80) });
  injectedScripts.set(sess, scripts);
  return ok(`Script injected (id: ${identifier}). Will run on every new document load.\nPreview: ${args.script.substring(0, 120)}`);
}

async function handlePageBypassCsp(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");
  const enabled = args.enabled !== undefined ? args.enabled : true;
  await cdp("Page.setBypassCSP", { enabled }, sess);
  return ok(`Content Security Policy bypass: ${enabled ? "enabled" : "disabled"}`);
}

// ─── Interact Handlers ──────────────────────────────────────────────

async function handleInteractClick(args) {
  const sess = await getTabSession(args.tabId);
  const el = await resolveElement(sess, args.uid, args.selector);
  const button = args.button || "left";
  const clicks = args.clickCount || 1;
  const buttonCode = button === "right" ? 2 : button === "middle" ? 1 : 0;
  // CDP buttons bitmask: 1=left, 2=right, 4=middle
  const buttonsMap = { left: 1, right: 2, middle: 4 };
  const buttons = buttonsMap[button] || 1;

  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y }, sess);
  await sleep(50);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: el.x, y: el.y, button, clickCount: clicks, buttons }, sess);
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: el.x, y: el.y, button, clickCount: clicks }, sess);
  return ok(`Clicked <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})`);
}

async function handleInteractHover(args) {
  const sess = await getTabSession(args.tabId);
  const el = await resolveElement(sess, args.uid, args.selector);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y }, sess);
  return ok(`Hovering over <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})`);
}

async function handleInteractType(args) {
  if (!args.text) return fail("Provide 'text' to type.");
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

async function handleInteractFill(args) {
  if (!args.fields?.length) return fail("Provide 'fields' array.");
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
      if (type === "radio") { el.click(); return { ok: true, value: val }; }
      if (type === "select") {
        let opt = Array.from(el.options).find(o => o.value === val || o.textContent.trim() === val);
        if (!opt) return { error: "Option not found: " + val };
        el.value = opt.value;
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return { ok: true, value: opt.textContent.trim() };
      }
      el.focus();
      if ('value' in el) el.value = val; else el.textContent = val;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return { ok: true, value: val.substring(0, 40) };
    })()`;
    const r = await cdp("Runtime.evaluate", { expression: code, returnByValue: true }, sess);
    results.push({ field: field.uid ?? field.selector, ...(r.result.value || { error: "eval failed" }) });
  }
  return ok({ filled: results });
}

async function handleInteractSelect(args) {
  if (!args.value) return fail("Provide 'value' to select.");
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

async function handleInteractPress(args) {
  if (!args.key) return fail("Provide 'key' to press.");
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

async function handleInteractDrag(args) {
  const sess = await getTabSession(args.tabId);
  const src = await resolveElement(sess, args.sourceUid, args.sourceSelector);
  const tgt = await resolveElement(sess, args.targetUid, args.targetSelector);

  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: src.x, y: src.y }, sess);
  await sleep(50);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: src.x, y: src.y, button: "left", clickCount: 1 }, sess);
  await sleep(100);
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

async function handleInteractScroll(args) {
  const sess = await getTabSession(args.tabId);
  const amount = args.amount || 400;

  // scrollTo absolute position
  if (args.x !== undefined || args.y !== undefined) {
    const scrollX = args.x ?? 0;
    const scrollY = args.y ?? 0;
    if (args.uid !== undefined || args.selector) {
      const finder = elementFinderExpr(args.uid, args.selector);
      await cdp("Runtime.evaluate", {
        expression: `(() => { const el = ${finder}; if(el) el.scrollTo({left:${scrollX},top:${scrollY},behavior:'smooth'}); })()`,
        returnByValue: true,
      }, sess);
    } else {
      await cdp("Runtime.evaluate", {
        expression: `window.scrollTo({left:${scrollX},top:${scrollY},behavior:'smooth'})`,
        returnByValue: true,
      }, sess);
    }
    return ok(`Scrolled to (${scrollX}, ${scrollY})`);
  }

  // scrollBy with direction
  const dir = args.direction || "down";
  let deltaX = 0, deltaY = 0;
  switch (dir) {
    case "up": deltaY = -amount; break;
    case "down": deltaY = amount; break;
    case "left": deltaX = -amount; break;
    case "right": deltaX = amount; break;
  }

  if (args.uid !== undefined || args.selector) {
    const finder = elementFinderExpr(args.uid, args.selector);
    await cdp("Runtime.evaluate", {
      expression: `(() => { const el = ${finder}; if(el) el.scrollBy({left:${deltaX},top:${deltaY},behavior:'smooth'}); })()`,
      returnByValue: true,
    }, sess);
  } else {
    await cdp("Runtime.evaluate", {
      expression: `window.scrollBy({left:${deltaX},top:${deltaY},behavior:'smooth'})`,
      returnByValue: true,
    }, sess);
  }
  return ok(`Scrolled ${dir} by ${amount}px`);
}

async function handleInteractUpload(args) {
  if (!args.files?.length) return fail("Provide 'files' array with absolute file paths.");
  const sess = await getTabSession(args.tabId);

  // Resolve element to get backendNodeId
  const finder = elementFinderExpr(args.uid, args.selector);
  const evalResult = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = ${finder};
      if (!el) return { error: "Element not found" };
      el.scrollIntoView({ block: "center" });
      return { tag: el.tagName.toLowerCase(), type: el.type || "" };
    })()`,
    returnByValue: true,
  }, sess);
  if (evalResult.result.value?.error) return fail(evalResult.result.value.error);

  // Get objectId for the element
  const objResult = await cdp("Runtime.evaluate", {
    expression: finder,
    returnByValue: false,
  }, sess);
  if (!objResult.result.objectId) return fail("Could not resolve element for file upload.");

  // Describe node to get backendNodeId
  const { node } = await cdp("DOM.describeNode", { objectId: objResult.result.objectId }, sess);
  await cdp("DOM.setFileInputFiles", { files: args.files, backendNodeId: node.backendNodeId }, sess);

  return ok(`Uploaded ${args.files.length} file(s): ${args.files.map(f => f.split(/[/\\]/).pop()).join(", ")}`);
}

async function handleInteractFocus(args) {
  const sess = await getTabSession(args.tabId);
  const finder = elementFinderExpr(args.uid, args.selector);
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = ${finder};
      if (!el) return { error: "Element not found" };
      el.scrollIntoView({ block: "center" });
      el.focus();
      return { tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || el.textContent || "").trim().substring(0, 60) };
    })()`,
    returnByValue: true,
  }, sess);
  const v = result.result.value;
  if (v?.error) return fail(v.error);
  return ok(`Focused <${v.tag}> "${v.label}"`);
}

async function handleInteractCheck(args) {
  if (args.checked === undefined) return fail("Provide 'checked' (true/false).");
  const sess = await getTabSession(args.tabId);
  const finder = elementFinderExpr(args.uid, args.selector);
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = ${finder};
      if (!el) return { error: "Element not found" };
      el.scrollIntoView({ block: "center" });
      const desired = ${args.checked === true};
      if (el.checked !== desired) {
        el.click();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { checked: el.checked, label: (el.getAttribute("aria-label") || el.labels?.[0]?.textContent || "").trim().substring(0, 60) };
    })()`,
    returnByValue: true,
  }, sess);
  const v = result.result.value;
  if (v?.error) return fail(v.error);
  return ok(`Checkbox "${v.label}": ${v.checked ? "checked" : "unchecked"}`);
}

// ─── Execute Handlers ───────────────────────────────────────────────

async function handleExecuteEval(args) {
  if (!args.expression) return fail("Provide 'expression' to evaluate.");
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

async function handleExecuteScript(args) {
  if (!args.code) return fail("Provide 'code' for script body.");
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

async function handleExecuteCall(args) {
  if (!args.function) return fail("Provide 'function' declaration, e.g. '(el) => el.textContent'.");
  const sess = await getTabSession(args.tabId);
  const objectId = await resolveElementObjectId(sess, args.uid, args.selector);

  const result = await cdp("Runtime.callFunctionOn", {
    functionDeclaration: args.function,
    objectId,
    arguments: [{ objectId }],
    returnByValue: true,
    awaitPromise: true,
  }, sess);

  if (result.exceptionDetails) {
    return fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Call error");
  }
  const v = result.result;
  if (v.type === "undefined") return ok("undefined");
  if (v.value !== undefined) return ok(typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2));
  return ok(v.description || String(v));
}

// ─── Observe Handlers ───────────────────────────────────────────────

async function handleObserveConsole(args) {
  const sess = await getTabSession(args.tabId);
  await enableMonitoring(sess, "console");

  let logs = consoleLogs.get(sess) || [];
  if (args.level && args.level !== "all") logs = logs.filter(l => l.level === args.level);
  if (args.last) logs = logs.slice(-args.last);
  if (args.clear) consoleLogs.set(sess, []);
  if (!logs.length) return ok("No console messages captured yet. Interact with the page to generate console output.");

  const lines = logs.map(l => {
    const ts = new Date(l.ts).toLocaleTimeString();
    return `[${ts}] [${l.level.toUpperCase()}] ${l.text.substring(0, 200)}`;
  });
  return ok(`${logs.length} console message(s):\n\n${lines.join("\n")}`);
}

async function handleObserveNetwork(args) {
  const sess = await getTabSession(args.tabId);
  await enableMonitoring(sess, "network");

  const reqMap = networkReqs.get(sess) || new Map();
  let reqs = Array.from(reqMap.values());

  if (args.filter) {
    const f = args.filter.toLowerCase();
    reqs = reqs.filter(r => r.url.toLowerCase().includes(f));
  }
  if (args.types?.length) {
    const types = new Set(args.types.map(t => t.toLowerCase()));
    reqs = reqs.filter(r => types.has((r.type || "").toLowerCase()));
  }
  if (args.last) reqs = reqs.slice(-args.last);
  if (args.clear) networkReqs.set(sess, new Map());
  if (!reqs.length) return ok("No network requests captured yet. Navigate or interact to start capturing.");

  const lines = reqs.map(r => {
    const status = r.status || "pending";
    const size = r.size != null ? `${(r.size / 1024).toFixed(1)}KB` : "?";
    return `[${r.id}] ${r.method} ${status} ${size} ${r.type} ${r.url.substring(0, 120)}`;
  });
  return ok(`${reqs.length} request(s):\n\n${lines.join("\n")}`);
}

async function handleObserveRequest(args) {
  if (!args.requestId) return fail("Provide 'requestId' (from network listing).");
  const sess = await getTabSession(args.tabId);
  await enableMonitoring(sess, "network");

  const reqMap = networkReqs.get(sess) || new Map();
  const reqInfo = reqMap.get(args.requestId);

  const result = { requestId: args.requestId };
  if (reqInfo) {
    result.url = reqInfo.url;
    result.method = reqInfo.method;
    result.status = reqInfo.status;
    result.type = reqInfo.type;
  }

  // Get response body
  try {
    const resp = await cdp("Network.getResponseBody", { requestId: args.requestId }, sess);
    if (resp.base64Encoded) {
      const decoded = Buffer.from(resp.body, "base64");
      if (decoded.length > MAX_INLINE_LEN) {
        const path = writeTempFile(`response-${Date.now()}.bin`, decoded, null);
        result.responseBody = `[Binary, ${decoded.length} bytes, saved to: ${path}]`;
      } else {
        result.responseBody = decoded.toString("utf8");
      }
    } else {
      result.responseBody = resp.body;
    }
  } catch (e) {
    result.responseBody = `[Not available: ${e.message}]`;
  }

  // Get request post data
  try {
    const post = await cdp("Network.getRequestPostData", { requestId: args.requestId }, sess);
    result.requestBody = post.postData;
  } catch {
    result.requestBody = null;
  }

  return ok(result);
}

async function handleObservePerformance(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Performance");
  const { metrics } = await cdp("Performance.getMetrics", {}, sess);

  const m = {};
  for (const { name, value } of metrics) m[name] = value;

  const fmt = (bytes) => {
    if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${bytes}B`;
  };

  const lines = [
    `Documents: ${m.Documents || 0} | Frames: ${m.Frames || 0}`,
    `DOM Nodes: ${m.Nodes || 0} | JS Listeners: ${m.JSEventListeners || 0}`,
    `JS Heap: ${fmt(m.JSHeapUsedSize || 0)} / ${fmt(m.JSHeapTotalSize || 0)}`,
    `Layout: ${m.LayoutCount || 0} recalcs, ${((m.LayoutDuration || 0) * 1000).toFixed(1)}ms total`,
    `Style Recalc: ${m.RecalcStyleCount || 0} recalcs, ${((m.RecalcStyleDuration || 0) * 1000).toFixed(1)}ms total`,
    `Scripts: ${((m.ScriptDuration || 0) * 1000).toFixed(1)}ms total`,
    `Tasks: ${((m.TaskDuration || 0) * 1000).toFixed(1)}ms total`,
  ];
  return ok(`Performance Metrics:\n\n${lines.join("\n")}`);
}

// ─── Emulate Handler ────────────────────────────────────────────────

async function handleEmulate(args) {
  const sess = await getTabSession(args.tabId);
  const results = [];

  // Reset all overrides
  if (args.reset) {
    try { await cdp("Emulation.clearDeviceMetricsOverride", {}, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setEmulatedMedia", { features: [] }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.clearGeolocationOverride", {}, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setCPUThrottlingRate", { rate: 1 }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setTimezoneOverride", { timezoneId: "" }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setLocaleOverride", { locale: "" }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setEmulatedVisionDeficiency", { type: "none" }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.clearIdleOverride", {}, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setUserAgentOverride", { userAgent: "" }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setAutoDarkModeOverride", {}, sess); } catch { /* ok */ }
    try {
      await ensureDomain(sess, "Network");
      await cdp("Network.emulateNetworkConditions", NETWORK_PRESETS.none, sess);
      await cdp("Network.setBlockedURLs", { urls: [] }, sess);
      await cdp("Network.setExtraHTTPHeaders", { headers: {} }, sess);
    } catch { /* ok */ }
    try {
      await ensureDomain(sess, "Security");
      await cdp("Security.setIgnoreCertificateErrors", { ignore: false }, sess);
    } catch { /* ok */ }
    return ok("All emulation overrides reset.");
  }

  if (args.viewport) {
    const v = args.viewport;
    const width = v.landscape ? (v.height || 720) : (v.width || 1280);
    const height = v.landscape ? (v.width || 1280) : (v.height || 720);
    await cdp("Emulation.setDeviceMetricsOverride", {
      width, height,
      deviceScaleFactor: v.deviceScaleFactor || 1,
      mobile: v.mobile || false,
    }, sess);
    if (v.touch) {
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: true }, sess);
    }
    results.push(`Viewport: ${width}x${height}${v.mobile ? " (mobile)" : ""}${v.touch ? " (touch)" : ""}`);
  }

  if (args.colorScheme) {
    if (args.colorScheme === "auto") {
      await cdp("Emulation.setEmulatedMedia", { features: [] }, sess);
    } else {
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: args.colorScheme }] }, sess);
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

  if (args.timezone) {
    await cdp("Emulation.setTimezoneOverride", { timezoneId: args.timezone }, sess);
    results.push(`Timezone: ${args.timezone}`);
  }

  if (args.locale) {
    await cdp("Emulation.setLocaleOverride", { locale: args.locale }, sess);
    results.push(`Locale: ${args.locale}`);
  }

  if (args.visionDeficiency) {
    await cdp("Emulation.setEmulatedVisionDeficiency", { type: args.visionDeficiency }, sess);
    results.push(`Vision deficiency: ${args.visionDeficiency}`);
  }

  if (args.autoDarkMode !== undefined) {
    await cdp("Emulation.setAutoDarkModeOverride", { enabled: args.autoDarkMode }, sess);
    results.push(`Auto dark mode: ${args.autoDarkMode}`);
  }

  if (args.idle) {
    if (args.idle === "active") {
      await cdp("Emulation.setIdleOverride", { isUserActive: true, isScreenUnlocked: true }, sess);
    } else {
      await cdp("Emulation.setIdleOverride", { isUserActive: false, isScreenUnlocked: false }, sess);
    }
    results.push(`Idle state: ${args.idle}`);
  }

  if (args.networkCondition) {
    const preset = NETWORK_PRESETS[args.networkCondition];
    if (!preset) return fail(`Unknown network condition: ${args.networkCondition}. Use: ${Object.keys(NETWORK_PRESETS).join(", ")}`);
    await ensureDomain(sess, "Network");
    await cdp("Network.emulateNetworkConditions", preset, sess);
    results.push(`Network: ${args.networkCondition}`);
  }

  if (args.ignoreSSL !== undefined) {
    await ensureDomain(sess, "Security");
    await cdp("Security.setIgnoreCertificateErrors", { ignore: args.ignoreSSL }, sess);
    results.push(`Ignore SSL: ${args.ignoreSSL}`);
  }

  if (args.blockUrls) {
    await ensureDomain(sess, "Network");
    await cdp("Network.setBlockedURLs", { urls: args.blockUrls }, sess);
    results.push(`Blocked URLs: ${args.blockUrls.length} pattern(s)`);
  }

  if (args.extraHeaders) {
    await ensureDomain(sess, "Network");
    await cdp("Network.setExtraHTTPHeaders", { headers: args.extraHeaders }, sess);
    results.push(`Extra headers: ${Object.keys(args.extraHeaders).join(", ")}`);
  }

  return ok(results.length ? results.join("\n") : "No emulation changes applied.");
}

// ─── Storage Handlers ───────────────────────────────────────────────

async function handleStorageGetCookies(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Network");
  const params = {};
  if (args.urls?.length) params.urls = args.urls;
  const { cookies } = await cdp("Network.getCookies", params, sess);

  if (!cookies?.length) return ok("No cookies found.");

  const lines = cookies.map(c => {
    const flags = [c.httpOnly && "HttpOnly", c.secure && "Secure", c.sameSite].filter(Boolean).join(", ");
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session";
    return `${c.name}=${c.value.substring(0, 60)}${c.value.length > 60 ? "..." : ""}\n  Domain: ${c.domain} | Path: ${c.path} | Expires: ${exp} | ${flags}`;
  });
  return ok(`${cookies.length} cookie(s):\n\n${lines.join("\n\n")}`);
}

async function handleStorageSetCookie(args) {
  if (!args.name || args.value === undefined) return fail("Provide 'name' and 'value'.");
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Network");

  const cookieParams = { name: args.name, value: args.value };
  if (args.domain) cookieParams.domain = args.domain;
  if (args.path) cookieParams.path = args.path;
  if (args.secure !== undefined) cookieParams.secure = args.secure;
  if (args.httpOnly !== undefined) cookieParams.httpOnly = args.httpOnly;
  if (args.sameSite) cookieParams.sameSite = args.sameSite;
  if (args.expires) cookieParams.expires = args.expires;

  // If no domain, get from current page
  if (!cookieParams.domain && !cookieParams.url) {
    const urlResult = await cdp("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sess);
    cookieParams.url = urlResult.result.value;
  }

  const { success } = await cdp("Network.setCookie", cookieParams, sess);
  return ok(success ? `Cookie set: ${args.name}=${args.value.substring(0, 40)}` : "Failed to set cookie.");
}

async function handleStorageDeleteCookies(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Network");

  const params = {};
  if (args.name) params.name = args.name;
  if (args.domain) params.domain = args.domain;
  if (args.url) params.url = args.url;

  if (!params.name) return fail("Provide 'name' to delete specific cookies.");
  // CDP requires at least url or domain
  if (!params.url && !params.domain) {
    const r = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
    const origin = r.result?.value;
    if (origin && origin !== "null") {
      params.url = origin;
      try { params.domain = new URL(origin).hostname; } catch { /* ok */ }
    }
  }
  await cdp("Network.deleteCookies", params, sess);
  return ok(`Deleted cookies matching: ${args.name}${args.domain ? ` (domain: ${args.domain})` : ""}`);
}

async function handleStorageClearCookies(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Network");
  await cdp("Network.clearBrowserCookies", {}, sess);
  return ok("All cookies cleared.");
}

async function handleStorageClearData(args) {
  const sess = await getTabSession(args.tabId);

  let origin = args.origin;
  if (!origin) {
    const r = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
    origin = r.result.value;
  }

  const storageTypes = args.types === "all"
    ? "cookies,local_storage,indexeddb,cache_storage,service_workers"
    : (args.types || "local_storage,indexeddb,cache_storage");

  await cdp("Storage.clearDataForOrigin", { origin, storageTypes }, sess);
  return ok(`Cleared storage for ${origin}: ${storageTypes}`);
}

async function handleStorageQuota(args) {
  const sess = await getTabSession(args.tabId);

  let origin;
  const r = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
  origin = r.result.value;

  const { usage, quota, usageBreakdown } = await cdp("Storage.getUsageAndQuota", { origin }, sess);

  const fmt = (b) => {
    if (b > 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
    if (b > 1048576) return `${(b / 1048576).toFixed(2)} MB`;
    if (b > 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  };

  let text = `Storage for ${origin}:\n  Usage: ${fmt(usage)} / ${fmt(quota)} (${(usage / quota * 100).toFixed(2)}%)`;
  if (usageBreakdown?.length) {
    text += "\n\nBreakdown:";
    for (const { storageType, usage: u } of usageBreakdown) {
      if (u > 0) text += `\n  ${storageType}: ${fmt(u)}`;
    }
  }
  return ok(text);
}

// ─── Intercept Handlers ─────────────────────────────────────────────

async function handleInterceptEnable(args) {
  const sess = await getTabSession(args.tabId);

  const patterns = (args.patterns || ["*"]).map(p => ({
    urlPattern: p,
    requestStage: "Request",
  }));

  await cdp("Fetch.enable", { patterns }, sess);

  // Initialize tracking maps
  if (!pendingFetchRequests.has(sess)) pendingFetchRequests.set(sess, new Map());
  if (!fetchRules.has(sess)) fetchRules.set(sess, []);

  return ok(`Request interception enabled.\nPatterns: ${patterns.map(p => p.urlPattern).join(", ")}\nPaused requests will auto-continue after 10s if not handled.`);
}

async function handleInterceptDisable(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Fetch.disable", {}, sess);
  pendingFetchRequests.delete(sess);
  fetchRules.delete(sess);
  return ok("Request interception disabled.");
}

async function handleInterceptContinue(args) {
  if (!args.requestId) return fail("Provide 'requestId'.");
  const sess = await getTabSession(args.tabId);

  const params = { requestId: args.requestId };
  if (args.url) params.url = args.url;
  if (args.method) params.method = args.method;
  if (args.postData) params.postData = Buffer.from(args.postData).toString("base64");
  if (args.headers) {
    params.headers = Object.entries(args.headers).map(([name, value]) => ({ name, value: String(value) }));
  }

  await cdp("Fetch.continueRequest", params, sess);

  const pending = pendingFetchRequests.get(sess);
  if (pending) pending.delete(args.requestId);

  return ok(`Request ${args.requestId} continued${args.url ? ` (redirected to ${args.url})` : ""}.`);
}

async function handleInterceptFulfill(args) {
  if (!args.requestId) return fail("Provide 'requestId'.");
  const sess = await getTabSession(args.tabId);

  const params = {
    requestId: args.requestId,
    responseCode: args.status || 200,
  };

  if (args.headers) {
    params.responseHeaders = Object.entries(args.headers).map(([name, value]) => ({ name, value: String(value) }));
  } else {
    params.responseHeaders = [{ name: "Content-Type", value: "application/json" }];
  }

  if (args.body !== undefined) {
    params.body = Buffer.from(args.body).toString("base64");
  }

  await cdp("Fetch.fulfillRequest", params, sess);

  const pending = pendingFetchRequests.get(sess);
  if (pending) pending.delete(args.requestId);

  return ok(`Request ${args.requestId} fulfilled with status ${params.responseCode}.`);
}

async function handleInterceptFail(args) {
  if (!args.requestId) return fail("Provide 'requestId'.");
  const sess = await getTabSession(args.tabId);

  const reason = args.reason || "Failed";
  await cdp("Fetch.failRequest", { requestId: args.requestId, reason }, sess);

  const pending = pendingFetchRequests.get(sess);
  if (pending) pending.delete(args.requestId);

  return ok(`Request ${args.requestId} failed with reason: ${reason}.`);
}

async function handleInterceptList(args) {
  const sess = await getTabSession(args.tabId);
  const pending = pendingFetchRequests.get(sess) || new Map();

  if (pending.size === 0) return ok("No pending intercepted requests.");

  const lines = Array.from(pending.values()).map(r => {
    const age = ((Date.now() - r.ts) / 1000).toFixed(1);
    return `[${r.requestId}] ${r.method} ${r.url.substring(0, 100)} (${r.resourceType}, ${age}s ago)`;
  });
  return ok(`${pending.size} pending request(s):\n\n${lines.join("\n")}`);
}

// ─── Cleanup Handlers ───────────────────────────────────────────────

async function handleCleanupDisconnectTab(args) {
  if (!args.tabId) return fail("Provide 'tabId'.");
  await detachTab(args.tabId);
  return ok("Detached from tab.");
}

async function handleCleanupDisconnectAll() {
  const ids = [...activeSessions.keys()];
  for (const id of ids) await detachTab(id);
  return ok(`Disconnected from ${ids.length} tab(s).`);
}

async function handleCleanupCleanTemp() {
  const n = cleanupTempFiles();
  return ok(`Cleaned up ${n} temp file(s) from ${TEMP_DIR}`);
}

async function handleCleanupStatus() {
  const tabs = await getTabs();
  const tabList = tabs.slice(0, 10).map(t => {
    const c = activeSessions.has(t.targetId) ? " [connected]" : "";
    return `  ${t.targetId}${c} — ${t.title || "(untitled)"}`;
  }).join("\n");
  const more = tabs.length > 10 ? `\n  ... and ${tabs.length - 10} more` : "";
  return ok(
    `Browser tabs: ${tabs.length}\n` +
    `Connected sessions: ${activeSessions.size}\n` +
    `Pending dialogs: ${[...pendingDialogs.values()].reduce((s, d) => s + d.length, 0)}\n` +
    `Pending intercepts: ${[...pendingFetchRequests.values()].reduce((s, m) => s + m.size, 0)}\n` +
    `Temp dir: ${TEMP_DIR}\n` +
    `Temp files: ${existsSync(TEMP_DIR) ? readdirSync(TEMP_DIR).length : 0}\n` +
    `\nRecent tabs:\n${tabList}${more}`
  );
}

// ═══════════════════════════════════════════════════════════════════
//  HANDLER DISPATCH MAP
// ═══════════════════════════════════════════════════════════════════

const HANDLERS = {
  tabs: {
    list: handleTabsList,
    find: handleTabsFind,
    new: handleTabsNew,
    close: handleTabsClose,
    activate: handleTabsActivate,
    info: handleTabsInfo,
  },
  page: {
    goto: handlePageGoto,
    back: handlePageBack,
    forward: handlePageForward,
    reload: handlePageReload,
    snapshot: handlePageSnapshot,
    screenshot: handlePageScreenshot,
    content: handlePageContent,
    wait: handlePageWait,
    pdf: handlePagePdf,
    dialog: handlePageDialog,
    inject: handlePageInject,
    bypass_csp: handlePageBypassCsp,
  },
  interact: {
    click: handleInteractClick,
    hover: handleInteractHover,
    type: handleInteractType,
    fill: handleInteractFill,
    select: handleInteractSelect,
    press: handleInteractPress,
    drag: handleInteractDrag,
    scroll: handleInteractScroll,
    upload: handleInteractUpload,
    focus: handleInteractFocus,
    check: handleInteractCheck,
  },
  execute: {
    eval: handleExecuteEval,
    script: handleExecuteScript,
    call: handleExecuteCall,
  },
  observe: {
    console: handleObserveConsole,
    network: handleObserveNetwork,
    request: handleObserveRequest,
    performance: handleObservePerformance,
  },
  emulate: handleEmulate,
  storage: {
    get_cookies: handleStorageGetCookies,
    set_cookie: handleStorageSetCookie,
    delete_cookies: handleStorageDeleteCookies,
    clear_cookies: handleStorageClearCookies,
    clear_data: handleStorageClearData,
    quota: handleStorageQuota,
  },
  intercept: {
    enable: handleInterceptEnable,
    disable: handleInterceptDisable,
    continue: handleInterceptContinue,
    fulfill: handleInterceptFulfill,
    fail: handleInterceptFail,
    list: handleInterceptList,
  },
  cleanup: {
    disconnect_tab: handleCleanupDisconnectTab,
    disconnect_all: handleCleanupDisconnectAll,
    clean_temp: handleCleanupCleanTemp,
    status: handleCleanupStatus,
  },
};

async function handleTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool: ${name}`);

  // Single-function handler (emulate)
  if (typeof handler === "function") return handler(args);

  // Action-based dispatch
  const action = args.action;
  if (!action) return fail(`Missing 'action' parameter for tool '${name}'.`);
  const fn = handler[action];
  if (!fn) return fail(`Unknown action '${action}' for tool '${name}'. Available: ${Object.keys(handler).join(", ")}`);
  return fn(args);
}

// ─── MCP Server Setup ───────────────────────────────────────────────

const server = new Server(
  { name: "cdp-browser", version: "3.0.0" },
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
