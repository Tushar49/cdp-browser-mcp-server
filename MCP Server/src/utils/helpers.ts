/**
 * Small general-purpose helpers extracted from server.js.
 *
 * These are pure functions (or near-pure) with no dependency on
 * global server state, making them easy to test and reuse.
 */

import type { ToolResult } from '../types.js';
import { TempFileManager } from './temp-files.js';

// ─── Point type for mouse-path generation ───────────────────────────

export interface Point {
  x: number;
  y: number;
}

// ─── ok / fail ──────────────────────────────────────────────────────

/**
 * Build a success {@link ToolResult}.
 *
 * If the output exceeds `maxInlineLen`, the full text is written to a
 * temp file and only the first 2 000 chars are inlined.
 */
export function ok(
  value: unknown,
  opts?: { maxInlineLen?: number; tempFiles?: TempFileManager },
): ToolResult {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const maxLen = opts?.maxInlineLen ?? 60_000;

  if (text.length > maxLen && opts?.tempFiles) {
    const file = opts.tempFiles.write(`output-${Date.now()}.txt`, text);
    return {
      content: [
        {
          type: 'text',
          text: `Output too large (${text.length} chars). Saved to: ${file}\n\nFirst 2000 chars:\n${text.substring(0, 2000)}`,
        },
      ],
    };
  }

  return { content: [{ type: 'text', text }] };
}

/** Build an error {@link ToolResult}. */
export function fail(msg: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

// ─── randomDelay ────────────────────────────────────────────────────

/**
 * Return a random delay in the range `[baseMs, baseMs × 3]`.
 * Used for human-like typing cadence (`charDelay`, `wordDelay`).
 */
export function randomDelay(baseMs: number): number {
  return baseMs + Math.random() * (baseMs * 2);
}

// ─── generateBezierPath ─────────────────────────────────────────────

/**
 * Generate a natural-looking mouse path using a randomised cubic Bézier
 * curve with slight overshoot, speed variation, and jitter for
 * anti-detection (human-mode clicks / hovers / drags).
 *
 * @param from   Start point
 * @param to     End point
 * @param steps  Number of intermediate points (default 20)
 * @param jitter Max random pixel offset per point (default 2)
 * @returns      Array of `{x, y}` points along the path
 */
export function generateBezierPath(
  from: Point,
  to: Point,
  steps = 20,
  jitter = 2,
): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Control-point spread scales with distance
  const spread = Math.min(dist * 0.3, 100);
  const cp1: Point = {
    x: from.x + dx * 0.2 + (Math.random() - 0.5) * spread,
    y: from.y + dy * 0.2 + (Math.random() - 0.5) * spread,
  };
  const cp2: Point = {
    x: from.x + dx * 0.8 + (Math.random() - 0.5) * spread,
    y: from.y + dy * 0.8 + (Math.random() - 0.5) * spread,
  };

  // Slight overshoot past target
  const overshoot = 3 + Math.random() * 5;
  const angle = Math.atan2(dy, dx);
  const overshootTarget: Point = {
    x: to.x + Math.cos(angle) * overshoot,
    y: to.y + Math.sin(angle) * overshoot,
  };

  const points: Point[] = [];

  // Phase 1: Move to overshoot point (80 % of steps)
  const mainSteps = Math.round(steps * 0.8);
  for (let i = 0; i <= mainSteps; i++) {
    const t = i / mainSteps;
    const mt = 1 - t;
    const x =
      mt * mt * mt * from.x +
      3 * mt * mt * t * cp1.x +
      3 * mt * t * t * cp2.x +
      t * t * t * overshootTarget.x;
    const y =
      mt * mt * mt * from.y +
      3 * mt * mt * t * cp1.y +
      3 * mt * t * t * cp2.y +
      t * t * t * overshootTarget.y;
    const jitterScale = Math.sin(t * Math.PI);
    points.push({
      x: x + (Math.random() - 0.5) * jitter * jitterScale,
      y: y + (Math.random() - 0.5) * jitter * jitterScale,
    });
  }

  // Phase 2: Correction from overshoot back to actual target
  const corrSteps = steps - mainSteps;
  for (let i = 1; i <= corrSteps; i++) {
    const t = i / corrSteps;
    points.push({
      x:
        overshootTarget.x +
        (to.x - overshootTarget.x) * t +
        (Math.random() - 0.5) * jitter * 0.3,
      y:
        overshootTarget.y +
        (to.y - overshootTarget.y) * t +
        (Math.random() - 0.5) * jitter * 0.3,
    });
  }

  return points;
}
