import { describe, expect, it } from 'vitest';
import { FLOOR_SHAPE_NAMES, SHAPES, floorShapesOf } from '../scripts/compat-matrix.mjs';

const EXPECTED_FLOOR_SHAPES = [
  'esm-js',
  'cjs-js',
  'esm-js-screens',
  'cjs-js-screens',
  'cli',
  'encapsulation',
];

describe('the declared-floor consumer suite', () => {
  it('runs the exact package and runtime probes promised by CI', () => {
    expect(FLOOR_SHAPE_NAMES).toEqual(EXPECTED_FLOOR_SHAPES);
    expect(floorShapesOf(SHAPES).map((shape) => shape.name)).toEqual(EXPECTED_FLOOR_SHAPES);
  });

  it.each(['esm-js-screens', 'cjs-js-screens'])('refuses to omit %s when it gains a fixture dependency', (name) => {
    const changed = SHAPES.map((shape) =>
      shape.name === name ? { ...shape, deps: ['fixture-package'] } : shape,
    );

    expect(() => floorShapesOf(changed)).toThrow(
      `declared-floor consumer shape ${name} must install only the tarball`,
    );
  });

  it('refuses an incomplete suite instead of reporting fewer successful shapes', () => {
    const incomplete = SHAPES.filter((shape) => shape.name !== 'esm-js-screens');

    expect(() => floorShapesOf(incomplete)).toThrow(
      'declared-floor consumer shape is missing: esm-js-screens',
    );
  });
});
