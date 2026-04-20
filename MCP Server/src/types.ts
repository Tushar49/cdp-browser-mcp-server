/**
 * Core type definitions for the CDP Browser MCP Server.
 *
 * These types model every major data shape used across the server:
 * configuration, CDP protocol messages, session/tab management,
 * accessibility tree nodes, and tool registration.
 */

// ─── Cleanup Strategy ───────────────────────────────────────────────

/** How tabs are handled when an agent session expires. */
export type CleanupStrategy = 'close' | 'detach' | 'none';

// ─── Server Configuration ───────────────────────────────────────────

export interface ServerConfig {
  cdpHost: string;
  cdpPort: number;

  /** Element action timeout (click, type, etc.) */
  actionTimeout: number;
  /** Page navigation timeout */
  navigationTimeout: number;
  /** Accessibility snapshot timeout */
  snapshotTimeout: number;
  /** Catch-all / legacy timeout */
  globalTimeout: number;

  /** Agent session time-to-live */
  sessionTTL: number;
  /** Debugger auto-resume timeout */
  debuggerTimeout: number;

  /** Default cleanup strategy for new sessions */
  defaultCleanupStrategy: CleanupStrategy;

  /** Max characters before content is written to a temp file */
  maxInlineLen: number;
  /** Directory for temp files (screenshots, PDFs, etc.) — resolved at runtime */
  tempDir: string;
  /** Maximum number of temp files before auto-cleanup kicks in */
  maxTempFiles: number;
  /** Maximum age (ms) before a temp file is eligible for cleanup */
  maxTempAgeMs: number;

  /** If set, auto-connect to this Chrome instance/profile on startup */
  autoConnectProfile: string;
}

// ─── MCP Tool Result ────────────────────────────────────────────────

export interface ToolResultContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Standard MCP tool response envelope. */
export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

// ─── CDP Protocol Messages ──────────────────────────────────────────

/** Outbound CDP command. */
export interface CDPMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** CDP response to a command. */
export interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** CDP event pushed by the browser. */
export interface CDPEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

// ─── Session & Tab Management ───────────────────────────────────────

/** Agent session metadata. */
export interface SessionInfo {
  id: string;
  createdAt: number;
  lastActivity: number;
  cleanupStrategy: CleanupStrategy;
  tabIds: Set<string>;
}

/** Lightweight tab descriptor. */
export interface TabInfo {
  targetId: string;
  url: string;
  title: string;
  type: string;
  sessionId?: string;
  exclusive: boolean;
}

// ─── Browser Discovery ──────────────────────────────────────────────

/** Chrome profile metadata parsed from Local State. */
export interface ProfileInfo {
  name: string;
  email?: string;
  directory: string;
}

/** A running Chromium-based browser instance. */
export interface BrowserInstance {
  name: string;
  port: number;
  wsUrl: string;
  userDataDir: string;
  profiles: ProfileInfo[];
}

// ─── Accessibility Tree ─────────────────────────────────────────────

/** A single node in the Chrome accessibility (AX) tree. */
export interface AXNode {
  role: string;
  name: string;
  uid?: number;
  backendNodeId: number;
  children?: AXNode[];
  properties?: Record<string, unknown>;
}

// ─── Tool Registration ──────────────────────────────────────────────

/** Signature for a tool action handler. */
export type ToolHandler = (
  ctx: ServerContext,
  params: Record<string, unknown>,
) => Promise<ToolResult>;

/** Describes one tool that can be registered with the MCP server. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

// ─── Dependency-Injection Context ───────────────────────────────────

/**
 * ServerContext is the DI container threaded through every tool handler.
 * It provides access to configuration, the active CDP connection, session
 * state, and shared helpers — without any tool needing global imports.
 */
export interface ServerContext {
  config: ServerConfig;

  /** Send a CDP command and await its response. */
  sendCommand: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<CDPResponse>;

  /** Map of agent session IDs → session metadata. */
  sessions: Map<string, SessionInfo>;

  /** Map of tab target IDs → locking info. */
  tabLocks: Map<string, { sessionId: string; origin: 'created' | 'claimed' }>;

  /** Per-process fallback session ID. */
  processSessionId: string;
}
