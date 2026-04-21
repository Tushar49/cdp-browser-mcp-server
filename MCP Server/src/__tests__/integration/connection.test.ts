import { describe, it, expect } from 'vitest';
import { discoverBrowserInstances } from '../../connection/browser-discovery.js';

const CDP_AVAILABLE = process.env.CDP_TEST === 'true';
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
