/**
 * Temp-file management extracted from server.js.
 *
 * Screenshots, PDFs, large text output, and HAR dumps are written to
 * a session-scoped temp directory.  The manager auto-cleans old files
 * when the count exceeds a configurable threshold.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

// ─── TempFileManager ────────────────────────────────────────────────

export class TempFileManager {
  private readonly tempDir: string;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;

  constructor(config: {
    tempDir: string;
    maxTempFiles: number;
    maxTempAgeMs: number;
  }) {
    this.tempDir = config.tempDir;
    this.maxFiles = config.maxTempFiles;
    this.maxAgeMs = config.maxTempAgeMs;
  }

  // ── public ──────────────────────────────────────────────────────

  /** Ensure the temp directory exists (creates recursively). */
  ensureDir(): void {
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Write a file into the temp directory, auto-cleaning old files first.
   *
   * @param name          Base file name (e.g. `"page-1719000000.png"`)
   * @param content       File content (string or Buffer)
   * @param encoding      Node encoding — defaults to `"utf8"`
   * @param sessionPrefix If supplied, the first 8 chars are prepended to the name
   * @returns             Absolute path of the written file
   */
  write(
    name: string,
    content: string | Buffer,
    encoding: BufferEncoding = 'utf8',
    sessionPrefix?: string,
  ): string {
    this.ensureDir();
    this.autoCleanup();

    const fileName = sessionPrefix
      ? `${sessionPrefix.substring(0, 8)}_${name}`
      : name;
    const filePath = join(this.tempDir, fileName);
    writeFileSync(filePath, content, encoding);
    return filePath;
  }

  /**
   * Remove temp files.
   *
   * @param sessionPrefix  If given, only files whose name starts with
   *                       the prefix are deleted.  Otherwise **all** files
   *                       in the temp directory are removed.
   * @returns Number of files deleted.
   */
  cleanup(sessionPrefix?: string): number {
    if (!existsSync(this.tempDir)) return 0;

    const files = readdirSync(this.tempDir);
    let count = 0;

    for (const f of files) {
      if (sessionPrefix && !f.startsWith(sessionPrefix.substring(0, 8)))
        continue;
      try {
        unlinkSync(join(this.tempDir, f));
        count++;
      } catch {
        /* best-effort */
      }
    }
    return count;
  }

  // ── private ─────────────────────────────────────────────────────

  /**
   * When the file count exceeds `maxFiles`, remove the oldest files
   * until we're at half the limit **or** they are older than `maxAgeMs`.
   */
  private autoCleanup(): void {
    if (!existsSync(this.tempDir)) return;

    const files = readdirSync(this.tempDir);
    if (files.length <= this.maxFiles) return;

    // Sort by modification time (oldest first)
    const withStats = files
      .map((f) => {
        const p = join(this.tempDir, f);
        try {
          return { path: p, mtime: statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{ path: string; mtime: number }>;

    withStats.sort((a, b) => a.mtime - b.mtime);

    const now = Date.now();
    let remaining = files.length;

    for (const { path, mtime } of withStats) {
      if (remaining <= this.maxFiles / 2 && now - mtime < this.maxAgeMs) break;
      try {
        unlinkSync(path);
        remaining--;
      } catch {
        /* best-effort */
      }
    }
  }
}
