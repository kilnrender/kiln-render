/**
 * Video capture hook (in-page). Activates only on `?capture=1`: renders at full
 * scale and exposes `window.__kilnCapture`, which scripts/capture.ts uses to move
 * the camera, wait for each frame to settle and pull it as a PNG.
 *
 * Structural typing (CaptureViewer) keeps this decoupled from the library types.
 */

import type { LoadMilestones } from '@kiln/core/milestones.js';

export type OrbitState = [number, number, number, number, number, number];

/** Minimal structural view of KilnViewer — only what the capture uses. */
export interface CaptureViewer {
  renderScale: number;
  renderer: { isConverged: boolean };
  streamingManager: {
    baseLodLoaded: boolean;
    getStats(): { pendingCount: number; bricksCommitted: number; requestCount: number; totalBytesDownloaded: number };
  };
  metadata: { name: string; dimensions: [number, number, number]; bitDepth: number };
  milestones: LoadMilestones;
  device: GPUDevice;
  camera: { getOrbitState(): OrbitState; setOrbitState(state: OrbitState): void };
  captureImage(type?: string): Promise<Blob>;
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
  setCamera(state: OrbitState): void;
  /**
   * Wait until streaming is idle and `samples` frames have accumulated since the last
   * brick commit (or the image converged). False if that took longer than `timeoutMs`.
   */
  settle(samples: number, timeoutMs: number): Promise<boolean>;
  /** The current view as a PNG data URL */
  frame(): Promise<string>;
  stats(): CaptureStats;
}

const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

async function settle(v: CaptureViewer, samples: number, timeoutMs: number): Promise<boolean> {
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

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Install `window.__kilnCapture` if `?capture=1`. Call once, right after the viewer is created. */
export function maybeInstallCapture(viewer: CaptureViewer): void {
  if (new URLSearchParams(window.location.search).get('capture') !== '1') return;
  viewer.renderScale = 1;
  const info = viewer.device.adapterInfo;
  const capture: KilnCapture = {
    start: viewer.camera.getOrbitState(),
    adapter: [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' '),
    setCamera: (state) => viewer.camera.setOrbitState(state),
    settle: (samples, timeoutMs) => settle(viewer, samples, timeoutMs),
    frame: async () => dataUrl(await viewer.captureImage('image/png')),
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
