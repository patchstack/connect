import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { inputMapBuildId, NonCanonicalInputMap } from '../src/input-map-id.js';

describe('the input-map identity', () => {
  it('pins the versioned document digest', () => {
    const map = {
      version: 3,
      endpoints: [{ file: 'src/Ä.ts', inputs: ['post.email'], evidence: {}, lines: [10, 2] }],
      coverage: { complete: true, note: 'quote " slash \\ newline\n' },
    };
    const canonical =
      '{"coverage":{"complete":true,"note":"quote \\" slash \\\\ newline\\u000a"},' +
      '"endpoints":[{"evidence":{},"file":"src/Ä.ts","inputs":["post.email"],"lines":[10,2]}],' +
      '"version":3}';
    const expected = createHash('sha256')
      .update('patchstack-input-map-v1\0', 'utf8')
      .update(canonical, 'utf8')
      .digest('hex');

    expect(inputMapBuildId(map)).toBe(expected);
    expect(expected).toBe('9c1c08248633749f1d075306f0513ab2d103974acf3fcd6db2828290a05c5ca3');
  });

  it('does not move when object keys are written in another order', () => {
    expect(inputMapBuildId({ version: 3, endpoints: [], coverage: { b: 2, a: 1 } })).toBe(
      inputMapBuildId({ coverage: { a: 1, b: 2 }, endpoints: [], version: 3 }),
    );
  });

  it('refuses numbers whose text is not portable across implementations', () => {
    for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => inputMapBuildId({ version: 3, endpoints: [], coverage: { value } })).toThrow(
        NonCanonicalInputMap,
      );
    }
  });

  it('moves when a mapped coordinate moves', () => {
    const before = { version: 3, endpoints: [{ file: 'src/server.ts', inputs: ['post.email'] }] };
    const after = { version: 3, endpoints: [{ file: 'src/server.ts', inputs: ['post.address'] }] };

    expect(inputMapBuildId(after)).not.toBe(inputMapBuildId(before));
  });

  it('does not identify analyser timing or memory as different coordinates', () => {
    const first = { version: 3, endpoints: [], coverage: { filesParsed: 2, analysisMs: 8, rssBytes: 100 } };
    const second = { version: 3, endpoints: [], coverage: { filesParsed: 2, analysisMs: 99, peakRssBytes: 500 } };

    expect(inputMapBuildId(second)).toBe(inputMapBuildId(first));
    expect(inputMapBuildId({ ...second, coverage: { ...second.coverage, filesParsed: 3 } })).not.toBe(
      inputMapBuildId(first),
    );
  });

  it('excludes the transport field that carries the digest', () => {
    const map = { version: 3, endpoints: [], coverage: {} };

    expect(inputMapBuildId({ ...map, build_id: 'not part of the map' })).toBe(inputMapBuildId(map));
  });
});
