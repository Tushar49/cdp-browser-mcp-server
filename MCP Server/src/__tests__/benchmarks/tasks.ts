/**
 * Benchmark task definitions for CDP Browser MCP and Playwright MCP.
 *
 * Each task is defined twice — once using CDP tool names/args and once using
 * Playwright equivalents — so the harness can run the exact same logical
 * operation against both servers.
 */

import type { BenchmarkTask } from './harness.js';

// ---------------------------------------------------------------------------
// Fixture URL helper
// ---------------------------------------------------------------------------

/**
 * Resolve the local fixture URL.  During real benchmark runs a small static
 * file server serves the `src/__tests__/fixtures` directory; the base URL is
 * injected via the `BENCHMARK_BASE_URL` env var (defaults to a file:// path).
 */
export function fixtureUrl(file: string): string {
  const base = process.env['BENCHMARK_BASE_URL'];
  if (base) {
    return `${base.replace(/\/$/, '')}/${file}`;
  }
  // Fallback: file:// protocol (may have CORS restrictions in some browsers)
  return `file://${process.cwd().replace(/\\/g, '/')}/src/__tests__/fixtures/${file}`;
}

// ---------------------------------------------------------------------------
// CDP tasks
// ---------------------------------------------------------------------------

export const CDP_TASKS: BenchmarkTask[] = [
  // -- Task 1: Navigate + Snapshot ------------------------------------------
  {
    name: 'navigate-snapshot',
    description: 'Navigate to a page and take an accessibility snapshot',
    steps: [
      {
        tool: 'cdp-browser-tabs',
        args: { action: 'new', url: 'https://example.com' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-page',
        args: { action: 'snapshot', tabId: '__TAB__' },
        expectedSuccess: true,
      },
    ],
  },

  // -- Task 2: Form Filling (simple) ---------------------------------------
  {
    name: 'form-fill-simple',
    description: 'Fill a simple form with text, dropdown, and checkbox fields',
    steps: [
      {
        tool: 'cdp-browser-tabs',
        args: { action: 'new', url: fixtureUrl('benchmark-form.html') },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-page',
        args: { action: 'snapshot', tabId: '__TAB__' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: {
          action: 'fill',
          tabId: '__TAB__',
          fields: [
            { selector: '#name', value: 'John Doe', type: 'text' },
            { selector: '#email', value: 'john@example.com', type: 'text' },
            { selector: '#phone', value: '+1-555-0100', type: 'text' },
          ],
        },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: {
          action: 'select',
          tabId: '__TAB__',
          selector: '#country',
          value: 'US',
        },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: {
          action: 'check',
          tabId: '__TAB__',
          selector: '#terms',
          checked: true,
        },
        expectedSuccess: true,
      },
    ],
  },

  // -- Task 3: Click + Navigate ---------------------------------------------
  {
    name: 'click-navigate',
    description: 'Navigate to a page, click a link, and wait for navigation',
    steps: [
      {
        tool: 'cdp-browser-tabs',
        args: { action: 'new', url: 'https://example.com' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-page',
        args: { action: 'snapshot', tabId: '__TAB__' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: { action: 'click', tabId: '__TAB__', selector: 'a' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-page',
        args: { action: 'wait', tabId: '__TAB__', timeout: 5000 },
        expectedSuccess: true,
      },
    ],
  },

  // -- Task 4: Multi-Tab Workflow -------------------------------------------
  {
    name: 'multi-tab',
    description: 'Open 3 tabs, switch between them, and snapshot each',
    steps: [
      {
        tool: 'cdp-browser-tabs',
        args: { action: 'new', url: 'https://example.com' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-tabs',
        args: { action: 'new', url: 'https://www.iana.org/domains/reserved' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-tabs',
        args: { action: 'new', url: 'https://httpbin.org/html' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-page',
        args: { action: 'snapshot', tabId: '__TAB_0__' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-page',
        args: { action: 'snapshot', tabId: '__TAB_1__' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-page',
        args: { action: 'snapshot', tabId: '__TAB_2__' },
        expectedSuccess: true,
      },
    ],
  },

  // -- Task 5: Complex Form (combobox / datalist) ---------------------------
  {
    name: 'complex-form',
    description: 'Fill a form with combobox/datalist inputs',
    steps: [
      {
        tool: 'cdp-browser-tabs',
        args: { action: 'new', url: fixtureUrl('benchmark-form.html') },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-page',
        args: { action: 'snapshot', tabId: '__TAB__' },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: {
          action: 'fill',
          tabId: '__TAB__',
          fields: [
            { selector: '#name', value: 'Jane Smith', type: 'text' },
            { selector: '#email', value: 'jane@example.com', type: 'text' },
            { selector: '#phone', value: '+44-20-7946-0958', type: 'text' },
          ],
        },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: {
          action: 'select',
          tabId: '__TAB__',
          selector: '#country',
          value: 'UK',
        },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: {
          action: 'type',
          tabId: '__TAB__',
          selector: '#experience',
          text: '3-5 years',
        },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: {
          action: 'check',
          tabId: '__TAB__',
          selector: '#terms',
          checked: true,
        },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: {
          action: 'click',
          tabId: '__TAB__',
          selector: 'input[name="gender"][value="F"]',
        },
        expectedSuccess: true,
      },
      {
        tool: 'cdp-browser-interact',
        args: {
          action: 'type',
          tabId: '__TAB__',
          selector: '#cover-letter',
          text: 'I am excited to apply for this role.',
        },
        expectedSuccess: true,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Playwright equivalents
// ---------------------------------------------------------------------------

export const PLAYWRIGHT_TASKS: Record<string, BenchmarkTask> = {
  'navigate-snapshot': {
    name: 'navigate-snapshot',
    description: 'Navigate to a page and take an accessibility snapshot',
    steps: [
      {
        tool: 'browser_navigate',
        args: { url: 'https://example.com' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_snapshot',
        args: {},
        expectedSuccess: true,
      },
    ],
  },

  'form-fill-simple': {
    name: 'form-fill-simple',
    description: 'Fill a simple form with text, dropdown, and checkbox fields',
    steps: [
      {
        tool: 'browser_navigate',
        args: { url: fixtureUrl('benchmark-form.html') },
        expectedSuccess: true,
      },
      {
        tool: 'browser_snapshot',
        args: {},
        expectedSuccess: true,
      },
      {
        tool: 'browser_fill_form',
        args: {
          fields: [
            { ref: 'name-input', name: 'Full Name', type: 'textbox', value: 'John Doe' },
            { ref: 'email-input', name: 'Email', type: 'textbox', value: 'john@example.com' },
            { ref: 'phone-input', name: 'Phone', type: 'textbox', value: '+1-555-0100' },
          ],
        },
        expectedSuccess: true,
      },
      {
        tool: 'browser_select_option',
        args: { ref: 'country-select', values: ['US'] },
        expectedSuccess: true,
      },
      {
        tool: 'browser_click',
        args: { ref: 'terms-checkbox', element: 'Terms checkbox' },
        expectedSuccess: true,
      },
    ],
  },

  'click-navigate': {
    name: 'click-navigate',
    description: 'Navigate to a page, click a link, and wait for navigation',
    steps: [
      {
        tool: 'browser_navigate',
        args: { url: 'https://example.com' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_snapshot',
        args: {},
        expectedSuccess: true,
      },
      {
        tool: 'browser_click',
        args: { ref: 'more-info-link', element: 'More information link' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_wait_for',
        args: { time: 5 },
        expectedSuccess: true,
      },
    ],
  },

  'multi-tab': {
    name: 'multi-tab',
    description: 'Open 3 tabs, switch between them, and snapshot each',
    steps: [
      {
        tool: 'browser_tabs',
        args: { action: 'new' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_navigate',
        args: { url: 'https://example.com' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_snapshot',
        args: {},
        expectedSuccess: true,
      },
      {
        tool: 'browser_tabs',
        args: { action: 'new' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_navigate',
        args: { url: 'https://www.iana.org/domains/reserved' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_snapshot',
        args: {},
        expectedSuccess: true,
      },
      {
        tool: 'browser_tabs',
        args: { action: 'new' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_navigate',
        args: { url: 'https://httpbin.org/html' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_snapshot',
        args: {},
        expectedSuccess: true,
      },
    ],
  },

  'complex-form': {
    name: 'complex-form',
    description: 'Fill a form with combobox/datalist inputs',
    steps: [
      {
        tool: 'browser_navigate',
        args: { url: fixtureUrl('benchmark-form.html') },
        expectedSuccess: true,
      },
      {
        tool: 'browser_snapshot',
        args: {},
        expectedSuccess: true,
      },
      {
        tool: 'browser_fill_form',
        args: {
          fields: [
            { ref: 'name-input', name: 'Full Name', type: 'textbox', value: 'Jane Smith' },
            { ref: 'email-input', name: 'Email', type: 'textbox', value: 'jane@example.com' },
            { ref: 'phone-input', name: 'Phone', type: 'textbox', value: '+44-20-7946-0958' },
          ],
        },
        expectedSuccess: true,
      },
      {
        tool: 'browser_select_option',
        args: { ref: 'country-select', values: ['UK'] },
        expectedSuccess: true,
      },
      {
        tool: 'browser_type',
        args: { ref: 'experience-input', text: '3-5 years' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_click',
        args: { ref: 'terms-checkbox', element: 'Terms checkbox' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_click',
        args: { ref: 'female-radio', element: 'Female radio button' },
        expectedSuccess: true,
      },
      {
        tool: 'browser_type',
        args: { ref: 'cover-letter-textarea', text: 'I am excited to apply for this role.' },
        expectedSuccess: true,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return all CDP tasks as an iterable. */
export function getCdpTasks(): BenchmarkTask[] {
  return CDP_TASKS;
}

/** Look up the Playwright equivalent for a given CDP task name. */
export function getPlaywrightTask(name: string): BenchmarkTask | undefined {
  return PLAYWRIGHT_TASKS[name];
}
