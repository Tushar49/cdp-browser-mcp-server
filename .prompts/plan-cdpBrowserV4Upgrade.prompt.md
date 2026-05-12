## Plan: CDP Browser MCP v4 — Comprehensive Upgrade

### TL;DR

The CDP MCP server has **10 core gaps** vs Playwright MCP across reliability, performance, UX, and session isolation. Additionally, tool descriptions are bare-bones compared to the Dataverse `server.py` which provides exhaustive per-operation documentation with required/optional parameter callouts. This plan addresses everything: stable element refs, auto-waiting, incremental snapshots, per-agent sessions, framework-aware interactions, modal state guards, structured responses, tool annotations, and — critically — rich Dataverse-style tool descriptions that tell the LLM exactly what each sub-action needs.

---

### The server.py Description Pattern (what we're adopting)

The Dataverse `server.py` follows a strict pattern for every router tool:

```
Tool-level summary sentence.

Operations:
- operation_name: Human-readable description (requires: param1, param2; optional: param3, param4)
- another_op: Description (requires: X; optional: Y)

Reference Data:
Column Types: X, Y, Z
Access Rights: A, B, C
```

**Key traits:**
1. Every operation lists `requires:` and `optional:` params inline
2. Enum-like reference data (types, rights, presets) listed at the bottom
3. Common use cases / notes section for complex tools
4. The `operation` parameter uses a `Literal` type that constrains valid values

The current CDP server descriptions are just one-liners like `"Manage browser tabs. Actions: list, find, new, close, activate, info."` — no parameter guidance at all. The LLM has to guess which params each action needs.

---

### Problem Analysis — Why Playwright MCP Wins

| Area | Current CDP Server | Playwright MCP | Impact |
|---|---|---|---|
| **Element refs** | Sequential UID counter — re-walks DOM to find element, breaks if DOM changed since snapshot | Stable `aria-ref=X` IDs mapped to auto-waiting locators | **#1 reliability issue** |
| **After-action waiting** | None — returns immediately after click/type | `waitForCompletion()`: detects triggered XHR/fetch/navigation, waits for settle (5s cap) | Actions fail because page hasn't updated yet |
| **Snapshots** | Full tree every call (~thousands of tokens) | Incremental diffs after first snapshot | Massive token waste |
| **Sessions** | Single global state — all agents share one `activeSessions` map | One `Context` per MCP connection with isolated state | Agents step on each other |
| **Dropdowns** | Sets `el.value` + dispatches `change` — breaks React/Angular/MUI custom dropdowns | Playwright's `selectOption` handles all frameworks | Dropdown fills fail on modern SPAs |
| **Form typing** | `Input.insertText` — skips React synthetic events | Character-by-character dispatch or proper `fill()` with framework-aware events | Typed values don't register in React |
| **Modal states** | No guard — tools called while dialog is open just fail silently | Blocks all tools except dialog handler when modal is active | Unclear errors |
| **Tool descriptions** | One-line descriptions, no parameter guidance | Rich per-parameter descriptions guiding LLM behavior | LLM makes wrong tool choices |
| **Response structure** | Plain text `ok()` / `fail()` | Structured markdown: Result + Snapshot + Events + Code | LLM lacks context for next action |
| **iframes** | Not handled | Transparent cross-frame support | Can't interact with iframed content |

---

### Steps

#### Phase 1: Rich Tool Descriptions (Dataverse server.py style)

1. **Rewrite all 9 tool descriptions** in `server.js` (lines 783-996) following the exact pattern from Dataverse `server.py`. Each tool description should become a multi-line string with:
   - Summary sentence
   - `Operations:` block listing every action with `requires:` / `optional:` parameters
   - Reference data section for enums/presets
   - Usage notes where relevant

   **Exact rewrites for all 9 tools:**

   **tabs** — currently: `"Manage browser tabs. Actions: list, find, new, close, activate, info."`
   → Rewrite to:
   ```
   Manage browser tabs: list, search, create, close, activate, and inspect tabs.

   Operations:
   - list: List all open browser tabs with their IDs, URLs, and titles
   - find: Search tabs by title or URL substring (requires: query)
   - new: Open a new tab (optional: url — defaults to about:blank)
   - close: Close a specific tab (requires: tabId)
   - activate: Bring a tab to the foreground (requires: tabId)
   - info: Get detailed info about a tab including URL, title, and connection status (requires: tabId)
   ```

   **page** — currently one line → Rewrite to:
   ```
   Page-level operations: navigation, accessibility snapshots, screenshots, content extraction, waiting, PDF export, dialog handling, script injection, and CSP bypass.

   Operations:
   - goto: Navigate to a URL and wait for page load (requires: tabId, url)
   - back: Navigate back in browser history (requires: tabId)
   - forward: Navigate forward in browser history (requires: tabId)
   - reload: Reload the current page (requires: tabId; optional: ignoreCache)
   - snapshot: Capture accessibility tree snapshot with element refs for interaction (requires: tabId)
   - screenshot: Take a screenshot of the page or a specific element (requires: tabId; optional: fullPage, quality, uid)
   - content: Extract text or HTML content from the page or an element (requires: tabId; optional: uid, selector, format[text|html])
   - wait: Wait for text to appear/disappear, a CSS selector to match, or a fixed time (requires: tabId; provide one of: text, textGone, selector, or time; optional: timeout)
   - pdf: Export page as PDF to temp file (requires: tabId; optional: landscape, scale, paperWidth, paperHeight, margin{top,bottom,left,right})
   - dialog: Handle a pending JavaScript dialog (alert/confirm/prompt) (requires: tabId; optional: accept[default:true], text for prompt response)
   - inject: Inject a script that runs on every new document load (requires: tabId, script)
   - bypass_csp: Enable/disable Content Security Policy bypass (requires: tabId; optional: enabled[default:true])

   Notes:
   - Always take a snapshot before interacting with elements — it provides refs needed by interact tools
   - The snapshot returns an accessibility tree with roles, names, and properties matching ARIA semantics
   - Wait actions poll every 300ms up to the timeout (default: 10000ms)
   ```

   **interact** — Rewrite to:
   ```
   Element interaction: click, hover, type text, fill forms, select dropdown options, press keys, drag & drop, scroll, upload files, focus elements, and toggle checkboxes.

   Operations:
   - click: Click an element (requires: tabId, uid or selector; optional: button[left|right|middle], clickCount — use 2 for double-click)
   - hover: Hover over an element to trigger tooltips or menus (requires: tabId, uid or selector)
   - type: Type text into a focused input field (requires: tabId, text, uid or selector; optional: clear[default:true] — clears field first, submit — press Enter after typing)
   - fill: Fill multiple form fields in one call (requires: tabId, fields — array of {uid or selector, value, type[text|checkbox|radio|select|combobox]})
   - select: Select an option from a <select> dropdown by value or visible text (requires: tabId, value, uid or selector)
   - press: Press a keyboard key with optional modifiers (requires: tabId, key; optional: modifiers[Ctrl|Shift|Alt|Meta])
   - drag: Drag an element to another element (requires: tabId, sourceUid or sourceSelector, targetUid or targetSelector)
   - scroll: Scroll the page or a specific element (requires: tabId; optional: direction[up|down|left|right], amount[default:400px], x, y for absolute scroll, uid or selector for scrolling within an element)
   - upload: Upload files to a file input (requires: tabId, files — array of absolute file paths, uid or selector)
   - focus: Focus an element and scroll it into view (requires: tabId, uid or selector)
   - check: Set a checkbox to checked or unchecked (requires: tabId, checked[true|false], uid or selector)

   Element Resolution: Provide either 'uid' (from a snapshot) or 'selector' (CSS selector). UIDs are preferred — they come from the accessibility snapshot and map to visible, interactive elements.

   Keys for press: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space, F1-F12, Insert
   ```

   **execute** — Rewrite to:
   ```
   Execute JavaScript code on the page in three modes: inline expression evaluation, async script execution, and calling a function on a specific element.

   Operations:
   - eval: Evaluate a JavaScript expression and return its value (requires: tabId, expression)
   - script: Execute an async function body wrapped in an IIFE — use for multi-step JS logic (requires: tabId, code)
   - call: Call a JavaScript function with a specific page element as its argument (requires: tabId, function — e.g. '(el) => el.textContent', uid or selector)

   Notes:
   - eval returns the expression's value directly (must be JSON-serializable)
   - script wraps your code in: (async () => { <your code> })() — use 'return' to send a value back
   - call resolves the element first, then passes it as the first argument to your function
   ```

   **observe** — Rewrite to:
   ```
   Monitor browser console messages, network requests, retrieve full request/response bodies, and measure page performance metrics.

   Operations:
   - console: Retrieve captured console messages (requires: tabId; optional: level[all|error|warning|log|info|debug], last — return only last N entries, clear — clear after returning)
   - network: List captured network requests with URLs, methods, status codes, and timing (requires: tabId; optional: filter — URL substring, types — resource type filter array, last, clear)
   - request: Get the full request and response body for a specific network request (requires: tabId, requestId — from network listing)
   - performance: Collect page performance metrics including DOM size, JS heap, layout counts, and paint timing (requires: tabId)

   Network Resource Types: xhr, fetch, document, script, stylesheet, image, font, media, websocket, other

   Notes:
   - Console and network monitoring starts automatically when first queried — no explicit enable needed
   - Use 'clear: true' to reset captured data between test iterations
   ```

   **emulate** — Rewrite to:
   ```
   Emulate device characteristics and network conditions: viewport size, color scheme, user agent, geolocation, CPU throttle, timezone, locale, vision deficiency simulation, network throttling, SSL bypass, URL blocking, and custom headers. Pass 'reset: true' to clear all overrides.

   Operations (set any combination of properties in a single call):
   - viewport: Set viewport dimensions (optional: {width, height, deviceScaleFactor, mobile, touch, landscape})
   - colorScheme: Emulate preferred color scheme (optional: dark|light|auto)
   - userAgent: Override the browser user agent string (optional: string)
   - geolocation: Spoof geolocation (optional: {latitude, longitude})
   - cpuThrottle: Throttle CPU speed — 1 = normal, 4 = 4x slower (optional: number)
   - timezone: Override timezone (optional: string, e.g. 'America/New_York')
   - locale: Override locale (optional: string, e.g. 'fr-FR')
   - visionDeficiency: Simulate vision impairment (optional: none|protanopia|deuteranopia|tritanopia|achromatopsia|blurredVision)
   - autoDarkMode: Force automatic dark mode (optional: boolean)
   - idle: Emulate idle/locked screen state (optional: active|locked)
   - networkCondition: Throttle network speed (optional: offline|slow3g|fast3g|slow4g|fast4g|none)
   - ignoreSSL: Bypass SSL certificate errors (optional: boolean)
   - blockUrls: Block requests matching URL patterns (optional: string array)
   - extraHeaders: Set extra HTTP headers on all requests (optional: object)
   - reset: Clear ALL emulation overrides (optional: true)

   Network Presets: offline (no connection), slow3g (2s latency, 50KB/s), fast3g (562ms, 180KB/s), slow4g (150ms, 400KB/s), fast4g (50ms, 1.5MB/s), none (remove throttling)
   ```

   **storage** — Rewrite to:
   ```
   Cookie and storage management: get, set, and delete cookies, clear browser storage, and check storage quota.

   Operations:
   - get_cookies: Retrieve cookies (requires: tabId; optional: urls — filter by URLs)
   - set_cookie: Set a cookie (requires: tabId, name, value; optional: domain, path, secure, httpOnly, sameSite[None|Lax|Strict], expires — epoch seconds)
   - delete_cookies: Delete specific cookies by name (requires: tabId, name; optional: url, domain, path)
   - clear_cookies: Clear all cookies for the browser profile (requires: tabId)
   - clear_data: Clear browser storage for an origin (requires: tabId; optional: origin, types — comma-separated: 'cookies,local_storage,indexeddb,cache_storage' or 'all')
   - quota: Check storage quota usage for the current page's origin (requires: tabId)
   ```

   **intercept** — Rewrite to:
   ```
   HTTP request interception via CDP Fetch domain. Intercept, modify, mock, or block network requests in real-time.

   Operations:
   - enable: Start intercepting requests matching URL patterns (requires: tabId; optional: patterns — array of URL glob patterns, e.g. ['*.api.example.com/*'])
   - disable: Stop all request interception (requires: tabId)
   - continue: Resume a paused request, optionally modifying it (requires: tabId, requestId; optional: url, method, headers, postData)
   - fulfill: Respond to a paused request with a custom/mocked response (requires: tabId, requestId; optional: status, body, headers)
   - fail: Abort a paused request with a network error (requires: tabId, requestId; optional: reason)
   - list: List all currently paused/intercepted requests (requires: tabId)

   Failure Reasons: Failed, Aborted, TimedOut, AccessDenied, ConnectionClosed, ConnectionReset, ConnectionRefused, ConnectionAborted, ConnectionFailed, NameNotResolved, InternetDisconnected, AddressUnreachable, BlockedByClient, BlockedByResponse

   Notes:
   - Call 'enable' first with URL patterns to start intercepting
   - Intercepted requests are paused until you call continue, fulfill, or fail
   - Each intercepted request has a unique requestId shown in the 'list' output
   ```

   **cleanup** — Rewrite to:
   ```
   Disconnect browser sessions and clean up temporary files created by the server.

   Operations:
   - disconnect_tab: Disconnect from a specific tab session without closing the tab (requires: tabId)
   - disconnect_all: Disconnect all active tab sessions (no parameters)
   - clean_temp: Delete all temporary files (screenshots, PDFs) created by the server (no parameters)
   - status: Show current server status — active sessions, temp file count, connection state (no parameters)
   ```

2. **Add `annotations` to each tool definition** following MCP spec:
   - Add `title` (human-readable name), `readOnlyHint`, `destructiveHint`, and `openWorldHint` fields
   - `tabs.list/find/info`, `page.snapshot/screenshot/content`, `observe.*`, `cleanup.status` → `readOnlyHint: true`
   - `tabs.close`, `storage.clear_*`, `cleanup.clean_temp/disconnect_*` → `destructiveHint: true`
   - All tools → `openWorldHint: true` (browser interacts with external world)

#### Phase 2: Stable Element References

3. **Replace sequential UID counter with stable refs** in `buildSnapshot()` (lines 415-584):
   - During `buildSnapshot()`, use `Runtime.evaluate` to walk the DOM but also call `DOM.getDocument({depth:-1, pierce:true})` to get the full DOM tree with stable `backendNodeId` values
   - Assign each element a short ref like `e1`, `e2`, ... and store a server-side `Map<ref, backendNodeId>` on the session
   - The snapshot YAML output uses `[ref=e5]` instead of `[uid=5]`
   - Clear and rebuild the map on each snapshot call

4. **New element resolution via `DOM.resolveNode`** replacing `uidResolver()` (lines 589-658):
   - Look up `backendNodeId` from the ref map
   - Call `DOM.resolveNode({backendNodeId})` → get `objectId`
   - Call `Runtime.callFunctionOn({objectId, functionDeclaration: ...})` for coordinates/scrollIntoView
   - This is O(1) and survives DOM mutations (backendNodeId is stable within a session)

5. **Add iframe/Shadow DOM support** to snapshot building:
   - When a node is an `<iframe>`, use `DOM.describeNode` to get its `contentDocument`, then recursively snapshot it
   - Prefix refs with frame index: `f0.e5`, `f1.e3`
   - When resolving refs with `.`, split and route to the correct frame session
   - For Shadow DOM: use `DOM.getDocument({pierce:true})` to access shadow roots

#### Phase 3: Auto-Waiting & Actionability

6. **Implement `waitForCompletion()` wrapper** — new function:
   - Before action: enable Network domain, start collecting `Network.requestWillBeSent` events
   - Execute the action callback
   - 500ms stabilization pause
   - If any request was a navigation (`type === "Document"`): wait for `Page.loadEventFired` via CDP (up to 10s)
   - Otherwise: for each XHR/fetch/script/stylesheet request, wait for `Network.loadingFinished` (up to 5s with `Promise.race`)
   - Extra 500ms settling pause if any network activity occurred
   - Apply this wrapper to: `handleInteractClick`, `handleInteractType`, `handleInteractFill`, `handleInteractSelect`, `handleInteractCheck`, `handleInteractPress`

7. **Add actionability checks** before element interactions:
   - After resolving element, verify: visible (`offsetParent` check), enabled (`!disabled`), non-zero size (`width > 0 && height > 0`)
   - Check element is stable: get bounding rect, wait 100ms, get again — if position changed by >2px, wait and retry (up to 3 attempts)
   - Throw descriptive error if element fails checks: `"Element <button> 'Submit' is disabled"`, `"Element is obscured by another element at (x,y)"`

8. **Add hit-test validation** on click:
   - After scrolling element into view, use `DOM.getNodeForLocation({x, y})` to verify the intended element is actually at the click coordinates
   - If a different element covers it (overlay, modal, etc.), report: `"Click target <button> 'Submit' is obscured by <div class='overlay'> at (320, 240)"`

#### Phase 4: Incremental Snapshots

9. **Store previous snapshot per session** — add a `lastSnapshot` map:
   - After building a snapshot, store the YAML string keyed by `sessionId`
   - On next snapshot request, compute a line-level diff (added `+`, removed `-`, context lines)
   - Return both `full` and `incremental` in the response
   - Default to sending the incremental diff, with the full snapshot available in the response's `### Full Snapshot` section or via a forced flag
   - If snapshot capture fails, set `forceFullSnapshot = true` for next call

10. **Add `snapshotMode` config option**:
    - `incremental` (default): send diff
    - `full`: always send complete tree
    - `none`: skip snapshot in responses (for screenshot-only workflows)
    - Configurable via `CDP_SNAPSHOT_MODE` env var

#### Phase 5: Per-Agent Session Isolation

11. **Create `BrowserSession` class** to encapsulate all per-session state:
    - Extracts `activeSessions`, `enabledDomains`, `consoleLogs`, `networkReqs`, `eventListeners`, `pendingDialogs`, `pendingFetchRequests`, `fetchRules`, `injectedScripts`, `refMap`, `lastSnapshot` into a single class
    - Factory method: `BrowserSession.create(browserWs)` — shares the WS connection
    - Disposal: `session.dispose()` detaches all tabs, clears all state

12. **Session routing in `handleTool()`** (lines 2168-2180):
    - Add optional `sessionId` parameter to all tools
    - Maintain a `Map<string, BrowserSession>` of active sessions
    - If `sessionId` provided: use/create the matching `BrowserSession`
    - If not provided: use a default session (backward compatible)
    - Sessions auto-expire after 5 minutes of inactivity (configurable via `CDP_SESSION_TTL`)

13. **Support `--isolated` mode** for full browser-context isolation:
    - Use `Target.createBrowserContext` to create a separate incognito context per session
    - Tabs created within a session are scoped to its browser context
    - On session cleanup: `Target.disposeBrowserContext`

14. **Add StreamableHTTP transport** as alternative to stdio:
    - Use `@modelcontextprotocol/sdk/server/streamableHttp.js`
    - Each HTTP connection → new `BrowserSession`
    - Enabled via `CDP_TRANSPORT=http CDP_HTTP_PORT=3100`
    - Maintains the existing stdio as default

#### Phase 6: Framework-Aware Interactions

15. **Rewrite select/dropdown handling** (lines 1346-1366):
    - **Native `<select>`**: dispatch full event sequence: `mousedown` → `focus` → `change` → `mouseup` → `click` (matches real browser behavior)
    - **Custom dropdown detection**: check for `role="combobox"`, `role="listbox"`, `aria-haspopup`, `data-testid`, MUI class patterns (`MuiSelect`, `ant-select`, `react-select`)
    - **Custom dropdown handler**: click element to open → `waitForCompletion` → find options via `role="option"` or `role="listitem"` → click matching option → verify selection

16. **Rewrite text input handling** (lines 1280-1305):
    - Add React-compatible `nativeInputValueSetter` approach: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val)` then dispatch `new Event('input', {bubbles: true})`
    - Support Angular's `ngModel` by also dispatching `compositionstart` → `compositionend` events
    - Add `mode` parameter: `"fast"` (current `Input.insertText`), `"compatible"` (char-by-char `Input.dispatchKeyEvent`), `"auto"` (default — detect framework)

17. **Add date picker / specialized input handling**:
    - For `<input type="date|time|datetime-local">`: set value via `nativeInputValueSetter` + dispatch `input` + `change`
    - For `<input type="range">` (sliders): calculate pixel position from value and use `Input.dispatchMouseEvent` drag
    - For `contenteditable`: use `document.execCommand('insertText', false, text)` for undo-compatible insertion

18. **Add combobox/autocomplete field type** to `handleInteractFill`:
    - New field type `"combobox"`: type the value → wait for suggestion dropdown → click matching suggestion
    - Handles: Material UI Autocomplete, React Select, Ant Design Select, Headless UI Combobox

#### Phase 7: Modal State Enforcement

19. **Add modal state guard** to `handleTool()`:
    - Before dispatching any tool, check all sessions for pending dialogs via `pendingDialogs`
    - If dialog is pending for the target tab and tool is not `page.dialog`:
      ```
      Error: A JavaScript dialog is blocking the page. Handle it first.
      Dialog: alert "Are you sure you want to delete this?"
      → Use page.dialog with action: 'dialog', tabId: '...', accept: true/false
      ```
    - Track file chooser events (CDP `Page.fileChooserOpened`) as additional modal state → only `interact.upload` clears it

20. **Race modal states during actions**:
    - When executing click/type/etc., race the action against dialog/filechooser events
    - If a dialog appears during an action, report it immediately in the response instead of hanging

#### Phase 8: Structured Responses

21. **Rewrite `ok()` / `fail()` helpers** (lines 663-675) to produce structured markdown:
    ```
    ### Result
    Clicked <button> "Submit" at (320, 240)

    ### Page
    - URL: https://example.com/form
    - Title: Contact Form

    ### Snapshot (incremental)
    ```yaml
    + - status "Form submitted successfully" [ref=e42]
    - - button "Submit" [ref=e15]
    + - button "Submit" [disabled] [ref=e15]
    ```

    ### Events
    - [XHR] POST /api/submit → 200 (142ms)
    - [ERROR] Failed to load resource: net::ERR_CONNECTION_REFUSED @ analytics.js
    ```

22. **Auto-include console errors** in every response:
    - After each action, collect any new console `error`/`warning` entries since the last tool call
    - Include them in the `### Events` section automatically
    - This eliminates the need for a separate `observe.console` call to debug failures

23. **Auto-include mini-snapshot diff** in interaction responses:
    - After `waitForCompletion()`, capture a snapshot and diff against the previous one
    - Include only changed/added/removed lines (capped at 50 lines) in the response
    - The LLM sees the result of its action without a separate snapshot call

#### Phase 9: Advanced Features

24. **Add `browser_generate_locator` tool** (Playwright-inspired):
    - New action on `execute` tool: `generate_locator`
    - Given a `ref` or `selector`, returns a robust CSS/XPath/text-based locator recommendation
    - Useful for test automation workflows

25. **Add download tracking**:
    - Intercept `Page.downloadWillBegin` and `Page.downloadProgress` CDP events
    - Track downloads per session with status (in-progress, complete, failed)
    - Report download events in structured responses
    - Add `downloads` action to `observe` tool

26. **Add `init_script` support**:
    - New config option (`CDP_INIT_SCRIPT` env var or `--init-script` flag)
    - Uses `Page.addScriptToEvaluateOnNewDocument` to inject a script into every page load
    - Useful for: disabling animations, setting up test fixtures, polyfilling APIs

27. **Add `test_id_attribute` config** for better element detection:
    - Config option (`CDP_TEST_ID` env var) specifying a custom test ID attribute (default: `data-testid`)
    - `buildSnapshot()` includes the test ID in the snapshot output: `button "Submit" [testid=submit-btn, ref=e5]`
    - Element resolution supports `testid:submit-btn` as an alternative to `ref:e5` or CSS selectors

28. **Add smart error messages with recovery hints**:
    - `"Ref e15 not found — the page snapshot may be stale. Take a new snapshot with page.snapshot."`
    - `"Element <input> 'Email' is not visible — it may be inside a collapsed section or behind a modal."`
    - `"Click failed: element moved during interaction — the page may be animating. Try waiting 500ms."`
    - These contextual messages teach the LLM how to recover, mimicking Playwright's approach

29. **Add capability gating** (Playwright-inspired):
    - Core tools always available: `tabs`, `page`, `interact`, `execute`, `cleanup`
    - Optional capabilities enabled via `CDP_CAPS` env var:
      - `network`: enables `observe.network`, `observe.request`, `intercept.*`
      - `devtools`: enables `emulate.*`, `storage.*`
      - `vision`: enables `page.screenshot` as inline image (vs file path)
    - Default: all capabilities enabled (backward compatible)
    - Purpose: reduce tool surface for simple automation tasks

30. **Add connection health monitoring**:
    - Periodic WebSocket ping (every 30s) to detect dropped connections
    - Auto-reconnect with state recovery on WS disconnect
    - Report connection status in `cleanup.status`

---

### Verification

- **Tool descriptions**: Verify with a fresh LLM context that it can correctly determine which parameters each action needs without prior knowledge
- **Element stability**: Snapshot → XHR modifies DOM → resolve ref → verify correct element
- **Auto-waiting**: Click button that triggers API → next snapshot shows updated content without explicit wait
- **Incremental snapshots**: Two snapshots of same page with one change → measure token reduction (target: 60-80%)
- **Session isolation**: Two concurrent agents on different tabs → verify no state leakage
- **React forms**: Test against a React app with controlled inputs, MUI Select, date pickers
- **Modal guard**: `alert()` → try click → verify error message, then handle dialog → verify click works
- **Structured responses**: Verify every tool response has `### Result` + `### Page` sections
- **Custom dropdowns**: Test against MUI Select, Ant Design Select, React Select
- **Hit-test**: Click element with overlay → verify descriptive error about obstruction

---

### Decisions

- **Adopt server.py description pattern verbatim** — every tool lists operations with `requires:` / `optional:` / reference data
- **`backendNodeId` for element resolution** over re-walking DOM — O(1) and survives DOM mutations
- **Auto-include snapshot diff in interaction responses** — eliminates one round-trip per action cycle
- **React-compatible input setter as default** — `nativeInputValueSetter` works on all frameworks including vanilla HTML
- **All capabilities enabled by default** — backward compatible, opt-out rather than opt-in
- **StreamableHTTP for multi-agent** — each connection automatically gets isolated session
- **No auto-retry on failures** (Playwright's approach) — report clear errors with recovery hints, let the LLM decide
- **Structured markdown responses** matching Playwright's section format but adapted for CDP context
- **Keep direct CDP** (no Playwright dependency) — this is the server's unique value: connects to the user's real browser with real cookies/sessions
