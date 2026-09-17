import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A coding tool can refuse to execute this CLI until the person adds a permission rule for it, and the
 * shipped docs carry the way through: the agent stops and hands the command over, and the person runs it,
 * approves it once, or adds the rule. That path holds only while every copy of the rule is the same text
 * and the docs tell the agent to write the command in the form the rule matches. A rule the README
 * recommends and AGENT-INSTALL.md spells differently sends the person to configure one thing while the
 * agent runs another, and the refusal comes back with no explanation.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

/** The allow rules the docs hand to a Claude Code user, verbatim. */
const RULES = ['Bash(npx @patchstack/connect *)', 'Bash(npx --yes @patchstack/connect *)'];

const HANDOFF_HEADING = '## When your tool will not run this CLI';
const README_HEADING = '### If your coding tool blocks the command';

/** One markdown section: from its heading to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `${heading} should exist`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)![0].length;
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return heading + (next === -1 ? rest : rest.slice(0, next));
}

describe('the permission handoff', () => {
  const docs = {
    'AGENT-INSTALL.md': read('AGENT-INSTALL.md'),
    'README.md': read('README.md'),
    'GETTING-STARTED.md': read('GETTING-STARTED.md'),
  };
  const handoff = section(docs['AGENT-INSTALL.md'], HANDOFF_HEADING);
  const readmeSection = section(docs['README.md'], README_HEADING);

  it('tells the agent to stop rather than route around the refusal', () => {
    // Each of these runs the declined command anyway, with the person's decision removed.
    expect(handoff).toMatch(/Stop at the refused command/);
    expect(handoff).toMatch(/do not call the Patchstack API\s+yourself/i);
    expect(handoff).toMatch(/do not wrap the command in a `package\.json` script/i);
    expect(handoff).toMatch(/do not add\s+the `postinstall` \/ `prebuild` hooks first/i);
  });

  it('hands the person the shell-mode command and the rules', () => {
    expect(handoff).toContain('! npx @patchstack/connect setup');
    for (const rule of RULES) expect(handoff).toContain(rule);
  });

  it('names the command forms the rules do not cover', () => {
    // These are the spellings an agent reaches for on its own. A rule matches the command text as written,
    // so none of them is covered, and a person who added the rule would meet the refusal again.
    for (const form of [
      './node_modules/.bin/patchstack-connect',
      'PATCHSTACK_ENVIRONMENT=sandbox npx',
      'npx --yes patchstack-connect setup',
    ]) {
      expect(handoff, `AGENT-INSTALL.md must name ${form} as uncovered`).toContain(form);
    }
    expect(readmeSection).toContain('./node_modules/.bin/patchstack-connect');
    expect(readmeSection).toContain('PATCHSTACK_ENVIRONMENT=sandbox');
  });

  it('says how to verify from files when the tool will not run guide or status either', () => {
    // Without these the agent either guesses at the state or invents a dashboard link.
    expect(handoff).toMatch(/`siteUuid` in\s+`\.patchstackrc\.json`/);
    expect(handoff).toMatch(/`patchstack-connect scan` and\s+`patchstack-connect mark-build` in the `package\.json` scripts/);
    expect(handoff).toMatch(/`patchstack-widget\.js` in the root shell/);
    expect(handoff).toMatch(/`\.patchstackrc\.local\.json` in\s+`\.gitignore`/);
    expect(handoff).toMatch(/Never construct a dashboard link yourself/);
  });

  it('carries the same rules in every copy', () => {
    for (const [name, text] of Object.entries(docs)) {
      for (const rule of RULES) expect(text, `${name} must carry ${rule}`).toContain(rule);
    }
  });

  it('recommends no other Bash rule shape anywhere', () => {
    // A broader rule such as Bash(npx *) approves every npx command; a narrower or differently spelled one
    // does not match what the docs tell the agent to run. Either drift is a rule that is not one of the two.
    for (const [name, text] of Object.entries(docs)) {
      const found = [...text.matchAll(/Bash\([^)]*\)/g)].map((m) => m[0]);
      expect(found.length, `${name} should carry the rules at all`).toBeGreaterThan(0);
      expect(new Set(found), `${name} recommends a rule that is not one of the two`).toEqual(new Set(RULES));
    }
  });

  it('is reachable from the rules list', () => {
    const rules = section(docs['AGENT-INSTALL.md'], '## Rules');
    expect(rules).toMatch(/Never work around a permission refusal/);
    expect(rules).toContain(HANDOFF_HEADING.replace('## ', ''));
  });

  it('points at README sections that exist, for the other tools', () => {
    const title = README_HEADING.replace('### ', '');
    expect(handoff).toContain(`"${title}"`);
    expect(docs['GETTING-STARTED.md']).toContain(`"${title}"`);
    expect(readmeSection).toContain('~/.gemini/policies/');
    expect(readmeSection).toContain('commandPrefix = "npx @patchstack/connect"');
    expect(readmeSection).toContain('"npx @patchstack/connect *": "allow"');
  });
});
