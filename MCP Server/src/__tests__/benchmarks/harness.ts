/**
 * Benchmark harness for comparing CDP Browser MCP vs Playwright MCP.
 *
 * Provides types, timing utilities, and result formatting used by
 * individual benchmark test files.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
  task: string;
  server: 'cdp' | 'playwright';
  timeMs: number;
  toolCalls: number;
  success: boolean;
  error?: string;
  output?: string;
}

export interface BenchmarkStep {
  /** MCP tool name to invoke */
  tool: string;
  /** Arguments passed to the tool */
  args: Record<string, unknown>;
  /** Whether this step is expected to succeed */
  expectedSuccess: boolean;
}

export interface BenchmarkTask {
  name: string;
  description: string;
  /** Ordered steps executed against the MCP server */
  steps: BenchmarkStep[];
}

// ---------------------------------------------------------------------------
// Timing utility
// ---------------------------------------------------------------------------

/**
 * Execute an async function and return both its result and wall-clock time.
 */
export async function timeAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; timeMs: number }> {
  const start = performance.now();
  const result = await fn();
  const timeMs = Math.round((performance.now() - start) * 100) / 100;
  return { result, timeMs };
}

// ---------------------------------------------------------------------------
// Simulated MCP executor
// ---------------------------------------------------------------------------

/**
 * Simulate running a {@link BenchmarkTask} against an MCP server.
 *
 * In a real integration test the executor would open a JSON-RPC connection to
 * the MCP server process.  For the benchmark harness we record the number of
 * tool calls and the elapsed time so that the surrounding test can assert on
 * them.
 *
 * @param task  – the task definition (steps to run)
 * @param server – which server is being benchmarked
 * @param executor – callback that actually invokes an MCP tool and returns
 *                   the raw response (or throws on failure)
 */
export async function runTask(
  task: BenchmarkTask,
  server: 'cdp' | 'playwright',
  executor: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<BenchmarkResult> {
  let toolCalls = 0;
  let lastOutput: unknown;

  const { timeMs } = await timeAsync(async () => {
    for (const step of task.steps) {
      toolCalls++;
      try {
        lastOutput = await executor(step.tool, step.args);
      } catch (err) {
        if (step.expectedSuccess) {
          return {
            task: task.name,
            server,
            timeMs: 0, // will be overwritten
            toolCalls,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies BenchmarkResult;
        }
      }
    }
    return undefined; // all steps succeeded
  });

  // If the inner loop returned an error result, unwrap it and patch the time.
  if (typeof lastOutput === 'object' && lastOutput !== null && 'success' in (lastOutput as BenchmarkResult)) {
    const partial = lastOutput as BenchmarkResult;
    if (!partial.success) {
      return { ...partial, timeMs };
    }
  }

  return {
    task: task.name,
    server,
    timeMs,
    toolCalls,
    success: true,
    output: typeof lastOutput === 'string' ? lastOutput : JSON.stringify(lastOutput),
  };
}

// ---------------------------------------------------------------------------
// Result comparison / formatting
// ---------------------------------------------------------------------------

/**
 * Build a human-readable markdown table comparing CDP and Playwright results.
 */
export function compareResults(
  cdpResults: BenchmarkResult[],
  pwResults: BenchmarkResult[],
): string {
  const lines: string[] = [
    '| Task | CDP Time (ms) | PW Time (ms) | CDP Calls | PW Calls | Winner |',
    '| ---- | ------------- | ------------ | --------- | -------- | ------ |',
  ];

  for (const cdp of cdpResults) {
    const pw = pwResults.find((r) => r.task === cdp.task);
    if (!pw) continue;

    const cdpTime = cdp.success ? String(cdp.timeMs) : 'FAIL';
    const pwTime = pw.success ? String(pw.timeMs) : 'FAIL';

    let winner = '—';
    if (cdp.success && pw.success) {
      if (cdp.timeMs < pw.timeMs) winner = '🏆 CDP';
      else if (pw.timeMs < cdp.timeMs) winner = '🏆 PW';
      else winner = 'TIE';
    } else if (cdp.success) {
      winner = '🏆 CDP';
    } else if (pw.success) {
      winner = '🏆 PW';
    }

    lines.push(
      `| ${cdp.task} | ${cdpTime} | ${pwTime} | ${cdp.toolCalls} | ${pw.toolCalls} | ${winner} |`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/** Return the median value from a sorted-ascending numeric array. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Aggregate multiple runs of the same benchmark into a single result. */
export function aggregateRuns(runs: BenchmarkResult[]): BenchmarkResult {
  if (runs.length === 0) {
    throw new Error('aggregateRuns requires at least one run');
  }

  const successes = runs.filter((r) => r.success);
  const times = successes.map((r) => r.timeMs);

  return {
    task: runs[0].task,
    server: runs[0].server,
    timeMs: median(times),
    toolCalls: runs[0].toolCalls, // constant across runs
    success: successes.length > runs.length / 2, // majority must pass
    output: successes[0]?.output,
  };
}
