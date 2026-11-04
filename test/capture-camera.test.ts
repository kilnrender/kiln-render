import { describe, it, expect } from 'vitest';
import { cameraAt } from '../scripts/capture.ts';
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
