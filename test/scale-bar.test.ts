import { describe, it, expect } from 'vitest';
import { scaleBarFor } from '../examples/shared/scale-bar.js';

describe('scaleBarFor', () => {
  it('picks the longest 1, 2 or 5 × 10ⁿ that fits', () => {
    // 1 µm per pixel, 120 px max: 100 µm
    expect(scaleBarFor(1, 'micrometer', 120)).toEqual({ px: 100, label: '100 µm' });
    // 0.5 µm per pixel: 60 µm fit, so 50 µm over 100 px
    expect(scaleBarFor(0.5, 'micrometer', 120)).toEqual({ px: 100, label: '50 µm' });
    // 0.3 µm per pixel: 36 µm fit, so 20 µm
    const bar = scaleBarFor(0.3, 'micrometer', 120)!;
    expect(bar.label).toBe('20 µm');
    expect(bar.px).toBeCloseTo(66.67, 1);
  });

  it('switches to the prefix that fits the length', () => {
    expect(scaleBarFor(20, 'micrometer', 120)!.label).toBe('2 mm');
    expect(scaleBarFor(0.002, 'micrometer', 120)!.label).toBe('200 nm');
    expect(scaleBarFor(10, 'nanometer', 120)!.label).toBe('1 µm');
    expect(scaleBarFor(1, 'angstrom', 120)!.label).toBe('10 nm');
  });

  it('keeps a non-metric unit as written', () => {
    expect(scaleBarFor(0.1, 'inch', 120)).toEqual({ px: 100, label: '10 inch' });
  });

  it('returns null for an unusable scale', () => {
    expect(scaleBarFor(0, 'micrometer')).toBeNull();
    expect(scaleBarFor(Number.NaN, 'micrometer')).toBeNull();
    expect(scaleBarFor(Infinity, 'micrometer')).toBeNull();
  });
});
