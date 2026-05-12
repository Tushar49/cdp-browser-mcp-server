import { describe, it, expect } from 'vitest';
import { getSlimTools, mapSlimToFull } from '../../tools/slim-mode.js';

describe('Slim Mode', () => {
  describe('getSlimTools()', () => {
    it('should return exactly 6 tools', () => {
      const tools = getSlimTools();
      expect(tools).toHaveLength(6);
    });

    it('should expose the correct tool names', () => {
      const names = getSlimTools().map(t => t.name);
      expect(names).toEqual([
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_fill_form',
        'browser_tabs',
      ]);
    });

    it('should have schemas under 2KB total', () => {
      const tools = getSlimTools();
      const totalSize = JSON.stringify(tools.map(t => t.inputSchema)).length;
      expect(totalSize).toBeLessThan(2048);
    });

    it('should have descriptions on every tool', () => {
      for (const tool of getSlimTools()) {
        expect(tool.description.length).toBeGreaterThan(10);
      }
    });

    it('should have valid JSON Schema types on all schemas', () => {
      for (const tool of getSlimTools()) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });
  });

  describe('mapSlimToFull()', () => {
    it('should map browser_navigate to page.goto', () => {
      const result = mapSlimToFull('browser_navigate', { url: 'https://example.com', tabId: 'tab1' });
      expect(result.tool).toBe('page');
      expect(result.args).toEqual({
        action: 'goto',
        url: 'https://example.com',
        tabId: 'tab1',
      });
    });

    it('should map browser_snapshot to page.snapshot', () => {
      const result = mapSlimToFull('browser_snapshot', {
        tabId: 'tab1',
        maxLength: 5000,
        interactive: true,
        search: 'Login',
      });
      expect(result.tool).toBe('page');
      expect(result.args).toEqual({
        action: 'snapshot',
        tabId: 'tab1',
        maxLength: 5000,
        interactive: true,
        search: 'Login',
      });
    });

    it('should map browser_click to interact.click with ref → uid', () => {
      const result = mapSlimToFull('browser_click', { ref: 42, tabId: 'tab1' });
      expect(result.tool).toBe('interact');
      expect(result.args).toEqual({
        action: 'click',
        uid: 42,
        tabId: 'tab1',
      });
    });

    it('should map browser_type to interact.type', () => {
      const result = mapSlimToFull('browser_type', {
        ref: 7,
        text: 'hello',
        tabId: 'tab1',
        submit: true,
      });
      expect(result.tool).toBe('interact');
      expect(result.args).toEqual({
        action: 'type',
        uid: 7,
        text: 'hello',
        tabId: 'tab1',
        submit: true,
      });
    });

    it('should map browser_fill_form to form.fill with ref → uid mapping', () => {
      const result = mapSlimToFull('browser_fill_form', {
        fields: [
          { ref: 1, value: 'John' },
          { ref: 2, value: 'Doe' },
        ],
        tabId: 'tab1',
      });
      expect(result.tool).toBe('form');
      expect(result.args.action).toBe('fill');
      expect(result.args.tabId).toBe('tab1');
      expect(result.args.fields).toEqual([
        { uid: 1, value: 'John' },
        { uid: 2, value: 'Doe' },
      ]);
    });

    it('should map browser_tabs list action', () => {
      const result = mapSlimToFull('browser_tabs', { action: 'list' });
      expect(result.tool).toBe('tabs');
      expect(result.args).toEqual({ action: 'list', showAll: true });
    });

    it('should map browser_tabs new action', () => {
      const result = mapSlimToFull('browser_tabs', { action: 'new', url: 'https://example.com' });
      expect(result.tool).toBe('tabs');
      expect(result.args).toEqual({ action: 'new', url: 'https://example.com' });
    });

    it('should map browser_tabs close action', () => {
      const result = mapSlimToFull('browser_tabs', { action: 'close', tabId: 'tab1' });
      expect(result.tool).toBe('tabs');
      expect(result.args).toEqual({ action: 'close', tabId: 'tab1' });
    });

    it('should default browser_tabs to list when no action specified', () => {
      const result = mapSlimToFull('browser_tabs', {});
      expect(result.tool).toBe('tabs');
      expect(result.args.action).toBe('list');
    });

    it('should pass through unknown tool names unchanged', () => {
      const result = mapSlimToFull('some_unknown_tool', { foo: 'bar' });
      expect(result.tool).toBe('some_unknown_tool');
      expect(result.args).toEqual({ foo: 'bar' });
    });
  });
});
