# CDP Browser MCP Server v5.0.0 Development

## Architecture
Modular TypeScript. 38 files in MCP Server/src/.
Entry: src/index.ts → dist/index.js
12 tools: tabs, page, interact, form, execute, observe, emulate, storage, intercept, cleanup, browser, debug

## Key Patterns
- DI via ServerContext
- Tools registered with defineTool() + registerXTools()
- Preprocessing: dispatch.ts handles session/tab/modal before every tool call
- Auto-connect: ensureConnected() before every tool dispatch
- Errors: ActionableError with fix suggestions

## Build & Verify
cd "MCP Server" && npm run build && npm run typecheck
