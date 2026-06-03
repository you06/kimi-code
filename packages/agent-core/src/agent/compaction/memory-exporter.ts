// CompactionMemoryExporter — durable, at-least-once exporter of
// compacted prefixes to a mem9 server.
//
// Design locked in #mem9-discussion:9dcf4b01 (Phase 2b):
//
//   - Triggered after a *successful* compaction by `FullCompaction.
//     compactionWorker`, never during. The compaction state machine is
//     not allowed to depend on this exporter's success.
//   - Two halves with a durable boundary in between:
//
//        compactionWorker → enqueue() → <local JSON queue> → reaper
//                                                            → mem9 POST
//
//     enqueue() returns once the job is on disk; the network write
//     happens later in a background reaper. Enqueue failures emit a
//     redacted diagnostic event and do NOT throw out of the
//     compaction worker — by team agreement compaction continues even
//     when memory export cannot enqueue.
//   - Reaper is in-process `setInterval` with `unref()` so the timer
//     never keeps the event loop alive on its own (matches the cron
//     scheduler pattern in `tools/cron/scheduler.ts`).
//   - Reaper does its work serially per tick to avoid hammering mem9.
//   - Crash recovery: every reaper start reclaims any `.processing.*`
//     files left behind by a previous crashed process to `.pending`
//     before scanning. mem9's `content_hash` UNIQUE constraint
//     dedupes a duplicate POST server-side; we accept at-least-once.
//   - Disabled mode (`enabled: false`) is fully silent — no
//     directory creation, no log output, no diagnostic events. The
//     exporter constructor returns a no-op instance.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  promises as fs,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import type { Logger } from '../../logging/types';
import type { CompactedMessageView } from '../../rpc/events';

export interface CompactionExportMetadata {
  readonly ingest_source: 'kimi-code-compaction';
  readonly session_id?: string;
  readonly tokens_before: number;
  readonly tokens_after: number;
  readonly compaction_trigger: 'auto' | 'manual';
}

export interface CompactionExportJobInput {
  readonly sessionId?: string;
  readonly agentId: string;
  readonly summary: string;
  readonly compactedMessages: readonly CompactedMessageView[];
  readonly metadata: CompactionExportMetadata;
}

interface CompactionExportJobOnDisk extends CompactionExportJobInput {
  readonly jobId: string;
  readonly enqueuedAt: number;
  readonly attempts: number;
  // nextAttemptAt is the earliest wall-clock time the reaper is
  // allowed to retry this job. Set on enqueue to `now` (immediately
  // eligible) and on retry to `now + backoffBase * 2^(attempts-1)`.
  readonly nextAttemptAt: number;
}

export interface CompactionExportDiagnosticEvent {
  readonly type:
    | 'compaction.export.enqueue_failed'
    | 'compaction.export.send_failed'
    | 'compaction.export.permanent_failure';
  readonly jobId?: string;
  readonly sessionId?: string;
  readonly attempts?: number;
  readonly reason: string;
}

export interface Mem9ExportTarget {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly agentId: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface CompactionMemoryExporterOptions {
  readonly enabled: boolean;
  readonly queueDir: string;
  readonly mem9: Mem9ExportTarget;
  readonly reaperIntervalMs?: number;
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly onDiagnostic?: (event: CompactionExportDiagnosticEvent) => void;
  // Test seam: when set, the reaper is driven by `tick()` calls
  // instead of `setInterval`. Used by unit tests to step through
  // queue states deterministically.
  readonly manualTick?: boolean;
}

const DEFAULT_REAPER_INTERVAL_MS = 30_000;
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const STORE_TIMEOUT_MS = 30_000;

const PENDING_SUFFIX = '.pending';
const PROCESSING_PREFIX = '.processing.';
const FAILED_SUFFIX_PREFIX = '.failed.attempts-';

export class CompactionMemoryExporter {
  private readonly opts: CompactionMemoryExporterOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Logger;
  private readonly onDiagnostic?: (event: CompactionExportDiagnosticEvent) => void;
  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private reaperRunning = false;
  private started = false;

  static disabled(): CompactionMemoryExporter {
    return new CompactionMemoryExporter({
      enabled: false,
      queueDir: '',
      mem9: { baseUrl: '', apiKey: '', agentId: '' },
    });
  }

  constructor(opts: CompactionMemoryExporterOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger;
    this.onDiagnostic = opts.onDiagnostic;
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  // enqueue writes a job descriptor to disk atomically (tmp → fsync →
  // rename) and returns once it is durable. Failures are surfaced as
  // a diagnostic event and never thrown; compaction must not depend
  // on the queue layer.
  async enqueue(input: CompactionExportJobInput): Promise<void> {
    if (!this.opts.enabled) return;
    const jobId = randomUUID();
    const enqueuedAt = Date.now();
    const job: CompactionExportJobOnDisk = {
      jobId,
      enqueuedAt,
      nextAttemptAt: enqueuedAt,
      attempts: 0,
      ...input,
    };
    try {
      this.ensureQueueDir();
      const target = this.pathFor(jobId, 0, PENDING_SUFFIX);
      writeAtomic(target, JSON.stringify(job));
    } catch (err) {
      this.emitDiagnostic({
        type: 'compaction.export.enqueue_failed',
        jobId,
        sessionId: input.sessionId,
        reason: redactReason(err),
      });
      this.logger?.warn?.('compaction memory export: enqueue failed', {
        reason: redactReason(err),
      });
    }
  }

  startReaper(): void {
    if (!this.opts.enabled) return;
    if (this.started) return;
    this.started = true;
    try {
      this.ensureQueueDir();
      this.reclaimProcessing();
    } catch (err) {
      this.logger?.warn?.('compaction memory export: reaper start prep failed', {
        reason: redactReason(err),
      });
    }
    if (this.opts.manualTick === true) return;
    const interval = this.opts.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
    if (interval <= 0) return;
    const handle = setInterval(() => {
      void this.tick();
    }, interval);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref: () => void }).unref();
    }
    this.timerHandle = handle;
  }

  async stopReaper(): Promise<void> {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    this.started = false;
    // Wait out any in-flight tick before returning so callers (tests,
    // shutdown) can rely on "no further network activity" after this
    // resolves.
    while (this.reaperRunning) {
      await sleep(10);
    }
  }

  // tick processes any eligible jobs in the queue. Exposed primarily
  // for tests via `manualTick: true`; also called by the setInterval
  // loop. Serial — never overlaps with itself.
  async tick(): Promise<void> {
    if (!this.opts.enabled) return;
    if (this.reaperRunning) return;
    this.reaperRunning = true;
    try {
      const eligible = this.scanEligible();
      for (const entry of eligible) {
        await this.processJob(entry);
      }
    } catch (err) {
      this.logger?.warn?.('compaction memory export: reaper tick failed', {
        reason: redactReason(err),
      });
    } finally {
      this.reaperRunning = false;
    }
  }

  private ensureQueueDir(): void {
    mkdirSync(this.opts.queueDir, { recursive: true, mode: 0o700 });
  }

  private pathFor(jobId: string, attempts: number, suffix: string): string {
    const stem = `${attempts.toString().padStart(3, '0')}-${jobId}`;
    return join(this.opts.queueDir, `${stem}${suffix}`);
  }

  // Reclaim any `.processing.<pid>` files left over from a previous
  // process that crashed mid-send. Renamed back to `.pending` so the
  // current reaper picks them up. Idempotent across crashes.
  private reclaimProcessing(): void {
    const entries = safeReaddir(this.opts.queueDir);
    for (const name of entries) {
      const idx = name.indexOf(PROCESSING_PREFIX);
      if (idx < 0) continue;
      const stem = name.slice(0, idx);
      try {
        renameSync(
          join(this.opts.queueDir, name),
          join(this.opts.queueDir, `${stem}${PENDING_SUFFIX}`),
        );
      } catch {
        // best-effort; another process may already be reaping
      }
    }
  }

  // Return eligible pending entries sorted by enqueuedAt (oldest
  // first) and filtered by nextAttemptAt against wall clock.
  private scanEligible(): readonly QueueEntry[] {
    const now = Date.now();
    const eligible: QueueEntry[] = [];
    for (const name of safeReaddir(this.opts.queueDir)) {
      if (!name.endsWith(PENDING_SUFFIX)) continue;
      const fullPath = join(this.opts.queueDir, name);
      let raw: string;
      try {
        raw = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }
      let job: CompactionExportJobOnDisk;
      try {
        job = JSON.parse(raw) as CompactionExportJobOnDisk;
      } catch {
        continue;
      }
      // Back-compat: legacy jobs (pre-nextAttemptAt) are immediately
      // eligible. New jobs honor their stored nextAttemptAt.
      const nextAttemptAt = job.nextAttemptAt ?? job.enqueuedAt;
      if (nextAttemptAt > now) continue;
      eligible.push({ name, path: fullPath, job });
    }
    eligible.sort((a, b) => a.job.enqueuedAt - b.job.enqueuedAt);
    return eligible;
  }

  private async processJob(entry: QueueEntry): Promise<void> {
    const { name, path, job } = entry;
    const stem = name.slice(0, -PENDING_SUFFIX.length);
    const processingPath = join(
      this.opts.queueDir,
      `${stem}${PROCESSING_PREFIX}${process.pid}`,
    );
    try {
      renameSync(path, processingPath);
    } catch {
      // another reaper took it; skip
      return;
    }
    try {
      await this.postToMem9(job);
      unlinkSync(processingPath);
    } catch (err) {
      const nextAttempts = job.attempts + 1;
      const maxRetries = this.opts.maxRetries ?? DEFAULT_MAX_RETRIES;
      const reason = redactReason(err);
      if (nextAttempts >= maxRetries) {
        const failedPath = join(
          this.opts.queueDir,
          `${stem}${FAILED_SUFFIX_PREFIX}${nextAttempts}`,
        );
        try {
          renameSync(processingPath, failedPath);
        } catch {
          /* best effort */
        }
        this.emitDiagnostic({
          type: 'compaction.export.permanent_failure',
          jobId: job.jobId,
          sessionId: job.sessionId,
          attempts: nextAttempts,
          reason,
        });
        return;
      }
      const backoffBase = this.opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
      const nextAttemptAt =
        Date.now() + backoffBase * 2 ** Math.max(0, nextAttempts - 1);
      const updated: CompactionExportJobOnDisk = {
        ...job,
        attempts: nextAttempts,
        nextAttemptAt,
      };
      const stemNext = `${nextAttempts.toString().padStart(3, '0')}-${job.jobId}`;
      const retryPath = join(this.opts.queueDir, `${stemNext}${PENDING_SUFFIX}`);
      try {
        writeAtomic(retryPath, JSON.stringify(updated));
        unlinkSync(processingPath);
      } catch (retryErr) {
        // failed to write retry; leave the processing file for the
        // next reaper round (reclaimProcessing will rescue it).
        this.logger?.warn?.('compaction memory export: retry write failed', {
          reason: redactReason(retryErr),
        });
      }
      this.emitDiagnostic({
        type: 'compaction.export.send_failed',
        jobId: job.jobId,
        sessionId: job.sessionId,
        attempts: nextAttempts,
        reason,
      });
    }
  }

  private async postToMem9(job: CompactionExportJobOnDisk): Promise<void> {
    const body = {
      messages: job.compactedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      agent_id: job.agentId,
      session_id: job.sessionId,
      mode: 'smart',
      metadata: job.metadata,
    };
    // customHeaders spread FIRST so the required auth/identity
    // headers below win on key collision. Matches the order in
    // `Mem9MemoryProvider.headers()` — caller-supplied headers must
    // not be able to override `X-Mnemo-Agent-Id` / `X-API-Key`.
    const headers: Record<string, string> = {
      ...(this.opts.mem9.customHeaders ?? {}),
      'Content-Type': 'application/json',
      'X-Mnemo-Agent-Id': job.agentId,
      'X-API-Key': this.opts.mem9.apiKey,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STORE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.opts.mem9.baseUrl}/v1alpha2/mem9s/memories`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Drain body briefly so the socket can be reused; do not include
      // the body in diagnostic events (it may echo back the user
      // content the agent just compacted).
      try {
        await response.text();
      } catch {
        /* ignore */
      }
      throw new Error(`mem9 returned HTTP ${response.status}`);
    }
  }

  private emitDiagnostic(event: CompactionExportDiagnosticEvent): void {
    if (this.onDiagnostic !== undefined) {
      try {
        this.onDiagnostic(event);
      } catch {
        // never let a diagnostic listener break the exporter
      }
    }
  }
}

interface QueueEntry {
  readonly name: string;
  readonly path: string;
  readonly job: CompactionExportJobOnDisk;
}

function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const data = Buffer.from(content, 'utf-8');
  const fd = openSync(tmp, 'w', 0o600);
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function safeReaddir(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// redactReason strips network bodies, API keys, and message payloads
// from error messages so diagnostic events stay safe to emit on the
// public agent event stream. Errors at this layer come from either
// `node:fs` (paths only, no secrets) or `fetch`/AbortError (status
// codes only) — both are safe — but we still cap length and refuse
// non-string causes defensively.
function redactReason(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const trimmed = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  // Strip anything that smells like a bearer / x-api-key / mem9 url
  // path in case the underlying error helpfully echoed it.
  return trimmed
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer <redacted>')
    .replace(/X-API-Key:\s*[^\s,]+/gi, 'X-API-Key: <redacted>')
    .replace(/apikey=[^&\s,]+/gi, 'apikey=<redacted>');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Unused `fs.promises` import kept for future async migration; intentionally
// referenced here so the import remains tree-shake-stable.
void fs;
