import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import type { InputMap } from '../../src/map/types.js';

// Whether the app has a server side at all.
//
// The reason to answer it: an app with no server runtime cannot run a request guard, so its advisories are
// dependency and bundle hygiene rather than request-path risk. Saying that plainly is useful. Saying it
// wrongly is the worst output this analysis can produce — "nothing to protect here" on an app nobody could
// read — so most of this file is about the cases that must come back `unknown`.
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-surface-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
};
const mapOf = async (files: Record<string, string>): Promise<InputMap> => {
  const { map, error } = await buildInputMap(project(files));
  expect(error).toBeUndefined();
  return map!;
};
const stateOf = async (files: Record<string, string>) => (await mapOf(files)).serverSurface?.state;

const VITE_APP = {
  'package.json': JSON.stringify({ dependencies: { react: '18' }, devDependencies: { vite: '5' } }),
  'src/main.tsx': 'export const App = () => null;',
  'index.html': '<div id="root"></div>',
};

describe('a server runtime, when something positively shows one', () => {
  it('reports a recognized endpoint as a server runtime', async () => {
    expect(await stateOf({
      'package.json': JSON.stringify({ dependencies: { express: '4' } }),
      'src/server.js': `
        const express = require("express");
        const app = express();
        app.get("/items", (req, res) => res.json([]));
        module.exports = app;
      `,
    })).toBe('server-runtime-detected');
  });

  it('reports function source with no endpoint parsed as a runtime', async () => {
    // The case the evidence layer exists for: a handler this analysis cannot read still serves. The source
    // in a provider function directory says so, and that outweighs an empty endpoint list.
    expect(await stateOf({
      ...VITE_APP,
      'netlify.toml': '[build]\n  publish = "dist"',
      'netlify/functions/submit.ts': 'export default async () => new Response("ok")',
    })).toBe('server-runtime-detected');
  });

  it('reports a worker entry as a runtime, since that file IS the server', async () => {
    expect(await stateOf({
      ...VITE_APP,
      '_worker.js': 'export default { fetch: () => new Response("ok") }',
    })).toBe('server-runtime-detected');
  });

  it('carries the evidence that produced the state', async () => {
    const map = await mapOf({
      ...VITE_APP,
      'supabase/functions/notify/index.ts': 'Deno.serve(() => new Response("ok"))',
    });

    // A consumer has to be able to show WHY, not just display a badge.
    expect(map.serverSurface?.state).toBe('server-runtime-detected');
    expect(map.serverSurface?.evidence.map((e) => e.signal)).toContain('runtime-entry');
    expect(map.serverSurface?.evidence.find((e) => e.signal === 'runtime-entry')?.source)
      .toContain('supabase/functions');
  });
});

describe('a static build, only when one is named', () => {
  it('reports a static build for a client-only project', async () => {
    expect(await stateOf(VITE_APP)).toBe('static-build-detected');
  });

  it('recognizes the other common generators', async () => {
    expect(await stateOf({ 'package.json': JSON.stringify({ devDependencies: { 'react-scripts': '5' } }) }))
      .toBe('static-build-detected');
    expect(await stateOf({ 'package.json': JSON.stringify({ dependencies: { gatsby: '5' } }) }))
      .toBe('static-build-detected');
  });

  it('reads a real static SvelteKit project, which ships kit AND the adapter', async () => {
    // The package set people actually have. Treating `@sveltejs/kit` as an unconditional server dependency
    // made every genuine static SvelteKit app permanently `unknown`, and the test that appeared to cover
    // this installed the adapter with no kit — a combination nobody ships.
    expect(await stateOf({
      'package.json': JSON.stringify({
        devDependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-static': '3', vite: '5' },
      }),
    })).toBe('static-build-detected');

    // And kit without the static adapter stays undecided, because then it is a server framework.
    expect(await stateOf({
      'package.json': JSON.stringify({ devDependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-node': '5', vite: '5' } }),
    })).toBe('unknown');
  });

  it('does not read Vite as static when an SSR companion is installed', async () => {
    // Vite builds client-only apps and underpins several server frameworks, so `vite` alone is not a
    // static build. A companion that adds SSR vetoes the reading — conservative in the direction that
    // matters, since this state means "no request-path protection needed".
    expect(await stateOf({
      'package.json': JSON.stringify({ dependencies: { vike: '0.4' }, devDependencies: { vite: '5' } }),
    })).toBe('unknown');
    expect(await stateOf({
      'package.json': JSON.stringify({ devDependencies: { vite: '5', 'vite-plugin-ssr': '0.4' } }),
    })).toBe('unknown');
  });

  it('reads a Next project as static only when it exports statically', async () => {
    // Next ships both modes, so the dependency says nothing on its own.
    expect(await stateOf({ 'package.json': JSON.stringify({ dependencies: { next: '14' } }) }))
      .toBe('unknown');
    expect(await stateOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' }, scripts: { build: 'next build && next export' } }),
    })).toBe('static-build-detected');
    expect(await stateOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' } }),
      'next.config.js': "module.exports = { output: 'export' };",
    })).toBe('static-build-detected');
  });

  it('ignores output: export when it is only a comment, a string, or dead code', async () => {
    // A regex over the config text accepted all three, and each would have reclassified an ordinary
    // server-mode Next app as static — the direction that loses protection. The config is parsed instead:
    // comments never reach the AST, a string literal is one token, and only a value reachable from the
    // module's export counts.
    const commented = await stateOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' } }),
      'next.config.js': `
        // output: 'export'   <- we tried this and reverted
        /* const old = { output: 'export' }; */
        module.exports = { reactStrictMode: true };
      `,
    });
    expect(commented, 'a commented-out setting is not configuration').toBe('unknown');

    const stringified = await stateOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' } }),
      'next.config.js': `module.exports = { env: { NOTE: "output: 'export' is not set here" } };`,
    });
    expect(stringified, 'the words inside a string are not a setting').toBe('unknown');

    const deadCode = await stateOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' } }),
      'next.config.js': `
        const staticExample = { output: 'export' };
        module.exports = { reactStrictMode: true };
      `,
    });
    expect(deadCode, 'an object nobody exports is not this project’s config').toBe('unknown');

    // And the real thing still reads, including through a plugin wrapper and a named variable.
    expect(await stateOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' } }),
      'next.config.mjs': `const nextConfig = { output: 'export' };\nexport default nextConfig;`,
    })).toBe('static-build-detected');
    expect(await stateOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' } }),
      'next.config.js': `module.exports = withPlugins({ output: 'export' });`,
    })).toBe('static-build-detected');
  });

  it('follows an alias chain to the real config, and survives a cyclic one', async () => {
    // Chained aliases are ordinary in real configs, so the traversal has to follow them...
    expect(await stateOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' } }),
      'next.config.mjs': `const base = { output: 'export' };\nconst config = base;\nexport default config;`,
    })).toBe('static-build-detected');

    // ...and a malformed one must come back as an ordinary answer rather than an exception used as control
    // flow. Recursing until the stack gives out also discards any signal found before it.
    const cyclic = await mapOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' } }),
      'next.config.js': `const a = b;\nconst b = a;\nmodule.exports = a;`,
    });
    expect(cyclic.serverSurface?.state).toBe('unknown');
    expect(cyclic.coverage.notes.some((n) => n.includes('serverSurface'))).toBe(true);
  });

  it('does not list a static generator for a Next app that serves', async () => {
    // Two independent rules keep plain `next` out of `static-build-detected`: it is not counted as a static
    // generator, and it IS counted as a server dependency. Only the second decides the state, so mutating
    // the first changed nothing observable — which made the first rule untested rather than redundant.
    //
    // The evidence list is consumer-visible, and a `static-generator` signal in it invites "static build
    // detected" as a displayed reason for a state that says the opposite.
    const map = await mapOf({ 'package.json': JSON.stringify({ dependencies: { next: '14' } }) });
    const signals = map.serverSurface?.evidence ?? [];

    expect(map.serverSurface?.state).toBe('unknown');
    expect(signals.filter((e) => e.signal === 'static-generator')).toEqual([]);
    expect(signals.map((e) => e.source)).toContain('next');

    // And when it does export statically, the generator signal appears with the setting that proved it.
    const exported = await mapOf({
      'package.json': JSON.stringify({ dependencies: { next: '14' } }),
      'next.config.mjs': "export default { output: 'export' };",
    });
    expect(exported.serverSurface?.evidence.find((e) => e.signal === 'static-generator')?.source)
      .toContain("output: 'export'");
  });

  it('does not read Astro as static when an SSR adapter is installed', async () => {
    expect(await stateOf({ 'package.json': JSON.stringify({ dependencies: { astro: '4' } }) }))
      .toBe('static-build-detected');
    expect(await stateOf({ 'package.json': JSON.stringify({ dependencies: { astro: '4', '@astrojs/node': '8' } }) }))
      .toBe('unknown');
  });

  it('says what the state does NOT mean, in the document itself', async () => {
    const map = await mapOf(VITE_APP);
    const note = map.coverage.notes.find((n) => n.includes('serverSurface'));

    // The claim a consumer would otherwise make for us. A static reading describes the source; a function
    // added at the platform level is invisible to it.
    expect(note).toContain('NOT deployment attestation');
    expect(note).toContain('not what is deployed');
  });
});

describe('unknown, which is most of the interesting cases', () => {
  it('does not read a platform config alone as a server runtime', async () => {
    // The common shape this gets wrong: a static site deployed to Netlify has a `netlify.toml` and no
    // server whatsoever. Same for a static Vercel project and a Pages project serving only assets. The
    // config establishes "deploys somewhere", which is not "serves requests".
    for (const config of [
      { 'netlify.toml': '[build]\n  publish = "dist"' },
      { 'vercel.json': '{"cleanUrls": true}' },
      { 'wrangler.toml': 'name = "app"\npages_build_output_dir = "dist"' },
    ]) {
      expect(await stateOf({ ...VITE_APP, ...config }), JSON.stringify(config)).toBe('unknown');
    }
  });

  it('keeps the config visible as evidence, and still refuses the static claim', async () => {
    // Both halves: the config is why this is not `static-build-detected`, and a consumer needs to see it —
    // but it is not promoted to a runtime either. `unknown` with a stated reason.
    const map = await mapOf({ ...VITE_APP, 'netlify.toml': '[build]\n  publish = "dist"' });
    const signals = map.serverSurface?.evidence ?? [];

    expect(map.serverSurface?.state).toBe('unknown');
    expect(signals.map((e) => e.signal)).toContain('deployment-config');
    expect(signals.map((e) => e.signal)).toContain('static-generator');
  });

  it('refuses a static claim when a server framework is installed but no endpoint parsed', async () => {
    // The defect this rule prevents: an unparsed framework produces no endpoints, which looks exactly like
    // a static app. `express` in the manifest says otherwise, so the honest answer is that we do not know.
    expect(await stateOf({
      'package.json': JSON.stringify({ dependencies: { express: '4', vite: '5' } }),
      'src/main.tsx': 'export const App = () => null;',
    })).toBe('unknown');
  });

  it('refuses a static claim when an ambiguous api folder holds source', async () => {
    // `api/client.ts` is an ordinary front-end helper; `api/handler.ts` is a platform function. From here
    // they are the same folder, so neither claim is available.
    expect(await stateOf({
      ...VITE_APP,
      'api/client.ts': 'export const get = () => fetch("/x");',
    })).toBe('unknown');
  });

  it('reports unknown for a stack it recognizes nothing in', async () => {
    expect(await stateOf({
      'package.json': JSON.stringify({ dependencies: { 'some-unknown-framework': '1' } }),
      'src/app.ts': 'export const handler = () => "hello";',
    })).toBe('unknown');
  });

  it('reports unknown with no manifest at all', async () => {
    expect(await stateOf({ 'src/app.ts': 'export const x = 1;' })).toBe('unknown');
  });

  it('says plainly that unknown is not "no server side"', async () => {
    const map = await mapOf({ 'package.json': JSON.stringify({ dependencies: { 'x-framework': '1' } }) });
    const note = map.coverage.notes.find((n) => n.includes('serverSurface'));

    expect(note).toContain('UNKNOWN');
    expect(note).toContain('must not be read as "no server side"');
    // And it names the reason, rather than asserting the limit.
    expect(note).toContain('no completeness flag');
  });

  it('keeps the ambiguous layout visible in the evidence, so the state can be explained', async () => {
    const map = await mapOf({ ...VITE_APP, 'functions/hello.js': 'export const onRequest = () => {}' });
    const signals = map.serverSurface?.evidence.map((e) => e.signal) ?? [];

    // Both halves are reported: the folder that blocked the static claim AND the generator that would
    // otherwise have supported it. A state with no visible reason is one a consumer cannot act on.
    expect(map.serverSurface?.state).toBe('unknown');
    expect(signals).toContain('ambiguous-layout');
    expect(signals).toContain('static-generator');
  });
});

describe('the field stays safe to consume', () => {
  it('is additive, so a v3 reader is unaffected', async () => {
    const map = await mapOf(VITE_APP);

    expect(map.version).toBe(3);
    expect(map.serverSurface?.state).toBeDefined();
  });

  it('never claims a state without at least one signal behind it, except unknown', async () => {
    for (const files of [VITE_APP, { 'package.json': JSON.stringify({ dependencies: { express: '4' } }) }]) {
      const map = await mapOf(files);
      if (map.serverSurface?.state !== 'unknown') {
        expect(map.serverSurface?.evidence.length, 'a positive state needs evidence').toBeGreaterThan(0);
      }
    }
  });
});

// ── the sentence a consumer renders verbatim ───────────────────────────────────────────────────────
// `surfaceNote` is copied into `coverage.notes`, and every consumer of this map shows those notes as written.
// So the note is not internal prose: it is product copy, and until this suite pinned it, nothing did.
describe('the note each state carries', () => {
  /** Words that turn an analysis result into a claim about the app's security posture. */
  const POSTURE_CLAIMS = ['protection applies', 'is protected', 'unprotected', 'is safe', 'is secure', 'not vulnerable'];

  const noteFor = async (files: Record<string, string>): Promise<string> => {
    const map = await mapOf(files);
    const note = (map.coverage.notes ?? []).find((n) => n.startsWith('serverSurface'));
    expect(note, 'every map must carry a serverSurface note').toBeDefined();
    return note!.toLowerCase();
  };

  it('says request-path shielding is APPLICABLE, never that it is in place', async () => {
    // The distinction: this analysis sees source, so it can say which kind of protection is relevant to these
    // paths. Whether a guard is installed, fetching rules or enforcing them is invisible to it, and the
    // earlier wording asserted exactly that — on a dashboard, verbatim.
    const note = await noteFor({
      'package.json': JSON.stringify({ dependencies: { express: '4.18.2' } }),
      'server.js': "const express = require('express');\nconst app = express();\napp.get('/api/items', (req, res) => res.json([]));\n",
    });

    expect(note).toContain('applicable');
    expect(note).toContain('not a statement that a guard is installed');
    for (const claim of POSTURE_CLAIMS) expect(note, `note must not claim ${claim}`).not.toContain(claim);
  });

  it('keeps the static note a description of the source, not of the deployment', async () => {
    const note = await noteFor(VITE_APP);
    expect(note).toContain('not deployment attestation');
    for (const claim of POSTURE_CLAIMS) expect(note, `note must not claim ${claim}`).not.toContain(claim);
  });

  it('keeps the unknown note from reading as "no server side"', async () => {
    const note = await noteFor({ 'package.json': JSON.stringify({ dependencies: { express: '4' } }) });
    expect(note).toContain('must not be read as "no server side"');
    for (const claim of POSTURE_CLAIMS) expect(note, `note must not claim ${claim}`).not.toContain(claim);
  });
});
