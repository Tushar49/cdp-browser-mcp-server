# Plan: v4.1.0 — Auto Sessions + Geolocation Params

**TL;DR**: Two improvements: (1) Expose `accuracy` and `altitude` in geolocation spoofing for realism, and (2) make per-agent session isolation automatic and real. Currently with `StdioServerTransport`, each MCP client already gets its own OS process — so isolation is inherently there at the process level. But the `agentSessions` system is half-baked: opt-in, no enforcement, no real tab filtering. The fix auto-assigns a session per process, enforces tab ownership, properly filters `tabs.list`, and cleans up resources when sessions expire. An optional `sessionId` param lets agents reconnect to a specific session.

## Steps

### 1. Geolocation params
In `server.js`, update the `emulate` tool's input schema to add `accuracy` (number, default 100) and `altitude` (number, optional) inside the `geolocation` object. Then update the `handleEmulate` function (~L2436) to pass `args.geolocation.accuracy ?? 100` and `args.geolocation.altitude` to `Emulation.setGeolocationOverride`. Also update the tool description string to mention these new params.

### 2. Auto-assign process session
At server startup (after the `const` declarations, near L116), generate a `processSessionId` using `crypto.randomUUID()`. Add `import { randomUUID } from "crypto"` at the top. This ID represents "this server process = this agent's session."

### 3. Rework `handleTool` session logic (~L2860)
Change the session routing:
- If `args.sessionId` is provided, use it (allows reconnecting to a specific session).
- Otherwise, use `processSessionId` automatically (no opt-in needed).
- Either way, create/update the `agentSessions` entry with `lastActivity` and `tabIds`.
- Remove `delete args.sessionId` — instead, just don't pass it to handlers (use destructuring or pull it out cleanly).

### 4. Enforce tab ownership in `tabs.list`
When an agent calls `tabs.list` and has a session with tracked tabs, **filter** the results to only show session-owned tabs (not just prepend a text tag). Add a `showAll` boolean param to the `tabs` tool schema that bypasses filtering when explicitly set.

### 5. Clean up `tabIds` on detach
In `detachTab` (~L494), iterate `agentSessions` and remove the detached `tabId` from every session's `tabIds` Set. This prevents stale tab references from accumulating.

### 6. Clean up CDP state on session expiry
In both the periodic timer (~L2970) and the inline stale-session sweep in `handleTool`, when deleting an expired `agentSession`, also call `detachTab` for each `tabId` in the session's `tabIds` — this properly cleans up `activeSessions`, `consoleLogs`, `networkReqs`, `refMaps`, etc. Currently only the `agentSessions` map entry is removed, leaving CDP sessions dangling.

### 7. Declare `sessionId` in tool schemas
Add `sessionId: { type: "string", description: "Optional session ID to connect to a specific session. Auto-assigned if omitted." }` to every tool's `inputSchema.properties`. This makes it visible/documented rather than a hidden convention.

### 8. Version bump
Update `version` in `package.json` from `"4.0.0"` to `"4.1.0"`, and update the `Server` constructor in `server.js` (~L2955) from `version: "4.0.0"` to `version: "4.1.0"`.

## Verification

- `node -c server.js` — syntax check passes
- Test geolocation: call `emulate` with `{ geolocation: { latitude: 40.7, longitude: -74.0, accuracy: 10, altitude: 30 } }`, then verify on a geolocation test site
- Test auto-session: call `tabs.new` then `tabs.list` — should only show the tab this agent created, without passing any `sessionId`
- Test session reconnect: call with explicit `sessionId: "my-session"`, close and reopen, call again with same `sessionId` — should see same tabs
- Test cleanup: let session expire (`CDP_SESSION_TTL=5000`), verify CDP sessions are detached and state maps cleared

## Decisions

- Auto-assign uses `crypto.randomUUID()` per process — simpler than per-request hashing
- Tab filtering defaults to session-owned tabs only; `showAll: true` overrides for debugging
- `accuracy` defaults to `100` (meters) when not specified — backward-compatible
- `altitude` is fully optional — omitted from CDP call if not provided (CDP treats `undefined` as "no altitude")
