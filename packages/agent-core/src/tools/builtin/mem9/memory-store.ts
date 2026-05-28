import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { Mem9MemoryProvider } from '../../providers/mem9-memory';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './memory-store.md';

export const Mem9MemoryStoreInputSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'The fact to remember, written as a short declarative statement with an explicit subject. Store one fact per call.',
    ),
});

export type Mem9MemoryStoreInput = z.Infer<typeof Mem9MemoryStoreInputSchema>;

export class Mem9MemoryStoreTool implements BuiltinTool<Mem9MemoryStoreInput> {
  readonly name = 'Mem9MemoryStore' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(Mem9MemoryStoreInputSchema);

  constructor(
    private readonly provider: Mem9MemoryProvider,
    private readonly sessionId?: string,
  ) {}

  resolveExecution(args: Mem9MemoryStoreInput): ToolExecution {
    const content = args.content.trim();
    if (content.length === 0) return { isError: true, output: 'content is required' };
    const preview = content.length > 40 ? `${content.slice(0, 40)}…` : content;
    const subject = approvalSubject(content);
    return {
      accesses: ToolAccesses.none(),
      description: `Storing mem9 memory: ${preview}`,
      display: {
        kind: 'generic',
        summary: `Store mem9 memory: ${preview}`,
        detail: { content },
      },
      approvalRule: literalRulePattern(this.name, subject),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
      execute: (ctx) => this.execution({ content }, ctx),
    };
  }

  private async execution(
    args: Mem9MemoryStoreInput,
    { signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.provider.store({
        content: args.content,
        sessionId: this.sessionId,
        signal,
      });
      const builder = new ToolResultBuilder({ maxChars: 4_000, maxLineLength: 2_000 });

      builder.write(`Status: ${result.status}\n`);
      builder.write(`Accepted: ${String(result.accepted)}\n`);
      builder.write(`Searchable now: ${String(result.searchableNow)}\n`);
      if (this.sessionId !== undefined && this.sessionId.length > 0) {
        builder.write(`Source session: ${this.sessionId}\n`);
      }
      if (result.hint !== undefined) {
        builder.write(`Hint: ${result.hint}\n`);
      }
      builder.write(
        'Writes are best-effort and not guaranteed unique; mem9 server-side smart extraction handles deduplication.\n',
      );

      return builder.ok();
    } catch (error) {
      return { isError: true, output: classifyMem9StoreError(error) };
    }
  }
}

function approvalSubject(content: string): string {
  const preview = content.replaceAll(/\s+/g, ' ').trim().slice(0, 80);
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
  return `${digest}:${preview}`;
}

function classifyMem9StoreError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (name === 'AbortError' || lower.includes('abort')) {
    return `Memory store cancelled: ${message}`;
  }
  if (name === 'TimeoutError' || lower.includes('timed out') || lower.includes('timeout')) {
    return `Memory store timed out: ${message}`;
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return `Memory store failed (authentication): ${message}`;
  }
  if (lower.includes('http ') || lower.includes('network') || lower.includes('fetch')) {
    return `Memory store failed (network): ${message}`;
  }
  return `Memory store failed: ${message}`;
}
