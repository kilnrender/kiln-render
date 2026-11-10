/**
 * HubStore - the Zarr store a chunk worker reads through with ?hub=1: every read is
 * forwarded to the main thread's ChunkHub, which fetches each payload once for all workers.
 */

import type { AbsolutePath, AsyncReadable, RangeQuery } from 'zarrita';

/** Worker → main */
export type HubRequest =
  | { type: 'hubGet'; hid: number; key: string; range?: RangeQuery; tag?: string }
  | { type: 'hubCancel'; hid: number };

/** Main → worker */
export interface HubReply {
  type: 'hubData';
  hid: number;
  /** Absent when the store has no such key */
  data?: ArrayBuffer;
  error?: string;
  aborted?: boolean;
}

/** @internal */
export class HubStore implements AsyncReadable<RequestInit> {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: Uint8Array | undefined) => void; reject: (e: unknown) => void; cleanup: () => void }>();

  // Network totals are counted once, by the hub's store on the main thread
  readonly bytesFetched = undefined;
  readonly requestCount = undefined;
  /** Bench only: non-null turns on the worker's core-chunk report; the hub attributes the bytes. */
  bytesByTag: Map<string, number> | null = null;

  constructor(private post: (message: HubRequest) => void) {}

  get(key: AbsolutePath, options?: RequestInit): Promise<Uint8Array | undefined> {
    return this.request(key, undefined, options);
  }

  getRange(key: AbsolutePath, range: RangeQuery, options?: RequestInit): Promise<Uint8Array | undefined> {
    return this.request(key, range, options);
  }

  private request(key: string, range: RangeQuery | undefined, options?: RequestInit): Promise<Uint8Array | undefined> {
    const signal = options?.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const hid = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(hid)) return;
        this.post({ type: 'hubCancel', hid });
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(hid, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      this.post({ type: 'hubGet', hid, key, range, tag: (options as { kilnTag?: string } | undefined)?.kilnTag });
    });
  }

  /** Settle the request a hub reply belongs to. */
  handleReply(reply: HubReply): void {
    const entry = this.pending.get(reply.hid);
    if (!entry) return; // cancelled meanwhile
    this.pending.delete(reply.hid);
    entry.cleanup();
    if (reply.aborted) entry.reject(new DOMException('Aborted', 'AbortError'));
    else if (reply.error !== undefined) entry.reject(new Error(reply.error));
    else entry.resolve(reply.data ? new Uint8Array(reply.data) : undefined);
  }
}
