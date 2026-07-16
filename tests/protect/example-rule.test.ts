import { describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// Patchstack's real rule_v2 bundle: block if `mytestparameter` is PRESENT (isset)
// OR if `hithere` CONTAINS `allgood`. Two plain (non-inclusive) conditions ->
// OR-combined by #evaluateRule (engine.js:310-314): ANY match -> block.
const bundle = {
  firewall: [
    {
      id: 'rm-npm-test-0001',
      title: "Example test rule",
      rule_v2: [
        {
          parameter: 'get.mytestparameter',
          match: {
            type: 'isset',
          },
        },
        {
          parameter: 'get.hithere',
          match: {
            type: 'contains',
            value: 'allgood',
          },
        },
      ],
    },
  ],
  whitelists: [],
  whitelist_keys: {},
};

// GET request carrying a query string — params reach the engine as get.<name>
// via fromFetchRequest -> url.searchParams (src/protect/engine/fetch.js:22-29).
function getReq(qs: string) {
  return new Request(`https://app.example.com/api/thing?${qs}`, { method: 'GET' });
}

describe("Example rule — inline bundle via fetchGuard", () => {
  it('BLOCKED: ?mytestparameter=1 (isset match) -> 403', async () => {
    const protection = await createProtection({ rules: bundle, mode: 'block' });
    const guard = protection.fetchGuard(); // (request) => Promise<Response | null>

    const res = await guard(getReq('mytestparameter=1'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('BLOCKED: ?hithere=xxallgoodxx (contains match) -> 403', async () => {
    const protection = await createProtection({ rules: bundle, mode: 'block' });
    const guard = protection.fetchGuard();

    const res = await guard(getReq('hithere=xxallgoodxx'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('ALLOWED: ?hithere=nope and NO mytestparameter -> null (proves engine is not blocking everything)', async () => {
    const protection = await createProtection({ rules: bundle, mode: 'block' });
    const guard = protection.fetchGuard();

    const res = await guard(getReq('hithere=nope'));
    expect(res).toBeNull();
  });

  it('OR semantics: each condition blocks on its own, independent of the other', async () => {
    const protection = await createProtection({ rules: bundle, mode: 'block' });
    const guard = protection.fetchGuard();

    // Only mytestparameter present (hithere absent) -> isset fires alone.
    const onlyIsset = await guard(getReq('mytestparameter=anything'));
    expect(onlyIsset).not.toBeNull();
    expect(onlyIsset!.status).toBe(403);

    // Only hithere=...allgood... present (mytestparameter absent) -> contains fires alone.
    const onlyContains = await guard(getReq('hithere=allgood'));
    expect(onlyContains).not.toBeNull();
    expect(onlyContains!.status).toBe(403);
  });
});

describe("Example rule — full production fetch path (PulseRuleClient)", () => {
  it('BLOCKED via live Pulse fetch: ?mytestparameter=1 -> 403', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(bundle), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const protection = await createProtection({
        siteUuid: 'test-site',
        pulseRulesUrl: 'https://x.test/monitor/pulse',
        mode: 'block',
      });
      const guard = protection.fetchGuard();

      const res = await guard(getReq('mytestparameter=1'));
      expect(fetchMock).toHaveBeenCalled();
      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
