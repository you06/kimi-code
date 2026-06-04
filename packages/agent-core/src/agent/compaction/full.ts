import {
  ErrorCodes,
  KimiError,
  isKimiError,
  makeErrorPayload,
  toKimiErrorPayload,
} from '#/errors';
import {
  APIEmptyResponseError,
  isRetryableGenerateError,
  type GenerateResult,
  type Message,
  type TokenUsage,
  APIContextOverflowError,
} from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { isAbortError } from '../../loop/errors';
import {
  retryBackoffDelays,
  sleepForRetry,
} from '../../loop/retry';
import { renderPrompt } from '../../utils/render-prompt';
import {
  estimateTokens,
  estimateTokensForMessages,
} from '../../utils/tokens';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '../../utils/completion-budget';
import { randomUUID } from 'node:crypto';

import type { CompactedMessageView } from '../../rpc/events';
import compactionInstructionTemplate from './compaction-instruction.md';
import {
  CompactionMemoryExporter,
  type CompactionExportDiagnosticEvent,
} from './memory-exporter';
import { renderMessagesToText } from './render-messages';
import { renderTodoList, type TodoItem } from '../../tools/builtin/state/todo-list';
import type { CompactionBeginData, CompactionResult } from './types';
import {
  DEFAULT_COMPACTION_CONFIG,
  DefaultCompactionStrategy,
  type CompactionStrategy,
} from './strategy';

type CompactionTelemetryTrigger = CompactionBeginData['source'] | 'manual-with-prompt' | 'unknown';

export interface CompactedHistory {
  text: string;
}

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;

class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

export class FullCompaction {
  protected compactionCountInTurn = 0;
  protected compacting: {
    abortController: AbortController;
    startedAt: number;
    telemetryTrigger: CompactionTelemetryTrigger;
    promise: Promise<void>;
    blockedByTurn: boolean;
  } | null = null;
  protected _compactedHistory: CompactedHistory[] = [];
  protected readonly strategy: CompactionStrategy;
  readonly memoryExporter: CompactionMemoryExporter;
  protected readonly sessionId: string | undefined;

  constructor(
    protected readonly agent: Agent,
    strategy?: CompactionStrategy,
    options?: { sessionId?: string; memoryExporter?: CompactionMemoryExporter },
  ) {
    this.strategy =
      strategy ??
      new DefaultCompactionStrategy(
        () => agent.config.modelCapabilities.max_context_tokens,
        {
          ...DEFAULT_COMPACTION_CONFIG,
          reservedContextSize:
            agent.kimiConfig?.loopControl?.reservedContextSize ??
            DEFAULT_COMPACTION_CONFIG.reservedContextSize,
        }
      );
    this.sessionId = options?.sessionId;
    // When the host hasn't wired an exporter (default), use the
    // no-op disabled instance. Hosts that want compaction memory
    // export to mem9 pass in a configured CompactionMemoryExporter
    // (see core-impl.ts / SDK harness). The exporter eagerly starts
    // its reaper here so any `.processing.*` jobs left behind by a
    // crashed previous process are reclaimed at startup before the
    // first new compaction enqueues anything.
    this.memoryExporter = options?.memoryExporter ?? CompactionMemoryExporter.disabled();
    this.memoryExporter.startReaper();
  }

  get isCompacting(): boolean {
    return this.compacting !== null;
  }

  // dispose tears down lifetime-bound resources held by the compaction
  // module — currently only the memory exporter's reaper. Called by
  // Agent.dispose() during session/agent shutdown so long-lived host
  // processes (SDK servers, embedded harnesses) get deterministic
  // cleanup without relying on `unref()` + process exit. Safe to call
  // multiple times.
  async dispose(): Promise<void> {
    await this.memoryExporter.stopReaper();
  }

  get compactedHistory(): readonly CompactedHistory[] {
    return this._compactedHistory;
  }

  begin(data: Readonly<CompactionBeginData>): void {
    if (this.compacting) return;
    if (data.source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    if (this.compactionCountInTurn > this.strategy.maxCompactionPerTurn) return;
    if (this.agent.records.restoring) {
      return;
    }
    const compactedCount = this.strategy.computeCompactCount(this.agent.context.history, data.source);
    if (compactedCount === 0) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'No prefix that can be compacted in current history.');
    }
    this.agent.records.logRecord({
      type: 'full_compaction.begin',
      ...data,
    });
    this.startCompactionWorker(data, compactedCount);
  }

  private startCompactionWorker(
    data: Readonly<CompactionBeginData>,
    compactedCount: number,
  ): void {
    const abortController = new AbortController();
    this.agent.emitEvent({
      type: 'compaction.started',
      trigger: data.source,
      instruction: data.instruction,
    });
    const active = {
      abortController,
      startedAt: Date.now(),
      telemetryTrigger: compactionTelemetryTrigger(data.source, data.instruction),
      promise: Promise.resolve(),
      blockedByTurn: false,
    };
    this.compacting = active;
    active.promise = this.compactionWorker(abortController.signal, data, compactedCount);
  }

  cancel(): void {
    this.markCanceled();
  }

  private markCanceled(): void {
    if (!this.compacting) return;
    this.agent.records.logRecord({
      type: 'full_compaction.cancel',
    });
    this.compacting.abortController.abort();
    this.compacting = null;
    this.agent.emitEvent({ type: 'compaction.cancelled' });
  }

  markCompleted() {
    this.agent.records.logRecord({
      type: 'full_compaction.complete',
    });
    this.compacting = null;
    this._compactedHistory.push({
      text: renderMessagesToText(this.agent.context.history),
    });
  }

  private get tokenCountWithPending(): number {
    return this.agent.context.tokenCountWithPending;
  }

  resetForTurn(): void {
    this.compactionCountInTurn = 0;
  }

  async handleOverflowError(signal: AbortSignal, error: unknown) {
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this.compacting) throw error;
    // Always block on overflow errors
    await this.block(signal);
  }

  async beforeStep(signal: AbortSignal): Promise<void> {
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending)) {
      await this.block(signal);
    }
  }

  async afterStep(): Promise<void> {
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
    // Do not block after the step
  }

  private checkAutoCompaction(throwOnLimit: boolean = true): boolean {
    if (this.compacting) return true;
    if (!this.strategy.shouldCompact(this.tokenCountWithPending)) return false;

    return this.beginAutoCompaction(throwOnLimit);
  }

  private beginAutoCompaction(throwOnLimit: boolean = true): boolean {
    if (this.compacting) return true;
    const maxCompactions = this.strategy.maxCompactionPerTurn;
    if (this.compactionCountInTurn >= maxCompactions) {
      if (throwOnLimit) {
        throw new KimiError(ErrorCodes.CONTEXT_OVERFLOW, `Compaction limit exceeded (${String(maxCompactions)})`, {
          details: { maxCompactions },
        });
      }
      return false;
    }
    this.begin({ source: 'auto', instruction: undefined });
    return this.compacting !== null;
  }

  private async block(signal: AbortSignal): Promise<void> {
    const active = this.compacting;
    if (active) {
      active.blockedByTurn = true;
      signal.addEventListener('abort', () => {
        if (this.compacting === active) {
          this.cancel();
        }
      });
      this.agent.emitEvent({
        type: 'compaction.blocked',
        turnId: this.agent.turn.currentId,
      });
      await active.promise;
    }
  }

  private async compactionWorker(
    signal: AbortSignal,
    data: Readonly<CompactionBeginData>,
    initialCompactedCount: number,
  ): Promise<void> {
    const startedAt = Date.now();
    const originalHistory = [...this.agent.context.history];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    let retryCount = 0;
    try {
      let compactedCount = initialCompactedCount;

      await this.triggerPreCompactHook(data, tokensBefore, signal);

      const model = this.agent.config.model;
      const provider = applyCompletionBudget({
        provider: this.agent.config.provider,
        budget: resolveCompletionBudget({
          reservedContextSize: this.agent.kimiConfig?.loopControl?.reservedContextSize,
        }),
        capability: this.agent.config.modelCapabilities,
      });

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let usage: TokenUsage | null;
      let summary: string;
      while (true) {
        const messagesToCompact = originalHistory.slice(0, compactedCount);
        const messages = [
          ...this.agent.context.project(messagesToCompact),
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: COMPACTION_INSTRUCTION(data.instruction),
              },
            ],
            toolCalls: [],
          } satisfies Message,
        ];
        try {
          const response = await this.agent.generate(
            provider,
            this.agent.config.systemPrompt,
            [...this.agent.tools.loopTools],
            messages,
            undefined,
            { signal },
          );
          if (response.finishReason === 'truncated') {
            throw new CompactionTruncatedError();
          }
          usage = response.usage;
          summary = extractCompactionSummary(response);
          break;
        } catch (error) {
          if (error instanceof APIContextOverflowError || error instanceof CompactionTruncatedError) {
            compactedCount = this.strategy.reduceCompactOnOverflow(messagesToCompact);
          }
          else if (!isRetryableGenerateError(error)) {
            throw error;
          }
          if (retryCount + 1 >= MAX_COMPACTION_RETRY_ATTEMPTS) {
            throw error;
          }
          await sleepForRetry(delays[retryCount]!, signal);
          retryCount += 1;
        }
      }

      if (usage !== null) {
        this.agent.usage.record(model, usage);
      }

      const newHistory = this.agent.context.history;
      for (let i = 0; i < originalHistory.length; i++) {
        if (newHistory[i] !== originalHistory[i]) {
          // History changed during compaction, likely due to undo
          this.cancel();
          return undefined;
        }
      }

      summary = this.postProcessSummary(summary);

      const recent = originalHistory.slice(compactedCount);
      const tokensAfter = estimateTokens(summary) + estimateTokensForMessages(recent);

      const result: CompactionResult = {
        summary,
        compactedCount,
        tokensBefore,
        tokensAfter,
      };

      const active = this.compacting!;
      this.agent.telemetry.track('compaction_finished', {
        trigger_type: active.telemetryTrigger,
        before_tokens: result.tokensBefore,
        after_tokens: result.tokensAfter,
        duration_ms: Date.now() - active.startedAt,
        compacted_count: result.compactedCount,
        retry_count: retryCount,
        ...usage,
      });
      // Take the prefix slice from the *final* result-driven count so
      // event subscribers and PostCompact hooks see exactly what the
      // summary replaces (the count may have shrunk during overflow
      // retries — `reduceCompactOnOverflow`).
      const compactedPrefix = originalHistory.slice(0, result.compactedCount);
      const compactedMessages = projectCompactedMessages(compactedPrefix);
      // Generate the compaction id BEFORE emitting the event so SDK
      // subscribers (LoCoMo benchmark variant 4, future Phase 3b
      // fact extractor) get the same id the exporter writes into
      // mem9's `metadata.compaction_id`. Without this ordering the
      // subscriber's `compaction_id → dia_ids` map can't be joined
      // back to the memories mem9 later returns. @Kaltsit caught
      // this in Phase 3a review (#mem9-discussion:9dcf4b01).
      const compactionId = randomUUID();
      this.markCompleted();
      this.agent.emitEvent({
        type: 'compaction.completed',
        compactionId,
        result,
        compactedMessages,
      });
      this.agent.context.applyCompaction(result);
      // Compaction collapses the prefix into a summary, dropping any goal
      // reminder that lived there. Re-inject it onto the fresh tail so an active
      // goal does not silently fall out of context. Append-only; no-op off goal mode.
      await this.agent.injection.injectGoal();
      // Memory export runs *after* the compaction is committed to
      // context. Enqueue is durable (writes a local file) and
      // non-throwing; the network POST to mem9 happens later in the
      // exporter's reaper. Failures don't fall through into the
      // compaction state machine.
      //
      // Phase 3a (locked 2026-06-04, #mem9-discussion:9dcf4b01):
      // ship the *summary* — a short narrative the LLM already
      // produced — instead of the raw compacted prefix. mem9's K
      // extraction now sees a ~few-KB input rather than a
      // potentially-100K-token prefix, which keeps it under its 3 s
      // timeout. The richer per-fact extractor (Phase 3b) will run
      // *on top of* `summary + compactedMessages` and produce
      // structured `Fact[]`; that lands in its own follow-up PR.
      // `compaction_id` lets the LoCoMo benchmark variant 4
      // subscriber join exporter writes to its parallel
      // `compaction.completed` event mapping for deterministic
      // recall@k (no fuzzy matching).
      await this.memoryExporter.enqueue({
        sessionId: this.sessionId,
        agentId: resolveAgentIdForExport(this.agent),
        summary: result.summary,
        metadata: {
          ingest_source: 'kimi-code-compaction-summary',
          session_id: this.sessionId,
          compaction_id: compactionId,
          compacted_count: result.compactedCount,
          tokens_before: result.tokensBefore,
          tokens_after: result.tokensAfter,
          compaction_trigger: data.source,
        },
      });
      this.triggerPostCompactHook(data, result, compactedMessages);
    } catch (error) {
      if (!isAbortError(error)) {
        const active = this.compacting;
        const blockedByTurn = active?.blockedByTurn === true;
        this.agent.log.error('compaction failed', {
          code: isKimiError(error) ? error.code : undefined,
          error,
        });
        this.markCanceled();
        if (!blockedByTurn) {
          const payload =
            isKimiError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED
              ? toKimiErrorPayload(error)
              : makeErrorPayload(ErrorCodes.COMPACTION_FAILED, String(error));
          this.agent.emitEvent({
            type: 'error',
            ...payload,
          });
        }
        this.agent.telemetry.track('compaction_failed', {
          trigger_type: compactionTelemetryTrigger(data.source, data.instruction),
          before_tokens: tokensBefore,
          duration_ms: Date.now() - startedAt,
          retry_count: retryCount,
          error_type: error instanceof Error ? error.name : 'Unknown',
        });
        if (blockedByTurn) {
          if (isKimiError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED) throw error;
          throw new KimiError(ErrorCodes.COMPACTION_FAILED, String(error), { cause: error });
        }
      }
    }
  }

  private async triggerPreCompactHook(
    data: Readonly<CompactionBeginData>,
    tokenCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.agent.hooks?.trigger('PreCompact', {
      matcherValue: data.source,
      signal,
      inputData: {
        trigger: data.source,
        tokenCount,
      },
    });
    signal.throwIfAborted();
  }

  private triggerPostCompactHook(
    data: Readonly<CompactionBeginData>,
    result: CompactionResult,
    compactedMessages: readonly CompactedMessageView[],
  ): void {
    void this.agent.hooks?.fireAndForgetTrigger('PostCompact', {
      matcherValue: data.source,
      inputData: {
        trigger: data.source,
        summary: result.summary,
        compactedCount: result.compactedCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        // DEPRECATED: kept in lockstep with `tokensAfter` so existing
        // hook scripts that read `estimatedTokenCount` keep working.
        // Remove once downstream consumers have migrated.
        estimatedTokenCount: result.tokensAfter,
        compactedMessages,
      },
    });
  }

  private postProcessSummary(summary: string): string {
    const storeData = this.agent.tools.storeData();
    const todos = (storeData['todo'] as readonly TodoItem[] | undefined) ?? [];
    if (todos.length === 0) {
      return summary;
    }
    const todoMarkdown = renderTodoList(todos, '## TODO List');
    return `${summary.trim()}\n\n${todoMarkdown}`;
  }
}

function extractCompactionSummary(response: GenerateResult): string {
  const summary =
    typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

  if (summary.trim().length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }
  return summary;
}

export const COMPACTION_INSTRUCTION = (customInstruction = ''): string =>
  renderPrompt(compactionInstructionTemplate, { customInstruction });

// resolveAgentIdForExport returns the agent id used in the
// compaction memory export POST body and `X-Mnemo-Agent-Id` header.
// Mirrors how Mem9MemoryProvider resolves its own id: read
// `KIMI_CODE_AGENT_ID` (which carries variant / benchmark namespace
// tags like `locomo-<subject>-<variant>`); fall back to `kimi-code`
// when unset so unconfigured deployments still route somewhere
// sensible. `_agent` is reserved for a future per-agent override.
function resolveAgentIdForExport(_agent: Agent): string {
  const fromEnv = process.env['KIMI_CODE_AGENT_ID'];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  return 'kimi-code';
}

// projectCompactedMessages flattens kosong Message objects into the
// wire-friendly {role, content} shape SDK subscribers consume. Text
// parts are concatenated with newlines; `think` parts (agent's
// internal reasoning) are deliberately dropped — they are not meant
// to be persisted as memory or replayed by benchmark drivers.
// Non-text content parts (image / audio / video URLs) are also
// skipped because the wire shape is text-only on purpose; richer
// projections can be added later as separate fields.
function projectCompactedMessages(
  messages: readonly Message[],
): CompactedMessageView[] {
  return messages.map((m) => {
    const text = m.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { type: 'text'; text: string }).text)
      .join('\n');
    return { role: m.role, content: text };
  });
}

function compactionTelemetryTrigger(
  trigger: CompactionBeginData['source'] | undefined,
  instruction: string | undefined,
): CompactionTelemetryTrigger {
  if (trigger === undefined) return 'unknown';
  if (trigger === 'manual' && instruction !== undefined && instruction.length > 0) {
    return 'manual-with-prompt';
  }
  return trigger;
}
