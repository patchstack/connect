import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDetectionReporter } from '../../src/protect/detections.js';
import { RequestResolver } from '../../src/protect/engine/request.js';
import { normalizeRequest } from '../../src/protect/engine/normalizer.js';
import { captureValues, derivePlan, planReference } from '../../src/protect/capture-plan.js';

/**
 * The disclosure, checked against a REAL serialized payload rather than against itself.
 *
 * Three rounds of review on this section all found the same thing: the prose was wrong and the code was
 * right. An endpoint nobody had written down, a trigger described as narrower than it is, and a privacy
 * boundary claimed wider than the code's. The guards that existed asserted that words APPEAR — none of
 * them read the payload, so none could tell whether the words were TRUE OF IT.
 *
 * So this test posts a detection through the real reporter, captures the bytes, and asks two questions
 * of them: is every field we emit described, and does every exclusion we claim actually hold.
 *
 * The prose stays hand-written. What is mechanised is the inventory — generated disclosure text would
 * read as machine output to the agents auditing this file, and the wording is doing adversarial-UX work a
 * serializer cannot do.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const disclosure = readFileSync(join(root, 'AGENT-INSTALL.md'), 'utf8');

/**
 * Every key the payload may carry, and the wording that describes it.
 *
 * A key with no entry fails. That is the point: adding a field to the report stops the build until
 * someone writes it down or decides it should not ship.
 */
const FIELD_DISCLOSURE: Record<string, RegExp> = {
  rule_id: /rule id/i,
  route: /request path/i,
  query_keys: /query string's parameter \*\*names\*\*|query string travels as names only/i,
  method: /request's method|method/i,
  user_agent: /user\s+agent/i,
  parameters: /parameter names/i,
  phase: /which phase matched/i,
  enforced: /whether it was enforced/i,
  rules_etag: /identifier of the rule bundle/i,
  rule_revision: /revision of the rule/i,
  detected_at: /timestamp/i,
  client_ip: /client address/i,
  client_ip_source: /where that address came from/i,
  truncated: /which fields were shortened/i,
  capture: /values of the parameters a rule names/i,
  parameters_total: /how many parameters the rule reads/i,
  query_keys_total: /how many query parameters the request carried/i,
};

/**
 * Fields the payload omits rather than sends empty.
 *
 * `client_ip` is absent when no address could be established, which is the documented behaviour: a
 * present-but-empty field reads as a failed lookup of a real address. So the completeness check below
 * requires every OTHER documented field, and this one only when there was an address to report.
 */
const CONDITIONAL_FIELDS = new Set([
  'client_ip',
  'truncated',
  'parameters_total',
  'query_keys_total',
  'capture',
]);

/** Envelope keys, described separately because they are per-batch rather than per-detection. */
const ENVELOPE_DISCLOSURE: Record<string, RegExp> = {
  detections: /per matched rule/i,
  dropped: /count of reports dropped/i,
};

/**
 * Values planted where the reporter could pick them up, each with the sentence that promises it will not.
 * Proving the boundary beats restating it: if a future change starts forwarding any of these, the bytes
 * change and this fails.
 */
const VALUE_EXCLUSIONS = [
  {
    what: 'the value of a parameter the rule does not name',
    sentinel: 'SENTINEL-UNNAMED-FIELD',
    disclosed: /the value of any parameter the matched rule does not name/i,
  },
  {
    what: 'a header value the rule does not name',
    sentinel: 'SENTINEL-HEADER-VALUE',
    disclosed: /the value of any parameter the matched rule does not name/i,
  },
  {
    what: 'the request body, where no reviewed opt-in permits it',
    sentinel: 'SENTINEL-REQUEST-BODY',
    disclosed: /request body, other than the reviewed raw prefix/i,
  },
  {
    what: 'a response body value',
    sentinel: 'SENTINEL-RESPONSE-BODY',
    disclosed: /response\*\* values are never captured|any response\s+body, header or status value/i,
  },
  {
    what: 'a query-string value in the route',
    sentinel: 'SENTINEL-QUERY-VALUE',
    disclosed: /query.string|query string/i,
  },
];

/**
 * Values a rule's own plan DOES permit.
 *
 * Positive controls. Without them every exclusion above could pass because capture was not running at
 * all, which is the failure mode a list of absences invites.
 */
const VALUE_INCLUSIONS = [
  { what: 'a named body field', sentinel: 'SENTINEL-NAMED-FIELD' },
  { what: 'a named cookie', sentinel: 'SENTINEL-NAMED-COOKIE' },
];

/**
 * A rule that reads the sensitive regions on purpose — a cookie and an Authorization header — because
 * those are the parameters whose NAMES are sent, which is the distinction the disclosure has to make.
 */
const RULE = {
  id: 'PS-CVE-2026-0001',
  rule_v2: [
    { parameter: 'post.title', match: { type: 'contains', value: 'x' } },
    { parameter: 'cookie.session', match: { type: 'contains', value: 'x' } },
    { parameter: 'server.HTTP_AUTHORIZATION', match: { type: 'contains', value: 'x' } },
  ],
};

/** One real detection, serialized by the real reporter. */
async function capturePayload(): Promise<{ raw: string; body: Record<string, unknown> }> {
  let raw = '';
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    raw = String(init.body);

    return new Response('{}', { status: 202 });
  });

  const reporter = createDetectionReporter({
    siteUuid: 'site-contract',
    baseUrl: 'https://api.test/monitor/pulse',
    rulesEtag: '"bundle-7"',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  reporter.record({
    rule: RULE,
    phase: 'request',
    mode: 'block',
    // The query string carries a sentinel: the route is supposed to arrive with it stripped.
    path: '/checkout/confirm?token=SENTINEL-QUERY-VALUE',
    // Fields a detection could plausibly grow, planted so that forwarding them is a test failure rather
    // than a silent change in what leaves the app.
    matchedValue: 'SENTINEL-MATCHED-VALUE',
    body: 'SENTINEL-REQUEST-BODY',
    headers: { authorization: 'SENTINEL-HEADER-VALUE' },
    cookies: { session: 'SENTINEL-COOKIE-VALUE' },
  } as never);

  reporter.flush();
  await vi.waitFor(() => expect(raw).not.toBe(''));

  return { raw, body: JSON.parse(raw) as Record<string, unknown> };
}

/**
 * The same reporter, on a detection large enough to be shortened.
 *
 * The fields that only appear when something was truncated would otherwise never be emitted here, and
 * their disclosure entries would sit in the table above describing a payload this test never produces.
 */
async function captureTruncatedPayload(): Promise<Record<string, unknown>> {
  let raw = '';
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    raw = String(init.body);

    return new Response('{}', { status: 202 });
  });
  const reporter = createDetectionReporter({
    siteUuid: 'site-contract',
    baseUrl: 'https://api.test/monitor/pulse',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  reporter.record({
    rule: {
      id: 'PS-CVE-2026-0002',
      rule_v2: Array.from({ length: 40 }, (_, i) => ({
        parameter: `post.field_${i}`,
        match: { type: 'contains', value: 'x' },
      })),
    },
    phase: 'request',
    mode: 'block',
    // A long route AND more query parameters than one event carries, so every field that appears only
    // when something was shortened is actually produced here.
    path: `/${'a'.repeat(400)}?${Array.from({ length: 25 }, (_, i) => `k${i}=v${i}`).join('&')}`,
  } as never);
  reporter.flush();
  await vi.waitFor(() => expect(raw).not.toBe(''));

  return (JSON.parse(raw).detections as Array<Record<string, unknown>>)[0];
}

/**
 * One detection carrying real evidence, taken the way the runtime takes it.
 *
 * The rule names two of the sentinels below and not the others, so the payload is the boundary itself:
 * what a plan permits, against everything planted beside it.
 */
async function captureBearingPayload(): Promise<string> {
  const rule = {
    id: 'PS-CVE-2026-0003',
    rule_v2: [
      { parameter: 'post.title', match: { type: 'contains', value: 'SENTINEL' } },
      { parameter: 'cookie.session', match: { type: 'contains', value: 'SENTINEL' } },
    ],
  };
  const req: any = {
    method: 'POST',
    url: '/checkout/confirm?token=SENTINEL-QUERY-VALUE',
    originalUrl: '/checkout/confirm?token=SENTINEL-QUERY-VALUE',
    headers: { 'content-type': 'application/json', authorization: 'SENTINEL-HEADER-VALUE' },
    query: {},
    body: { title: 'SENTINEL-NAMED-FIELD', secret: 'SENTINEL-UNNAMED-FIELD' },
    cookies: { session: 'SENTINEL-NAMED-COOKIE' },
    _rawBody: 'SENTINEL-REQUEST-BODY',
    _response: { status: 200, body: 'SENTINEL-RESPONSE-BODY', headers: {} },
  };

  const resolver = new RequestResolver({ ...req, ...normalizeRequest(req) });
  const plan = derivePlan(rule);
  const capture = { plan: planReference(plan), ...captureValues(plan, resolver) };

  let raw = '';
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    raw = String(init.body);

    return new Response('{}', { status: 202 });
  });
  const reporter = createDetectionReporter({
    siteUuid: 'site-contract',
    baseUrl: 'https://api.test/monitor/pulse',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  reporter.record({ rule, phase: 'request', mode: 'block', path: req.originalUrl, capture } as never);
  reporter.flush();
  await vi.waitFor(() => expect(raw).not.toBe(''));

  return raw;
}

describe('the detection payload matches what AGENT-INSTALL.md says about it', () => {
  it('describes every field it emits', async () => {
    const { body } = await capturePayload();
    const truncatedDetection = await captureTruncatedPayload();
    // Every payload the reporter can emit, merged: a field that appears only when evidence is captured
    // would otherwise sit outside this check, which is how an undisclosed field ships.
    const withEvidence = (JSON.parse(await captureBearingPayload()).detections as any[])[0];
    const detection = {
      ...(body.detections as Array<Record<string, unknown>>)[0],
      ...truncatedDetection,
      ...withEvidence,
    };

    expect(Object.keys(withEvidence), 'a capture-bearing payload names its evidence').toContain('capture');

    // The conditional fields are only conditional; they still have to be produced somewhere.
    expect(Object.keys(truncatedDetection), 'a shortened payload names what it shortened').toContain(
      'truncated',
    );
    expect(Object.keys(truncatedDetection)).toContain('parameters_total');
    expect(Object.keys(truncatedDetection), 'and a shortened query list names its total').toContain(
      'query_keys_total',
    );

    for (const key of Object.keys(detection)) {
      const pattern = FIELD_DISCLOSURE[key];
      expect(
        pattern,
        `The payload emits "${key}" and nothing in FIELD_DISCLOSURE covers it. Describe it in ` +
          `AGENT-INSTALL.md and map it here — or establish that it should not be sent.`,
      ).toBeDefined();
      expect(disclosure, `AGENT-INSTALL.md must describe the "${key}" field`).toMatch(pattern);
    }

    for (const key of Object.keys(body)) {
      const pattern = ENVELOPE_DISCLOSURE[key];
      expect(pattern, `The batch envelope carries "${key}" with no entry in ENVELOPE_DISCLOSURE.`).toBeDefined();
      expect(disclosure, `AGENT-INSTALL.md must describe the "${key}" envelope field`).toMatch(pattern);
    }
  });

  it('emits the fields it claims to, not a subset', async () => {
    // The vacuity control for the check above: it iterates over the payload's keys, so a reporter that
    // emitted nothing would satisfy it perfectly while the disclosure described a payload that no longer
    // exists. Every documented field has to actually be there.
    const { body } = await capturePayload();
    const detection = (body.detections as Array<Record<string, unknown>>)[0];

    const expected = Object.keys(FIELD_DISCLOSURE).filter(
      (key) => !CONDITIONAL_FIELDS.has(key) || key in detection,
    );

    expect(Object.keys(detection).sort()).toEqual(expected.sort());
    // And the conditional field is absent for the right reason, not missing by accident.
    if (!('client_ip' in detection)) expect(detection.client_ip_source).toBe('unavailable');
    expect(Object.keys(body).sort()).toEqual(Object.keys(ENVELOPE_DISCLOSURE).sort());
  });

  it('sends parameter identifiers, including their request region', async () => {
    // The half the disclosure got wrong: these names ARE sent, and they say which region they read. A
    // test that only checked for absent values would have agreed with the incorrect wording.
    const { body } = await capturePayload();
    const detection = (body.detections as Array<Record<string, unknown>>)[0];

    expect(detection.parameters).toContain('cookie.session');
    expect(detection.parameters).toContain('server.HTTP_AUTHORIZATION');
    expect(disclosure, 'the disclosure must say identifiers name their request region').toMatch(/request region/i);
  });

  it('sends the values its rule named, so the exclusions below mean something', async () => {
    const raw = await captureBearingPayload();

    for (const { what, sentinel } of VALUE_INCLUSIONS) {
      expect(raw, `${what} is what the rule was written to inspect`).toContain(sentinel);
    }
  });

  it('excludes every value it promises to exclude', async () => {
    // Driven through the real plan and the real extractor, with a rule that names two fields and not the
    // rest. A list of absences taken from a payload where capture never ran would prove nothing.
    const raw = await captureBearingPayload();

    for (const { what, sentinel, disclosed } of VALUE_EXCLUSIONS) {
      expect(raw, `${what} must not reach the wire`).not.toContain(sentinel);
      expect(disclosure, `AGENT-INSTALL.md must promise that ${what} is excluded`).toMatch(disclosed);
    }
  });

  it('excludes them from a detection carrying no evidence at all, too', async () => {
    const { raw } = await capturePayload();

    for (const { sentinel } of VALUE_EXCLUSIONS) expect(raw).not.toContain(sentinel);
  });

  it('keeps the route while dropping the query string, rather than dropping both', async () => {
    // The control for the query-string sentinel: a reporter that sent no route at all would pass the
    // exclusion check while losing the field the disclosure describes.
    const { body } = await capturePayload();
    const detection = (body.detections as Array<Record<string, unknown>>)[0];

    expect(detection.route).toBe('/checkout/confirm');
  });
});
