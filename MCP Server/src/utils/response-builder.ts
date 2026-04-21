/**
 * Smart response formatting that stays within LLM token budgets.
 *
 * LLMs have finite context windows. Large tool responses waste tokens
 * and can cause truncation or OOM at the LLM layer. ResponseBuilder
 * provides structured output with progressive truncation:
 *
 *  1. Full output (if within budget)
 *  2. Truncate long code blocks
 *  3. Truncate table rows
 *  4. Summarize sections
 *  5. Overflow to temp file with preview
 */

import type { ToolResult } from '../types.js';
import type { TempFileManager } from './temp-files.js';

// ─── Types ──────────────────────────────────────────────────────────

interface Section {
  title: string;
  content: string;
  priority: number; // higher = keep longer during truncation
}

// ─── ResponseBuilder ────────────────────────────────────────────────

export class ResponseBuilder {
  private sections: Section[] = [];
  private budget: number;

  /**
   * @param budget Maximum output characters (default 50 000 ≈ ~12k tokens)
   */
  constructor(budget: number = 50_000) {
    this.budget = budget;
  }

  /**
   * Add a titled section.
   * @param priority 0–10, higher = more important (default 5)
   */
  addSection(title: string, content: string, priority: number = 5): this {
    this.sections.push({ title, content, priority });
    return this;
  }

  /**
   * Add a markdown table from headers and rows.
   */
  addTable(
    headers: string[],
    rows: string[][],
    priority: number = 5,
  ): this {
    if (rows.length === 0) return this;

    const headerLine = `| ${headers.join(' | ')} |`;
    const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
    const dataLines = rows.map((row) => `| ${row.join(' | ')} |`);

    const content = [headerLine, separatorLine, ...dataLines].join('\n');
    this.sections.push({ title: '', content, priority });
    return this;
  }

  /**
   * Add a fenced code block.
   */
  addCode(code: string, language: string = '', priority: number = 5): this {
    const content = `\`\`\`${language}\n${code}\n\`\`\``;
    this.sections.push({ title: '', content, priority });
    return this;
  }

  /**
   * Build the response, progressively truncating if over budget.
   */
  build(): string {
    const full = this.renderFull();
    if (full.length <= this.budget) return full;

    // Stage 1: Truncate code blocks (keep first/last 10 lines)
    let truncated = this.renderWithTruncatedCode();
    if (truncated.length <= this.budget) return truncated;

    // Stage 2: Truncate tables (keep first 20 rows)
    truncated = this.renderWithTruncatedTables(truncated);
    if (truncated.length <= this.budget) return truncated;

    // Stage 3: Drop low-priority sections
    truncated = this.renderPrioritized();
    if (truncated.length <= this.budget) return truncated;

    // Stage 4: Hard truncate with ellipsis
    return truncated.substring(0, this.budget - 50) +
      '\n\n... (truncated — response exceeded token budget)';
  }

  /**
   * Build with overflow support — if the response exceeds the budget,
   * save the full output to a temp file and return a preview + path.
   */
  buildWithOverflow(tempManager: TempFileManager): ToolResult {
    const full = this.renderFull();

    if (full.length <= this.budget) {
      return { content: [{ type: 'text', text: full }] };
    }

    // Save full output to temp file
    const fileName = `response-${Date.now()}.md`;
    const filePath = tempManager.write(fileName, full);

    // Build a preview
    const preview = this.build();
    const text = `${preview}\n\n📄 Full output saved to: ${filePath}`;

    return { content: [{ type: 'text', text }] };
  }

  // ── Internal rendering ────────────────────────────────────────────

  private renderFull(): string {
    return this.sections
      .map((s) => {
        if (s.title) return `## ${s.title}\n\n${s.content}`;
        return s.content;
      })
      .join('\n\n');
  }

  private renderWithTruncatedCode(): string {
    return this.sections
      .map((s) => {
        const content = s.content.replace(
          /```(\w*)\n([\s\S]*?)```/g,
          (_match, lang: string, code: string) => {
            const lines = code.split('\n');
            if (lines.length <= 25) return _match;
            const head = lines.slice(0, 10).join('\n');
            const tail = lines.slice(-10).join('\n');
            const skipped = lines.length - 20;
            return `\`\`\`${lang}\n${head}\n\n... (${skipped} lines omitted)\n\n${tail}\n\`\`\``;
          },
        );
        if (s.title) return `## ${s.title}\n\n${content}`;
        return content;
      })
      .join('\n\n');
  }

  private renderWithTruncatedTables(input: string): string {
    return input.replace(
      /(\|[^\n]+\|\n\|[\s\-:|]+\|\n)((?:\|[^\n]+\|\n)*)/g,
      (match, header: string, body: string) => {
        const rows = body.trimEnd().split('\n');
        if (rows.length <= 20) return match;
        const kept = rows.slice(0, 20).join('\n');
        return `${header}${kept}\n| ... (${rows.length - 20} more rows) |\n`;
      },
    );
  }

  private renderPrioritized(): string {
    // Sort by priority descending, keep high-priority sections
    const sorted = [...this.sections].sort((a, b) => b.priority - a.priority);
    const parts: string[] = [];
    let total = 0;

    for (const s of sorted) {
      const rendered = s.title ? `## ${s.title}\n\n${s.content}` : s.content;
      if (total + rendered.length > this.budget) {
        // Truncate this section
        const remaining = this.budget - total - 50;
        if (remaining > 100) {
          parts.push(rendered.substring(0, remaining) + '\n... (truncated)');
        }
        break;
      }
      parts.push(rendered);
      total += rendered.length;
    }

    return parts.join('\n\n');
  }
}
