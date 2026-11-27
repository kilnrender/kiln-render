/**
 * Scale bar: a round physical length at the camera target, bottom left of the main view.
 * Shown only when the dataset's spatial axes carry a unit.
 */

import type { Camera } from '@kiln/core/camera.js';
import type { VolumeMetadata } from '@kiln/data/data-provider.js';

/** Longest bar in CSS pixels; the bar is the longest 1, 2 or 5 × 10ⁿ that fits. */
const MAX_PX = 120;

const METERS: Record<string, number> = {
  angstrom: 1e-10, picometer: 1e-12, nanometer: 1e-9, micrometer: 1e-6, millimeter: 1e-3,
  centimeter: 1e-2, decimeter: 1e-1, meter: 1, kilometer: 1e3,
};
const PREFIXES: [string, number][] = [['km', 1e3], ['m', 1], ['mm', 1e-3], ['µm', 1e-6], ['nm', 1e-9], ['pm', 1e-12]];

/** Bar length in pixels and its label, for `unitsPerPx` units of `unit` per CSS pixel. */
export function scaleBarFor(unitsPerPx: number, unit: string, maxPx = MAX_PX): { px: number; label: string } | null {
  if (!(unitsPerPx > 0) || !Number.isFinite(unitsPerPx)) return null;
  const toMeters = METERS[unit];
  // Metric units are shown with the best-fitting prefix; others (e.g. inch) in their own unit
  const perPx = unitsPerPx * (toMeters ?? 1);
  const max = perPx * maxPx;
  const base = 10 ** Math.floor(Math.log10(max));
  const length = [5, 2, 1].map(m => m * base).find(l => l <= max * (1 + 1e-9))!;
  const px = length / perPx;
  if (toMeters === undefined) return { px, label: `${Number(length.toPrecision(3))} ${unit}` };
  const [symbol, factor] = PREFIXES.find(([, f]) => length >= f * (1 - 1e-9)) ?? PREFIXES[PREFIXES.length - 1]!;
  return { px, label: `${Number((length / factor).toPrecision(3))} ${symbol}` };
}

/** `viewer` is a KilnViewer and `canvas` its main canvas: the bar follows its camera, size and dataset. */
export function mountScaleBar(viewer: { readonly camera: Camera; readonly metadata: VolumeMetadata }, canvas: HTMLCanvasElement): void {
  const el = document.createElement('div');
  el.className = 'scale-bar';
  el.innerHTML = '<span class="scale-bar-label"></span><span class="scale-bar-line"></span>';
  document.body.appendChild(el);
  const label = el.querySelector<HTMLElement>('.scale-bar-label')!;
  const line = el.querySelector<HTMLElement>('.scale-bar-line')!;

  let shown = '';
  const update = () => {
    requestAnimationFrame(update);
    const { metadata, camera } = viewer;
    const rect = canvas.getBoundingClientRect();
    // Above the status strip, which covers the bottom of a full-window canvas
    const strip = document.querySelector('.status-strip')?.getBoundingClientRect().height ?? 0;
    let bottom = Math.max(window.innerHeight - rect.bottom, strip) + 8;
    // The colour bar sits bottom centre of the window; in the quad layout that can be under the bar
    const colorbar = document.querySelector('.colorbar')?.getBoundingClientRect();
    if (colorbar?.width && colorbar.right > rect.left && colorbar.left < rect.left + MAX_PX + 24) {
      bottom = Math.max(bottom, window.innerHeight - colorbar.top + 6);
    }
    const key = `${camera.version} ${rect.left} ${bottom} ${rect.height} ${metadata.spatialUnit} ${metadata.dimensions} ${metadata.voxelSpacing}`;
    if (key === shown) return;
    shown = key;

    // World space spans the dataset's largest physical extent as 1; at the target the view is
    // 2·distance·tan(fov/2) tall in perspective and orthographic alike
    const spacing = metadata.voxelSpacing ?? [1, 1, 1];
    const extent = Math.max(...metadata.dimensions.map((d, i) => d * spacing[i]!));
    const distance = camera.getOrbitState()[2];
    const unitsPerPx = (2 * distance * Math.tan(camera.fovY / 2) * extent) / rect.height;
    const bar = metadata.spatialUnit ? scaleBarFor(unitsPerPx, metadata.spatialUnit) : null;

    el.style.display = bar ? '' : 'none';
    if (!bar) return;
    el.style.left = `${rect.left + 8}px`;
    el.style.bottom = `${bottom}px`;
    line.style.width = `${bar.px}px`;
    label.textContent = bar.label;
  };
  update();
}
