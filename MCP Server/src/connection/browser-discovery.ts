/**
 * Browser auto-discovery — finds running Chromium-based browsers
 * by scanning known User Data directories for DevToolsActivePort files.
 *
 * Extracted from `discoverChromeInstances` and `getWsUrl` in server.js.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { platform, homedir } from 'os';
import type { BrowserInstance, ProfileInfo } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface DiscoverOptions {
  /** Skip Local State parsing for faster lookups (default false). */
  skipProfiles?: boolean;
  /** Additional User Data directory paths to check first. */
  extraPaths?: string[];
}

export interface WsUrlResult {
  wsUrl: string;
  userDataDir: string | null;
}

// Re-export for convenience
export type { BrowserInstance, ProfileInfo };

// ─── Candidate List ─────────────────────────────────────────────────

interface Candidate {
  name: string;
  path: string;
}

function getBrowserCandidates(): Candidate[] {
  const os = platform();
  const home = homedir();

  if (os === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      { name: 'Chrome', path: join(local, 'Google', 'Chrome', 'User Data') },
      { name: 'Chrome Beta', path: join(local, 'Google', 'Chrome Beta', 'User Data') },
      { name: 'Chrome Canary', path: join(local, 'Google', 'Chrome SxS', 'User Data') },
      { name: 'Chromium', path: join(local, 'Chromium', 'User Data') },
      { name: 'Edge', path: join(local, 'Microsoft', 'Edge', 'User Data') },
      { name: 'Brave', path: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    ];
  } else if (os === 'darwin') {
    const appSupport = join(home, 'Library', 'Application Support');
    return [
      { name: 'Chrome', path: join(appSupport, 'Google', 'Chrome') },
      { name: 'Chrome Canary', path: join(appSupport, 'Google', 'Chrome Canary') },
      { name: 'Chromium', path: join(appSupport, 'Chromium') },
      { name: 'Edge', path: join(appSupport, 'Microsoft Edge') },
      { name: 'Brave', path: join(appSupport, 'BraveSoftware', 'Brave-Browser') },
    ];
  } else {
    // Linux
    return [
      { name: 'Chrome', path: join(home, '.config', 'google-chrome') },
      { name: 'Chromium', path: join(home, '.config', 'chromium') },
      { name: 'Edge', path: join(home, '.config', 'microsoft-edge') },
      { name: 'Brave', path: join(home, '.config', 'BraveSoftware', 'Brave-Browser') },
    ];
  }
}

function getCandidates(extraPaths: string[] = []): Candidate[] {
  const candidates: Candidate[] = [];

  // Extra paths (e.g. from CDP_USER_DATA or override) take priority
  for (const p of extraPaths) {
    if (p) candidates.push({ name: 'Custom', path: p });
  }

  // Platform-specific browser paths
  candidates.push(...getBrowserCandidates());

  return candidates;
}

// ─── Port File Parsing ──────────────────────────────────────────────

interface PortFileInfo {
  port: number;
  wsPath: string;
}

function readPortFile(userDataDir: string): PortFileInfo | null {
  try {
    const raw = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').trim();
    const lines = raw.split('\n');
    return {
      port: parseInt(lines[0], 10),
      wsPath: lines[1] || '/devtools/browser/',
    };
  } catch {
    return null;
  }
}

// ─── Profile Parsing ────────────────────────────────────────────────

function readProfiles(userDataDir: string): ProfileInfo[] {
  try {
    const raw = readFileSync(join(userDataDir, 'Local State'), 'utf8');
    const localState = JSON.parse(raw) as {
      profile?: {
        info_cache?: Record<
          string,
          { name?: string; gaia_name?: string; user_name?: string }
        >;
      };
    };
    const cache = localState?.profile?.info_cache || {};
    return Object.entries(cache).map(([dir, info]) => ({
      directory: dir,
      name: info.name || dir,
      email: info.user_name || undefined,
    }));
  } catch {
    return [];
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Scan the filesystem for running Chromium instances.
 * Returns all instances that have a valid DevToolsActivePort file.
 */
export function discoverBrowserInstances(
  opts: DiscoverOptions = {},
): BrowserInstance[] {
  const { skipProfiles = false, extraPaths = [] } = opts;
  const candidates = getCandidates(extraPaths);
  const instances: BrowserInstance[] = [];

  for (const { name, path: udPath } of candidates) {
    const portInfo = readPortFile(udPath);
    if (!portInfo) continue;

    const profiles = skipProfiles ? [] : readProfiles(udPath);

    instances.push({
      name,
      port: portInfo.port,
      wsUrl: `ws://127.0.0.1:${portInfo.port}${portInfo.wsPath}`,
      userDataDir: udPath,
      profiles,
    });
  }

  return instances;
}

/**
 * Resolve the WebSocket URL by scanning known User Data directories
 * for a DevToolsActivePort file. Falls back to querying /json/version
 * on the fallback host:port (P0-3).
 *
 * @param overrideDir   User Data dir override (e.g. from `browser.connect`)
 * @param fallbackHost  Default host (from config)
 * @param fallbackPort  Default port (from config)
 */
export function resolveWsUrl(
  overrideDir: string | null,
  fallbackHost: string,
  fallbackPort: number,
): WsUrlResult {
  const extra: string[] = [];
  if (overrideDir) extra.push(overrideDir);
  if (process.env.CDP_USER_DATA) extra.push(process.env.CDP_USER_DATA);

  const candidates = getCandidates(extra);

  for (const { path: udPath } of candidates) {
    const portInfo = readPortFile(udPath);
    if (portInfo) {
      return {
        wsUrl: `ws://127.0.0.1:${portInfo.port}${portInfo.wsPath}`,
        userDataDir: udPath,
      };
    }
  }

  // P0-3: Last resort — construct URL (caller should try /json/version at runtime)
  return {
    wsUrl: `ws://${fallbackHost}:${fallbackPort}/devtools/browser/`,
    userDataDir: null,
  };
}

/**
 * Async variant that queries /json/version when file-based discovery fails.
 * P0-3 fix: Uses the HTTP endpoint to get the correct WebSocket URL
 * instead of guessing.
 */
export async function resolveWsUrlAsync(
  overrideDir: string | null,
  fallbackHost: string,
  fallbackPort: number,
): Promise<WsUrlResult> {
  // Try synchronous file-based discovery first
  const syncResult = resolveWsUrl(overrideDir, fallbackHost, fallbackPort);
  if (syncResult.userDataDir) return syncResult;

  // File-based discovery failed — try HTTP /json/version endpoint
  try {
    const resp = await fetch(`http://${fallbackHost}:${fallbackPort}/json/version`);
    const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
    if (data.webSocketDebuggerUrl) {
      return {
        wsUrl: data.webSocketDebuggerUrl,
        userDataDir: null,
      };
    }
  } catch {
    // /json/version unavailable — fall through
  }

  // Last resort — constructed URL (may not work)
  return syncResult;
}

/**
 * Find the best matching instance given user input (name, port, or path).
 * Returns null if no match is found.
 */
export function findBestInstance(
  instances: BrowserInstance[],
  input: string,
): BrowserInstance | null {
  const needle = input.trim().toLowerCase();

  return (
    instances.find(
      (i) =>
        i.name.toLowerCase() === needle ||
        i.port.toString() === needle ||
        i.userDataDir.toLowerCase() === needle,
    ) ?? null
  );
}
