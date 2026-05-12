# Task: Add Human-Like Typing with Word-Aware Delays to CDP Browser MCP Server

## Objective

Enhance the `interact` tool's `type` action in the CDP Browser MCP server at **`E:\Projects\CDP Browser Automation\MCP Server\server.js`** to support **randomized, human-like typing delays** with separate control for character-level and word-level gaps. The current `delay` parameter applies a fixed delay between every keystroke — it has no concept of words, no randomization, and no way to specify different timing for characters within a word vs. spaces between words.

## Current State

The `handleInteractType` function (around line 2135 of `server.js`) has two code paths:

1. **`delay > 0`**: Loops through each character, dispatches `Input.dispatchKeyEvent` (keyDown + keyUp), then `await sleep(args.delay)` — a **fixed** delay after every character, no word awareness.
2. **No delay**: Instant fill via `Runtime.evaluate` using native input value setter or `execCommand('insertText')`.

### Current delay parameter in schema (line ~1203):
```js
delay: { type: "number", description: "Delay in ms between keystrokes for type action (enables char-by-char typing like Playwright's pressSequentially)." },
```

### Current typing loop (line ~2156-2162):
```js
if (args.delay && args.delay > 0) {
  for (const char of args.text) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char, unmodifiedText: char }, sess);
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: char }, sess);
    await sleep(args.delay);
  }
}
```

### Helper (line ~692):
```js
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
```

## Required Changes

### 1. Add new parameters to the `interact` tool's `inputSchema`

Add these properties alongside the existing `delay` parameter (around line 1203):

| Parameter | Type | Default | Description |
|---|---|---|---|
| `charDelay` | number | 200 | Base delay in ms between characters within a word. Actual delay per char is randomized in range `[charDelay, charDelay * 3]`. |
| `wordDelay` | number | 800 | Base delay in ms between words (applied when typing a space character). Actual delay per space is randomized in range `[wordDelay, wordDelay * 3]`. |

**Behavior:**
- If `charDelay` is provided (with or without `wordDelay`), it activates the **human-like typing mode** — character-by-character with randomized delays.
- `wordDelay` defaults to `800` if `charDelay` is provided but `wordDelay` is not.
- `charDelay` defaults to `200` if `wordDelay` is provided but `charDelay` is not.
- The existing `delay` parameter should still work as before (fixed delay, no randomization, no word awareness) for backward compatibility.
- If both `delay` AND `charDelay`/`wordDelay` are provided, `charDelay`/`wordDelay` take precedence (human-like mode wins).

### 2. Add randomization helper

Add a helper function near `sleep()`:

```js
function randomDelay(baseMs) {
  // Returns random value in range [baseMs, baseMs * 3]
  return baseMs + Math.random() * (baseMs * 2);
}
```

### 3. Modify `handleInteractType` typing loop

Replace the delay typing section with a three-tier check:

```js
if (args.charDelay || args.wordDelay) {
  // Human-like typing: randomized per-char and per-word delays
  const charBase = args.charDelay || 200;
  const wordBase = args.wordDelay || 800;
  
  for (const char of args.text) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char, unmodifiedText: char }, sess);
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: char }, sess);
    
    if (char === ' ' || char === '\t') {
      // Word boundary — longer pause
      await sleep(randomDelay(wordBase));
    } else if (char === '\n') {
      // Newline — use word delay (natural pause at line breaks)
      await sleep(randomDelay(wordBase));
    } else {
      // Regular character within a word
      await sleep(randomDelay(charBase));
    }
  }
} else if (args.delay && args.delay > 0) {
  // Legacy: fixed delay per keystroke (backward compatible)
  for (const char of args.text) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char, unmodifiedText: char }, sess);
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: char }, sess);
    await sleep(args.delay);
  }
} else {
  // Instant fill (existing behavior, unchanged)
  // ... existing Runtime.evaluate code ...
}
```

### 4. Update the tool description

In the `description` array for the `interact` tool (around line 1167), update the `type` operation line:

**From:**
```
"- type: Type text into a focused input field (requires: tabId, text, uid or selector; optional: clear[default:true] — clears field first, submit — press Enter after typing, delay — ms between keystrokes for char-by-char typing)",
```

**To:**
```
"- type: Type text into a focused input field (requires: tabId, text, uid or selector; optional: clear[default:true] — clears field first, submit — press Enter after typing, delay — fixed ms between keystrokes, charDelay — base ms between chars with randomized range [base, base*3] default 200ms, wordDelay — base ms between words with randomized range [base, base*3] default 800ms)",
```

### 5. Update parameter descriptions in `inputSchema`

Add after the existing `delay` property:

```js
charDelay: { type: "number", description: "Base delay in ms between characters within a word for human-like typing. Actual delay randomized in [charDelay, charDelay*3]. Default 200ms. Activates human-like mode." },
wordDelay: { type: "number", description: "Base delay in ms between words (spaces/newlines) for human-like typing. Actual delay randomized in [wordDelay, wordDelay*3]. Default 800ms." },
```

## Summary of changes

1. **Add `randomDelay(baseMs)` helper** near the existing `sleep()` function (~line 692)
2. **Add `charDelay` and `wordDelay` to `inputSchema.properties`** (~line 1203, after `delay`)
3. **Update tool description string** (~line 1167) to document new params
4. **Modify `handleInteractType`** (~line 2156) to add the human-like typing branch before the existing `delay` branch
5. **Do NOT change** the instant-fill path or the legacy `delay` path — both must remain for backward compatibility

## Example Usage After Change

```json
{
  "action": "type",
  "tabId": "ABC123",
  "uid": 539,
  "text": "Hi Prem, thank you for the opportunity. Looking forward to it!",
  "clear": false,
  "charDelay": 70,
  "wordDelay": 1500
}
```

This would type each character with a random delay of 70-210ms, and each space/word boundary with 1500-4500ms.

With defaults (just specify one):
```json
{ "action": "type", "tabId": "ABC123", "uid": 539, "text": "Hello world", "charDelay": 200 }
```
→ charDelay=200 (range 200-600ms per char), wordDelay defaults to 800 (range 800-2400ms per word).

## File to edit

**`E:\Projects\CDP Browser Automation\MCP Server\server.js`** — single file, all changes go here.
