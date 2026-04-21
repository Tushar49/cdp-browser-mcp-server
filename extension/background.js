// CDP Browser MCP Bridge — Chrome Extension Service Worker
// This extension provides zero-config CDP access without --remote-debugging-port

const DEFAULT_PORT = 9333;
let wsServer = null;
let connections = new Map(); // tabId → chrome.debugger session

console.log('[CDP MCP Bridge] Service worker started');

// TODO: Phase B — implement WebSocket server for MCP connection
// TODO: Phase C — implement CDP command forwarding via chrome.debugger
// TODO: Phase D — auto-detection from MCP server side

// For now, just a skeleton that logs tab activity
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    console.log(`[CDP MCP Bridge] Tab ${tabId} loaded: ${tab.url}`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  connections.delete(tabId);
  console.log(`[CDP MCP Bridge] Tab ${tabId} closed`);
});
