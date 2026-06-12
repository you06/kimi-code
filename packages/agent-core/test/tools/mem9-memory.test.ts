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

  it('instructs the agent to normalize relative time references when an anchor is available', () => {
    // Tool description ("memory-store.md") is what reaches the model, so the
    // normalization rule has to be in the rendered description string, not
    // only in a separate runtime helper. Conditional wording ("when the
    // surrounding context gives you a reliable anchor") is intentional —
    // ordinary chat without a session date should NOT trigger date
    // fabrication. Locked in #mem9-discussion:9dcf4b01 (2026-06-06).
    const provider = providerWithResponse({ memories: [] });
    const store = new Mem9MemoryStoreTool(provider, 'session-1');

    expect(store.description).toContain('Temporal normalization');
    expect(store.description).toMatch(/last week|yesterday|Friday/);
    expect(store.description).toContain('25 August 2023');
    expect(store.description).toMatch(/anchor|reliable/);
    // The original relative phrase must NOT be retained alongside the
    // absolute date — not even parenthesized. A stored "('last Tues')"
    // is anchored to a dead "now": it false-matches future
    // relative-phrased queries and baits the answering model into
    // recomputing against the wrong present. Reversed from the first
    // version of this rule per @tmgg06, #mem9-discussion:037b518a
    // (2026-06-11).
    expect(store.description).toMatch(/Store ONLY the resolved absolute form/);
    expect(store.description).toMatch(/not even in parentheses/i);
    expect(store.description).toMatch(/preserve.*original|original.*preserve|invent|precision/i);
    expect(store.description).toMatch(/every Friday|weekly|periodic/i);

    const contentDescription = (
      store.parameters as { properties: { content: { description: string } } }
    ).properties.content.description;
    expect(contentDescription).toMatch(/last week|yesterday|Friday/);
    expect(contentDescription).toMatch(/anchor|reliable/);
    expect(contentDescription).toMatch(/invent|precision/);
  });

  it('instructs the agent to preserve specifics verbatim and stay traceable', () => {
    // Store-quality rules from the LoCoMo conv-26 trace + DB review
    // (#mem9-discussion:037b518a, 2026-06-11). Two write-side failure
    // modes that no recall-side tuning can repair:
    //  - generalization loss: "a cup she made" stored as "made pottery"
    //    drops the very word a future question asks about (q48);
    //  - write-side hallucination: details that were never said get
    //    baked into a memory (the "religious conservatives" case).
    // Both rules are deliberately production-generic; the LoCoMo
    // store_hack prompt must NOT duplicate them (single source).
    const provider = providerWithResponse({ memories: [] });
    const store = new Mem9MemoryStoreTool(provider, 'session-1');

    expect(store.description).toContain('# Specificity');
    expect(store.description).toMatch(/verbatim/);
    expect(store.description).toMatch(/do not generalize/i);
    expect(store.description).toContain('cup');

    expect(store.description).toContain('# Traceability');
    expect(store.description).toMatch(/never add details/i);
    expect(store.description).toMatch(/leave the detail out/i);
  });

  it('teaches frame retention and strict attribution (R12 store-fidelity buckets)', () => {
    // R12 error bucketing put store fidelity at 47% of all judged
    // misses, concentrated in three write-side shapes no recall-side
    // work can repair (#mem9-discussion:b3075037, 2026-06-12):
    //  - context-link loss: "self-care is important" stored without
    //    "after the charity race" answers a different question;
    //  - detail loss: the cup's dog-face decoration dropped;
    //  - attribution distortion: a relative/artwork/pet attributed to
    //    the wrong person (one such distortion scored zero on two
    //    questions at once), or scope words ("other children")
    //    excluding people the speaker included.
    // Examples in the description are deliberately genericized — same
    // structure as the observed failures, different surface.
    const provider = providerWithResponse({ memories: [] });
    const store = new Mem9MemoryStoreTool(provider, 'session-1');

    expect(store.description).toMatch(/connecting frame/i);
    expect(store.description).toMatch(/occasion, cause, or purpose/i);
    expect(store.description).toMatch(/answers a different question/i);

    expect(store.description).toContain('# Attribution');
    expect(store.description).toMatch(/speaker is not automatically the subject/i);
    expect(store.description).toMatch(/fabricates a biography/i);
    expect(store.description).toMatch(/scope words/i);
    expect(store.description).toMatch(/dog face/);
  });

  it('teaches category keys so agent-keyed stores stay aggregate-searchable', () => {
    // Server-side category-key generation (mem9 8e9c4dc) only runs in
    // the extractkeys fallback path; ~97% of LoCoMo stores carry
    // agent-provided retrieval_keys and skip it entirely
    // (#mem9-discussion:037b518a). The agent guidance must therefore
    // teach category keys itself — including the subject name, which
    // both anchors the key and satisfies the server's token-overlap
    // validation.
    const provider = providerWithResponse({ memories: [] });
    const store = new Mem9MemoryStoreTool(provider, 'session-1');

    expect(store.description).toMatch(/CATEGORY keys/);
    expect(store.description).toContain('Melanie activities');
    expect(store.description).toMatch(/subject'?s name/i);
    expect(store.description).toMatch(/skip category keys for one-off facts/i);

    const keysDescription = (
      store.parameters as {
        properties: { retrieval_keys: { description: string } };
      }
    ).properties.retrieval_keys.description;
    expect(keysDescription).toMatch(/category keys/i);
    expect(keysDescription).toContain('Melanie activities');
  });

  it('searches across sessions without flagging low scores as low confidence', async () => {
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
    expect(content).toContain('Showing top 2 of 2 candidates');
    expect(content).toContain('User also writes TypeScript');
    expect(content).toContain('User prefers Python');
    // RRF scores are ordering signals, not confidences: the old
    // `maxScore < 0.3` "All matches have low confidence" hint fired on
    // essentially every normal K=>V search (non-fast-path RRF ceiling
    // is ~0.066) and trained the agent to distrust good results.
    // Results present → no retry hint, regardless of score magnitude.
    expect(content).not.toContain('low confidence');
    expect(content).not.toContain('Retry hint');
  });

  it('does not render storage age on search results', async () => {
    // The server's relative_age is derived from the row's updated_at —
    // STORAGE age, not fact time. Rendering it ("Age: 13 hours ago")
    // planted a now-anchored relative time on every result: a fact
    // about 2023 ingested yesterday read as recent, misleading
    // temporal reasoning. Fact time lives in the content's normalized
    // absolute dates (#mem9-discussion:037b518a, 2026-06-12).
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        memories: [
          {
            content: 'User went hiking around 18 August 2023.',
            score: 0.05,
            relative_age: '13 hours ago',
          },
        ],
      }),
    );
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemorySearchTool(provider);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-age',
      args: { query: 'user hiking' },
      signal,
    });

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('User went hiking around 18 August 2023.');
    expect(content).not.toContain('Age:');
    expect(content).not.toContain('13 hours ago');
  });

  it('keeps the retry hint for the zero-results case only', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ memories: [] }));
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemorySearchTool(provider);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-zero',
      args: { query: 'nothing stored about this' },
      signal,
    });

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('No memories found.');
    expect(content).toContain('Retry hint: No memories matched');
  });

  it('tells the agent when the candidate pool exceeds the shown page', async () => {
    // The server-side pool is ~3x the requested limit (provider asks
    // for limit*3 and slices to limit for display). The old header
    // ("Available results: 15") misled the agent into believing it had
    // seen all 15 — LoCoMo conv-26 traces showed it never re-searched
    // with a higher limit even when every shown result was
    // low-confidence (#mem9-discussion:037b518a). The header must make
    // the shown-vs-pool split explicit.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        memories: Array.from({ length: 7 }, (_, i) => ({
          content: `memory number ${i + 1}`,
          confidence: 7 - i,
          score: (7 - i) / 10,
        })),
      }),
    );
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemorySearchTool(provider);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-pool',
      args: { query: 'user memories' },
      signal,
    });

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('Showing top 5 of 7 candidates');
    expect(content).not.toContain('Available results');
    // Description must teach the two retry levers the trace review
    // found missing: vary entity/object words (not just verbs), and
    // raise `limit` when unseen candidates remain.
    expect(tool.description).toMatch(/ENTITY or OBJECT words/);
    expect(tool.description).toMatch(/higher `limit`/);
    expect(tool.description).toContain('Showing top N of M candidates');
    // Facet collection: multi-item questions fail by stopping at the
    // first satisfying result — memories for different facets of one
    // topic rank differently per query, so one search rarely surfaces
    // all items. The recurring shape across LoCoMo trace reviews
    // (q15/q37/q95/q116: answers listing 1-2 of 4+ remembered items)
    // (#mem9-discussion:037b518a, 2026-06-12).
    expect(tool.description).toMatch(/asks for multiple items/i);
    expect(tool.description).toMatch(/facet variants TOGETHER in one call/);
    expect(tool.description).toMatch(/cannot stop halfway/i);
    expect(tool.description).toMatch(/combine every distinct item/i);
  });

  it('accepts overlong variant lists and trims at execution instead of erroring', async () => {
    // Forgiving cap: R11 traces showed 13 batch calls rejected by a
    // hard schema max(4) when the model passed extra variants. The
    // schema now accepts up to 10; execution runs the first 5
    // effective queries and tells the model what was dropped
    // (#mem9-discussion:037b518a, 2026-06-12).
    const ok = Mem9MemorySearchInputSchema.safeParse({
      query: 'Melanie activities',
      queries: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(ok.success).toBe(true);

    const fetchImpl = vi.fn(async () => jsonResponse({ memories: [] }));
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemorySearchTool(provider);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-trim',
      args: {
        query: 'Melanie activities',
        queries: ['Melanie crafts', 'Melanie sports', 'Melanie trips', 'Melanie music', 'Melanie food'],
      },
      signal,
    });

    expect(result.isError).toBe(false);
    // Empty multi-q response is provenance-ambiguous → 1 repeated-q
    // attempt + 5 single-query fallback calls; the 6th variant is
    // dropped before either path.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    const content = toolContentString(result);
    expect(content).toContain('#5: Melanie music');
    expect(content).not.toContain('Melanie food');
    expect(content).toContain('Note: 1 extra variant(s)');
  });

  it('teaches that variants must differ in domain, not wording', () => {
    // R11 q15 failure shape: the model batched 4 SYNONYM variants
    // ("does"/"partakes in"/"hobbies"/"enjoys") which all retrieved
    // the same generic cluster — none of the four gold items surfaced.
    // Orthogonal facets, not paraphrases (#mem9-discussion:037b518a).
    const provider = providerWithResponse({ memories: [] });
    const search = new Mem9MemorySearchTool(provider);
    const queriesDescription = (
      search.parameters as { properties: { queries: { description: string } } }
    ).properties.queries.description;
    expect(queriesDescription).toMatch(/differ in DOMAIN or OBJECT, not wording/);
    expect(queriesDescription).toMatch(/synonyms of the same phrase/i);
    expect(queriesDescription).toMatch(/waste the batch/i);
  });

  it('sends one repeated-q request and renders server-merged provenance', async () => {
    // Preferred wire (mem9 d2595dc+): ONE request carries every facet
    // variant as a repeated `q` param; the server deep-pools each
    // query, quota-merges round-robin, caps the window, and tags
    // matched_queries. Client preserves server order — the quota
    // merge IS the ordering (#mem9-discussion:037b518a, 2026-06-12).
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.getAll('q')).toEqual(['Melanie pottery', 'Melanie swimming']);
      // Raw limit, not limit*3: the server manages multi-query depth.
      expect(url.searchParams.get('limit')).toBe('5');
      return jsonResponse({
        memories: [
          { id: 'm-3', content: 'Melanie went swimming with her kids.', score: 0.062, matched_queries: [1] },
          { id: 'm-1', content: 'Melanie made a plate in pottery class.', score: 0.06, matched_queries: [0] },
          { id: 'm-2', content: 'Melanie enjoys arts and crafts.', score: 0.058, matched_queries: [0, 1] },
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
      toolCallId: 'c-batch',
      args: { query: 'Melanie pottery', queries: ['Melanie swimming'] },
      signal,
    });

    expect(result.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const content = toolContentString(result);
    expect(content).toContain('#1: Melanie pottery');
    expect(content).toContain('#2: Melanie swimming');
    expect(content).toContain('3 unique memories across 2 queries');
    // Server-merged wire exposes no per-query pools.
    expect(content).not.toContain('candidate pools total');
    expect(content).toContain('Found by: #1, #2');
    // Server order preserved: swimming (quota round-robin head) first.
    expect(content.indexOf('swimming')).toBeLessThan(content.indexOf('plate in pottery'));
  });

  it('falls back to client-side fan-out when the server lacks repeated-q support', async () => {
    // An old server silently reads only the FIRST repeated q — a
    // facet batch would degrade to a single search. New servers
    // always tag matched_queries on multi-query responses, so its
    // absence routes to the legacy parallel fan-out and every variant
    // still runs.
    const calls: string[][] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url.searchParams.getAll('q'));
      const q = url.searchParams.getAll('q')[0] ?? '';
      if (q === 'Melanie pottery') {
        return jsonResponse({
          memories: [
            { id: 'm-1', content: 'Melanie made a plate in pottery class.', score: 0.06 },
            { id: 'm-2', content: 'Melanie enjoys arts and crafts.', score: 0.05 },
          ],
        });
      }
      return jsonResponse({
        memories: [
          { id: 'm-3', content: 'Melanie went swimming with her kids.', score: 0.062 },
          { id: 'm-2', content: 'Melanie enjoys arts and crafts.', score: 0.058 },
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
      toolCallId: 'c-fallback',
      args: { query: 'Melanie pottery', queries: ['Melanie swimming'] },
      signal,
    });

    expect(result.isError).toBe(false);
    // 1 repeated-q attempt + 2 single-query fallback calls.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(calls[0]).toEqual(['Melanie pottery', 'Melanie swimming']);
    const content = toolContentString(result);
    expect(content).toContain('3 unique memories across 2 queries');
    // Client-side merge: m-2 deduped, found by both, best score kept.
    expect(content.match(/arts and crafts/g)).toHaveLength(1);
    expect(content).toContain('Found by: #1, #2');
    expect(content).toContain('Score: 0.058');
  });

  it('keeps the single-query output shape when no variants are given', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ memories: [{ content: 'User prefers Python', score: 0.06 }] }),
    );
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemorySearchTool(provider);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-single',
      args: { query: 'user language' },
      signal,
    });

    expect(result.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const content = toolContentString(result);
    expect(content).toContain('Showing top 1 of 1 candidates');
    expect(content).not.toContain('unique memories across');
    expect(content).not.toContain('Found by:');
  });

  it('collapses duplicate variant queries and falls back to content-key dedup', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        // No ids: dedup must fall back to trimmed content.
        memories: [{ content: 'Melanie enjoys camping.', score: 0.05 }],
      }),
    );
    const provider = new Mem9MemoryProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const tool = new Mem9MemorySearchTool(provider);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-dupes',
      args: { query: 'Melanie camping', queries: ['Melanie camping', 'Melanie outdoors'] },
      signal,
    });

    expect(result.isError).toBe(false);
    // Duplicate variant collapsed to 2 distinct queries; the
    // no-provenance response routes to fallback: 1 repeated-q attempt
    // + 2 single-query calls.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const content = toolContentString(result);
    expect(content).toContain('1 unique memories across 2 queries');
    expect(content.match(/enjoys camping/g)).toHaveLength(1);
    expect(content).toContain('Found by: #1, #2');
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
