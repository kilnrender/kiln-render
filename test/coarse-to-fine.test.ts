/**
 * Coarse-to-fine refinement (enableCoarseToFine): the real StreamingManager traversal decides
 * which bricks are desired and in which order they are queued.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { DatasetConfig } from '../src/core/config.js';
import type { DataProvider, VolumeMetadata, NetworkStats } from '../src/data/data-provider.js';
import type { ViewParams } from '../src/core/view.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

// 512³ volume, 4 LOD levels (brick grids 8 → 4 → 2 → 1)
function makeMetadata(): VolumeMetadata {
  return {
    name: 'c2f', dimensions: [512, 512, 512], brickSize: 64, physicalBrickSize: 66,
    maxLod: 3, bitDepth: 8, numChannels: 1,
    levels: [8, 4, 2, 1].map((g, lod) => ({ lod, dimensions: [g * 64, g * 64, g * 64], brickGrid: [g, g, g], brickCount: g ** 3 })) as VolumeMetadata['levels'],
  };
}

function makeProvider(): DataProvider {
  return {
    initialize: vi.fn().mockResolvedValue(makeMetadata()),
    getMetadata: vi.fn().mockReturnValue(makeMetadata()),
    getBrickGrid: vi.fn().mockReturnValue([1, 1, 1] as [number, number, number]),
    loadBrick: vi.fn().mockResolvedValue({ data: new Uint8Array(66 ** 3), min: 0, max: 128, avg: 64 }),
    isBrickEmpty: vi.fn().mockResolvedValue(false),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 } as NetworkStats),
    dispose: vi.fn(),
  };
}

function makeResources() {
  let next = 0;
  return {
    numChannels: 1,
    allocator: {
      allocate: vi.fn(() => ({ slot: { x: 0, y: 0, z: 0 }, slotIndex: next++, evicted: null })),
      setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), hasEvictableSlot: () => true,
      usedCount: 0, totalSlots: 512,
    },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: [{ bitDepth: 8 }],
  };
}

function view(dist: number): ViewParams {
  const width = 800, height = 600, fovY = Math.PI / 4;
  const pos: [number, number, number] = [0, 0, dist];
  return {
    position: new Float32Array(pos),
    view: mat4.lookAt(pos, [0, 0, 0], [0, 1, 0]) as Float32Array,
    proj: mat4.perspective(fovY, width / height, 0.01, 100) as Float32Array,
    fovY, width, height, interacting: false,
  };
}

interface Internals {
  desiredKeys: Set<string>;
  loadQueue: { key: string; lod: number; distance: number }[];
  loadedBricks: Map<string, { slot: { x: number; y: number; z: number }; slotIndex: number }>;
  emptyBricks: Map<string, number>;
}
const internals = (sm: StreamingManager) => sm as unknown as Internals;
const lodOf = (key: string) => Number(/^lod(\d+):/.exec(key)![1]);

async function makeSM(coarseToFine: boolean): Promise<StreamingManager> {
  const sm = new StreamingManager(
    makeResources() as never, makeProvider(), makeMetadata(),
    {} as GPUDevice, new DatasetConfig([512, 512, 512], [1, 1, 1]) as never, vi.fn(),
  );
  if (coarseToFine) sm.enableCoarseToFine();
  await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });
  return sm;
}

/** Whether `key` has a desired brick somewhere below it. */
function hasDesiredDescendant(keys: Set<string>, key: string): boolean {
  const [, lod, z, y, x] = /^lod(\d+):(\d+)\/(\d+)\/(\d+)$/.exec(key)!.map(Number);
  return [...keys].some(k => {
    const [, l, cz, cy, cx] = /^lod(\d+):(\d+)\/(\d+)\/(\d+)$/.exec(k)!.map(Number);
    const s = lod! - l!;
    return s > 0 && cz! >> s === z && cy! >> s === y && cx! >> s === x;
  });
}

beforeEach(() => { vi.clearAllMocks(); });

// Close enough that the base level (lod 3) refines by two levels or more
const NEAR = 0.3;

describe('coarse-to-fine refinement', () => {
  it('is off by default: only the target bricks are desired', async () => {
    const sm = await makeSM(false);
    sm.forceUpdate(view(NEAR));
    const keys = internals(sm).desiredKeys;
    expect(Math.min(...[...keys].map(lodOf))).toBeLessThanOrEqual(1);
    expect([...keys].some(k => hasDesiredDescendant(keys, k))).toBe(false);
  });

  it('also desires every missing brick between the base level and the targets', async () => {
    const plain = await makeSM(false);
    plain.forceUpdate(view(NEAR));
    const targets = new Set(internals(plain).desiredKeys);

    const sm = await makeSM(true);
    sm.forceUpdate(view(NEAR));
    const keys = internals(sm).desiredKeys;
    for (const key of targets) expect(keys.has(key)).toBe(true);
    const stones = [...keys].filter(k => !targets.has(k));
    expect(stones.length).toBeGreaterThan(0);
    for (const key of stones) {
      expect(lodOf(key)).toBeLessThan(3); // never the pinned base level
      expect(hasDesiredDescendant(keys, key)).toBe(true);
    }
  });

  it('queues coarser levels first, nearest first within a level', async () => {
    const sm = await makeSM(true);
    sm.forceUpdate(view(NEAR));
    const queue = internals(sm).loadQueue;
    expect(new Set(queue.map(r => r.lod)).size).toBeGreaterThan(1);
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i - 1]!, b = queue[i]!;
      expect(a.lod > b.lod || (a.lod === b.lod && a.distance <= b.distance)).toBe(true);
    }
  });

  it('drops a stepping stone once everything below it is resident or empty', async () => {
    const sm = await makeSM(true);
    sm.forceUpdate(view(NEAR));
    const priv = internals(sm);
    const targets = [...priv.desiredKeys].filter(k => !hasDesiredDescendant(priv.desiredKeys, k));
    targets.forEach((key, i) => {
      if (i % 2) priv.emptyBricks.set(key, 1);
      else priv.loadedBricks.set(key, { slot: { x: 0, y: 0, z: 0 }, slotIndex: 100 + i });
    });
    sm.forceUpdate(view(NEAR));
    expect([...priv.desiredKeys].some(k => hasDesiredDescendant(priv.desiredKeys, k))).toBe(false);
    expect(priv.loadQueue).toHaveLength(0);
  });

  it('keeps a resident stepping stone desired while bricks below it are missing', async () => {
    const sm = await makeSM(true);
    sm.forceUpdate(view(NEAR));
    const priv = internals(sm);
    const stone = [...priv.desiredKeys].find(k => hasDesiredDescendant(priv.desiredKeys, k))!;
    priv.loadedBricks.set(stone, { slot: { x: 0, y: 0, z: 0 }, slotIndex: 99 });
    sm.forceUpdate(view(NEAR));
    expect(priv.desiredKeys.has(stone)).toBe(true);
    expect(priv.loadQueue.some(r => r.key === stone)).toBe(false);
  });
});
