import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The published npm tarball must NEVER contain examples/ — that folder installs a REAL
// vulnerable dependency (lodash@4.17.11) for the demo, and it must not reach consumers via
// `npm install`/download.
//
// npm decides what ships from the package.json "files" allowlist (authoritative: with a strict
// allowlist, only those paths plus npm's always-included files — package.json / README / LICENSE
// — are published), with .npmignore as a backstop. We assert those inputs directly instead of
// shelling `npm pack`: the pack CLI's --json stdout format varies across npm 9/10/11 (node
// 18/20/22 in CI), so parsing it is flaky, whereas the allowlist is the ground truth npm obeys.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const npmignore = readFileSync(path.join(root, '.npmignore'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim());

describe('npm publish safety', () => {
  it('ships via a strict "files" allowlist (no catch-all that could pull in examples/)', () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files.length).toBeGreaterThan(0);
    // Reject any entry broad enough to sweep in examples/: a bare '.', a leading '/', a '*'/'**'
    // glob, or an explicit examples path. With none of these, examples/ cannot be published.
    for (const entry of pkg.files) {
      expect(/^(\.|\/|\*|\*\*|examples)/.test(entry), `files entry "${entry}" is too broad`).toBe(false);
    }
  });

  it('publishes only dist/ and the top-level docs', () => {
    const allowed = new Set(['dist', 'README.md', 'AGENT-INSTALL.md', 'LICENSE']);
    const unexpected = pkg.files.filter((f: string) => !allowed.has(f));
    expect(unexpected).toEqual([]);
  });

  it('lists examples/ in .npmignore as a backstop (in case the allowlist is ever dropped)', () => {
    expect(npmignore).toContain('examples');
  });
});
