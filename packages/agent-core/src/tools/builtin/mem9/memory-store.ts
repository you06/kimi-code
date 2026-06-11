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

// Per #mem9-discussion:9dcf4b01 (2026-06-05): agent generates the
// retrieval keys itself instead of letting mem9 server run a
// generic LLM extractor against the V text. The agent has the full
// system prompt + tool context + conversation history when it stores
// a fact, so the K it produces should describe the queries it (or a
// future agent in the same session) is likely to actually ask. The
// mem9 server-side `extractkeys.Extract` path remains as fallback
// when `retrieval_keys` is omitted/empty.
const RetrievalKeySchema = z.object({
  text: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'A short query-shaped phrase (≤ 8 words) that a future agent might say when looking for this fact. ' +
        'Use a complete predicate fragment ("user works at", "team deploys on", "project uses") or a named ' +
        'entity from the fact ("Acme Robotics", "千葉"). Avoid single-token generic words like "user", "home", ' +
        '"team" — they collide with unrelated memories.',
    ),
  source: z
    .enum(['agent', 'agent_translation'])
    .describe(
      '`agent` for keys in the same language as the fact. `agent_translation` for the cross-language ' +
        'expansion when the fact contains a named entity that the user may search for in another language ' +
        '(e.g. emit both "company in Otemachi" and "会社の所在地 大手町").',
    ),
  weight: z
    .number()
    .min(0.1)
    .max(2.0)
    .optional()
    .describe(
      'Recall-time ranking weight in [0.1, 2.0]. Default 1.0. Use higher (≈1.3–1.5) for keys that combine a ' +
        'predicate AND a named entity; use lower (≈0.5–0.8) for entity-only keys.',
    ),
});

export const Mem9MemoryStoreInputSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'The fact to remember, written as a short declarative statement with an explicit subject. Store one fact per call. ' +
        'Resolve relative time references ("last week", "yesterday", "Friday") to absolute dates when the surrounding ' +
        'context (a system-supplied session date, an earlier dated turn, or the message timestamp) gives a reliable ' +
        'anchor — store only the absolute form, dropping the relative phrase. With no anchor, preserve the original wording rather than invent ' +
        'precision. Periodic schedules ("every Friday", "weekly") are not relative references and stay as-is.',
    ),
  retrieval_keys: z
    .array(RetrievalKeySchema)
    .min(1)
    .max(10)
    .optional()
    .describe(
      'Retrieval keys for this fact: 3–7 short query phrases (≤ 8 words each) that mix predicate fragments ' +
        '(like "user works at") and named entities (like "Acme Robotics"). When the fact contains a named ' +
        'entity that may be searched for in another language, add 1–2 cross-language keys with ' +
        '`source: "agent_translation"`. When the fact is an instance of a recurring category (activity, ' +
        'hobby, place type, preference), add 1–2 category keys with the subject name ("Melanie activities") ' +
        'so future aggregate searches match without guessing the specific word. mem9 server rejects ' +
        'single-token generic stop-list words ' +
        '(`user`, `home`, `team`, `project`, `company`, `name`, `date`, `time`, `place`, `work`); each key ' +
        'must share at least one token with the fact (translation keys are exempt). Omitting this field ' +
        "falls back to mem9's generic server-side key extraction, which has no access to the agent's " +
        'reasoning context and tends to produce noisier keys; prefer providing keys yourself.',
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
      execute: (ctx) =>
        this.execution({ content, retrieval_keys: args.retrieval_keys }, ctx),
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
        retrievalKeys: args.retrieval_keys,
        signal,
      });
      const builder = new ToolResultBuilder({ maxChars: 4_000, maxLineLength: 2_000 });

      builder.write(`Status: ${result.status}\n`);
      builder.write(`Accepted: ${String(result.accepted)}\n`);
      builder.write(`Searchable now: ${String(result.searchableNow)}\n`);
      if (this.sessionId !== undefined && this.sessionId.length > 0) {
        builder.write(`Source session: ${this.sessionId}\n`);
      }
      if (result.keysInserted !== undefined) {
        builder.write(`Retrieval keys accepted: ${String(result.keysInserted)}\n`);
      }
      if (result.keysRejected !== undefined && result.keysRejected.length > 0) {
        builder.write('Retrieval keys rejected:\n');
        for (const rejected of result.keysRejected) {
          builder.write(`  - ${rejected.text} (${rejected.reason})\n`);
        }
        builder.write(
          'Adjust the rejected keys (drop stop-list words, add a predicate fragment, share a token with the fact) before re-storing this fact.\n',
        );
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
