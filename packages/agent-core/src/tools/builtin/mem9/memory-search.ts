import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { Mem9MemoryProvider } from '../../providers/mem9-memory';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './memory-search.md';

const DEFAULT_LIMIT = 5;

export const Mem9MemorySearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'A short query close to how stored facts are worded. Prefer likely predicates and key terms. Good: "user lives in", "project uses React". Bad: full user utterances, "my home", "user home location".',
    ),
  queries: z
    .array(z.string().min(1))
    .min(1)
    .max(4)
    .optional()
    .describe(
      'Up to 4 additional facet-variant queries to run together with `query` in one batch. ' +
        'Use for questions asking about multiple items or aspects of one topic: submit the ' +
        'primary phrasing in `query` and variants covering other facets (different ' +
        'activities, objects, places, companions, time periods) here. All queries run in ' +
        'parallel; results are merged and deduplicated with per-query provenance.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(DEFAULT_LIMIT)
    .describe('The maximum number of memories to return. Default is 5.')
    .optional(),
  scan_all: z
    .boolean()
    .default(false)
    .describe('When using a Space Chain API key, continue searching every Space in the chain.')
    .optional(),
});

export type Mem9MemorySearchInput = z.Infer<typeof Mem9MemorySearchInputSchema>;

export class Mem9MemorySearchTool implements BuiltinTool<Mem9MemorySearchInput> {
  readonly name = 'Mem9MemorySearch' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(Mem9MemorySearchInputSchema);

  constructor(private readonly provider: Mem9MemoryProvider) {}

  resolveExecution(args: Mem9MemorySearchInput): ToolExecution {
    const query = args.query.trim();
    if (query.length === 0) return { isError: true, output: 'query is required' };
    const variantCount = effectiveQueries(query, args.queries).length - 1;
    const preview = query.length > 40 ? `${query.slice(0, 40)}…` : query;
    const suffix = variantCount > 0 ? ` (+${String(variantCount)} facet variants)` : '';
    return {
      accesses: ToolAccesses.none(),
      description: `Searching mem9 memory: ${preview}${suffix}`,
      display: { kind: 'search', query, scope: 'mem9 long-term memory' },
      approvalRule: literalRulePattern(this.name, query),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, query),
      execute: (ctx) => this.execution({ ...args, query }, ctx),
    };
  }

  private async execution(
    args: Mem9MemorySearchInput,
    { signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const limit = args.limit ?? DEFAULT_LIMIT;
      const queries = effectiveQueries(args.query, args.queries);
      if (queries.length > 1) {
        return await this.batchExecution(queries, limit, args.scan_all, signal);
      }
      const result = await this.provider.search({
        query: args.query,
        limit,
        scanAll: args.scan_all,
        signal,
      });
      const builder = new ToolResultBuilder({ maxChars: 12_000, maxLineLength: 2_000 });

      builder.write(`Effective query: ${result.effectiveQuery}\n`);
      builder.write('Session scoped: false\n');
      // "Showing top N of M candidates" instead of the old bare
      // "Available results: M": M counts the server-side candidate
      // pool (~3x the requested limit under multi-path RRF), while
      // only `limit` memories are rendered below. LoCoMo trace review
      // (#mem9-discussion:037b518a, 2026-06-11) showed the old wording
      // misled the agent into believing it had already seen all M
      // candidates, so it never retried with a higher `limit` even
      // when the shown results were low-confidence.
      builder.write(
        `Showing top ${String(result.memories.length)} of ${String(result.availableResultCount)} candidates\n\n`,
      );

      if (result.memories.length === 0) {
        builder.write('No memories found.\n');
      }

      result.memories.forEach((memory, index) => {
        if (index > 0) builder.write('---\n');
        builder.write(`Memory ${String(index + 1)}\n`);
        builder.write(`Content: ${memory.content}\n`);
        if (memory.confidence !== undefined) {
          builder.write(`Confidence: ${String(memory.confidence)}\n`);
        }
        if (memory.score !== undefined) {
          builder.write(`Score: ${String(memory.score)}\n`);
        }
        if (memory.memoryType !== undefined) {
          builder.write(`Type: ${memory.memoryType}\n`);
        }
        // memory.relativeAge (server relative_age, derived from the row's
        // updated_at) is deliberately NOT rendered. It is STORAGE age —
        // "how long since this row was written" relative to the moment of
        // the search — not the time of the remembered fact. Rendering it
        // as "Age: 13 hours ago" planted a now-anchored relative time on
        // every result and misled temporal reasoning: a fact about 2023
        // ingested yesterday read as recent. Fact time lives in the
        // memory content's normalized absolute dates. If write-recency is
        // ever needed for conflict resolution, surface it as an absolute
        // date, never a relative phrase (#mem9-discussion:037b518a,
        // 2026-06-12).
      });

      if (result.retryHint !== undefined) {
        if (builder.nChars > 0) builder.write('\n');
        builder.write(`Retry hint: ${result.retryHint}\n`);
      }

      return builder.ok();
    } catch (error) {
      return { isError: true, output: classifyMem9Error('Memory search', error) };
    }
  }

  /**
   * Batch facet search rendering. One numbered query legend up top,
   * then the merged deduplicated list with per-memory provenance
   * ("Found by: #1, #3"). Completeness across the submitted variants
   * is guaranteed by code (provider.searchMany), not by hoping the
   * model issues every follow-up search itself — the failure mode
   * R9/R9b traced on multi-item questions (#mem9-discussion:037b518a,
   * 2026-06-12).
   */
  private async batchExecution(
    queries: readonly string[],
    limit: number,
    scanAll: boolean | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.provider.searchMany({ queries, limit, scanAll, signal });
      const builder = new ToolResultBuilder({ maxChars: 12_000, maxLineLength: 2_000 });

      builder.write('Queries:\n');
      queries.forEach((query, index) => {
        builder.write(`  #${String(index + 1)}: ${query}\n`);
      });
      builder.write('Session scoped: false\n');
      const totalPool = result.perQueryAvailableCounts.reduce((sum, count) => sum + count, 0);
      builder.write(
        `${String(result.memories.length)} unique memories across ` +
          `${String(queries.length)} queries (candidate pools total ${String(totalPool)})\n\n`,
      );

      if (result.memories.length === 0) {
        builder.write('No memories found.\n');
      }

      result.memories.forEach((memory, index) => {
        if (index > 0) builder.write('---\n');
        builder.write(`Memory ${String(index + 1)}\n`);
        builder.write(`Content: ${memory.content}\n`);
        if (memory.confidence !== undefined) {
          builder.write(`Confidence: ${String(memory.confidence)}\n`);
        }
        if (memory.score !== undefined) {
          builder.write(`Score: ${String(memory.score)}\n`);
        }
        if (memory.memoryType !== undefined) {
          builder.write(`Type: ${memory.memoryType}\n`);
        }
        const sources = memory.foundByQueryIndexes.map((i) => `#${String(i + 1)}`).join(', ');
        builder.write(`Found by: ${sources}\n`);
      });

      if (result.retryHint !== undefined) {
        if (builder.nChars > 0) builder.write('\n');
        builder.write(`Retry hint: ${result.retryHint}\n`);
      }

      return builder.ok();
    } catch (error) {
      return { isError: true, output: classifyMem9Error('Memory search', error) };
    }
  }
}

/**
 * The deduplicated effective query list for one tool call: the primary
 * `query` first, then any facet variants, trimmed, with exact
 * duplicates dropped (first occurrence wins). Length 1 means the call
 * takes the unchanged single-query path.
 */
function effectiveQueries(primary: string, variants: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const candidate of [primary, ...(variants ?? [])]) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

function classifyMem9Error(action: string, error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (name === 'AbortError' || lower.includes('abort')) return `${action} cancelled: ${message}`;
  if (name === 'TimeoutError' || lower.includes('timed out') || lower.includes('timeout')) {
    return `${action} timed out: ${message}`;
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return `${action} failed (authentication): ${message}`;
  }
  if (lower.includes('http ') || lower.includes('network') || lower.includes('fetch')) {
    return `${action} failed (network): ${message}`;
  }
  return `${action} failed: ${message}`;
}
