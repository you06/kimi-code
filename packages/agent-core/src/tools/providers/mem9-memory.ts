/**
 * Mem9MemoryProvider — host-side client for mem9 long-term memory.
 *
 * The provider is intentionally thin over the production mem9 v1 API used by
 * the Dify plugin. Keep server-specific fields opaque so a future mem9 API
 * revision can be contained here.
 */

const DEFAULT_BASE_URL = 'https://api.mem9.ai';
const AGENT_ID = 'kimi-code';
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

export interface Mem9MemoryStoreResult {
  readonly status: string;
  readonly accepted: boolean;
  readonly searchableNow: boolean;
  readonly hint?: string;
}

export interface Mem9MemoryProviderOptions {
  readonly baseUrl?: string;
  readonly apiKey: string;
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
}

export class Mem9MemoryProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly scanAll: boolean;
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Mem9MemoryProviderOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
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
      agent_id: AGENT_ID,
      mode: 'smart',
    };
    if (options.sessionId !== undefined && options.sessionId.length > 0) {
      body['session_id'] = options.sessionId;
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
    };
  }

  private headers(): Record<string, string> {
    return {
      ...this.customHeaders,
      'X-Mnemo-Agent-Id': AGENT_ID,
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
