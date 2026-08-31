import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMO_TARGET } from '../examples/protect/demo-target.mjs';

/**
 * The demo's vulnerable target: pinned, and outside the dependency graph.
 *
 * The demos show a real CVE being exploited and then shielded. Against a version that carries no flaw the
 * exploit fails on its own, both demos still print their proof, and the guard is credited for a block
 * that never happened — so the version is part of what they prove, not an installation detail.
 *
 * It is installed on demand rather than declared, because a knowingly vulnerable package named in a
 * committed manifest enters this repository's dependency graph, where its advisories cannot be told apart
 * from advisories about the package that actually ships.
 */
const exampleDir = new URL('../examples/protect/', import.meta.url);
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, exampleDir)), 'utf8');

/** Every manifest section that contributes to the dependency graph. */
const GRAPH_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  // Both spellings: npm accepts either, and each is an array of names rather than a name-keyed object.
  'bundledDependencies',
  'bundleDependencies',
] as const;

/**
 * The sections of `manifest` that declare the demo target.
 *
 * Shared between the manifests so neither can be checked against a shorter list than the other.
 */
function declaresTarget(manifest: Record<string, unknown>): string[] {
  return GRAPH_SECTIONS.filter((section) => {
    const value = manifest[section];
    const names = Array.isArray(value) ? value : Object.keys((value ?? {}) as object);

    return names.includes(DEMO_TARGET.package);
  });
}

describe('the demo target', () => {
  it('is the version that actually carries the flaw', () => {
    // Pinned literally: changing it changes what the demos prove, which should require editing a test
    // that says so.
    expect({ pkg: DEMO_TARGET.package, version: DEMO_TARGET.version, cve: DEMO_TARGET.cve }).toEqual({
      pkg: 'lodash',
      version: '4.17.11',
      cve: 'CVE-2019-10744',
    });
  });

  it('is older than the version that fixes it', () => {
    // States the relationship rather than restating the numbers: a target at or past `fixedIn` cannot be
    // exploited, so the demo would prove nothing.
    const asParts = (v: string) => v.split('.').map(Number);
    const [tMaj, tMin, tPatch] = asParts(DEMO_TARGET.version);
    const [fMaj, fMin, fPatch] = asParts(DEMO_TARGET.fixedIn);

    expect(tMaj * 1e6 + tMin * 1e3 + tPatch).toBeLessThan(fMaj * 1e6 + fMin * 1e3 + fPatch);
  });

  it('is absent from every section of the example manifest that reaches the dependency graph', () => {
    // Naming the target rather than forbidding dependencies outright: the invariant is that this one
    // package stays out of the graph, not that the example may never depend on anything. Optional and
    // peer sections are included because both are resolved.
    expect(declaresTarget(JSON.parse(read('package.json')))).toEqual([]);
  });

  it('is absent from every dependency-bearing section of the root manifest too', () => {
    // The demo target must not arrive through the package itself either — the root has no runtime
    // dependencies, and a devDependency on it would put it in the graph just the same.
    const root = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

    expect(declaresTarget(root)).toEqual([]);
  });

  it('is installed by a setup step that names the same version', () => {
    // The setup script must read the constant rather than name a version of its own, or the two can
    // disagree. Asserted on the script's text so a second hard-coded spec cannot appear.
    const setup = read('setup.mjs');

    expect(setup).toContain('DEMO_TARGET');
    expect(setup).toContain('--no-save');
    expect(setup).not.toMatch(/lodash@\d/);
  });

  it('is loaded through the guard that refuses a wrong version', () => {
    // A direct import runs against whatever happens to be installed. Both demos load the target through
    // the helper, which refuses any version but the pinned one.
    for (const name of ['demo.mjs', 'demo-pulse-chain.mjs']) {
      const source = read(name);

      expect(source, `${name} must not import the target directly`).not.toMatch(/^import .* from 'lodash'/m);
      expect(source, `${name} must load it through the helper`).toContain('requireDemoTarget');
    }
  });
});
