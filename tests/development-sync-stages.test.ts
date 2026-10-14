import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startDevelopmentSync } from '../src/development-sync.js';

const mocks = vi.hoisted(() => ({ manifest: vi.fn(), sync: vi.fn() }));
vi.mock('../src/protect/refresh-manifest.js', () => ({ reportManifest: mocks.manifest }));
vi.mock('../src/config.js', () => ({ resolveConfig: async () => ({}) }));
vi.mock('../src/setup-sync.js', () => ({ syncSetupProtection: mocks.sync }));
const build = 'a'.repeat(64);
const accepted = { map: { buildId: build, upload: { result: 'stored' } }, rules: { ok: true, mapRules: 'ready' } };
const coordinatorOptions = { snapshot: () => 'stable', pollMs: 10, debounceMs: 0, minIntervalMs: 100, log: () => {} };
beforeEach(() => { vi.useFakeTimers(); mocks.manifest.mockReset(); mocks.sync.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

it('retries a failed package report using the accepted map identity, then stops on success', async () => {
  mocks.manifest.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  mocks.sync.mockResolvedValueOnce(accepted).mockResolvedValue({ ...accepted, map: { buildId: build, unchangedLocal: true } });
  const coordinator = startDevelopmentSync('.', coordinatorOptions);
  try {
    await vi.advanceTimersByTimeAsync(99);
    expect(mocks.manifest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.manifest).toHaveBeenCalledTimes(2);
    expect(mocks.sync.mock.calls[1]![2].mapOptions.previousBuildId).toBe(build);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.manifest).toHaveBeenCalledTimes(2);
  } finally { coordinator.stop(); }
});

it('keeps repeated manifest failures rate limited even while map and rule retrieval succeed', async () => {
  mocks.manifest.mockRejectedValue(new Error('offline'));
  mocks.sync.mockResolvedValue(accepted);
  const coordinator = startDevelopmentSync('.', coordinatorOptions);
  try {
    await vi.advanceTimersByTimeAsync(299);
    expect(mocks.manifest).toHaveBeenCalledTimes(3);
    coordinator.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.manifest).toHaveBeenCalledTimes(3);
  } finally { coordinator.stop(); }
});

it('does not reuse a locally stamped map whose upload failed', async () => {
  mocks.manifest.mockResolvedValue(undefined);
  mocks.sync.mockResolvedValueOnce({ ...accepted, map: { buildId: build, upload: { result: 'failed' } } }).mockResolvedValue(accepted);
  const coordinator = startDevelopmentSync('.', coordinatorOptions);
  try {
    await vi.advanceTimersByTimeAsync(101);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(mocks.sync.mock.calls[1]![2].mapOptions.previousBuildId).toBeUndefined();
  } finally { coordinator.stop(); }
});

it('does not acknowledge a partially successful snapshot superseded during upload', async () => {
  let snapshot = 'one';
  let release!: (value: typeof accepted) => void;
  mocks.manifest.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  mocks.sync.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(accepted);
  const coordinator = startDevelopmentSync('.', { ...coordinatorOptions, snapshot: () => snapshot });
  try {
    await vi.advanceTimersByTimeAsync(0);
    snapshot = 'two';
    release(accepted);
    await vi.advanceTimersByTimeAsync(101);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(mocks.sync.mock.calls[1]![2].mapOptions.previousBuildId).toBeUndefined();
  } finally { coordinator.stop(); }
});
