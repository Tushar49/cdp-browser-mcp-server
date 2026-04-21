import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../../types.js';

function makeTool(name: string, handler?: ToolDefinition['handler']): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: handler ?? (async () => ({
      content: [{ type: 'text', text: `${name} result` }],
    })),
  };
}

// Minimal mock of ServerContext — only fields needed by dispatch
function mockCtx(): ServerContext {
  return {} as ServerContext;
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register()', () => {
    it('stores tool', () => {
      registry.register(makeTool('my-tool'));
      expect(registry.has('my-tool')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('throws on duplicate name', () => {
      registry.register(makeTool('dup'));
      expect(() => registry.register(makeTool('dup'))).toThrow('already registered');
    });
  });

  describe('list()', () => {
    it('returns all tools in MCP format', () => {
      registry.register(makeTool('tool-a'));
      registry.register(makeTool('tool-b'));

      const listed = registry.list();
      expect(listed).toHaveLength(2);

      const names = listed.map(t => t.name).sort();
      expect(names).toEqual(['tool-a', 'tool-b']);

      for (const t of listed) {
        expect(t).toHaveProperty('name');
        expect(t).toHaveProperty('description');
        expect(t).toHaveProperty('inputSchema');
        // handler should NOT be in list output
        expect(t).not.toHaveProperty('handler');
      }
    });

    it('returns empty array when no tools registered', () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe('dispatch()', () => {
    it('calls correct handler', async () => {
      const handler = vi.fn(async (): Promise<ToolResult> => ({
        content: [{ type: 'text', text: 'hello' }],
      }));
      registry.register(makeTool('greeter', handler));

      const result = await registry.dispatch('greeter', { name: 'world' }, mockCtx());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.anything(), { name: 'world' });
      expect(result.content[0].text).toBe('hello');
      expect(result.isError).toBeUndefined();
    });

    it('returns error for unknown tool', async () => {
      const result = await registry.dispatch('nonexistent', {}, mockCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
      expect(result.content[0].text).toContain('nonexistent');
    });

    it('wraps handler exceptions into ToolResult', async () => {
      const handler = vi.fn(async () => {
        throw new Error('handler boom');
      });
      registry.register(makeTool('boomer', handler));

      const result = await registry.dispatch('boomer', {}, mockCtx());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('handler boom');
    });

    it('passes ServerContext to handler', async () => {
      const ctx = mockCtx();
      const handler = vi.fn(async (c: ServerContext): Promise<ToolResult> => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      registry.register(makeTool('ctx-check', handler));

      await registry.dispatch('ctx-check', {}, ctx);
      expect(handler.mock.calls[0][0]).toBe(ctx);
    });
  });

  describe('has()', () => {
    it('returns true for registered tool', () => {
      registry.register(makeTool('exists'));
      expect(registry.has('exists')).toBe(true);
    });

    it('returns false for unregistered tool', () => {
      expect(registry.has('nope')).toBe(false);
    });
  });

  describe('size', () => {
    it('returns correct count', () => {
      expect(registry.size).toBe(0);
      registry.register(makeTool('a'));
      expect(registry.size).toBe(1);
      registry.register(makeTool('b'));
      expect(registry.size).toBe(2);
    });
  });
});
