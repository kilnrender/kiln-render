/**
 * Lazy ghost borders (enableLazyBorders): refined bricks load from their core chunks first and
 * get their real border once no brick is missing. Runs the real StreamingManager against a
 * provider that reports a replicated border for every core-only load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { DatasetConfig } from '../src/core/config.js';
import { writeToCanvas } from '../src/core/volume.js';
import { sameChunkRange, computeBrickChunkFootprint, computeBrickCoreChunkRange, clampedLutEntry } from '../src/data/chunk-math.js';
import type { DataProvider, VolumeMetadata, NetworkStats, BrickLoadOptions } from '../src/data/data-provider.js';
import type { ViewParams } from '../src/core/view.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

// 256³ volume, 3 LOD levels (brick grids 4 → 2 → 1)
function makeMetadata(): VolumeMetadata {
  return {
    name: 'lazy', dimensions: [256, 256, 256], brickSize: 64, physicalBrickSize: 66,
    maxLod: 2, bitDepth: 8, numChannels: 1,
    levels: [4, 2, 1].map((g, lod) => ({ lod, dimensions: [g * 64, g * 64, g * 64], brickGrid: [g, g, g], brickCount: g ** 3 })) as VolumeMetadata['levels'],
  };
}

const PARTIAL = new Uint8Array(66 ** 3).fill(1);
const FULL = new Uint8Array(66 ** 3).fill(2);

function makeProvider() {
  const loadBrick = vi.fn(async (_lod: number, _bx: number, _by: number, _bz: number, _ch?: number, _signal?: AbortSignal, options?: BrickLoadOptions) =>
    options?.coreOnly
      ? { data: PARTIAL, min: 0, max: 128, avg: 64, partialBorder: true }
      : { data: FULL, min: 0, max: 128, avg: 64 });
  const provider: DataProvider = {
    initialize: vi.fn().mockResolvedValue(makeMetadata()),
    getMetadata: vi.fn().mockReturnValue(makeMetadata()),
    getBrickGrid: vi.fn().mockReturnValue([1, 1, 1] as [number, number, number]),
    loadBrick,
    isBrickEmpty: vi.fn().mockResolvedValue(false),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 } as NetworkStats),
    dispose: vi.fn(),
  };
  return { provider, loadBrick };
}

function makeResources() {
  let next = 0;
  return {
    numChannels: 1,
    allocator: {
      allocate: vi.fn(() => { const i = next++; return { slot: { x: i, y: 0, z: 0 }, slotIndex: i, evicted: null }; }),
      setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), hasEvictableSlot: () => true,
      usedCount: 0, totalSlots: 512,
    },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: [{ bitDepth: 8, format: 'r8unorm' }],
  };
}

// Inside the volume: everything in view refines below the base level
const NEAR: [number, number, number] = [0, 0, 0.3];
function view(): ViewParams {
  const width = 800, height = 600, fovY = Math.PI / 4;
  return {
    position: new Float32Array(NEAR),
    view: mat4.lookAt(NEAR, [0, 0, 0], [0, 1, 0]) as Float32Array,
    proj: mat4.perspective(fovY, width / height, 0.01, 100) as Float32Array,
    fovY, width, height, interacting: false,
  };
}

interface Internals {
  loadQueue: unknown[];
  borderQueue: { key: string }[];
  partialBorders: Set<string>;
  inFlightRequests: Map<string, AbortController>;
  loadedBricks: Map<string, { slotIndex: number }>;
  brickCache: { get(key: string): Uint8Array | undefined };
  releaseEvicted(result: { slot: object; slotIndex: number; evicted: { key: string; lod: number; bx: number; by: number; bz: number } | null }): void;
}
const internals = (sm: StreamingManager) => sm as unknown as Internals;

async function makeSM(lazy: boolean) {
  const { provider, loadBrick } = makeProvider();
  const sm = new StreamingManager(
    makeResources() as never, provider, makeMetadata(),
    {} as GPUDevice, new DatasetConfig([256, 256, 256], [1, 1, 1]) as never, vi.fn(),
  );
  if (lazy) sm.enableLazyBorders();
  await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });
  return { sm, loadBrick };
}

/** Update until nothing is queued or in flight. */
async function settle(sm: StreamingManager): Promise<void> {
  const priv = internals(sm);
  await vi.waitFor(() => {
    sm.forceUpdate(view());
    sm.update(view());
    expect(priv.loadQueue.length + priv.borderQueue.length + priv.inFlightRequests.size).toBe(0);
  });
}

const coreOnlyCalls = (loadBrick: ReturnType<typeof makeProvider>['loadBrick']) =>
  loadBrick.mock.calls.filter(c => c[6]?.coreOnly);
const uploads = () => vi.mocked(writeToCanvas).mock.calls.map(c => c[2]);

beforeEach(() => { vi.clearAllMocks(); });

describe('lazy ghost borders', () => {
  it('is off by default: every brick loads in full once', async () => {
    const { sm, loadBrick } = await makeSM(false);
    await settle(sm);
    expect(loadBrick.mock.calls.length).toBeGreaterThan(1);
    expect(coreOnlyCalls(loadBrick)).toHaveLength(0);
    expect(sm.getStats().partialBorderCount).toBe(0);
  });

  it('loads the base level in full', async () => {
    const { loadBrick } = await makeSM(true);
    expect(loadBrick.mock.calls).toHaveLength(1);
    expect(loadBrick.mock.calls[0]![6]).toBeUndefined();
  });

  it('shows core-only bricks first and completes their borders once none is missing', async () => {
    const { sm, loadBrick } = await makeSM(true);
    const priv = internals(sm);
    sm.forceUpdate(view());
    sm.update(view());
    await vi.waitFor(() => { expect(priv.partialBorders.size).toBeGreaterThan(0); });
    // While bricks are still missing, no border is completed
    const firstFull = loadBrick.mock.calls.findIndex((c, i) => i > 0 && !c[6]?.coreOnly);
    const refined = coreOnlyCalls(loadBrick).length;
    expect(firstFull === -1 || priv.loadQueue.length === 0).toBe(true);
    expect(refined).toBeGreaterThan(0);

    await settle(sm);
    const bricks = priv.loadedBricks.size - 1; // without the base brick
    expect(coreOnlyCalls(loadBrick)).toHaveLength(bricks);
    expect(loadBrick.mock.calls.filter(c => !c[6]?.coreOnly)).toHaveLength(bricks + 1);
    expect(priv.partialBorders.size).toBe(0);
    expect(sm.getStats().partialBorderCount).toBe(0);
    // Each refined brick was uploaded twice: replicated border, then the real one
    expect(uploads().filter(d => d === PARTIAL)).toHaveLength(bricks);
    expect(uploads().filter(d => d === FULL)).toHaveLength(bricks + 1);
  });

  it('caches a brick only once its border is real', async () => {
    const { sm } = await makeSM(true);
    const priv = internals(sm);
    sm.forceUpdate(view());
    sm.update(view());
    await vi.waitFor(() => { expect(priv.partialBorders.size).toBeGreaterThan(0); });
    for (const key of priv.partialBorders) expect(priv.brickCache.get(`c0@0:${key}`)).toBeUndefined();
    const keys = [...priv.partialBorders];
    await settle(sm);
    for (const key of keys) expect(priv.brickCache.get(`c0@0:${key}`)).toBe(FULL);
  });

  it('forgets an evicted brick and ignores a completion that arrives for it', async () => {
    const { sm, loadBrick } = await makeSM(true);
    const priv = internals(sm);
    sm.forceUpdate(view());
    sm.update(view());
    await vi.waitFor(() => { expect(priv.partialBorders.size).toBeGreaterThan(0); });
    const key = [...priv.partialBorders][0]!;
    const entry = priv.loadedBricks.get(key)!;
    const [, lod, bz, by, bx] = /^lod(\d+):(\d+)\/(\d+)\/(\d+)$/.exec(key)!.map(Number);
    priv.releaseEvicted({ slot: {}, slotIndex: entry.slotIndex, evicted: { key, lod: lod!, bx: bx!, by: by!, bz: bz! } });
    expect(priv.partialBorders.has(key)).toBe(false);
    expect(priv.loadedBricks.has(key)).toBe(false);
    await settle(sm);
    // Loaded again from scratch: core first, then its border
    expect(loadBrick.mock.calls.filter(c => c[0] === lod && c[1] === bx && c[2] === by && c[3] === bz && c[6]?.coreOnly)).toHaveLength(2);
    expect(priv.partialBorders.size).toBe(0);
  });
});

describe('core-only assembly geometry', () => {
  const params = { scaleX: 1, scaleY: 1, scaleZ: 1, actualDimX: 256, actualDimY: 256, actualDimZ: 256, csx: 64, csy: 64, csz: 64 };

  it('needs 1 chunk instead of 27 when chunks match the brick grid', () => {
    const footprint = computeBrickChunkFootprint(params, 1, 1, 1, 64, 66);
    const core = computeBrickCoreChunkRange(params, 1, 1, 1, 64);
    expect(sameChunkRange(core, footprint)).toBe(false);
    expect([core.minCx, core.maxCx, core.minCy, core.maxCy, core.minCz, core.maxCz]).toEqual([1, 1, 1, 1, 1, 1]);
    expect([footprint.minCx, footprint.maxCx]).toEqual([0, 2]);
  });

  it('has nothing to leave out when one chunk holds the whole footprint', () => {
    const big = { ...params, csx: 256, csy: 256, csz: 256 };
    expect(sameChunkRange(computeBrickCoreChunkRange(big, 1, 1, 1, 64), computeBrickChunkFootprint(big, 1, 1, 1, 64, 66))).toBe(true);
  });

  it('repeats the nearest core voxel for border voxels outside the core chunks', () => {
    // Brick 1 along x: virtual voxels 63..128, core chunk 1 holds 64..127
    const lut = (v: number) => clampedLutEntry(v, 1, 256, 64, 1, 1);
    expect(lut(63)).toEqual({ chunkIdx: 0, offset: 0 });   // left border → voxel 64
    expect(lut(64)).toEqual({ chunkIdx: 0, offset: 0 });
    expect(lut(127)).toEqual({ chunkIdx: 0, offset: 63 });
    expect(lut(128)).toEqual({ chunkIdx: 0, offset: 63 }); // right border → voxel 127
  });
});
