import type { UrlFetcher, WebSearchProvider } from '../builtin';
import type { Mem9MemoryProvider } from '../providers/mem9-memory';

export interface ToolServices {
  readonly urlFetcher?: UrlFetcher;
  readonly webSearcher?: WebSearchProvider;
  readonly mem9Memory?: Mem9MemoryProvider;
}
