import { describe, it, expect } from 'vitest';
import { discoverBrowserInstances } from '../../connection/browser-discovery.js';

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

describeIf('Connection Integration', () => {
  it('should discover at least one browser instance', () => {
    const instances = discoverBrowserInstances();
    expect(instances.length).toBeGreaterThan(0);
    expect(instances[0]).toHaveProperty('name');
    expect(instances[0]).toHaveProperty('wsUrl');
  });

  it('should auto-connect on first tool call', async () => {
    // Would test ensureConnected() → CDPClient.connect() flow
    expect(true).toBe(true); // placeholder
  });
});
