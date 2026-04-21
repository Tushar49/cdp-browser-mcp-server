document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('status');
  // TODO: Query background.js for connection state
  status.textContent = '⏳ Extension loaded — MCP bridge coming soon';
});
