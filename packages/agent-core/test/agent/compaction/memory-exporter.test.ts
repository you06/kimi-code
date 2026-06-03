import { mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CompactionMemoryExporter,
  type CompactionExportDiagnosticEvent,
  type CompactionMemoryExporterOptions,
} from '#/agent/compaction/memory-exporter';

interface Harness {
  exporter: CompactionMemoryExporter;
  queueDir: string;
  diagnostics: CompactionExportDiagnosticEvent[];
  fetchMock: ReturnType<typeof vi.fn>;
  capturedRequests: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }>;
}

function buildExporter(
  overrides: Partial<CompactionMemoryExporterOptions> = {},
): Harness {
  const queueDir = mkdtempSync(join(tmpdir(), 'kimi-compaction-export-'));
  const diagnostics: CompactionExportDiagnosticEvent[] = [];
  const captured: Harness['capturedRequests'] = [];
  const fetchMock = vi.fn(
    async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = init?.headers as Record<string, string>;
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
      captured.push({ url, headers, body });
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    },
  );
  const exporter = new CompactionMemoryExporter({
    enabled: true,
    queueDir,
    mem9: {
      baseUrl: 'http://mem9.test',
      apiKey: 'mem9-test-key',
      agentId: 'kimi-code',
    },
    manualTick: true,
    fetchImpl: fetchMock as unknown as typeof fetch,
    onDiagnostic: (event) => diagnostics.push(event),
    ...overrides,
  });
  return { exporter, queueDir, diagnostics, fetchMock, capturedRequests: captured };
}

const sampleJob = () => ({
  sessionId: 'session-x',
  agentId: 'kimi-code',
  summary: 'Compacted summary text.',
  compactedMessages: [
    { role: 'user' as const, content: 'old user message' },
    { role: 'assistant' as const, content: 'old assistant reply' },
  ],
  metadata: {
    ingest_source: 'kimi-code-compaction' as const,
    session_id: 'session-x',
    tokens_before: 100,
    tokens_after: 30,
    compaction_trigger: 'auto' as const,
  },
});

describe('CompactionMemoryExporter', () => {
  let cleanup: Array<() => Promise<void>> = [];

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn().catch(() => {});
    }
  });

  it('disabled mode is fully silent — enqueue is a no-op and reaper never touches disk', async () => {
    const queueDir = mkdtempSync(join(tmpdir(), 'kimi-compaction-export-disabled-'));
    const exporter = CompactionMemoryExporter.disabled();
    cleanup.push(() => exporter.stopReaper());
    await exporter.enqueue(sampleJob());
    exporter.startReaper();
    await exporter.tick();
    expect(readdirSync(queueDir)).toEqual([]);
    expect(exporter.enabled).toBe(false);
  });

  it('enqueue writes a single pending file containing the job JSON', async () => {
    const h = buildExporter();
    cleanup.push(() => h.exporter.stopReaper());
    await h.exporter.enqueue(sampleJob());
    const entries = readdirSync(h.queueDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^000-[0-9a-f-]+\.pending$/);
    const job = JSON.parse(readFileSync(join(h.queueDir, entries[0]!), 'utf-8'));
    expect(job).toMatchObject({
      sessionId: 'session-x',
      agentId: 'kimi-code',
      attempts: 0,
      metadata: { ingest_source: 'kimi-code-compaction' },
    });
    expect(job.jobId).toMatch(/^[0-9a-f-]+$/);
    expect(typeof job.enqueuedAt).toBe('number');
  });

  it('concurrent enqueues produce distinct jobIds and files', async () => {
    const h = buildExporter();
    cleanup.push(() => h.exporter.stopReaper());
    await Promise.all([
      h.exporter.enqueue(sampleJob()),
      h.exporter.enqueue(sampleJob()),
      h.exporter.enqueue(sampleJob()),
    ]);
    const entries = readdirSync(h.queueDir);
    expect(entries).toHaveLength(3);
    const ids = entries.map((name) => name.match(/^000-([^.]+)\./)?.[1]).filter(Boolean);
    expect(new Set(ids).size).toBe(3);
  });

  it('reaper tick posts pending job to mem9 with metadata + ingest_source and removes file on 2xx', async () => {
    const h = buildExporter();
    cleanup.push(() => h.exporter.stopReaper());
    await h.exporter.enqueue(sampleJob());
    await h.exporter.tick();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const req = h.capturedRequests[0]!;
    expect(req.url).toBe('http://mem9.test/v1alpha2/mem9s/memories');
    expect(req.headers['X-Mnemo-Agent-Id']).toBe('kimi-code');
    expect(req.headers['X-API-Key']).toBe('mem9-test-key');
    expect(req.body).toMatchObject({
      agent_id: 'kimi-code',
      session_id: 'session-x',
      mode: 'smart',
      metadata: { ingest_source: 'kimi-code-compaction', tokens_after: 30 },
    });
    expect(req.body['messages']).toEqual([
      { role: 'user', content: 'old user message' },
      { role: 'assistant', content: 'old assistant reply' },
    ]);
    expect(readdirSync(h.queueDir)).toEqual([]);
  });

  it('4xx response renames to retry pending with attempts++ + emits diagnostic', async () => {
    const h = buildExporter({ backoffBaseMs: 0 });
    cleanup.push(() => h.exporter.stopReaper());
    h.fetchMock.mockImplementationOnce(
      async () => new Response('rejected', { status: 400 }),
    );
    await h.exporter.enqueue(sampleJob());
    await h.exporter.tick();
    const after = readdirSync(h.queueDir);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/^001-[0-9a-f-]+\.pending$/);
    expect(h.diagnostics).toEqual([
      expect.objectContaining({
        type: 'compaction.export.send_failed',
        attempts: 1,
      }),
    ]);
  });

  it('respects exponential backoff: ineligible job is skipped on tick', async () => {
    const h = buildExporter({ backoffBaseMs: 60_000 });
    cleanup.push(() => h.exporter.stopReaper());
    h.fetchMock.mockImplementation(
      async () => new Response('rejected', { status: 500 }),
    );
    await h.exporter.enqueue(sampleJob());
    // First tick: send fails, attempt count becomes 1, file requeued
    await h.exporter.tick();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    // Second tick immediately: still inside backoff window, mem9 not called
    await h.exporter.tick();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(h.queueDir)).toHaveLength(1);
  });

  it('after maxRetries the job is renamed to .failed.attempts-N + emits permanent_failure', async () => {
    const h = buildExporter({ backoffBaseMs: 0, maxRetries: 2 });
    cleanup.push(() => h.exporter.stopReaper());
    h.fetchMock.mockImplementation(
      async () => new Response('always 500', { status: 500 }),
    );
    await h.exporter.enqueue(sampleJob());
    await h.exporter.tick(); // attempts 0 -> 1, requeue
    await h.exporter.tick(); // attempts 1 -> 2 (== maxRetries), permanent
    const after = readdirSync(h.queueDir);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/\.failed\.attempts-2$/);
    expect(h.diagnostics.at(-1)).toMatchObject({
      type: 'compaction.export.permanent_failure',
      attempts: 2,
    });
  });

  it('startReaper reclaims orphaned .processing.* files left by a previous crashed process', async () => {
    const h = buildExporter();
    cleanup.push(() => h.exporter.stopReaper());
    // Simulate a crashed run: write a `.processing.<pid>` file directly.
    const orphan = join(h.queueDir, '000-orphan-uuid.processing.99999');
    writeFileSync(
      orphan,
      JSON.stringify({
        jobId: 'orphan-uuid',
        enqueuedAt: 0,
        attempts: 0,
        ...sampleJob(),
      }),
    );
    // Restart: a *new* exporter instance over the same queueDir
    const h2 = buildExporter({ queueDir: h.queueDir, fetchImpl: h.fetchMock as unknown as typeof fetch });
    cleanup.push(() => h2.exporter.stopReaper());
    // startReaper was called by the constructor implicitly only if
    // enabled — we explicitly drive a tick to confirm reclaim worked.
    h2.exporter.startReaper();
    const entries = readdirSync(h.queueDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe('000-orphan-uuid.pending');
    // and tick processes it
    await h2.exporter.tick();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(h.queueDir)).toEqual([]);
  });

  it('emits enqueue_failed diagnostic when queue dir is unwritable and does NOT throw', async () => {
    const queueDir = mkdtempSync(join(tmpdir(), 'kimi-compaction-export-ro-'));
    // Read-only dir → atomic write will fail
    chmodSync(queueDir, 0o500);
    const h = buildExporter({ queueDir });
    cleanup.push(async () => {
      try {
        chmodSync(queueDir, 0o700);
      } catch {
        /* ignore */
      }
      await h.exporter.stopReaper();
    });
    await expect(h.exporter.enqueue(sampleJob())).resolves.toBeUndefined();
    expect(h.diagnostics).toEqual([
      expect.objectContaining({ type: 'compaction.export.enqueue_failed' }),
    ]);
  });

  it('redacts bearer tokens / api keys from diagnostic reasons', async () => {
    const h = buildExporter({ backoffBaseMs: 0 });
    cleanup.push(() => h.exporter.stopReaper());
    h.fetchMock.mockImplementationOnce(async () => {
      throw new Error(
        'fetch failed: Authorization: Bearer abc.def.ghi sent to mem9',
      );
    });
    await h.exporter.enqueue(sampleJob());
    await h.exporter.tick();
    const event = h.diagnostics[0]!;
    expect(event.reason).not.toContain('abc.def.ghi');
    expect(event.reason).toMatch(/<redacted>/);
  });
});
