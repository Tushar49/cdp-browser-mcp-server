import { describe, it, expect } from 'vitest';
import { TokenOptimizer } from '../../snapshot/token-optimizer.js';
import type { AXNode } from '../../snapshot/accessibility.js';

function node(role: string, name = '', children?: AXNode[], extra?: Partial<AXNode>): AXNode {
  return { role, name, backendNodeId: 0, ...extra, children };
}

describe('TokenOptimizer', () => {
  describe('filterRoles()', () => {
    it('removes decorative roles: generic, none, presentation, separator, LineBreak, InlineTextBox', () => {
      const skipRoles = ['generic', 'none', 'presentation', 'separator', 'LineBreak', 'InlineTextBox'];
      for (const role of skipRoles) {
        const result = TokenOptimizer.filterRoles([node(role, 'text')]);
        // The node itself is removed (children promoted, but there are none)
        expect(result).toHaveLength(0);
      }
    });

    it('promotes children of removed nodes', () => {
      const tree = [node('generic', '', [node('button', 'Click'), node('link', 'Go')])];
      const result = TokenOptimizer.filterRoles(tree);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('button');
      expect(result[1].role).toBe('link');
    });

    it('preserves interactive roles', () => {
      const interactiveRoles = ['button', 'textbox', 'link', 'combobox', 'checkbox', 'radio',
        'listbox', 'menuitem', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'searchbox'];
      for (const role of interactiveRoles) {
        const result = TokenOptimizer.filterRoles([node(role, 'test')]);
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe(role);
      }
    });

    it('recursively filters nested decorative roles', () => {
      const tree = [
        node('group', 'container', [
          node('generic', '', [node('button', 'OK')]),
        ]),
      ];
      const result = TokenOptimizer.filterRoles(tree);

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('group');
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children![0].role).toBe('button');
    });
  });

  describe('truncateText()', () => {
    it('caps text at specified length', () => {
      const longName = 'a'.repeat(200);
      const tree = [node('heading', longName)];
      const result = TokenOptimizer.truncateText(tree, 50);

      expect(result[0].name!.length).toBe(51); // 50 chars + '…'
      expect(result[0].name!.endsWith('…')).toBe(true);
    });

    it('does not truncate text within limit', () => {
      const tree = [node('heading', 'short text')];
      const result = TokenOptimizer.truncateText(tree, 50);
      expect(result[0].name).toBe('short text');
    });

    it('truncates value field too', () => {
      const tree = [node('textbox', 'label', undefined, { value: 'x'.repeat(200) })];
      const result = TokenOptimizer.truncateText(tree, 30);
      expect(result[0].value!.length).toBe(31); // 30 + '…'
    });

    it('recursively truncates children', () => {
      const tree = [node('group', 'g', [node('text', 'a'.repeat(200))])];
      const result = TokenOptimizer.truncateText(tree, 50);
      expect(result[0].children![0].name!.length).toBe(51);
    });
  });

  describe('limitDepth()', () => {
    it('removes children beyond max depth', () => {
      const tree = [
        node('root', 'r', [
          node('level1', 'l1', [
            node('level2', 'l2', [
              node('level3', 'l3'),
            ]),
          ]),
        ]),
      ];

      const result = TokenOptimizer.limitDepth(tree, 2);
      expect(result[0].role).toBe('root');
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children![0].children).toEqual([]);
    });

    it('returns empty array at depth 0', () => {
      const tree = [node('root', 'r')];
      expect(TokenOptimizer.limitDepth(tree, 0)).toEqual([]);
    });

    it('preserves full tree when depth is sufficient', () => {
      const tree = [node('root', 'r', [node('child', 'c')])];
      const result = TokenOptimizer.limitDepth(tree, 10);
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children![0].role).toBe('child');
    });
  });

  describe('collapseEmpty()', () => {
    it('removes empty containers with no name, value, or interactive role', () => {
      const tree = [node('group', '')];
      const result = TokenOptimizer.collapseEmpty(tree);
      expect(result).toHaveLength(0);
    });

    it('promotes single child when collapsing', () => {
      const tree = [node('group', '', [node('button', 'OK')])];
      const result = TokenOptimizer.collapseEmpty(tree);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('button');
    });

    it('keeps containers with multiple children', () => {
      const tree = [node('group', '', [node('button', 'OK'), node('button', 'Cancel')])];
      const result = TokenOptimizer.collapseEmpty(tree);
      expect(result).toHaveLength(1);
      expect(result[0].children).toHaveLength(2);
    });

    it('preserves containers with name', () => {
      const tree = [node('group', 'Navigation')];
      const result = TokenOptimizer.collapseEmpty(tree);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Navigation');
    });

    it('preserves interactive nodes even without name', () => {
      const tree = [node('button', '')];
      const result = TokenOptimizer.collapseEmpty(tree);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('button');
    });

    it('preserves nodes with properties', () => {
      const tree = [node('group', '', undefined, { properties: { expanded: true } })];
      const result = TokenOptimizer.collapseEmpty(tree);
      expect(result).toHaveLength(1);
    });
  });

  describe('optimize() pipeline', () => {
    it('reduces tree size with combined pipeline', () => {
      const tree: AXNode[] = [
        node('generic', '', [
          node('presentation', '', [
            node('button', 'Click Me'),
          ]),
          node('separator', ''),
          node('none', '', [
            node('link', 'Go Home'),
          ]),
          node('group', '', [
            node('heading', 'a'.repeat(200)),
          ]),
        ]),
      ];

      const result = TokenOptimizer.optimize(tree);

      // Button and link should survive
      const flatRoles = flattenRoles(result);
      expect(flatRoles).toContain('button');
      expect(flatRoles).toContain('link');

      // Decorative roles should be gone
      expect(flatRoles).not.toContain('generic');
      expect(flatRoles).not.toContain('presentation');
      expect(flatRoles).not.toContain('separator');
      expect(flatRoles).not.toContain('none');
    });

    it('preserves all interactive elements', () => {
      const tree: AXNode[] = [
        node('generic', '', [
          node('button', 'Submit'),
          node('textbox', 'Name'),
          node('link', 'Help'),
          node('combobox', 'Country'),
          node('checkbox', 'Agree'),
        ]),
      ];

      const result = TokenOptimizer.optimize(tree);
      const flatRoles = flattenRoles(result);

      expect(flatRoles).toContain('button');
      expect(flatRoles).toContain('textbox');
      expect(flatRoles).toContain('link');
      expect(flatRoles).toContain('combobox');
      expect(flatRoles).toContain('checkbox');
    });

    it('truncates text to maxTextLen', () => {
      const tree: AXNode[] = [node('heading', 'x'.repeat(500))];
      const result = TokenOptimizer.optimize(tree, { maxTextLen: 40 });
      expect(result[0].name!.length).toBeLessThanOrEqual(41); // 40 + '…'
    });

    it('respects custom maxDepth', () => {
      const tree = [
        node('root', 'r', [
          node('l1', '1', [
            node('l2', '2', [
              node('l3', '3'),
            ]),
          ]),
        ]),
      ];

      const result = TokenOptimizer.optimize(tree, { maxDepth: 2 });
      expect(result[0].children![0].children).toEqual([]);
    });
  });

  describe('interactiveOnly()', () => {
    it('should keep buttons, links, inputs', () => {
      const tree: AXNode[] = [
        node('button', 'Submit'),
        node('link', 'Help'),
        node('textbox', 'Name'),
        node('checkbox', 'Agree'),
        node('combobox', 'Country'),
      ];
      const result = TokenOptimizer.interactiveOnly(tree);
      expect(result).toHaveLength(5);
      expect(flattenRoles(result)).toEqual(['button', 'link', 'textbox', 'checkbox', 'combobox']);
    });

    it('should remove generic, paragraph, group nodes', () => {
      const tree: AXNode[] = [
        node('generic', 'wrapper'),
        node('paragraph', 'Some text'),
        node('group', 'Section', [
          node('button', 'OK'),
        ]),
      ];
      const result = TokenOptimizer.interactiveOnly(tree);
      const roles = flattenRoles(result);
      expect(roles).toContain('button');
      expect(roles).not.toContain('generic');
      expect(roles).not.toContain('paragraph');
    });

    it('should keep headings for context', () => {
      const tree: AXNode[] = [
        node('heading', 'Login Form'),
        node('textbox', 'Username'),
      ];
      const result = TokenOptimizer.interactiveOnly(tree);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('heading');
    });

    it('should keep named images', () => {
      const tree: AXNode[] = [
        node('img', 'Logo'),
        node('img', ''),
      ];
      const result = TokenOptimizer.interactiveOnly(tree);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Logo');
    });
  });

  describe('search()', () => {
    it('should find nodes by name', () => {
      const tree: AXNode[] = [
        node('button', 'Login'),
        node('button', 'Sign Up'),
        node('link', 'Forgot Password'),
      ];
      const result = TokenOptimizer.search(tree, 'Login');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Login');
    });

    it('should find nodes by value', () => {
      const tree: AXNode[] = [
        node('textbox', 'Email', undefined, { value: 'john@example.com' }),
        node('textbox', 'Phone', undefined, { value: '555-1234' }),
      ];
      const result = TokenOptimizer.search(tree, 'john@');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Email');
    });

    it('should find nodes by description', () => {
      const tree: AXNode[] = [
        node('button', 'Submit', undefined, { description: 'Submit the application form' }),
        node('button', 'Cancel'),
      ];
      const result = TokenOptimizer.search(tree, 'application');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Submit');
    });

    it('should return empty for no match', () => {
      const tree: AXNode[] = [
        node('button', 'Login'),
        node('link', 'Help'),
      ];
      const result = TokenOptimizer.search(tree, 'NonExistent');
      expect(result).toHaveLength(0);
    });

    it('should be case-insensitive', () => {
      const tree: AXNode[] = [
        node('button', 'LOGIN BUTTON'),
      ];
      const result = TokenOptimizer.search(tree, 'login');
      expect(result).toHaveLength(1);
    });

    it('should find nested matching nodes', () => {
      const tree: AXNode[] = [
        node('group', 'Nav', [
          node('link', 'Dashboard'),
          node('link', 'Settings'),
        ]),
      ];
      const result = TokenOptimizer.search(tree, 'Dashboard');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Dashboard');
    });
  });

  describe('capLength()', () => {
    it('should not truncate short snapshots', () => {
      const short = 'button "OK" [ref=1]\nlink "Help" [ref=2]';
      expect(TokenOptimizer.capLength(short, 1000)).toBe(short);
    });

    it('should truncate at line boundary', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `button "Item ${i}" [ref=${i}]`);
      const serialized = lines.join('\n');
      const result = TokenOptimizer.capLength(serialized, 500);
      expect(result.length).toBeLessThanOrEqual(serialized.length);
      // Should not break mid-line
      const lastNewline = result.lastIndexOf('\n\n... (truncated');
      expect(lastNewline).toBeGreaterThan(0);
    });

    it('should include truncation message', () => {
      const long = 'x'.repeat(1000) + '\n' + 'y'.repeat(1000);
      const result = TokenOptimizer.capLength(long, 500);
      expect(result).toContain('truncated');
      expect(result).toContain('chars');
      expect(result).toContain('search parameter');
    });

    it('should return original when length equals maxChars', () => {
      const exact = 'a'.repeat(500);
      expect(TokenOptimizer.capLength(exact, 500)).toBe(exact);
    });
  });
});

/** Flatten all roles in a tree into a flat array for easy assertions. */
function flattenRoles(nodes: AXNode[]): string[] {
  const roles: string[] = [];
  for (const n of nodes) {
    roles.push(n.role);
    if (n.children) roles.push(...flattenRoles(n.children));
  }
  return roles;
}
