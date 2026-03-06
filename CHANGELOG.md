# Changelog

All notable changes to CDP Browser MCP Server will be documented in this file.

## [4.5.0] — 2026-03-06

### Added — Chrome Profile & Instance Selection

New `browser` tool (#10) for Chrome instance discovery, profile visibility, and connection switching.

### Added
- **`browser.profiles` action** — scans known User Data directories (Chrome, Beta, Canary, Chromium) for `DevToolsActivePort` files, reads `Local State` for profile names/emails, shows connection status
- **`browser.connect` action** — switch the server's WebSocket to a different Chrome instance by name, port, or path. Guards against active sessions, waits for clean close event (no race condition), uses `overrideUserDataDir` so Chrome GUID regeneration on restart doesn't break reconnection
- **`browser.active` action** — shows connected instance name, port, User Data dir, health, profiles from Local State, and tab count per `browserContextId` (profile grouping)
- **`discoverChromeInstances()` helper** — scans Chrome/Beta/Canary/Chromium User Data dirs, reads `DevToolsActivePort` + `Local State` profile metadata
- **`CDP_PROFILE` env var** — auto-connect to a specific Chrome instance at startup by name or path
- **`overrideUserDataDir` + `lastResolvedUserDataDir`** — `getWsUrl()` refactored with override support and User Data dir tracking
- **`activeConnectionInfo`** — server state tracking current Chrome instance, auto-detected on first connection, always refreshes `wsUrl` on reconnect
- **`tabs.info` shows `browserContextId`** — lets agents see which profile a tab belongs to
- **`cleanup.status` shows Chrome instance info** — name, port, User Data dir

### Changed
- **WebSocket close handler** clears `activeConnectionInfo` and `overrideUserDataDir` on disconnect
- **`connectBrowser()` open handler** auto-detects connection info by matching against discovered instances

---

## [4.4.0] — 2026-03-06

### Added — Session Exclusivity & Configurable Auto-Cleanup

Agent sessions now own tabs exclusively with automatic cleanup when sessions expire.

### Added
- **Exclusive tab locking** — tabs are locked to the first agent session that references them. Other sessions are rejected with a clear error unless `exclusive: false` is passed to share access
- **Tab ownership at creation** — `tabs.new` immediately registers the new tab in the session's ownership and locks it, eliminating the unowned-tab gap
- **`cleanupStrategy` parameter** — controls what happens when a session expires: `"close"` (default) removes tabs from the browser, `"detach"` drops the CDP session but keeps tabs open, `"none"` skips cleanup entirely
- **`cleanup.session` action** — explicitly end a session and run its cleanup strategy on demand, with `targetSessionId` to end a specific session
- **`sweepStaleSessions()` shared function** — replaced two duplicated TTL sweep blocks with a single function, fixing `handleCleanupListSessions` which previously deleted stale entries without detaching their tabs
- **`cleanupTab()` helper** — wraps `detachTab()` + optional `Target.closeTarget` based on cleanup strategy
- **Locked-tab annotations** — `tabs.list` (with `showAll: true`) and `tabs.find` now annotate tabs owned by other sessions with `[locked by: ...]`
- **`sessionId`, `cleanupStrategy`, `exclusive` parameters** — declared in all 9 tool schemas so agents discover them. `cleanupStrategy` is sticky per session
- **Enhanced `list_sessions` output** — shows cleanup strategy, owned vs. borrowed tabs, per-session TTL remaining

### Changed
- **`detachTab()` restructured** — lock cleanup (`tabLocks.delete`) and session reference removal now run **before** the `!sid` early-return guard, ensuring locks are always released even for tabs that were never interacted with
- **`disconnect_tab` / `disconnect_all` lock guards** — these handlers now check tab lock ownership before detaching, preventing agents from detaching tabs owned by other sessions
- **Borrowed-tab safety** — the TTL sweep and `cleanup.session` only clean up tabs the session actually owns (checks `tabLocks.get(tid) === sessionId`), never closing/detaching borrowed tabs

---

## [4.3.0] — 2026-02-20

### Added — Human-Like Typing with Word-Aware Delays

New `charDelay` and `wordDelay` parameters for the `interact` tool's `type` action enable randomized, human-like typing with separate control for character-level and word-level pauses.

### Added
- **`charDelay` parameter** — base delay in ms between characters within a word, randomized in range `[charDelay, charDelay*3]` (default 200ms)
- **`wordDelay` parameter** — base delay in ms between words (spaces, tabs, newlines), randomized in range `[wordDelay, wordDelay*3]` (default 800ms)
- **`randomDelay()` helper** — generates randomized delays in `[base, base*3]` range for natural typing variance
- Either `charDelay` or `wordDelay` activates human-like mode; omitted param uses its default
- Existing `delay` parameter unchanged for backward compatibility (fixed delay, no randomization)
- If both `delay` and `charDelay`/`wordDelay` are provided, human-like mode takes precedence

### Example
```json
{ "action": "type", "tabId": "ABC", "uid": 42, "text": "Hello world", "charDelay": 70, "wordDelay": 1500 }
```
Types each character with 70–210ms delay, each space with 1500–4500ms delay.

---

## [4.2.2] — 2026-02-18

### Changed — Temp directory moved to repo-local `.temp/`

- Temp files (PDFs, large outputs) now stored in `<repo>/.temp/` instead of system temp (`%TEMP%\.cdp-mcp\`)
- Path resolved via `import.meta.url` — works regardless of where the server is invoked from
- Override with `CDP_TEMP_DIR` env var if needed
- `.temp/` added to `.gitignore`

---

## [4.2.1] — 2026-02-18

### Fixed — Full-Page Screenshots on SPA Pages

Full-page screenshots on SPA sites (LinkedIn, Gmail, Twitter) now correctly capture **all loaded content** instead of blank space or skeleton placeholders.

### Fixed
- **Scroll-before-expand strategy** — scrolls through the SPA scroll container *while it's still scrollable* to trigger lazy loading, then expands it for capture. Previously expanded first (disabling scroll), so lazy content never loaded
- **Body overflow handling** — now also overrides `body { overflow: hidden }` which LinkedIn and other SPAs use to prevent document-level scroll
- **Infinite scroll safeguards** — capped at 30 scroll steps; monitors content growth every 5 steps and aborts if height exceeds 1.5x (runaway infinite scroll) or 16384px (Chrome GPU limit)
- **Post-capture stability** — increased settle times after viewport resize/restore to prevent timeout on subsequent screenshots

### Test Results
| Page | Viewport | Full Page |
|------|----------|----------|
| LinkedIn Profile | 1920×804 (105 KB) | 1536×4231 (709 KB) |
| LinkedIn Notifications | 1920×804 (161 KB) | 1520×1150 (128 KB) |
| Wikipedia article | 1920×804 | 1520×6044 (1064 KB) |

---

## [4.2.0] — 2026-02-14

### Playwright Alignment — Comprehensive API Audit & Improvements

This release brings the CDP Browser MCP Server's API surface in line with Playwright conventions. Users familiar with Playwright will find our params, naming, and behavior familiar and predictable.

### Changed
- **`page.wait` — merged `time` into `timeout`** — no more separate params. Use `timeout` alone for a fixed delay (like Playwright's `waitForTimeout`), or with `text`/`textGone`/`selector` as the polling cap. Legacy `time` still accepted silently
- **`page.screenshot` — renamed `savePath` to `path`** — matches Playwright's `path` convention. Legacy `savePath` still accepted silently
- **`interact.press/click/hover` modifiers — renamed `Ctrl` to `Control`** — matches Playwright's key naming. `Ctrl` still works internally via `modifierFlags()`
- **`page.goto/back/forward/reload` — navigation now uses `waitUntil`** — `load` (default), `domcontentloaded`, `networkidle`, `commit`. Plus optional `timeout`. Matches Playwright's `goto({ waitUntil })` pattern
- **`page.wait` selector — added `state` param** — `visible`, `hidden`, `attached` (default), `detached`. Matches Playwright's `locator.waitFor({ state })`

### Added
- **`modifiers` on `interact.click` and `interact.hover`** — `["Control", "Shift", "Alt", "Meta"]` for Ctrl+click, Shift+click, etc. Already existed on `press`, now available on click/hover too
- **`delay` on `interact.type`** — milliseconds between keystrokes for character-by-character typing (like Playwright's `pressSequentially`). Without delay, uses instant fill via `nativeInputValueSetter`
- **`type` param on `page.screenshot`** — `png` (default) or `jpeg`. JPEG produces smaller files for vision-model agents. Previously jpeg was only triggered by `quality` param
- **`waitForReadyState` helper** — shared navigation wait logic supporting all 4 `waitUntil` strategies including `networkidle` (waits for no pending requests for 500ms)

## [4.1.0] — 2026-02-14

### Added
- **Geolocation `accuracy` and `altitude` params** — `accuracy` (meters, default 100) and `altitude` (meters, optional) for realistic GPS spoofing
- **Automatic geolocation permission granting** — 3-tier fallback: `Browser.grantPermissions` → `Browser.setPermission` → JS API override injection. Permission-based sites (e.g. where-am-i.co) now work without manual user prompts
- **Auto-assigned per-process sessions** — each MCP server process gets a `crypto.randomUUID()` session automatically; no opt-in needed
- **Tab ownership enforcement** — `tabs.list` filters to session-owned tabs by default
- **`showAll` param for `tabs.list`** — bypasses session filtering to see all browser tabs
- **`sessionId` declared in all tool schemas** — visible and documented, not a hidden convention

### Changed
- Session isolation is now automatic — every tool call routes through a session (uses `args.sessionId` or auto-assigned process session)
- `detachTab` now removes tab from all `agentSessions` to prevent stale references
- Session expiry now calls `detachTab` for each owned tab, properly cleaning up CDP sessions, console logs, network captures, and ref maps

### Fixed
- Geolocation spoofing on permission-based sites — `Emulation.setGeolocationOverride` alone wasn't enough; browser permission grants are now handled automatically
- **`page.wait` time/timeout consistency** — both `time` and `timeout` are now in milliseconds (matching Playwright convention). Hard cap at 60000ms prevents runaway waits

### Added (post-release)
- **`savePath` param for `page.screenshot`** — pass an absolute file path to save screenshots directly to disk instead of returning base64. Creates parent directories automatically

## [4.0.0] — 2026-02-14

### Added
- **Stable element references** — `ref` numbers mapped to Chrome's `backendNodeId` (O(1) resolution, stable within session)
- **Auto-waiting after actions** — every click, type, fill, select, and press waits for triggered XHR/fetch and navigation to complete
- **Actionability checks** — verifies element dimensions, visibility, pointer-events, and disabled state before interaction
- **Framework-aware form filling** — works with React (`nativeInputValueSetter`), MUI Select, Ant Design Select, React Select, contenteditable, and native selects
- **Incremental snapshots** — line-level diffs reduce token usage by 60–80% on subsequent snapshots
- **Per-agent session isolation** — multiple AI agents share one Chrome instance with scoped tab visibility, independent logs, and TTL-based expiry
- **Modal/dialog guards** — blocks actions when a JS dialog is pending, returns clear message to handle it first
- **Console error auto-reporting** — last 5 console errors/warnings appended to every tool response
- **Smart error messages** — actionable recovery hints for stale refs, hidden elements, obscured click targets
- **Connection health monitoring** — WebSocket ping/pong every 30s, auto-cleanup on 2 consecutive failures
- **Rich tool descriptions** — comprehensive action documentation with parameter details and usage notes

### Changed
- Upgraded from sequential element counters to `backendNodeId`-based stable refs
- Snapshot format now shows `[ref=N]` instead of sequential IDs

## [3.0.0] — 2026-02-10

### Changed
- **Consolidated 19 tools into 9** with ~50 sub-actions using action-based dispatch
- Tools reorganized: `tabs`, `page`, `interact`, `execute`, `observe`, `emulate`, `storage`, `intercept`, `cleanup`

### Removed
- 19 individual flat tools replaced by 9 consolidated tools with sub-actions

## [2.0.0] — 2026-02-10

### Added
- Initial CDP Browser MCP Server
- 19 individual tools for browser automation
- Direct Chrome DevTools Protocol connection via WebSocket
- Tab management, navigation, screenshots, element interaction
- Network interception and monitoring
- Cookie and storage management
- Device and network emulation
- JavaScript execution
- Console and performance monitoring

---

[4.1.0]: https://github.com/Tushar49/cdp-browser-mcp-server/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/Tushar49/cdp-browser-mcp-server/compare/v3.0.0...v4.0.0
[3.0.0]: https://github.com/Tushar49/cdp-browser-mcp-server/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/Tushar49/cdp-browser-mcp-server/releases/tag/v2.0.0
