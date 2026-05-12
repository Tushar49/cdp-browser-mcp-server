# CDP Browser MCP Server v3 — Tool Consolidation & Feature Expansion Plan

## TL;DR

Rewrite the 19-tool server into **9 main tools** using action-based parameter routing.
Add **15+ missing features** (dialog handling, file upload, cookies, request interception,
PDF export, scroll, performance metrics, network throttling, timezone/locale emulation,
CSS inspection, vision deficiency simulation, URL blocking, script injection, CSP bypass,
SSL bypass). Total: **~50 sub-actions** across 9 tools. Down from what would be 30+ separate
tools if each was standalone.

---

## Tool Architecture: 19 tools → 9 tools

### Current (v2) → Proposed (v3) Mapping

```
CURRENT v2 (19 tools)              →  PROPOSED v3 (9 tools)
─────────────────────                  ─────────────────────
tabs                               →  tabs         (6 actions — unchanged)
navigate                           →  page         (merged)
snapshot                           →  page         (merged)
screenshot                         →  page         (merged)
get_content                        →  page         (merged)
wait_for                           →  page         (merged)
click                              →  interact     (merged)
hover                              →  interact     (merged)
type                               →  interact     (merged)
fill_form                          →  interact     (merged)
select_option                      →  interact     (merged)
press_key                          →  interact     (merged)
drag                               →  interact     (merged)
evaluate                           →  execute      (merged)
run_script                         →  execute      (merged)
console                            →  observe      (merged)
network                            →  observe      (merged)
emulate                            →  emulate      (expanded)
cleanup                            →  cleanup      (expanded)
                                   +  storage      (NEW)
                                   +  intercept    (NEW)
```

---

## Tool 1: `tabs`

**Purpose:** Browser tab lifecycle management.

| Action | Params | Notes |
|--------|--------|-------|
| `list` | — | List all open tabs with IDs, titles, URLs |
| `find` | `query` | Search tabs by title/URL substring |
| `new` | `url` | Open new tab, optionally navigate to URL |
| `close` | `tabId` | Close tab and detach session |
| `activate` | `tabId` | Bring tab to foreground |
| `info` | `tabId` | Tab details + session stats (console/network counts) |

**Changes from v2:** None — already consolidated. Keep as-is.

---

## Tool 2: `page`

**Purpose:** All page-level operations — navigation, inspection, capture, waiting, dialog handling.

Merges: `navigate` + `snapshot` + `screenshot` + `get_content` + `wait_for` + NEW features.

| Action | Params | Notes |
|--------|--------|-------|
| `goto` | `tabId`, `url` | Navigate to URL, wait for load |
| `back` | `tabId` | Go back in history |
| `forward` | `tabId` | Go forward in history |
| `reload` | `tabId`, `ignoreCache?` | Reload page |
| `snapshot` | `tabId` | A11y tree with UIDs (existing implementation) |
| `screenshot` | `tabId`, `fullPage?`, `quality?`, `uid?` | PNG/JPEG capture. NEW: `uid` to screenshot a single element |
| `content` | `tabId`, `selector?`, `uid?`, `format?` | Get text/HTML of page or element |
| `wait` | `tabId`, `text?`, `textGone?`, `selector?`, `time?`, `timeout?` | Wait for condition |
| `pdf` | `tabId`, `landscape?`, `scale?`, `paperWidth?`, `paperHeight?`, `margin?` | **NEW:** Print page to PDF |
| `dialog` | `tabId`, `accept`, `text?` | **NEW:** Handle JS alert/confirm/prompt |
| `inject` | `tabId`, `script` | **NEW:** Add script to run on every new document load (`Page.addScriptToEvaluateOnNewDocument`) |
| `bypass_csp` | `tabId`, `enabled` | **NEW:** Toggle Content Security Policy bypass |

### Implementation Details

**`pdf`** — CDP: `Page.printToPDF`
```
Parameters: landscape, displayHeaderFooter, printBackground, scale,
paperWidth, paperHeight, marginTop/Bottom/Left/Right, pageRanges,
headerTemplate, footerTemplate, preferCSSPageSize
Returns: base64 data → save to temp file if large, return path
```

**`dialog`** — CDP: `Page.javascriptDialogOpening` (event) + `Page.handleJavaScriptDialog`
```
On session attach: listen for Page.javascriptDialogOpening events.
Store pending dialog info: {type, message, defaultPrompt, url}.
When 'dialog' action called: call Page.handleJavaScriptDialog({accept, promptText}).
Auto-accept after 5s if no tool call (prevent hanging).
Must enable Page domain for events.
```

**`inject`** — CDP: `Page.addScriptToEvaluateOnNewDocument`
```
Runs before any page scripts on every navigation/reload.
Use cases: override APIs, inject polyfills, add debugging helpers.
Returns identifier that can be used to remove later.
```

**`bypass_csp`** — CDP: `Page.setBypassCSP`
```
Allows injecting scripts even on pages with strict CSP.
Useful for evaluating custom JS on restricted pages.
```

**`screenshot` with `uid`** — Resolve uid → get bounding rect → use `clip` param in `Page.captureScreenshot`

---

## Tool 3: `interact`

**Purpose:** All element-level interaction — mouse, keyboard, forms, drag, scroll, file upload.

Merges: `click` + `hover` + `type` + `fill_form` + `select_option` + `press_key` + `drag` + NEW features.

| Action | Params | Notes |
|--------|--------|-------|
| `click` | `tabId`, `uid?`, `selector?`, `button?`, `clickCount?` | Click element with real mouse events |
| `hover` | `tabId`, `uid?`, `selector?` | Mouse hover to trigger tooltips/effects |
| `type` | `tabId`, `uid?`, `selector?`, `text`, `clear?`, `submit?` | Type text into input/textarea |
| `fill` | `tabId`, `fields[]` | Batch fill multiple form fields |
| `select` | `tabId`, `uid?`, `selector?`, `value` | Select dropdown option by value or text |
| `press` | `tabId`, `key`, `modifiers?[]` | Press keyboard key/combo |
| `drag` | `tabId`, `sourceUid?`, `sourceSelector?`, `targetUid?`, `targetSelector?` | Drag and drop with smooth interpolation |
| `scroll` | `tabId`, `uid?`, `selector?`, `direction?`, `amount?`, `x?`, `y?` | **NEW:** Scroll page or element |
| `upload` | `tabId`, `uid?`, `selector?`, `files[]` | **NEW:** Upload files via file input |
| `focus` | `tabId`, `uid?`, `selector?` | **NEW:** Focus element without clicking |
| `check` | `tabId`, `uid?`, `selector?`, `checked` | **NEW:** Toggle checkbox/radio (smarter than click) |

### Implementation Details

**`scroll`** — CDP: `Input.dispatchMouseEvent` (wheel) or `Runtime.evaluate` with `scrollBy`/`scrollTo`
```
Params:
  direction: "up" | "down" | "left" | "right" — shorthand scroll
  amount: number — pixels to scroll (default 400)
  x, y: number — specific scroll position (uses scrollTo)
  uid/selector: scroll within a specific scrollable container
  
Implementation:
  If uid/selector given:
    el.scrollBy({top: amount, behavior: 'smooth'})
  Else:
    window.scrollBy({top: amount, behavior: 'smooth'})
  
  Direction maps: up → -amount, down → +amount, left/right similar
```

**`upload`** — CDP: `DOM.setFileInputFiles`
```
1. Resolve uid/selector to backendNodeId via Runtime.evaluate + DOM.describeNode
2. Or: Page.setInterceptFileChooserDialog + listen for Page.fileChooserOpened
3. Call DOM.setFileInputFiles({ files: [...paths], backendNodeId })
Files param: array of absolute file paths on the machine
```

**`focus`** — Simply `el.focus()` via Runtime.evaluate
```
Useful for focusing elements before press_key actions
(e.g., focus a contenteditable div, then press Ctrl+A)
```

**`check`** — Smarter than raw click for checkboxes
```
1. Detect current checked state
2. Only click if state doesn't match desired
3. Works for both checkbox and radio inputs
4. Dispatches proper change events
```

---

## Tool 4: `execute`

**Purpose:** JavaScript execution on page.

Merges: `evaluate` + `run_script`.

| Action | Params | Notes |
|--------|--------|-------|
| `eval` | `tabId`, `expression` | Quick inline JS expression |
| `script` | `tabId`, `code` | Multi-line async function body (wrapped in IIFE) |
| `call` | `tabId`, `uid?`, `selector?`, `function` | **NEW:** Execute function with element as argument |

### Implementation Details

**`call`** — Execute a function that receives a DOM element
```
Like Chrome DevTools MCP's evaluate_script with element ref.
Resolves uid/selector → DOM element, then calls function with it.

CDP: Runtime.callFunctionOn
  1. Resolve element to objectId via Runtime.evaluate + resolveNode  
  2. Call Runtime.callFunctionOn({ functionDeclaration: userFn, objectId, returnByValue: true, awaitPromise: true })
  
Use case: "Get the computed styles of element uid=42"
  action: "call", uid: 42, function: "(el) => getComputedStyle(el).backgroundColor"
```

---

## Tool 5: `observe`

**Purpose:** Passive monitoring of console, network, performance.

Merges: `console` + `network` + NEW features.

| Action | Params | Notes |
|--------|--------|-------|
| `console` | `tabId`, `level?`, `clear?`, `last?` | Get captured console messages |
| `network` | `tabId`, `filter?`, `types?[]`, `clear?`, `last?` | Get captured network requests |
| `request` | `tabId`, `requestId` | **NEW:** Get full request/response body for a specific request |
| `performance` | `tabId` | **NEW:** Get runtime performance metrics |

### Implementation Details

**`network` enhancements:**
```
New param `types`: Filter by resource type array 
["xhr","fetch","document","script","stylesheet","image","font","media","websocket","other"]
Maps to the `type` field from Network.requestWillBeSent
```

**`request`** — CDP: `Network.getResponseBody` + `Network.getRequestPostData`
```
Given a requestId (from the network listing):
  1. Network.getResponseBody({ requestId }) → { body, base64Encoded }
  2. Network.getRequestPostData({ requestId }) → { postData }

Returns: { url, method, status, requestHeaders, responseHeaders, requestBody, responseBody }
If response is large (>MAX_INLINE_LEN), save to temp file and return path.
```

**`performance`** — CDP: `Performance.enable` + `Performance.getMetrics`
```
Returns key metrics:
  - Timestamp, Documents, Frames, JSEventListeners
  - Nodes, LayoutCount, RecalcStyleCount, LayoutDuration
  - RecalcStyleDuration, ScriptDuration, TaskDuration
  - JSHeapUsedSize, JSHeapTotalSize
  
Format as readable table:
  Documents: 1 | Frames: 1
  DOM Nodes: 1,247 | JS Listeners: 342
  JS Heap: 12.4MB / 33.1MB
  Layout: 42 recalcs, 12ms total
  Scripts: 891ms total
```

---

## Tool 6: `emulate`

**Purpose:** Device/environment simulation. Already one tool — just expanding params.

| Param Group | Params | CDP Method | Notes |
|-------------|--------|-----------|-------|
| Viewport | `width`, `height`, `deviceScaleFactor`, `mobile`, `touch`, `landscape` | `Emulation.setDeviceMetricsOverride` | Add touch/landscape flags |
| Color | `colorScheme` (dark/light/auto) | `Emulation.setEmulatedMedia` | Unchanged |
| User Agent | `userAgent` | `Emulation.setUserAgentOverride` | Unchanged |
| Geolocation | `latitude`, `longitude` | `Emulation.setGeolocationOverride` | Unchanged |
| CPU | `cpuThrottle` (1-20) | `Emulation.setCPUThrottlingRate` | Unchanged |
| Timezone | `timezone` | `Emulation.setTimezoneOverride` | **NEW** |
| Locale | `locale` | `Emulation.setLocaleOverride` | **NEW** |
| Vision | `visionDeficiency` (none/protanopia/deuteranopia/tritanopia/achromatopsia/blurredVision) | `Emulation.setEmulatedVisionDeficiency` | **NEW** |
| Dark Mode | `autoDarkMode` (true/false) | `Emulation.setAutoDarkModeOverride` | **NEW** |
| Idle | `idle` (active/locked) | `Emulation.setIdleOverride` | **NEW** |
| Network | `networkCondition` (offline/slow3g/fast3g/slow4g/fast4g/none) | `Network.emulateNetworkConditions` | **NEW** |
| SSL | `ignoreSSL` (true/false) | `Security.setIgnoreCertificateErrors` | **NEW** |
| Block URLs | `blockUrls` (string[]) | `Network.setBlockedURLs` | **NEW** |
| Extra Headers | `extraHeaders` (object) | `Network.setExtraHTTPHeaders` | **NEW** |
| Reset | `reset` (true) | Clear all overrides | **NEW** |

### Network Condition Presets
```
offline:  { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
slow3g:   { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 }
fast3g:   { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 }
slow4g:   { offline: false, latency: 150, downloadThroughput: 400000, uploadThroughput: 150000 }
fast4g:   { offline: false, latency: 50, downloadThroughput: 1500000, uploadThroughput: 750000 }
none:     disable throttling
```

---

## Tool 7: `storage`

**Purpose:** Cookie and storage management. **Entirely new tool.**

| Action | Params | Notes |
|--------|--------|-------|
| `get_cookies` | `tabId`, `urls?[]` | Get all cookies or cookies for specific URLs |
| `set_cookie` | `tabId`, `name`, `value`, `domain?`, `path?`, `secure?`, `httpOnly?`, `sameSite?`, `expires?` | Set a cookie |
| `delete_cookies` | `tabId`, `name?`, `domain?`, `url?` | Delete specific cookies by name/domain |
| `clear_cookies` | `tabId` | Clear ALL cookies |
| `clear_data` | `tabId`, `origin?`, `types?` | Clear storage data (cookies, localStorage, indexedDB, cache, etc.) |
| `quota` | `tabId` | Get storage usage and quota for current origin |

### Implementation Details

**`get_cookies`** — CDP: `Network.getCookies` or `Storage.getCookies`
```
Returns: Array of { name, value, domain, path, expires, size, httpOnly, secure, sameSite, sameParty }
Format as readable table.
```

**`set_cookie`** — CDP: `Network.setCookie`
```
Params map directly to CDP method params.
If domain not provided, use current page's domain.
```

**`clear_data`** — CDP: `Storage.clearDataForOrigin`
```
storageTypes: "cookies,local_storage,indexeddb,cache_storage,service_workers"
Can specify subset or "all" for everything.
```

**`quota`** — CDP: `Storage.getUsageAndQuota`
```
Returns: { usage: "12.4 MB", quota: "300 GB", usageBreakdown: [...] }
Breakdown shows per-type usage (indexedDB, cache, localStorage, etc.)
```

---

## Tool 8: `intercept`

**Purpose:** HTTP request interception, mocking, and blocking. **Entirely new tool.**
Uses the CDP `Fetch` domain (more powerful than `Network.setBlockedURLs`).

| Action | Params | Notes |
|--------|--------|-------|
| `enable` | `tabId`, `patterns?[]`, `stages?` | Start intercepting requests matching URL patterns |
| `disable` | `tabId` | Stop intercepting |
| `continue` | `tabId`, `requestId`, `url?`, `method?`, `headers?`, `postData?` | Continue a paused request (optionally modified) |
| `fulfill` | `tabId`, `requestId`, `status`, `headers?`, `body?` | Respond to a paused request with custom response |
| `fail` | `tabId`, `requestId`, `reason` | Fail a paused request with error |
| `list` | `tabId` | List currently paused/pending intercepted requests |

### Implementation Details

**`enable`** — CDP: `Fetch.enable`
```
patterns: Array of { urlPattern: "*.google-analytics.com/*", requestStage: "Request" }
If no patterns, intercepts everything (careful with performance).

Events: Fetch.requestPaused → store in pendingRequests map
Each paused request must be continued/fulfilled/failed within 30s or Chrome drops it.
```

**`fulfill`** — CDP: `Fetch.fulfillRequest`
```
Mock API responses:
  fulfill({ requestId, responseCode: 200, 
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    body: btoa(JSON.stringify({ mock: true })) })
Body must be base64 encoded.
```

**`fail`** — CDP: `Fetch.failRequest`
```
reasons: "Failed", "Aborted", "TimedOut", "AccessDenied", "ConnectionClosed",
         "ConnectionReset", "ConnectionRefused", "ConnectionAborted",
         "ConnectionFailed", "NameNotResolved", "InternetDisconnected",
         "AddressUnreachable", "BlockedByClient", "BlockedByResponse"
```

### Architecture for Fetch Interception

```
1. On `enable`: Fetch.enable with patterns, subscribe to Fetch.requestPaused
2. On Fetch.requestPaused event:
   - Store request details in pendingInterceptions Map(requestId → {url, method, headers, ...})
   - If auto-rules configured (via patterns), auto-fulfill/fail/continue
   - Otherwise wait for explicit continue/fulfill/fail tool call
   - Auto-continue after 10s timeout to prevent hangs
3. On `disable`: Fetch.disable, clear pending map
```

---

## Tool 9: `cleanup`

**Purpose:** Session management, temp files, status.

| Action | Params | Notes |
|--------|--------|-------|
| `disconnect_tab` | `tabId` | Detach from single tab |
| `disconnect_all` | — | Detach all sessions |
| `clean_temp` | — | Delete temp files |
| `status` | — | Show connection stats, temp dir info |

**Changes from v2:** None needed. Already clean.

---

## New Features Implementation Priority

### Phase 1 — Critical (implement first)

1. **Consolidate tool routing** — Refactor all tool definitions and handlers to use action-based dispatch
2. **`page.dialog`** — Dialog handling prevents hangs (blocking issue)
3. **`interact.scroll`** — Essential for page exploration
4. **`interact.upload`** — File workflows impossible without this

### Phase 2 — High Value

5. **`storage`** (all actions) — Cookie management
6. **`observe.request`** — Full response body inspection
7. **`observe.performance`** — Performance metrics
8. **`page.pdf`** — PDF export
9. **Emulate expansions** — timezone, locale, network throttling, vision deficiency

### Phase 3 — Advanced

10. **`intercept`** (all actions) — Request mocking/interception
11. **`execute.call`** — Function-on-element execution
12. **`page.inject`** — Persistent script injection
13. **`page.bypass_csp`** — CSP bypass
14. **`emulate` extras** — SSL bypass, URL blocking, extra headers, auto dark mode, idle

---

## Full Schema Definition — All 9 Tools

```
tabs:
  action: list | find | new | close | activate | info
  tabId?: string
  query?: string
  url?: string

page:
  action: goto | back | forward | reload | snapshot | screenshot | content | wait | pdf | dialog | inject | bypass_csp
  tabId: string
  url?: string                    # goto
  ignoreCache?: boolean           # reload  
  fullPage?: boolean              # screenshot
  quality?: number                # screenshot (JPEG)
  uid?: number                    # screenshot (element), content
  selector?: string               # content
  format?: string                 # content: text | html
  text?: string                   # wait (text appear) / dialog (prompt input)
  textGone?: string               # wait
  time?: number                   # wait (seconds)
  timeout?: number                # wait (ms)
  accept?: boolean                # dialog
  landscape?: boolean             # pdf
  scale?: number                  # pdf
  script?: string                 # inject
  enabled?: boolean               # bypass_csp

interact:
  action: click | hover | type | fill | select | press | drag | scroll | upload | focus | check
  tabId: string
  uid?: number
  selector?: string
  # click:
  button?: string                 # left | right | middle
  clickCount?: number
  # type:
  text?: string
  clear?: boolean
  submit?: boolean
  # fill:
  fields?: array                  # [{uid, selector, value, type}]
  # select:
  value?: string
  # press:
  key?: string
  modifiers?: string[]
  # drag:
  sourceUid?: number
  sourceSelector?: string
  targetUid?: number
  targetSelector?: string
  # scroll:
  direction?: string              # up | down | left | right
  amount?: number                 # pixels
  x?: number                      # scrollTo x
  y?: number                      # scrollTo y
  # upload:
  files?: string[]                # absolute file paths
  # check:
  checked?: boolean

execute:
  action: eval | script | call
  tabId: string
  expression?: string             # eval
  code?: string                   # script
  function?: string               # call
  uid?: number                    # call (element target)
  selector?: string               # call (element target)

observe:
  action: console | network | request | performance
  tabId: string
  # console:
  level?: string                  # all | error | warning | log | info | debug
  # network:
  filter?: string
  types?: string[]                # xhr, fetch, document, script, image, font, etc.
  # both console & network:
  clear?: boolean
  last?: number
  # request:
  requestId?: string

emulate:
  tabId: string
  # All params are optional — set what you want to change:
  viewport?: { width, height, deviceScaleFactor, mobile, touch, landscape }
  colorScheme?: string            # dark | light | auto
  userAgent?: string
  geolocation?: { latitude, longitude }
  cpuThrottle?: number
  timezone?: string               # e.g. "America/New_York"
  locale?: string                 # e.g. "fr-FR"
  visionDeficiency?: string       # none | protanopia | deuteranopia | tritanopia | achromatopsia | blurredVision
  autoDarkMode?: boolean
  idle?: string                   # active | locked
  networkCondition?: string       # offline | slow3g | fast3g | slow4g | fast4g | none
  ignoreSSL?: boolean
  blockUrls?: string[]
  extraHeaders?: object
  reset?: boolean                 # clear ALL overrides

storage:
  action: get_cookies | set_cookie | delete_cookies | clear_cookies | clear_data | quota
  tabId: string
  # get_cookies:
  urls?: string[]
  # set_cookie:
  name?: string
  value?: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string               # None | Lax | Strict
  expires?: number                # epoch seconds
  # delete_cookies:
  # (can use name, domain, url to filter)
  # clear_data:
  origin?: string
  types?: string                  # "cookies,local_storage,indexeddb,cache_storage" or "all"

intercept:
  action: enable | disable | continue | fulfill | fail | list
  tabId: string
  # enable:
  patterns?: string[]             # URL patterns like "*.api.example.com/*"
  # continue:
  requestId?: string
  url?: string                    # override URL
  method?: string                 # override method
  headers?: object                # override headers
  postData?: string               # override body
  # fulfill:
  status?: number                 # response status code
  body?: string                   # response body
  # fail:
  reason?: string                 # Failed | Aborted | TimedOut | etc.

cleanup:
  action: disconnect_tab | disconnect_all | clean_temp | status
  tabId?: string
```

---

## Architecture Changes

### 1. Handler Dispatch Pattern

Replace the current giant `switch(name)` with a two-level dispatch:

```javascript
const HANDLERS = {
  tabs:      { list: handleTabsList, find: handleTabsFind, new: handleTabsNew, ... },
  page:      { goto: handlePageGoto, snapshot: handlePageSnapshot, dialog: handlePageDialog, ... },
  interact:  { click: handleClick, hover: handleHover, scroll: handleScroll, ... },
  execute:   { eval: handleEval, script: handleScript, call: handleCall },
  observe:   { console: handleConsole, network: handleNetwork, request: handleRequest, ... },
  emulate:   handleEmulate,   // single function (no sub-actions, params-driven)
  storage:   { get_cookies: handleGetCookies, set_cookie: handleSetCookie, ... },
  intercept: { enable: handleInterceptEnable, fulfill: handleInterceptFulfill, ... },
  cleanup:   { disconnect_tab: handleDisconnectTab, disconnect_all: handleDisconnectAll, ... },
};

async function handleTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool: ${name}`);
  
  if (typeof handler === 'function') return handler(args);    // emulate
  
  const action = args.action;
  if (!action) return fail(`Missing 'action' parameter.`);
  const fn = handler[action];
  if (!fn) return fail(`Unknown action '${action}' for tool '${name}'.`);
  return fn(args);
}
```

### 2. Dialog Auto-Handling System

```javascript
// Per-session dialog queue
const pendingDialogs = new Map();  // sessionId → [{ type, message, defaultPrompt, url }]

// On session attach → enable Page domain + listen for dialog events
// In handleEvent():
if (method === "Page.javascriptDialogOpening") {
  const dialogs = pendingDialogs.get(sessionId) || [];
  dialogs.push({
    type: params.type,           // alert | confirm | prompt | beforeunload
    message: params.message,
    defaultPrompt: params.defaultPromptText,
    url: params.url,
    ts: Date.now(),
  });
  pendingDialogs.set(sessionId, dialogs);
  
  // Auto-accept after 10s if no manual handling
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
```

### 3. Fetch Interception System

```javascript
const pendingFetchRequests = new Map(); // sessionId → Map(requestId → requestInfo)
const fetchRules = new Map();           // sessionId → [ { pattern, action, response } ]

// In handleEvent():
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
  const matchingRule = rules.find(r => info.url.match(r.pattern));
  if (matchingRule) {
    // Auto-handle based on rule
    if (matchingRule.action === "block") {
      await cdp("Fetch.failRequest", { requestId: params.requestId, reason: "BlockedByClient" }, sessionId);
    } else if (matchingRule.action === "mock") {
      await cdp("Fetch.fulfillRequest", { ... }, sessionId);
    }
    return;
  }
  
  pending.set(params.requestId, info);
  pendingFetchRequests.set(sessionId, pending);
  
  // Auto-continue after 10s to prevent hangs
  setTimeout(async () => {
    if (pending.has(params.requestId)) {
      try { await cdp("Fetch.continueRequest", { requestId: params.requestId }, sessionId); } catch {}
      pending.delete(params.requestId);
    }
  }, 10000);
}
```

### 4. File Structure

Keep single `server.js` (user preference) with clear section headers.
Only modularize if file exceeds ~2500 lines.

---

## Implementation Steps

1. Refactor tool definitions — 19 tool schemas → 9 tool schemas with `action` enum params
2. Implement handler dispatch map pattern replacing the switch statement
3. Wire up dialog event system (listen + auto-accept + manual `page.dialog`)
4. Add `interact.scroll` — `el.scrollBy()` / `window.scrollBy()` by direction+amount
5. Add `interact.upload` — `DOM.setFileInputFiles` with uid/selector resolution
6. Add `interact.focus` and `interact.check`
7. Add `page.pdf` — `Page.printToPDF` → base64 → temp file
8. Add `page.inject` and `page.bypass_csp`
9. Add `execute.call` — `Runtime.callFunctionOn` with element objectId
10. Add `observe.request` — `Network.getResponseBody` + `Network.getRequestPostData`
11. Add `observe.performance` — `Performance.enable` + `Performance.getMetrics`
12. Expand `emulate` with all 10 new params (timezone, locale, vision, network throttle, SSL, etc.)
13. Implement `storage` tool — all 6 cookie/storage actions
14. Implement `intercept` tool — Fetch domain enable/disable/continue/fulfill/fail/list with auto-continue timeout
15. Update `observe.network` — add `types[]` filter param for resource type filtering
16. Add `page.screenshot` `uid` param — element-level screenshot via bounding rect clip

## Verification Plan

After implementation, test each tool category:

1. **tabs** — list tabs, find by query, open new, close, activate, get info
2. **page** — navigate google.com, back/forward, snapshot, screenshot, content, wait for text, PDF export, trigger alert() and handle dialog
3. **interact** — click a link (by uid), hover a menu, type in search box, fill a form, press Enter, scroll down, upload a file
4. **execute** — eval `document.title`, run_script to extract data, call function on element
5. **observe** — check console messages, list network requests, get response body, check performance metrics
6. **emulate** — set mobile viewport, dark mode, timezone, slow 3G, vision deficiency
7. **storage** — get cookies, set a cookie, delete it, check quota
8. **intercept** — enable interception, mock an API response, block analytics URL
9. **cleanup** — disconnect tab, check status, clean temp files

Manual test sequence:
```
tabs(list) → get a tabId
page(goto, tabId, "https://example.com") → navigates
page(snapshot, tabId) → get a11y tree with uids
interact(click, tabId, uid=5) → clicks element
interact(scroll, tabId, direction="down", amount=500) → scrolls
observe(console, tabId) → check messages
observe(performance, tabId) → get metrics
emulate(tabId, timezone="Asia/Tokyo", colorScheme="dark") → emulate
storage(get_cookies, tabId) → list cookies
page(pdf, tabId) → export PDF
cleanup(status) → check state
```

---

## Key Decisions

- **Single file vs modular:** Keep single file with clear section comments. Modularize only if >2500 lines.
- **UID system:** Keep custom JS-based a11y walker (not CDP Accessibility domain). It's faster, doesn't require domain enable, and gives full control.
- **Dialog auto-handling:** Auto-accept after 10s timeout to prevent indefinite hangs. LLM can explicitly handle before timeout.
- **Fetch interception auto-continue:** 10s timeout. All unhandled paused requests get continued.
- **Network throttle presets:** Named presets (slow3g, fast3g, etc.) rather than raw throughput numbers.
- **`interact` is the biggest tool** with 11 sub-actions, but it's cohesive — all "do something to/with an element". The `action` param makes it clear.
