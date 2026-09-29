import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM workflow helper
import { fetchPublishedPackage } from '../scripts/fetch-published-package.mjs';

function fixture() {
  return {
    run: vi.fn().mockReturnValue({ status: 0, stdout: JSON.stringify([{
      name: '@patchstack/connect', version: '1.2.3', filename: 'patchstack-connect-1.2.3.tgz',
    }]), stderr: '' }),
    wait: vi.fn(), makeDirectory: () => '/tmp/package-check', exists: vi.fn(() => true), log: vi.fn(),
  };
}

describe('published package retrieval', () => {
  it('fetches the exact registry artifact outside the checkout without running package scripts', async () => {
    const f = fixture();
    expect(await fetchPublishedPackage('1.2.3', f)).toBe('/tmp/package-check/package/dist/protect.js');
    expect(f.run.mock.calls[0]).toEqual(['npm', expect.arrayContaining([
      'pack', '@patchstack/connect@1.2.3', '--ignore-scripts', '--prefer-online',
      '--registry=https://registry.npmjs.org', '--cache', '/tmp/package-check/cache',
    ]), expect.objectContaining({ cwd: '/tmp/package-check', timeout: 60000 })]);
    expect(f.run.mock.calls[1][0]).toBe('tar');
  });
  it('retains npm diagnostics and retries transient failures', async () => {
    const f = fixture();
    f.run.mockReturnValueOnce({ status: 1, stderr: 'Registry unavailable' });
    await fetchPublishedPackage('1.2.3', f);
    expect(f.log).toHaveBeenCalledWith('Registry unavailable');
    expect(f.wait).toHaveBeenCalledWith(15000);
    expect(f.run).toHaveBeenCalledTimes(3);
  });
  it('bounds retries and never extracts after a failed fetch', async () => {
    const f = fixture();
    f.run.mockReturnValue({ status: 1, stderr: 'Registry unavailable' });
    await expect(fetchPublishedPackage('1.2.3', f)).rejects.toThrow('remains unverified');
    expect(f.run).toHaveBeenCalledTimes(5);
    expect(f.wait.mock.calls).toEqual([[15000], [30000], [45000], [60000]]);
    expect(f.run.mock.calls.every(([command]) => command === 'npm')).toBe(true);
  });
  it.each(['', 'latest', '../1.2.3', '1.2.3\n', '01.2.3'])('refuses invalid version %j before running anything', async (version) => {
    const f = fixture();
    await expect(fetchPublishedPackage(version, f)).rejects.toThrow('explicit release version');
    expect(f.run).not.toHaveBeenCalled();
  });
  it('refuses a mismatched artifact without extracting it', async () => {
    const f = fixture();
    f.run.mockReturnValueOnce({ status: 0, stdout: '[{"name":"another-package"}]' });
    await expect(fetchPublishedPackage('1.2.3', f)).rejects.toThrow('does not match');
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('requires both the tarball and the engine file', async () => {
    const f = fixture();
    f.exists.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(fetchPublishedPackage('1.2.3', f)).rejects.toThrow('no dist/protect.js');
  });
  it('does not hide extraction errors', async () => {
    const f = fixture();
    f.run.mockImplementation((command) => command === 'tar'
      ? { status: 1, stderr: 'Invalid archive' }
      : { status: 0, stdout: '[{"name":"@patchstack/connect","version":"1.2.3","filename":"patchstack-connect-1.2.3.tgz"}]' });
    await expect(fetchPublishedPackage('1.2.3', f)).rejects.toThrow('Invalid archive');
  });
});
