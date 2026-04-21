# User-Identified Issues — CDP Browser MCP Server

All issues below are extracted from real usage sessions (chat1-5.md) where the CDP Browser MCP server was used for job applications, email checking, form filling, D365 testing, and general browser automation. These are NOT theoretical — every single one happened in production use.

---

## CRITICAL — Blocks core workflows

### 0. Agents can't figure out how to connect — hallucinate and break things
Many times no browser is connected. Agents try tabs.list() first → get error → then try to close the browser and relaunch with debugging port (even though it was already running with debugging) → hallucinate because of wrong results → "fuck things up". The tool names and call order are confusing. Agents think CDP is "not available" and give up, or they try to kill the browser process which disrupts user's work. The entire tool surface is too complex for agents to use correctly without extensive prompting.
- Root cause: No auto-connect, confusing error messages, tools don't self-document proper usage flow
- Fix: Auto-connect transparently, simplify tool surface, add agent guidance in tool descriptions

### 1. Server doesn't auto-reconnect
Agents start fresh sessions and immediately try `tabs.new()` without connecting first. Server silently fails or returns "no target found". No tool error says "you need to connect first".
- chat4.md: Agent tried to open mashtest tab, failed, user had to debug manually
- Fix: `browser.connect()` needed first but nothing tells agents this
- Playwright doesn't have this problem — it manages its own browser

### 2. Tabs auto-close when session expires
Default `cleanupStrategy: "close"` kills all tabs when agent session ends. User loses their work — 35 open tabs with important pages.
- chat2.md: Tabs disappearing between sessions, user extremely frustrated
- User had to learn about `cleanupStrategy: "detach"` through trial and error
- Should default to "detach" or at minimum warn before closing

### 3. Fresh tabs open to about:blank
Creating new tabs with a URL often results in about:blank — auth cookies don't propagate properly to new tabs.
- chat4.md: "The browser keeps going to about:blank" — multiple attempts failed
- chat5.md: "Tab opened to about:blank again. D365 CSW needs a fresh goto"
- Workaround: use existing authenticated tabs instead of creating new ones

### 4. Element refs go stale instantly
Between taking a snapshot and clicking an element, refs change. "Element ref=284 not found" happens constantly.
- chat2.md: 3 consecutive stale ref errors trying to click a Gmail email
- Agent had to fall back to JavaScript DOM queries to click anything
- Playwright doesn't have this problem — their ref system is stable

### 5. Can't fill React/Greenhouse comboboxes
Greenhouse forms use React synthetic events. fill() types text but dropdown doesn't select. Need to: type → wait → snapshot → find option → click option. 5 tool calls for ONE dropdown.
- chat5.md: Degree combobox — typed "Bachelor", it appeared in dropdown, but fill() didn't select it. Had to type, snapshot, find "Bachelor's Degree" option ref, click it manually
- chat5.md: Discipline combobox — same issue, "Computer Science" typed but not selected
- Playwright handles this in ONE call with its combobox type

### 6. LinkedIn clicks don't work via CDP
LinkedIn's Ember.js framework doesn't respond to CDP-dispatched mouse events on message list items.
- chat2.md: "LinkedIn Ember.js doesn't respond to CDP coordinate-based mouse events"
- Fix: Must use `el.click()` via JS execute instead of interact.click
- Every agent has to re-learn this workaround

---

## HIGH — Severely degrades experience

### 7. Monolithic 254KB single file
Entire server is ONE file: `server.js` (254,325 bytes). 11 tools with 87+ sub-actions, all in one file.
- Impossible to maintain, debug, or contribute to
- No modular structure, no separation of concerns
- Every competitor (Playwright MCP, Chrome DevTools MCP) uses modular architecture

### 8. 30-second timeout kills slow pages
D365, SharePoint, enterprise apps take 60-90+ seconds to load. CDP_TIMEOUT of 30s causes constant failures.
- chat5.md: D365 mashtest took 75+ seconds to load frames, constant timeout failures
- chat5.md: "D365 CSW stuck at Loading for over 85 seconds"
- Multiple navigation retry loops needed, each burning agent context

### 9. Snapshots are 34KB+ — too large for LLMs
Gmail, D365, LinkedIn snapshots are 30-40KB of accessibility tree text. Agents can't process them directly.
- chat2.md: "Output too large to read at once (34.0 KB). Saved to temp file"
- Agents then grep through the temp file — extra round-trips
- Playwright's snapshots are smaller and more focused

### 10. No smart form-filling for dropdowns/selects
Standard HTML `<select>` dropdowns work, but:
- React comboboxes: fail (see #5)
- Multi-select checkboxes: need individual clicks
- Autocomplete inputs: need type → wait → click suggestion
- Date pickers: no built-in support
- Playwright: `fill_form` handles ALL of these in one call

### 11. Profile targeting is broken
Can't open tabs in a specific browser profile. Everything opens in whatever profile is currently focused.
- chat4.md: User wanted to use Edge for specific accounts but tabs opened in wrong profile
- Need per-profile tab creation for multi-account workflows (personal Gmail vs job Gmail)

### 12. No built-in guidance for agents
Tools don't explain themselves. Agents don't know:
- That they need to connect first
- That cleanupStrategy should be "detach"
- That LinkedIn needs JS clicks instead of CDP clicks
- That comboboxes need multi-step workflows
- Playwright's tool descriptions are extremely detailed and self-documenting

### 13. No cross-origin iframe support (pre-v4.12.0, partially fixed)
Cross-origin iframes were completely invisible — SharePoint, Azure Portal, OAuth screens, payment forms all blank.
- chat1.md: Full detailed analysis of the issue
- chat4.md: Same problem with Azure Portal sandboxed iframes
- v4.12.0 added `Target.setAutoAttach` — partially resolved but still unreliable

---

## MEDIUM — Causes friction and wasted time

### 14. No connection health monitoring
When browser restarts or debugging port changes, server silently fails. No reconnection attempt, no health check, no warning.
- chat4.md: Server was disconnected, agent had no idea, kept failing
- Need auto-reconnect or at minimum clear error: "Browser disconnected, reconnect with browser.connect()"

### 15. Tab session expires silently
SESSION_TTL of 5 minutes means tabs lose their session lock silently. Next interaction fails with cryptic error.
- No notification that session is about to expire
- No renewal mechanism
- 5 minutes is too short for complex multi-step workflows

### 16. File upload is unreliable
Upload tool works for simple `<input type="file">` but fails on:
- Drag-and-drop upload zones
- Google Drive file picker popups
- Multi-file uploads with progress
- Playwright handles all of these

### 17. Screenshot saves to temp with auto-cleanup
Screenshots go to `.temp/` folder which auto-cleans after 30 min or 50 files. User's evidence screenshots disappear.
- chat5.md: Test screenshots saved to .temp, later lost
- Should save to user-specified path reliably

### 18. Dialog handling is reactive only
No way to pre-configure dialog handling. Each alert/confirm/prompt needs a separate tool call.
- chat5.md: "beforeunload" dialogs block navigation
- Playwright has `handleBeforeUnload` parameter

### 19. Network interception is complex
Setting up request interception requires multiple tool calls (enable, pattern, handler). Playwright's approach is simpler.

### 20. Console errors pollute every response
Every tool response includes `### Console Errors` section even when irrelevant.
- chat2.md: Every single Gmail interaction shows "TypeError: Failed to set innerHTML..." from a Chrome extension
- Adds noise to every response, wastes context tokens

### 21. No wait-for-navigation
`page.goto()` doesn't reliably wait for SPAs. Need manual `page.wait()` calls after every navigation.
- D365 uses client-side routing — goto completes but page isn't ready
- Playwright: `waitUntil: "networkidle"` works reliably

### 22. Hirist 403 overlay blocks everything
Hirist.tech throws a 403 overlay that blocks the accessibility tree. Known issue, documented in failure patterns, but agent has to re-learn the fix every session.
- chat2.md: Had to use JS to dismiss overlay before reading notifications
- Server should auto-dismiss common overlays or provide guidance

---

## LOW — Annoyances

### 23. `showAll: true` needed to see all tabs
Default `tabs.list()` shows only session-owned tabs. User's existing tabs are invisible unless `showAll: true` is passed.
- Confusing for agents — they think there are no tabs open

### 24. No keyboard shortcut support in type()
Can't type Ctrl+A, Ctrl+C, etc. via the type tool. Need separate press() action.

### 25. Viewport resets between tabs
Setting viewport 1920x1080 on one tab doesn't affect new tabs. Must set on EVERY new tab.
- chat2.md: LinkedIn renders mobile layout because viewport wasn't set on new tab

### 26. No page.waitForSelector equivalent
Must use `page.wait` with text matching or fixed timeout. Can't wait for a specific CSS selector to appear.

### 27. scroll() amount is arbitrary
Default scroll of 400px may not be enough. No "scroll element into view" action.

### 28. No batch operations
Can't fill multiple unrelated form fields in one call efficiently. Each combobox needs 3-5 tool calls.

---

## Comparison: CDP Browser vs Playwright MCP (from actual usage)

| Feature | CDP Browser MCP | Playwright MCP |
|---------|----------------|----------------|
| Browser management | Must connect to user's browser | Manages its own browser |
| Auth handling | Depends on user's logged-in sessions | Can handle login flows |
| Form filling | Text fields only, comboboxes broken | ALL field types work |
| Element stability | Refs go stale constantly | Refs are stable |
| Snapshot size | 34KB+ for complex pages | Smaller, focused |
| Page load wait | 30s timeout, manual waits | Smart waiting, networkidle |
| D365 support | Fails (60-90s loads) | Works (waited 60s, loaded fine) |
| File upload | Basic only | Full support including popups |
| Tab management | Complex session/locking system | Simple tab indexing |
| Click reliability | Fails on React/Ember/Angular apps | Works on everything |
| Speed | Slow (many round-trips per action) | Fast (single calls) |
| Error messages | Cryptic ("No target found") | Clear and actionable |
| Self-documentation | Tools don't explain usage | Detailed descriptions |
| Architecture | 254KB monolith | Modular, well-structured |
| Startup | Slow, manual connect needed | Fast, auto-launch |

---

## What users actually said

> "it is extremely extremely behind other competitors like playwright mcp"
> "it autocloses all tabs user gets so frustrated"
> "it does nothing literally"
> "connecting, maintaining the fact that the tab shouldn't be opened in focused browser profile but the profile we wanna open it in and so on all are very very very bad"
> "I think entire project needs to be re-made, restructured"
> "See how CDP is so limited, how bad its structure, tool calling, everything is"
> "agents know how to use the mcp server, and doesn't be dumb. Tool should provide info too right?"
> "We should support multiple diff browser connections right"
