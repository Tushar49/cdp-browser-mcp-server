/**
 * Benchmark tests — CDP Browser MCP vs Playwright MCP.
 *
 * These tests use a **mock executor** so they can run without live MCP servers.
 * They validate that the harness, task definitions, and comparison logic work
 * correctly.  Replace the mock executor with a real MCP client to get actual
 * performance numbers.
 */

import { describe, it, expect } from 'vitest';
import {
  timeAsync,
  runTask,
  compareResults,
  median,
  aggregateRuns,
  type BenchmarkResult,
} from './harness.js';
import { getCdpTasks, getPlaywrightTask } from './tasks.js';

// ---------------------------------------------------------------------------
// Mock executor — resolves after a small random delay
// ---------------------------------------------------------------------------

function mockExecutor(baseLatencyMs = 5) {
  return async (_tool: string, _args: Record<string, unknown>): Promise<unknown> => {
    const jitter = Math.random() * baseLatencyMs;
    await new Promise((r) => setTimeout(r, jitter));
    return { ok: true };
  };
}

// ---------------------------------------------------------------------------
// Unit: harness utilities
// ---------------------------------------------------------------------------

describe('harness utilities', () => {
  it('timeAsync measures elapsed time', async () => {
    const { result, timeMs } = await timeAsync(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 42;
    });

    expect(result).toBe(42);
    expect(timeMs).toBeGreaterThanOrEqual(40);
    expect(timeMs).toBeLessThan(200);
  });

  it('median returns correct value for odd-length arrays', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('median returns correct value for even-length arrays', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('median returns 0 for empty array', () => {
    expect(median([])).toBe(0);
  });

  it('aggregateRuns computes median time', () => {
    const runs: BenchmarkResult[] = [
      { task: 't', server: 'cdp', timeMs: 100, toolCalls: 2, success: true },
      { task: 't', server: 'cdp', timeMs: 200, toolCalls: 2, success: true },
      { task: 't', server: 'cdp', timeMs: 150, toolCalls: 2, success: true },
    ];
    const agg = aggregateRuns(runs);
    expect(agg.timeMs).toBe(150);
    expect(agg.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: compareResults formatting
// ---------------------------------------------------------------------------

describe('compareResults', () => {
  it('produces a markdown table', () => {
    const cdp: BenchmarkResult[] = [
      { task: 'nav', server: 'cdp', timeMs: 100, toolCalls: 2, success: true },
    ];
    const pw: BenchmarkResult[] = [
      { task: 'nav', server: 'playwright', timeMs: 150, toolCalls: 3, success: true },
    ];

    const table = compareResults(cdp, pw);
    expect(table).toContain('CDP');
    expect(table).toContain('nav');
    expect(table).toContain('🏆 CDP');
  });

  it('marks failures correctly', () => {
    const cdp: BenchmarkResult[] = [
      { task: 'x', server: 'cdp', timeMs: 0, toolCalls: 1, success: false, error: 'boom' },
    ];
    const pw: BenchmarkResult[] = [
      { task: 'x', server: 'playwright', timeMs: 50, toolCalls: 1, success: true },
    ];

    const table = compareResults(cdp, pw);
    expect(table).toContain('FAIL');
    expect(table).toContain('🏆 PW');
  });
});

// ---------------------------------------------------------------------------
// Integration: run every CDP task through the mock executor
// ---------------------------------------------------------------------------

describe('CDP tasks (mock executor)', () => {
  const tasks = getCdpTasks();

  for (const task of tasks) {
    it(`runs "${task.name}" successfully`, async () => {
      const result = await runTask(task, 'cdp', mockExecutor());
      expect(result.success).toBe(true);
      expect(result.toolCalls).toBe(task.steps.length);
      expect(result.timeMs).toBeGreaterThanOrEqual(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Integration: run every Playwright task through the mock executor
// ---------------------------------------------------------------------------

describe('Playwright tasks (mock executor)', () => {
  const cdpTasks = getCdpTasks();

  for (const cdpTask of cdpTasks) {
    const pwTask = getPlaywrightTask(cdpTask.name);

    it(`has a Playwright equivalent for "${cdpTask.name}"`, () => {
      expect(pwTask).toBeDefined();
    });

    if (pwTask) {
      it(`runs PW "${pwTask.name}" successfully`, async () => {
        const result = await runTask(pwTask, 'playwright', mockExecutor());
        expect(result.success).toBe(true);
        expect(result.toolCalls).toBe(pwTask.steps.length);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Integration: side-by-side comparison
// ---------------------------------------------------------------------------

describe('side-by-side comparison (mock)', () => {
  it('produces a comparison table for all tasks', async () => {
    const cdpResults: BenchmarkResult[] = [];
    const pwResults: BenchmarkResult[] = [];

    for (const task of getCdpTasks()) {
      cdpResults.push(await runTask(task, 'cdp', mockExecutor(2)));

      const pwTask = getPlaywrightTask(task.name);
      if (pwTask) {
        pwResults.push(await runTask(pwTask, 'playwright', mockExecutor(2)));
      }
    }

    const table = compareResults(cdpResults, pwResults);
    expect(table).toContain('navigate-snapshot');
    expect(table).toContain('form-fill-simple');
    expect(table).toContain('click-navigate');
    expect(table).toContain('multi-tab');
    expect(table).toContain('complex-form');

    // Uncomment to print during development:
    // console.log('\n' + table + '\n');
  });
});
