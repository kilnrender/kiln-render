import { describe, it, expect } from 'vitest';
import { cameraAt, stateAt, overlayAt, DEFAULTS } from '../scripts/capture.ts';
import type { Shot } from '../scripts/capture.ts';
import type { OrbitState } from '../examples/shared/capture.ts';

const START: OrbitState = [0.3, 1, 2, 0.1, 0.2, 0.3];

describe('cameraAt', () => {
  it('static keeps the URL camera', () => {
    expect(cameraAt('static', START, 0.7)).toEqual(START);
  });

  it('turntable turns around the target and loops', () => {
    expect(cameraAt('turntable', START, 0)).toEqual(START);
    const half = cameraAt('turntable', START, 0.5);
    expect(half[1]).toBeCloseTo(1 + Math.PI);
    expect([half[0], half[2], half[3], half[4], half[5]]).toEqual([0.3, 2, 0.1, 0.2, 0.3]);
    expect(cameraAt('turntable', START, 1, 2)[1]).toBeCloseTo(1 + 4 * Math.PI);
  });

  it('passes through the keys, starting and ending on them', () => {
    const keys = ['0,0,1,0,0,0', '0.5,1,2,0,0,0', '0.2,2,4,1,1,1'];
    expect(cameraAt(keys, START, 0)).toEqual([0, 0, 1, 0, 0, 0]);
    cameraAt(keys, START, 0.5).forEach((v, i) => expect(v).toBeCloseTo([0.5, 1, 2, 0, 0, 0][i]!));
    cameraAt(keys, START, 1).forEach((v, i) => expect(v).toBeCloseTo([0.2, 2, 4, 1, 1, 1][i]!));
  });

  it('takes the short way round between angles', () => {
    // 3.1 to -3.1 is 0.08 rad across ±π, not 6.2 back the long way
    const mid = cameraAt(['0,3.1,1', '0,-3.1,1'], START, 0.5);
    expect(Math.abs(Math.sin(mid[1]))).toBeLessThan(0.05);
    expect(Math.cos(mid[1])).toBeLessThan(0);
  });

  it('zooms on a log scale and keeps the URL target for 3-value keys', () => {
    const mid = cameraAt(['0,0,1', '0,0,4'], START, 0.5);
    expect(mid[2]).toBeCloseTo(2);
    expect(mid.slice(3)).toEqual([0.1, 0.2, 0.3]);
  });

  it('accepts URL-encoded cam values and a single key', () => {
    cameraAt(['0.1%2C0.2%2C3'], START, 0.4).forEach((v, i) => expect(v).toBeCloseTo([0.1, 0.2, 3, 0.1, 0.2, 0.3][i]!));
  });

  it('rejects malformed keys', () => {
    expect(() => cameraAt(['1,2'], START, 0)).toThrow(/Bad camera key/);
  });
});

const SHOT: Shot = { ...DEFAULTS, url: 'https://kilnrender.com/app/', camera: 'static' };
const INITIAL = { mode: 'dvr', shading: 0, clipMax: [1, 1, 1], channel0: 1 };

describe('stateAt', () => {
  const shot: Shot = {
    ...SHOT,
    actions: [
      { at: 4, until: 6, set: { shading: 0.5 } },
      { at: 1, set: { mode: 'lod' } },
      { at: 2, until: 4, set: { clipMax: [1, 1, 0.5], shading: 1 } },
      { at: 2, until: 4, cam: '0.3,1,0.5' },
    ],
  };

  it('keeps the initial state before the first action', () => {
    expect(stateAt(shot, START, INITIAL, 0.5, 0)).toEqual({ cam: START, settings: INITIAL });
  });

  it('jumps without until and eases with it, from the state the earlier actions left', () => {
    expect(stateAt(shot, START, INITIAL, 1, 0).settings.mode).toBe('lod');
    const mid = stateAt(shot, START, INITIAL, 3, 0).settings;
    expect(mid.shading).toBeCloseTo(0.5);
    expect(mid.clipMax).toEqual([1, 1, 0.75]);
    // The tween from 4 s starts at 1, where the one before ended
    expect(stateAt(shot, START, INITIAL, 5, 0).settings.shading).toBeCloseTo(0.75);
    expect(stateAt(shot, START, INITIAL, 9, 0).settings).toEqual({ mode: 'lod', shading: 0.5, clipMax: [1, 1, 0.5], channel0: 1 });
  });

  it('moves the camera to cam, zooming on a log scale', () => {
    const mid = stateAt(shot, START, INITIAL, 3, 0).cam;
    expect(mid[2]).toBeCloseTo(1); // halfway between 2 and 0.5 on a log scale
    cameraAt(['0.3,1,0.5'], START, 0).forEach((v, i) => expect(stateAt(shot, START, INITIAL, 4, 0).cam[i]).toBeCloseTo(v));
  });

  it('names the settings the dataset has when one is unknown', () => {
    const bad: Shot = { ...SHOT, actions: [{ at: 0, set: { shadng: 1 } }] };
    expect(() => stateAt(bad, START, INITIAL, Infinity, 1)).toThrow(/Unknown setting "shadng".*mode, shading/);
  });
});

describe('overlayAt', () => {
  const shot: Shot = { ...SHOT, stats: true, captions: [{ from: 1, to: 3, text: 'a' }, { from: 2, to: 4, text: 'b' }] };

  it('shows the captions in their window, fading in and out', () => {
    expect(overlayAt(shot, 0.5)).toEqual({ captions: [], stats: true });
    expect(overlayAt(shot, 1.15).captions).toEqual([{ text: 'a', alpha: expect.closeTo(0.5) }]);
    expect(overlayAt(shot, 2.5).captions.map(c => [c.text, c.alpha])).toEqual([['a', 1], ['b', 1]]);
    expect(overlayAt(shot, 3.85).captions).toEqual([{ text: 'b', alpha: expect.closeTo(0.5) }]);
  });
});
