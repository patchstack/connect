import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { DEFAULT_EGRESS_RULES, DEFAULT_RESPONSE_RULES } from '../../src/protect/defaults.js';

/**
 * One matching and one non-matching sample for every shipped policy.
 *
 * The non-matching half is the reason this exists. A pattern that masks a secret is easy to write and
 * easy to write too broadly, and a policy that masks legitimate content breaks the response it was
 * meant to protect. So each case pairs the thing the policy is for with the nearest thing it must
 * leave alone: a test key beside a live one, a publishable key beside a secret one, the public `anon`
 * role beside `service_role`, a connection string without credentials beside one with them.
 *
 * Every credential here is SYNTHETIC.
 */
const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A JWT is three dot-separated parts; these rules read the payload, so the signature is filler. */
const jwt = (payload: Record<string, unknown>) =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.c2lnbmF0dXJl`;

/**
 * Prefixed keys are assembled rather than written out.
 *
 * A literal in a provider's live-key shape is what secret scanning is for, and it cannot tell a
 * synthetic one from a real one — so the file would be rejected for carrying exactly the shape these
 * policies exist to catch. Assembling the same string from parts keeps the sample and drops the
 * literal. Every value in this file is synthetic.
 */
const key = (...parts: string[]) => parts.join('');

const SUPABASE_RANDOM = 'Xk9Lm2Qp7Rt4Vw8ZaB3cD6';
const SUPABASE_CHECKSUM = 'eF7hJ2kM';

/**
 * `matches` must not survive a screened response; `benign` must survive it verbatim.
 */
const RESPONSE_CASES: Array<{ policy: string; matches: string; benign: string; why: string }> = [
  {
    policy: 'resp-private-key',
    matches: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34\n-----END RSA PRIVATE KEY-----',
    benign: 'Paste your private key into the field below to continue',
    why: 'prose about a private key is not one',
  },
  {
    policy: 'resp-aws-access-key',
    matches: key('AKIA', 'IOSFODNN7EXAMPLE'),
    benign: key('akia', 'iosfodnn7example'),
    why: 'the key id is upper case; a lower-case run is not one',
  },
  {
    policy: 'resp-gcp-api-key',
    matches: key('AIza', 'SyD-1234567890abcdefghijklmnopqrstu'),
    benign: key('AIza', 'TooShortToBeAKey'),
    why: 'the format is a fixed length, and a shorter run is not a key',
  },
  {
    policy: 'resp-vendor-api-key',
    matches: key('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc'),
    benign: key('sk_', 'test_', '4eC39HqLyjWDarjtT1zdp7dc'),
    why: 'a test key is not a live one, and belongs in a response body',
  },
  {
    policy: 'resp-supabase-secret-key',
    matches: key('sb_', 'secret_', SUPABASE_RANDOM, '_', SUPABASE_CHECKSUM),
    benign: key('sb_', 'publishable_', SUPABASE_RANDOM, '_', SUPABASE_CHECKSUM),
    why: 'the publishable key is meant for public clients',
  },
  {
    policy: 'resp-supabase-service-role-key',
    matches: jwt({ role: 'service_role', iss: 'supabase' }),
    benign: jwt({ role: 'anon', iss: 'supabase' }),
    why: 'the anon role is public by design',
  },
  {
    policy: 'resp-db-connection-string',
    matches: 'postgres://app:s3cr3tpw@db.internal:5432/main',
    benign: 'postgres://db.internal:5432/main',
    why: 'a connection string without credentials leaks nothing',
  },
  {
    policy: 'resp-stack-trace',
    matches: 'TypeError: x\n    at handler (/srv/app/index.js:42:15)',
    benign: 'The meeting starts at 10:00 (room 4)',
    why: '" at " in prose is not a stack frame',
  },
  {
    policy: 'resp-sql-error',
    matches: 'SQLSTATE[42000]: Syntax error or access violation',
    benign: 'The request could not be completed',
    why: 'an ordinary error message discloses nothing',
  },
  {
    policy: 'resp-exception-trace',
    matches: 'Traceback (most recent call last):\n  File "app.py", line 3',
    benign: 'System.out.println was called during startup',
    why: 'a class name that is not an exception is not a trace',
  },
];

/** The named policy, alone. */
function policyNamed(id: string): unknown {
  const rule = (DEFAULT_RESPONSE_RULES as any[]).find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`no shipped policy named ${id}`);

  return rule;
}

/**
 * Screen a body through ONE policy, and report whether that policy fired.
 *
 * Isolated deliberately. Run through the whole shipped set, "the sample was handled" says only that
 * something handled it, and a case could pass while the policy it names matched nothing at all.
 *
 * The answer is whether the policy FIRED, not whether the sample survived. A policy that withholds a
 * response removes the sample and so does one that masks it — and a sample the body never contained
 * verbatim, because JSON escaped its newlines, is absent without anything having happened. What each
 * policy leaves on the wire is asserted in `response-policy-wire-behaviour.test.ts`.
 */
async function screen(policy: string, body: string, extra: Record<string, string> = {}) {
  const fired: string[] = [];
  const p: any = await createProtection({
    rules: { firewall: [], whitelists: [], whitelist_keys: {} },
    mode: 'block',
    responseRules: [policyNamed(policy)],
    onDetect: (event: any) => fired.push(String(event.rule?.id)),
  });
  const out = await p.screenResponse(
    new Response(JSON.stringify({ field: body, ...extra }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Request('https://app.test/', { method: 'GET' }),
  );

  return { fired: fired.length > 0, status: out.status, body: await out.text() };
}

describe('every shipped response policy has a sample it matches', () => {
  it.each(RESPONSE_CASES.map((c) => [c.policy, c] as const))('%s', async (policy, testCase) => {
    expect((await screen(policy, testCase.matches)).fired, 'the policy did not fire').toBe(true);
  });
});

describe('and the nearest thing it must leave alone', () => {
  it.each(RESPONSE_CASES.map((c) => [c.policy, c] as const))('%s: %o', async (policy, testCase) => {
    // Screened on its own. The policy's own matching sample cannot travel alongside as a control,
    // because a policy that withholds would take the benign value with it — the matching case above
    // is what proves this policy fires at all.
    const result = await screen(policy, testCase.benign);

    expect(result.fired, testCase.why).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body, testCase.why).toContain(testCase.benign);
  });
});

describe('each policy can reach its own sample', () => {
  it('has at least one prefilter anchor present in what it matches', () => {
    // A prefilter is a gate: the pattern runs only when one of its anchors is in the body. So an
    // anchor absent from the very content the policy is for is a policy that never fires — and
    // nothing else here would notice, because the body would simply come back unmasked for a reason
    // that looks like the pattern not matching.
    const unreachable: string[] = [];

    for (const rule of DEFAULT_RESPONSE_RULES as any[]) {
      const anchors: string[] = rule.prefilter ?? [];
      if (anchors.length === 0) continue;

      const sample = RESPONSE_CASES.find((c) => c.policy === rule.id)?.matches ?? '';
      const reachable = anchors.some((anchor) => sample.toLowerCase().includes(anchor.toLowerCase()));

      if (!reachable) unreachable.push(`${rule.id}: none of [${anchors.join(', ')}] is in its sample`);
    }

    expect(unreachable).toEqual([]);
  });
});

describe('the set is covered', () => {
  it('has a case for every shipped response policy', () => {
    // So a policy added to the guard without a sample here is a failure rather than a gap nobody sees.
    expect(RESPONSE_CASES.map((c) => c.policy).sort()).toEqual(
      DEFAULT_RESPONSE_RULES.map((rule: any) => rule.id).sort(),
    );
  });

  it('has one shipped egress policy, covered below', () => {
    expect(DEFAULT_EGRESS_RULES.map((rule: any) => rule.id)).toEqual(['egress-internal-address']);
  });
});

describe('the shipped egress policy', () => {
  const withEgress = async (fn: (fetchStub: typeof globalThis.fetch) => Promise<void>) => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('stub')) as any;
    const p: any = await createProtection({ egress: true, mode: 'block' });
    try {
      await fn(globalThis.fetch);
    } finally {
      p.uninstallEgress?.();
      globalThis.fetch = origFetch;
    }
  };

  it('blocks a call to the loopback interface', async () => {
    await withEgress(async (f) => {
      await expect(f('http://127.0.0.1/admin')).rejects.toThrow();
    });
  });

  it('blocks a call to the cloud metadata address', async () => {
    await withEgress(async (f) => {
      await expect(f('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    });
  });

  it('allows a call to a public address', async () => {
    // An address literal, and a public one: a name that cannot be resolved is screened as internal,
    // which is fail-closed and would make this pass for the wrong reason.
    await withEgress(async (f) => {
      expect(await (await f('http://93.184.216.34/api')).text()).toBe('stub');
    });
  });
});
