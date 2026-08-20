import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every Patchstack endpoint this package can call has to be named in the shipped docs.
 *
 * Not a style rule. Agents `npm pack` the tarball and audit it before installing, and a capability in
 * `dist/` that the docs do not mention reads as misrepresentation — it gets installs refused, and the
 * refusal is correct. The detection reporter shipped without a single mention in AGENT-INSTALL.md, and
 * nothing noticed, because the only thing resembling this check ("Capability contract" in CI) is about
 * the map vocabulary manifest and never looks at documentation.
 *
 * The guard is deliberately on the ENDPOINT rather than the wording: adding an outbound path fails this
 * test until someone writes down how it is described, which is the moment to decide whether it should be
 * disclosed at all.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How each endpoint is allowed to be described. A path segment is not always the phrase a reader needs —
 * `package-removed` is documented as "package removal" — so this maps the wire name to acceptable prose
 * rather than demanding the literal string.
 */
const DISCLOSED_AS: Record<string, RegExp> = {
  manifest: /manifest/i,
  rules: /rules/i,
  'input-map': /input-map/i,
  detections: /detections/i,
  'package-removed': /package-removed|package removal/i,
  token: /token/i,
  'logs\/log': /logs\/log/i,
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Templates are scaffolded into the target app and are not this package's outbound surface.
      if (entry !== 'templates' && entry !== 'node_modules') out.push(...sourceFiles(full));
    } else if (['.ts', '.js'].includes(extname(entry))) {
      out.push(full);
    }
  }

  return out;
}

/** Endpoint names the package can reach, read out of the source rather than listed by hand. */
function endpointsInSource(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/monitor\/pulse\/([a-z][a-z-]*)/g)) found.add(m[1]);
    // Built from a resolved base URL instead of a literal path — how the detection reporter is written,
    // and therefore the shape this check would have missed if it only read literal paths.
    for (const m of text.matchAll(/\$\{baseUrl\}\/([a-z][a-z-]*)\//g)) found.add(m[1]);
    if (/api\/logs\/log/.test(text)) found.add('logs\/log');
  }

  return found;
}

describe('shipped docs disclose every endpoint the package calls', () => {
  const agentInstall = readFileSync(join(root, 'AGENT-INSTALL.md'), 'utf8');

  it('finds the endpoints in the source', () => {
    // The vacuity control. If the patterns above ever stop matching — a refactor, a new way of building a
    // URL — the set goes empty, every assertion below passes over nothing, and the check would report
    // that all endpoints are disclosed while reading none of them.
    const found = endpointsInSource();

    expect(found.size).toBeGreaterThanOrEqual(6);
    for (const known of ['manifest', 'rules', 'input-map', 'detections']) {
      expect(found, `${known} should be discoverable in src/`).toContain(known);
    }
  });

  it('names each of them in AGENT-INSTALL.md', () => {
    for (const endpoint of endpointsInSource()) {
      const pattern = DISCLOSED_AS[endpoint];
      expect(
        pattern,
        `"${endpoint}" is an outbound endpoint with no entry in DISCLOSED_AS. Add it to AGENT-INSTALL.md ` +
          `and record here how it is described — or establish that it should not ship.`,
      ).toBeDefined();
      expect(agentInstall, `AGENT-INSTALL.md must describe the ${endpoint} endpoint`).toMatch(pattern);
    }
  });

  it('says what a detection report carries, and what it does not', () => {
    // The specific claim that was missing, asserted rather than assumed: an agent auditing this decides
    // on the payload, so "we send detections" without saying what is in them is the disclosure failing at
    // the point it matters.
    expect(agentInstall).toMatch(/reportDetections/);
    for (const claim of [/query string/i, /matched value/i, /request body/i]) {
      expect(agentInstall, `the payload description must address ${claim}`).toMatch(claim);
    }
  });
});
