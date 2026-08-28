import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The published source maps: present, usable, and without the source text embedded.
 *
 * Maps are what turn a customer's stack trace into a file and a line. Dropping the embedded
 * `sourcesContent` keeps that and roughly quarters the published package, because the source text it
 * duplicates is already public in this repository at the tag matching the version the CLI reports.
 *
 * Two separate build steps produce maps — `tsup.config.ts` for the three main artifacts and
 * `scripts/build-edge.mjs` for the edge bundle — so the setting exists in two places and can be added to
 * one. These assertions are over the ARTIFACTS rather than the configuration for that reason: a new entry
 * point added to either builder is covered without anyone remembering to update a list.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

// `dist/` is gitignored and built on publish, so a plain checkout has nothing to assert against. CI builds
// before it tests, which is what makes these run there rather than returning green having checked nothing.
const built = existsSync(dist);

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe.skipIf(!built)('published source maps', () => {
  // Everything in `dist/` ships, so enumerating it is the same set as enumerating the tarball — without
  // running `npm pack`, which would rebuild. Pinned so the equivalence stops holding loudly.
  it('ships the whole of dist, which is what makes the checks below equivalent to the tarball', () => {
    expect(manifest.files).toContain('dist');
  });

  const artifacts = readdirSync(dist).filter((f) => /\.(js|cjs)$/.test(f));
  const maps = readdirSync(dist).filter((f) => f.endsWith('.map'));

  it('has artifacts and maps to check', () => {
    // A guard against the whole suite passing vacuously if the build layout changes.
    expect(artifacts.length).toBeGreaterThan(3);
    expect(maps.length).toBeGreaterThan(3);
  });

  it('gives every published JavaScript artifact a map', () => {
    // Including the chunks. A stack frame landing in an unmapped chunk is the case where a report says
    // "somewhere in the bundle", which is the state maps exist to avoid.
    const unmapped = artifacts.filter((f) => !existsSync(join(dist, `${f}.map`)));

    expect(unmapped).toEqual([]);
  });

  it('points each artifact at its map', () => {
    // A map on disk that nothing references is not a map anybody will use.
    const missingComment = artifacts.filter(
      (f) => !/# sourceMappingURL=.+\.map\s*$/.test(readFileSync(join(dist, f), 'utf8').trimEnd()),
    );

    expect(missingComment).toEqual([]);
  });

  it('gives every map real mappings and real sources', () => {
    // The failure this catches is a map that exists and resolves nothing — indistinguishable from a
    // working map until someone needs it.
    const broken = maps.filter((f) => {
      const map = JSON.parse(readFileSync(join(dist, f), 'utf8'));

      return (
        typeof map.mappings !== 'string' ||
        map.mappings.length === 0 ||
        !Array.isArray(map.sources) ||
        map.sources.length === 0
      );
    });

    expect(broken).toEqual([]);
  });

  it('embeds no source text in any map', () => {
    // The decision being enforced. Asserted over every map because the setting lives in two build files:
    // adding an entry point to one builder and not the other would otherwise reintroduce it quietly.
    const withSources = maps.filter((f) => {
      const map = JSON.parse(readFileSync(join(dist, f), 'utf8'));

      return map.sourcesContent !== undefined;
    });

    expect(withSources).toEqual([]);
  });

  it('resolves a real stack frame to the source file and line that threw', () => {
    // The check that matters, and the only one that would notice a map whose mappings are present but
    // wrong. `resolveConfig` rejects a malformed site UUID by throwing from `src/config.ts` through a
    // public export, so this is a frame a support conversation could actually produce.
    //
    // The assertion is not on a line NUMBER — that would break on any edit above the throw, and pinning it
    // would say nothing about accuracy. Instead the resolved line is read back out of the source, so the
    // map has to land on the statement that actually threw.
    const dir = mkdtempSync(join(tmpdir(), 'ps-maps-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(dir, 'probe.mjs'),
      `import { resolveConfig } from ${JSON.stringify(join(dist, 'index.js'))};\n` +
        `try {\n` +
        `  await resolveConfig({ cwd: ${JSON.stringify(dir)}, cliSiteUuid: 'not-a-uuid' });\n` +
        `  console.log('NO_THROW');\n` +
        `} catch (error) {\n` +
        `  console.log(error.stack);\n` +
        `}\n`,
    );

    // Node's own source-map consumer, so what is tested is the map working for the tool a reporter uses.
    const run = spawnSync(process.execPath, ['--enable-source-maps', join(dir, 'probe.mjs')], {
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });

    expect(run.stdout).not.toContain('NO_THROW');

    const frame = run.stdout.split('\n').find((line) => line.includes('src/config.ts'));
    expect(frame, `no src/config.ts frame in:\n${run.stdout}\n${run.stderr}`).toBeDefined();

    const [, lineNumber] = /src\/config\.ts:(\d+):/.exec(frame ?? '') ?? [];
    expect(lineNumber).toBeDefined();

    const source = readFileSync(join(root, 'src', 'config.ts'), 'utf8').split('\n');
    // The resolved line, plus the one after it: the throw spans several lines and the frame may point at
    // either the `throw` or the constructor call on it.
    const resolved = `${source[Number(lineNumber) - 1]}${source[Number(lineNumber)] ?? ''}`;

    expect(resolved).toContain('PatchstackError');
  });
});
