import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// A mode set in the environment wins over the one chosen on the platform. The app's log says so, once,
// because nothing on the platform shows that the choice made there is not the one in force.

const bundle = (enforcement: string) =>
  ({ bundle: { firewall: [], whitelists: [], whitelist_keys: {}, enforcement }, etag: 'W/"1"', buildId: null, source: 'site:x@' }) as never;

let protection: any;

afterEach(async () => {
  await protection?.stop();
  protection = undefined;
  delete process.env.PATCHSTACK_MODE;
  vi.restoreAllMocks();
});

const overrideWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('PATCHSTACK_MODE='));

describe('a local mode that overrides the platform', () => {
  it('is said in the log, naming both modes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PATCHSTACK_MODE = 'dry-run';

    protection = await createProtection({ reportDetections: false, rules: bundle('block') });

    expect(protection.mode).toBe('dry-run');
    const lines = overrideWarnings(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('PATCHSTACK_MODE=dry-run');
    expect(lines[0]).toContain('dashboard (block) is not applied');
  });

  it('is not said when both agree', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PATCHSTACK_MODE = 'block';

    protection = await createProtection({ reportDetections: false, rules: bundle('block') });

    expect(overrideWarnings(warn)).toEqual([]);
  });

  it('is not said when nothing is set locally', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    protection = await createProtection({ reportDetections: false, rules: bundle('block') });

    expect(protection.mode).toBe('block');
    expect(overrideWarnings(warn)).toEqual([]);
  });
});
