<p align="center">
  <h1 align="center">CDP Browser MCP Server</h1>
  <p align="center">
    <strong>The only MCP server that connects to your real browser.</strong><br>
    Keep your cookies. Keep your sessions. Keep your extensions. Automate everything.
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-4.1.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/tools-9-green" alt="Tools">
  <img src="https://img.shields.io/badge/sub--actions-54+-green" alt="Actions">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="License">
</p>

---

## Why This Exists

Every other browser MCP server **launches a fresh browser** — no cookies, no login sessions, no extensions, no history. You end up automating a blank browser that can't access anything you're already logged into.

**CDP Browser MCP Server connects to your actual running Chrome.** Your Gmail is already open. Your LinkedIn is already logged in. Your corporate SSO just works. No re-authentication, no MFA prompts, no cookie imports.

### Instant Startup — No Browser Launch Overhead

Other browser automation tools need to **launch a browser process** — and that takes time. Puppeteer with 20+ tabs open can take **3–5 minutes** just to initialize. Playwright MCP downloads and installs browser binaries before first run.

CDP Browser MCP Server connects to your **already-running** browser over a WebSocket. Startup is **instantaneous** regardless of how many tabs you have open — 20 tabs or 100 tabs, it connects in milliseconds and starts working immediately. No browser launch, no binary downloads, no cold start penalty.

### The Problem with Other Approaches

| Approach | What breaks |
|----------|------------|
| Playwright MCP launches new browser | No cookies, no sessions, need to re-login everywhere. Downloads browser binaries first |
| Puppeteer MCP launches Chromium | Same — blank slate. 3–5 min startup with many tabs. Plus it's **deprecated** |
| Browserbase MCP uses cloud browser | Requires paid subscription + separate LLM API key |
| Browser Use needs Python + LLM key | Heavy framework, double LLM cost |
| BrowserTools MCP is read-only | Can observe but can't automate |

**This server**: connects to Chrome on `localhost:9222`, uses the real browser state, and gives you **54+ automation actions** across 9 tools — all from a single `server.js` file with 2 dependencies. Geolocation spoofing automatically grants browser permissions so permission-based sites just work.

---

## Comparison with Other Browser MCP Servers

| Feature | **CDP Browser** (this) | **Playwright MCP** | **Browserbase** | **Puppeteer MCP** | **BrowserTools** |
|---|:---:|:---:|:---:|:---:|:---:|
| Connects to real browser | **Yes** | Via flag only | No (cloud) | No | Read-only |
| Preserves cookies/sessions | **Yes** | No | No | No | Yes |
| Works with extensions | **Yes** | No | No | No | Yes |
| Tool count | **9 tools, 54+ actions** | ~30 tools | ~10 tools | 7 tools | ~13 tools |
| Auto-waiting after actions | **Yes** | Yes | Yes | No | N/A |
| Network interception | **Yes** (mock/block/modify) | No | No | No | Read-only |
| HTTP request mocking | **Yes** | No | No | No | No |
| Cookie/storage management | **Yes** (full CRUD) | File-based | Cloud profiles | User data dir | No |
| Device emulation | **Yes** (16 options) | Partial | Limited | No | No |
| Network throttling | **Yes** (6 presets) | No | No | No | No |
| Performance metrics | **Yes** (DOM, heap, paint) | No | No | No | Lighthouse |
| PDF export | **Yes** | Yes | No | No | No |
| File upload | **Yes** | Yes | No | No | No |
| Drag & drop | **Yes** | Yes | No | No | No |
| Console monitoring | **Yes** (auto-appended) | Yes | Limited | Yes | Yes |
| Download tracking | **Yes** | No | No | No | No |
| Framework-aware inputs | **Yes** (React/Angular/MUI) | Yes | Via AI | No | No |
| Per-agent session isolation | **Yes** | Yes | Yes | No | No |
| Custom dropdown support | **Yes** (MUI/Ant/React Select) | Native | Via AI | No | No |
| Modal/dialog guards | **Yes** | Yes | No | No | No |
| Incremental snapshot diffs | **Yes** | Yes | No | No | No |
| Requires paid service | **No** | No | Yes | No | No |
| Requires LLM API key | **No** | No | Yes | No | No |
| Dependencies | **2** (ws, MCP SDK) | Playwright + browsers | API key + subscription | Puppeteer + Chromium | 3-part install |
| Single file server | **Yes** (~2900 lines) | Multi-file package | Multi-file package | Multi-file | Multi-file |
| Status | **Active** | Active | Active | **Deprecated** | Active |
| Startup speed | **Instant** (WebSocket connect) | Slow (browser launch) | Slow (cloud API) | Slow (3-5 min w/ tabs) | N/A |

---

## Installation

### Prerequisites

- **Node.js** 18+ ([download](https://nodejs.org/))
- **Google Chrome** (any recent version)

### Step 1: Enable Chrome Remote Debugging

**Option A — Chrome flag (recommended, persists across restarts):**

1. Open Chrome and navigate to `chrome://flags/#enable-remote-debugging`
2. Set to **Enabled**
3. Relaunch Chrome

**Option B — Launch with flag (one-time):**

```powershell
# Windows
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

**Verify it works:** Open `http://localhost:9222/json/version` in a browser — you should see a JSON response.

### Step 2: Clone & Install

```bash
git clone https://github.com/Tushar49/cdp-browser-mcp-server.git
cd cdp-browser-mcp-server/MCP\ Server
npm install
```

That's it. Two dependencies: `ws` (WebSocket client) and `@modelcontextprotocol/sdk`.

### Step 3: Configure Your MCP Client

<details>
<summary><strong>VS Code (Copilot / Cline / Continue)</strong></summary>

Add to your `settings.json` or `mcp.json`:

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "node",
      "args": ["/path/to/MCP Server/server.js"],
      "env": {
        "CDP_PORT": "9222"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "node",
      "args": ["/path/to/MCP Server/server.js"],
      "env": {
        "CDP_PORT": "9222"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "node",
      "args": ["/path/to/MCP Server/server.js"]
    }
  }
}
```

</details>

<details>
<summary><strong>Any MCP Client (stdio)</strong></summary>

```bash
node "MCP Server/server.js"
```

The server communicates over stdio using the MCP protocol. Any MCP-compatible client can connect.

</details>

---

## Tools & Actions

### `tabs` — Tab Management

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `list` | List all open tabs with IDs, URLs, titles | — | `showAll` |
| `find` | Search tabs by title or URL substring | `query` | — |
| `new` | Open a new tab | — | `url` |
| `close` | Close a tab | `tabId` | — |
| `activate` | Bring tab to foreground | `tabId` | — |
| `info` | Get tab details + connection status | `tabId` | — |

### `page` — Page Operations

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `goto` | Navigate to URL, wait for load | `tabId`, `url` | — |
| `back` | Navigate back in history | `tabId` | — |
| `forward` | Navigate forward in history | `tabId` | — |
| `reload` | Reload page | `tabId` | `ignoreCache` |
| `snapshot` | Accessibility tree with element refs | `tabId` | — |
| `screenshot` | Capture page or element as image | `tabId` | `fullPage`, `quality`, `uid`, `savePath` |
| `content` | Extract text or HTML | `tabId` | `uid`, `selector`, `format` |
| `wait` | Wait for text, selector, or fixed delay | `tabId` | `text`, `textGone`, `selector`, `time`(ms), `timeout`(ms) |
| `pdf` | Export page as PDF | `tabId` | `landscape`, `scale`, `paperWidth`, `paperHeight`, `margin` |
| `dialog` | Handle JS alert/confirm/prompt | `tabId` | `accept`, `text` |
| `inject` | Inject script on every page load | `tabId`, `script` | — |
| `bypass_csp` | Disable Content Security Policy | `tabId` | `enabled` |

### `interact` — Element Interaction

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `click` | Click an element | `tabId`, `uid` or `selector` | `button`, `clickCount` |
| `hover` | Hover to trigger tooltips/menus | `tabId`, `uid` or `selector` | — |
| `type` | Type text into input field | `tabId`, `text`, `uid` or `selector` | `clear`, `submit` |
| `fill` | Fill multiple form fields at once | `tabId`, `fields[]` | — |
| `select` | Select dropdown option | `tabId`, `value`, `uid` or `selector` | — |
| `press` | Press keyboard key | `tabId`, `key` | `modifiers` |
| `drag` | Drag element to target | `tabId`, source + target | — |
| `scroll` | Scroll page or element | `tabId` | `direction`, `amount`, `x`, `y`, `uid` |
| `upload` | Upload files to file input | `tabId`, `files[]`, `uid` or `selector` | — |
| `focus` | Focus element + scroll into view | `tabId`, `uid` or `selector` | — |
| `check` | Toggle checkbox | `tabId`, `checked`, `uid` or `selector` | — |

### `execute` — JavaScript Execution

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `eval` | Evaluate JS expression, return value | `tabId`, `expression` | — |
| `script` | Run async IIFE (multi-step logic) | `tabId`, `code` | — |
| `call` | Call function on a specific element | `tabId`, `function`, `uid` or `selector` | — |

### `observe` — Monitoring

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `console` | Get captured console messages | `tabId` | `level`, `last`, `clear` |
| `network` | List network requests | `tabId` | `filter`, `types`, `last`, `clear` |
| `request` | Get full request/response body | `tabId`, `requestId` | — |
| `performance` | DOM size, JS heap, layout metrics | `tabId` | — |
| `downloads` | List tracked file downloads | `tabId` | `last`, `clear` |

### `emulate` — Device & Network Emulation

Set any combination of properties in a single call:

| Property | Description | Values |
|----------|-------------|--------|
| `viewport` | Screen dimensions | `{width, height, deviceScaleFactor, mobile, touch, landscape}` |
| `colorScheme` | Color preference | `dark`, `light`, `auto` |
| `userAgent` | User agent override | string |
| `geolocation` | GPS spoofing (auto-grants permission) | `{latitude, longitude, accuracy, altitude}` |
| `cpuThrottle` | CPU slowdown | number (1 = normal, 4 = 4x slower) |
| `timezone` | Timezone override | e.g. `America/New_York` |
| `locale` | Locale override | e.g. `fr-FR` |
| `visionDeficiency` | Vision simulation | `protanopia`, `deuteranopia`, `tritanopia`, `achromatopsia`, `blurredVision` |
| `networkCondition` | Network throttle | `offline`, `slow3g`, `fast3g`, `slow4g`, `fast4g`, `none` |
| `ignoreSSL` | Bypass SSL errors | boolean |
| `blockUrls` | Block URL patterns | string array |
| `extraHeaders` | Set custom headers | object |
| `reset` | Clear all overrides | `true` |

### `storage` — Cookie & Storage Management

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `get_cookies` | Retrieve cookies | `tabId` | `urls` |
| `set_cookie` | Set a cookie | `tabId`, `name`, `value` | `domain`, `path`, `secure`, `httpOnly`, `sameSite`, `expires` |
| `delete_cookies` | Delete cookies by name | `tabId`, `name` | `url`, `domain`, `path` |
| `clear_cookies` | Clear all cookies | `tabId` | — |
| `clear_data` | Clear storage by type | `tabId` | `origin`, `types` |
| `quota` | Check storage quota | `tabId` | — |

### `intercept` — HTTP Request Interception

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `enable` | Start intercepting requests | `tabId` | `patterns` (URL globs) |
| `disable` | Stop intercepting | `tabId` | — |
| `continue` | Resume paused request | `tabId`, `requestId` | `url`, `method`, `headers`, `postData` |
| `fulfill` | Mock response for request | `tabId`, `requestId` | `status`, `body`, `headers` |
| `fail` | Abort request with error | `tabId`, `requestId` | `reason` |
| `list` | List paused requests | `tabId` | — |

### `cleanup` — Session Management

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `disconnect_tab` | Disconnect from a tab | `tabId` | — |
| `disconnect_all` | Disconnect all sessions | — | — |
| `clean_temp` | Delete temp files | — | — |
| `status` | Server status | — | — |
| `list_sessions` | List agent sessions | — | — |

---

## Key Features

### Stable Element References

Elements are addressed by `ref` numbers mapped to Chrome's internal `backendNodeId`. Unlike sequential counters that break when the DOM changes, `backendNodeId` is stable within a session and resolves in O(1).

```
# Snapshot output
- button "Submit" [ref=42]
- textbox "Email" [ref=38]

# Use ref to interact
interact → { action: "click", tabId: "...", uid: 42 }
```

### Auto-Waiting After Actions

Every click, type, fill, select, and press action is wrapped in `waitForCompletion()`:
1. Captures pending network requests before the action
2. Executes the action  
3. Waits for triggered XHR/fetch requests to complete (5s cap)
4. Waits for page navigation if detected (10s cap)
5. Returns only after the page has settled

No more "click then pray" — the server knows when the action's side effects are done.

### Actionability Checks

Before interacting with any element, the server verifies:
- Element has non-zero dimensions
- Element is not `disabled`
- Element is visible (`display`, `visibility`, `opacity`)
- Element has `pointer-events` enabled

If checks fail, you get a descriptive error with recovery hints instead of a silent failure.

### Framework-Aware Form Filling

Works with React, Angular, Vue, and vanilla HTML:
- **Text inputs**: Uses `nativeInputValueSetter` to bypass React's synthetic event system
- **Custom dropdowns**: Detects MUI Select, Ant Design Select, React Select by role/class — clicks to open, finds matching option, clicks it
- **Contenteditable**: Uses `document.execCommand('insertText')` for undo-compatible insertion
- **Native selects**: Dispatches full event sequence (`mousedown → focus → change → mouseup → click`)

### Incremental Snapshots

After the first snapshot, subsequent calls return a line-level diff showing only what changed. Reduces token usage by 60–80% on pages with minor updates.

```
### Changes (2 added, 1 removed)
+ - status "Form submitted successfully" [ref=42]
- - button "Submit" [ref=15]
+ - button "Submit" [disabled] [ref=15]
```

### Per-Agent Session Isolation

Multiple AI agents can share the same Chrome instance without interfering. Each server process is **automatically assigned a session** via `crypto.randomUUID()` — no opt-in needed. Each agent gets:
- Scoped tab visibility (agent A can't see agent B's tabs via `tabs.list`)
- Independent console/network logs
- TTL-based expiry with full CDP cleanup (default: 5 minutes, configurable via `CDP_SESSION_TTL`)
- Use `showAll: true` on `tabs.list` to bypass filtering and see all tabs

Optionally pass a custom `sessionId` to reconnect to a specific session across restarts.

### Modal/Dialog Guards

If a JavaScript `alert`, `confirm`, or `prompt` is pending on a tab, the server blocks all actions except `page.dialog` and returns a clear message telling the agent to handle the dialog first.

### Console Error Auto-Reporting

Every tool response automatically includes the last 5 console errors/warnings from the page. No need to separately poll `observe.console` to debug failures.

### Smart Error Messages

Errors include actionable recovery hints:
- *"Ref 15 not found — the page may have changed. Take a new snapshot with page.snapshot."*
- *"Element \<input\> 'Email' is not visible — it may be inside a collapsed section or behind a modal."*
- *"Click target is obscured — another element is covering it at the click coordinates."*

### Connection Health Monitoring

WebSocket ping/pong every 30 seconds. If 2 consecutive pings fail, the connection is marked dead and cleaned up. Connection status is visible via `cleanup.status`.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CDP_HOST` | `127.0.0.1` | Chrome DevTools Protocol host |
| `CDP_PORT` | `9222` | Chrome DevTools Protocol port |
| `CDP_TIMEOUT` | `30000` | Command timeout in milliseconds |
| `CDP_SESSION_TTL` | `300000` | Agent session TTL in milliseconds (5 min) |

---

## Architecture

```
                        ┌─────────────────────────────┐
                        │     Your Chrome Browser      │
                        │  (cookies, sessions, ext.)   │
                        │                              │
                        │   ws://localhost:9222/       │
                        │   devtools/browser/{id}      │
                        └──────────────┬──────────────┘
                                       │ Single browser-level WebSocket
                                       │
                        ┌──────────────┴──────────────┐
                        │   CDP Browser MCP Server     │
                        │         (server.js)          │
                        │                              │
                        │  ┌─ Tab A session ──────┐   │
                        │  │  console, network,    │   │
                        │  │  dialogs, downloads   │   │
                        │  └──────────────────────┘   │
                        │  ┌─ Tab B session ──────┐   │
                        │  │  console, network,    │   │
                        │  │  dialogs, downloads   │   │
                        │  └──────────────────────┘   │
                        │        ...per tab...         │
                        │                              │
                        │  ┌─ Agent Sessions ─────┐   │
                        │  │  agent-1 → [Tab A]    │   │
                        │  │  agent-2 → [Tab B, C] │   │
                        │  └──────────────────────┘   │
                        └──────────────┬──────────────┘
                                       │ stdio (MCP protocol)
                                       │
                        ┌──────────────┴──────────────┐
                        │       MCP Client             │
                        │  (VS Code, Claude, Cursor)   │
                        └─────────────────────────────┘
```

**Key design decisions:**

- **Browser-level WebSocket** — single connection multiplexes all tabs via `Target.attachToTarget`
- **Lazy tab attachment** — tabs are only attached when you interact with them, not on startup
- **Per-tab state isolation** — each attached tab gets independent console logs, network captures, dialog tracking, and download monitoring
- **No browser enumeration** — works with 50+ tabs without performance degradation
- **Direct CDP** — no abstraction layer (Playwright/Puppeteer), full protocol access

---

## Usage Examples

### Navigate and screenshot a page

```
1. tabs.new      → { url: "https://example.com" }
2. page.snapshot → see accessibility tree with [ref=N]
3. page.screenshot → captures as PNG
```

### Fill a form on a React app

```
1. page.snapshot → find form fields with ref numbers
2. interact.fill → { fields: [
     { uid: 10, value: "John", type: "text" },
     { uid: 12, value: "john@email.com", type: "text" },
     { uid: 14, value: "Option A", type: "select" }
   ]}
3. interact.click → { uid: 20 }  // Submit button
   → auto-waits for XHR to complete
```

### Mock an API response

```
1. intercept.enable  → { patterns: ["*/api/users*"] }
2. intercept.list    → see paused request with requestId
3. intercept.fulfill → { requestId: "...", status: 200,
                         body: '{"users": []}' }
```

### Test responsive design

```
1. emulate           → { viewport: { width: 375, height: 812, mobile: true },
                         networkCondition: "slow3g" }
2. page.screenshot   → see mobile layout under slow network
3. emulate           → { reset: true }
```

### Monitor network traffic

```
1. observe.network  → { filter: "api", types: ["xhr", "fetch"] }
   → see all API calls with status, size, timing
2. observe.request  → { requestId: "..." }
   → see full request/response body
```

---

## Tested Against

| Site | DOM Size | JS Heap | Result |
|------|----------|---------|--------|
| **LinkedIn** (React SPA) | 32,000 nodes | 155 MB | All features work |
| **Instagram** (React SPA) | Complex | Large | Scroll, navigate, screenshot |
| **Gmail** (Google Workspace) | 700+ a11y elements | Large | Inbox, search, email read |
| **W3Schools** forms | Standard | Light | Type, fill, submit |
| **DemoQA** React forms | React-based | Medium | Multi-field fill |
| **The Internet** (Herokuapp) | Standard | Light | Dropdowns, checkboxes |

---

## FAQ

**Q: Does this require Playwright or Puppeteer?**  
A: No. It connects directly to Chrome via CDP WebSocket. Only dependencies are `ws` and `@modelcontextprotocol/sdk`.

**Q: Can multiple AI agents use it simultaneously?**  
A: Yes. Each agent process is automatically assigned an isolated session — no configuration needed. Sessions auto-expire after 5 minutes. Pass a custom `sessionId` to reconnect to a previous session.

**Q: Does it work with Chrome profiles / corporate Chrome?**  
A: Yes. It connects to whatever Chrome instance is running on the configured port, including managed/enterprise Chrome with all its policies, certificates, and proxy settings.

**Q: What about iframes and Shadow DOM?**  
A: The snapshot uses `Accessibility.getFullAXTree()` which captures the full accessibility tree including shadow DOM and iframes. Element refs work across frames.

**Q: Can I use it with Edge?**  
A: Edge (Chromium-based) works out of the box — same CDP protocol. Enable remote debugging the same way.

**Q: How is this different from Playwright MCP's `--cdp-endpoint` mode?**  
A: Playwright MCP's `--cdp-endpoint` still uses Playwright's abstraction layer, limiting you to its API surface. This server gives you raw CDP access — network interception, device emulation, storage management, performance metrics, and capabilities Playwright doesn't expose.

---

## License

MIT
