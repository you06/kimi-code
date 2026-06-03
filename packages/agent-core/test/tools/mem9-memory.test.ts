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
      expect(JSON.parse(String(init?.body))).toMatchObject({
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

  it('uses the configured agent id for mem9 headers and store body', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        'X-Mnemo-Agent-Id': 'locomo-subject-variant',
        'X-API-Key': 'sk-test',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
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
