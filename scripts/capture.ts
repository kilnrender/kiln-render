/**
 * Render a Kiln view to video: a turntable, a camera path, or the progressive load.
 *
 *   bun run capture <shot.json> [--base <url>] [--out <dir>]
 *
 * A shot is a viewer URL (a Share link) plus how the camera moves:
 *
 *   {
 *     "url": "https://kilnrender.com/app/?dataset=…&mode=dvr&cam=…",
 *     "camera": "turntable",   // "static", or keyframes: ["rx,ry,dist,tx,ty,tz", …] (cam= of Share links)
 *     "timing": "converged",   // or "realtime"
 *     "seconds": 10, "fps": 30, "size": [1920, 1080], "samples": 16, "turns": 1
 *   }
 *
 * timing "converged": every frame waits until streaming is idle and `samples` frames have
 * accumulated, so the video is smooth and full quality on any GPU; a slower one only takes longer.
 * timing "realtime": records the first `seconds` after the dataset opens, cold cache, at wall-clock
 * speed: the progressive load as a visitor sees it. Frames are repeated to fill `fps`.
 *
 * The turntable makes `turns` full turns around the URL's camera target and loops seamlessly.
 * Keyframes are passed through on a smooth curve, easing in and out.
 *
 * --base replaces the URL's origin and path and keeps its query, e.g. to render a production
 * Share link against `bun run dev` (http://localhost:3000/kiln-render/app/) or a PR preview.
 *
 * Writes <out>/<name>.mp4, <name>.png (first frame, last for realtime) and <name>.json
 * (dataset, bytes, load milestones). Needs ffmpeg on the PATH. Chromium runs headed like the
 * visual tests (under Xvfb on Linux); KILN_CHROME_ARGS replaces the browser flags.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import type { CaptureStats, KilnCapture, OrbitState } from '../examples/shared/capture.ts';

export type CameraSpec = 'turntable' | 'static' | Array<string | number[]>;

interface Shot {
  url: string;
  camera: CameraSpec;
  timing: 'converged' | 'realtime';
  seconds: number;
  fps: number;
  size: [number, number];
  samples: number;
  turns: number;
}

const DEFAULTS: Omit<Shot, 'url'> = {
  camera: 'turntable',
  timing: 'converged',
  seconds: 10,
  fps: 30,
  size: [1920, 1080],
  samples: 16,
  turns: 1,
};

// ── Camera ───────────────────────────────────────────────────────────────────

function parseCam(key: string | number[], start: OrbitState): OrbitState {
  const n = typeof key === 'string' ? decodeURIComponent(key).split(',').map(Number) : key;
  if ((n.length !== 3 && n.length !== 6) || n.some(v => !Number.isFinite(v))) {
    throw new Error(`Bad camera key ${JSON.stringify(key)}: expected rx,ry,dist[,tx,ty,tz]`);
  }
  // Without a target, keep the URL camera's
  return (n.length === 6 ? n : [...n, start[3], start[4], start[5]]) as OrbitState;
}

const catmullRom = (p0: number, p1: number, p2: number, p3: number, f: number) =>
  0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f);

/** Camera at t in [0, 1]. `start` is the URL's camera; the turntable makes `turns` turns around it. */
export function cameraAt(spec: CameraSpec, start: OrbitState, t: number, turns = 1): OrbitState {
  if (spec === 'static') return start;
  if (spec === 'turntable') {
    const [rx, ry, dist, tx, ty, tz] = start;
    return [rx, ry + 2 * Math.PI * turns * t, dist, tx, ty, tz];
  }
  if (spec.length === 0) throw new Error('Camera path needs at least one key');
  // Angles take the short way between keys; distance moves on a log scale so zooms feel even
  const keys = spec.map(k => parseCam(k, start));
  for (let i = 1; i < keys.length; i++) {
    for (const a of [0, 1]) {
      const prev = keys[i - 1]![a]!;
      keys[i]![a] = prev + Math.atan2(Math.sin(keys[i]![a]! - prev), Math.cos(keys[i]![a]! - prev));
    }
  }
  for (const k of keys) k[2] = Math.log(k[2]);
  const u = Math.min(Math.max(t, 0), 1);
  const s = u * u * (3 - 2 * u) * (keys.length - 1);
  const i = Math.min(Math.floor(s), Math.max(keys.length - 2, 0));
  const at = (j: number) => keys[Math.min(Math.max(j, 0), keys.length - 1)]!;
  const out = at(i).map((_, c) => catmullRom(at(i - 1)[c]!, at(i)[c]!, at(i + 1)[c]!, at(i + 2)[c]!, s - i)) as OrbitState;
  out[2] = Math.exp(out[2]);
  return out;
}

// ── Recording ────────────────────────────────────────────────────────────────

type CaptureWindow = { __kilnCapture: KilnCapture };

function encoder(file: string, fps: number) {
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  return {
    write: (png: Buffer) => new Promise<void>(r => (ffmpeg.stdin.write(png) ? r() : ffmpeg.stdin.once('drain', () => r()))),
    end: () => { ffmpeg.stdin.end(); return done; },
  };
}

async function grab(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => (window as unknown as CaptureWindow).__kilnCapture.frame());
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

const setCamera = (page: Page, cam: OrbitState) =>
  page.evaluate(c => (window as unknown as CaptureWindow).__kilnCapture.setCamera(c), cam);

function progress(done: number, total: number): void {
  process.stdout.write(`\r  frame ${done}/${total}`);
  if (done === total) process.stdout.write('\n');
}

/** Every frame settled: smooth, full quality, independent of the GPU's speed. Returns the poster. */
async function recordConverged(page: Page, shot: Shot, start: OrbitState, write: (png: Buffer) => Promise<void>): Promise<Buffer> {
  const n = Math.max(1, Math.round(shot.seconds * shot.fps));
  // The turntable loops: its last frame is one step before the first
  const span = shot.camera === 'turntable' ? n : Math.max(n - 1, 1);
  let poster: Buffer | undefined;
  for (let i = 0; i < n; i++) {
    await setCamera(page, cameraAt(shot.camera, start, i / span, shot.turns));
    // The first frame waits for the dataset to open and load
    const settled = await page.evaluate(({ samples, timeout }) =>
      (window as unknown as CaptureWindow).__kilnCapture.settle(samples, timeout), { samples: shot.samples, timeout: i === 0 ? 300_000 : 60_000 });
    if (!settled) console.warn(`\n  frame ${i}: still loading after the timeout, recorded anyway`);
    const png = await grab(page);
    poster ??= png;
    await write(png);
    progress(i + 1, n);
  }
  return poster!;
}

/** The first `seconds` at wall-clock speed, each frame repeated until the next one. Returns the poster. */
async function recordRealtime(page: Page, shot: Shot, start: OrbitState, write: (png: Buffer) => Promise<void>): Promise<Buffer> {
  const n = Math.max(1, Math.round(shot.seconds * shot.fps));
  const t0 = performance.now();
  let slot = 0;
  let last: Buffer | undefined;
  while (slot < n) {
    const at = (performance.now() - t0) / 1000;
    await setCamera(page, cameraAt(shot.camera, start, Math.min(at / shot.seconds, 1), shot.turns));
    const png = await grab(page);
    // Slots before this frame show the one before it (the first frame fills its own)
    last ??= png;
    for (; slot < n && slot / shot.fps < at; slot++) await write(last);
    last = png;
    progress(slot, n);
  }
  return last!;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { shotPath: string; base?: string; out: string } {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    argv.splice(i, 2);
    return value;
  };
  const base = flag('--base');
  const out = flag('--out') ?? 'captures';
  const shotPath = argv[0];
  if (!shotPath) throw new Error('Usage: bun run capture <shot.json> [--base <url>] [--out <dir>]');
  return { shotPath, base, out };
}

async function main(): Promise<void> {
  const { shotPath, base, out } = parseArgs(process.argv.slice(2));
  const shot: Shot = { ...DEFAULTS, ...JSON.parse(await readFile(shotPath, 'utf8')) };
  const [width, height] = shot.size;
  if (width % 2 || height % 2) throw new Error('size must be even (H.264 4:2:0)');
  if (spawnSync('ffmpeg', ['-version']).error) throw new Error('ffmpeg not found on the PATH');

  const url = new URL(shot.url);
  if (base) {
    const b = new URL(base);
    url.protocol = b.protocol;
    url.host = b.host;
    url.pathname = b.pathname;
  }
  url.searchParams.set('capture', '1');

  const name = basename(shotPath, '.json');
  await mkdir(out, { recursive: true });

  const { chromium } = await import('@playwright/test');
  const linux = process.platform === 'linux';
  const args = process.env.KILN_CHROME_ARGS?.split(' ')
    ?? ['--enable-unsafe-webgpu', ...(linux ? ['--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-angle=vulkan'] : [])];
  // Headed: headless Chromium can't present WebGPU canvases on Linux
  const browser = await chromium.launch({ headless: false, args });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', e => console.error(`[page] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') console.error(`[page] ${m.text()}`); });
    await page.goto(url.href);
    await page.waitForFunction(() => (window as unknown as Partial<CaptureWindow>).__kilnCapture, null, { timeout: 120_000 });
    const { start, adapter } = await page.evaluate(() => {
      const c = (window as unknown as CaptureWindow).__kilnCapture;
      return { start: c.start, adapter: c.adapter };
    });
    console.log(`${name}: ${shot.timing}, ${shot.seconds} s at ${shot.fps} fps, ${width}×${height} on ${adapter || 'unknown adapter'}`);

    const video = encoder(join(out, `${name}.mp4`), shot.fps);
    const record = shot.timing === 'realtime' ? recordRealtime : recordConverged;
    const poster = await record(page, shot, start, video.write);
    await video.end();
    await writeFile(join(out, `${name}.png`), poster);

    const stats: CaptureStats = await page.evaluate(() => (window as unknown as CaptureWindow).__kilnCapture.stats());
    await writeFile(join(out, `${name}.json`), JSON.stringify({ name, adapter, ...shot, ...stats }, null, 2) + '\n');
    console.log(`  wrote ${join(out, name)}.{mp4,png,json}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
