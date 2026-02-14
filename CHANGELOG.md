# Changelog

All notable changes to CDP Browser MCP Server will be documented in this file.

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

[4.0.0]: https://github.com/Tushar49/cdp-browser-mcp-server/compare/v3.0.0...v4.0.0
[3.0.0]: https://github.com/Tushar49/cdp-browser-mcp-server/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/Tushar49/cdp-browser-mcp-server/releases/tag/v2.0.0
