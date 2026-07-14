import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The published npm tarball must NEVER contain examples/ — that folder installs a real
// vulnerable dependency (lodash@4.17.11) for the demo, and it must not reach consumers via
// `npm install`/download. This asserts what `npm pack` would actually publish, so loosening
// the package.json "files" allowlist (or dropping it) fails here instead of shipping a CVE.

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function packedFiles(): string[] {
  // --ignore-scripts: skip the prepack build (dist is already built; keeps stdout pure JSON).
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: pkgRoot,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0].files.map((f) => f.path);
}

describe('npm pack safety', () => {
  it('never ships examples/ or any lodash artifact', () => {
    const files = packedFiles();
    const leaked = files.filter((p) => /^(examples)\//.test(p) || /lodash/i.test(p));
    expect(leaked).toEqual([]);
  }, 30_000);

  it('ships only dist/ and top-level docs (allowlist intact)', () => {
    const files = packedFiles();
    const unexpected = files.filter(
      (p) => !p.startsWith('dist/') && !['package.json', 'README.md', 'AGENT-INSTALL.md', 'LICENSE'].includes(p),
    );
    expect(unexpected).toEqual([]);
  }, 30_000);
});
