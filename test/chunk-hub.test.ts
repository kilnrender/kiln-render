import { describe, it, expect, vi } from 'vitest';
import type { AbsolutePath } from 'zarrita';
import { ChunkHub, hubRequestKey } from '../src/data/chunk-hub.js';
import type { HubSource } from '../src/data/chunk-hub.js';
import { HubStore } from '../src/data/hub-store.js';
import type { HubRequest } from '../src/data/hub-store.js';

const KEY = '/0/c/1/2/3' as AbsolutePath;

/** A source whose reads stay pending until settled by hand. */
function manualSource() {
  const calls: { key: string; signal: AbortSignal; resolve: (v: Uint8Array | undefined) => void }[] = [];
  const read = (key: string, options?: RequestInit) => new Promise<Uint8Array | undefined>((resolve, reject) => {
    const signal = options!.signal!;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    calls.push({ key, signal, resolve });
  });
  const source: HubSource = { get: vi.fn(read), getRange: vi.fn((key, _range, options) => read(key, options)) };
  return { source, calls };
}

describe('ChunkHub', () => {
  it('fetches a chunk once for concurrent requests', async () => {
    const { source, calls } = manualSource();
    const hub = new ChunkHub(source);
    const a = hub.fetch(KEY);
    const b = hub.fetch(KEY);
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(new Uint8Array([1, 2, 3]));
    expect(await a).toEqual(new Uint8Array([1, 2, 3]));
    expect(await b).toBe(await a);
    expect(hub.shared).toBe(1);
  });

  it('answers a later request from its cache', async () => {
    const { source, calls } = manualSource();
    const hub = new ChunkHub(source);
    const first = hub.fetch(KEY);
    calls[0]!.resolve(new Uint8Array(8));
    await first;
    expect(await hub.fetch(KEY)).toBe(await first);
    expect(calls).toHaveLength(1);
  });

  it('keeps ranges of one key apart', async () => {
    const { source, calls } = manualSource();
    const hub = new ChunkHub(source);
    void hub.fetch(KEY, { offset: 0, length: 10 });
    void hub.fetch(KEY, { offset: 10, length: 10 });
    void hub.fetch(KEY, { suffixLength: 10 });
    void hub.fetch(KEY, { offset: 0, length: 10 });
    expect(calls).toHaveLength(3);
    expect(hubRequestKey(KEY, { suffixLength: 10 })).not.toBe(hubRequestKey(KEY, { offset: 10, length: 0 }));
  });

  it('keeps a shared fetch alive until every requester has cancelled', async () => {
    const { source, calls } = manualSource();
    const hub = new ChunkHub(source);
    const first = new AbortController();
    const second = new AbortController();
    const a = hub.fetch(KEY, undefined, first.signal);
    const b = hub.fetch(KEY, undefined, second.signal);
    a.catch(() => {});
    first.abort();
    expect(calls[0]!.signal.aborted).toBe(false);
    calls[0]!.resolve(new Uint8Array(4));
    expect(await b).toHaveLength(4);
    await expect(a).resolves.toBeDefined(); // the shared fetch had already been joined

    const c = hub.fetch('/other' as AbsolutePath, undefined, second.signal);
    second.abort();
    await expect(c).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[1]!.signal.aborted).toBe(true);
  });

  it('does not cache missing chunks or payloads above the budget, and evicts the oldest', async () => {
    const { source, calls } = manualSource();
    const hub = new ChunkHub(source, 10);
    const settle = async (key: string, value: Uint8Array | undefined) => {
      const p = hub.fetch(key as AbsolutePath);
      calls.at(-1)!.resolve(value);
      await p;
    };
    await settle('/missing', undefined);
    await settle('/big', new Uint8Array(11));
    await settle('/a', new Uint8Array(6));
    await settle('/b', new Uint8Array(6)); // evicts /a
    const before = calls.length;
    void hub.fetch('/b' as AbsolutePath);
    expect(calls).toHaveLength(before);
    for (const key of ['/missing', '/big', '/a']) void hub.fetch(key as AbsolutePath);
    expect(calls).toHaveLength(before + 3);
  });
});

describe('HubStore', () => {
  it('forwards reads and resolves them from the replies', async () => {
    const posted: HubRequest[] = [];
    const store = new HubStore(m => posted.push(m));
    const chunk = store.get(KEY, { kilnTag: 't' } as RequestInit);
    const range = store.getRange(KEY, { offset: 4, length: 2 });
    const missing = store.get('/none' as AbsolutePath);
    expect(posted).toEqual([
      { type: 'hubGet', hid: 0, key: KEY, range: undefined, tag: 't' },
      { type: 'hubGet', hid: 1, key: KEY, range: { offset: 4, length: 2 }, tag: undefined },
      { type: 'hubGet', hid: 2, key: '/none', range: undefined, tag: undefined },
    ]);
    store.handleReply({ type: 'hubData', hid: 1, data: new Uint8Array([7, 8]).buffer });
    store.handleReply({ type: 'hubData', hid: 0, data: new Uint8Array([1]).buffer });
    store.handleReply({ type: 'hubData', hid: 2 });
    expect(await chunk).toEqual(new Uint8Array([1]));
    expect(await range).toEqual(new Uint8Array([7, 8]));
    expect(await missing).toBeUndefined();
  });

  it('rejects on errors and aborted replies', async () => {
    const store = new HubStore(() => {});
    const failed = store.get(KEY);
    const aborted = store.get(KEY);
    store.handleReply({ type: 'hubData', hid: 0, error: 'HTTP 500' });
    store.handleReply({ type: 'hubData', hid: 1, aborted: true });
    await expect(failed).rejects.toThrow('HTTP 500');
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels at the hub when the caller aborts, and ignores the late reply', async () => {
    const posted: HubRequest[] = [];
    const store = new HubStore(m => posted.push(m));
    const controller = new AbortController();
    const read = store.get(KEY, { signal: controller.signal });
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted.at(-1)).toEqual({ type: 'hubCancel', hid: 0 });
    store.handleReply({ type: 'hubData', hid: 0, data: new ArrayBuffer(1) });
    await expect(store.get(KEY, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
