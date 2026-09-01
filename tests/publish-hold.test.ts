import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The publication hold is a gate, not a note.
 *
 * A pull-request description is read once and by one person; a file the release workflows refuse to run
 * past is read by every attempt to publish. This asserts the gate exists and is wired into both paths that
 * can publish, because a gate someone can delete without noticing is the same as no gate.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = (name: string) => readFileSync(`${root}.github/workflows/${name}`, 'utf8');
const holdPath = `${root}.publish-hold`;

describe('the publication hold', () => {
  it.each(['publish.yml', 'release.yml'])('is checked by %s before anything else runs', (name) => {
    const text = workflow(name);

    // Before any step that could tag, publish or otherwise act: a hold honoured after the fact is not a
    // hold. Checkout has to come first, since the file has to be on disk to be read.
    const steps = [...text.matchAll(/^ {6}- name: (.+)$/gm)];
    const holdAt = steps.findIndex((m) => /hold/i.test(m[1]));

    expect(holdAt, `${name} must have a hold step`).toBeGreaterThan(-1);
    expect(holdAt, 'and it must be the first thing after checkout').toBe(1);

    // Scoped to THAT step's own body. `exit 1` appears elsewhere in these files, so a whole-file match
    // would pass for a hold step that printed a warning and carried on.
    const body = text.slice(steps[holdAt].index, steps[holdAt + 1]?.index ?? text.length);

    expect(body, 'the hold must read the file').toMatch(/\.publish-hold/);
    expect(body, 'and must fail the run rather than warn').toMatch(/exit 1/);
  });

  it('states both server-side blockers while it exists', () => {
    if (!existsSync(holdPath)) return; // Lifted, which is the point of it being a file.

    const hold = readFileSync(holdPath, 'utf8');

    // The two reasons this package cannot be published yet. Named in the file rather than only in a pull
    // request, so whoever lifts the hold is the person who read them.
    expect(hold, 'idempotency deduplication').toMatch(/Idempotency-Key/);
    expect(hold, 'payload compatibility').toMatch(/capture/);
    expect(hold, 'and the new baseline fields').toMatch(/query_keys/);
    expect(hold, 'must say how to lift it').toMatch(/Remove this file/i);
  });

  it('is not shipped to anyone who installs the package', () => {
    // It is a note to this repository, not to a consumer. `files` in package.json is an allowlist, so the
    // check is that the hold is not named in it.
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));

    expect(pkg.files, 'package.json must use a files allowlist').toBeInstanceOf(Array);
    expect(pkg.files.some((entry: string) => entry.includes('publish-hold'))).toBe(false);
  });
});
