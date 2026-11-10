/**
 * ChunkHub - one place on the main thread where the worker pool's chunk bytes are
 * fetched (?hub=1). Every worker keeps its own decoded-chunk cache, so a chunk that
 * bricks on different workers share (a ghost-border neighbour, a chunk larger than a
 * brick) used to be downloaded once per worker. The hub coalesces concurrent requests
 * for the same bytes onto one fetch and keeps recent payloads for the workers that
 * ask a moment later.
 */

import type { AbsolutePath, RangeQuery } from 'zarrita';
import { SharedFetchRegistry } from './shared-fetch.js';

/** The part of a Zarr store the hub reads through (TolerantFetchStore). */
export interface HubSource {
  get(key: AbsolutePath, options?: RequestInit): Promise<Uint8Array | undefined>;
  getRange(key: AbsolutePath, range: RangeQuery, options?: RequestInit): Promise<Uint8Array | undefined>;
}

/** Compressed payloads kept for late duplicates; the decoded chunks live in the workers. */
const DEFAULT_CACHE_BYTES = 96 * 1024 * 1024;

export function hubRequestKey(key: string, range?: RangeQuery): string {
  if (!range) return key;
  return 'suffixLength' in range ? `${key}|-${range.suffixLength}` : `${key}|${range.offset}+${range.length}`;
}

export class ChunkHub {
  private inflight = new SharedFetchRegistry<Uint8Array | undefined>();
  private cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  /** Requests answered without a fetch of their own (shared in-flight fetch or cached payload). */
  shared = 0;
  requests = 0;

  constructor(private source: HubSource, private maxCacheBytes = DEFAULT_CACHE_BYTES) {}

  /** The bytes of `key` (or of `range` within it); undefined when the store has none. The
   *  returned array is shared between callers: copy it before transferring it away. */
  fetch(key: AbsolutePath, range?: RangeQuery, signal?: AbortSignal, tag?: string): Promise<Uint8Array | undefined> {
    this.requests++;
    const id = hubRequestKey(key, range);
    const cached = this.cache.get(id);
    if (cached) {
      // refresh recency
      this.cache.delete(id);
      this.cache.set(id, cached);
      this.shared++;
      return Promise.resolve(cached);
    }
    let started = false;
    const result = this.inflight.run(id, async (fetchSignal) => {
      started = true;
      const options = { signal: fetchSignal, kilnTag: tag } as RequestInit;
      const bytes = range ? await this.source.getRange(key, range, options) : await this.source.get(key, options);
      if (bytes) this.remember(id, bytes);
      return bytes;
    }, signal);
    if (!started) this.shared++;
    return result;
  }

  private remember(id: string, bytes: Uint8Array): void {
    if (bytes.byteLength > this.maxCacheBytes) return;
    while (this.cacheBytes + bytes.byteLength > this.maxCacheBytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(oldest)!.byteLength;
      this.cache.delete(oldest);
    }
    this.cache.set(id, bytes);
    this.cacheBytes += bytes.byteLength;
  }
}
