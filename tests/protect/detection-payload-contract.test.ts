import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDetectionReporter } from '../../src/protect/detections.js';

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
  parameters: /parameter names/i,
  phase: /which phase matched/i,
  enforced: /whether it was enforced/i,
  rules_etag: /identifier of the rule bundle/i,
  rule_revision: /revision of the rule/i,
  detected_at: /timestamp/i,
};

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
  { what: 'the value that matched', sentinel: 'SENTINEL-MATCHED-VALUE', disclosed: /value that matched|matched value/i },
  { what: 'the request body', sentinel: 'SENTINEL-REQUEST-BODY', disclosed: /request body/i },
  { what: 'a header value', sentinel: 'SENTINEL-HEADER-VALUE', disclosed: /header/i },
  { what: 'a cookie value', sentinel: 'SENTINEL-COOKIE-VALUE', disclosed: /cookie/i },
  { what: 'a query-string value', sentinel: 'SENTINEL-QUERY-VALUE', disclosed: /query.string|query string/i },
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

describe('the detection payload matches what AGENT-INSTALL.md says about it', () => {
  it('describes every field it emits', async () => {
    const { body } = await capturePayload();
    const detection = (body.detections as Array<Record<string, unknown>>)[0];

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

    expect(Object.keys(detection).sort()).toEqual(Object.keys(FIELD_DISCLOSURE).sort());
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

  it('excludes every value it promises to exclude', async () => {
    const { raw } = await capturePayload();

    for (const { what, sentinel, disclosed } of VALUE_EXCLUSIONS) {
      expect(raw, `${what} must not reach the wire`).not.toContain(sentinel);
      expect(disclosure, `AGENT-INSTALL.md must promise that ${what} is excluded`).toMatch(disclosed);
    }
  });

  it('keeps the route while dropping the query string, rather than dropping both', async () => {
    // The control for the query-string sentinel: a reporter that sent no route at all would pass the
    // exclusion check while losing the field the disclosure describes.
    const { body } = await capturePayload();
    const detection = (body.detections as Array<Record<string, unknown>>)[0];

    expect(detection.route).toBe('/checkout/confirm');
  });
});
