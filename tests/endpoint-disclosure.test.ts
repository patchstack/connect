import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every Patchstack endpoint this package can call has to be named in the shipped docs.
 *
 * Not a style rule. Agents `npm pack` the tarball and audit it before installing, and a capability in
 * `dist/` the docs do not mention reads as misrepresentation — it gets installs refused, and the refusal
 * is correct. The detection reporter shipped with no mention anywhere and nothing noticed, because the
 * only comparable check ("Capability contract" in CI) is about the map vocabulary manifest and never
 * reads documentation.
 *
 * ## Why this file is shaped the way it is
 *
 * The first version enumerated URL-building IDIOMS — a literal `monitor/pulse/x`, a `${baseUrl}/x/`
 * template, the log path — and asserted that everything it recognised was disclosed. It passed while
 * three real endpoints sat outside it: the OAuth token exchange, the widget-settings lookup, and the
 * older `get-rules` path. A scan that recognises some shapes cannot support the sentence "every endpoint
 * is disclosed"; it can only say the ones it happened to match were.
 *
 * So the polarity is inverted here. Candidates are extracted broadly, and every one must be CLASSIFIED —
 * either an endpoint with a documented description, or explicitly not an endpoint with a reason. Anything
 * unrecognised fails. New URL, new comment, new fixture path: all of them stop this test until someone
 * decides which it is, and that decision is the point.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Endpoints the package can reach, and the wording that counts as describing each one. */
const DISCLOSED_AS: Record<string, RegExp> = {
  'monitor/pulse/manifest': /manifest/i,
  'monitor/pulse/rules': /monitor\/pulse\/rules|pulse rules/i,
  'monitor/pulse/input-map': /input-map/i,
  // Built from the resolved Pulse base rather than a literal path, which is why it needs the second
  // extraction pattern below — and why the first version of this file could not see it.
  detections: /monitor\/pulse\/detections/i,
  'monitor/pulse/package-removed': /package-removed|package removal/i,
  'monitor/pulse/token': /short-lived token|pulse\/token/i,
  'monitor/widget/settings': /monitor\/widget\/settings/i,
  'monitor/claim': /claim/i,
  'oauth/token': /oauth\/token/i,
  // The RFC 8628 login flow. Documented by showing the approval URL the command prints, which is the
  // form a reader actually needs: it is where they are sent.
  device: /monitor\/pulse\/device/i,
  'api/logs/log': /logs\/log/i,
  'api/get-rules/3': /get-rules/i,
};

/** Path-shaped strings that are not endpoints of ours. Each needs a reason, not just an entry. */
const NOT_AN_ENDPOINT: Record<string, string> = {
  'monitor/pulse': 'the base path the per-site endpoints are built on, not an endpoint itself',
  'api/tasks': "a route in the demo's own throwaway app on localhost, used as the default exploit target",
  // Paths INSIDE the target project, written by the scaffolder. They match the same shape as a URL
  // segment appended to a base, and are classified rather than filtered out by a heuristic: a rule that
  // guessed which template literals were URLs is what let three real endpoints through last time.
  patchstack: 'a directory in the target app that the scaffolder writes the guard into',
  rules: 'a file the scaffolder writes beside the guard in the target app',
  guard: 'the guard file the scaffolder writes into the target app',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Templates are scaffolded into the target app; they are that app's surface, not this package's.
      if (entry !== 'templates' && entry !== 'node_modules') out.push(...sourceFiles(full));
    } else if (['.ts', '.js'].includes(extname(entry))) {
      out.push(full);
    }
  }

  return out;
}

/** Comments carry example URLs that are not endpoints; the code is what makes a request. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;,)])\/\/.*$/gm, '$1');
}

const API_ROOTS = ['monitor', 'api', 'oauth'];

/** Every path-shaped candidate in the source, by whichever way its URL is assembled. */
function candidates(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (path: string, file: string) => {
    const set = found.get(path) ?? new Set<string>();
    set.add(file);
    found.set(path, set);
  };

  for (const file of sourceFiles(join(root, 'src'))) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const name = file.slice(root.length + 1);

    // A path written under one of the API roots, however the rest of the URL is built.
    for (const m of text.matchAll(/\b(monitor|api|oauth)\/([a-z][a-z0-9/-]*)/g)) {
      add(`${m[1]}/${m[2]}`.replace(/\/$/, ''), name);
    }
    // A segment appended to an already-resolved base URL, where the root is not in the literal at all.
    for (const m of text.matchAll(/\$\{[A-Za-z_$][\w$]*\}\/([a-z][a-z0-9-]*)/g)) {
      if (!API_ROOTS.includes(m[1])) add(m[1], name);
    }
  }

  return found;
}

describe('shipped docs disclose every endpoint the package calls', () => {
  const agentInstall = readFileSync(join(root, 'AGENT-INSTALL.md'), 'utf8');

  it('classifies every path-shaped candidate it finds', () => {
    // The completeness assertion. An unclassified candidate is not skipped — it fails, because the only
    // honest way to claim every endpoint is disclosed is to have accounted for everything found.
    const unclassified = [...candidates().entries()]
      .filter(([path]) => !(path in DISCLOSED_AS) && !(path in NOT_AN_ENDPOINT))
      .map(([path, files]) => `${path} (in ${[...files].sort().join(', ')})`);

    expect(
      unclassified,
      'Unclassified path(s). If the package can call it, describe it in AGENT-INSTALL.md and add it to ' +
        'DISCLOSED_AS; if it is not an endpoint of ours, add it to NOT_AN_ENDPOINT with the reason.',
    ).toEqual([]);
  });

  it('finds the endpoints at all', () => {
    // The vacuity control. If both patterns stop matching, every assertion here passes over an empty set
    // and the file reports total disclosure while reading nothing.
    const found = candidates();

    expect(found.size).toBeGreaterThanOrEqual(10);
    for (const known of ['monitor/pulse/manifest', 'oauth/token', 'api/logs/log', 'detections']) {
      expect([...found.keys()], `${known} should be discoverable in src/`).toContain(known);
    }
  });

  it('names each endpoint in AGENT-INSTALL.md', () => {
    for (const [path, pattern] of Object.entries(DISCLOSED_AS)) {
      expect(agentInstall, `AGENT-INSTALL.md must describe ${path}`).toMatch(pattern);
    }
  });

  it('says what a detection report carries, and what it does not', () => {
    expect(agentInstall).toMatch(/reportDetections/);
    for (const claim of [/query string/i, /matched value/i, /request body/i]) {
      expect(agentInstall, `the payload description must address ${claim}`).toMatch(claim);
    }
  });

  it('does not describe detection reporting as limited to non-blocking matches', () => {
    // The runtime records EVERY match, then additionally posts the enforced ones to the block log. Saying
    // only non-blocking detections are sent understates what leaves the app, which is the direction that
    // matters: a reader deciding whether to enable this is owed the larger number, not the smaller one.
    expect(agentInstall).toMatch(/every rule that matched/i);
  });
});
