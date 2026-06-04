/**
 * Covers: Mem9MemorySearchTool, Mem9MemoryStoreTool, and Mem9MemoryProvider.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  Mem9MemorySearchInputSchema,
  Mem9MemorySearchTool,
  Mem9MemoryStoreInputSchema,
  Mem9MemoryStoreTool,
} from '../../src/tools/builtin/mem9';
import { Mem9MemoryProvider } from '../../src/tools/providers/mem9-memory';
import { executeTool } from './fixtures/execute-tool';
import { toolContentString } from './fixtures/fake-kaos';

const signal = new AbortController().signal;

describe('Mem9 memory tools', () => {
  it('exposes search and store schemas', () => {
    const provider = providerWithResponse({ memories: [] });
    const search = new Mem9MemorySearchTool(provider);
    const store = new Mem9MemoryStoreTool(provider, 'session-1');

    expect(search.name).toBe('Mem9MemorySearch');
    expect(store.name).toBe('Mem9MemoryStore');
    expect(Mem9MemorySearchInputSchema.safeParse({ query: 'user preferences' }).success).toBe(true);
    expect(Mem9MemoryStoreInputSchema.safeParse({ content: 'User prefers Python' }).success).toBe(
      true,
    );
    expect(search.parameters).toMatchObject({
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    });
  });

  it('searches across sessions and surfaces retry hints', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1alpha2/mem9s/memories');
      expect(url.searchParams.get('q')).toBe('user language preference');
      expect(url.searchParams.get('limit')).toBe('15');
      expect(url.searchParams.has('session_id')).toBe(false);
      return jsonResponse({
        memories: [
          { content: 'User prefers Python', confidence: 1, score: 0.2 },
          { content: 'User also writes TypeScript', confidence: 2, score: 0.1 },
        ],
      });
    });
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemorySearchTool(provider);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c1',
      args: { query: 'user language preference' },
      signal,
    });

    expect(result.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const content = toolContentString(result);
    expect(content).toContain('Session scoped: false');
    expect(content).toContain('User also writes TypeScript');
    expect(content).toContain('User prefers Python');
    expect(content).toContain('Retry hint: All matches have low confidence');
  });

  it('stores memories with the Kimi session id and async hint', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        'X-Mnemo-Agent-Id': 'kimi-code',
        'X-API-Key': 'sk-test',
        'Content-Type': 'application/json',
      });
      expect(parseJsonBody(init)).toMatchObject({
        messages: [{ role: 'user', content: 'User prefers Python' }],
        agent_id: 'kimi-code',
        mode: 'smart',
        session_id: 'session-123',
      });
      return jsonResponse({ status: 'accepted' });
    });
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemoryStoreTool(provider, 'session-123');

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-store',
      args: { content: 'User prefers Python' },
      signal,
    });

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('Status: accepted');
    expect(content).toContain('Source session: session-123');
    expect(content).toContain('not immediately searchable');
  });

  it('parses retrieval_keys input — weight optional, source enum required', () => {
    // Locked wire contract from #mem9-discussion:9dcf4b01 2026-06-05:
    // agent-supplied retrieval keys go in `retrieval_keys`, with
    // `source ∈ {agent, agent_translation}` and optional `weight` in
    // [0.1, 2.0]. Invalid source values and out-of-range weights are
    // caught by the schema before they hit the wire.
    expect(
      Mem9MemoryStoreInputSchema.safeParse({
        content: 'User lives in Chiba',
        retrieval_keys: [
          { text: 'user lives in Chiba', source: 'agent', weight: 1.4 },
          { text: 'ユーザーの自宅 千葉県', source: 'agent_translation' },
        ],
      }).success,
    ).toBe(true);

    expect(
      Mem9MemoryStoreInputSchema.safeParse({
        content: 'x',
        retrieval_keys: [{ text: 'key', source: 'extract' }],
      }).success,
    ).toBe(false);

    expect(
      Mem9MemoryStoreInputSchema.safeParse({
        content: 'x',
        retrieval_keys: [{ text: 'key', source: 'agent', weight: 3.0 }],
      }).success,
    ).toBe(false);

    expect(
      Mem9MemoryStoreInputSchema.safeParse({
        content: 'x',
        retrieval_keys: [{ text: 'key', source: 'agent', weight: 0 }],
      }).success,
    ).toBe(false);
  });

  it('forwards retrieval_keys to mem9 server and surfaces accepted/rejected counts', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = parseJsonBody(init);
      // Wire is snake_case `keys` matching mem9 server's
      // `IngestRequest.Keys []RetrievalKey` per the 2026-06-05 lock.
      expect(body).toMatchObject({
        messages: [{ role: 'user', content: 'User lives in Chiba' }],
        agent_id: 'kimi-code',
        mode: 'smart',
        // `sync: true` is required so mem9's messages-shape returns
        // `keys_inserted` / `keys_rejected`. Async path only logs
        // rejection server-side and the agent self-correction loop
        // breaks. @Kaltsit caught this post-server-fc56bdd.
        sync: true,
        keys: [
          { text: 'user lives in Chiba', source: 'agent', weight: 1.4 },
          { text: 'ユーザーの自宅 千葉県', source: 'agent_translation' },
        ],
      });
      // Server rejects the stop-list-only key, accepts the other.
      return jsonResponse({
        status: 'ok',
        keys_inserted: 1,
        keys_rejected: [{ text: 'user', reason: 'stop_list_single_token' }],
      });
    });
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemoryStoreTool(provider, 'session-x');

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-store-keys',
      args: {
        content: 'User lives in Chiba',
        retrieval_keys: [
          { text: 'user lives in Chiba', source: 'agent', weight: 1.4 },
          { text: 'ユーザーの自宅 千葉県', source: 'agent_translation' },
        ],
      },
      signal,
    });

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('Retrieval keys accepted: 1');
    expect(content).toContain('user (stop_list_single_token)');
    expect(content).toContain('Adjust the rejected keys');
  });

  it('omits the `keys` field when retrieval_keys is absent so server falls back to extract', async () => {
    // Backward-compat path: when the agent doesn't supply
    // `retrieval_keys`, the request body must NOT include `keys: []`,
    // because mem9 server distinguishes "no agent keys → fall back to
    // extractkeys.Extract" from "agent keys empty → server still
    // tries fallback but logs intent". Empty array would be
    // ambiguous; we just omit the field.
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = parseJsonBody(init);
      expect('keys' in body).toBe(false);
      // Legacy no-keys store stays async (no `sync: true`) so it
      // doesn't pay the latency of mem9's sync K-extraction path.
      // Sync is only opted into when there are agent keys whose
      // rejected feedback the agent needs to learn from.
      expect('sync' in body).toBe(false);
      return jsonResponse({ status: 'accepted' });
    });
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemoryStoreTool(provider, 'session-x');

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-store-no-keys',
      args: { content: 'Project ships on Friday' },
      signal,
    });

    expect(result.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the configured agent id for mem9 headers and store body', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        'X-Mnemo-Agent-Id': 'locomo-subject-variant',
        'X-API-Key': 'sk-test',
      });
      expect(parseJsonBody(init)).toMatchObject({
        agent_id: 'locomo-subject-variant',
      });
      return jsonResponse({ status: 'accepted' });
    });
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      agentId: 'locomo-subject-variant',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemoryStoreTool(provider, 'session-123');

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-store',
      args: { content: 'User prefers Python' },
      signal,
    });

    expect(result.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function providerWithResponse(body: unknown): Mem9MemoryProvider {
  return new Mem9MemoryProvider({
    apiKey: 'sk-test',
    fetchImpl: (async () => jsonResponse(body)) as typeof fetch,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new TypeError('expected JSON string request body');
  }
  return JSON.parse(body) as Record<string, unknown>;
}
