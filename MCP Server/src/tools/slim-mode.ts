/**
 * Slim mode reduces the tool surface for small-context models.
 * Instead of 15 tools with 90+ actions, expose 6 essential tools
 * with simplified schemas.
 *
 * Enable via: CDP_SLIM_MODE=true or { mode: "slim" } in config
 *
 * The 6 slim tools use Playwright-compatible naming so agents that
 * already know Playwright MCP can use them without learning new APIs.
 */

export interface SlimToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Returns the 6 essential tools with minimal schemas.
 * Total schema size: ~1.5KB vs ~8KB+ for full tool set.
 */
export function getSlimTools(): SlimToolDef[] {
  return [
    {
      name: 'browser_navigate',
      description: 'Navigate to URL. Auto-connects to browser.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          tabId: { type: 'string', description: 'Tab ID (optional — uses active tab if omitted)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'browser_snapshot',
      description: 'Get page accessibility snapshot with element refs. Use refs to interact with elements.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          maxLength: { type: 'number', description: 'Max chars to return (default: 8000)' },
          interactive: { type: 'boolean', description: 'Only show interactive elements (buttons, inputs, links)' },
          search: { type: 'string', description: 'Filter snapshot to elements matching this text' },
        },
      },
    },
    {
      name: 'browser_click',
      description: 'Click an element by ref from snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'Element ref from snapshot' },
          tabId: { type: 'string' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'browser_type',
      description: 'Type text into focused element or element by ref.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'Element ref (optional — types into focused element)' },
          text: { type: 'string', description: 'Text to type' },
          tabId: { type: 'string' },
          submit: { type: 'boolean', description: 'Press Enter after typing' },
        },
        required: ['text'],
      },
    },
    {
      name: 'browser_fill_form',
      description: 'Fill multiple form fields at once. Handles text, dropdowns, checkboxes, all types.',
      inputSchema: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'number', description: 'Element ref from snapshot' },
                value: { type: 'string', description: 'Value to fill' },
              },
              required: ['ref', 'value'],
            },
          },
          tabId: { type: 'string' },
        },
        required: ['fields'],
      },
    },
    {
      name: 'browser_tabs',
      description: 'List open tabs, create new tab, or close a tab.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'new', 'close'],
            description: 'list: show tabs, new: open tab, close: close tab',
          },
          url: { type: 'string', description: 'URL for new tab' },
          tabId: { type: 'string', description: 'Tab to close' },
        },
      },
    },
  ];
}

/**
 * Maps slim tool calls to full tool calls.
 *
 * This allows slim tools to reuse the existing handler infrastructure
 * without duplicating any logic.
 */
export function mapSlimToFull(
  slimName: string,
  args: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } {
  switch (slimName) {
    case 'browser_navigate':
      return {
        tool: 'page',
        args: { action: 'goto', url: args.url, tabId: args.tabId },
      };
    case 'browser_snapshot':
      return {
        tool: 'page',
        args: {
          action: 'snapshot',
          tabId: args.tabId,
          maxLength: args.maxLength,
          interactive: args.interactive,
          search: args.search,
        },
      };
    case 'browser_click':
      return {
        tool: 'interact',
        args: { action: 'click', uid: args.ref, tabId: args.tabId },
      };
    case 'browser_type':
      return {
        tool: 'interact',
        args: {
          action: 'type',
          uid: args.ref,
          text: args.text,
          tabId: args.tabId,
          submit: args.submit,
        },
      };
    case 'browser_fill_form':
      return {
        tool: 'form',
        args: {
          action: 'fill',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridging slim→full field shape
          fields: (args.fields as any[])?.map(f => ({ uid: f.ref, value: f.value })),
          tabId: args.tabId,
        },
      };
    case 'browser_tabs': {
      if (args.action === 'new')
        return { tool: 'tabs', args: { action: 'new', url: args.url } };
      if (args.action === 'close')
        return { tool: 'tabs', args: { action: 'close', tabId: args.tabId } };
      return { tool: 'tabs', args: { action: 'list', showAll: true } };
    }
    default:
      return { tool: slimName, args };
  }
}
