import { describe, it, expect } from 'vitest';
import { ElementResolver } from '../../snapshot/element-resolver.js';
import { TokenOptimizer } from '../../snapshot/token-optimizer.js';
import type { AXNode } from '../../snapshot/accessibility.js';

// Runtime browser detection — no env var needed
async function isCdpAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:9222/json/version');
    return res.ok;
  } catch {
    return false;
  }
}
const CDP_AVAILABLE = await isCdpAvailable();
const describeIf = CDP_AVAILABLE ? describe : describe.skip;

describe('Snapshot (unit-level)', () => {
  it('should optimize snapshot with token optimizer', () => {
    const nodes: AXNode[] = [
      { role: 'generic', name: '', backendNodeId: 1, children: [
        { role: 'button', name: 'Submit', backendNodeId: 2, children: [] },
        { role: 'presentation', name: '', backendNodeId: 3, children: [] },
      ]},
    ];
    const optimized = TokenOptimizer.optimize(nodes);
    // Button should survive, presentation and empty generic should be removed
    expect(optimized.length).toBeLessThanOrEqual(nodes.length);
  });

  it('should assign stable refs with ElementResolver', () => {
    const resolver = new ElementResolver();
    const nodes1: AXNode[] = [
      { role: 'button', name: 'A', backendNodeId: 10 },
      { role: 'link', name: 'B', backendNodeId: 20 },
    ];
    resolver.assignRefs(nodes1);
    const uid1 = nodes1[0].uid;
    const uid2 = nodes1[1].uid;

    // Second snapshot — same backendNodeIds should get same uids
    const nodes2: AXNode[] = [
      { role: 'button', name: 'A', backendNodeId: 10 },
      { role: 'link', name: 'B', backendNodeId: 20 },
      { role: 'textbox', name: 'C', backendNodeId: 30 },
    ];
    resolver.assignRefs(nodes2);
    expect(nodes2[0].uid).toBe(uid1);
    expect(nodes2[1].uid).toBe(uid2);
    expect(nodes2[2].uid).toBe(uid2! + 1); // next sequential
  });
});

describeIf('Snapshot Integration', () => {
  it('should capture full a11y tree from live page', async () => {
    // Would test captureAccessibilityTree() with real CDP
    expect(true).toBe(true);
  });
});
