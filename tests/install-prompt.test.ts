import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The install prompt exists in three places and all three must be the same text.
 *
 * `field-test/prompt.txt` is the copy the field-test harness runs an agent against, and
 * `README.md` / `GETTING-STARTED.md` are the copies a user actually pastes. When they
 * differ, the docs advertise one prompt while the gate measures another, and a green gate
 * says nothing about the wording anybody will use. Nothing else in the tree notices that,
 * because each file is valid on its own.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

/** The blockquoted prompt in a markdown doc, without its `> ` marker. */
function quotedPrompt(relative: string): string {
  const quoted = read(relative)
    .split('\n')
    .filter((line) => line.startsWith('> I have vetted'));

  expect(quoted, `expected exactly one install-prompt blockquote in ${relative}`).toHaveLength(1);
  return quoted[0].slice(2);
}

describe('the install prompt', () => {
  const tested = read('field-test/prompt.txt').trim();

  it('is long enough to be the prompt at all', () => {
    // Guards the assertions below: two empty strings match each other.
    expect(tested.length).toBeGreaterThan(200);
  });

  it('is what README.md tells people to paste', () => {
    expect(quotedPrompt('README.md')).toBe(tested);
  });

  it('is what GETTING-STARTED.md hands a teammate', () => {
    expect(quotedPrompt('GETTING-STARTED.md')).toBe(tested);
  });

  it('closes by asking the assistant to tell the user to refresh', () => {
    // The install ends on a page that loaded before the widget tag existed. The CLI cannot
    // reload the user's browser, so the assistant relaying this is the whole mechanism.
    expect(tested).toMatch(/refresh the preview/i);
    expect(tested).toContain('Report a vulnerability');
  });

  it('asks for a deploy reminder without authorizing a deploy', () => {
    // A live site keeps serving its previous build, so the user has to deploy — but an
    // assistant that reads this as permission to ship would be a side effect nobody asked for.
    expect(tested).toMatch(/remind me to deploy/i);
    expect(tested).toMatch(/do not deploy anything yourself/i);
  });
});
