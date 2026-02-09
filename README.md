# CDP Browser Automation

Tools for automating Chrome via the Chrome DevTools Protocol (CDP).

## MCP Server

A lightweight MCP server that connects to Chrome's CDP endpoint and provides tools for tab management and page interaction.

### Why This Exists

Existing MCP browser tools (Chrome DevTools MCP, Playwright MCP) connect to ALL browser targets on startup. With a heavy browser (50+ tabs, extensions, service workers), this causes `Network.enable` timeouts.

This server takes a different approach:
- **Lazy connections** — only connects to a tab when you interact with it
- **No enumeration** — uses HTTP endpoints for tab listing, WebSocket per tab on demand
- **Multi-tab** — list, switch, open, and close tabs freely
- **Lightweight** — single Node.js file, minimal dependencies

### Setup

#### 1. Enable Remote Debugging in Chrome

Navigate to `chrome://flags/#enable-remote-debugging` → set to **Enabled** → restart Chrome.

Alternatively, launch Chrome with `--remote-debugging-port=9222`.

#### 2. Install Dependencies

```powershell
cd "E:\Projects\CDP Browser Automation\MCP Server"
npm install
```

#### 3. MCP Configuration

Already configured in VS Code's `mcp.json`. The server starts automatically when you use its tools.

### Environment Variables

| Variable      | Default     | Description              |
|---------------|-------------|--------------------------|
| `CDP_PORT`    | `9222`      | Chrome debugging port    |
| `CDP_HOST`    | `127.0.0.1` | Chrome debugging host   |
| `CDP_TIMEOUT` | `30000`     | Command timeout (ms)     |

### Available Tools

#### Tab Management (HTTP only — instant, no WebSocket)

| Tool            | Description                          |
|-----------------|--------------------------------------|
| `list_tabs`     | List all open tabs with IDs          |
| `find_tab`      | Search tabs by title or URL          |
| `new_tab`       | Open a new tab                       |
| `close_tab`     | Close a tab                          |
| `activate_tab`  | Bring a tab to the foreground        |

#### Page Interaction (WebSocket — connects to tab on first use)

| Tool            | Description                          |
|-----------------|--------------------------------------|
| `navigate`      | Go to a URL, wait for page load      |
| `screenshot`    | Capture page as PNG image            |
| `evaluate`      | Run JavaScript and get result        |
| `get_content`   | Get text or HTML of page/element     |
| `click`         | Click element (realistic mouse events)|
| `type_text`     | Type into input/textarea             |
| `select_option` | Select from dropdown                 |
| `wait_for`      | Wait for element or text to appear   |

### Architecture

```
Chrome (port 9222)
  ├── HTTP: /json/list     ←── list_tabs, find_tab (no WebSocket)
  ├── HTTP: /json/new      ←── new_tab
  ├── HTTP: /json/close/ID ←── close_tab
  ├── HTTP: /json/activate ←── activate_tab
  │
  └── WS: /devtools/page/ID  ←── Per-tab WebSocket (lazy)
       ├── Page.navigate     ←── navigate
       ├── Page.captureScreenshot ←── screenshot
       ├── Runtime.evaluate  ←── evaluate, get_content, click, type_text
       └── Input.*           ←── click (mouse events), type_text
```

Only the page-level WebSocket is used — never the browser-level one. This means:
- No target enumeration
- Can coexist with Chrome DevTools MCP (which uses browser-level WebSocket)
- Each tab connection is independent
