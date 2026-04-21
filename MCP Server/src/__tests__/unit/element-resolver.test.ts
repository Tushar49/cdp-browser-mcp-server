import { describe, it, expect, beforeEach } from 'vitest';
import { ElementResolver } from '../../snapshot/element-resolver.js';
import type { AXNode } from '../../snapshot/accessibility.js';

function makeNode(backendNodeId: number, role = 'button', name = 'test'): AXNode {
  return { role, name, backendNodeId };
}

describe('ElementResolver', () => {
  let resolver: ElementResolver;

  beforeEach(() => {
    resolver = new ElementResolver();
  });

  describe('assignRefs()', () => {
    it('assigns sequential uids starting from 1', () => {
      const nodes: AXNode[] = [makeNode(100), makeNode(200), makeNode(300)];
      resolver.assignRefs(nodes);

      expect(nodes[0].uid).toBe(1);
      expect(nodes[1].uid).toBe(2);
      expect(nodes[2].uid).toBe(3);
    });

    it('assigns uids to nested children', () => {
      const nodes: AXNode[] = [{
        role: 'group', name: 'g', backendNodeId: 100,
        children: [makeNode(200), makeNode(300)],
      }];
      resolver.assignRefs(nodes);

      expect(nodes[0].uid).toBe(1);
      expect(nodes[0].children![0].uid).toBe(2);
      expect(nodes[0].children![1].uid).toBe(3);
    });

    it('same backendNodeId gets same uid across multiple assignRefs calls (stability)', () => {
      const nodes1: AXNode[] = [makeNode(100), makeNode(200)];
      resolver.assignRefs(nodes1);
      const uid1 = nodes1[0].uid;
      const uid2 = nodes1[1].uid;

      // Second snapshot — same backend IDs should reuse uids
      const nodes2: AXNode[] = [makeNode(100), makeNode(200)];
      resolver.assignRefs(nodes2);

      expect(nodes2[0].uid).toBe(uid1);
      expect(nodes2[1].uid).toBe(uid2);
    });

    it('new backendNodeIds get new uids', () => {
      const nodes1: AXNode[] = [makeNode(100)];
      resolver.assignRefs(nodes1);
      expect(nodes1[0].uid).toBe(1);

      const nodes2: AXNode[] = [makeNode(100), makeNode(999)];
      resolver.assignRefs(nodes2);

      expect(nodes2[0].uid).toBe(1); // reused
      expect(nodes2[1].uid).toBe(2); // new
    });

    it('nodes with backendNodeId=0 do not get refs', () => {
      const nodes: AXNode[] = [makeNode(0), makeNode(100)];
      resolver.assignRefs(nodes);

      expect(nodes[0].uid).toBeUndefined();
      expect(nodes[1].uid).toBe(1);
    });
  });

  describe('resolve()', () => {
    it('returns correct backendNodeId for a valid uid', () => {
      const nodes: AXNode[] = [makeNode(100), makeNode(200)];
      resolver.assignRefs(nodes);

      expect(resolver.resolve(1)).toBe(100);
      expect(resolver.resolve(2)).toBe(200);
    });

    it('returns undefined for nonexistent uid', () => {
      expect(resolver.resolve(999)).toBeUndefined();
    });
  });

  describe('onNavigation()', () => {
    it('clears all refs and resets counter', () => {
      const nodes: AXNode[] = [makeNode(100), makeNode(200)];
      resolver.assignRefs(nodes);
      expect(resolver.resolve(1)).toBe(100);

      resolver.onNavigation();

      expect(resolver.resolve(1)).toBeUndefined();
      expect(resolver.resolve(2)).toBeUndefined();
      expect(resolver.stats.totalRefs).toBe(0);
      expect(resolver.stats.nextUid).toBe(1);
    });

    it('assigns uids from 1 again after navigation', () => {
      const nodes1: AXNode[] = [makeNode(100)];
      resolver.assignRefs(nodes1);
      expect(nodes1[0].uid).toBe(1);

      resolver.onNavigation();

      const nodes2: AXNode[] = [makeNode(999)];
      resolver.assignRefs(nodes2);
      expect(nodes2[0].uid).toBe(1); // starts over
    });
  });

  describe('stats', () => {
    it('reflects correct totalRefs and nextUid', () => {
      expect(resolver.stats.totalRefs).toBe(0);
      expect(resolver.stats.nextUid).toBe(1);

      const nodes: AXNode[] = [makeNode(10), makeNode(20)];
      resolver.assignRefs(nodes);

      expect(resolver.stats.totalRefs).toBe(2);
      expect(resolver.stats.nextUid).toBe(3);
    });
  });
});
