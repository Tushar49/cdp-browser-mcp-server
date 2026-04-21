/**
 * Smart form filling engine — the #1 UX gap vs Playwright MCP.
 *
 * Handles ALL field types in a single call: text, combobox, checkbox,
 * radio, date, file uploads, select, and multi-select.  Automatically
 * detects field type from the accessibility tree role.
 *
 * The combobox handler is the key differentiator — it types values
 * char-by-char to trigger React/Angular search, waits for dropdown
 * options, and auto-selects the best match.
 */

import type { ToolResult, ServerContext } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';
import { wrapError, Errors } from '../utils/error-handler.js';
import { sleep } from '../utils/wait.js';

// ─── Arg Interfaces ─────────────────────────────────────────────────

interface FormField {
  uid: number;
  value?: string;
  type?: 'auto' | 'text' | 'combobox' | 'checkbox' | 'radio' | 'select' | 'date' | 'file';
}

interface FormArgs {
  action: 'fill' | 'read' | 'clear';
  tabId: string;
  fields: FormField[];
  sessionId?: string;
  cleanupStrategy?: string;
}

/** Validated form field with required value for fill action. */
interface FillField {
  uid: number;
  value: string;
  type?: FormField['type'];
}

/** Result for a single field operation. */
interface FieldResult {
  uid: number;
  role: string;
  success: boolean;
  message: string;
}

// ─── CDP Session Helper ─────────────────────────────────────────────

async function getTabSession(ctx: ServerContext, tabId: string): Promise<string> {
  const { sessionId } = await ctx.sendCommand('Target.attachToTarget', {
    targetId: tabId,
    flatten: true,
  }) as { sessionId: string };
  return sessionId;
}

// ─── Resolve uid → objectId via backendNodeId ───────────────────────

async function resolveUidToObjectId(
  ctx: ServerContext,
  sess: string,
  uid: number,
): Promise<{ objectId: string; backendNodeId: number }> {
  // Get full AX tree and find the node with this uid
  const { nodes } = await ctx.sendCommand('Accessibility.getFullAXTree', {}, sess) as {
    nodes: Array<{
      nodeId: string;
      backendDOMNodeId?: number;
      ignored?: boolean;
      role?: { value: string };
      name?: { value: string };
      value?: { value: unknown };
      properties?: Array<{ name: string; value: { value: unknown } }>;
      childIds?: string[];
    }>;
  };

  // Walk the AX tree and assign uids to find the matching node
  let currentUid = 1;
  const SKIP_ROLES = new Set(['none', 'GenericContainer', 'InlineTextBox']);
  let targetBackendId: number | undefined;

  // Collect non-ignored, non-structural nodes in tree order
  const nodeMap = new Map<string, typeof nodes[0]>();
  for (const n of nodes) nodeMap.set(n.nodeId, n);

  // DFS walk matching the uid assignment logic from ElementResolver
  function walk(nodeId: string): boolean {
    const raw = nodeMap.get(nodeId);
    if (!raw) return false;

    if (raw.ignored) {
      // Traverse children of ignored nodes
      for (const childId of raw.childIds || []) {
        if (walk(childId)) return true;
      }
      return false;
    }

    const role = raw.role?.value;
    if (!role || SKIP_ROLES.has(role)) {
      for (const childId of raw.childIds || []) {
        if (walk(childId)) return true;
      }
      return false;
    }

    // This node gets a uid assigned
    if (raw.backendDOMNodeId) {
      if (currentUid === uid) {
        targetBackendId = raw.backendDOMNodeId;
        return true;
      }
      currentUid++;
    } else {
      currentUid++;
    }

    for (const childId of raw.childIds || []) {
      if (walk(childId)) return true;
    }
    return false;
  }

  // Find root nodes and walk
  const roots = nodes.filter(n => {
    const parent = nodes.find(p => p.childIds?.includes(n.nodeId));
    return !parent;
  });

  for (const root of roots) {
    if (walk(root.nodeId)) break;
  }

  if (!targetBackendId) {
    throw Errors.staleRef(uid);
  }

  // Resolve backendNodeId → objectId
  const resolved = await ctx.sendCommand('DOM.resolveNode', {
    backendNodeId: targetBackendId,
  }, sess) as { object: { objectId: string } };

  if (!resolved?.object?.objectId) {
    throw Errors.staleRef(uid);
  }

  return { objectId: resolved.object.objectId, backendNodeId: targetBackendId };
}

// ─── Get AXNode info for a uid ──────────────────────────────────────

async function getAXNodeInfo(
  ctx: ServerContext,
  sess: string,
  uid: number,
): Promise<{
  role: string;
  name: string;
  value?: string;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  backendNodeId: number;
}> {
  const { nodes } = await ctx.sendCommand('Accessibility.getFullAXTree', {}, sess) as {
    nodes: Array<{
      nodeId: string;
      backendDOMNodeId?: number;
      ignored?: boolean;
      role?: { value: string };
      name?: { value: string };
      value?: { value: unknown };
      properties?: Array<{ name: string; value: { value: unknown } }>;
      childIds?: string[];
    }>;
  };

  let currentUid = 1;
  const SKIP_ROLES = new Set(['none', 'GenericContainer', 'InlineTextBox']);
  const nodeMap = new Map<string, typeof nodes[0]>();
  for (const n of nodes) nodeMap.set(n.nodeId, n);

  let foundNode: typeof nodes[0] | undefined;

  function walk(nodeId: string): boolean {
    const raw = nodeMap.get(nodeId);
    if (!raw) return false;

    if (raw.ignored) {
      for (const childId of raw.childIds || []) {
        if (walk(childId)) return true;
      }
      return false;
    }

    const role = raw.role?.value;
    if (!role || SKIP_ROLES.has(role)) {
      for (const childId of raw.childIds || []) {
        if (walk(childId)) return true;
      }
      return false;
    }

    if (currentUid === uid) {
      foundNode = raw;
      return true;
    }
    currentUid++;

    for (const childId of raw.childIds || []) {
      if (walk(childId)) return true;
    }
    return false;
  }

  const roots = nodes.filter(n => {
    const parent = nodes.find(p => p.childIds?.includes(n.nodeId));
    return !parent;
  });

  for (const root of roots) {
    if (walk(root.nodeId)) break;
  }

  if (!foundNode) throw Errors.staleRef(uid);

  // Parse properties
  const props: Record<string, unknown> = {};
  if (foundNode.properties) {
    for (const p of foundNode.properties) {
      if (p.value?.value !== undefined) props[p.name] = p.value.value;
    }
  }

  return {
    role: foundNode.role?.value || 'unknown',
    name: foundNode.name?.value || '',
    value: foundNode.value?.value !== undefined ? String(foundNode.value.value) : undefined,
    checked: props['checked'] === true || props['checked'] === 'true' ? true
           : props['checked'] === 'mixed' ? 'mixed'
           : undefined,
    selected: props['selected'] === true ? true : undefined,
    expanded: typeof props['expanded'] === 'boolean' ? props['expanded'] : undefined,
    disabled: props['disabled'] === true ? true : undefined,
    backendNodeId: foundNode.backendDOMNodeId ?? 0,
  };
}

// ─── Detect field type from AX role ─────────────────────────────────

function detectFieldType(role: string): NonNullable<FormField['type']> {
  switch (role) {
    case 'textbox':
    case 'searchbox':
    case 'textarea':
      return 'text';
    case 'combobox':
      return 'combobox';
    case 'checkbox':
    case 'switch':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'listbox':
    case 'select':
    case 'popupbutton':
      return 'select';
    case 'spinbutton':
      return 'text'; // number inputs behave like text
    default:
      return 'text'; // safe fallback
  }
}

// ─── Key dispatch helpers ───────────────────────────────────────────

interface KeyInfo {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const KEYS: Record<string, KeyInfo> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
};

async function pressKey(ctx: ServerContext, sess: string, keyName: string, modifiers = 0): Promise<void> {
  const k = KEYS[keyName] || { key: keyName, code: keyName, keyCode: 0 };
  await ctx.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
    modifiers, text: k.text,
  }, sess);
  await ctx.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
    modifiers,
  }, sess);
}

async function typeChar(ctx: ServerContext, sess: string, char: string): Promise<void> {
  await ctx.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown', text: char, key: char, unmodifiedText: char,
  }, sess);
  await ctx.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp', key: char,
  }, sess);
}

// ─── Field Handlers ─────────────────────────────────────────────────

/**
 * Text handler: Focus → Ctrl+A → Delete → type value using native setter + events.
 * Uses nativeInputValueSetter for React/Angular compatibility.
 */
async function fillText(
  ctx: ServerContext,
  sess: string,
  uid: number,
  value: string,
): Promise<FieldResult> {
  const { objectId } = await resolveUidToObjectId(ctx, sess, uid);
  const axInfo = await getAXNodeInfo(ctx, sess, uid);

  // Focus, clear, and set value using React-compatible approach
  await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      this.focus();
      // Clear existing value
      if ('value' in this) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(this, '');
        else this.value = '';
        this.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (this.isContentEditable) {
        this.textContent = '';
      }
    }`,
    objectId,
    returnByValue: true,
  }, sess);

  // Set the value using native setter for React/Angular compatibility
  const result = await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      const val = ${JSON.stringify(value)};
      if ('value' in this) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(this, val);
        else this.value = val;
      } else if (this.isContentEditable) {
        this.textContent = val;
      }
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }`,
    objectId,
    returnByValue: true,
  }, sess) as { result: { value: { ok?: boolean; error?: string } } };

  if (result.result.value?.error) {
    return { uid, role: axInfo.role, success: false, message: result.result.value.error };
  }

  const display = value.length > 40 ? value.substring(0, 40) + '…' : value;
  return { uid, role: axInfo.role, success: true, message: `"${display}"` };
}

/**
 * Combobox handler — THE KEY DIFFERENTIATOR.
 *
 * 1. Focus the combobox input
 * 2. Clear existing value
 * 3. Type value char-by-char with 50ms delay (triggers React search)
 * 4. Wait up to 3s for dropdown options to appear (poll AX tree for option roles)
 * 5. Find best matching option — scoped to aria-controls/aria-owns listbox first (P1-3)
 * 6. Click the best match option
 * 7. If no match found, try pressing Enter (some comboboxes accept free text)
 * 8. Return what was selected or error with available options
 */
async function fillCombobox(
  ctx: ServerContext,
  sess: string,
  uid: number,
  value: string,
): Promise<FieldResult> {
  const { objectId } = await resolveUidToObjectId(ctx, sess, uid);
  const axInfo = await getAXNodeInfo(ctx, sess, uid);

  // 1. Focus and clear the combobox
  await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      this.focus();
      if ('value' in this) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(this, '');
        else this.value = '';
        this.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }`,
    objectId,
    returnByValue: true,
  }, sess);

  // 2. Select all and delete to clear (keyboard approach for frameworks that listen)
  await pressKey(ctx, sess, 'Backspace');
  await sleep(50);

  // 3. Type value char-by-char to trigger React/Angular search filtering
  for (const char of value) {
    await typeChar(ctx, sess, char);
    await sleep(50);
  }

  // P1-3: Get the combobox's aria-controls/aria-owns to scope option search
  let controlledListboxId: string | null = null;
  try {
    const controlsResult = await ctx.sendCommand('Runtime.callFunctionOn', {
      functionDeclaration: `function() {
        return this.getAttribute('aria-controls') || this.getAttribute('aria-owns') || '';
      }`,
      objectId,
      returnByValue: true,
    }, sess) as { result: { value: string } };
    const controlsId = controlsResult?.result?.value;
    if (controlsId) controlledListboxId = controlsId;
  } catch { /* best-effort */ }

  // 4. Wait for dropdown options to appear (poll AX tree)
  const optionTexts: string[] = [];
  let matchedOption: { text: string; backendNodeId: number } | null = null;
  const pollStart = Date.now();

  while (Date.now() - pollStart < 3000) {
    await sleep(300);

    // Get fresh AX tree and look for option/listbox roles
    const { nodes } = await ctx.sendCommand('Accessibility.getFullAXTree', {}, sess) as {
      nodes: Array<{
        nodeId: string;
        backendDOMNodeId?: number;
        ignored?: boolean;
        role?: { value: string };
        name?: { value: string };
        childIds?: string[];
        properties?: Array<{ name: string; value: { value: unknown } }>;
      }>;
    };

    optionTexts.length = 0;
    const candidates: Array<{ text: string; backendNodeId: number }> = [];

    // P1-3: If we have a controlled listbox ID, find it and scope to its children
    let scopedNodeIds: Set<string> | null = null;
    if (controlledListboxId) {
      // Find the listbox node whose backendDOMNodeId maps to the controlled element
      const listboxNode = nodes.find(n => {
        if (n.ignored) return false;
        const role = n.role?.value;
        if (role !== 'listbox' && role !== 'menu' && role !== 'tree' && role !== 'grid') return false;
        // Check properties for the matching DOM id
        if (n.properties) {
          for (const p of n.properties) {
            if (p.name === 'id' && p.value?.value === controlledListboxId) return true;
          }
        }
        return false;
      });

      if (listboxNode) {
        // Collect all descendant nodeIds of this listbox
        scopedNodeIds = new Set<string>();
        const collectChildren = (nodeId: string) => {
          scopedNodeIds!.add(nodeId);
          const nd = nodes.find(n => n.nodeId === nodeId);
          for (const childId of nd?.childIds || []) {
            collectChildren(childId);
          }
        };
        for (const childId of listboxNode.childIds || []) {
          collectChildren(childId);
        }
      }
    }

    // If no scoped listbox found via aria-controls, try to find the nearest expanded popup
    if (!scopedNodeIds) {
      const expandedListbox = nodes.find(n => {
        if (n.ignored) return false;
        const role = n.role?.value;
        if (role !== 'listbox' && role !== 'menu' && role !== 'tree') return false;
        // Check if expanded
        const expandedProp = n.properties?.find(p => p.name === 'expanded');
        return expandedProp?.value?.value === true;
      });

      if (expandedListbox) {
        scopedNodeIds = new Set<string>();
        const collectChildren = (nodeId: string) => {
          scopedNodeIds!.add(nodeId);
          const nd = nodes.find(n => n.nodeId === nodeId);
          for (const childId of nd?.childIds || []) {
            collectChildren(childId);
          }
        };
        for (const childId of expandedListbox.childIds || []) {
          collectChildren(childId);
        }
      }
    }

    for (const node of nodes) {
      if (node.ignored) continue;

      // P1-3: If we have a scoped set, only consider nodes within it
      if (scopedNodeIds && !scopedNodeIds.has(node.nodeId)) continue;

      const role = node.role?.value;
      if (role === 'option' || role === 'menuitem' || role === 'listitem' || role === 'treeitem') {
        const text = (node.name?.value || '').trim();
        if (!text) continue;
        optionTexts.push(text);
        if (node.backendDOMNodeId) {
          candidates.push({ text, backendNodeId: node.backendDOMNodeId });
        }
      }
    }

    if (candidates.length === 0) continue;

    // 5. Find best match: exact → startsWith → includes → case-insensitive variants
    const valueLower = value.toLowerCase();

    // Exact match
    matchedOption = candidates.find(c => c.text === value) || null;

    // Case-insensitive exact match
    if (!matchedOption) {
      matchedOption = candidates.find(c => c.text.toLowerCase() === valueLower) || null;
    }

    // startsWith match
    if (!matchedOption) {
      matchedOption = candidates.find(c => c.text.toLowerCase().startsWith(valueLower)) || null;
    }

    // includes match
    if (!matchedOption) {
      matchedOption = candidates.find(c => c.text.toLowerCase().includes(valueLower)) || null;
    }

    // Fuzzy: value is contained in option text, or option text contained in value
    if (!matchedOption) {
      matchedOption = candidates.find(c => valueLower.includes(c.text.toLowerCase())) || null;
    }

    if (matchedOption) break;

    // If we have options but no match, keep polling briefly in case more load
    if (candidates.length > 0 && Date.now() - pollStart > 1500) break;
  }

  // 6. Click the matched option
  if (matchedOption) {
    try {
      const resolved = await ctx.sendCommand('DOM.resolveNode', {
        backendNodeId: matchedOption.backendNodeId,
      }, sess) as { object: { objectId: string } };

      if (resolved?.object?.objectId) {
        await ctx.sendCommand('Runtime.callFunctionOn', {
          functionDeclaration: `function() {
            this.scrollIntoView({ block: "center" });
            this.click();
          }`,
          objectId: resolved.object.objectId,
          returnByValue: true,
        }, sess);

        return {
          uid,
          role: axInfo.role,
          success: true,
          message: `selected "${matchedOption.text}" from ${optionTexts.length} options`,
        };
      }
    } catch {
      // Click via DOM failed — try mouse click via box model
    }

    // Fallback: try clicking via getBoxModel + mouse event
    try {
      const box = await ctx.sendCommand('DOM.getBoxModel', {
        backendNodeId: matchedOption.backendNodeId,
      }, sess) as { model: { content: number[] } };

      if (box?.model?.content) {
        const q = box.model.content;
        const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
        const cy = (q[1] + q[3] + q[5] + q[7]) / 4;

        await ctx.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: cx, y: cy,
        }, sess);
        await sleep(30);
        await ctx.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1,
        }, sess);
        await ctx.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
        }, sess);

        return {
          uid,
          role: axInfo.role,
          success: true,
          message: `selected "${matchedOption.text}" from ${optionTexts.length} options`,
        };
      }
    } catch {
      // Fall through to Enter fallback
    }
  }

  // 7. No match — try pressing Enter for free-text comboboxes
  if (optionTexts.length === 0) {
    await pressKey(ctx, sess, 'Enter');
    return {
      uid,
      role: axInfo.role,
      success: true,
      message: `"${value}" (no dropdown appeared — submitted as free text)`,
    };
  }

  // 8. Options exist but no match found
  const available = optionTexts.slice(0, 10);
  return {
    uid,
    role: axInfo.role,
    success: false,
    message: `no match for "${value}" — available: ${JSON.stringify(available)}`,
  };
}

/**
 * Checkbox handler: Read current checked state from AXNode, click only if != desired.
 */
async function fillCheckbox(
  ctx: ServerContext,
  sess: string,
  uid: number,
  value: string,
): Promise<FieldResult> {
  const { objectId } = await resolveUidToObjectId(ctx, sess, uid);
  const axInfo = await getAXNodeInfo(ctx, sess, uid);

  const desired = value === 'true' || value === '1' || value === 'yes';

  const result = await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      const desired = ${desired};
      const current = this.checked || this.getAttribute('aria-checked') === 'true';
      if (current !== desired) {
        this.click();
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { checked: desired };
    }`,
    objectId,
    returnByValue: true,
  }, sess) as { result: { value: { checked: boolean } } };

  return {
    uid,
    role: axInfo.role,
    success: true,
    message: desired ? 'checked' : 'unchecked',
  };
}

/**
 * Radio handler: Click the radio button.
 */
async function fillRadio(
  ctx: ServerContext,
  sess: string,
  uid: number,
  value: string,
): Promise<FieldResult> {
  const { objectId } = await resolveUidToObjectId(ctx, sess, uid);
  const axInfo = await getAXNodeInfo(ctx, sess, uid);

  await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      this.click();
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    objectId,
    returnByValue: true,
  }, sess);

  return {
    uid,
    role: axInfo.role,
    success: true,
    message: `selected "${value}"`,
  };
}

/**
 * Select handler: For native <select>, set value and fire change event.
 */
async function fillSelect(
  ctx: ServerContext,
  sess: string,
  uid: number,
  value: string,
): Promise<FieldResult> {
  const { objectId } = await resolveUidToObjectId(ctx, sess, uid);
  const axInfo = await getAXNodeInfo(ctx, sess, uid);

  const result = await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      const val = ${JSON.stringify(value)};

      if (this.tagName === 'SELECT') {
        let opt = Array.from(this.options).find(o => o.value === val || o.textContent.trim() === val);
        if (!opt) {
          // Case-insensitive match
          opt = Array.from(this.options).find(o =>
            o.value.toLowerCase() === val.toLowerCase() ||
            o.textContent.trim().toLowerCase() === val.toLowerCase()
          );
        }
        if (!opt) {
          const available = Array.from(this.options).map(o => o.textContent.trim()).filter(Boolean);
          return { error: "Option not found: " + val, available };
        }

        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(this, opt.value);
        else this.value = opt.value;

        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: opt.textContent.trim() };
      }

      // Custom dropdown — click to open, then look for matching option
      this.click();
      return { customDropdown: true };
    }`,
    objectId,
    returnByValue: true,
  }, sess) as { result: { value: { selected?: string; error?: string; available?: string[]; customDropdown?: boolean } } };

  const v = result.result.value;

  if (v?.error) {
    const availableStr = v.available ? ` — available: ${JSON.stringify(v.available.slice(0, 10))}` : '';
    return {
      uid,
      role: axInfo.role,
      success: false,
      message: `${v.error}${availableStr}`,
    };
  }

  if (v?.customDropdown) {
    // Wait for dropdown to open, then find and click the option
    await sleep(300);
    const clickResult = await ctx.sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const val = ${JSON.stringify(value)};
        const valLower = val.toLowerCase();
        const options = document.querySelectorAll('[role="option"], [role="listitem"], li[data-value], .MuiMenuItem-root, .ant-select-item, [class*="option"]');
        for (const opt of options) {
          const text = opt.textContent.trim();
          const optValue = opt.getAttribute("data-value") || opt.getAttribute("value") || "";
          if (text === val || optValue === val || text.toLowerCase() === valLower) {
            opt.scrollIntoView({ block: "center" });
            opt.click();
            return { selected: text };
          }
        }
        const available = Array.from(options).slice(0, 10).map(o => o.textContent.trim());
        return { error: "Option not found in custom dropdown", available };
      })()`,
      returnByValue: true,
    }, sess) as { result: { value: { selected?: string; error?: string; available?: string[] } } };

    const cv = clickResult.result.value;
    if (cv?.error) {
      const availableStr = cv.available?.length ? ` — available: ${JSON.stringify(cv.available)}` : '';
      return { uid, role: axInfo.role, success: false, message: `${cv.error}${availableStr}` };
    }

    return { uid, role: axInfo.role, success: true, message: `"${cv.selected}"` };
  }

  return { uid, role: axInfo.role, success: true, message: `"${v.selected}"` };
}

/**
 * Date handler: Focus → clear → type ISO date string.
 */
async function fillDate(
  ctx: ServerContext,
  sess: string,
  uid: number,
  value: string,
): Promise<FieldResult> {
  const { objectId } = await resolveUidToObjectId(ctx, sess, uid);
  const axInfo = await getAXNodeInfo(ctx, sess, uid);

  const result = await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      this.focus();
      const val = ${JSON.stringify(value)};

      // Native date input
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(this, val);
      else this.value = val;

      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }`,
    objectId,
    returnByValue: true,
  }, sess);

  return { uid, role: axInfo.role, success: true, message: `"${value}"` };
}

/**
 * File handler: Set files on a file input.
 */
async function fillFile(
  ctx: ServerContext,
  sess: string,
  uid: number,
  value: string,
): Promise<FieldResult> {
  const { backendNodeId } = await resolveUidToObjectId(ctx, sess, uid);
  const axInfo = await getAXNodeInfo(ctx, sess, uid);
  const files = value.split(',').map(f => f.trim());

  try {
    await ctx.sendCommand('DOM.setFileInputFiles', {
      files,
      backendNodeId,
    }, sess);

    const fileNames = files.map(f => f.split(/[/\\]/).pop()).join(', ');
    return { uid, role: axInfo.role, success: true, message: `uploaded ${fileNames}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { uid, role: axInfo.role, success: false, message: `upload failed: ${msg}` };
  }
}

// ─── Smart Fill Dispatch ────────────────────────────────────────────

async function smartFillField(
  ctx: ServerContext,
  sess: string,
  uid: number,
  value: string,
  fieldType: FormField['type'],
): Promise<FieldResult> {
  // Detect field type from AX tree if auto
  let resolvedType: NonNullable<FormField['type']> = fieldType || 'auto';

  if (resolvedType === 'auto') {
    const axInfo = await getAXNodeInfo(ctx, sess, uid);
    resolvedType = detectFieldType(axInfo.role);
  }

  switch (resolvedType) {
    case 'text':
      return fillText(ctx, sess, uid, value);
    case 'combobox':
      return fillCombobox(ctx, sess, uid, value);
    case 'checkbox':
      return fillCheckbox(ctx, sess, uid, value);
    case 'radio':
      return fillRadio(ctx, sess, uid, value);
    case 'select':
      return fillSelect(ctx, sess, uid, value);
    case 'date':
      return fillDate(ctx, sess, uid, value);
    case 'file':
      return fillFile(ctx, sess, uid, value);
    default:
      return fillText(ctx, sess, uid, value);
  }
}

// ─── Read Fields ────────────────────────────────────────────────────

async function readFields(
  ctx: ServerContext,
  sess: string,
  fields: FormField[],
): Promise<FieldResult[]> {
  const results: FieldResult[] = [];

  for (const field of fields) {
    try {
      const axInfo = await getAXNodeInfo(ctx, sess, field.uid);
      const currentValue = axInfo.value ?? '';
      const stateInfo: string[] = [];

      if (axInfo.checked !== undefined) stateInfo.push(`checked=${axInfo.checked}`);
      if (axInfo.selected !== undefined) stateInfo.push(`selected=${axInfo.selected}`);
      if (axInfo.disabled) stateInfo.push('disabled');

      const extra = stateInfo.length > 0 ? ` [${stateInfo.join(', ')}]` : '';

      results.push({
        uid: field.uid,
        role: axInfo.role,
        success: true,
        message: `"${currentValue}"${extra}`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ uid: field.uid, role: 'unknown', success: false, message: msg });
    }
  }

  return results;
}

// ─── Clear Fields ───────────────────────────────────────────────────

async function clearFields(
  ctx: ServerContext,
  sess: string,
  fields: FormField[],
): Promise<FieldResult[]> {
  const results: FieldResult[] = [];

  for (const field of fields) {
    try {
      const axInfo = await getAXNodeInfo(ctx, sess, field.uid);
      const { objectId } = await resolveUidToObjectId(ctx, sess, field.uid);

      const type = detectFieldType(axInfo.role);

      if (type === 'checkbox') {
        // Uncheck if checked
        await ctx.sendCommand('Runtime.callFunctionOn', {
          functionDeclaration: `function() {
            if (this.checked || this.getAttribute('aria-checked') === 'true') {
              this.click();
              this.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }`,
          objectId,
          returnByValue: true,
        }, sess);
        results.push({ uid: field.uid, role: axInfo.role, success: true, message: 'unchecked' });
      } else {
        // Clear text-like fields
        await ctx.sendCommand('Runtime.callFunctionOn', {
          functionDeclaration: `function() {
            this.focus();
            if ('value' in this) {
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                                || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
              if (nativeSetter) nativeSetter.call(this, '');
              else this.value = '';
            } else if (this.isContentEditable) {
              this.textContent = '';
            }
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }`,
          objectId,
          returnByValue: true,
        }, sess);
        results.push({ uid: field.uid, role: axInfo.role, success: true, message: 'cleared' });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ uid: field.uid, role: 'unknown', success: false, message: msg });
    }
  }

  return results;
}

// ─── Format Results ─────────────────────────────────────────────────

function formatResults(action: string, results: FieldResult[]): string {
  const successes = results.filter(r => r.success).length;
  const failures = results.length - successes;

  const lines: string[] = [];

  const actionVerb = action === 'fill' ? 'Filled' : action === 'read' ? 'Read' : 'Cleared';
  const summary = failures > 0
    ? `${actionVerb} ${successes}/${results.length} fields (${failures} failed):`
    : `${actionVerb} ${results.length} fields:`;
  lines.push(summary);

  for (const r of results) {
    const icon = r.success ? '✓' : '✗';
    lines.push(`  ${icon} uid=${r.uid} (${r.role}): ${r.message}`);
  }

  return lines.join('\n');
}

// ─── Tool Description ───────────────────────────────────────────────

const FORM_DESCRIPTION = [
  'Smart form filling — handles text, combobox, checkbox, radio, date, file uploads, and multi-select in a single call.',
  '',
  'Automatically detects field type from accessibility tree role. For React/Greenhouse comboboxes,',
  'types the value char-by-char, waits for dropdown options, and auto-selects the best match.',
  '',
  'Actions:',
  '- fill: Set field values. Auto-detects type from a11y role, or override with type parameter.',
  '- read: Get current values of specified fields from the accessibility tree.',
  '- clear: Reset all specified fields (clear text, uncheck checkboxes).',
  '',
  'Supported field types (auto-detected from role):',
  '  textbox/searchbox/textarea → types value with React-compatible events',
  '  combobox → types char-by-char, waits for dropdown, selects best match',
  '  checkbox/switch → toggles checked state',
  '  radio → clicks the radio button',
  '  listbox/select → sets native <select> or handles custom dropdowns',
  '  spinbutton → treated as text input',
  '',
  'Example:',
  '  form({ action: "fill", tabId: "...", fields: [',
  '    { uid: 5, value: "John Doe" },',
  '    { uid: 8, value: "Bachelor\'s Degree" },',
  '    { uid: 12, value: "true" },',
  '    { uid: 15, value: "India" }',
  '  ]})',
  '',
  'Always take a snapshot first to get uid refs for the fields you want to fill.',
].join('\n');

// ─── Input Schema ───────────────────────────────────────────────────

const FORM_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: {
      type: 'string' as const,
      enum: ['fill', 'read', 'clear'] as const,
      description: 'fill: set values, read: get current values, clear: reset all fields',
    },
    tabId: {
      type: 'string' as const,
      description: 'Tab ID.',
    },
    fields: {
      type: 'array' as const,
      description: 'Fields to operate on. Each needs uid (from snapshot). Value is required for fill, optional for read/clear.',
      items: {
        type: 'object' as const,
        properties: {
          uid: {
            type: 'number' as const,
            description: 'Element uid from snapshot.',
          },
          value: {
            type: 'string' as const,
            description: 'Value to set. For checkbox: "true"/"false". For combobox: text of the option. For file: comma-separated absolute paths.',
          },
          type: {
            type: 'string' as const,
            enum: ['auto', 'text', 'combobox', 'checkbox', 'radio', 'select', 'date', 'file'] as const,
            description: 'Field type. Default "auto" detects from a11y role.',
          },
        },
        required: ['uid'] as const,
      },
    },
    sessionId: {
      type: 'string' as const,
      description: 'Agent session ID for tab ownership. Default: per-process UUID.',
    },
    cleanupStrategy: {
      type: 'string' as const,
      enum: ['close', 'detach', 'none'] as const,
      description: "Tab cleanup on session expiry. 'close' removes tabs, 'detach' keeps them, 'none' skips cleanup.",
    },
  },
  required: ['action', 'tabId', 'fields'] as const,
};

// ─── Tool Registration ──────────────────────────────────────────────

export function registerFormTools(registry: ToolRegistry, _ctx: ServerContext): void {
  registry.register(
    defineTool({
      name: 'form',
      description: FORM_DESCRIPTION,
      inputSchema: FORM_INPUT_SCHEMA as Record<string, unknown>,
      handler: async (ctx, params) => {
        const args = params as unknown as FormArgs;

        if (!args.action) return fail("Provide 'action' parameter: fill, read, or clear.");
        if (!args.tabId) return fail("Provide 'tabId' parameter.");
        if (!args.fields?.length) return fail("Provide 'fields' array with at least one field.");

        try {
          const sess = await getTabSession(ctx, args.tabId);

          switch (args.action) {
            case 'fill': {
              // Validate that all fields have a value for fill action
              for (const field of args.fields) {
                if (field.value === undefined || field.value === null) {
                  return fail(`Field uid=${field.uid} requires a 'value' for fill action.`);
                }
              }
              const results: FieldResult[] = [];
              for (const field of args.fields) {
                try {
                  const result = await smartFillField(ctx, sess, field.uid, field.value!, field.type);
                  results.push(result);
                } catch (e: unknown) {
                  const msg = e instanceof Error ? e.message : String(e);
                  results.push({ uid: field.uid, role: 'unknown', success: false, message: msg });
                }
              }
              const hasFailures = results.some(r => !r.success);
              const text = formatResults('fill', results);
              return hasFailures ? { content: [{ type: 'text', text }], isError: true } : ok(text);
            }

            case 'read': {
              const results = await readFields(ctx, sess, args.fields);
              return ok(formatResults('read', results));
            }

            case 'clear': {
              const results = await clearFields(ctx, sess, args.fields);
              const hasFailures = results.some(r => !r.success);
              const text = formatResults('clear', results);
              return hasFailures ? { content: [{ type: 'text', text }], isError: true } : ok(text);
            }

            default:
              return fail(`Unknown form action: "${args.action}". Available: fill, read, clear.`);
          }
        } catch (error: unknown) {
          return wrapError(error).toToolResult();
        }
      },
    }),
  );
}
