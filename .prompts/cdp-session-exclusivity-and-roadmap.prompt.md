# Task: Session Exclusivity, Auto-Cleanup & Feature Roadmap for CDP Browser MCP Server

## Objective

Implement **exclusive agent sessions with configurable auto-cleanup** in the CDP Browser MCP server at **`E:\Projects\CDP Browser Automation\MCP Server\server.js`**, then follow up with 4 additional features: Chrome profile selection, full web resource debugging, human-like interaction consolidation, and a Playwright audit with gap fixes.

## File to edit

**`E:\Projects\CDP Browser Automation\MCP Server\server.js`** — single file, all changes go here.

---

## Feature 1: Session Exclusivity + Auto-Cleanup (Implement First)

### Problem

- Agents can't own tabs exclusively — any agent can access any tab by passing its `tabId`, effectively "stealing" it from another session.
- When an agent dies or its session expires (TTL), tabs are only **detached** (CDP session dropped) but remain **open** in the browser — accumulating garbage tabs.
- `tabs.new` doesn't register ownership until a follow-up call uses the new `tabId` — there's a gap where the tab is unowned.
- `sessionId` is supported in `handleTool` but **not declared in any tool schema** — agents don't know it exists.
- No way to configure cleanup behavior — it's hardcoded to detach-only.

### Current State

#### Session State Maps (~line 104–121)

```js
const agentSessions = new Map();        // agentSessionId → { lastActivity, tabIds: Set }
const processSessionId = randomUUID();  // fallback when no sessionId provided
```

#### Session Resolution in `handleTool` (~line 3262)

```js
const sessionId = args.sessionId || processSessionId;
delete args.sessionId;
```

- `sessionId` comes from `args` (caller-supplied) or falls back to a per-process UUID.
- Not from MCP protocol — `StdioServerTransport` provides no caller identity.

#### Tab Ownership (~line 3287–3289)

```js
if (args.tabId) {
  session.tabIds.add(args.tabId);  // lazy association — only on use, not creation
}
```

#### Tab Listing Filter (~line 3292–3301)

Only `tabs.list` respects session ownership (shows owned tabs unless `showAll: true`). All other tools accept any `tabId` unconditionally.

#### TTL Sweep (~line 3266–3272 and ~line 3371–3382)

```js
for (const [id, s] of agentSessions) {
  if (now - s.lastActivity > SESSION_TTL) {
    for (const tid of s.tabIds) {
      try { await detachTab(tid); } catch {}  // detach only — tab stays open!
    }
    agentSessions.delete(id);
  }
}
```

#### `detachTab` (~line 498–519)

Calls `Target.detachFromTarget` + purges 11 state maps. Does **NOT** call `Target.closeTarget` — tab remains in browser.

---

### Required Changes

### Step 1 — Fix tab ownership at creation time

In `handleTabsNew` (~line 1513), after `Target.createTarget`, add the new `targetId` to the current agent session's `tabIds` **and** lock it.

**Approach:** In `handleTool` (~line 3287), inject the session object and sessionId into args:
```js
args._agentSession = session;
args._agentSessionId = sessionId;
```

In `handleTabsNew`, after creating the tab:

```js
async function handleTabsNew(args) {
  const url = args.url || "about:blank";
  const { targetId } = await cdp("Target.createTarget", { url });
  if (args._agentSession) {
    args._agentSession.tabIds.add(targetId);
    tabLocks.set(targetId, args._agentSessionId);
  }
  return ok(`New tab: [${targetId}]\nURL: ${url}`);
}
```

**Cleanup:** In `handleTool`, strip internal fields from args before returning (after the handler call):
```js
delete args._agentSession;
delete args._agentSessionId;
```
This prevents leaking internal references into handler responses.

---

### Step 2 — Add exclusive tab locking

Add a new state Map near the other maps (~line 104):

```js
const tabLocks = new Map();  // tabId → agentSessionId
```

When a tab is associated with a session (~line 3287), add a lock check:

```js
if (args.tabId) {
  const lockOwner = tabLocks.get(args.tabId);
  if (lockOwner && lockOwner !== sessionId && args.exclusive !== false) {
    return fail(`Tab [${args.tabId}] is locked by another agent session. Use exclusive:false to override.`);
  }
  session.tabIds.add(args.tabId);
  // Only set lock if tab is unowned — never overwrite another session's lock
  if (!lockOwner) {
    tabLocks.set(args.tabId, sessionId);
  }
}
```

**Unowned tab claiming:** Tabs already open in the browser but not part of any session (no entry in `tabLocks`) can be freely claimed by the first agent that references them. Once claimed, they become locked to that session.

**Why `if (!lockOwner)`:** When Session B uses `exclusive: false` to share Session A's tab, the `fail()` is correctly skipped. But without this guard, `tabLocks.set(args.tabId, sessionId)` would overwrite Session A's lock with Session B's ID. If Session B's TTL then expires, `detachTab` deletes the lock — leaving Session A's tab unprotected. Only the original owner (or the first claimer of an unowned tab) should set the lock.

Release locks in `detachTab` (~line 498) — add at the **top**, before the `!sid` early-return guard:

```js
async function detachTab(tabId) {
  tabLocks.delete(tabId);  // always clean lock, even if no CDP session exists
  for (const [, agentSession] of agentSessions) {
    agentSession.tabIds.delete(tabId);
  }
  const sid = activeSessions.get(tabId);
  if (!sid) return;
  // ...rest of existing cleanup unchanged
}
```

**Why before `!sid`:** A tab created via `tabs.new` gets locked immediately (Step 1), but may never be interacted with — meaning `activeSessions` has no CDP session for it. If TTL expires, `detachTab(tid)` would hit the `if (!sid) return` early-exit and never reach cleanup at the bottom. Placing `tabLocks.delete` and `tabIds.delete` before the guard ensures locks are always released regardless of CDP session state.

Since `detachTab` handles lock cleanup, all callers (including `cleanupTab`, TTL sweep, `tabs.close`) automatically release locks.

**Fix existing `cleanup.disconnect_tab` and `cleanup.disconnect_all` handlers** (~line 3122–3132). These call `detachTab()` directly without any ownership check. An agent could call `disconnect_tab` on a borrowed tab and successfully detach it from the owner's CDP session. Add a lock guard to both:

```js
async function handleCleanupDisconnectTab(args) {
  if (!args.tabId) return fail("Provide 'tabId'.");
  // Only allow disconnecting tabs this session owns or unowned tabs
  // No exclusive:false override — detaching is destructive (kills CDP session + clears all state)
  const lockOwner = tabLocks.get(args.tabId);
  if (lockOwner && lockOwner !== args._agentSessionId) {
    return fail(`Tab [${args.tabId}] is locked by another session. Cannot disconnect.`);
  }
  await detachTab(args.tabId);
  return ok("Detached from tab.");
}

async function handleCleanupDisconnectAll(args) {
  const ids = [...activeSessions.keys()];
  let count = 0;
  for (const id of ids) {
    // Only disconnect tabs caller owns or unowned tabs
    const lockOwner = tabLocks.get(id);
    if (!lockOwner || lockOwner === args._agentSessionId) {
      await detachTab(id);
      count++;
    }
  }
  return ok(`Disconnected from ${count} tab(s). ${ids.length - count} locked tab(s) skipped.`);
}
```

**Default: exclusive.** Agents must pass `exclusive: false` to share tabs.

**Destructive ops guard:** `exclusive: false` allows shared read/interact access but must NOT allow destructive operations on another session's tab. `tabs.close` has its own ownership check that rejects closing tabs locked by other sessions — independent of `exclusive`. This ensures sharing a tab never grants the power to destroy it.

---

### Step 3 — Add configurable cleanup strategy

Add `cleanupStrategy` to `agentSessions` entries:

```js
session = { lastActivity: now, tabIds: new Set(), cleanupStrategy: args.cleanupStrategy || "close" };
```

**Values:**

| Strategy | Behavior on session expiry |
|---|---|
| `"close"` (default) | `detachTab(tid)` + `Target.closeTarget({ targetId: tid })` — removes tab from browser |
| `"detach"` | `detachTab(tid)` only — tab stays open for manual inspection |
| `"none"` | No cleanup — tabs and sessions persist indefinitely |

Add a `cleanupTab` helper near `detachTab`:

```js
async function cleanupTab(tabId, strategy = "close") {
  await detachTab(tabId);  // also calls tabLocks.delete(tabId) internally
  if (strategy === "close") {
    try { await cdp("Target.closeTarget", { targetId: tabId }); } catch {}
  }
}
```

**Note:** `tabLocks.delete` is handled inside `detachTab` (Step 2), so `cleanupTab` doesn't need to repeat it.

---

### Step 4 — Extract sweep into shared function + update to use cleanup strategy

The TTL sweep is currently duplicated in two places (~line 3266–3272 in `handleTool` and ~line 3371–3382 in `setInterval`). **Extract into a single `sweepStaleSessions()` function** to prevent logic drift:

```js
async function sweepStaleSessions() {
  const now = Date.now();
  for (const [id, s] of agentSessions) {
    if (now - s.lastActivity > SESSION_TTL) {
      // "none" strategy = persist indefinitely — skip the entire sweep for this session
      if (s.cleanupStrategy === "none") continue;

      for (const tid of s.tabIds) {
        // Only cleanup tabs this session actually owns (locked to it)
        // Borrowed tabs (exclusive:false) should just be removed from tabIds, not closed/detached
        if (tabLocks.get(tid) === id) {
          try { await cleanupTab(tid, s.cleanupStrategy); } catch {}
        }
      }
      // Clear the session's tabIds (including borrowed refs) and delete session
      s.tabIds.clear();
      agentSessions.delete(id);
    }
  }
}
```

**Critical: `"none"` strategy must skip the ENTIRE sweep.** Previously, the code used `if (s.cleanupStrategy !== "none")` to skip only the `cleanupTab` calls, but still deleted the session and cleared its `tabIds`. This left orphaned entries in `tabLocks` pointing to a deleted session ID — creating "ghost locks" that permanently block other agents from accessing those tabs. The fix uses `continue` to skip the entire iteration, keeping the session and its locks alive indefinitely as promised.

Then call `await sweepStaleSessions()` in both locations:
- In `handleTool` before session get-or-create
- In the `setInterval(60_000)` periodic sweep

Also fix `handleCleanupListSessions` (~line 3139) which currently does its own stale sweep that only deletes entries without detaching tabs — replace with `await sweepStaleSessions()`.

---

### Step 5 — Declare `sessionId`, `cleanupStrategy`, `exclusive` in tool schemas

These params are handled in `handleTool` before dispatch — they don't need to be on every tool. **Only add them to tools that accept `tabId`** (where they're relevant): `tabs`, `page`, `interact`, `execute`, `observe`, `emulate`, `storage`, `intercept`, `cleanup`.

In practice, add to the **shared description header** of each tool rather than duplicating properties on all 9 schemas. Add a single note:

```
"Session params (all tools): sessionId — agent session ID for tab ownership/isolation; cleanupStrategy — close|detach|none for tab cleanup on expiry (default: close); exclusive — lock tabs to session (default: true)",
```

And add the properties only to tools that use `tabId`:

```js
sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'close' (default) removes tabs, 'detach' keeps them, 'none' skips cleanup. Set once per session, sticky." },
exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
```

**`cleanupStrategy` is sticky** — set on the first call that provides it, persists for the session lifetime. Subsequent calls can override it.

---

### Step 6 — Add `cleanup.session` action (self-terminate only)

Add to the `cleanup` tool's actions (~line 1501). Also add `session` to the cleanup schema's action enum and handler dispatch map.

**Session isolation model:** Sessions can ONLY terminate themselves. No cross-session termination capability exists. This prevents subagent A from killing subagent B's work in multi-subagent workflows.

- **Self-terminate:** `cleanup.session` always terminates the caller's own session
- **TTL sweep:** Expired sessions are cleaned up automatically by `sweepStaleSessions()`
- **Admin wipe:** `browser.connect` clears all sessions when switching Chrome instances
- **No `targetSessionId`:** Removed entirely to eliminate cross-session termination vectors

**Destructive operations access control:**
| Operation | Ownership required? | `exclusive:false` override? |
|---|---|---|
| Read/interact (snapshot, click, type...) | Lock check in `handleTool` | Yes — grants shared access |
| `tabs.close` | Own lock check in handler | No — always requires ownership |
| `cleanup.disconnect_tab` | Own lock check in handler | No — always requires ownership |
| `cleanup.session` | Self-only | N/A |

```js
async function handleCleanupSession(args) {
  const sid = args._agentSessionId;
  const session = agentSessions.get(sid);
  if (!session) return fail(`No session found: ${sid}`);
  
  const strategy = args.cleanupStrategy || session.cleanupStrategy || "close";
  let cleaned = 0;
  for (const tid of session.tabIds) {
    // Only cleanup tabs this session owns — don't touch borrowed tabs
    if (tabLocks.get(tid) === sid) {
      try { await cleanupTab(tid, strategy); cleaned++; } catch {}
    }
  }
  // Clear all tab references (including borrowed) and delete session
  session.tabIds.clear();
  agentSessions.delete(sid);
  return ok(`Session ${sid} ended. ${cleaned} owned tab(s) ${strategy === "close" ? "closed" : "detached"}.`);
}
```

**Note:** `args._agentSessionId` is injected by `handleTool` (Step 1). No additional schema properties needed — `cleanup.session` always terminates the caller's own session.

---

### Step 7 — Mark locked tabs in `tabs.list` and `tabs.find` output

When `showAll: true` in `tabs.list`, and always in `tabs.find`, annotate tabs owned by other sessions with `[locked]`:

```js
const lockOwner = tabLocks.get(t.targetId);
const lockTag = lockOwner && lockOwner !== sessionId ? ` [locked by: ${lockOwner.substring(0, 8)}...]` : "";
// Include lockTag in the tab listing line
```

**Apply to both `handleTabsList` (~line 1470) and `handleTabsFind` (~line 1500).** Both functions build tab listing lines — add the `lockTag` to each.

This is display-only. The actual **rejection of operations** on locked tabs is already handled by the lock check in Step 2 (in `handleTool`), which runs before any handler is called.

---

### Step 8 — Enhance `cleanup.list_sessions` output

**Security: Session IDs must be truncated.** Full session IDs are unguessable UUIDs — they function as session credentials. Exposing them in diagnostic output enables session impersonation (any caller can send `sessionId = victimId` to act as that session). Truncate to first 8 chars in all output:

Show per-session details:

```
Session: abc12345…
  Last activity: 2m ago | TTL remaining: 3m
  Cleanup strategy: close
  Owned tabs: 3
    [TAB_ID_1] https://example.com
    [TAB_ID_2] https://google.com
    [TAB_ID_3] about:blank
```

**Implementation:** In `handleCleanupListSessions`, use `id.substring(0, 8) + "…"` instead of raw `id`. Also truncate session IDs in `handleCleanupSession` response messages. The `tabs.list` lock tags already truncate (`lockOwner.substring(0, 8)`). Ensure NO code path ever returns a full session UUID to the caller except the caller's own ID (which they already know).

---

### Verification Tests

| # | Test | Expected |
|---|---|---|
| 1 | Create session "A", open 3 tabs. Set `CDP_SESSION_TTL=10000`. Wait 15s. | All 3 tabs closed in browser. |
| 2 | Session A locks a tab. Session B tries to interact with it. | Rejection: "Tab is locked by another agent session". |
| 3 | `tabs.new` creates a tab. Immediately call `tabs.list`. | New tab shows as owned (no follow-up needed). |
| 4 | Set `cleanupStrategy: "detach"`. Let session expire. | Tabs remain open, CDP sessions dropped. |
| 5 | Call `cleanup.session` explicitly. | All owned tabs closed, session removed from `agentSessions`. |
| 6 | Session B with `exclusive: false` accesses Session A's tab. | Access granted, no lock conflict. |
| 7 | Tab already open in browser (not part of any session). Agent A references it. | Tab claimed and locked to Agent A's session. |
| 8 | Agent A claims unowned tab. Agent B tries to access same tab. | Rejection: "Tab is locked by another agent session". |
| 9 | `cleanup.list_sessions` with stale sessions. | Stale sessions swept (tabs cleaned per strategy), then active sessions listed with tab URLs. |

---

## Feature 2: Chrome Profile Selection (Next)

### Problem

The server connects to whichever Chrome instance has remote debugging enabled. No awareness of Chrome profiles. Agents open tabs in whatever profile the user last clicked on.

### Current State

- `getWsUrl()` (~line 146): Reads `DevToolsActivePort` from `CDP_USER_DATA` env var or default Chrome User Data path (`%LOCALAPPDATA%\Google\Chrome\User Data`).
- Falls back to `ws://CDP_HOST:CDP_PORT/devtools/browser/` if no `DevToolsActivePort` found.
- No profile enumeration. No multi-profile support. Connects to one browser endpoint.
- `browserWs` is a single global variable (~line 104). Entire server assumes one connection.

### How Chrome Profiles Actually Work with CDP

Chrome does NOT create per-profile `DevToolsActivePort` files. There is ONE `DevToolsActivePort` in the User Data root dir, shared across all profiles within a single Chrome instance.

- All tabs from ALL profiles are visible as targets via `Target.getTargets`.
- Profile identity is NOT directly exposed in `TargetInfo` — but each profile gets a unique `browserContextId`.
- Separate Chrome instances (launched with different `--user-data-dir`) DO have separate debug ports and separate `DevToolsActivePort` files.

### Profile Name Resolution via `Local State`

Chrome stores profile metadata in `<User Data>/Local State` (JSON). The `profile.info_cache` object maps directory names to profile details:

```json
{
  "profile": {
    "info_cache": {
      "Default": { "name": "Tushar", "gaia_name": "Tushar Agarwal", "user_name": "tushar@gmail.com" },
      "Profile 1": { "name": "Yogesh", "gaia_name": "Yogesh Tulsan", "user_name": "yogesh@gmail.com" },
      "Profile 7": { "name": "Work", "gaia_name": "Mansha Agarwal", "user_name": "mansha@gmail.com" }
    }
  }
}
```

This is how we map `browserContextId` → human-readable profile name for same-instance multi-profile visibility.

---

### Required Changes

### Step 1 — Add `discoverChromeInstances()` helper

Scan known User Data directories for `DevToolsActivePort` files + read `Local State` for profile names.

```js
function discoverChromeInstances() {
  const candidates = [
    { name: "Chrome", path: join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data") },
    { name: "Chrome Beta", path: join(process.env.LOCALAPPDATA || "", "Google", "Chrome Beta", "User Data") },
    { name: "Chrome Canary", path: join(process.env.LOCALAPPDATA || "", "Google", "Chrome SxS", "User Data") },
    { name: "Chromium", path: join(process.env.LOCALAPPDATA || "", "Chromium", "User Data") },
  ];
  // Add custom path from env if set
  if (process.env.CDP_USER_DATA) {
    candidates.unshift({ name: "Custom", path: process.env.CDP_USER_DATA });
  }

  const instances = [];
  for (const { name, path: udPath } of candidates) {
    try {
      const portFile = readFileSync(join(udPath, "DevToolsActivePort"), "utf8").trim();
      const lines = portFile.split("\n");
      const port = parseInt(lines[0]);
      const wsPath = lines[1];
      
      // Read profile names from Local State
      let profiles = [];
      try {
        const localState = JSON.parse(readFileSync(join(udPath, "Local State"), "utf8"));
        const cache = localState?.profile?.info_cache || {};
        profiles = Object.entries(cache).map(([dir, info]) => ({
          directory: dir,
          name: info.name || dir,
          gaiaName: info.gaia_name || "",
          email: info.user_name || "",
        }));
      } catch { /* Local State may not exist or be readable */ }

      instances.push({
        name,
        userDataDir: udPath,
        port,
        wsPath,
        wsUrl: `ws://127.0.0.1:${port}${wsPath}`,
        profiles,
        connected: browserWs?.url === `ws://127.0.0.1:${port}${wsPath}`,
      });
    } catch { /* no DevToolsActivePort — Chrome not running with this user-data-dir */ }
  }
  return instances;
}
```

**Note:** `browserWs?.url` — the WebSocket object stores the URL it connected to. Use this to mark which instance is currently active.

---

### Step 2 — Add server state for active connection info

Near the other state variables (~line 104), add:

```js
let activeConnectionInfo = null; // { name, userDataDir, port, wsUrl }
```

Update `connectBrowser()` to auto-detect connection info in the `browserWs.once("open")` callback. The variables `instanceName`, `udPath`, and `port` don't exist in `connectBrowser()` — it only has the resolved WebSocket URL. So we match the URL against discovered instances:

```js
browserWs.once("open", () => {
  startHealthCheck();
  // Auto-detect which Chrome instance we connected to
  if (!activeConnectionInfo) {
    const wsUrl = browserWs.url;
    const instances = discoverChromeInstances();
    const match = instances.find(i => i.wsUrl === wsUrl);
    if (match) {
      activeConnectionInfo = { name: match.name, userDataDir: match.userDataDir, port: match.port, wsUrl };
    } else {
      // Fallback for manual port connections without a User Data dir match
      const portMatch = wsUrl.match(/:(\d+)/);
      activeConnectionInfo = { name: "Auto-detected", userDataDir: lastResolvedUserDataDir, port: portMatch ? parseInt(portMatch[1]) : CDP_PORT, wsUrl };
    }
  } else {
    // Always refresh wsUrl — Chrome regenerates the GUID on every restart.
    // If CDP_PROFILE was set at boot, the wsUrl from that moment may be stale.
    activeConnectionInfo.wsUrl = browserWs.url;
  }
  resolve();
});
```

**Why always update `wsUrl`:** When `CDP_PROFILE` is set, `activeConnectionInfo` is populated at boot with the GUID from that moment. If Chrome restarts before the first tool call, `connectBrowser()` reads the fresh GUID from `DevToolsActivePort` — but the `if (!activeConnectionInfo)` guard would skip updating `activeConnectionInfo.wsUrl`, leaving `browser.active` reporting a stale URL. The `else` branch fixes this by always syncing the actual WebSocket URL.

Clear in the WebSocket close handler:
```js
activeConnectionInfo = null;
overrideUserDataDir = null;  // reset so next implicit connection uses default env vars
```

Also update `getWsUrl()` — currently it returns a URL string. Refactor to also track which User Data dir was used:
```js
let lastResolvedUserDataDir = null;

function getWsUrl() {
  const paths = [
    process.env.CDP_USER_DATA,
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
  ].filter(Boolean);
  for (const p of paths) {
    try {
      const c = readFileSync(join(p, "DevToolsActivePort"), "utf8");
      const lines = c.trim().split("\n");
      lastResolvedUserDataDir = p;
      return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    } catch { /* next */ }
  }
  lastResolvedUserDataDir = null;
  return `ws://${CDP_HOST}:${CDP_PORT}/devtools/browser/`;
}
```

---

### Step 3 — Add `browser` tool schema

New tool #10. Action-based pattern.

```js
{
  name: "browser",
  description: [
    "Chrome instance and profile management. Detect running Chrome instances, switch connections, and view profile information.",
    "",
    "Operations:",
    "- profiles: List all detected Chrome instances with their profiles, ports, and connection status (no parameters)",
    "- connect: Switch to a different Chrome instance by name, port, or User Data directory path (requires: instance — name like 'Chrome' or 'Chrome Canary', or port number, or path to User Data dir)",
    "- active: Show the currently connected Chrome instance, port, profiles, and WebSocket URL (no parameters)",
    "",
    "Notes:",
    "- All Chrome profiles within one instance share a single debug port — you cannot connect to a specific profile, only to an instance",
    "- Each profile's tabs are distinguishable via browserContextId in tab info",
    "- Switching instances requires no other active agent sessions (use cleanup.session to end them first)",
    "- Set CDP_PROFILE env var to auto-connect to a specific User Data directory at startup",
  ].join("\\n"),
  annotations: {
    title: "Browser Instance",
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["profiles", "connect", "active"], description: "Browser action." },
      instance: { type: "string", description: "Chrome instance to connect to — name (e.g. 'Chrome Canary'), port number, or User Data directory path." },
    },
    required: ["action"],
  },
}
```

---

### Step 4 — Implement `handleBrowserProfiles`

```js
async function handleBrowserProfiles() {
  const instances = discoverChromeInstances();
  if (!instances.length) {
    return ok("No Chrome instances found with remote debugging enabled.\nLaunch Chrome with --remote-debugging-port=9222 or enable chrome://flags/#enable-remote-debugging");
  }
  const sections = instances.map(inst => {
    const connTag = inst.connected ? " [CONNECTED]" : "";
    let section = `${inst.name}${connTag}\n  Port: ${inst.port}\n  User Data: ${inst.userDataDir}`;
    if (inst.profiles.length) {
      section += `\n  Profiles (${inst.profiles.length}):`;
      for (const p of inst.profiles) {
        const email = p.email ? ` (${p.email})` : "";
        section += `\n    ${p.directory}: ${p.name}${email}`;
      }
    }
    return section;
  });
  return ok(`Chrome instances: ${instances.length}\n\n${sections.join("\n\n")}`);
}
```

---

### Step 5 — Implement `handleBrowserConnect`

```js
async function handleBrowserConnect(args) {
  if (!args.instance) return fail("Provide 'instance' — name (e.g. 'Chrome'), port number (e.g. '9333'), or User Data directory path.");

  // Guard: reject if other agent sessions are active
  const otherSessions = [...agentSessions.entries()].filter(([id]) => id !== args._agentSessionId);
  const activeSids = otherSessions.filter(([, s]) => s.tabIds.size > 0);
  if (activeSids.length > 0) {
    const ids = activeSids.map(([id, s]) => `${id.substring(0, 8)}… (${s.tabIds.size} tabs)`).join(", ");
    return fail(`Cannot switch — ${activeSids.length} other session(s) with active tabs: ${ids}. End them first with cleanup.session.`);
  }

  // Find the target instance
  const instances = discoverChromeInstances();
  const input = args.instance.toString().trim();
  const target = instances.find(inst =>
    inst.name.toLowerCase() === input.toLowerCase() ||
    inst.port.toString() === input ||
    inst.userDataDir.toLowerCase() === input.toLowerCase()
  );
  if (!target) {
    const available = instances.map(i => `${i.name} (port ${i.port})`).join(", ") || "none found";
    return fail(`Chrome instance "${input}" not found. Available: ${available}`);
  }
  if (target.connected) {
    return ok(`Already connected to ${target.name} (port ${target.port}).`);
  }

  // Clear caller's session state — tabs from old browser are invalid
  const callerSession = agentSessions.get(args._agentSessionId);
  if (callerSession) {
    callerSession.tabIds.clear();
    agentSessions.delete(args._agentSessionId);
  }
  tabLocks.clear();
  agentSessions.clear(); // wipe all sessions — old browser's tabs are gone

  // Disconnect current browser — wait for close event, not a blind timer
  if (browserWs && browserWs.readyState !== WebSocket.CLOSED) {
    const oldWs = browserWs;
    await new Promise(resolve => {
      oldWs.once("close", resolve);
      oldWs.close();
    });
  }

  // Connect to new instance — override the User Data dir, NOT the full WS URL
  // Chrome regenerates the WebSocket GUID on every restart. If we stored the full URL,
  // reconnects after a Chrome restart would fail with a stale GUID forever.
  // By overriding the User Data dir, getWsUrl() re-reads DevToolsActivePort dynamically.
  overrideUserDataDir = target.userDataDir;
  await connectBrowser();
  activeConnectionInfo = { name: target.name, userDataDir: target.userDataDir, port: target.port, wsUrl: browserWs?.url };

  return ok(`Connected to ${target.name}\nPort: ${target.port}\nUser Data: ${target.userDataDir}\nProfiles: ${target.profiles.map(p => p.name).join(", ") || "unknown"}`);
}
```

**Note on `overrideUserDataDir`:** Add a module-level variable `let overrideUserDataDir = null;` near `browserWs`. Modify `getWsUrl()` to check it first:

```js
function getWsUrl() {
  const paths = [
    overrideUserDataDir,  // browser.connect override — takes priority
    process.env.CDP_USER_DATA,
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
  ].filter(Boolean);
  for (const p of paths) {
    try {
      const c = readFileSync(join(p, "DevToolsActivePort"), "utf8");
      const lines = c.trim().split("\n");
      lastResolvedUserDataDir = p;
      return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    } catch { /* next */ }
  }
  lastResolvedUserDataDir = null;
  return `ws://${CDP_HOST}:${CDP_PORT}/devtools/browser/`;
}
```

**Why User Data dir, not full URL:** Chrome's DevTools WebSocket URLs contain a randomly generated GUID (e.g. `ws://127.0.0.1:9222/devtools/browser/23423acf-4dc4-...`). Chrome regenerates this GUID on every launch. If we stored the full URL via `overrideWsUrl`, a Chrome restart would permanently break reconnection — the server would keep trying to connect to a dead GUID. By storing only the User Data directory, `getWsUrl()` re-reads `DevToolsActivePort` on every connection attempt, always getting the fresh GUID.

**Why `await oldWs.once("close")` instead of `setTimeout(200)`:** The plan's original `await new Promise(r => setTimeout(r, 200))` is a race condition. If the TCP socket takes >200ms to close, the old socket's close handler fires AFTER the new connection is established — setting `browserWs = null` and destroying the fresh connection. Using `oldWs.once("close", resolve)` waits for the actual close event, eliminating the race.

---

### Step 6 — Implement `handleBrowserActive`

```js
async function handleBrowserActive() {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
    return ok("Not connected to any Chrome instance.");
  }

  const info = activeConnectionInfo || {};
  let text = `Connected to: ${info.name || "unknown"}\n`;
  text += `Port: ${info.port || "unknown"}\n`;
  text += `User Data: ${info.userDataDir || "unknown"}\n`;
  text += `WebSocket: ${info.wsUrl || browserWs.url || "unknown"}\n`;
  text += `Health: ${connectionHealth.status}\n`;

  // Show profiles from Local State
  if (info.userDataDir) {
    try {
      const localState = JSON.parse(readFileSync(join(info.userDataDir, "Local State"), "utf8"));
      const cache = localState?.profile?.info_cache || {};
      const profiles = Object.entries(cache).map(([dir, p]) => `${p.name || dir}${p.user_name ? ` (${p.user_name})` : ""}`);
      if (profiles.length) text += `Profiles: ${profiles.join(", ")}\n`;
    } catch { /* ok */ }
  }

  // Show tab count per browserContextId (profile grouping)
  try {
    const { targetInfos } = await cdp("Target.getTargets", { filter: [{ type: "page" }] });
    if (targetInfos?.length) {
      const byContext = {};
      for (const t of targetInfos) {
        const ctx = t.browserContextId || "default";
        byContext[ctx] = (byContext[ctx] || 0) + 1;
      }
      text += `\nTabs by profile context:\n`;
      for (const [ctx, count] of Object.entries(byContext)) {
        text += `  ${ctx.substring(0, 12)}… — ${count} tab(s)\n`;
      }
    }
  } catch { /* ok */ }

  return ok(text);
}
```

---

### Step 7 — Enhance `tabs.info` with `browserContextId`

In `handleTabsInfo` (~line 1605), add `browserContextId` to the output. The `TargetInfo` object from `Target.getTargets` already contains it:

```js
async function handleTabsInfo(args) {
  // ... existing code gets `tab` from getTabs() ...
  const contextId = tab.browserContextId ? `\nProfile context: ${tab.browserContextId}` : "";
  return ok(
    `Tab: ${tab.title}\nURL: ${tab.url}\nID: ${tab.targetId}` +
    contextId +
    `\nSession: ${connected ? "active" : "not connected"}\n` +
    `Console: ${consoleCount} messages | Network: ${netCount} requests`
  );
}
```

This lets agents see which profile a tab belongs to.

---

### Step 8 — Enhance `cleanup.status` with connection info

In `handleCleanupStatus` (~line 3270), add active Chrome instance info:

```js
const connInfo = activeConnectionInfo
  ? `Chrome instance: ${activeConnectionInfo.name} (port ${activeConnectionInfo.port})\n  User Data: ${activeConnectionInfo.userDataDir}`
  : `Chrome instance: auto-detected (port ${CDP_PORT})`;
```

Add `connInfo` to the output string.

---

### Step 9 — Register in HANDLERS dispatch map

```js
browser: {
  profiles: handleBrowserProfiles,
  connect: handleBrowserConnect,
  active: handleBrowserActive,
},
```

---

### Step 10 — Add `CDP_PROFILE` env var support

At startup (near the end of the file, before `await server.connect(transport)`), auto-connect if `CDP_PROFILE` is set:

```js
if (process.env.CDP_PROFILE) {
  const instances = discoverChromeInstances();
  const target = instances.find(i =>
    i.name.toLowerCase() === process.env.CDP_PROFILE.toLowerCase() ||
    i.userDataDir.toLowerCase() === process.env.CDP_PROFILE.toLowerCase()
  );
  if (target) {
    overrideUserDataDir = target.userDataDir;
    activeConnectionInfo = { name: target.name, userDataDir: target.userDataDir, port: target.port, wsUrl: target.wsUrl };
  }
}
```

This selects the instance before the first tool call. If the env var doesn't match any instance, fall back to default auto-discovery.

---

### Verification Tests

| # | Test | Expected |
|---|---|---|
| 1 | `browser.profiles` with Chrome running | Lists instance with name, port, User Data dir, and profile names from Local State |
| 2 | `browser.profiles` with no Chrome running | "No Chrome instances found" with help text |
| 3 | `browser.connect` with name "Chrome" | Connects, shows profile list |
| 4 | `browser.connect` with port "9222" | Same — matches by port |
| 5 | `browser.connect` with full User Data path | Same — matches by path |
| 6 | `browser.connect` while other sessions have tabs | Rejection with session list |
| 7 | `browser.connect` to already-connected instance | "Already connected" |
| 8 | `browser.active` | Shows instance name, port, profiles, health, tabs-per-context |
| 9 | `tabs.info` on any tab | Shows `browserContextId` in output |
| 10 | `cleanup.status` | Shows active Chrome instance info |
| 11 | Set `CDP_PROFILE=Chrome Canary`, restart server | Auto-connects to Canary instance |
| 12 | `browser.connect` then `tabs.list` | Old session's tabs gone, fresh start on new instance |

---

## Feature 3: Web Resource Debugging — Phase 5

### Problem

No ability to set breakpoints, step through code, inspect call stacks, watch variables, or temporarily override CSS/JS resources on pages. The `Debugger`, `DOMDebugger` CDP domains are completely unused. No way to override response bodies without manual Fetch intercept round-trips.

### Current CDP Domain Usage

16 domains used: Runtime, Target, Page, Input, DOM, Accessibility, Network, Fetch, Emulation, Performance, Storage, Security, Browser. **Not used:** Debugger, DOMDebugger, Profiler, HeapProfiler, CSS, DOMSnapshot, ServiceWorker, IndexedDB, CacheStorage, Overlay.

### Architecture: New `debug` Tool (#11)

Action-based tool following the same pattern as `intercept`, `cleanup`, `browser`. Split into 4 sub-areas:
- **5a. Debugger core** — enable/disable, breakpoints, stepping, call stack inspection, script listing
- **5b. Resource overrides** — pre-registered URL pattern → response body rules (extends Fetch infrastructure)
- **5c. DOM/Event breakpoints** — break on DOM mutations or JS events via DOMDebugger
- **5d. Source inspection** — get script source, find possible breakpoint locations

---

### Required Changes

### Step 1 — Add new state maps (~line 128, after `downloads`)

```js
const pausedTabs = new Map();           // cdpSessionId → { reason, callFrames, hitBreakpoints, ts }
const parsedScripts = new Map();        // cdpSessionId → Map<scriptId, { url, startLine, endLine, hash }>
const activeBreakpoints = new Map();    // cdpSessionId → Map<breakpointId, { url, lineNumber, columnNumber, condition }>
const resourceOverrides = new Map();    // cdpSessionId → [{ urlPattern, responseCode, headers, body }]
const fetchPatterns = new Map();        // cdpSessionId → { request: [...], response: [...] }
```

**Why keyed by CDP `sessionId` (not `tabId` or agent `sessionId`):** `handleEvent` receives only the CDP `sessionId` — it has no `tabId` or agent session context. All event-driven state must be keyed by CDP session ID, same as `consoleLogs`, `pendingDialogs`, `fetchRules`, etc.

Also add the env var for auto-resume timeout near the other env vars (~line 36):
```js
const CDP_DEBUGGER_TIMEOUT = parseInt(process.env.CDP_DEBUGGER_TIMEOUT || "30000");
```

---

### Step 2 — Add cleanup for new state maps

**In `detachTab` (~line 590–600), add after `downloads.delete(sid)`:**
```js
pausedTabs.delete(sid);
parsedScripts.delete(sid);
activeBreakpoints.delete(sid);
resourceOverrides.delete(sid);
fetchPatterns.delete(sid);
```

**In WebSocket close handler (~line 269-281), add after `downloads.clear()`:**
```js
pausedTabs.clear();
parsedScripts.clear();
activeBreakpoints.clear();
resourceOverrides.clear();
fetchPatterns.clear();
```

---

### Step 3 — Add `refreshFetchPatterns` helper (near `handleInterceptEnable` ~line 3500)

```js
/**
 * Re-issue Fetch.enable with the unified set of request-stage + response-stage patterns.
 * Must be called whenever patterns change (from intercept.enable, intercept.disable, 
 * debug.override_resource, or debug.remove_override).
 * CDP Fetch.enable REPLACES the entire config — it is NOT additive.
 *
 * IMPORTANT: CDP urlPattern uses glob syntax (* = any, ? = single), NOT JS regex.
 * Request-stage patterns from intercept.enable are already globs (user provides them).
 * Response-stage patterns for resource overrides always use "*" (catch-all) because
 * the user provides JS regex patterns — precise matching happens in handleEvent,
 * not in Chrome's Fetch domain. This avoids glob/regex semantics confusion.
 */
async function refreshFetchPatterns(sess) {
  const p = fetchPatterns.get(sess) || { request: [], response: [] };
  const allPatterns = [
    ...p.request.map(url => ({ urlPattern: url, requestStage: "Request" })),
    // Response-stage: always use "*" catch-all — JS regex matching in handleEvent does precision filtering
    ...(p.response.length > 0 ? [{ urlPattern: "*", requestStage: "Response" }] : []),
  ];
  if (allPatterns.length === 0) {
    try { await cdp("Fetch.disable", {}, sess); } catch { /* ok */ }
  } else {
    await cdp("Fetch.enable", { patterns: allPatterns }, sess);
  }
}
```

**Why `"*"` for response-stage:** CDP `Fetch.enable` `urlPattern` uses glob syntax (not JS regex). Users provide JS regex patterns for `override_resource` (e.g., `https://example\.com/.*\.js`). Passing these to CDP as globs would silently fail. Instead, register `"*"` to catch ALL responses, then match precisely with `new RegExp()` in the `handleEvent` response-stage handler. This is semantically correct: Chrome pauses all responses, and the server's handler decides which to override vs continue.

---

### Step 4 — Refactor `handleInterceptEnable` to use unified patterns (~line 3502)

Replace the current implementation with:

```js
async function handleInterceptEnable(args) {
  const sess = await getTabSession(args.tabId);
  const patterns = args.patterns || ["*"];

  // Save to unified pattern store (request-stage)
  const p = fetchPatterns.get(sess) || { request: [], response: [] };
  p.request = patterns;
  fetchPatterns.set(sess, p);

  // Re-issue Fetch.enable with ALL patterns (request + response)
  await refreshFetchPatterns(sess);

  if (!pendingFetchRequests.has(sess)) pendingFetchRequests.set(sess, new Map());
  if (!fetchRules.has(sess)) fetchRules.set(sess, []);

  return ok(`Request interception enabled.\nPatterns: ${patterns.join(", ")}\nPaused requests will auto-continue after 10s if not handled.`);
}
```

---

### Step 5 — Refactor `handleInterceptDisable` to use unified patterns (~line 3519)

Replace with:

```js
async function handleInterceptDisable(args) {
  const sess = await getTabSession(args.tabId);

  // Only clear request-stage patterns — response-stage overrides may still be active
  const p = fetchPatterns.get(sess);
  if (p) p.request = [];
  await refreshFetchPatterns(sess);

  pendingFetchRequests.delete(sess);
  fetchRules.delete(sess);

  const overrideCount = resourceOverrides.get(sess)?.length || 0;
  return ok("Request interception disabled." + (overrideCount ? ` ${overrideCount} response override(s) still active.` : ""));
}
```

---

### Step 6 — Add response-stage disambiguation in `handleEvent` Fetch handler (~line 439)

The existing `Fetch.requestPaused` handler must distinguish request-stage from response-stage pauses. Response-stage pauses include `params.responseStatusCode`. Add at the TOP of the `Fetch.requestPaused` block:

```js
if (method === "Fetch.requestPaused") {
  // Response-stage pause (has responseStatusCode) — check resource overrides
  if (params.responseStatusCode !== undefined) {
    const overrides = resourceOverrides.get(sessionId) || [];
    const url = params.request?.url || "";
    const override = overrides.find(o => {
      try { return new RegExp(o.urlPattern, "i").test(url); } catch { return false; }
    });
    if (override) {
      (async () => {
        try {
          await cdp("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: override.responseCode || 200,
            responseHeaders: override.headers || [{ name: "Content-Type", value: "text/html" }],
            ...(override.body ? { body: Buffer.from(override.body).toString("base64") } : {}),
          }, sessionId);
        } catch { /* ok */ }
      })();
    } else {
      // No matching override — MUST continue or Chrome hangs
      (async () => {
        try { await cdp("Fetch.continueResponse", { requestId: params.requestId }, sessionId); } catch { /* ok */ }
      })();
    }
    return;
  }

  // Request-stage pause — existing fetchRules logic (unchanged below)
  const pending = pendingFetchRequests.get(sessionId) || new Map();
  // ... rest of existing handler unchanged
```

**Critical:** The response-stage branch must `return` before the existing request-stage logic runs. Otherwise a response-stage pause would fall through to `pending.set(params.requestId, info)` and create a phantom pending request that never gets resolved.

**Note:** Use `Fetch.continueResponse` (not `Fetch.continueRequest`) for response-stage pauses. `continueRequest` is for request-stage only. Chrome will error if you use the wrong one.

---

### Step 7 — Add debugger event handling in `handleEvent` (~line 493, before closing brace)

Add three new event handlers:

```js
  // ── Debugger events ──
  if (method === "Debugger.scriptParsed") {
    const scripts = parsedScripts.get(sessionId) || new Map();
    // Only track scripts with URLs (skip eval'd code and internal scripts)
    if (params.url) {
      scripts.set(params.scriptId, {
        url: params.url,
        startLine: params.startLine,
        endLine: params.endLine,
        hash: params.hash || "",
      });
      parsedScripts.set(sessionId, scripts);
    }
  }

  if (method === "Debugger.paused") {
    const pauseTs = Date.now();
    pausedTabs.set(sessionId, {
      reason: params.reason,
      callFrames: params.callFrames,
      hitBreakpoints: params.hitBreakpoints || [],
      ts: pauseTs,
    });

    // Auto-resume after timeout to prevent permanently bricked tabs
    // LLMs are slow — 30s default (vs 10s for dialogs/fetch)
    setTimeout(async () => {
      const entry = pausedTabs.get(sessionId);
      if (entry && entry.ts === pauseTs) {
        try { await cdp("Debugger.resume", {}, sessionId); } catch { /* ok */ }
        pausedTabs.delete(sessionId);
      }
    }, CDP_DEBUGGER_TIMEOUT);
  }

  if (method === "Debugger.resumed") {
    pausedTabs.delete(sessionId);
  }
```

---

### Step 8 — Add debugger pause guard in `handleTool` (~line 4076, after dialog guard)

Mirror the dialog guard pattern. The debugger pause guard blocks all non-debug actions while the tab is paused:

```js
  // ── Debugger pause guard ──
  // If debugger is paused on the target tab, block non-debug tool calls
  // Allow ALL debug actions (not just stepping — read-only inspection + override management too)
  // Also allow page.dialog since dialogs can fire while paused and must be dismissible
  if (args.tabId) {
    const sid = activeSessions.get(args.tabId);
    if (sid) {
      const paused = pausedTabs.get(sid);
      if (paused && name !== "debug" && !(name === "page" && args.action === "dialog")) {
        const topFrame = paused.callFrames?.[0];
        const location = topFrame ? `\nPaused at: ${topFrame.url}:${topFrame.location.lineNumber}` : "";
        delete args._agentSession;
        delete args._agentSessionId;
        return fail(
          `Debugger is paused on this tab. Handle it first.${location}\n` +
          `Reason: ${paused.reason}\n` +
          `→ Use debug tool with action: 'resume', 'step_over', 'step_into', 'step_out', 'call_stack', or 'evaluate_on_frame'\n` +
          `Auto-resume in ${CDP_DEBUGGER_TIMEOUT / 1000}s if not handled.`
        );
      }
    }
  }
```

**Why `name !== "debug"` instead of a narrow action allow-list:**
- All debug actions should work while paused — not just stepping. Read-only inspection (`list_breakpoints`, `list_scripts`, `get_source`, `list_overrides`) and override management (`override_resource`, `remove_override`) are explicitly debugger-independent per the tool's Notes section.
- `disable` must work while paused as an emergency exit (auto-resumes internally).
- Using a narrow allow-list would contradict the tool's own documentation that overrides are independent.

**Why `page.dialog` exception:**
- A JS dialog can fire while the debugger is paused (e.g., breakpoint in code that triggers a dialog on resume).
- Without this exception, the dialog guard lets `page.dialog` through but the pause guard blocks it — deadlocking the tab until auto-resume fires after 30s.

---

### Step 9 — Add `debug` tool schema (tool #11, after browser in TOOLS array ~line 1789)

```js
  // ── 11. debug ──
  {
    name: "debug",
    description: [
      "JavaScript debugger, resource overrides, and DOM/event breakpoints. Uses CDP Debugger and DOMDebugger domains.",
      "",
      "Debugger operations:",
      "- enable: Enable JavaScript debugger for a tab — starts tracking scripts and allows breakpoints (requires: tabId)",
      "- disable: Disable the debugger for a tab (requires: tabId)",
      "- set_breakpoint: Set a breakpoint by URL pattern + line number (requires: tabId, url, lineNumber; optional: columnNumber, condition)",
      "- remove_breakpoint: Remove a breakpoint by ID (requires: tabId, breakpointId)",
      "- list_breakpoints: List all active breakpoints for a tab (requires: tabId)",
      "- pause: Pause JavaScript execution immediately (requires: tabId)",
      "- resume: Resume execution after a pause (requires: tabId)",
      "- step_over: Step over the current statement (requires: tabId)",
      "- step_into: Step into the next function call (requires: tabId)",
      "- step_out: Step out of the current function (requires: tabId)",
      "- call_stack: Get the current call stack with scope variables when paused (requires: tabId)",
      "- evaluate_on_frame: Evaluate an expression in a specific call frame (requires: tabId, expression; optional: frameIndex — default 0, top frame)",
      "- list_scripts: List all loaded scripts tracked by the debugger (requires: tabId)",
      "- get_source: Get the source code of a script by ID (requires: tabId, scriptId)",
      "",
      "Resource override operations:",
      "- override_resource: Pre-register a URL pattern + replacement response body. Pattern is a JS regex matched against response URLs. Matching responses are fulfilled automatically — no LLM round-trip (requires: tabId, urlPattern; optional: body, responseCode, headers)",
      "- remove_override: Remove a resource override by URL pattern (requires: tabId, urlPattern)",
      "- list_overrides: List all active resource overrides (requires: tabId)",
      "",
      "DOM/Event breakpoint operations:",
      "- set_dom_breakpoint: Break when a DOM node is modified (requires: tabId, uid, type — 'subtree-modified', 'attribute-modified', or 'node-removed')",
      "- remove_dom_breakpoint: Remove a DOM breakpoint (requires: tabId, uid, type)",
      "- set_event_breakpoint: Break on a specific event type like 'click', 'xhr', 'setTimeout' (requires: tabId, eventName)",
      "- remove_event_breakpoint: Remove an event breakpoint (requires: tabId, eventName)",
      "",
      "Notes:",
      "- Call 'enable' before setting breakpoints or listing scripts",
      "- When debugger pauses, ALL other tool calls on that tab are blocked until you resume/step",
      "- Auto-resume fires after " + "30s (CDP_DEBUGGER_TIMEOUT) to prevent permanently frozen tabs",
      "- Resource overrides work independently of the debugger — no need to call 'enable' first",
      "- Resource overrides coexist with request interception (intercept tool). Both can be active simultaneously",
      "- Performance: while overrides are active, ALL responses are routed through the handler for regex matching. Remove overrides when done to avoid unnecessary overhead on resource-heavy pages",
      "",
      "Session params (all tools): sessionId, cleanupStrategy, exclusive",
    ].join("\n"),
    annotations: {
      title: "Debug & Override",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "enable", "disable",
            "set_breakpoint", "remove_breakpoint", "list_breakpoints",
            "pause", "resume", "step_over", "step_into", "step_out",
            "call_stack", "evaluate_on_frame",
            "list_scripts", "get_source",
            "override_resource", "remove_override", "list_overrides",
            "set_dom_breakpoint", "remove_dom_breakpoint",
            "set_event_breakpoint", "remove_event_breakpoint",
          ],
          description: "Debug action.",
        },
        tabId: { type: "string", description: "Tab ID." },
        url: { type: "string", description: "URL pattern for set_breakpoint (matched by prefix — e.g. 'https://example.com/app.js')." },
        lineNumber: { type: "number", description: "Line number for set_breakpoint (0-based)." },
        columnNumber: { type: "number", description: "Column number for set_breakpoint (0-based, optional)." },
        condition: { type: "string", description: "Conditional breakpoint expression — break only when this evaluates to true." },
        breakpointId: { type: "string", description: "Breakpoint ID for remove_breakpoint." },
        expression: { type: "string", description: "JS expression for evaluate_on_frame." },
        frameIndex: { type: "number", description: "Call frame index for evaluate_on_frame (default: 0 = top frame)." },
        scriptId: { type: "string", description: "Script ID for get_source." },
        urlPattern: { type: "string", description: "URL regex pattern for override_resource / remove_override (JS regex syntax, e.g. 'example\\.com/api/.*')" },
        body: { type: "string", description: "Response body for override_resource." },
        responseCode: { type: "number", description: "HTTP status code for override_resource (default: 200)." },
        headers: { type: "object", description: "Response headers for override_resource (object of name→value)." },
        uid: { type: "number", description: "Element ref for set_dom_breakpoint / remove_dom_breakpoint." },
        type: { type: "string", enum: ["subtree-modified", "attribute-modified", "node-removed"], description: "DOM breakpoint type." },
        eventName: { type: "string", description: "Event name for set_event_breakpoint (e.g. 'click', 'xhr', 'setTimeout')." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true)." },
      },
      required: ["action", "tabId"],
    },
  },
```

---

### Step 10 — Implement debug handlers

Add all handlers in a new section before the Browser Handlers block (~line 3597):

```js
// ─── Debug Handlers ─────────────────────────────────────────────────

async function handleDebugEnable(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Debugger");
  return ok("Debugger enabled. Scripts are being tracked. Set breakpoints with set_breakpoint.");
}

async function handleDebugDisable(args) {
  const sess = await getTabSession(args.tabId);
  try { await cdp("Debugger.disable", {}, sess); } catch { /* ok */ }
  pausedTabs.delete(sess);
  parsedScripts.delete(sess);
  activeBreakpoints.delete(sess);
  return ok("Debugger disabled.");
}

async function handleDebugSetBreakpoint(args) {
  if (args.url === undefined || args.lineNumber === undefined) return fail("Provide 'url' and 'lineNumber'.");
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Debugger");
  const params = { url: args.url, lineNumber: args.lineNumber };
  if (args.columnNumber !== undefined) params.columnNumber = args.columnNumber;
  if (args.condition) params.condition = args.condition;
  const result = await cdp("Debugger.setBreakpointByUrl", params, sess);
  // Track internally
  const bps = activeBreakpoints.get(sess) || new Map();
  bps.set(result.breakpointId, { url: args.url, lineNumber: args.lineNumber, columnNumber: args.columnNumber, condition: args.condition });
  activeBreakpoints.set(sess, bps);
  const locs = (result.locations || []).map(l => `  ${l.scriptId}:${l.lineNumber}:${l.columnNumber || 0}`).join("\n");
  return ok(`Breakpoint set: ${result.breakpointId}\nResolved locations:\n${locs || "  (none yet — will resolve when matching script loads)"}`);
}

async function handleDebugRemoveBreakpoint(args) {
  if (!args.breakpointId) return fail("Provide 'breakpointId'.");
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.removeBreakpoint", { breakpointId: args.breakpointId }, sess);
  const bps = activeBreakpoints.get(sess);
  if (bps) bps.delete(args.breakpointId);
  return ok(`Breakpoint removed: ${args.breakpointId}`);
}

async function handleDebugListBreakpoints(args) {
  const sess = await getTabSession(args.tabId);
  const bps = activeBreakpoints.get(sess) || new Map();
  if (bps.size === 0) return ok("No active breakpoints.");
  const lines = [...bps.entries()].map(([id, bp]) => {
    const cond = bp.condition ? ` [if: ${bp.condition}]` : "";
    return `[${id}] ${bp.url}:${bp.lineNumber}${bp.columnNumber !== undefined ? `:${bp.columnNumber}` : ""}${cond}`;
  });
  return ok(`${bps.size} breakpoint(s):\n\n${lines.join("\n")}`);
}

async function handleDebugPause(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.pause", {}, sess);
  return ok("Pause requested. Execution will halt at the next statement.");
}

async function handleDebugResume(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.resume", {}, sess);
  pausedTabs.delete(sess);
  return ok("Resumed execution.");
}

async function handleDebugStepOver(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.stepOver", {}, sess);
  // Will trigger Debugger.paused again at next statement
  return ok("Stepped over. Waiting for next pause...");
}

async function handleDebugStepInto(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.stepInto", {}, sess);
  return ok("Stepped into. Waiting for next pause...");
}

async function handleDebugStepOut(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.stepOut", {}, sess);
  return ok("Stepped out. Waiting for next pause...");
}

async function handleDebugCallStack(args) {
  const sess = await getTabSession(args.tabId);
  const paused = pausedTabs.get(sess);
  if (!paused) return fail("Debugger is not paused. Use 'pause' or set a breakpoint first.");
  const frames = paused.callFrames || [];
  if (!frames.length) return ok("Paused but no call frames available.");
  const sections = frames.slice(0, 10).map((f, i) => {
    let section = `#${i} ${f.functionName || "(anonymous)"}\n  ${f.url}:${f.location.lineNumber}:${f.location.columnNumber || 0}`;
    // Show scope variables for top 3 frames
    if (i < 3 && f.scopeChain) {
      const localScope = f.scopeChain.find(s => s.type === "local");
      if (localScope && localScope.object?.objectId) {
        section += "\n  Local vars: (use evaluate_on_frame to inspect)";
      }
    }
    return section;
  });
  const hitBps = paused.hitBreakpoints?.length ? `\nHit breakpoints: ${paused.hitBreakpoints.join(", ")}` : "";
  return ok(`Paused: ${paused.reason}${hitBps}\n\nCall stack (${frames.length} frames):\n\n${sections.join("\n\n")}`);
}

async function handleDebugEvaluateOnFrame(args) {
  if (!args.expression) return fail("Provide 'expression'.");
  const sess = await getTabSession(args.tabId);
  const paused = pausedTabs.get(sess);
  if (!paused) return fail("Debugger is not paused.");
  const frameIndex = args.frameIndex || 0;
  const frame = paused.callFrames?.[frameIndex];
  if (!frame) return fail(`Frame index ${frameIndex} out of range (${paused.callFrames?.length || 0} frames).`);
  const result = await cdp("Debugger.evaluateOnCallFrame", {
    callFrameId: frame.callFrameId,
    expression: args.expression,
    returnByValue: true,
  }, sess);
  if (result.exceptionDetails) {
    return fail(`Evaluation error: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  }
  const val = result.result;
  let display;
  if (val.type === "object" && val.value !== undefined) {
    display = JSON.stringify(val.value, null, 2);
  } else if (val.type === "undefined") {
    display = "undefined";
  } else {
    display = val.description || val.value?.toString() || val.type;
  }
  return ok(`[frame #${frameIndex}] ${args.expression} = ${display}`);
}

async function handleDebugListScripts(args) {
  const sess = await getTabSession(args.tabId);
  const scripts = parsedScripts.get(sess) || new Map();
  if (scripts.size === 0) return ok("No scripts tracked. Call 'enable' first, then reload the page.");
  // Group by domain for readability
  const entries = [...scripts.entries()].filter(([, s]) => s.url);
  const lines = entries.slice(0, 50).map(([id, s]) => `[${id}] ${s.url} (lines ${s.startLine}-${s.endLine})`);
  return ok(`${entries.length} script(s)${entries.length > 50 ? " (showing first 50)" : ""}:\n\n${lines.join("\n")}`);
}

async function handleDebugGetSource(args) {
  if (!args.scriptId) return fail("Provide 'scriptId'.");
  const sess = await getTabSession(args.tabId);
  const result = await cdp("Debugger.getScriptSource", { scriptId: args.scriptId }, sess);
  const source = result.scriptSource || "";
  return ok(`Script ${args.scriptId} (${source.length} chars):\n\n${source}`);
}

// ── Resource Override Handlers ──

async function handleDebugOverrideResource(args) {
  if (!args.urlPattern) return fail("Provide 'urlPattern' (regex pattern to match response URLs).");
  const sess = await getTabSession(args.tabId);

  // Validate regex
  try { new RegExp(args.urlPattern, "i"); } catch (e) { return fail(`Invalid regex: ${e.message}`); }

  const override = {
    urlPattern: args.urlPattern,
    responseCode: args.responseCode || 200,
    headers: args.headers
      ? Object.entries(args.headers).map(([name, value]) => ({ name, value: String(value) }))
      : [{ name: "Content-Type", value: "text/html" }],
    body: args.body || "",
  };

  const overrides = resourceOverrides.get(sess) || [];
  // Replace if pattern already exists
  const idx = overrides.findIndex(o => o.urlPattern === args.urlPattern);
  if (idx >= 0) overrides[idx] = override;
  else overrides.push(override);
  resourceOverrides.set(sess, overrides);

  // Register response-stage Fetch pattern (uses catch-all "*" in CDP, regex matching in handler)
  const p = fetchPatterns.get(sess) || { request: [], response: [] };
  if (!p.response.includes(args.urlPattern)) {
    p.response.push(args.urlPattern);
    fetchPatterns.set(sess, p);
  }
  await refreshFetchPatterns(sess);

  return ok(`Resource override registered.\nPattern: ${args.urlPattern}\nStatus: ${override.responseCode}\nBody: ${override.body.length} chars\nMatching responses will be replaced automatically.`);
}

async function handleDebugRemoveOverride(args) {
  if (!args.urlPattern) return fail("Provide 'urlPattern'.");
  const sess = await getTabSession(args.tabId);
  const overrides = resourceOverrides.get(sess) || [];
  const idx = overrides.findIndex(o => o.urlPattern === args.urlPattern);
  if (idx < 0) return fail(`No override found for pattern: ${args.urlPattern}`);
  overrides.splice(idx, 1);

  // Remove from response-stage Fetch patterns
  const p = fetchPatterns.get(sess);
  if (p) {
    p.response = p.response.filter(pat => pat !== args.urlPattern);
    await refreshFetchPatterns(sess);
  }

  return ok(`Override removed: ${args.urlPattern}\n${overrides.length} override(s) remaining.`);
}

async function handleDebugListOverrides(args) {
  const sess = await getTabSession(args.tabId);
  const overrides = resourceOverrides.get(sess) || [];
  if (overrides.length === 0) return ok("No active resource overrides.");
  const lines = overrides.map((o, i) => `${i + 1}. ${o.urlPattern} → ${o.responseCode} (${o.body.length} chars)`);
  return ok(`${overrides.length} override(s):\n\n${lines.join("\n")}`);
}

// ── DOM/Event Breakpoint Handlers ──

async function handleDebugSetDomBreakpoint(args) {
  if (args.uid === undefined) return fail("Provide 'uid' (element ref from snapshot).");
  if (!args.type) return fail("Provide 'type': 'subtree-modified', 'attribute-modified', or 'node-removed'.");
  const sess = await getTabSession(args.tabId);

  // Resolve uid → backendNodeId via refMaps, then → nodeId via DOM.pushNodesByBackendIds
  // DOMDebugger.setDOMBreakpoint requires nodeId (not backendNodeId or RemoteObject)
  const map = refMaps.get(sess);
  const backendNodeId = map?.get(args.uid);
  if (!backendNodeId) return fail(`Element ref=${args.uid} not found. Take a fresh snapshot.`);

  // Get DOM document root first (required for pushNodesByBackendIds)
  await cdp("DOM.getDocument", { depth: 0 }, sess);
  const { nodeIds } = await cdp("DOM.pushNodesByBackendIds", { backendNodeIds: [backendNodeId] }, sess);
  const nodeId = nodeIds?.[0];
  if (!nodeId) return fail(`Cannot resolve DOM nodeId for ref=${args.uid}. The element may have been removed.`);

  await cdp("DOMDebugger.setDOMBreakpoint", { nodeId, type: args.type }, sess);
  return ok(`DOM breakpoint set: ${args.type} on ref=${args.uid} (nodeId=${nodeId})\nExecution will pause when this node is ${args.type === "subtree-modified" ? "or its children are modified" : args.type === "attribute-modified" ? "has attributes changed" : "removed from DOM"}.`);
}

async function handleDebugRemoveDomBreakpoint(args) {
  if (args.uid === undefined) return fail("Provide 'uid'.");
  if (!args.type) return fail("Provide 'type'.");
  const sess = await getTabSession(args.tabId);

  // Same resolution chain: uid → backendNodeId → nodeId
  const map = refMaps.get(sess);
  const backendNodeId = map?.get(args.uid);
  if (!backendNodeId) return fail(`Element ref=${args.uid} not found. Take a fresh snapshot.`);

  await cdp("DOM.getDocument", { depth: 0 }, sess);
  const { nodeIds } = await cdp("DOM.pushNodesByBackendIds", { backendNodeIds: [backendNodeId] }, sess);
  const nodeId = nodeIds?.[0];
  if (!nodeId) return fail(`Cannot resolve DOM nodeId for ref=${args.uid}.`);

  await cdp("DOMDebugger.removeDOMBreakpoint", { nodeId, type: args.type }, sess);
  return ok(`DOM breakpoint removed: ${args.type} on ref=${args.uid}`);
}

async function handleDebugSetEventBreakpoint(args) {
  if (!args.eventName) return fail("Provide 'eventName' (e.g. 'click', 'xhr', 'setTimeout').");
  const sess = await getTabSession(args.tabId);
  await cdp("DOMDebugger.setEventListenerBreakpoint", { eventName: args.eventName }, sess);
  return ok(`Event breakpoint set: ${args.eventName}\nExecution will pause when a '${args.eventName}' event fires.`);
}

async function handleDebugRemoveEventBreakpoint(args) {
  if (!args.eventName) return fail("Provide 'eventName'.");
  const sess = await getTabSession(args.tabId);
  await cdp("DOMDebugger.removeEventListenerBreakpoint", { eventName: args.eventName }, sess);
  return ok(`Event breakpoint removed: ${args.eventName}`);
}
```

---

### Step 11 — Register in HANDLERS dispatch map (~line 3990, after `browser` block)

```js
  debug: {
    enable: handleDebugEnable,
    disable: handleDebugDisable,
    set_breakpoint: handleDebugSetBreakpoint,
    remove_breakpoint: handleDebugRemoveBreakpoint,
    list_breakpoints: handleDebugListBreakpoints,
    pause: handleDebugPause,
    resume: handleDebugResume,
    step_over: handleDebugStepOver,
    step_into: handleDebugStepInto,
    step_out: handleDebugStepOut,
    call_stack: handleDebugCallStack,
    evaluate_on_frame: handleDebugEvaluateOnFrame,
    list_scripts: handleDebugListScripts,
    get_source: handleDebugGetSource,
    override_resource: handleDebugOverrideResource,
    remove_override: handleDebugRemoveOverride,
    list_overrides: handleDebugListOverrides,
    set_dom_breakpoint: handleDebugSetDomBreakpoint,
    remove_dom_breakpoint: handleDebugRemoveDomBreakpoint,
    set_event_breakpoint: handleDebugSetEventBreakpoint,
    remove_event_breakpoint: handleDebugRemoveEventBreakpoint,
  },
```

---

### Step 12 — Update README and version

- Bump version to 4.9.0 in `server.js`, `package.json`, README badge
- Update tool count badge from 10 to 11 (adding `debug`)
- Update sub-actions count to 84+ (63 existing + 21 new debug actions)
- Add `debug` tool section to README tool reference table
- Add CHANGELOG entry for v4.9.0

**README `debug` tool table:**

```markdown
### `debug` — JavaScript Debugger & Resource Overrides

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `enable` | Enable JS debugger, start tracking scripts | `tabId` | — |
| `disable` | Disable debugger, clear breakpoints | `tabId` | — |
| `set_breakpoint` | Set breakpoint by URL + line | `tabId`, `url`, `lineNumber` | `columnNumber`, `condition` |
| `remove_breakpoint` | Remove a breakpoint | `tabId`, `breakpointId` | — |
| `list_breakpoints` | List active breakpoints | `tabId` | — |
| `pause` | Pause execution immediately | `tabId` | — |
| `resume` | Resume paused execution | `tabId` | — |
| `step_over` | Step over current statement | `tabId` | — |
| `step_into` | Step into function call | `tabId` | — |
| `step_out` | Step out of current function | `tabId` | — |
| `call_stack` | View call stack when paused | `tabId` | — |
| `evaluate_on_frame` | Evaluate expression in call frame | `tabId`, `expression` | `frameIndex` |
| `list_scripts` | List all loaded scripts | `tabId` | — |
| `get_source` | Get script source code | `tabId`, `scriptId` | — |
| `override_resource` | Register URL pattern → response body | `tabId`, `urlPattern` | `body`, `responseCode`, `headers` |
| `remove_override` | Remove a resource override | `tabId`, `urlPattern` | — |
| `list_overrides` | List active overrides | `tabId` | — |
| `set_dom_breakpoint` | Break on DOM node change | `tabId`, `uid`, `type` | — |
| `remove_dom_breakpoint` | Remove DOM breakpoint | `tabId`, `uid`, `type` | — |
| `set_event_breakpoint` | Break on event type | `tabId`, `eventName` | — |
| `remove_event_breakpoint` | Remove event breakpoint | `tabId`, `eventName` | — |
```

---

### Implementation Sequence (ordered for minimal risk)

1. **State maps + env var** (Step 1) — no behavioral change yet
2. **Cleanup in detachTab + WebSocket close** (Step 2) — safe, just adds `.delete()/.clear()` for new maps
3. **`refreshFetchPatterns` helper** (Step 3) — new function, no callers yet
4. **Refactor intercept enable/disable** (Steps 4-5) — behavior-preserving refactor of existing code
5. **Response-stage Fetch handler** (Step 6) — extends existing event handler
6. **Debugger event handling** (Step 7) — new event branches, no existing behavior changed
7. **Debugger pause guard in handleTool** (Step 8) — new guard after dialog guard
8. **Tool schema** (Step 9) — adds the tool to the MCP tool list
9. **All handler implementations** (Step 10) — the actual feature code
10. **HANDLERS dispatch map** (Step 11) — wires everything up
11. **Version bump + docs** (Step 12) — CHANGELOG, README, version numbers

### Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `Fetch.enable` clobbers existing intercept patterns when override is added | Unified `fetchPatterns` map + `refreshFetchPatterns()` merges both stages |
| `intercept.disable` kills response overrides | Refactored to only clear request-stage patterns |
| CDP glob vs JS regex semantics mismatch for response-stage overrides | Response-stage always uses `"*"` catch-all in CDP; precise matching via `new RegExp()` in event handler |
| Debugger pause permanently bricks a tab | Auto-resume timeout (30s default, configurable) |
| `Debugger.resumed` event not handled → phantom lockout | Explicit `pausedTabs.delete(sessionId)` on resumed event AND on manual resume/step calls |
| Response-stage pause falls through to request-stage handler | Response check is first, with explicit `return` before request logic |
| `DOMDebugger.setDOMBreakpoint` needs `nodeId` but we have `uid` (snapshot ref) | Full resolution chain: `uid` → `refMaps` → `backendNodeId` → `DOM.pushNodesByBackendIds` → `nodeId` |
| Large script sources exceed `MAX_INLINE_LEN` | Handled by existing `ok()` helper which auto-spills to temp file |
| Debugger pause guard deadlocks dialog handling | Guard allows `page.dialog` through when paused (same exception pattern as dialog guard) |
| Pause guard blocks read-only debug actions + override management | Guard uses `name !== "debug"` to allow ALL debug actions, not a narrow stepping-only allow-list |

### Verification Tests

| # | Test | Expected |
|---|---|---|
| 1 | `debug.enable`, load page, `debug.list_scripts` | Shows parsed scripts with URLs and line ranges |
| 2 | `debug.set_breakpoint` on a known script URL + line | Breakpoint ID returned with resolved locations |
| 3 | Trigger the breakpoint (e.g., click button that calls function) | Tab pauses. All non-debug tool calls return "Debugger is paused" error |
| 4 | `debug.call_stack` while paused | Shows frames with function names, URLs, line numbers |
| 5 | `debug.evaluate_on_frame` with simple expression | Returns evaluated value |
| 6 | `debug.resume` | Tab resumes. Other tool calls work again |
| 7 | `debug.step_over` while paused | Advances one statement, pauses again |
| 8 | Wait 30s without resuming | Auto-resume fires. Tab unblocks automatically |
| 9 | `debug.override_resource` with URL pattern + body | Override registered. Response matched on next fetch |
| 10 | Load page with a CSS/JS resource matching override pattern | Overridden content served instead of original |
| 11 | `debug.remove_override` | Override removed. Original content served again |
| 12 | `intercept.enable` + `debug.override_resource` simultaneously | Both request-stage and response-stage intercepts coexist |
| 13 | `intercept.disable` while override is active | Request intercept stops. Override remains active (Fetch stays enabled for response stage) |
| 14 | `debug.set_dom_breakpoint` on a node, then modify it via JS | Debugger pauses with DOM mutation reason |
| 15 | `debug.set_event_breakpoint` for 'click', then click element | Debugger pauses with event listener reason |
| 16 | `debug.get_source` with a script ID | Returns full source code of the script |
| 17 | `debug.disable` | Clears all breakpoints, scripts, pause state |
| 18 | `detachTab` on a tab with active debugger | All debug state maps cleaned up |

---

## Feature 4: Human-Like Interaction Consolidation (Phase 4)

### Problem

Input simulation is mechanical — no realistic mouse movement, no browsing behavior patterns, no auto-analysis snapshots around interactions. `charDelay`/`wordDelay` (v4.3.0) only covers typing.

### Current State

- **Mouse click:** `mouseMoved` → 50ms pause → `mousePressed` → `mouseReleased`. Single jump to target — no path simulation, no jitter, no overshoot.
- **Drag:** 10-step linear interpolation with 20ms per step. No bezier curves, no speed variation.
- **Scroll:** Uses `behavior: 'smooth'` (browser-native easing). No custom easing or variable speed.
- **Typing:** `charDelay`/`wordDelay` already exist (v4.3.0) with `randomDelay(baseMs)` returning `[base, base*3]`. No typos or bigram-awareness.
- **No auto-snapshots:** Snapshots are only taken on explicit `page.snapshot` calls. Agents must make separate round-trips to see what changed after an action.
- **`waitForCompletion`** wraps 7 of 12 interact handlers (click, type, fill, select, press, check, tap). Not used by hover, drag, scroll, upload, focus.

### Architecture Decision

**Extend `interact` with `humanMode` and `autoSnapshot` booleans** — NOT a separate `human` tool. Rationale:
- Avoids duplicating 12 handler functions
- Agents use the same familiar action names (`click`, `hover`, `type`, etc.)
- `humanMode` can be combined with any action (`click` + `humanMode: true`)
- `autoSnapshot` works independently of `humanMode` — useful even for mechanical actions

---

### Required Changes

### Step 1 — Add `generateBezierPath` helper

Add near the `randomDelay` function (~line 812):

```js
/**
 * Generate a natural-looking mouse path using a randomized cubic bezier curve.
 * Includes slight overshoot, speed variation, and jitter for anti-detection.
 * @param {{x,y}} from - start point
 * @param {{x,y}} to - end point
 * @param {number} [steps=20] - number of intermediate points
 * @param {number} [jitter=2] - max random pixel offset per point
 * @returns {{x:number, y:number}[]} array of {x, y} points along the path
 */
function generateBezierPath(from, to, steps = 20, jitter = 2) {
  // Random control points for cubic bezier — offset from the straight line
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  // Control point spread scales with distance — shorter moves need less curve
  const spread = Math.min(dist * 0.3, 100);
  const cp1 = {
    x: from.x + dx * 0.2 + (Math.random() - 0.5) * spread,
    y: from.y + dy * 0.2 + (Math.random() - 0.5) * spread,
  };
  const cp2 = {
    x: from.x + dx * 0.8 + (Math.random() - 0.5) * spread,
    y: from.y + dy * 0.8 + (Math.random() - 0.5) * spread,
  };
  
  // Slight overshoot — target extends 3–8px past the actual target
  const overshoot = 3 + Math.random() * 5;
  const angle = Math.atan2(dy, dx);
  const overshootTarget = {
    x: to.x + Math.cos(angle) * overshoot,
    y: to.y + Math.sin(angle) * overshoot,
  };
  
  const points = [];
  // Phase 1: Move to overshoot point (80% of steps)
  const mainSteps = Math.round(steps * 0.8);
  for (let i = 0; i <= mainSteps; i++) {
    const t = i / mainSteps;
    const mt = 1 - t;
    // Cubic bezier: B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
    const x = mt*mt*mt * from.x + 3*mt*mt*t * cp1.x + 3*mt*t*t * cp2.x + t*t*t * overshootTarget.x;
    const y = mt*mt*mt * from.y + 3*mt*mt*t * cp1.y + 3*mt*t*t * cp2.y + t*t*t * overshootTarget.y;
    // Add jitter (less at start and end, more in the middle)
    const jitterScale = Math.sin(t * Math.PI); // peaks at t=0.5
    points.push({
      x: x + (Math.random() - 0.5) * jitter * jitterScale,
      y: y + (Math.random() - 0.5) * jitter * jitterScale,
    });
  }
  // Phase 2: Correction from overshoot back to actual target (20% of steps)
  const corrSteps = steps - mainSteps;
  for (let i = 1; i <= corrSteps; i++) {
    const t = i / corrSteps;
    points.push({
      x: overshootTarget.x + (to.x - overshootTarget.x) * t + (Math.random() - 0.5) * jitter * 0.3,
      y: overshootTarget.y + (to.y - overshootTarget.y) * t + (Math.random() - 0.5) * jitter * 0.3,
    });
  }
  
  return points;
}
```

**Key behaviors:**
- Cubic bezier curve with randomized control points (not linear)
- Overshoot by 3–8px past target, then correct back (natural hand movement)
- Jitter peaks in the middle of the movement, minimal at endpoints
- Control point spread scales with distance — short moves are nearly straight, long moves curve more

---

### Step 2 — Add `humanMode` to mouse-based interact handlers

When `args.humanMode === true`, replace the single `mouseMoved` with a bezier path.

**`handleInteractClick`** — replace the mouse dispatch block inside `waitForCompletion`:

```js
// Inside waitForCompletion callback:
if (args.humanMode) {
  // Get current mouse position (use 0,0 if unknown)
  const startX = args._lastMouseX || 0;
  const startY = args._lastMouseY || 0;
  const path = generateBezierPath({ x: startX, y: startY }, { x: el.x, y: el.y });
  for (let i = 0; i < path.length; i++) {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: path[i].x, y: path[i].y, modifiers: mods }, sess);
    // Variable speed: slower near target (last 30%), faster in middle
    const progress = i / path.length;
    const delay = progress > 0.7 ? 15 + Math.random() * 20 : 5 + Math.random() * 10;
    await sleep(delay);
  }
  // Final small pause before click (like a human hesitating)
  await sleep(30 + Math.random() * 50);
} else {
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y, modifiers: mods }, sess);
  await sleep(50);
}
// mousePressed + mouseReleased unchanged
```

**`handleInteractHover`** — same bezier path, no click:

```js
if (args.humanMode) {
  const path = generateBezierPath({ x: 0, y: 0 }, { x: el.x, y: el.y });
  for (const pt of path) {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, modifiers: mods }, sess);
    await sleep(5 + Math.random() * 15);
  }
} else {
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y, modifiers: mods }, sess);
}
```

**`handleInteractDrag`** — replace linear interpolation with bezier:

```js
if (args.humanMode) {
  const path = generateBezierPath({ x: src.x, y: src.y }, { x: tgt.x, y: tgt.y }, 25, 3);
  for (const pt of path) {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }, sess);
    await sleep(10 + Math.random() * 15);
  }
} else {
  // Existing 10-step linear interpolation
  const steps = 10;
  for (let i = 1; i <= steps; i++) { ... }
}
```

---

### Step 3 — Add `typoRate` for human-like typing errors

Extend the existing `charDelay`/`wordDelay` typing block in `handleInteractType` with an optional `typoRate` parameter (probability of typing a wrong character then backspace-correcting).

```js
// Inside the charDelay/wordDelay block, before dispatching each char:
if (args.typoRate && args.typoRate > 0 && Math.random() < args.typoRate && char.match(/[a-zA-Z]/)) {
  // Type a wrong character (adjacent key)
  const wrongChar = getAdjacentKey(char);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: wrongChar, key: wrongChar }, sess);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: wrongChar }, sess);
  await sleep(randomDelay(charBase * 2)); // pause — "noticing" the mistake
  // Backspace to correct
  const bk = resolveKey("Backspace");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...bk }, sess);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...bk }, sess);
  await sleep(randomDelay(charBase * 0.5)); // quick correction
}
// Then type the correct char as normal
```

**`getAdjacentKey` helper** — returns a character near the target key on a QWERTY keyboard:

```js
const QWERTY_NEIGHBORS = {
  q: "wa", w: "qeas", e: "wrds", r: "etfs", t: "rygs", y: "tuhj",
  u: "yijk", i: "uokl", o: "iplm", p: "ol",
  a: "qwsz", s: "weadxz", d: "ersfxc", f: "rtdgcv", g: "tyfhvb",
  h: "yugjbn", j: "uihknm", k: "iojlm", l: "opk",
  z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn",
  n: "bhjm", m: "njk",
};

function getAdjacentKey(char) {
  const lower = char.toLowerCase();
  const neighbors = QWERTY_NEIGHBORS[lower];
  if (!neighbors) return char;
  const picked = neighbors[Math.floor(Math.random() * neighbors.length)];
  return char === char.toUpperCase() ? picked.toUpperCase() : picked;
}
```

Add `typoRate` to the interact tool schema:
```js
typoRate: { type: "number", description: "Probability of typing a wrong character then correcting (0-1, e.g. 0.03 = 3% per char). Requires charDelay or wordDelay." },
```

---

### Step 4 — Add `autoSnapshot` wrapper in `handleTool`

Add an `autoSnapshot` flag that wraps any interact action with before/after snapshot diffing. This goes in `handleTool` AFTER the handler call, not inside each handler — single entry point.

```js
// In handleTool, after the handler returns result:
if (name === "interact" && args.autoSnapshot && args.tabId) {
  // autoSnapshot was requested — the before snapshot was taken earlier
  const afterSess = activeSessions.get(args.tabId);
  if (afterSess && args._beforeSnapshot) {
    try {
      const afterSnap = await buildSnapshot(afterSess);
      const before = args._beforeSnapshot;
      let snapInfo = "";
      
      if (before.url !== afterSnap.url) {
        // Navigation occurred
        snapInfo = `\n\n### Navigation Detected\n${before.url} → ${afterSnap.url}\n\n### New Page Snapshot\n${afterSnap.snapshot}`;
      } else {
        const diff = computeSnapshotDiff(before.snapshot.split("\n"), afterSnap.snapshot.split("\n"));
        if (diff.changed && diff.lines.length > 0) {
          snapInfo = `\n\n### Snapshot Changes (${diff.added} added, ${diff.removed} removed)\n${diff.lines.join("\n")}`;
        } else {
          snapInfo = "\n\n### No visible changes detected";
        }
      }
      
      // Append snapshot info to the result
      if (result.content?.[0]?.type === "text") {
        result.content[0].text += snapInfo;
      }
      
      // Update lastSnapshots for incremental diffing on next page.snapshot call
      lastSnapshots.set(afterSess, { snapshot: afterSnap.snapshot, url: afterSnap.url, title: afterSnap.title });
    } catch { /* snapshot failed — don't break the action result */ }
  }
}
```

**Before the handler call** (in `handleTool`, after tab lock check):
```js
// Capture before-snapshot if autoSnapshot requested
if (name === "interact" && args.autoSnapshot && args.tabId) {
  try {
    const sess = activeSessions.get(args.tabId);
    if (sess) {
      const beforeSnap = await buildSnapshot(sess);
      args._beforeSnapshot = beforeSnap;
    }
  } catch { /* ok — will just skip the diff */ }
}
```

Add `autoSnapshot` to the interact tool schema:
```js
autoSnapshot: { type: "boolean", description: "Take accessibility snapshots before and after the action, return a diff of changes. Useful for understanding what the action changed without a separate snapshot call." },
```

And add `humanMode` to the interact tool schema:
```js
humanMode: { type: "boolean", description: "Enable human-like interaction: bezier curve mouse paths, natural speed variation, slight overshoot. For click, hover, drag actions." },
```

**Cleanup:** Strip `_beforeSnapshot` from args after use:
```js
delete args._beforeSnapshot;
```

---

### Step 5 — Update interact tool description

Add to the interact description:
```
"Human-like mode: Set humanMode: true for realistic mouse paths (bezier curves, overshoot, jitter). Works with click, hover, drag. Combine with charDelay/wordDelay + typoRate for human typing.",
"Auto-snapshot: Set autoSnapshot: true to get a before/after diff appended to the action response — shows what changed without a separate snapshot call.",
```

---

### Step 6 — Schema additions summary

Add to `interact` inputSchema properties:

```js
humanMode: { type: "boolean", description: "Enable human-like interaction: bezier curve mouse paths, natural speed variation, slight overshoot. For click, hover, drag actions." },
autoSnapshot: { type: "boolean", description: "Take accessibility snapshots before and after the action, return a diff of changes. Useful for understanding what the action changed without a separate snapshot call." },
typoRate: { type: "number", description: "Probability of typing a wrong character then correcting (0-1, e.g. 0.03 = 3% per char). Requires charDelay or wordDelay." },
```

---

### Verification Tests

| # | Test | Expected |
|---|---|---|
| 1 | `interact.click` with `humanMode: true` on a button | Mouse moves along curved path (visible in Chrome's mouse cursor trail if DevTools is open). Click succeeds. |
| 2 | `interact.click` with `humanMode: false` (default) | Same as current — single jump to target. No behavior change for existing users. |
| 3 | `interact.hover` with `humanMode: true` | Mouse follows bezier path to element. Tooltip appears. |
| 4 | `interact.drag` with `humanMode: true` | Element dragged along curved path, not linear. |
| 5 | `interact.type` with `charDelay: 100, typoRate: 0.05` | Some characters are mistyped then corrected with backspace. |
| 6 | `interact.type` with `typoRate: 0` or omitted | No typos — same as current behavior. |
| 7 | `interact.click` with `autoSnapshot: true` | Response includes diff showing DOM changes after the click. |
| 8 | `interact.click` with `autoSnapshot: true` that triggers navigation | Response shows "Navigation Detected: url1 → url2" + new page snapshot. |
| 9 | `interact.type` with `autoSnapshot: true` | Shows text input value change in diff. |
| 10 | `interact.click` without `autoSnapshot` | No snapshot taken — same as current. Performance identical. |

---

## Feature 3: Playwright Audit — Priority A (Phase 3)

### Problem

Five high-impact Playwright features are missing: auto-retry with actionability checks, frame-scoped CSS selector interaction, `page.setContent()`, `page.addStyleTag()`, and touch events. These are the biggest API gaps between this server and Playwright's capabilities.

### Current State

- **Auto-retry:** Zero retry logic. Every handler makes a single attempt. Only `click` calls `checkActionability` (~line 944). All other interact actions (`hover`, `type`, `fill`, `select`, `drag`, `scroll`, `upload`, `focus`, `check`) skip visibility/disabled/size checks entirely.
- **Frame interaction:** `buildSnapshot` already includes iframe content with `[frame N]` prefixes and global `backendNodeId` refs. `resolveElement` (uid path) works cross-frame via `DOM.resolveNode({ backendNodeId })`. **CSS selector path fails** — it uses `Runtime.evaluate` in the top-level frame only, can't find elements inside iframes.
- **`setContent()`:** Not implemented. `content` action is read-only. `Page.setDocumentContent` not used anywhere.
- **`addStyleTag()`:** No CSS injection exists. `inject` action only handles JavaScript via `Page.addScriptToEvaluateOnNewDocument`.
- **Touch:** `Emulation.setTouchEmulationEnabled` exists in `emulate` tool, but no `Input.dispatchTouchEvent` — can't actually tap elements.

---

### Required Changes

### Step 1 — Add `withRetry` helper for auto-retry

Add near `checkActionability` (~line 1000):

```js
/**
 * Retry a function until it succeeds or timeout expires.
 * Used to wrap element resolution + actionability checks for Playwright-style auto-waiting.
 * @param {Function} fn - async function to retry
 * @param {object} opts - { timeout: 5000, interval: 200 }
 */
async function withRetry(fn, { timeout = 5000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (true) {
    try { return await fn(); }
    catch (e) {
      lastError = e;
      // Fast-fail on errors that will never recover with retries:
      // - Stale uid refs require a new snapshot (refMaps is static between snapshots)
      // - Missing input params are user errors, not transient failures
      const msg = e.message || "";
      if (msg.includes("ref=") && msg.includes("not found")) throw e;
      if (msg.includes("Provide either")) throw e;
      if (Date.now() + interval > deadline) throw lastError;
      await sleep(interval);
    }
  }
}
```

**Fast-fail rules:** Stale uid errors (containing `"ref="` + `"not found"`) throw immediately because `refMaps` is static between snapshots — retrying the same uid will always fail. CSS selector `"Element not found"` errors do NOT fast-fail because the element may appear dynamically. User input errors (`"Provide either"`) also fast-fail.

---

### Step 2 — Apply `checkActionability` to ALL interaction handlers with retry

Currently only `click` checks actionability. Every handler that targets an element should use `checkActionability` (which calls `resolveElement` internally) wrapped in `withRetry`.

**Handlers to update:**

| Handler | Current | Change to |
|---|---|---|
| `handleInteractClick` | `checkActionability(sess, args.uid, args.selector)` | Wrap in `withRetry` |
| `handleInteractHover` | `resolveElement(...)` | `withRetry(() => checkActionability(...))` |
| `handleInteractType` | `resolveElementObjectId(...)` | `withRetry(() => checkActionability(...))` + separate `resolveElementObjectId` |
| `handleInteractFill` | `resolveElementObjectId(...)` per field | `withRetry` per field |
| `handleInteractSelect` | `resolveElementObjectId(...)` | `withRetry(() => checkActionability(...))` |
| `handleInteractDrag` | `resolveElement(...)` x2 | `withRetry` for both source + target |
| `handleInteractScroll` | `resolveElementObjectId(...)` (optional) | `withRetry` if uid/selector provided |
| `handleInteractUpload` | `resolveElementObjectId(...)` | `withRetry` |
| `handleInteractFocus` | `resolveElementObjectId(...)` | `withRetry` |
| `handleInteractCheck` | `resolveElementObjectId(...)` | `withRetry(() => checkActionability(...))` |

**Pattern for handlers that need both coordinates AND objectId** (like `type`, `select`, `check`):

**Critical: Bundle `resolveElementObjectId` inside the `withRetry` block** alongside `checkActionability`. If they are separate sequential calls, a page re-render in the microsecond gap between them causes `resolveElementObjectId` to fail with an unhandled crash. Bundling them ensures the retry loop catches and retries both together:

```js
async function handleInteractType(args) {
  if (!args.text) return fail("Provide 'text' to type.");
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  
  // Bundle actionability + object resolution in one retry block to avoid race conditions
  const objectId = await withRetry(async () => {
    await checkActionability(sess, args.uid, args.selector);
    return resolveElementObjectId(sess, args.uid, args.selector);
  }, { timeout: retryTimeout });
  
  // ... rest of handler unchanged
}
```

**Handlers that MUST bundle both calls:** `handleInteractType`, `handleInteractFill` (per field), `handleInteractSelect`, `handleInteractCheck`. These all require `objectId` — if it fails, the tool call crashes.

**Handlers that are fine without bundling:**
- `handleInteractClick` — objectId resolution is already wrapped in try/catch and is optional (used for JS click fallback only; click still works via CDP mouse events)
- `handleInteractHover` — uses `resolveElement` only (no objectId needed)
- `handleInteractUpload`, `handleInteractFocus`, `handleInteractScroll` — `resolveElementObjectId` is already inside `withRetry` (no separate checkActionability call)

**For `hover`** (doesn't need actionability checks — Playwright's hover doesn't require enabled/visible):
```js
const el = await withRetry(() => resolveElement(sess, args.uid, args.selector), { timeout: retryTimeout });
```

---

### Step 3 — Add `timeout` parameter to `interact` tool schema

Add to the `interact` inputSchema properties (~line 1342):

```js
timeout: { type: "number", description: "Retry timeout in ms for element resolution and actionability (default: 5000ms). Element is polled until found+actionable or timeout." },
```

This is separate from `page.wait`'s timeout — this controls how long to retry finding/waiting for an element before giving up. Matches Playwright's `locator.click({ timeout })` pattern.

---

### Step 4 — Add `page.set_content` action

Add to the `page` tool schema action enum (~line 1253):
```
"set_content"
```

Add to `page` inputSchema properties:
```js
html: { type: "string", description: "HTML content for set_content action." },
```

Add to page description:
```
"- set_content: Set the page's HTML content directly (requires: tabId, html)",
```

**Handler:**

```js
async function handlePageSetContent(args) {
  if (!args.html) return fail("Provide 'html' content.");
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");
  
  // Get the root frame ID
  const { frameTree } = await cdp("Page.getFrameTree", {}, sess);
  const frameId = frameTree.frame.id;
  
  await cdp("Page.setDocumentContent", { frameId, html: args.html }, sess);
  
  // Wait for the content to be ready
  await sleep(200);
  
  return ok(`Page content set (${args.html.length} chars).`);
}
```

**Register in dispatch map:**
```js
set_content: handlePageSetContent,
```

---

### Step 5 — Add `page.add_style` action

Add to the `page` tool schema action enum:
```
"add_style"
```

Add to `page` inputSchema properties:
```js
css: { type: "string", description: "CSS content for add_style action." },
cssUrl: { type: "string", description: "URL of external stylesheet for add_style action." },
persistent: { type: "boolean", description: "If true, style persists across page navigations (default: false)." },
```

Add to page description:
```
"- add_style: Inject CSS into the page — either inline content or an external stylesheet URL (requires: tabId, css or cssUrl; optional: persistent — survives navigation)",
```

**Handler:**

```js
async function handlePageAddStyle(args) {
  if (!args.css && !args.cssUrl) return fail("Provide 'css' (inline content) or 'cssUrl' (external stylesheet URL).");
  const sess = await getTabSession(args.tabId);
  
  if (args.persistent) {
    // Use Page.addScriptToEvaluateOnNewDocument to inject CSS on every load.
    // IMPORTANT: addScriptToEvaluateOnNewDocument runs before DOM is constructed,
    // so document.head may be null. Must defer to DOMContentLoaded if head doesn't exist yet.
    await ensureDomain(sess, "Page");
    const code = args.css
      ? `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(args.css)}; const insert = () => (document.head || document.documentElement).appendChild(s); if (document.head) insert(); else document.addEventListener('DOMContentLoaded', insert); })()`
      : `(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(args.cssUrl)}; const insert = () => (document.head || document.documentElement).appendChild(l); if (document.head) insert(); else document.addEventListener('DOMContentLoaded', insert); })()`;
    const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: code }, sess);
    // Also execute immediately on current page (head exists here since page is already loaded)
    await cdp("Runtime.evaluate", { expression: code }, sess);
    const scripts = injectedScripts.get(sess) || [];
    scripts.push({ identifier, description: `[CSS] ${(args.css || args.cssUrl).substring(0, 60)}` });
    injectedScripts.set(sess, scripts);
    return ok(`Style injected (persistent, id: ${identifier}).`);
  }
  
  // Non-persistent — inject into current page only
  const code = args.css
    ? `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(args.css)}; document.head.appendChild(s); return { ok: true }; })()`
    : `(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(args.cssUrl)}; document.head.appendChild(l); return { ok: true }; })()`;
  
  const result = await cdp("Runtime.evaluate", { expression: code, returnByValue: true }, sess);
  if (result.exceptionDetails) return fail("Failed to inject style: " + (result.exceptionDetails.exception?.description || "unknown error"));
  
  return ok(`Style injected${args.css ? ` (${args.css.length} chars)` : ` (${args.cssUrl})`}.`);
}
```

**Register in dispatch map:**
```js
add_style: handlePageAddStyle,
```

---

### Step 6 — Add `interact.tap` action for touch events

Add `"tap"` to the `interact` tool schema action enum (~line 1342).

Add to interact description:
```
"- tap: Tap an element using touch events (requires: tabId, uid or selector)",
```

**Handler:**

```js
async function handleInteractTap(args) {
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  const el = await withRetry(() => checkActionability(sess, args.uid, args.selector), { timeout: retryTimeout });
  
  const { networkEvents } = await waitForCompletion(sess, async () => {
    await cdp("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(el.x), y: Math.round(el.y) }],
    }, sess);
    await sleep(50);
    await cdp("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    }, sess);
  });
  
  let msg = `Tapped <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
}
```

**Register in dispatch map:**
```js
tap: handleInteractTap,
```

---

### Step 7 — Frame-scoped CSS selector interaction (partial — uid already works)

**Good news:** The uid-based path (`DOM.resolveNode({ backendNodeId })`) already works cross-frame because `backendNodeId` is page-global. Agents using snapshots + uid refs can already interact with iframe elements.

**The gap:** CSS selector path in `resolveElement` and `resolveElementObjectId` uses `Runtime.evaluate` in the top-level frame. `document.querySelector(...)` won't find elements inside iframes.

**MVP fix — document the limitation clearly:**

Update the `interact` tool description to note:
```
"Frame interaction: Use 'uid' from snapshots to interact with elements inside iframes — CSS selectors only find top-level elements. Snapshot includes iframe content with [frame N] prefixes.",
```

**Full fix (if needed later):** Add optional `frameId` parameter to `resolveElement`/`resolveElementObjectId` that evaluates `Runtime.evaluate` with a specific `executionContextId` (from the `executionContexts` map added in Feature 5). This requires the execution context tracking infrastructure described in the Phase 5 plan.

**For Phase 3 MVP, the uid path covers the need.** Agents should:
1. Take a snapshot (includes iframe content with refs)
2. Use the ref uid to interact — `DOM.resolveNode` handles the cross-frame resolution automatically
3. CSS selectors work only for top-level elements

---

### Verification Tests

| # | Test | Expected |
|---|---|---|
| 1 | Click a hidden element (display:none). Wait for it to become visible via JS. | `withRetry` polls until visible, then clicks. |
| 2 | Click an element that doesn't exist yet. Another script adds it after 2s. | Retries for up to `timeout`, finds element, clicks. |
| 3 | `interact.click` on disabled button with `timeout: 1000`. | Fails after 1s with "disabled" error. |
| 4 | `interact.hover` on element inside same-origin iframe (via uid from snapshot). | Hovers at correct global coordinates (backendNodeId resolves cross-frame). |
| 5 | `interact.type` with `timeout: 3000` on an input that appears after 1s. | Retries, finds input, types successfully. |
| 6 | `page.set_content` with `<h1>Hello</h1>`. Take snapshot. | Snapshot shows the h1 element. |
| 7 | `page.add_style` with `body { background: red }`. Take screenshot. | Screenshot shows red background. |
| 8 | `page.add_style` with `persistent: true`, then navigate. | Style persists on new page. |
| 9 | `interact.tap` on a button. | Touch events dispatched, button activated. |
| 10 | `interact.tap` on a hidden element. | Retries with actionability check, fails if never visible. |

---

## Feature 5: Playwright Audit — Priority B+C (Phase 6)

### Priority B (Medium-Impact)

| Feature | Description |
|---|---|
| **Download save/path** | Currently only tracks downloads. Add `downloads.save` to retrieve file content. |
| **HAR export** | Compile `networkReqs` data into HAR format on demand. |
| **Full HTML `page.content()`** | Return complete `<!DOCTYPE>` HTML via `document.documentElement.outerHTML`. |
| **Popup/new-window detection** | Listen for `Target.targetCreated` events, auto-track popups opened by page actions. |
| **Snapshot overflow visual fallback** | When `page.snapshot` output exceeds `MAX_INLINE_LEN` (60KB), the shared `ok()` spills to a temp `.txt` file but agents lose immediate visual context. Fix: also auto-capture a screenshot and include a reference/path alongside the spilled text. Keep existing text-file behavior, append screenshot artifact for quick page-state review. |
| **Tab origin tracking** | ~~Track per-tab acquisition origin in session metadata~~ **PROMOTED to Phase 4.2** — now includes `cleanup.reset` action. See Phase 4.2 section below. |

### Priority C (Code Consistency)

| Area | Issue |
|---|---|
| **Unit values** | Verify all time params are in ms. PDF margins are in inches per Chrome spec (acceptable). |
| **Error messages** | Standardize format across all handlers. |
| **Handler structure** | Normalize element resolution patterns across handlers. |

---

## Phase 4.1: Security Hardening

### Problem

Session identity is caller-controlled via `args.sessionId` in `handleTool`. Since `StdioServerTransport` provides no transport-level caller identity, any agent can impersonate any other session by sending `sessionId = victimSessionId`. All ownership guards (tab locks, `tabs.close`, `cleanup.disconnect_tab`, `cleanup.session`) trust this user-supplied identity and are therefore bypassable. Combined with `cleanup.list_sessions` exposing full session UUIDs, a complete exploit chain exists: enumerate IDs → spoof sessionId → perform privileged action as victim.

### Threat Model

Multiple concurrent LLM agent workers share one MCP server process. Each worker constructs its own tool args including `sessionId`. Workers cannot be trusted to respect session boundaries — they may accidentally or intentionally send another worker's session ID.

### Root Cause

`StdioServerTransport` is a single-pipe transport with no multiplexing or caller identity. The server has no way to cryptographically verify "who" is making a call. Session isolation is therefore **cooperative** — but the server leaks the credentials (full UUIDs) needed to break cooperation.

### Security Model: Session ID = Credential (Opacity)

Session UUIDs are already cryptographically random (`randomUUID()` = 122 bits of entropy). They are unguessable. The fix is to **treat session IDs as credentials** and never expose them:

- **Session IDs must never be returned in full** in any output that could reach another session
- **Enumeration must not leak usable credentials** — truncate to first 8 chars (diagnostic only)
- **Error messages must not leak other sessions' IDs** — use generic "another session" phrasing

With this model, spoofing requires guessing a UUID (2^122 possibilities) — computationally infeasible.

### Required Changes

### Step 1 — Truncate session IDs in `cleanup.list_sessions`

In `handleCleanupListSessions`, replace `${id}` with `${id.substring(0, 8)}…`:

```js
let section = `Session: ${id.substring(0, 8)}…\n  Last activity: ${age}s ago | TTL remaining: ${ttl}s\n  Cleanup strategy: ${s.cleanupStrategy || "close"}\n  Owned tabs: ${ownedTabs.length}`;
```

This preserves diagnostic usefulness (agents can identify their own session by the first 8 chars) while making the full UUID unavailable for spoofing.

### Step 2 — Truncate session IDs in `cleanup.session` response

```js
return ok(`Session ${sid.substring(0, 8)}… ended. ${cleaned} owned tab(s) ${strategy === "close" ? "closed" : "detached"}.`);
```

### Step 3 — Audit all error/response messages for session ID leaks

Ensure no code path returns a full session UUID belonging to another session. Locations to check:
- Lock conflict error in `handleTool`: currently says "locked by another agent session" — ✅ no ID leaked
- `tabs.list` lock tags: already truncated (`lockOwner.substring(0, 8)`) — ✅ safe
- `cleanup.status`: shows session count, not IDs — ✅ safe  
- `browser.connect` rejection: shows truncated IDs (`id.substring(0, 8)`) — ✅ safe

### Step 4 — Scope `cleanup.clean_temp` to caller's session

Currently `cleanupTempFiles()` deletes ALL files in the shared `TEMP_DIR`. One session can destroy another's debugging artifacts (screenshots, spilled snapshots).

**Fix: Prefix temp filenames with session ID at write time, scope cleanup to caller's files.**

**Two-layer approach:**

1. **Writers prefix filenames** — callers that have session context (`args._agentSessionId`) pass it to `writeTempFile` as a prefix. This creates files like `abc12345_response-1234.bin`.
2. **Cleanup scopes by prefix** — `handleCleanupCleanTemp` only deletes files matching the caller's prefix + unprefixed legacy files.

**Limitation:** The `ok()` helper spills large outputs to temp files but has no session context (it's a low-level function used everywhere). These spilled files remain unprefixed and get cleaned by any session's `clean_temp` call. This is acceptable because:
- `autoCleanupTempFiles()` handles age-based (30-minute) global cleanup
- `ok()` spills are transient diagnostic output, not long-lived artifacts

Modify `writeTempFile` to accept an optional session prefix:

```js
function writeTempFile(name, content, encoding = "utf8", sessionPrefix = null) {
  ensureTempDir();
  autoCleanupTempFiles();
  const fileName = sessionPrefix ? `${sessionPrefix.substring(0, 8)}_${name}` : name;
  const p = join(TEMP_DIR, fileName);
  writeFileSync(p, content, encoding);
  return p;
}
```

**Update all callers that have session context:**

- `handleObserveRequest`: `writeTempFile(\`response-...\`, decoded, null, args._agentSessionId)`
- `handlePagePdf`: Uses direct `writeFileSync` — prefix the filename: `` `${prefix}page-${Date.now()}.pdf` ``
- `ok()` spill: No change — stays unprefixed (no session context available)

**`handleCleanupCleanTemp`** scopes deletion:

```js
async function handleCleanupCleanTemp(args) {
  if (!existsSync(TEMP_DIR)) return ok("No temp directory.");
  const prefix = args._agentSessionId ? args._agentSessionId.substring(0, 8) + "_" : null;
  const files = readdirSync(TEMP_DIR);
  let count = 0;
  for (const f of files) {
    // Only delete files belonging to this session, or unprefixed legacy files
    if (!prefix || f.startsWith(prefix) || !f.match(/^[a-f0-9]{8}_/)) {
      try { unlinkSync(join(TEMP_DIR, f)); count++; } catch {}
    }
  }
  return ok(`Cleaned up ${count} temp file(s) from ${TEMP_DIR}`);
}
```

### Step 5 — Add `processSessionId` opacity guard

The `processSessionId` (auto-assigned root session) should never appear in output. It's the fallback when no `sessionId` is provided — if leaked, any caller that omits `sessionId` becomes root.

Check: Does any response message include `processSessionId`?
- `cleanup.session` response: `${sid}` — if caller is the root session, this leaks it. **Fix:** Always truncate (Step 2 already handles this).
- `cleanup.list_sessions`: lists all sessions including root. **Fix:** Step 1 already truncates.

No additional changes needed — Steps 1-2 cover this.

### Verification Tests

| # | Test | Expected |
|---|---|---|
| 1 | `cleanup.list_sessions` with 3 active sessions | Session IDs shown as `abc12345…` (8 chars + ellipsis), NOT full UUIDs |
| 2 | Session A calls `cleanup.session` | Response shows `abc12345… ended.` — truncated |
| 3 | Session B tries `sessionId = <full UUID of session A>` (guessing) | Only succeeds if exact UUID known — and no API exposes it |
| 4 | `cleanup.clean_temp` called by session A | Only deletes session A's temp files + unprefixed legacy files |
| 5 | `tabs.list` with `showAll: true` showing locked tabs | Lock owners shown as `abc12345…` — already truncated |
| 6 | Omit `sessionId` (falls back to `processSessionId`) | Root session ID never appears in any output in full |

---

## Phase 4.2: Tab Origin Tracking + cleanup.reset

### Problem

`tabLocks` stores only `tabId → sessionId` (a string). There is no distinction between tabs created via `tabs.new` and pre-existing browser tabs claimed by first reference. When a session expires or calls `cleanup.session`, both types receive the same treatment — pre-existing user tabs get closed/detached, which is destructive and unexpected.

A `cleanup.reset` (master-clear) action is needed for production multi-agent workflows: terminate all sessions, with an option to close their created tabs, but **never** close tabs that were originally open in the browser before any agent touched them.

### Threat Model

Main agent opens Chrome. 5 user tabs are already open. Agent creates 3 new tabs for work. If the user or orchestrator calls "reset," the 3 created tabs should be closable, but the 5 original user tabs must survive.

### Required Changes

### Step 1 — Refactor `tabLocks` value type

Change from `Map<tabId, sessionId>` to `Map<tabId, { sessionId, origin }>`:

```js
const tabLocks = new Map(); // tabId → { sessionId, origin: "created"|"claimed" }
```

Origins:
- `"created"` — tab was opened via `tabs.new`
- `"claimed"` — tab already existed in browser and was first referenced by a session
- Borrowed tabs (via `exclusive: false`) are NOT in `tabLocks` — the borrower only appears in `session.tabIds`

### Step 2 — Update `handleTabsNew`

```js
tabLocks.set(targetId, { sessionId: args._agentSessionId, origin: "created" });
```

### Step 3 — Update `handleTool` tab association

In the `if (!lockOwner)` block:

```js
if (!lockOwner) {
  tabLocks.set(args.tabId, { sessionId, origin: "claimed" });
}
```

### Step 4 — Update ALL `tabLocks.get()` read sites

Every location that reads `tabLocks.get(tabId)` and compares the result to a session ID must access `.sessionId` instead. Affected locations (~11 sites):

| Location | Current code | Updated code |
|---|---|---|
| `sweepStaleSessions` | `tabLocks.get(tid) === id` | `tabLocks.get(tid)?.sessionId === id` |
| `handleTabsList` lock tag | `lockOwner && lockOwner !== ...` | `lockOwner?.sessionId && lockOwner.sessionId !== ...` |
| `handleTabsFind` lock tag | same pattern | same fix |
| `handleTabsClose` guard | `lockOwner && lockOwner !== ...` | `lockOwner?.sessionId && lockOwner.sessionId !== ...` |
| `handleCleanupDisconnectTab` | `lockOwner && lockOwner !== ...` | `lockOwner?.sessionId && lockOwner.sessionId !== ...` |
| `handleCleanupDisconnectAll` | `!lockOwner \|\| lockOwner === ...` | `!lockOwner \|\| lockOwner.sessionId === ...` |
| `handleCleanupListSessions` owned | `tabLocks.get(tid) === id` | `tabLocks.get(tid)?.sessionId === id` |
| `handleCleanupListSessions` borrowed | `tabLocks.get(tid) !== id` | `tabLocks.get(tid)?.sessionId !== id` |
| `handleCleanupSession` | `tabLocks.get(tid) === sid` | `tabLocks.get(tid)?.sessionId === sid` |
| `handleTool` lock check | `lockOwner && lockOwner !== sessionId` | `lockOwner?.sessionId && lockOwner.sessionId !== sessionId` |
| `handleTool` tabs.list lock tag | `lockOwner && lockOwner !== sessionId` | `lockOwner?.sessionId && lockOwner.sessionId !== sessionId` |

**Pattern:** Every `tabLocks.get(x)` result should be treated as `{ sessionId, origin }` or `undefined`. Use optional chaining (`?.sessionId`) for safe access.

Also update lock tag display: `lockOwner.substring(0, 8)` → `lockOwner.sessionId.substring(0, 8)` in tabs.list and tabs.find.

### Step 5 — Update `detachTab` lock cleanup

`detachTab` calls `tabLocks.delete(tabId)` — this is shape-agnostic, no change needed.

### Step 6 — Add `cleanup.reset` action

Add `"reset"` to the cleanup tool schema action enum and handler dispatch.

Add to cleanup schema properties:
```js
closeTabs: { type: "boolean", description: "Close tabs created by sessions (default: false). Pre-existing claimed tabs are NEVER closed." },
```

Add to cleanup description:
```
"- reset: Terminate ALL sessions and release all tab locks. Created tabs can optionally be closed (closeTabs: true), but pre-existing browser tabs are always preserved. (optional: closeTabs)",
```

**Handler:**

```js
async function handleCleanupReset(args) {
  const closeTabs = args.closeTabs || false;
  let closedCount = 0, detachedCount = 0, preservedCount = 0;
  
  for (const [id, s] of agentSessions) {
    for (const tid of s.tabIds) {
      const lock = tabLocks.get(tid);
      if (!lock || lock.sessionId !== id) continue; // skip borrowed or unowned
      
      if (lock.origin === "claimed") {
        // NEVER close pre-existing tabs — release lock + detach only
        await detachTab(tid);
        preservedCount++;
      } else if (lock.origin === "created" && closeTabs) {
        try { await cleanupTab(tid, "close"); } catch {}
        closedCount++;
      } else {
        await detachTab(tid);
        detachedCount++;
      }
    }
    s.tabIds.clear();
  }
  const sessionCount = agentSessions.size;
  agentSessions.clear();
  tabLocks.clear();
  
  return ok(`Reset complete. ${sessionCount} session(s) cleared.\n` +
    `Created tabs: ${closeTabs ? closedCount + " closed" : detachedCount + " detached"}\n` +
    `Pre-existing tabs: ${preservedCount} preserved (never closed)`);
}
```

### Step 7 — Update `cleanup.list_sessions` to show origin

In the tab listing, show origin metadata:

```js
const lock = tabLocks.get(tid);
const originTag = lock ? ` (${lock.origin})` : "";
section += `\n    [${tid}]${originTag} ${tab ? tab.url : "(unknown)"}`;
```

### Step 8 — Update `handleCleanupSession` to respect origin

When a session self-terminates, apply origin-aware cleanup:

```js
for (const tid of session.tabIds) {
  const lock = tabLocks.get(tid);
  if (!lock || lock.sessionId !== sid) continue; // skip borrowed

  if (lock.origin === "claimed") {
    // Pre-existing tabs: release lock + detach, never close
    await detachTab(tid);
    cleaned++;
  } else {
    // Created tabs: apply cleanup strategy
    if (strategy === "none") {
      tabLocks.delete(tid);
    } else {
      try { await cleanupTab(tid, strategy); } catch {}
    }
    cleaned++;
  }
}
```

### Verification Tests

| # | Test | Expected |
|---|---|---|
| 1 | Open Chrome with 3 tabs. Agent creates 2 via `tabs.new`. `cleanup.list_sessions` | Shows 2 `(created)` + 3 `(claimed)` tabs |
| 2 | `cleanup.reset` with `closeTabs: false` | All sessions cleared, all tabs detached, none closed |
| 3 | `cleanup.reset` with `closeTabs: true` | Created tabs closed, pre-existing tabs preserved |
| 4 | `cleanup.session` with `cleanupStrategy: "close"` | Created tabs closed, claimed tabs detached only |
| 5 | Session B borrows Session A's tab. Session A expires. | Only Session A's owned tabs affected; borrowed ref cleaned from tabIds |
| 6 | TTL sweep with mixed origins | Created tabs cleaned per strategy, claimed tabs detached only |

---

## Implementation Order

| Phase | Feature | Effort | Priority |
|---|---|---|---|
| **Phase 1** | Session exclusivity + auto-cleanup | Medium | ~~Critical~~ **DONE (v4.4.0)** — commit `e2ac850` |
| **Phase 2** | Chrome profile selection | Small | ~~High~~ **DONE (v4.5.0)** — commit `bd32407` |
| **Phase 3** | Playwright audit Priority A | Medium | ~~High~~ **DONE (v4.6.0)** — commit `c3f3d39`, race fix `f996711` |
| **Phase 4** | Human-like interaction | Medium | ~~Medium~~ **DONE (v4.7.0)** — commit `0516741`, cleanup fix `cb80a82` |
| **Phase 4.1** | Security hardening (session opacity + temp scoping) | Small | ~~Critical~~ **DONE (v4.8.0)** — commit `a693c60` |
| **Phase 4.2** | Tab origin tracking + cleanup.reset | Medium | ~~High~~ **DONE (v4.8.0)** — commit `fd50149` |
| **Phase 4.3** | Startup perf (skipProfiles) | Small | ~~Low~~ **DONE (v4.8.1)** — commit `0fe899c` |
| **Phase 5** | Web resource debugging (`debug` tool #11) | Large | ~~Next~~ **DONE (v4.9.0)** — 21 actions, 5 new state maps, Fetch refactor |
| **Phase 6** | Playwright audit Priority B+C | Small | ~~Low~~ **DONE (v4.11.1)** — commit `027fc6e` — HAR export, full HTML content, popup detection, snapshot screenshot fallback |
