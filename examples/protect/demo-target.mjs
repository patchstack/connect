// The vulnerable dependency the demos exploit, in one place.
//
// Deliberately not a declared dependency of this example: a knowingly vulnerable package named in a
// committed manifest enters the repository's dependency graph, where its advisories are
// indistinguishable from advisories about the package this repository actually ships. It is installed on
// demand instead (`npm run setup`).
//
// This module is the single place the version is written down, and `tests/demo-target.test.ts` pins it.
// The version matters to what the demos prove: against a patched version the exploit fails on its own,
// and the guard would be credited for a block that never happened.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEMO_TARGET = Object.freeze({
  package: 'lodash',
  version: '4.17.11',
  cve: 'CVE-2019-10744',
  fixedIn: '4.17.12',
  /** What the demos say when the package is absent, so the instruction is identical everywhere. */
  installHint: 'cd examples/protect && npm run setup',
});

/**
 * Load the vulnerable dependency, or exit with the instruction to install it.
 *
 * Exits rather than throwing: a stack trace about a missing module tells a reader nothing about what the
 * demo needs, and the demos are the first thing anybody runs.
 */
export async function requireDemoTarget() {
  try {
    const mod = await import(DEMO_TARGET.package);
    const loaded = mod.default ?? mod;

    if (loaded?.VERSION !== DEMO_TARGET.version) {
      console.error(
        `\n  This demo exploits ${DEMO_TARGET.package}@${DEMO_TARGET.version} (${DEMO_TARGET.cve}).\n` +
          `  Installed: ${loaded?.VERSION ?? 'unknown'} — a different version does not carry the flaw,\n` +
          `  so the demo would report a block that proves nothing.\n\n  Fix: ${DEMO_TARGET.installHint}\n`,
      );
      process.exit(2);
    }

    return loaded;
  } catch {
    console.error(
      `\n  This demo needs ${DEMO_TARGET.package}@${DEMO_TARGET.version} (${DEMO_TARGET.cve}), which is\n` +
        `  installed on demand rather than declared as a dependency of this example.\n\n  Run: ${DEMO_TARGET.installHint}\n`,
    );
    process.exit(2);
  }
}

/**
 * Load the built runtime, or exit with the command that builds it.
 *
 * The demos load `dist/protect.js` because that is the artifact an application loads. `dist/` is not
 * tracked, so a clean checkout has to build first — and a static import of a missing module fails before
 * any code in the demo can explain that.
 */
export async function loadRuntime() {
  const runtime = new URL('../../dist/protect.js', import.meta.url);

  // Presence is checked separately from loading, so the two failures stay distinguishable: an absent
  // build needs an instruction, while a build that exists and fails to load has a real cause worth
  // seeing. Catching both and printing the same advice hides the second behind the first.
  if (!existsSync(fileURLToPath(runtime))) {
    console.error(
      '\n  This demo loads the built runtime from dist/, which is not tracked.\n\n' +
        '  Run, from the repository root:  npm install && npm run build\n',
    );
    process.exit(2);
  }

  return import(runtime);
}
