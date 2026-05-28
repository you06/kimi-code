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
      'A short declarative description of what to recall, NOT a question. Good: "user prefers Python". Bad: "what does the user like?"',
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
    const preview = query.length > 40 ? `${query.slice(0, 40)}…` : query;
    return {
      accesses: ToolAccesses.none(),
      description: `Searching mem9 memory: ${preview}`,
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
      const result = await this.provider.search({
        query: args.query,
        limit,
        scanAll: args.scan_all,
        signal,
      });
      const builder = new ToolResultBuilder({ maxChars: 12_000, maxLineLength: 2_000 });

      builder.write(`Effective query: ${result.effectiveQuery}\n`);
      builder.write('Session scoped: false\n');
      builder.write(`Available results: ${String(result.availableResultCount)}\n\n`);

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
        if (memory.relativeAge !== undefined) {
          builder.write(`Age: ${memory.relativeAge}\n`);
        }
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
