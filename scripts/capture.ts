/**
 * Render a Kiln view to video: a turntable, a camera path, timed setting changes, captions.
 *
 *   bun run capture <shot.json> [--base <url>] [--out <dir>]
 *
 * A shot is a viewer URL (a Share link) plus what happens over time:
 *
 *   {
 *     "url": "https://kilnrender.com/app/?dataset=…&mode=dvr&cam=…",
 *     "camera": "turntable",   // "static", or keyframes: ["rx,ry,dist,tx,ty,tz", …] (cam= of Share links)
 *     "timing": "converged",   // "streaming" or "realtime"
 *     "seconds": 10, "fps": 30, "size": [1920, 1080], "samples": 16, "turns": 1, "wait": 2,
 *     "actions": [
 *       { "at": 2, "until": 5, "cam": "0.3,4.8,0.7" },   // move the camera there
 *       { "at": 6, "set": { "mode": "lod" } },           // switch at 6 s
 *       { "at": 7, "until": 10, "set": { "sliceZ": 1 } } // tween from the value at 7 s
 *     ],
 *     "captions": [{ "from": 0, "to": 3, "text": "16 GB in a browser tab" }],
 *     "stats": true             // dataset size and bytes streamed, top right
 *   }
 *
 * timing "converged": every frame waits until streaming is idle and `samples` frames have
 * accumulated: smooth, full quality on any GPU; a slower one only takes longer.
 * timing "streaming": starts once the coarsest level is in and grabs every frame after `wait`
 * animation frames, loaded or not: smooth motion with bricks refining, a bit slower than real time.
 * timing "realtime": the first `seconds` after the dataset opens, cold cache, at wall-clock speed;
 * frames are repeated to fill `fps`.
 *
 * The turntable makes `turns` full turns around the URL's camera target and loops seamlessly.
 * Keyframes are passed through on a smooth curve, easing in and out.
 *
 * Actions take effect at `at` seconds; with `until` they ease from the current value instead of
 * jumping. `cam` takes over from the camera above. `set` takes viewer state names: mode,
 * windowCenter, windowWidth, densityScale, shading, gradientOpacity, isoValue, sliceX/Y/Z (0–1),
 * clipMin, clipMax ([x, y, z], 0–1), showWireframe, showAxis, timepoint, and channel0–3 (a
 * channel's weight; 0 hides it).
 *
 * --base replaces the URL's origin and path up to /app/ and keeps the rest, e.g. to render a
 * production Share link against `bun run dev` (http://localhost:3000/kiln-render/app/) or a PR
 * preview (https://kilnrender.com/preview/<branch>/app/).
 *
 * Writes <out>/<name>.mp4, <name>.png (first frame; last for streaming and realtime) and
 * <name>.json (dataset, bytes, load milestones). Needs ffmpeg on the PATH. Chromium runs headed
 * like the visual tests (under Xvfb on Linux); KILN_CHROME_ARGS replaces the browser flags.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import type { CaptureStats, KilnCapture, OrbitState, Overlay, Settings } from '../examples/shared/capture.ts';

export type CameraSpec = 'turntable' | 'static' | Array<string | number[]>;

export interface Action {
  at: number;
  until?: number;
  cam?: string | number[];
  set?: Settings;
}

export interface Shot {
  url: string;
  camera: CameraSpec;
  timing: 'converged' | 'streaming' | 'realtime';
  seconds: number;
  fps: number;
  size: [number, number];
  samples: number;
  turns: number;
  wait: number;
  actions: Action[];
  captions: Array<{ from: number; to: number; text: string }>;
  stats: boolean;
}

export const DEFAULTS: Omit<Shot, 'url'> = {
  camera: 'turntable',
  timing: 'converged',
  seconds: 10,
  fps: 30,
  size: [1920, 1080],
  samples: 16,
  turns: 1,
  wait: 2,
  actions: [],
  captions: [],
  stats: false,
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

const ease = (t: number) => {
  const u = Math.min(Math.max(t, 0), 1);
  return u * u * (3 - 2 * u);
};

/** Shortest signed angle from a to b */
const turn = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

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
    for (const a of [0, 1]) keys[i]![a] = keys[i - 1]![a]! + turn(keys[i - 1]![a]!, keys[i]![a]!);
  }
  for (const k of keys) k[2] = Math.log(k[2]);
  const s = ease(t) * (keys.length - 1);
  const i = Math.min(Math.floor(s), Math.max(keys.length - 2, 0));
  const at = (j: number) => keys[Math.min(Math.max(j, 0), keys.length - 1)]!;
  const out = at(i).map((_, c) => catmullRom(at(i - 1)[c]!, at(i)[c]!, at(i + 1)[c]!, at(i + 2)[c]!, s - i)) as OrbitState;
  out[2] = Math.exp(out[2]);
  return out;
}

/** Orbit state a fraction f of the way from a to b, the same way the keyframe path moves */
function lerpOrbit(a: OrbitState, b: OrbitState, f: number): OrbitState {
  return [
    a[0] + turn(a[0], b[0]) * f,
    a[1] + turn(a[1], b[1]) * f,
    Math.exp(Math.log(a[2]) + (Math.log(b[2]) - Math.log(a[2])) * f),
    a[3] + (b[3] - a[3]) * f,
    a[4] + (b[4] - a[4]) * f,
    a[5] + (b[5] - a[5]) * f,
  ];
}

// ── Timeline ─────────────────────────────────────────────────────────────────

function mix(a: Settings[string], b: Settings[string], f: number): Settings[string] {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * f;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => v + (b[i]! - v) * f);
  return b;
}

/**
 * Camera and settings at `t` seconds; `u` is the camera's progress (0–1). `initial` holds the
 * page's settings; actions apply in time order, each from the state the ones before left.
 */
export function stateAt(shot: Shot, start: OrbitState, initial: Settings, t: number, u: number): { cam: OrbitState; settings: Settings } {
  let cam = cameraAt(shot.camera, start, u, shot.turns);
  const settings = { ...initial };
  for (const action of [...shot.actions].sort((a, b) => a.at - b.at)) {
    if (t < action.at) break;
    const f = action.until !== undefined && action.until > action.at ? ease((t - action.at) / (action.until - action.at)) : 1;
    if (action.cam !== undefined) cam = lerpOrbit(cam, parseCam(action.cam, start), f);
    for (const [key, target] of Object.entries(action.set ?? {})) {
      if (!(key in settings)) {
        throw new Error(`Unknown setting "${key}" at ${action.at} s. This dataset has: ${Object.keys(initial).join(', ')}`);
      }
      settings[key] = mix(settings[key]!, target, f);
    }
  }
  return { cam, settings };
}

const FADE_S = 0.3;

/** Captions showing at `t` seconds, fading in and out */
export function overlayAt(shot: Shot, t: number): Overlay {
  return {
    captions: shot.captions
      .filter(c => t >= c.from && t < c.to)
      .map(c => ({ text: c.text, alpha: Math.min(1, (t - c.from) / FADE_S, (c.to - t) / FADE_S) })),
    stats: shot.stats,
  };
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
    ffmpeg.on('close', (code: number | null) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  return {
    write: (png: Buffer) => new Promise<void>(r => (ffmpeg.stdin.write(png) ? r() : ffmpeg.stdin.once('drain', () => r()))),
    end: () => { ffmpeg.stdin.end(); return done; },
  };
}

async function grab(page: Page, overlay: Overlay): Promise<Buffer> {
  const url = await page.evaluate(o => (window as unknown as CaptureWindow).__kilnCapture.frame(o), overlay);
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

/** Move the camera and send the settings that changed since the last frame (each change restarts accumulation) */
async function step(page: Page, state: { cam: OrbitState; settings: Settings }, sent: Settings): Promise<void> {
  const changes: Settings = {};
  for (const [key, value] of Object.entries(state.settings)) {
    if (JSON.stringify(value) !== JSON.stringify(sent[key])) changes[key] = sent[key] = value;
  }
  await page.evaluate(({ cam, changes }) => {
    const c = (window as unknown as CaptureWindow).__kilnCapture;
    c.setCamera(cam);
    c.apply(changes);
  }, { cam: state.cam, changes });
}

function progress(done: number, total: number): void {
  process.stdout.write(`\r  frame ${done}/${total}`);
  if (done === total) process.stdout.write('\n');
}

/** converged and streaming: one step of 1/fps per frame. Returns the poster. */
async function recordStepped(page: Page, shot: Shot, start: OrbitState, initial: Settings, write: (png: Buffer) => Promise<void>): Promise<Buffer> {
  const n = Math.max(1, Math.round(shot.seconds * shot.fps));
  // The turntable loops: its last frame is one step before the first
  const span = shot.camera === 'turntable' ? n : Math.max(n - 1, 1);
  const sent = { ...initial };
  const streaming = shot.timing === 'streaming';
  if (streaming && !(await page.evaluate(() => (window as unknown as CaptureWindow).__kilnCapture.baseLoaded(120_000)))) {
    console.warn('  coarsest level still loading after 120 s, starting anyway');
  }
  let first: Buffer | undefined;
  let last: Buffer | undefined;
  for (let i = 0; i < n; i++) {
    const t = i / shot.fps;
    await step(page, stateAt(shot, start, initial, t, i / span), sent);
    if (streaming) {
      await page.evaluate(frames => (window as unknown as CaptureWindow).__kilnCapture.wait(frames), shot.wait);
    } else {
      // The first frame waits for the dataset to open and load
      const settled = await page.evaluate(({ samples, timeout }) =>
        (window as unknown as CaptureWindow).__kilnCapture.settle(samples, timeout), { samples: shot.samples, timeout: i === 0 ? 300_000 : 60_000 });
      if (!settled) console.warn(`\n  frame ${i}: still loading after the timeout, recorded anyway`);
    }
    last = await grab(page, overlayAt(shot, t));
    first ??= last;
    await write(last);
    progress(i + 1, n);
  }
  return streaming ? last! : first!;
}

/** realtime: the first `seconds` at wall-clock speed, each frame repeated until the next one. Returns the poster. */
async function recordRealtime(page: Page, shot: Shot, start: OrbitState, initial: Settings, write: (png: Buffer) => Promise<void>): Promise<Buffer> {
  const n = Math.max(1, Math.round(shot.seconds * shot.fps));
  const sent = { ...initial };
  const t0 = performance.now();
  let slot = 0;
  let last: Buffer | undefined;
  while (slot < n) {
    const at = (performance.now() - t0) / 1000;
    await step(page, stateAt(shot, start, initial, at, Math.min(at / shot.seconds, 1)), sent);
    const png = await grab(page, overlayAt(shot, at));
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
  if (!['converged', 'streaming', 'realtime'].includes(shot.timing)) throw new Error(`Unknown timing "${shot.timing}"`);
  if (spawnSync('ffmpeg', ['-version']).error) throw new Error('ffmpeg not found on the PATH');

  const url = new URL(shot.url);
  if (base) {
    const b = new URL(base);
    url.protocol = b.protocol;
    url.host = b.host;
    // Keep what follows /app/, e.g. multichannel/
    const rest = url.pathname.split('/app/')[1] ?? '';
    url.pathname = b.pathname.replace(/\/?$/, '/') + rest;
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
    const { start, adapter, initial } = await page.evaluate(() => {
      const c = (window as unknown as CaptureWindow).__kilnCapture;
      return { start: c.start, adapter: c.adapter, initial: c.settings() };
    });
    // Unknown settings fail now rather than mid-recording
    stateAt(shot, start, initial, Infinity, 1);
    console.log(`${name}: ${shot.timing}, ${shot.seconds} s at ${shot.fps} fps, ${width}×${height} on ${adapter || 'unknown adapter'}`);

    const video = encoder(join(out, `${name}.mp4`), shot.fps);
    const record = shot.timing === 'realtime' ? recordRealtime : recordStepped;
    const poster = await record(page, shot, start, initial, video.write);
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
