/**
 * Mem9MemoryProvider — host-side client for mem9 long-term memory.
 *
 * The provider is intentionally thin over the production mem9 v1 API used by
 * the Dify plugin. Keep server-specific fields opaque so a future mem9 API
 * revision can be contained here.
 */

export const DEFAULT_MEM9_BASE_URL = 'https://api.mem9.ai';
export const DEFAULT_MEM9_AGENT_ID = 'kimi-code';
// Kept as locals so existing references in this file stay terse;
// outside callers should import the exported constants.
const DEFAULT_BASE_URL = DEFAULT_MEM9_BASE_URL;
const DEFAULT_AGENT_ID = DEFAULT_MEM9_AGENT_ID;
const SEARCH_TIMEOUT_MS = 30_000;
const STORE_TIMEOUT_MS = 120_000;

export interface Mem9MemoryResult {
  readonly content: string;
  readonly confidence?: number | string;
  readonly score?: number | string;
  readonly memoryType?: string;
  readonly relativeAge?: string;
}

export interface Mem9MemorySearchResult {
  readonly effectiveQuery: string;
  readonly memories: readonly Mem9MemoryResult[];
  readonly availableResultCount: number;
  readonly retryHint?: string;
}

// Agent-provided retrieval key, mirroring the locked wire shape from
// #mem9-discussion:9dcf4b01 2026-06-05. The agent generates these
// short query-shaped phrases at Mem9MemoryStore time; mem9 server
// validates and persists them to memory_keys, skipping its server-side
// extractkeys LLM call. When the array is empty/absent, mem9 falls
// back to server-side extraction.
export interface Mem9RetrievalKey {
  // Short query-shaped phrase (≤ 8 words). Must include a predicate
  // fragment (e.g. "user works at", "team deploys on") OR a named
  // entity (e.g. "Acme Robotics", "千葉").
  readonly text: string;
  // `agent` for same-language K; `agent_translation` for cross-language
  // expansion (e.g. Japanese surface form of a Chinese entity).
  readonly source: 'agent' | 'agent_translation';
  // Recall-time ranking weight in [0.1, 2.0]. Default 1.0 if omitted.
  readonly weight?: number;
}

// Rejected key feedback from mem9 server's validation pass. Only the
// sync ingest path returns this; the async accepted path only logs
// rejections server-side and returns `undefined` here. Surface to the
// agent so a retry can avoid the same mistake.
export interface Mem9RejectedKey {
  readonly text: string;
  readonly reason: string;
}

export interface Mem9MemoryStoreResult {
  readonly status: string;
  readonly accepted: boolean;
  readonly searchableNow: boolean;
  readonly hint?: string;
  // Sync-path-only: counts of K's mem9 accepted / rejected during
  // validation. Undefined on async-accepted responses.
  readonly keysInserted?: number;
  readonly keysRejected?: readonly Mem9RejectedKey[];
}

export interface Mem9MemoryProviderOptions {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly agentId?: string;
  readonly scanAll?: boolean;
  readonly customHeaders?: Record<string, string>;
  readonly fetchImpl?: typeof fetch;
}

interface SearchOptions {
  readonly query: string;
  readonly limit: number;
  readonly scanAll?: boolean;
  readonly signal?: AbortSignal;
}

interface StoreOptions {
  readonly content: string;
  readonly sessionId?: string;
  // Optional agent-generated retrieval keys. When present, mem9 server
  // validates and persists these instead of running its own
  // `extractkeys.Extract` LLM call on the content. Empty array is
  // equivalent to omitted (server falls back to extraction).
  readonly retrievalKeys?: readonly Mem9RetrievalKey[];
  readonly signal?: AbortSignal;
}

interface RawSearchMemory {
  readonly content?: unknown;
  readonly confidence?: unknown;
  readonly score?: unknown;
  readonly memory_type?: unknown;
  readonly relative_age?: unknown;
}

interface RawSearchResponse {
  readonly memories?: unknown;
}

interface RawStoreResponse {
  readonly status?: unknown;
  readonly keys_inserted?: unknown;
  readonly keys_rejected?: unknown;
}

interface RawRejectedKey {
  readonly text?: unknown;
  readonly reason?: unknown;
}

export class Mem9MemoryProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly scanAll: boolean;
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Mem9MemoryProviderOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.agentId = normalizeAgentId(options.agentId) ?? DEFAULT_AGENT_ID;
    this.scanAll = options.scanAll ?? false;
    this.customHeaders = options.customHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(options: SearchOptions): Promise<Mem9MemorySearchResult> {
    const upstreamLimit = Math.min(Math.max(options.limit * 3, options.limit), 100);
    const url = new URL(`${this.baseUrl}/v1alpha2/mem9s/memories`);
    url.searchParams.set('q', options.query);
    url.searchParams.set('limit', String(upstreamLimit));
    if (options.scanAll ?? this.scanAll) {
      url.searchParams.set('scanAll', 'true');
    }

    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: this.headers(),
      },
      SEARCH_TIMEOUT_MS,
      options.signal,
    );
    await assertOk(response, 'mem9 search');

    const data = (await response.json()) as RawSearchResponse;
    const raw = Array.isArray(data.memories) ? data.memories : [];
    const sorted = raw
      .map(normalizeMemory)
      .filter((memory): memory is Mem9MemoryResult => memory !== undefined)
      .toSorted((left, right) => {
        const confidenceDelta = numericValue(right.confidence) - numericValue(left.confidence);
        if (confidenceDelta !== 0) return confidenceDelta;
        return numericValue(right.score) - numericValue(left.score);
      });
    const memories = sorted.slice(0, options.limit);
    const maxScore = memories.reduce<number | undefined>((current, memory) => {
      const score = numericValue(memory.score);
      if (score < 0) return current;
      return current === undefined || score > current ? score : current;
    }, undefined);

    return {
      effectiveQuery: options.query,
      memories,
      availableResultCount: raw.length,
      retryHint: retryHint(memories.length, maxScore),
    };
  }

  async store(options: StoreOptions): Promise<Mem9MemoryStoreResult> {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: options.content }],
      agent_id: this.agentId,
      mode: 'smart',
    };
    if (options.sessionId !== undefined && options.sessionId.length > 0) {
      body['session_id'] = options.sessionId;
    }
    // Forward agent-generated keys when present. Wire is snake_case
    // to match mem9 server's `IngestRequest.Keys []RetrievalKey`
    // (locked 2026-06-05). Server validates / rejects / inserts;
    // missing or empty array → server falls back to its own
    // `extractkeys.Extract` LLM call.
    //
    // We also flip the request to `sync: true` whenever agent keys
    // are present. mem9 server's messages-shape async path only logs
    // `keys_rejected` — it doesn't return them. To close the agent
    // self-correction loop (so a follow-up store can drop the
    // rejected keys), we need the sync response shape that carries
    // `keys_inserted` / `keys_rejected`. @Kaltsit caught this gap
    // post-server-fc56bdd: the server response infrastructure is
    // ready, but the client wasn't opted into sync, so feedback
    // never reached the agent in practice.
    if (options.retrievalKeys !== undefined && options.retrievalKeys.length > 0) {
      body['keys'] = options.retrievalKeys.map((key) => {
        const wire: Record<string, unknown> = {
          text: key.text,
          source: key.source,
        };
        if (key.weight !== undefined) wire['weight'] = key.weight;
        return wire;
      });
      body['sync'] = true;
    }

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/v1alpha2/mem9s/memories`,
      {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      STORE_TIMEOUT_MS,
      options.signal,
    );
    await assertOk(response, 'mem9 store');

    const data = (await response.json()) as RawStoreResponse;
    const status = typeof data.status === 'string' && data.status.length > 0 ? data.status : 'accepted';
    const isAsync = status !== 'ok';
    return {
      status,
      accepted: true,
      searchableNow: !isAsync,
      hint: isAsync
        ? 'Stored asynchronously. Smart extraction is in progress and this memory is not immediately searchable. Do not call Mem9MemorySearch for this content in the next turn.'
        : undefined,
      keysInserted: parseKeysInserted(data.keys_inserted),
      keysRejected: parseKeysRejected(data.keys_rejected),
    };
  }

  private headers(): Record<string, string> {
    return {
      ...this.customHeaders,
      'X-Mnemo-Agent-Id': this.agentId,
      'X-API-Key': this.apiKey,
    };
  }

  private async fetchWithTimeout(
    input: string | URL,
    init: RequestInit,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => {
      controller.abort(signal?.reason);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new Error(`mem9 request timed out after ${String(timeoutMs)}ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (response.status < 400) return;
  const detail = await safeReadText(response);
  throw new Error(`${action} request failed: HTTP ${String(response.status)}. ${detail}`.trim());
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function normalizeAgentId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  if (/[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeMemory(raw: unknown): Mem9MemoryResult | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as RawSearchMemory;
  const content = typeof item.content === 'string' ? item.content.trim() : '';
  if (content.length === 0) return undefined;
  const memoryType =
    typeof item.memory_type === 'string' && item.memory_type.length > 0
      ? item.memory_type
      : undefined;
  const relativeAge =
    typeof item.relative_age === 'string' && item.relative_age.length > 0
      ? item.relative_age
      : undefined;
  return {
    content,
    confidence: numberOrString(item.confidence),
    score: numberOrString(item.score),
    memoryType,
    relativeAge,
  };
}

function numberOrString(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function numericValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : -1;
  }
  return -1;
}

function parseKeysInserted(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function parseKeysRejected(value: unknown): readonly Mem9RejectedKey[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Mem9RejectedKey[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as RawRejectedKey;
    const text = typeof raw.text === 'string' ? raw.text : '';
    // Skip entries without a `text` field — the agent can't act on
    // "something was rejected" without knowing which key, so they
    // don't belong on the agent-visible rejection list. (Lightchaser
    // nit on PR #5.)
    if (text.length === 0) continue;
    const reason = typeof raw.reason === 'string' ? raw.reason : '';
    out.push({ text, reason });
  }
  return out;
}

function retryHint(resultCount: number, maxScore: number | undefined): string | undefined {
  if (resultCount === 0) {
    return (
      'No memories matched. Possible fixes: (1) rephrase as a short declarative ' +
      'statement instead of a question; (2) try broader or different keywords.'
    );
  }
  if (maxScore !== undefined && maxScore < 0.3) {
    return (
      'All matches have low confidence. The query may not align with how facts ' +
      'were stored. Consider rephrasing as a declarative statement or using more specific keywords.'
    );
  }
  return undefined;
}
