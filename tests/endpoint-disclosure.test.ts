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

/**
 * Endpoints the package can reach, and the wording that counts as describing each one.
 *
 * `files` is required for any key that is a BARE SEGMENT rather than a rooted path, and there is a
 * meta-assertion below enforcing that. A bare segment is ambiguous by construction — `detections` is an
 * endpoint here and could be a filename somewhere else — so it may only be recognised where it was
 * actually established, never globally.
 */
const DISCLOSED_AS: Record<string, { doc: RegExp; files?: string[] }> = {
  'monitor/pulse/manifest': { doc: /manifest/i },
  'monitor/pulse/rules': { doc: /monitor\/pulse\/rules|pulse rules/i },
  'monitor/pulse/input-map': { doc: /input-map/i },
  // Built from the resolved Pulse base rather than a literal path, which is why the second extraction
  // pattern exists — and why the first version of this file could not see it.
  detections: { doc: /monitor\/pulse\/detections/i, files: ['src/protect/detections.js'] },
  'monitor/pulse/package-removed': { doc: /package-removed|package removal/i },
  'monitor/pulse/token': { doc: /short-lived token|pulse\/token/i },
  'monitor/widget/settings': { doc: /monitor\/widget\/settings/i },
  'monitor/claim': { doc: /claim/i },
  'oauth/token': { doc: /oauth\/token/i },
  'api/logs/log': { doc: /logs\/log/i },
  'api/get-rules/3': { doc: /get-rules/i },
  // The RFC 8628 login flow, documented by showing the approval URL the command prints.
  device: { doc: /monitor\/pulse\/device/i, files: ['src/login.ts'] },

  // The same endpoints again, reached through an interpolated base rather than a literal path. Listing
  // them as bare segments is not duplication: it is the second identity each one has in the source, and
  // the classification has to hold for both or the check is only as good as the spelling it happened to
  // meet first.
  'input-map': { doc: /input-map/i, files: ['src/client.ts'] },
  'package-removed': { doc: /package-removed|package removal/i, files: ['src/client.ts'] },
  // `rules` is BOTH: an endpoint here, and a file the scaffolder writes (see NOT_AN_ENDPOINT). Exactly
  // the collision that makes global classification unsafe — and both readings are correct, because each
  // is tied to the files that establish it.
  rules: {
    doc: /monitor\/pulse\/rules|pulse rules/i,
    files: ['src/client.ts', 'src/protect/engine/pulse-client.js'],
  },
  token: { doc: /short-lived token|pulse\/token/i, files: ['src/pulse-token.ts'] },
};

/**
 * Path-shaped strings that are not endpoints of ours, scoped to the files that establish them.
 *
 * Scoped, because the justification is about a call site and not about a word. `rules` is a file the
 * scaffolder writes — in the scaffolder. A future `${pulseBase}/rules/${uuid}` request would produce the
 * same candidate from a different file, and a globally-keyed exemption would wave a real endpoint through
 * as "not an endpoint". That is this file's own original mistake repeated one level up: an exemption
 * answering beyond the evidence that earned it.
 *
 * The granularity is the FILE, not the call site, and that is the remaining limit: an outbound request
 * added to a file that already exempts the same word would still be missed. Narrowing further needs real
 * parsing rather than patterns. What makes the residue small is that these exemptions live in scaffolder
 * modules, which write files and make no requests — an outbound call appearing in one is odd enough to
 * notice in review, which is the check this backstops rather than replaces.
 */
const NOT_AN_ENDPOINT: Record<string, { why: string; files: string[] }> = {
  'monitor/pulse': {
    why: 'the base path the per-site endpoints are built on, not an endpoint itself',
    files: ['src/login.ts', 'src/protect/detections.js', 'src/protect/engine/pulse-client.js'],
  },
  'api/tasks': {
    why: "a route in the demo's own throwaway app on localhost, used as the default exploit target",
    files: ['src/cli.ts', 'src/demo.ts'],
  },
  patchstack: {
    why: 'a directory in the target app that the scaffolder writes the guard into',
    files: ['src/protect/install/adapters/next.ts', 'src/protect/install/seam.ts'],
  },
  rules: {
    why: 'a file the scaffolder writes beside the guard in the target app',
    files: ['src/protect/install/generic.ts'],
  },
  guard: {
    why: 'the guard file the scaffolder writes into the target app',
    files: ['src/protect/install/generic.ts'],
  },
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
    // The interpolation is matched as ANY expression, not an identifier: the rules client builds its URL
    // from `${this.#baseUrl}`, and an identifier-only pattern silently skipped it — so a real endpoint
    // was invisible here for the same reason the earlier version missed the OAuth exchange. Recognising
    // one spelling of "a base URL" is not the same as recognising a base URL.
    for (const m of text.matchAll(/\$\{[^}]*\}\/([a-z][a-z0-9-]*)/g)) {
      if (!API_ROOTS.includes(m[1])) add(m[1], name);
    }
  }

  return found;
}

describe('shipped docs disclose every endpoint the package calls', () => {
  const agentInstall = readFileSync(join(root, 'AGENT-INSTALL.md'), 'utf8');

  it('classifies every path-shaped candidate, at every call site it appears in', () => {
    // Per OCCURRENCE, not per path. A classification earned in one file says nothing about the same
    // string appearing in another, and treating it as though it did is how a real endpoint would inherit
    // an unrelated template-path exemption.
    const unclassified: string[] = [];
    for (const [path, files] of candidates()) {
      for (const file of files) {
        const exempt = NOT_AN_ENDPOINT[path];
        if (exempt && exempt.files.includes(file)) continue;
        const disclosed = DISCLOSED_AS[path];
        if (disclosed && (disclosed.files === undefined || disclosed.files.includes(file))) continue;
        unclassified.push(`${path} (in ${file})`);
      }
    }

    expect(
      unclassified.sort(),
      'Unclassified occurrence(s). If the package can call it, describe it in AGENT-INSTALL.md and add ' +
        'the file to DISCLOSED_AS; if it is not an endpoint of ours, add the file to NOT_AN_ENDPOINT ' +
        'with the reason. An entry for the same string in another file does not cover this one.',
    ).toEqual([]);
  });

  it('requires a bare segment to name the files that establish it', () => {
    // The meta-assertion that keeps the scoping honest: a rooted path like `monitor/pulse/rules` cannot
    // collide with a scaffolder filename, but a bare `detections` or `rules` can. Any bare-segment entry
    // recognised globally would reopen exactly the hole this scoping closes.
    const unscoped = Object.entries(DISCLOSED_AS)
      .filter(([path, entry]) => !path.includes('/') && entry.files === undefined)
      .map(([path]) => path);

    expect(unscoped, 'bare-segment endpoints must declare `files`').toEqual([]);
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
    for (const [path, { doc }] of Object.entries(DISCLOSED_AS)) {
      expect(agentInstall, `AGENT-INSTALL.md must describe ${path}`).toMatch(doc);
    }
  });

  it('says what a detection report carries, and what it does not', () => {
    expect(agentInstall).toMatch(/reportDetections/);
    // Phrasing-tolerant, substance-strict: the claim has to be there, not any particular sentence.
    for (const claim of [
      /query string|query-string/i,
      /request body/i,
      // A report can carry the values of the parameters a rule names, so the doc has to say which values
      // and on what authority — an omission here reads as the older, narrower promise.
      /values of the parameters a rule names/i,
      /derived from the rule/i,
      /capture\.plan/,
    ]) {
      expect(agentInstall, `the payload description must address ${claim}`).toMatch(claim);
    }
  });

  it('states the limits on captured values, and that the limits report themselves', () => {
    // A bound nobody documents is a bound a reader cannot rely on, and a truncated capture that does not
    // say so invites a conclusion drawn from a sample.
    for (const claim of [
      /at most 10 values/i,
      /512 characters/i,
      /shortened to fit is marked|marked/i,
      /counted/i,
    ]) {
      expect(agentInstall, `the bounds must address ${claim}`).toMatch(claim);
    }
  });

  it('says the same thing in the shipped type declaration and the module it documents', () => {
    // `protect.d.ts` is copied into `dist/` and is what an editor shows a caller; the module docblock is
    // what a reader of the source sees. A privacy statement that is current in one place and stale in
    // another is worse than one stale everywhere, because the stale one still reads as authoritative.
    const shipped = [
      readFileSync(new URL('../src/protect/protect.d.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/protect/detections.js', import.meta.url), 'utf8'),
    ];

    for (const text of shipped) {
      expect(text, 'must not still promise that no values are sent').not.toMatch(
        /does NOT send the matched value|never carries: \*\*the matched value/i,
      );
      expect(text, 'must say which values do travel').toMatch(
        /values of the parameters the matched rule names|values of the parameters a rule names/i,
      );
      expect(text, 'must scope the exclusion to unnamed parameters').toMatch(
        /any (other )?parameter the matched rule does not name/i,
      );
      // The User-Agent travels whether or not a rule names it, so an absolute exclusion would be false.
      // Pinned in every place the claim is made, because a carve-out stated in one is not stated at all.
      expect(text, 'must carve out the baseline user agent').toMatch(
        /user.agent is the one exception|exception to the rule-scoped policy/i,
      );
    }
  });

  it('states the egress baseline separately, since it is a different baseline', () => {
    // An egress detection has no client and no user agent, and a single "every report carries" claim
    // would be false for it in both directions.
    expect(agentInstall, 'egress must have its own baseline').toMatch(
      /\*\*An egress detection\*\*/i,
    );
    expect(agentInstall, 'and must say it carries no client attribution').toMatch(
      /no user agent and no\s+client address/i,
    );
  });

  it('qualifies the query-value exclusion as being about baseline metadata', () => {
    // A rule naming `egress.url` captures that URL as it read it, query values included. An unqualified
    // "query values are never sent" would be false, in the direction that flatters us.
    expect(agentInstall, 'the qualification must be present').toMatch(
      /One qualification on the query string/i,
    );
    expect(agentInstall, 'and must name the case it covers').toMatch(
      /names `egress\.url`[^.]*query values included|query values included/i,
    );
  });

  it('states which sources can never be captured, however a rule is written', () => {
    // These are the refusals that hold regardless of what a rule names, so they are the ones a reader
    // most needs stated rather than inferred.
    expect(agentInstall, 'a whole-request read must grant nothing').toMatch(
      /reading `raw` or `all`[^.]*permits \*\*nothing/i,
    );
    expect(agentInstall, 'response values must never be captured').toMatch(
      /\*\*response\*\* values are never captured/i,
    );
    expect(agentInstall, 'raw bytes need a reviewed per-rule opt-in').toMatch(
      /raw request bytes\*\* need an explicit, reviewed opt-in/i,
    );
    expect(agentInstall, 'and the one header that always travels must be named').toMatch(
      /User-Agent\*\*\. It is part of the baseline|One header value always travels/i,
    );
    expect(agentInstall, 'and a parameter the rule does not name is never sent').toMatch(
      /never contains:\*\* the value of any parameter the matched rule does not name/i,
    );
  });

  it('separates parameter identifiers from values, and does not exclude what it sends', () => {
    // `ruleParameters` returns each condition's `parameter` verbatim, and those name a request region:
    // `cookie.session`, `server.HTTP_AUTHORIZATION`. So a rule inspecting a cookie or an Authorization
    // header sends that name. The exclusion list previously read "the matched value, the request body,
    // headers, cookies, or query-string values", which scans as "headers and cookies are not sent" —
    // true of their values, false of their names, and wrong in the direction that flatters us.
    expect(agentInstall, 'must say the identifiers carry their request region').toMatch(/request region/i);
    expect(agentInstall, 'must show a region-qualified example').toMatch(/cookie\.session/);
    expect(agentInstall, 'must show a header example, since that is the sensitive case').toMatch(/server\.HTTP_/);
    // The exclusion is now scoped to the parameters a rule does NOT name, since the ones it names may
    // have their values captured. A blanket "no values of any kind" would be the opposite overclaim to
    // the one this test was written for: understating what is sent rather than overstating it.
    expect(agentInstall, 'the exclusion must be scoped to unnamed parameters').toMatch(
      /the value of any parameter the matched rule does not name/i,
    );
    expect(agentInstall, 'and must not still claim no values are sent at all').not.toMatch(
      /no values of any kind/i,
    );

    // The regression itself: an exclusion clause that names headers or cookies without scoping to their
    // values. Asserted as an absence because the overclaim is a sentence someone would write again while
    // tightening the prose.
    const exclusion = /does not contain[^.]*?\b(headers|cookies)\b(?![^.]*\bvalue)/i;
    expect(agentInstall, 'headers/cookies may only be excluded as VALUES').not.toMatch(exclusion);
  });

  it('does not describe detection reporting as limited to non-blocking matches', () => {
    // The runtime records EVERY match, then additionally posts the enforced ones to the block log. Saying
    // only non-blocking detections are sent understates what leaves the app, which is the direction that
    // matters: a reader deciding whether to enable this is owed the larger number, not the smaller one.
    expect(agentInstall).toMatch(/every rule that matched/i);
  });
});
