import { describe, expect, it, vi } from 'vitest';
import { createDetectionReporter } from '../../src/protect/detections.js';
import { ACTIONS } from '../../src/protect/rules/contract.js';

/**
 * What KIND of match a detection was, on the wire.
 *
 * Three facts travel: the phase it happened in, the class of thing the rule is for, and what the rule
 * DECLARES it does about it. None of them is `enforced`, which is whether it actually did.
 *
 * The declared action and the enforced state are independent, and a dry-run window is exactly where
 * they differ: every rule in it declares an action and enforces nothing. Reading either off the other
 * would describe such a window as protection that never happened, or as a fleet of rules that do
 * nothing.
 *
 * Nothing is filled in. A rule that declares no class is reported as declaring none, because "this rule
 * is for secret exposure" and "we cannot say what this rule is for" are different facts and only one of
 * them is available.
 *
 * Both are read from the RULE. A detection also carries a top-level `category` copied from the rule at
 * each site that raises one, and reading that copy would make this report depend on every one of those
 * copies staying right — a site that set it from something else would report a class the rule does not
 * have, indistinguishably from a correct report.
 */
function reporterWith(overrides: Record<string, unknown> = {}) {
  const posts: Array<{ url: string; body: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });

    return new Response('{}', { status: 202 });
  });
  const reporter = createDetectionReporter({
    siteUuid: 'site-1',
    baseUrl: 'https://x.test/monitor/pulse',
    rulesEtag: '"v7"',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });

  return { reporter, posts };
}

const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One reported event, from one recorded detection. */
async function reported(detection: Record<string, unknown>) {
  const { reporter, posts } = reporterWith();
  reporter.record({ phase: 'response', mode: 'dry-run', path: '/x', ...detection } as any);
  reporter.flush();
  await drain();

  return posts[0].body.detections[0];
}

const ruleWith = (extra: Record<string, unknown> = {}) => ({
  id: 'pulse-1',
  rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'x' } }],
  ...extra,
});

describe('the classification on the wire', () => {
  it('reports the phase, the category and the declared action', async () => {
    const event = await reported({
      rule: ruleWith({ category: 'secret-exposure', action: 'redact' }),
    });

    expect(event.phase).toBe('response');
    expect(event.category).toBe('secret-exposure');
    expect(event.action).toBe('redact');
  });

  it('reports a declared action that did not act', async () => {
    // The state a dry-run window consists of, and the reason these are two fields.
    const event = await reported({
      rule: ruleWith({ category: 'info-exposure', action: 'block' }),
      mode: 'dry-run',
    });

    expect(event.action).toBe('block');
    expect(event.enforced).toBe(false);
  });

  it('reports the same declared action when it did act', async () => {
    // The control: the declared action does not change with the mode. Only `enforced` does.
    const event = await reported({
      rule: ruleWith({ category: 'info-exposure', action: 'block' }),
      mode: 'block',
    });

    expect(event.action).toBe('block');
    expect(event.enforced).toBe(true);
  });

  it('reports null for a rule that declares no class', async () => {
    // Never a guess. A filled-in value would take away the distinction between a rule whose class is
    // known and one whose class nobody can state.
    const event = await reported({ rule: ruleWith() });

    expect(event.category).toBeNull();
    expect(event.action).toBeNull();
  });

  it('reports each field independently of the other', async () => {
    // A rule may declare one and not the other, and each has to travel on its own account.
    const onlyCategory = await reported({ rule: ruleWith({ category: 'ssrf' }) });
    expect(onlyCategory.category).toBe('ssrf');
    expect(onlyCategory.action).toBeNull();

    const onlyAction = await reported({ rule: ruleWith({ action: 'encode' }) });
    expect(onlyAction.category).toBeNull();
    expect(onlyAction.action).toBe('encode');
  });

  it('drops and marks a real category that is too long to carry', async () => {
    // A slug, and one character past what the receiving contract accepts. Not shortened —
    // `secret-exposure` cut short is a different class, and one sent as a class would be a category
    // nobody authored, counted beside real ones. So it travels as absent, and marked, because there was
    // a class here and it could not be carried.
    const event = await reported({ rule: ruleWith({ category: 'c'.repeat(65) }) });

    expect(event.category).toBeNull();
    expect(event.truncated).toContain('category');
  });

  it('marks nothing for an over-length value that was never a category', async () => {
    // The mark is a claim about a class that existed. Applied to nonsense that happens to be long, it
    // reports "there was a class here that would not fit" — about something that was never a class, and
    // with nothing in the report to show the claim is false.
    const event = await reported({ rule: ruleWith({ category: 'C'.repeat(65) }) });

    expect(event.category).toBeNull();
    expect(event.truncated).toBeUndefined();
  });

  it('marks nothing for an over-length action, because no action is long', async () => {
    // Every action the contract names is short, so an over-length one is not an action at any length.
    // Only the category can reach recognised-but-too-long.
    const event = await reported({ rule: ruleWith({ action: 'a'.repeat(65) }) });

    expect(event.action).toBeNull();
    expect(event.truncated).toBeUndefined();
  });

  it('carries a category at exactly the accepted length', async () => {
    // The boundary in the direction that must still work: a bound one character tight would silently
    // drop the longest legitimate category. Category only — no action in the vocabulary is this long,
    // so pinning a 64-character action would pin a value the receiver refuses.
    const event = await reported({ rule: ruleWith({ category: 'c'.repeat(64) }) });

    expect(event.category).toBe('c'.repeat(64));
    expect(event.truncated).toBeUndefined();
  });

  it('carries every action the rule contract names', async () => {
    // The vocabulary is imported rather than restated here, so this cannot drift from it: a list
    // written out in this file would pass while the one in the reporter fell behind.
    for (const action of ACTIONS) {
      const event = await reported({ rule: ruleWith({ action }) });
      expect(event.action, `contract action "${action}"`).toBe(action);
      expect(event.truncated, `contract action "${action}"`).toBeUndefined();
    }
  });

  it('reports nothing for a class the receiver would not recognise', async () => {
    // These are short enough to fit and would have travelled as though known, then been filed as
    // missing at the far end — arriving looking like a class while counting as the absence of one.
    //
    // Unmarked, because nothing was lost in transit: the mark distinguishes "declared something we
    // could not carry" from "declared nothing", and an unrecognisable value is neither.
    for (const category of ['unknown', 'Uppercase', 'has spaces', '-leading-dash', '9leading-digit']) {
      const event = await reported({ rule: ruleWith({ category }) });
      expect(event.category, `category ${JSON.stringify(category)}`).toBeNull();
      expect(event.truncated, `category ${JSON.stringify(category)}`).toBeUndefined();
    }

    for (const action of ['obliterate', 'BLOCK', 'redact ', 'unknown']) {
      const event = await reported({ rule: ruleWith({ action }) });
      expect(event.action, `action ${JSON.stringify(action)}`).toBeNull();
      expect(event.truncated, `action ${JSON.stringify(action)}`).toBeUndefined();
    }
  });

  it('reports the rule when a copied class disagrees with it', async () => {
    // The detection's own `category` is a copy made where the detection was raised. The rule is what
    // declares the class, so the rule wins — otherwise a wrong copy reports a class the rule does not
    // have, and there is nothing in the report to show it happened.
    const event = await reported({
      rule: ruleWith({ category: 'secret-exposure', action: 'redact' }),
      category: 'something-else-entirely',
    });

    expect(event.category).toBe('secret-exposure');
  });

  it('reports nothing for a rule that declares no class, whatever the copy says', async () => {
    // The same, in the direction that would invent a class rather than mis-state one.
    const event = await reported({ rule: ruleWith(), category: 'invented-by-the-caller' });

    expect(event.category).toBeNull();
  });

  it('marks nothing when the class fits', async () => {
    // The other half: `truncated` present at all is a claim, so it must not appear for a short value.
    const event = await reported({
      rule: ruleWith({ category: 'secret-exposure', action: 'redact' }),
    });

    expect(event.truncated).toBeUndefined();
  });

  it('puts no rule text on the wire beyond the class', async () => {
    // The rule object reaches the reporter whole. Only its identity and its declared class may travel;
    // a match value or a pattern must not, and the serialized payload is what is scanned rather than
    // the object built, so a field added later fails here.
    const { reporter, posts } = reporterWith();
    reporter.record({
      phase: 'response',
      mode: 'dry-run',
      path: '/x',
      rule: ruleWith({
        category: 'secret-exposure',
        action: 'redact',
        title: 'A title nobody asked for',
        rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'SUPERSECRET' } }],
      }),
    } as any);
    reporter.flush();
    await drain();

    const wire = JSON.stringify(posts[0].body);
    expect(wire).not.toContain('SUPERSECRET');
    expect(wire).not.toContain('A title nobody asked for');
  });
});
