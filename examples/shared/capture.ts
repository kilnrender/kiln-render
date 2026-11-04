/**
 * Video capture hook (in-page). Activates only on `?capture=1`: renders at full
 * scale and exposes `window.__kilnCapture`, which scripts/capture.ts uses to move
 * the camera, change settings, wait for each frame and pull it as a PNG with
 * captions and a stats line drawn on top.
 */

import type { KilnViewer, LoadMilestones, VolumeRenderMode } from 'kiln-render';

export type OrbitState = [number, number, number, number, number, number];

/** Viewer settings a shot can change: ViewerState names, plus `channel<N>` for a channel's weight (0 hides it) */
export type Settings = Record<string, number | number[] | string | boolean>;

export interface Overlay {
  captions: Array<{ text: string; alpha: number }>;
  /** Dataset size, bytes streamed so far, kilnrender.com */
  stats: boolean;
}

export interface CaptureStats {
  dataset: string;
  dimensions: [number, number, number];
  bitDepth: number;
  requests: number;
  bytesDownloaded: number;
  bricksCommitted: number;
  /** ms since navigation start, see LoadMilestones */
  milestones: LoadMilestones;
}

export interface KilnCapture {
  /** Camera orbit state the page opened with (?cam=) */
  start: OrbitState;
  /** WebGPU adapter, so a software fallback shows */
  adapter: string;
  /** Current values of every setting a shot can change */
  settings(): Settings;
  setCamera(state: OrbitState): void;
  apply(settings: Settings): void;
  /**
   * Wait until streaming is idle and `samples` frames have accumulated since the last
   * brick commit (or the image converged). False if that took longer than `timeoutMs`.
   */
  settle(samples: number, timeoutMs: number): Promise<boolean>;
  /** Wait `frames` animation frames, loaded or not */
  wait(frames: number): Promise<void>;
  /** Wait until the coarsest level is in: the first full, blurry image */
  baseLoaded(timeoutMs: number): Promise<boolean>;
  /** The current view as a PNG data URL, with the overlay drawn on top */
  frame(overlay?: Overlay): Promise<string>;
  stats(): CaptureStats;
}

const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

async function settle(v: KilnViewer, samples: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  let quiet = 0;
  let committed = -1;
  while (performance.now() < deadline) {
    await nextFrame();
    const s = v.streamingManager.getStats();
    const idle = s.pendingCount === 0 && v.streamingManager.baseLodLoaded;
    // A commit restarts accumulation, so count frames since the last one
    quiet = idle && s.bricksCommitted === committed ? quiet + 1 : 0;
    committed = s.bricksCommitted;
    if (idle && (quiet >= samples || v.renderer.isConverged)) return true;
  }
  return false;
}

function settings(v: KilnViewer): Settings {
  const s = v.getState();
  const out: Settings = {
    mode: s.mode,
    windowCenter: s.windowCenter,
    windowWidth: s.windowWidth,
    densityScale: s.densityScale,
    shading: s.shading,
    gradientOpacity: s.gradientOpacity,
    isoValue: s.isoValue,
    sliceX: s.sliceX,
    sliceY: s.sliceY,
    sliceZ: s.sliceZ,
    clipMin: s.clipMin,
    clipMax: s.clipMax,
    showWireframe: s.showWireframe,
    showAxis: s.showAxis,
    timepoint: s.timepoint ?? 0,
  };
  for (let c = 0; c < v.renderer.numChannels; c++) out[`channel${c}`] = v.renderer.channelColors[c * 4 + 3]!;
  return out;
}

function apply(v: KilnViewer, changes: Settings): void {
  const r = v.renderer;
  for (const [key, value] of Object.entries(changes)) {
    const channel = /^channel(\d)$/.exec(key);
    if (channel) {
      const c = Number(channel[1]);
      const cc = r.channelColors;
      r.setChannelColor(c, cc[c * 4]!, cc[c * 4 + 1]!, cc[c * 4 + 2]!, value as number);
      continue;
    }
    switch (key) {
      case 'mode': v.mode = value as VolumeRenderMode; break;
      case 'windowCenter': v.windowCenter = value as number; break;
      case 'windowWidth': v.windowWidth = value as number; break;
      case 'isoValue': v.isoValue = value as number; break;
      case 'densityScale':
      case 'shading':
      case 'gradientOpacity':
        r[key] = value as number;
        r.resetAccumulation();
        break;
      case 'sliceX':
      case 'sliceY':
      case 'sliceZ':
        r[key] = value as number;
        r.markDirty();
        break;
      case 'clipMin':
      case 'clipMax':
        r[key].set(value as number[]);
        r.resetAccumulation();
        break;
      case 'showWireframe':
      case 'showAxis':
        r[key] = value as boolean;
        r.markDirty();
        break;
      case 'timepoint': {
        const timepoint = Math.round(value as number);
        if (timepoint !== (v.metadata.timepoint ?? 0)) {
          v.setSourceSelection({ sourceChannels: [...(v.metadata.sourceChannels ?? [0])], timepoint });
        }
        break;
      }
      default:
        throw new Error(`Unknown setting "${key}"`);
    }
  }
}

function formatBytes(bytes: number): string {
  // Binary units, as the gallery quotes dataset sizes
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function statsLine(v: KilnViewer): string {
  const [x, y, z] = v.metadata.dimensions;
  const dims = x === y && y === z ? `${x}³` : `${x} × ${y} × ${z}`;
  const channels = v.renderer.numChannels;
  const size = x * y * z * (v.metadata.bitDepth / 8) * channels;
  const streamed = v.streamingManager.getStats().totalBytesDownloaded;
  return [dims, ...(channels > 1 ? [`${channels} channels`] : []), formatBytes(size), `${formatBytes(streamed)} streamed`, 'kilnrender.com'].join('  ·  ');
}

/** Text on a translucent dark box; (x, y) is the box's bottom-left, or bottom-right when `right` */
function label(g: OffscreenCanvasRenderingContext2D, text: string, x: number, y: number, size: number, alpha: number, right = false): number {
  g.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const pad = size * 0.45;
  const w = g.measureText(text).width + 2 * pad;
  const h = size + 2 * pad;
  const left = right ? x - w : x;
  g.globalAlpha = alpha;
  g.fillStyle = 'rgba(0, 0, 0, 0.55)';
  g.beginPath();
  g.roundRect(left, y - h, w, h, size * 0.3);
  g.fill();
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(text, left + pad, y - h / 2);
  g.globalAlpha = 1;
  return h;
}

async function composite(png: Blob, overlay: Overlay, v: KilnViewer): Promise<Blob> {
  const image = await createImageBitmap(png);
  const canvas = new OffscreenCanvas(image.width, image.height);
  const g = canvas.getContext('2d')!;
  g.drawImage(image, 0, 0);
  // Sizes are for 1080 lines and scale with the frame
  const u = image.height / 1080;
  const margin = 56 * u;
  if (overlay.stats) label(g, statsLine(v), image.width - margin, margin + 40 * u, 24 * u, 1, true);
  let y = image.height - margin;
  for (const caption of [...overlay.captions].reverse()) {
    y -= label(g, caption.text, margin, y, 44 * u, caption.alpha) + 16 * u;
  }
  return canvas.convertToBlob({ type: 'image/png' });
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Install `window.__kilnCapture` if `?capture=1`. Call once, right after the viewer is created. */
export function maybeInstallCapture(viewer: KilnViewer): void {
  if (new URLSearchParams(window.location.search).get('capture') !== '1') return;
  viewer.renderScale = 1;
  const info = viewer.device.adapterInfo;
  const capture: KilnCapture = {
    start: viewer.camera.getOrbitState(),
    adapter: [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' '),
    settings: () => settings(viewer),
    setCamera: (state) => viewer.camera.setOrbitState(state),
    apply: (changes) => apply(viewer, changes),
    settle: (samples, timeoutMs) => settle(viewer, samples, timeoutMs),
    wait: async (frames) => { for (let i = 0; i < frames; i++) await nextFrame(); },
    baseLoaded: async (timeoutMs) => {
      const deadline = performance.now() + timeoutMs;
      while (!viewer.streamingManager.baseLodLoaded) {
        if (performance.now() > deadline) return false;
        await nextFrame();
      }
      return true;
    },
    frame: async (overlay) => {
      let png = await viewer.captureImage('image/png');
      if (overlay && (overlay.stats || overlay.captions.length > 0)) png = await composite(png, overlay, viewer);
      return dataUrl(png);
    },
    stats: () => {
      const s = viewer.streamingManager.getStats();
      return {
        dataset: viewer.metadata.name,
        dimensions: viewer.metadata.dimensions,
        bitDepth: viewer.metadata.bitDepth,
        requests: s.requestCount,
        bytesDownloaded: s.totalBytesDownloaded,
        bricksCommitted: s.bricksCommitted,
        milestones: viewer.milestones,
      };
    },
  };
  (window as unknown as { __kilnCapture?: KilnCapture }).__kilnCapture = capture;
}
