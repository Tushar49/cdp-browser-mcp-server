/**
 * Connection module — public surface.
 */

export { CDPClient } from './cdp-client.js';
export type { ConnectionState, CDPClientOptions } from './cdp-client.js';

export {
  discoverBrowserInstances,
  resolveWsUrl,
  findBestInstance,
} from './browser-discovery.js';
export type { DiscoverOptions, WsUrlResult } from './browser-discovery.js';

export { HealthMonitor } from './health-monitor.js';
export type {
  HealthStatus,
  HealthState,
  HealthMonitorOptions,
} from './health-monitor.js';
