#!/usr/bin/env node

/**
 * CDP Browser Automation — MCP Server  v4.1
 *
 * 9 consolidated tools with ~50 sub-actions for full browser automation.
 * v4 upgrades: stable element refs (backendNodeId), auto-waiting, incremental snapshots,
 * per-agent session isolation, framework-aware inputs, modal guards, rich tool descriptions,
 * auto-console-error reporting, connection health monitoring, download tracking.
 *
 * Tools:
 *   tabs      — Tab lifecycle (list, find, new, close, activate, info)
 *   page      — Navigation, snapshot, screenshot, content, wait, PDF, dialog, inject, CSP bypass
 *   interact  — Click, hover, type, fill, select, press, drag, scroll, upload, focus, check
 *   execute   — JS eval, script, call-on-element
 *   observe   — Console, network, request body, performance metrics, downloads
 *   emulate   — Viewport, color, UA, geo, CPU, timezone, locale, vision, network, SSL, etc.
 *   storage   — Cookies, localStorage, indexedDB, cache, quota
 *   intercept — HTTP request interception, mocking, blocking via Fetch domain
 *   cleanup   — Disconnect sessions, clean temp files, status, list_sessions
 *
 * Setup:  chrome://flags/#enable-remote-debugging → Enabled → Relaunch
 *
 * Env vars:
 *   CDP_PORT          Chrome debugging port        (default: 9222)
 *   CDP_HOST          Chrome debugging host        (default: 127.0.0.1)
 *   CDP_TIMEOUT       Command timeout in ms        (default: 30000)
 *   CDP_SESSION_TTL   Agent session TTL in ms      (default: 300000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Config ─────────────────────────────────────────────────────────

const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = process.env.CDP_PORT || "9222";
const CDP_TIMEOUT = parseInt(process.env.CDP_TIMEOUT || "30000");
const SESSION_TTL = parseInt(process.env.CDP_SESSION_TTL) || 300000;
const LONG_TIMEOUT = 120_000;
const MAX_INLINE_LEN = 60_000;
const TEMP_DIR = join(tmpdir(), ".cdp-mcp");

// ─── Temp File Management ───────────────────────────────────────────

function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function writeTempFile(name, content, encoding = "utf8") {
  ensureTempDir();
  autoCleanupTempFiles();
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

const MAX_TEMP_FILES = 50;
const MAX_TEMP_AGE_MS = 30 * 60 * 1000; // 30 minutes

function autoCleanupTempFiles() {
  if (!existsSync(TEMP_DIR)) return;
  const files = readdirSync(TEMP_DIR);
  if (files.length <= MAX_TEMP_FILES) return;
  // Sort by creation time and remove oldest
  const withStats = files.map(f => {
    const p = join(TEMP_DIR, f);
    try { return { path: p, mtime: statSync(p).mtimeMs }; } catch { return null; }
  }).filter(Boolean);
  withStats.sort((a, b) => a.mtime - b.mtime);
  // Remove files until we're at half the limit, OR remove files older than MAX_TEMP_AGE_MS
  const now = Date.now();
  let remaining = files.length;
  for (const { path, mtime } of withStats) {
    if (remaining <= MAX_TEMP_FILES / 2 && now - mtime < MAX_TEMP_AGE_MS) break;
    try { unlinkSync(path); remaining--; } catch {}
  }
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
const refMaps = new Map();              // sessionId → Map<uid, backendNodeId>
const lastSnapshots = new Map();        // sessionId → { snapshot, url, title }
const agentSessions = new Map();        // agentSessionId → { lastActivity, tabIds: Set<tabId> }
const processSessionId = randomUUID();  // auto-assigned per-process session ID

const downloads = new Map();              // sessionId → [{guid, url, suggestedFilename, state, receivedBytes, totalBytes}]

const NO_ENABLE = new Set(["Input", "Target", "Browser", "Accessibility", "DOM", "Emulation", "Storage"]);

// ─── Connection Health ──────────────────────────────────────────────

let connectionHealth = { status: "disconnected", lastPing: null, lastPong: null, failures: 0 };
let healthCheckTimer = null;

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
    browserWs.once("open", () => { startHealthCheck(); resolve(); });
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
      refMaps.clear();
      lastSnapshots.clear();
      downloads.clear();
      browserWs = null;
      stopHealthCheck();
    });
  });
}

// ─── Connection Health Check ────────────────────────────────────────

function startHealthCheck() {
  stopHealthCheck();
  connectionHealth = { status: "connected", lastPing: null, lastPong: null, failures: 0 };
  healthCheckTimer = setInterval(() => {
    if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
      connectionHealth.status = "disconnected";
      return;
    }
    connectionHealth.lastPing = Date.now();
    let pongReceived = false;
    const pongHandler = () => { pongReceived = true; connectionHealth.lastPong = Date.now(); connectionHealth.failures = 0; connectionHealth.status = "connected"; };
    browserWs.once("pong", pongHandler);
    try { browserWs.ping(); } catch { connectionHealth.status = "error"; return; }
    setTimeout(() => {
      if (!pongReceived) {
        connectionHealth.failures++;
        connectionHealth.status = "unhealthy";
        browserWs.removeListener("pong", pongHandler);
        if (connectionHealth.failures >= 2) {
          connectionHealth.status = "dead";
          try { browserWs.terminate(); } catch { /* ok */ }
          browserWs = null;
        }
      }
    }, 5000);
  }, 30000);
}

function stopHealthCheck() {
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
  connectionHealth.status = "disconnected";
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

  // ── Download tracking ──
  if (method === "Page.downloadWillBegin") {
    const dl = downloads.get(sessionId) || [];
    dl.push({
      guid: params.guid,
      url: params.url,
      suggestedFilename: params.suggestedFilename || "unknown",
      state: "inProgress",
      receivedBytes: 0,
      totalBytes: 0,
      ts: Date.now(),
    });
    if (dl.length > 100) dl.splice(0, dl.length - 100);
    downloads.set(sessionId, dl);
  }
  if (method === "Page.downloadProgress") {
    const dl = downloads.get(sessionId);
    if (dl) {
      const entry = dl.find(d => d.guid === params.guid);
      if (entry) {
        entry.receivedBytes = params.receivedBytes || 0;
        entry.totalBytes = params.totalBytes || 0;
        entry.state = params.state || entry.state; // inProgress, completed, canceled
      }
    }
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
  refMaps.delete(sid);
  lastSnapshots.delete(sid);
  downloads.delete(sid);
  // Remove tabId from all agent sessions to prevent stale references
  for (const [, agentSession] of agentSessions) {
    agentSession.tabIds.delete(tabId);
  }
}

// ─── Tab Listing ────────────────────────────────────────────────────

async function getTabs() {
  await connectBrowser();
  const { targetInfos } = await cdp("Target.getTargets", { filter: [{ type: "page" }] });
  return targetInfos || [];
}

// ─── Accessibility Tree / Snapshot ──────────────────────────────────

function collectFrameIds(frameTree) {
  const ids = [frameTree.frame.id];
  if (frameTree.childFrames) {
    for (const child of frameTree.childFrames) {
      ids.push(...collectFrameIds(child));
    }
  }
  return ids;
}

async function buildSnapshot(sessionId) {
  await ensureDomain(sessionId, "Accessibility");

  // Get frame tree for iframe support
  let frameIds = [];
  try {
    await ensureDomain(sessionId, "Page");
    const { frameTree } = await cdp("Page.getFrameTree", {}, sessionId);
    frameIds = collectFrameIds(frameTree);
  } catch {
    // Can't get frame tree — use root frame only (getFullAXTree without frameId)
    frameIds = [null];
  }

  const newRefMap = new Map(); // ref (number) → backendDOMNodeId
  let refCounter = 0;
  let allLines = [];

  for (const frameId of frameIds) {
    try {
      const params = {};
      if (frameId) params.frameId = frameId;
      const { nodes } = await cdp("Accessibility.getFullAXTree", params, sessionId);
      if (!nodes || nodes.length === 0) continue;

      // Build node lookup
      const nodeMap = new Map();
      for (const n of nodes) nodeMap.set(n.nodeId, n);

      // Find root nodes (no parentId or parent not in this set)
      const roots = nodes.filter(n => !n.parentId || !nodeMap.has(n.parentId));

      // Prefix for sub-frames
      const frameIndex = frameIds.indexOf(frameId);
      const prefix = frameIndex > 0 ? `[frame ${frameIndex}] ` : "";

      function renderNode(node, depth) {
        if (node.ignored) {
          // Still process children of ignored nodes (they may contain non-ignored content)
          const children = (node.childIds || []).map(id => nodeMap.get(id)).filter(Boolean);
          return children.map(c => renderNode(c, depth)).filter(Boolean).join("\n");
        }

        const role = node.role?.value;
        if (!role || role === "none" || role === "GenericContainer" || role === "InlineTextBox") {
          // Skip generic containers but recurse into children
          const children = (node.childIds || []).map(id => nodeMap.get(id)).filter(Boolean);
          return children.map(c => renderNode(c, depth)).filter(Boolean).join("\n");
        }

        const ref = ++refCounter;
        if (node.backendDOMNodeId) {
          newRefMap.set(ref, node.backendDOMNodeId);
        }

        const indent = "  ".repeat(depth);
        const name = node.name?.value || "";
        const nameStr = name ? ` "${name.replace(/[\n\r"\\]/g, " ").trim().substring(0, 120)}"` : "";

        // Collect properties
        const props = [];
        if (node.properties) {
          for (const p of node.properties) {
            const val = p.value?.value;
            if (val === undefined || val === null) continue;
            switch (p.name) {
              case "disabled": if (val) props.push("disabled"); break;
              case "checked": if (val === "true" || val === true) props.push("checked"); else if (val === "mixed") props.push("mixed"); break;
              case "expanded": props.push(val ? "expanded" : "collapsed"); break;
              case "selected": if (val) props.push("selected"); break;
              case "required": if (val) props.push("required"); break;
              case "readonly": if (val) props.push("readonly"); break;
              case "focused": if (val) props.push("focused"); break;
              case "pressed": if (val === "true" || val === true) props.push("pressed"); break;
              case "level": props.push("level=" + val); break;
              case "valuetext": props.push("value=" + JSON.stringify(String(val).substring(0, 80))); break;
              case "hasPopup": if (val && val !== "false") props.push("haspopup=" + val); break;
              case "autocomplete": if (val && val !== "none") props.push("autocomplete=" + val); break;
              case "modal": if (val) props.push("modal"); break;
              case "multiselectable": if (val) props.push("multiselectable"); break;
              case "orientation": if (val !== "none") props.push("orientation=" + val); break;
            }
          }
        }

        // Add value for inputs
        if (node.value?.value !== undefined && node.value.value !== "") {
          const v = String(node.value.value).substring(0, 80);
          if (!props.some(p => p.startsWith("value="))) {
            props.push("value=" + JSON.stringify(v));
          }
        }

        const propStr = props.length ? " [" + props.join(", ") + "]" : "";
        let line = `${indent}${prefix}- ${role}${nameStr}${propStr} [ref=${ref}]`;

        // Process children
        const children = (node.childIds || []).map(id => nodeMap.get(id)).filter(Boolean);
        const childLines = children.map(c => renderNode(c, depth + 1)).filter(Boolean);

        if (childLines.length > 0) {
          return line + "\n" + childLines.join("\n");
        }
        return line;
      }

      for (const root of roots) {
        const rendered = renderNode(root, 0);
        if (rendered) allLines.push(rendered);
      }
    } catch (e) {
      // If a sub-frame fails, continue with others
      if (frameId) allLines.push(`  - [frame error: ${e.message?.substring(0, 60)}]`);
    }
  }

  // Update ref map
  refMaps.set(sessionId, newRefMap);

  const snapshot = allLines.join("\n");

  // Get page metadata
  let url = "", title = "";
  try {
    const meta = await cdp("Runtime.evaluate", {
      expression: `({ url: location.href, title: document.title })`,
      returnByValue: true,
    }, sessionId);
    url = meta.result?.value?.url || "";
    title = meta.result?.value?.title || "";
  } catch {}

  return { snapshot, count: refCounter, url, title };
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

// ─── Auto-Waiting (Playwright-inspired) ─────────────────────────────

/**
 * Wraps an action callback and waits for triggered network activity to settle.
 * Detects XHR/fetch/navigation requests fired by the action and waits for them to complete.
 * @param {string} sessionId - CDP session ID
 * @param {Function} actionFn - async function performing the action
 * @param {object} [opts] - options: { timeout: 5000 }
 * @returns {Promise<{result: any, networkEvents: string[]}>} action result + network events
 */
async function waitForCompletion(sessionId, actionFn, opts = {}) {
  const timeout = opts.timeout || 5000;
  const pendingRequests = new Map(); // requestId → { url, method, type, ts }
  const completedEvents = [];
  let navigationDetected = false;

  // Ensure network monitoring is active
  await enableMonitoring(sessionId, "network");

  // Snapshot current network request count to detect new ones
  const reqMap = networkReqs.get(sessionId) || new Map();
  const prevRequestIds = new Set(reqMap.keys());

  // Execute the action
  const result = await actionFn();

  // Wait a brief moment for triggered requests to start
  await sleep(150);

  // Collect new requests that appeared since the action
  const currentReqMap = networkReqs.get(sessionId) || new Map();
  for (const [reqId, req] of currentReqMap) {
    if (!prevRequestIds.has(reqId) && !req.status) {
      pendingRequests.set(reqId, req);
      if ((req.type || "").toLowerCase() === "document") {
        navigationDetected = true;
      }
    }
  }

  // If navigation detected, wait for page load (up to 10s)
  if (navigationDetected) {
    const navTimeout = Math.min(timeout * 2, 10000);
    const start = Date.now();
    while (Date.now() - start < navTimeout) {
      try {
        const r = await cdp("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        }, sessionId, 3000);
        if (r.result.value === "complete") break;
      } catch { /* page transitioning */ }
      await sleep(300);
    }
    completedEvents.push("[NAV] Page navigation detected and loaded");
  }

  // Wait for pending XHR/fetch requests to complete (up to timeout)
  if (pendingRequests.size > 0) {
    const start = Date.now();
    while (Date.now() - start < timeout && pendingRequests.size > 0) {
      const updatedMap = networkReqs.get(sessionId) || new Map();
      for (const [reqId, req] of pendingRequests) {
        const updated = updatedMap.get(reqId);
        if (updated?.status) {
          completedEvents.push(`[${(updated.type || "XHR").toUpperCase()}] ${updated.method} ${updated.url.substring(0, 80)} → ${updated.status}`);
          pendingRequests.delete(reqId);
        }
      }
      if (pendingRequests.size > 0) await sleep(100);
    }

    // Report timed-out requests
    for (const [, req] of pendingRequests) {
      completedEvents.push(`[PENDING] ${req.method} ${req.url.substring(0, 80)} (still loading)`);
    }
  }

  // Extra settling pause if any network activity occurred
  if (completedEvents.length > 0) {
    await sleep(200);
  }

  return { result, networkEvents: completedEvents };
}

/**
 * Check element actionability: visible, enabled, stable position, non-zero size.
 * Returns the element info or throws a descriptive error.
 */
async function checkActionability(sessionId, uid, selector) {
  const el = await resolveElement(sessionId, uid, selector);

  // Check non-zero size
  if (el.w <= 0 || el.h <= 0) {
    throw new Error(`Element <${el.tag}> "${el.label}" has zero size (${el.w}x${el.h}) — it may be hidden or inside a collapsed section. Try scrolling to the element or expanding its parent container.`);
  }

  // Check actionability via backendNodeId or selector
  let objectId;
  if (uid !== undefined && uid !== null) {
    const map = refMaps.get(sessionId);
    const backendNodeId = map?.get(uid);
    if (backendNodeId) {
      try {
        const { object } = await cdp("DOM.resolveNode", { backendNodeId }, sessionId);
        objectId = object?.objectId;
      } catch {}
    }
  }
  if (!objectId && selector) {
    const finder = elementFinderExpr(selector);
    const res = await cdp("Runtime.evaluate", { expression: finder, returnByValue: false }, sessionId);
    objectId = res.result?.objectId;
  }

  if (objectId) {
    const checks = await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() {
        if (this.disabled) return { error: "Element <" + this.tagName.toLowerCase() + "> '" + (this.getAttribute("aria-label") || this.textContent || "").trim().substring(0, 40) + "' is disabled — wait for it to become enabled or check if a prerequisite action is needed." };
        const s = getComputedStyle(this);
        if (s.visibility === "hidden" || s.display === "none") return { error: "Element is not visible (display: " + s.display + ", visibility: " + s.visibility + ") — it may be inside a collapsed section or behind a modal. Try dismissing overlays or expanding parent containers." };
        if (parseFloat(s.opacity) === 0) return { error: "Element has opacity: 0 — it may be hidden or animating in. Wait briefly and retry, or check for overlays." };
        if (s.pointerEvents === "none") return { error: "Element has pointer-events: none — it cannot be clicked. It may be covered by an overlay. Try dismissing modals or interacting with a parent element." };
        return { ok: true };
      }`,
      objectId,
      returnByValue: true,
    }, sessionId);
    const v = checks.result?.value;
    if (v?.error) throw new Error(v.error);
  }

  // Hit-test: verify no other element is covering the click target
  try {
    await cdp("Runtime.evaluate", {
      expression: `(() => {
        const el = document.elementFromPoint(${Math.round(el.x)}, ${Math.round(el.y)});
        if (!el) return { clear: true };
        return { tag: el.tagName.toLowerCase(), class: el.className?.toString?.()?.substring(0, 60) || "" };
      })()`,
      returnByValue: true,
    }, sessionId);
    // We don't block on hit-test mismatch — just provide info
  } catch {}

  return el;
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

// ─── Element Resolution (stable backendNodeId refs) ─────────────────

/** Build a JS expression that finds an element by CSS selector, piercing shadow DOM */
function elementFinderExpr(selector) {
  if (!selector) throw new Error("Provide a CSS 'selector' or take a snapshot and use 'uid' (ref number).");
  return `(() => {
    function deepQuery(root, sel) {
      const el = root.querySelector(sel);
      if (el) return el;
      for (const s of root.querySelectorAll('*')) {
        if (s.shadowRoot) {
          const found = deepQuery(s.shadowRoot, sel);
          if (found) return found;
        }
      }
      return null;
    }
    return deepQuery(document, ${JSON.stringify(selector)});
  })()`;
}

async function resolveElement(sessionId, uid, selector) {
  // Primary path: backendNodeId resolution (works for uid from snapshots)
  if (uid !== undefined && uid !== null) {
    const map = refMaps.get(sessionId);
    const backendNodeId = map?.get(uid);
    if (backendNodeId) {
      try {
        const { object } = await cdp("DOM.resolveNode", { backendNodeId }, sessionId);
        if (object?.objectId) {
          const result = await cdp("Runtime.callFunctionOn", {
            functionDeclaration: `function() {
              this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
              const r = this.getBoundingClientRect();
              return {
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
                tag: this.tagName.toLowerCase(),
                label: (this.getAttribute("aria-label") || this.textContent || "").trim().substring(0, 60),
                w: r.width, h: r.height,
              };
            }`,
            objectId: object.objectId,
            returnByValue: true,
          }, sessionId);
          if (!result.exceptionDetails && result.result.value) {
            return result.result.value;
          }
        }
      } catch {
        // backendNodeId stale — fall through
      }
    }
    // uid lookup failed — no CSS fallback since we don't set data-cdp-ref anymore
    throw new Error(`Element ref=${uid} not found — the page may have changed since the last snapshot. Take a new snapshot with page tool, action: snapshot.`);
  }

  // CSS selector path (with shadow DOM piercing)
  if (!selector) throw new Error("Provide either 'uid' (from snapshot ref) or 'selector' (CSS).");
  const finder = elementFinderExpr(selector);
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = ${finder};
      if (!el) return { error: "Element not found (" + ${JSON.stringify(selector)} + ")" };
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
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description || "Element resolution failed") + " — take a new snapshot with page tool, action: snapshot.");
  const v = result.result.value;
  if (v?.error) throw new Error(v.error);
  return v;
}

/** Resolve uid/selector to a remote JS object ID (for callFunctionOn, etc.) */
async function resolveElementObjectId(sessionId, uid, selector) {
  // Primary path: backendNodeId resolution
  if (uid !== undefined && uid !== null) {
    const map = refMaps.get(sessionId);
    const backendNodeId = map?.get(uid);
    if (backendNodeId) {
      try {
        const { object } = await cdp("DOM.resolveNode", { backendNodeId }, sessionId);
        if (object?.objectId) {
          // Scroll into view
          await cdp("Runtime.callFunctionOn", {
            functionDeclaration: `function() { this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }`,
            objectId: object.objectId,
          }, sessionId);
          return object.objectId;
        }
      } catch {
        // backendNodeId stale — fall through
      }
    }
    throw new Error(`Element ref=${uid} not found — the page may have changed since the last snapshot. Take a new snapshot with page tool, action: snapshot.`);
  }

  // CSS selector path (with shadow DOM piercing)
  if (!selector) throw new Error("Provide either 'uid' (from snapshot ref) or 'selector' (CSS).");
  const finder = elementFinderExpr(selector);
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = ${finder};
      if (!el) throw new Error("Element not found (" + ${JSON.stringify(selector)} + ") — provide a valid CSS selector or take a snapshot first.");
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return el;
    })()`,
    returnByValue: false,
  }, sessionId);
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description || "Element resolution failed") + " — take a new snapshot with page tool, action: snapshot.");
  return result.result.objectId;
}

// ─── Tool Definitions (9 tools) ─────────────────────────────────────

const TOOLS = [
  // ── 1. tabs ──
  {
    name: "tabs",
    description: [
      "Manage browser tabs: list, search, create, close, activate, and inspect tabs.",
      "",
      "Operations:",
      "- list: List all open browser tabs with their IDs, URLs, and titles",
      "- find: Search tabs by title or URL substring (requires: query)",
      "- new: Open a new tab (optional: url — defaults to about:blank)",
      "- close: Close a specific tab (requires: tabId)",
      "- activate: Bring a tab to the foreground (requires: tabId)",
      "- info: Get detailed info about a tab including URL, title, and connection status (requires: tabId)",
    ].join("\n"),
    annotations: {
      title: "Browser Tabs",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "find", "new", "close", "activate", "info"], description: "Tab action to perform." },
        query: { type: "string", description: "Search text for 'find' action." },
        tabId: { type: "string", description: "Tab ID for close/activate/info." },
        url: { type: "string", description: "URL for 'new' action." },
        showAll: { type: "boolean", description: "Show all browser tabs, not just session-owned ones (for list action)." },
        sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." },
      },
      required: ["action"],
    },
  },

  // ── 2. page ──
  {
    name: "page",
    description: [
      "Page-level operations: navigation, accessibility snapshots, screenshots, content extraction, waiting, PDF export, dialog handling, script injection, and CSP bypass.",
      "",
      "Operations:",
      "- goto: Navigate to a URL and wait for page load (requires: tabId, url)",
      "- back: Navigate back in browser history (requires: tabId)",
      "- forward: Navigate forward in browser history (requires: tabId)",
      "- reload: Reload the current page (requires: tabId; optional: ignoreCache)",
      "- snapshot: Capture accessibility tree snapshot with element refs for interaction (requires: tabId)",
      "- screenshot: Take a screenshot of the page or a specific element (requires: tabId; optional: fullPage, quality, uid)",
      "- content: Extract text or HTML content from the page or an element (requires: tabId; optional: uid, selector, format[text|html])",
      "- wait: Wait for text to appear/disappear, a CSS selector to match, or a fixed delay (requires: tabId; provide one of: text, textGone, selector, or time; optional: timeout)",
      "- pdf: Export page as PDF to temp file (requires: tabId; optional: landscape, scale, paperWidth, paperHeight, margin{top,bottom,left,right})",
      "- dialog: Handle a pending JavaScript dialog (alert/confirm/prompt) (requires: tabId; optional: accept[default:true], text for prompt response)",
      "- inject: Inject a script that runs on every new document load (requires: tabId, script)",
      "- bypass_csp: Enable/disable Content Security Policy bypass (requires: tabId; optional: enabled[default:true])",
      "",
      "Notes:",
      "- Always take a snapshot before interacting with elements — it provides uid refs needed by interact tools",
      "- The snapshot returns an accessibility tree with roles, names, and properties matching ARIA semantics",
      "- Wait actions poll every 300ms up to the timeout (default: 10s)
      - The 'time' param is in SECONDS (e.g. time: 3 = 3 seconds). Max 60 seconds. Values over 60 are treated as milliseconds and auto-converted
      - The 'timeout' param is in MILLISECONDS — it caps how long to poll for text/selector conditions (default: 10000ms = 10s)",
    ].join("\n"),
    annotations: {
      title: "Page Operations",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
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
        time: { type: "number", description: "Fixed wait time in SECONDS (e.g. 3 = 3 seconds, NOT milliseconds). Max 60s. Values >60 are auto-converted from ms." },
        timeout: { type: "number", description: "Max polling timeout in milliseconds for text/selector waits (default: 10000ms). Not used with 'time'." },
        accept: { type: "boolean", description: "Accept (true) or dismiss (false) dialog." },
        landscape: { type: "boolean", description: "PDF landscape orientation." },
        scale: { type: "number", description: "PDF scale factor." },
        paperWidth: { type: "number", description: "PDF paper width in inches." },
        paperHeight: { type: "number", description: "PDF paper height in inches." },
        margin: { type: "object", description: "PDF margins {top, bottom, left, right} in inches.", properties: { top: { type: "number" }, bottom: { type: "number" }, left: { type: "number" }, right: { type: "number" } } },
        script: { type: "string", description: "Script for inject action." },
        enabled: { type: "boolean", description: "Enable/disable for bypass_csp." },
        sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 3. interact ──
  {
    name: "interact",
    description: [
      "Element interaction: click, hover, type text, fill forms, select dropdown options, press keys, drag & drop, scroll, upload files, focus elements, and toggle checkboxes.",
      "",
      "Operations:",
      "- click: Click an element (requires: tabId, uid or selector; optional: button[left|right|middle], clickCount — use 2 for double-click)",
      "- hover: Hover over an element to trigger tooltips or menus (requires: tabId, uid or selector)",
      "- type: Type text into a focused input field (requires: tabId, text, uid or selector; optional: clear[default:true] — clears field first, submit — press Enter after typing)",
      "- fill: Fill multiple form fields in one call (requires: tabId, fields — array of {uid or selector, value, type[text|checkbox|radio|select]})",
      "- select: Select an option from a <select> dropdown by value or visible text (requires: tabId, value, uid or selector)",
      "- press: Press a keyboard key with optional modifiers (requires: tabId, key; optional: modifiers[Ctrl|Shift|Alt|Meta])",
      "- drag: Drag an element to another element (requires: tabId, sourceUid or sourceSelector, targetUid or targetSelector)",
      "- scroll: Scroll the page or a specific element (requires: tabId; optional: direction[up|down|left|right], amount[default:400px], x, y for absolute scroll, uid or selector for scrolling within an element)",
      "- upload: Upload files to a file input (requires: tabId, files — array of absolute file paths, uid or selector)",
      "- focus: Focus an element and scroll it into view (requires: tabId, uid or selector)",
      "- check: Set a checkbox to checked or unchecked (requires: tabId, checked[true|false], uid or selector)",
      "",
      "Element Resolution: Provide either 'uid' (from a snapshot) or 'selector' (CSS selector). UIDs are preferred — they come from the accessibility snapshot and map to visible, interactive elements.",
      "",
      "Keys for press: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space, F1-F12, Insert",
    ].join("\n"),
    annotations: {
      title: "Element Interaction",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
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
        sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 4. execute ──
  {
    name: "execute",
    description: [
      "Execute JavaScript code on the page in three modes: inline expression evaluation, async script execution, and calling a function on a specific element.",
      "",
      "Operations:",
      "- eval: Evaluate a JavaScript expression and return its value (requires: tabId, expression)",
      "- script: Execute an async function body wrapped in an IIFE — use for multi-step JS logic (requires: tabId, code)",
      "- call: Call a JavaScript function with a specific page element as its argument (requires: tabId, function — e.g. '(el) => el.textContent', uid or selector)",
      "",
      "Notes:",
      "- eval returns the expression's value directly (must be JSON-serializable)",
      "- script wraps your code in: (async () => { <your code> })() — use 'return' to send a value back",
      "- call resolves the element first, then passes it as the first argument to your function",
    ].join("\n"),
    annotations: {
      title: "Execute JavaScript",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
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
        sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 5. observe ──
  {
    name: "observe",
    description: [
      "Monitor browser console messages, network requests, retrieve full request/response bodies, and measure page performance metrics.",
      "",
      "Operations:",
      "- console: Retrieve captured console messages (requires: tabId; optional: level[all|error|warning|log|info|debug], last — return only last N entries, clear — clear after returning)",
      "- network: List captured network requests with URLs, methods, status codes, and timing (requires: tabId; optional: filter — URL substring, types — resource type filter array, last, clear)",
      "- request: Get the full request and response body for a specific network request (requires: tabId, requestId — from network listing)",
      "- performance: Collect page performance metrics including DOM size, JS heap, layout counts, and paint timing (requires: tabId)",
      "- downloads: List tracked file downloads with progress info (requires: tabId; optional: last, clear)",
      "",
      "Network Resource Types: xhr, fetch, document, script, stylesheet, image, font, media, websocket, other",
      "",
      "Notes:",
      "- Console and network monitoring starts automatically when first queried — no explicit enable needed",
      "- Use 'clear: true' to reset captured data between test iterations",
    ].join("\n"),
    annotations: {
      title: "Observe Browser",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["console", "network", "request", "performance", "downloads"], description: "Observe action." },
        tabId: { type: "string", description: "Tab ID." },
        level: { type: "string", enum: ["all", "error", "warning", "log", "info", "debug"], description: "Console level filter." },
        filter: { type: "string", description: "Network URL filter." },
        types: { type: "array", items: { type: "string" }, description: "Network resource types filter: xhr, fetch, document, script, stylesheet, image, font, media, websocket, other." },
        clear: { type: "boolean", description: "Clear captured data after returning." },
        last: { type: "number", description: "Return only last N items." },
        requestId: { type: "string", description: "Request ID for full body retrieval." },
        sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 6. emulate ──
  {
    name: "emulate",
    description: [
      "Emulate device characteristics and network conditions: viewport size, color scheme, user agent, geolocation, CPU throttle, timezone, locale, vision deficiency simulation, network throttling, SSL bypass, URL blocking, and custom headers. Pass 'reset: true' to clear all overrides.",
      "",
      "Operations (set any combination of properties in a single call):",
      "- viewport: Set viewport dimensions (optional: {width, height, deviceScaleFactor, mobile, touch, landscape})",
      "- colorScheme: Emulate preferred color scheme (optional: dark|light|auto)",
      "- userAgent: Override the browser user agent string (optional: string)",
      "- geolocation: Spoof geolocation (optional: {latitude, longitude, accuracy, altitude})",
      "- cpuThrottle: Throttle CPU speed — 1 = normal, 4 = 4x slower (optional: number)",
      "- timezone: Override timezone (optional: string, e.g. 'America/New_York')",
      "- locale: Override locale (optional: string, e.g. 'fr-FR')",
      "- visionDeficiency: Simulate vision impairment (optional: none|protanopia|deuteranopia|tritanopia|achromatopsia|blurredVision)",
      "- autoDarkMode: Force automatic dark mode (optional: boolean)",
      "- idle: Emulate idle/locked screen state (optional: active|locked)",
      "- networkCondition: Throttle network speed (optional: offline|slow3g|fast3g|slow4g|fast4g|none)",
      "- ignoreSSL: Bypass SSL certificate errors (optional: boolean)",
      "- blockUrls: Block requests matching URL patterns (optional: string array)",
      "- extraHeaders: Set extra HTTP headers on all requests (optional: object)",
      "- reset: Clear ALL emulation overrides (optional: true)",
      "",
      "Network Presets: offline (no connection), slow3g (2s latency, 50KB/s), fast3g (562ms, 180KB/s), slow4g (150ms, 400KB/s), fast4g (50ms, 1.5MB/s), none (remove throttling)",
    ].join("\n"),
    annotations: {
      title: "Device Emulation",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        viewport: { type: "object", description: "Viewport {width, height, deviceScaleFactor, mobile, touch, landscape}.", properties: { width: { type: "number" }, height: { type: "number" }, deviceScaleFactor: { type: "number" }, mobile: { type: "boolean" }, touch: { type: "boolean" }, landscape: { type: "boolean" } } },
        colorScheme: { type: "string", enum: ["dark", "light", "auto"], description: "Color scheme." },
        userAgent: { type: "string", description: "User agent string." },
        geolocation: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" }, accuracy: { type: "number", description: "GPS accuracy in meters (default: 100)." }, altitude: { type: "number", description: "Altitude in meters (optional)." } }, description: "Spoof geolocation: {latitude, longitude, accuracy?, altitude?}." },
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
        sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." },
      },
      required: ["tabId"],
    },
  },

  // ── 7. storage ──
  {
    name: "storage",
    description: [
      "Cookie and storage management: get, set, and delete cookies, clear browser storage, and check storage quota.",
      "",
      "Operations:",
      "- get_cookies: Retrieve cookies (requires: tabId; optional: urls — filter by URLs)",
      "- set_cookie: Set a cookie (requires: tabId, name, value; optional: domain, path, secure, httpOnly, sameSite[None|Lax|Strict], expires — epoch seconds)",
      "- delete_cookies: Delete specific cookies by name (requires: tabId, name; optional: url, domain, path)",
      "- clear_cookies: Clear all cookies for the browser profile (requires: tabId)",
      "- clear_data: Clear browser storage for an origin (requires: tabId; optional: origin, types — comma-separated: 'cookies,local_storage,indexeddb,cache_storage' or 'all')",
      "- quota: Check storage quota usage for the current page's origin (requires: tabId)",
    ].join("\n"),
    annotations: {
      title: "Cookie & Storage",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
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
        sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 8. intercept ──
  {
    name: "intercept",
    description: [
      "HTTP request interception via CDP Fetch domain. Intercept, modify, mock, or block network requests in real-time.",
      "",
      "Operations:",
      "- enable: Start intercepting requests matching URL patterns (requires: tabId; optional: patterns — array of URL glob patterns, e.g. ['*.api.example.com/*'])",
      "- disable: Stop all request interception (requires: tabId)",
      "- continue: Resume a paused request, optionally modifying it (requires: tabId, requestId; optional: url, method, headers, postData)",
      "- fulfill: Respond to a paused request with a custom/mocked response (requires: tabId, requestId; optional: status, body, headers)",
      "- fail: Abort a paused request with a network error (requires: tabId, requestId; optional: reason)",
      "- list: List all currently paused/intercepted requests (requires: tabId)",
      "",
      "Failure Reasons: Failed, Aborted, TimedOut, AccessDenied, ConnectionClosed, ConnectionReset, ConnectionRefused, ConnectionAborted, ConnectionFailed, NameNotResolved, InternetDisconnected, AddressUnreachable, BlockedByClient, BlockedByResponse",
      "",
      "Notes:",
      "- Call 'enable' first with URL patterns to start intercepting",
      "- Intercepted requests are paused until you call continue, fulfill, or fail",
      "- Each intercepted request has a unique requestId shown in the 'list' output",
    ].join("\n"),
    annotations: {
      title: "Request Intercept",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
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
        sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 9. cleanup ──
  {
    name: "cleanup",
    description: [
      "Disconnect browser sessions and clean up temporary files created by the server.",
      "",
      "Operations:",
      "- disconnect_tab: Disconnect from a specific tab session without closing the tab (requires: tabId)",
      "- disconnect_all: Disconnect all active tab sessions (no parameters)",
      "- clean_temp: Delete all temporary files (screenshots, PDFs) created by the server (no parameters)",
      "- status: Show current server status — active sessions, temp file count, connection state (no parameters)",
      "- list_sessions: List all active agent sessions with their TTL, idle time, and associated tabs (no parameters)",
    ].join("\n"),
    annotations: {
      title: "Session Cleanup",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["disconnect_tab", "disconnect_all", "clean_temp", "status", "list_sessions"], description: "Cleanup action." },
        tabId: { type: "string", description: "Tab ID for disconnect_tab." },
        sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." },
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

  // Compute incremental diff if previous snapshot exists
  const prev = lastSnapshots.get(sess);
  lastSnapshots.set(sess, { snapshot: snap.snapshot, url: snap.url, title: snap.title });

  if (prev && prev.url === snap.url) {
    const prevLines = prev.snapshot.split("\n");
    const currLines = snap.snapshot.split("\n");
    const diff = computeSnapshotDiff(prevLines, currLines);
    if (diff.changed && diff.lines.length < currLines.length * 0.8) {
      // Diff is meaningfully smaller than full snapshot
      const diffText = diff.lines.join("\n");
      return ok(
        header +
        `### Changes (${diff.added} added, ${diff.removed} removed)\n` +
        diffText +
        `\n\n### Full Snapshot\n` +
        snap.snapshot
      );
    }
  }

  return ok(header + snap.snapshot);
}

/** Compute a simple line-level diff between two snapshots */
function computeSnapshotDiff(prevLines, currLines) {
  const prevSet = new Set(prevLines);
  const currSet = new Set(currLines);
  const lines = [];
  let added = 0, removed = 0;

  for (const line of currLines) {
    if (!prevSet.has(line)) {
      lines.push("+ " + line);
      added++;
    }
  }
  for (const line of prevLines) {
    if (!currSet.has(line)) {
      lines.push("- " + line);
      removed++;
    }
  }

  return { changed: added > 0 || removed > 0, lines, added, removed };
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
  if (args.uid !== undefined || args.selector) {
    const objectId = await resolveElementObjectId(sess, args.uid, args.selector);
    const result = await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() { return this[${JSON.stringify(prop)}]; }`,
      objectId,
      returnByValue: true,
    }, sess);
    return ok(result.result.value ?? "(empty)");
  }
  // Default: body
  const result = await cdp("Runtime.evaluate", {
    expression: `document.body.${prop}`,
    returnByValue: true,
  }, sess);
  return ok(result.result.value ?? "(empty)");
}

async function handlePageWait(args) {
  if (args.time) {
    let timeSec = args.time;
    // Auto-detect: if >60, caller likely passed milliseconds — convert to seconds
    if (timeSec > 60) timeSec = timeSec / 1000;
    // Hard cap at 60 seconds to prevent runaway waits
    timeSec = Math.min(timeSec, 60);
    await sleep(timeSec * 1000);
    return ok(`Waited ${timeSec} seconds.${args.time > 60 ? ` (auto-converted from ${args.time}ms)` : ""}`);
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
  const el = await checkActionability(sess, args.uid, args.selector);
  const button = args.button || "left";
  const clicks = args.clickCount || 1;
  // CDP buttons bitmask: 1=left, 2=right, 4=middle
  const buttonsMap = { left: 1, right: 2, middle: 4 };
  const buttons = buttonsMap[button] || 1;

  // Resolve objectId for potential JS click fallback (web components / Shadow DOM)
  let objectId;
  if (args.uid !== undefined && args.uid !== null) {
    const map = refMaps.get(sess);
    const backendNodeId = map?.get(args.uid);
    if (backendNodeId) {
      try {
        const { object } = await cdp("DOM.resolveNode", { backendNodeId }, sess);
        objectId = object?.objectId;
      } catch {}
    }
  }
  if (!objectId && args.selector) {
    try {
      const finder = elementFinderExpr(args.selector);
      const res = await cdp("Runtime.evaluate", { expression: finder, returnByValue: false }, sess);
      objectId = res.result?.objectId;
    } catch {}
  }

  // Check pre-click state for popup/toggle elements (aria-expanded, open attribute)
  let preState = null;
  if (objectId && button === "left") {
    try {
      const check = await cdp("Runtime.callFunctionOn", {
        functionDeclaration: `function() {
          return {
            expanded: this.getAttribute("aria-expanded"),
            hasPopup: this.hasAttribute("aria-haspopup") || this.hasAttribute("popovertarget"),
            open: this.hasAttribute("open") || this.closest("details")?.hasAttribute("open"),
            isWebComponent: !!this.closest("[data-catalyst]") || !!this.getRootNode()?.host || this.tagName.includes("-"),
          };
        }`,
        objectId,
        returnByValue: true,
      }, sess);
      preState = check.result?.value;
    } catch {}
  }

  const { networkEvents } = await waitForCompletion(sess, async () => {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y }, sess);
    await sleep(50);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: el.x, y: el.y, button, clickCount: clicks, buttons }, sess);
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: el.x, y: el.y, button, clickCount: clicks }, sess);
  });

  // Smart JS click fallback: if the element is a web component or popup trigger
  // and the CDP mouse events didn't change its state, dispatch element.click() via JS.
  // This handles GitHub's <action-menu>, Popover API, and custom Web Components
  // that only listen for the 'click' event rather than raw mousedown/mouseup.
  if (objectId && button === "left" && preState) {
    const needsFallback = preState.hasPopup || preState.isWebComponent || preState.expanded === "false";
    if (needsFallback) {
      try {
        await sleep(100); // Let any CDP-triggered handlers settle first
        const postCheck = await cdp("Runtime.callFunctionOn", {
          functionDeclaration: `function() {
            return {
              expanded: this.getAttribute("aria-expanded"),
              open: this.hasAttribute("open") || this.closest("details")?.hasAttribute("open"),
            };
          }`,
          objectId,
          returnByValue: true,
        }, sess);
        const postState = postCheck.result?.value;
        // If state didn't change, dispatch full pointer+mouse event sequence as fallback.
        // Many modern frameworks (React, GitHub Primer, etc.) listen for PointerEvents,
        // not just click — so we need to dispatch the complete event chain.
        const stateChanged = (preState.expanded === "false" && postState?.expanded === "true") ||
                             (!preState.open && postState?.open);
        if (!stateChanged) {
          await cdp("Runtime.callFunctionOn", {
            functionDeclaration: `function() {
              const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
              this.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
              this.dispatchEvent(new MouseEvent('mousedown', opts));
              this.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
              this.dispatchEvent(new MouseEvent('mouseup', opts));
              this.dispatchEvent(new MouseEvent('click', opts));
            }`,
            objectId,
          }, sess);
          await sleep(200); // Let event handlers process
        }
      } catch {}
    }
  }

  let msg = `Clicked <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
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
  const objectId = await resolveElementObjectId(sess, args.uid, args.selector);
  const clearCode = args.clear !== false
    ? `if ('value' in this) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(this, '');
        else this.value = '';
        this.dispatchEvent(new Event('input', {bubbles:true}));
      } else if (this.isContentEditable) { this.textContent = ''; }`
    : "";
  const focused = await cdp("Runtime.callFunctionOn", {
    functionDeclaration: `function() { this.scrollIntoView({block:"center"}); this.focus(); ${clearCode} return {ok:true}; }`,
    objectId,
    returnByValue: true,
  }, sess);
  if (focused.result.value?.error) return fail(focused.result.value.error);

  const { networkEvents } = await waitForCompletion(sess, async () => {
    // Use nativeInputValueSetter for React/Angular compatibility
    await cdp("Runtime.evaluate", {
      expression: `(() => {
        const el = document.activeElement;
        if (!el) return;
        const val = ${JSON.stringify(args.text)};
        if ('value' in el) {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, val);
          else el.value = val;
        } else if (el.isContentEditable) {
          document.execCommand('insertText', false, val);
        }
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
      })()`,
    }, sess);
  });

  if (args.submit) {
    const k = resolveKey("Enter");
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k }, sess);
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k }, sess);
  }

  const display = args.text.length > 60 ? args.text.substring(0, 60) + "..." : args.text;
  let msg = `Typed "${display}"${args.submit ? " + Enter" : ""}`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
}

async function handleInteractFill(args) {
  if (!args.fields?.length) return fail("Provide 'fields' array.");
  const sess = await getTabSession(args.tabId);
  const results = [];

  const { networkEvents } = await waitForCompletion(sess, async () => {
    for (const field of args.fields) {
      try {
        const objectId = await resolveElementObjectId(sess, field.uid, field.selector);
        const fieldType = field.type || "text";
        const r = await cdp("Runtime.callFunctionOn", {
          functionDeclaration: `function() {
            this.scrollIntoView({ block: "center" });
            const type = ${JSON.stringify(fieldType)};
            const val = ${JSON.stringify(field.value)};
            if (type === "checkbox") {
              const wanted = val === "true" || val === "1";
              if (this.checked !== wanted) this.click();
              return { ok: true, value: String(this.checked) };
            }
            if (type === "radio") { this.click(); return { ok: true, value: val }; }
            if (type === "select") {
              let opt = Array.from(this.options).find(o => o.value === val || o.textContent.trim() === val);
              if (!opt) return { error: "Option not found: " + val };
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
              if (nativeSetter) nativeSetter.call(this, opt.value);
              else this.value = opt.value;
              this.dispatchEvent(new Event('input', {bubbles:true}));
              this.dispatchEvent(new Event('change', {bubbles:true}));
              return { ok: true, value: opt.textContent.trim() };
            }
            this.focus();
            if ('value' in this) {
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                                || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
              if (nativeSetter) nativeSetter.call(this, val);
              else this.value = val;
            } else if (this.isContentEditable) {
              this.textContent = val;
            }
            this.dispatchEvent(new Event('input', {bubbles:true}));
            this.dispatchEvent(new Event('change', {bubbles:true}));
            return { ok: true, value: val.substring(0, 40) };
          }`,
          objectId,
          returnByValue: true,
        }, sess);
        results.push({ field: field.uid ?? field.selector, ...(r.result.value || { error: "eval failed" }) });
      } catch (e) {
        results.push({ field: field.uid ?? field.selector, error: e.message });
      }
    }
  });

  const response = { filled: results };
  if (networkEvents.length) response.networkActivity = networkEvents;
  return ok(response);
}

async function handleInteractSelect(args) {
  if (!args.value) return fail("Provide 'value' to select.");
  const sess = await getTabSession(args.tabId);
  const objectId = await resolveElementObjectId(sess, args.uid, args.selector);

  const { networkEvents } = await waitForCompletion(sess, async () => {
    const result = await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() {
        const sel = this;

        // Native <select> handling with proper event sequence
        if (sel.tagName === "SELECT") {
          const targetVal = ${JSON.stringify(args.value)};
          let opt = Array.from(sel.options).find(o => o.value === targetVal);
          if (!opt) opt = Array.from(sel.options).find(o => o.textContent.trim() === targetVal);
          if (!opt) return { error: "Option not found: " + targetVal + ". Available: " + Array.from(sel.options).map(o => o.textContent.trim()).join(", ") };

          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(sel, opt.value);
          else sel.value = opt.value;

          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { selected: opt.textContent.trim(), value: opt.value };
        }

        // Custom dropdown detection (combobox, listbox, MUI, Ant Design, React Select)
        const role = sel.getAttribute("role");
        const isCustomDropdown = role === "combobox" || role === "listbox" ||
          sel.getAttribute("aria-haspopup") ||
          sel.classList.toString().match(/MuiSelect|ant-select|react-select|Select/i);

        if (isCustomDropdown) {
          sel.scrollIntoView({ block: "center" });
          sel.click();
          return { customDropdown: true, message: "Custom dropdown opened — click the matching option" };
        }

        return { error: "Not a <select> element and not a recognized custom dropdown. Element: <" + sel.tagName.toLowerCase() + ">" };
      }`,
      objectId,
      returnByValue: true,
    }, sess);
    const v = result.result.value;
    if (v?.error) throw new Error(v.error);

    // If custom dropdown was opened, wait for options to appear and click matching one
    if (v?.customDropdown) {
      await sleep(300); // Wait for dropdown animation
      const clickResult = await cdp("Runtime.evaluate", {
        expression: `(() => {
          const val = ${JSON.stringify(args.value)};
          // Look for option elements in open dropdowns
          const options = document.querySelectorAll('[role="option"], [role="listitem"], li[data-value], .MuiMenuItem-root, .ant-select-item, [class*="option"]');
          for (const opt of options) {
            const text = opt.textContent.trim();
            const value = opt.getAttribute("data-value") || opt.getAttribute("value") || "";
            if (text === val || value === val || text.toLowerCase() === val.toLowerCase()) {
              opt.scrollIntoView({ block: "center" });
              opt.click();
              return { selected: text, value: value || text };
            }
          }
          return { error: "Option not found in custom dropdown: " + val + ". Visible options: " + Array.from(options).slice(0, 10).map(o => o.textContent.trim()).join(", ") };
        })()`,
        returnByValue: true,
      }, sess);
      const cv = clickResult.result.value;
      if (cv?.error) throw new Error(cv.error);
      return cv;
    }
    return v;
  });

  let msg = `Selected option successfully`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
}

async function handleInteractPress(args) {
  if (!args.key) return fail("Provide 'key' to press.");
  const sess = await getTabSession(args.tabId);
  const k = resolveKey(args.key);
  const mods = modifierFlags(args.modifiers);

  const { networkEvents } = await waitForCompletion(sess, async () => {
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
  });

  const modStr = args.modifiers?.length ? args.modifiers.join("+") + "+" : "";
  let msg = `Pressed ${modStr}${args.key}`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
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
      const objectId = await resolveElementObjectId(sess, args.uid, args.selector);
      await cdp("Runtime.callFunctionOn", {
        functionDeclaration: `function() { this.scrollTo({left:${scrollX},top:${scrollY},behavior:'smooth'}); }`,
        objectId,
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
    const objectId = await resolveElementObjectId(sess, args.uid, args.selector);
    await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() { this.scrollBy({left:${deltaX},top:${deltaY},behavior:'smooth'}); }`,
      objectId,
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

  // Resolve element via resolveElementObjectId
  const objectId = await resolveElementObjectId(sess, args.uid, args.selector);

  // Describe node to get backendNodeId for setFileInputFiles
  const { node } = await cdp("DOM.describeNode", { objectId }, sess);
  await cdp("DOM.setFileInputFiles", { files: args.files, backendNodeId: node.backendNodeId }, sess);

  return ok(`Uploaded ${args.files.length} file(s): ${args.files.map(f => f.split(/[/\\]/).pop()).join(", ")}`);
}

async function handleInteractFocus(args) {
  const sess = await getTabSession(args.tabId);
  const objectId = await resolveElementObjectId(sess, args.uid, args.selector);
  const result = await cdp("Runtime.callFunctionOn", {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      this.focus();
      return { tag: this.tagName.toLowerCase(), label: (this.getAttribute("aria-label") || this.textContent || "").trim().substring(0, 60) };
    }`,
    objectId,
    returnByValue: true,
  }, sess);
  const v = result.result.value;
  if (v?.error) return fail(v.error);
  return ok(`Focused <${v.tag}> "${v.label}"`);
}

async function handleInteractCheck(args) {
  if (args.checked === undefined) return fail("Provide 'checked' (true/false).");
  const sess = await getTabSession(args.tabId);
  const objectId = await resolveElementObjectId(sess, args.uid, args.selector);

  const { networkEvents } = await waitForCompletion(sess, async () => {
    const result = await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() {
        this.scrollIntoView({ block: "center" });
        const desired = ${args.checked === true};
        if (this.checked !== desired) {
          this.click();
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { checked: this.checked, label: (this.getAttribute("aria-label") || this.labels?.[0]?.textContent || "").trim().substring(0, 60) };
      }`,
      objectId,
      returnByValue: true,
    }, sess);
    const v = result.result.value;
    if (v?.error) throw new Error(v.error);
    return v;
  });

  let msg = `Checkbox: ${args.checked ? "checked" : "unchecked"}`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
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

async function handleObserveDownloads(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");

  let dl = downloads.get(sess) || [];
  if (args.last) dl = dl.slice(-args.last);
  if (args.clear) downloads.set(sess, []);
  if (!dl.length) return ok("No downloads tracked yet. Downloads are captured automatically when they occur.");

  const lines = dl.map(d => {
    const pct = d.totalBytes > 0 ? ` ${((d.receivedBytes / d.totalBytes) * 100).toFixed(1)}%` : "";
    const size = d.totalBytes > 0 ? ` ${(d.totalBytes / 1024).toFixed(1)}KB` : "";
    return `[${d.state}]${pct}${size} ${d.suggestedFilename} — ${d.url.substring(0, 120)}`;
  });
  return ok(`${dl.length} download(s):\n\n${lines.join("\n")}`);
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
    const geoParams = {
      latitude: args.geolocation.latitude,
      longitude: args.geolocation.longitude,
      accuracy: args.geolocation.accuracy ?? 100,
    };
    if (args.geolocation.altitude !== undefined) geoParams.altitude = args.geolocation.altitude;
    await cdp("Emulation.setGeolocationOverride", geoParams, sess);
    // Auto-grant geolocation permission so navigator.geolocation works in JS
    let permGranted = false;
    try {
      const { result: originResult } = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
      const origin = originResult?.value;
      // Get browserContextId for the tab to scope the permission grant correctly
      let browserContextId;
      try {
        const { targetInfo } = await cdp("Target.getTargetInfo", { targetId: args.tabId });
        browserContextId = targetInfo?.browserContextId;
      } catch { /* ok */ }
      const grantParams = { permissions: ["geolocation"] };
      if (origin && origin !== "null") grantParams.origin = origin;
      if (browserContextId) grantParams.browserContextId = browserContextId;
      await cdp("Browser.grantPermissions", grantParams);
      // Verify the permission was actually granted
      const { result: permCheck } = await cdp("Runtime.evaluate", {
        expression: "navigator.permissions.query({name:'geolocation'}).then(r=>r.state)",
        returnByValue: true, awaitPromise: true,
      }, sess);
      permGranted = permCheck?.value === "granted";
    } catch { /* ok */ }
    if (!permGranted) {
      // Fallback: try Browser.setPermission (Chrome 93+)
      try {
        const { result: originResult2 } = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
        const origin2 = originResult2?.value;
        const setPermParams = { permission: { name: "geolocation" }, setting: "granted" };
        if (origin2 && origin2 !== "null") setPermParams.origin = origin2;
        await cdp("Browser.setPermission", setPermParams);
        const { result: permCheck2 } = await cdp("Runtime.evaluate", {
          expression: "navigator.permissions.query({name:'geolocation'}).then(r=>r.state)",
          returnByValue: true, awaitPromise: true,
        }, sess);
        permGranted = permCheck2?.value === "granted";
      } catch { /* ok */ }
    }
    if (!permGranted) {
      // Final fallback: inject JS geolocation override directly
      const geoScript = `(function(){
        const _lat=${geoParams.latitude},_lng=${geoParams.longitude},_acc=${geoParams.accuracy},_alt=${geoParams.altitude !== undefined ? geoParams.altitude : 'null'};
        const _pos={coords:{latitude:_lat,longitude:_lng,accuracy:_acc,altitude:_alt,altitudeAccuracy:null,heading:null,speed:null},timestamp:Date.now()};
        const _origGCP=navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
        const _origWP=navigator.geolocation.watchPosition.bind(navigator.geolocation);
        navigator.geolocation.getCurrentPosition=function(s,e,o){setTimeout(()=>s(_pos),0);};
        navigator.geolocation.watchPosition=function(s,e,o){setTimeout(()=>s(_pos),0);return 1;};
      })();`;
      try {
        await cdp("Runtime.evaluate", { expression: geoScript }, sess);
        // Also inject into new documents
        await ensureDomain(sess, "Page");
        await cdp("Page.addScriptToEvaluateOnNewDocument", { source: geoScript }, sess);
      } catch { /* ok */ }
    }
    let geoMsg = `Geolocation: ${args.geolocation.latitude}, ${args.geolocation.longitude} (accuracy: ${geoParams.accuracy}m`;
    if (geoParams.altitude !== undefined) geoMsg += `, altitude: ${geoParams.altitude}m`;
    geoMsg += ")";
    results.push(geoMsg);
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

async function handleCleanupListSessions() {
  // Expire stale sessions first
  const now = Date.now();
  for (const [id, s] of agentSessions) {
    if (now - s.lastActivity > SESSION_TTL) agentSessions.delete(id);
  }
  if (agentSessions.size === 0) return ok("No active agent sessions.");
  const lines = [];
  for (const [id, s] of agentSessions) {
    const age = ((now - s.lastActivity) / 1000).toFixed(0);
    const ttl = Math.max(0, ((SESSION_TTL - (now - s.lastActivity)) / 1000)).toFixed(0);
    lines.push(`  ${id} — ${s.tabIds.size} tab(s), idle ${age}s, expires in ${ttl}s`);
  }
  return ok(
    `Agent sessions: ${agentSessions.size}\n` +
    `Session TTL: ${SESSION_TTL / 1000}s\n\n` +
    lines.join("\n")
  );
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
    `Active downloads: ${[...downloads.values()].reduce((s, d) => s + d.filter(x => x.state === "inProgress").length, 0)}\n` +
    `Connection health: ${connectionHealth.status} (failures: ${connectionHealth.failures})\n` +
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
    downloads: handleObserveDownloads,
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
    list_sessions: handleCleanupListSessions,
  },
};

async function handleTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool: ${name}`);

  // ── Per-agent session routing (auto-assigned per process, or explicit) ──
  const sessionId = args.sessionId || processSessionId;
  delete args.sessionId; // don't pass down to handlers
  const now = Date.now();

  // Expire stale sessions and clean up their CDP state
  for (const [id, s] of agentSessions) {
    if (now - s.lastActivity > SESSION_TTL) {
      for (const tid of s.tabIds) {
        try { await detachTab(tid); } catch { /* ok */ }
      }
      agentSessions.delete(id);
    }
  }

  // Get or create session
  let session = agentSessions.get(sessionId);
  if (!session) {
    session = { lastActivity: now, tabIds: new Set() };
    agentSessions.set(sessionId, session);
  }
  session.lastActivity = now;

  // Track tab association
  if (args.tabId) {
    session.tabIds.add(args.tabId);
  }

  // For tab listing, enforce session ownership (filter to session tabs unless showAll)
  if (name === "tabs" && args.action === "list" && session.tabIds.size > 0 && !args.showAll) {
    const allTabs = await getTabs();
    const ownedTabs = allTabs.filter(t => session.tabIds.has(t.targetId));
    if (!ownedTabs.length) return ok("No session-owned tabs. Use showAll: true to see all browser tabs.");
    const lines = ownedTabs.map((t, i) => {
      const c = activeSessions.has(t.targetId) ? " [connected]" : "";
      return `${i + 1}. [${t.targetId}]${c}\n   ${t.title}\n   ${t.url}`;
    });
    return ok(`[session: ${sessionId}] ${ownedTabs.length} tab(s):\n\n${lines.join("\n\n")}`);
  }

  // ── Modal state guard ──
  // If a JavaScript dialog is pending on the target tab, block all actions except page.dialog
  if (args.tabId) {
    const sid = activeSessions.get(args.tabId);
    if (sid) {
      const dialogs = pendingDialogs.get(sid) || [];
      if (dialogs.length > 0 && !(name === "page" && args.action === "dialog")) {
        const d = dialogs[0];
        return fail(
          `A JavaScript dialog is blocking the page. Handle it first.\n` +
          `Dialog: ${d.type} "${d.message.substring(0, 100)}"\n` +
          `→ Use page tool with action: 'dialog', tabId: '${args.tabId}', accept: true/false`
        );
      }
    }
  }

  // Single-function handler (emulate)
  if (typeof handler === "function") {
    const result = await handler(args);
    return appendConsoleErrors(result, args.tabId);
  }

  // Action-based dispatch
  const action = args.action;
  if (!action) return fail(`Missing 'action' parameter for tool '${name}'.`);
  const fn = handler[action];
  if (!fn) return fail(`Unknown action '${action}' for tool '${name}'. Available: ${Object.keys(handler).join(", ")}`);
  const result = await fn(args);
  return appendConsoleErrors(result, args.tabId);
}

/**
 * Auto-include recent console errors/warnings in tool responses.
 * Appends any new error/warning messages that appeared since the last call.
 */
function appendConsoleErrors(result, tabId) {
  if (!tabId || result.isError) return result;
  const sid = activeSessions.get(tabId);
  if (!sid) return result;

  const logs = consoleLogs.get(sid) || [];
  const recentErrors = logs
    .filter(l => l.level === "error" || l.level === "warning")
    .slice(-5) // last 5 errors/warnings
    .map(l => `[${l.level.toUpperCase()}] ${l.text.substring(0, 150)}`);

  if (recentErrors.length > 0 && result.content?.[0]?.type === "text") {
    result.content[0].text += "\n\n### Console Errors\n" + recentErrors.join("\n");
  }
  return result;
}

// ─── MCP Server Setup ───────────────────────────────────────────────

const server = new Server(
  { name: "cdp-browser", version: "4.1.0" },
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

// ─── Periodic Session Cleanup ────────────────────────────────────────

setInterval(async () => {
  const now = Date.now();
  for (const [id, s] of agentSessions) {
    if (now - s.lastActivity > SESSION_TTL) {
      // Clean up CDP sessions for expired agent sessions
      for (const tid of s.tabIds) {
        try { await detachTab(tid); } catch { /* ok */ }
      }
      agentSessions.delete(id);
    }
  }
}, 60_000); // sweep every 60s

const transport = new StdioServerTransport();
await server.connect(transport);
