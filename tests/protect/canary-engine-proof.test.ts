import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Link 3 of the cross-repo canary: the engine's half of the claim.
 *
 * The platform proves "this reviewed recipe plus this map produces these exact rule bytes". This proves
 * the other half — those exact bytes block the exploit and allow a benign control. Neither is worth
 * anything alone: a rule that is generated correctly and never fires is the defining defect of this
 * product, and it is invisible from the side that generated it.
 *
 * The artifact is VENDORED, not rebuilt. Nothing here parses the recipe, evaluates a detector or binds a
 * coordinate — a second implementation of any of that would recreate the duplicate-implementation seam the
 * canary exists to catch, and both sides could then be wrong together. `rule_v2` and `when` go into the
 * bundle verbatim, exactly as the guard receives them from the rules endpoint.
 *
 * CVE-2017-5941: `node-serialize`'s `unserialize` executes an embedded `$$ND_FUNC$$` function expression,
 * so a request body reaching it is remote code execution. Public, which is why the rule and the requests
 * can live here while the recipe that produced it stays private.
 *
 * ## Why this runs against the BUILT engine
 *
 * `dist/protect.js` is what an application loads. Testing `src/` would prove the source blocks the
 * exploit and say nothing about whether the bundle does — and the bundler is a real failure surface: an
 * export dropped, a branch shaken out, an edge build diverging. The published tarball gets the same proof
 * in the release workflow, so a PR proves the branch and a release proves what shipped.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifactPath = path.join(root, 'tests', 'protect', 'fixtures', 'canary', 'cve-2017-5941.rule.json');

/**
 * The engine under test. `PS_CANARY_ENGINE` lets the release workflow point this at the engine unpacked
 * from the published tarball, so one suite covers both "the branch blocks it" and "what shipped blocks
 * it" without a second copy of the proof to drift.
 */
const enginePath = process.env.PS_CANARY_ENGINE ?? path.join(root, 'dist', 'protect.js');

// `dist/` is gitignored and built on publish, so a plain checkout has nothing to load and skipping is the
// honest answer. In CI it is the opposite: the run that is SUPPOSED to prove the shipped engine blocks a
// real exploit must not quietly prove nothing. `PS_REQUIRE_CANARY` is set by the post-build step and turns
// the skip into a failure — a skipped canary reads exactly like a passing one.
const built = existsSync(enginePath);
const required = process.env.PS_REQUIRE_CANARY === '1';

if (required && !built) {
  throw new Error(
    `PS_REQUIRE_CANARY=1 but ${enginePath} does not exist — this check runs after the build. ` +
      'Refusing to skip, because a skipped canary reads exactly like a passing one.',
  );
}

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

/** The bundle shape the rules endpoint serves, with the vendored rule dropped in unchanged. */
const bundleOf = (rule: Record<string, unknown>) => ({
  firewall: [rule],
  whitelists: [],
  whitelist_keys: {},
});

const URL_BASE = 'https://app.test';

/**
 * The published exploit shape for CVE-2017-5941. `_$$ND_FUNC$$_` makes `unserialize` evaluate the string
 * as a function and invoke it immediately; the payload reaches for `child_process` to run a command.
 *
 * Not a synthetic string chosen to match the signature — the point is that the rule the platform generated
 * catches the shape this vulnerability is actually exploited with. A test that fed it a token lifted from
 * the regex would prove the regex matches itself.
 */
const EXPLOIT = JSON.stringify({
  state: '_$$ND_FUNC$$_function (){ require("child_process").exec("id > /tmp/pwned", function(){}); }()',
});

/** A legitimate serialized payload for the same endpoint: no require, no process, nothing to execute. */
const BENIGN = JSON.stringify({ state: '{"cart":[{"sku":"AB-1","qty":2}],"currency":"EUR"}' });

const post = (body: string, url = `${URL_BASE}/api/restore`) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('the vendored canary rule is the one the platform generated', () => {
  // Integrity of the handover, checkable without regenerating anything. If the artifact were hand-edited
  // here — a signature widened, a parameter changed — the tests below would still pass while the engine
  // proved something the platform never produced.
  it('carries a checksum matching its own rule bytes', () => {
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(artifact.rule)).digest('hex').slice(0, 32)}`;

    expect(digest).toBe(artifact.rule_checksum);
  });

  it('names the recipe it was derived from', () => {
    // Not decoration: it is what lets a failure here be traced to a specific reviewed recipe rather than
    // to "some rule stopped working".
    expect(artifact.cve).toBe('CVE-2017-5941');
    expect(artifact.package).toBe('node-serialize');
    expect(artifact.recipe_hash).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it('is scoped and bound, as a generated rule must be', () => {
    // Read from the artifact rather than asserted against hard-coded values, so this states the SHAPE the
    // engine needs and not a copy of the platform's output. An unscoped generated rule applies everywhere.
    expect(artifact.rule.when).toEqual({ method: 'POST', path: '/api/restore' });
    expect(artifact.rule.rule_v2.map((c: any) => c.parameter)).toEqual(['post.state']);
  });
});

describe.skipIf(!built)('the built engine, given that rule verbatim', () => {
  async function guard(mode: 'block' | 'dry-run' = 'block') {
    const { createProtection } = await import(/* @vite-ignore */ enginePath);
    const protection: any = await createProtection({ rules: bundleOf(artifact.rule), mode });

    return protection.fetchGuard();
  }

  it('blocks the published exploit', async () => {
    const response = await (await guard())(post(EXPLOIT));

    expect(response?.status).toBe(403);
  });

  it('allows a benign request to the same endpoint', async () => {
    // The false-positive half. A rule that blocks everything is not protection, and every canary that
    // omits this proves only that something refuses traffic.
    const response = await (await guard())(post(BENIGN));

    expect(response ?? null).toBeNull();
  });

  it('leaves another endpoint alone, because the rule is scoped', async () => {
    // `when` is the difference between a rule aimed at one generated coordinate and a site-wide filter.
    // Without this, a scope silently ignored by the engine would look identical to one honoured.
    const response = await (await guard())(post(EXPLOIT, `${URL_BASE}/api/profile`));

    expect(response ?? null).toBeNull();
  });

  it('detects but does not block in dry-run, so enrolment stays reversible', async () => {
    // The mode a site starts in. If dry-run blocked, adopting protection would be a traffic change rather
    // than an observation, and nobody would run it.
    const detections: unknown[] = [];
    const { createProtection } = await import(/* @vite-ignore */ enginePath);
    const protection: any = await createProtection({
      rules: bundleOf(artifact.rule),
      mode: 'dry-run',
      onDetect: (d: unknown) => detections.push(d),
    });

    const response = await protection.fetchGuard()(post(EXPLOIT));

    expect(response ?? null).toBeNull();
    expect(detections).toHaveLength(1);
  });
});
