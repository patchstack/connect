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

  it('reports a declared deployment even with no endpoint parsed', async () => {
    // The case the evidence layer exists for: a handler this analysis cannot read still deploys. The
    // artifact says so, and that outweighs an empty endpoint list.
    expect(await stateOf({
      ...VITE_APP,
      'netlify.toml': '[build]\n  publish = "dist"',
      'netlify/functions/submit.ts': 'export default async () => new Response("ok")',
    })).toBe('server-runtime-detected');
  });

  it('carries the evidence that produced the state', async () => {
    const map = await mapOf({
      ...VITE_APP,
      'wrangler.toml': 'name = "app"',
    });

    // A consumer has to be able to show WHY, not just display a badge.
    expect(map.serverSurface?.state).toBe('server-runtime-detected');
    expect(map.serverSurface?.evidence.map((e) => e.signal)).toContain('deployment-artifact');
    expect(map.serverSurface?.evidence.find((e) => e.signal === 'deployment-artifact')?.source)
      .toContain('wrangler.toml');
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
    expect(await stateOf({ 'package.json': JSON.stringify({ devDependencies: { '@sveltejs/adapter-static': '3' } }) }))
      .toBe('static-build-detected');
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
