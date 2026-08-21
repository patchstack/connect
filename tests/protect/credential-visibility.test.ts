import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * A site UUID with no credential behind it must be AUDIBLE at boot.
 *
 * The credential is read from `.patchstackrc.json`, which needs a filesystem and a working directory —
 * neither of which exists on a Worker or an edge function, where only an environment variable can carry
 * it. Nothing about that failure shows up in traffic: the rules fetch is rejected, the guard falls open
 * onto its cached or bundled rules, and it goes on screening every request. An app frozen at the rule
 * set it installed with is indistinguishable from a current one, from the outside.
 *
 * So the guarantee under test is a diagnostic, and the assertions are about what the operator can see:
 * the warning fires when a credential is missing, does NOT fire when one resolves, and never costs the
 * app its protection either way.
 */
const NO_CREDENTIAL_ENV = ['PATCHSTACK_API_KEY', 'PATCHSTACK_PULSE_AUTH'] as const;

/** A directory with no `.patchstackrc.json` in it, standing in for a runtime with nothing to read. */
const emptyCwd = () => mkdtempSync(join(tmpdir(), 'ps-no-credential-'));

/** Rules passed inline so no fetch is needed: this file is about the credential, not the transport. */
const RULES = {
  firewall: [
    {
      id: 'r1',
      title: 'blocks a marker in the query',
      rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }],
    },
  ],
};

const app = async () => new Response('ok', { status: 200 });

describe('a site UUID with no credential is reported at boot', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of NO_CREDENTIAL_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Setting a site UUID makes the boot attempt a rule fetch. Stubbed so these tests neither touch the
    // network nor depend on it: the fetch fails, the guard falls back to the inline rules, and what is
    // left under test is the credential diagnostic.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
  });

  afterEach(() => {
    for (const key of NO_CREDENTIAL_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
  });

  it('warns, and names what to set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createProtection({ siteUuid: 'site-nocred', rules: RULES, cwd: emptyCwd() });

    const said = warn.mock.calls.flat().join(' ');
    expect(said, 'the site it could not authenticate').toContain('site-nocred');
    // The remedy, not just the symptom: a warning that does not say what to set leaves an operator on a
    // filesystem-less runtime with no next step, which is where this failure actually happens.
    expect(said, 'the variable that fixes it').toContain('PATCHSTACK_API_KEY');
  });

  it('reports through onError too, so a host that captures logs structurally sees it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors: Error[] = [];

    await createProtection({
      siteUuid: 'site-nocred',
      rules: RULES,
      cwd: emptyCwd(),
      onError: (err: Error) => errors.push(err),
    });

    expect(errors.map((e) => e.message).join(' ')).toContain('site-nocred');
  });

  it('does not warn when a credential resolves', async () => {
    // The control. Without it the test above passes for a warning hard-wired to `siteUuid`, which would
    // fire on every correctly-configured install and train operators to ignore it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createProtection({
      siteUuid: 'site-nocred',
      rules: RULES,
      cwd: emptyCwd(),
      pulseAuth: 'a-secret-40-chars-long-enough-for-this-1',
    });

    expect(warn.mock.calls.flat().join(' ')).not.toContain('site-nocred');
  });

  it('does not warn when there is no site UUID to authenticate for', async () => {
    // Bundled-rules mode is a supported configuration, not a misconfiguration: there is no per-site
    // lookup to authenticate, so there is nothing missing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createProtection({ rules: RULES, cwd: emptyCwd() });

    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/credential/i);
  });

  it('still protects — the warning never becomes a refusal to boot', async () => {
    // The reason this is a warning and not a throw. A missing credential costs rule FRESHNESS; refusing
    // to boot over it would cost protection entirely, which is strictly worse than running on stale rules.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PATCHSTACK_MODE = 'block';

    try {
      const p = await createProtection({ siteUuid: 'site-nocred', rules: RULES, cwd: emptyCwd() });

      expect((await p.fetch(app)(new Request('https://x.test/?q=boom'))).status).toBe(403);
      expect((await p.fetch(app)(new Request('https://x.test/?q=fine'))).status).toBe(200);
    } finally {
      delete process.env.PATCHSTACK_MODE;
    }
  });

});
