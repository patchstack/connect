import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectDeploymentShapes } from '../../src/map/sources.js';
import { buildInputMap } from '../../src/map/index.js';

// What the PROJECT declares about where it runs, as distinct from what its source says it does.
//
// The reason this exists is a negative nobody can check: a serverless handler the extractor cannot parse
// produces no endpoint, and an empty endpoint list is indistinguishable from an app that has no server at
// all. A consumer that classified apps on that basis would tell the owner of an unparsed Netlify function
// that there is nothing to protect. So this layer reports artifacts that are PRESENT, and each finding
// names the file or directory that proved it — a classification a consumer cannot explain is one it should
// not act on.
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-deploy-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
};
const shapesOf = (files: Record<string, string>) => detectDeploymentShapes(project(files)).map((s) => s.shape);

describe('a declared deployment artifact is recognized, whatever the source analysis makes of it', () => {
  it('recognizes each platform from its own config file', () => {
    expect(shapesOf({ 'vercel.json': '{}' })).toContain('vercel');
    expect(shapesOf({ 'netlify.toml': '[build]' })).toContain('netlify');
    expect(shapesOf({ 'wrangler.toml': 'name = "app"' })).toContain('cloudflare-workers');
    // Both current spellings, because a project using the newer one is not less deployed.
    expect(shapesOf({ 'wrangler.jsonc': '{}' })).toContain('cloudflare-workers');
    expect(shapesOf({ 'wrangler.json': '{}' })).toContain('cloudflare-workers');
  });

  it('recognizes the function directories, including a per-function layout', () => {
    expect(shapesOf({ 'netlify/functions/hello.ts': 'export default () => {}' })).toContain('netlify-functions');
    // `netlify/functions/hello/index.ts` — one level deeper, which a top-level-only check would miss.
    expect(shapesOf({ 'netlify/functions/hello/index.ts': 'export default () => {}' })).toContain('netlify-functions');
    expect(shapesOf({ 'netlify/edge-functions/geo.ts': 'export default () => {}' })).toContain('netlify-functions');
    expect(shapesOf({ 'supabase/functions/notify/index.ts': 'Deno.serve(() => new Response("ok"))' })).toContain('supabase-functions');
  });

  it('recognizes a Pages advanced-mode worker at the project root', () => {
    // `_worker.js` takes over routing for the whole deployment, so its presence is a server runtime even
    // when every other file in the project is static.
    expect(shapesOf({ '_worker.js': 'export default { fetch: () => new Response("ok") }' }))
      .toContain('cloudflare-pages-advanced');
  });

  it('names an ambiguous directory for what it is rather than guessing a provider', () => {
    // A root `functions/` directory is Cloudflare Pages Functions, Firebase, or a Deno layout depending on
    // the platform, and nothing inside the repository reliably says which. Reporting the shape honestly
    // beats attributing it to a provider that may not be involved.
    expect(shapesOf({ 'functions/hello.js': 'export const onRequest = () => {}' }))
      .toContain('root-functions-directory');
  });

  it('recognizes the bare-root api convention as its own shape', () => {
    // `api/handler.ts` with no framework router is the Vercel convention. Next owns `pages/api` and
    // `app/api`, which the endpoint walk already reads, so this stays separate rather than being folded
    // into `vercel` — a project can use one without the other.
    expect(shapesOf({ 'api/handler.ts': 'export default () => {}' })).toContain('root-api-directory');
  });
});

describe('what it refuses to claim', () => {
  it('finds nothing in a purely client-side project', () => {
    const shapes = shapesOf({
      'package.json': JSON.stringify({ dependencies: { react: '18' }, devDependencies: { vite: '5' } }),
      'src/main.tsx': 'export const App = () => null;',
      'index.html': '<div id="root"></div>',
    });

    // The finding this layer is FOR: nothing here declares a server. That is still not the same claim as
    // "this app has no server-side runtime" — see the note the map emits — but it is the honest input to it.
    expect(shapes).toEqual([]);
  });

  it('ignores an empty platform directory', () => {
    // Scaffolding left behind by a template, or a directory someone created and abandoned. Counting it
    // would make every project that once considered serverless look like it ships it.
    const dir = project({ 'package.json': '{}' });
    mkdirSync(join(dir, 'netlify', 'functions'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });

    expect(detectDeploymentShapes(dir)).toEqual([]);
  });

  it('ignores a directory holding no source file', () => {
    expect(shapesOf({ 'api/README.md': '# planned', 'api/notes.txt': 'later' })).toEqual([]);
  });

  it('returns an empty list for a project it cannot read at all', () => {
    // Fail-open, like everything else here: a missing directory is "found none", and the map says
    // explicitly that this is not evidence of absence.
    expect(detectDeploymentShapes(join(tmpdir(), 'ps-deploy-does-not-exist-'.concat(String(Date.now()))))).toEqual([]);
  });
});

describe('the map carries the evidence, not just the label', () => {
  it('reports each shape with the artifact that proved it', async () => {
    const dir = project({
      'package.json': JSON.stringify({ dependencies: { react: '18' } }),
      'netlify.toml': '[build]\n  publish = "dist"',
      'netlify/functions/submit.ts': 'export default async () => new Response("ok")',
      'src/main.tsx': 'export const App = () => null;',
    });

    const { map } = await buildInputMap(dir);
    const shapes = map!.deploymentShapes ?? [];

    // A consumer has to be able to say WHY it classified a project. A bare label cannot be argued with.
    expect(shapes.map((s) => s.shape)).toEqual(['netlify', 'netlify-functions']);
    expect(shapes.map((s) => s.source)).toEqual(['netlify.toml', 'netlify/functions']);
  });

  it('states in the notes that an empty list is not evidence of absence', async () => {
    const dir = project({
      'package.json': JSON.stringify({ dependencies: { react: '18' } }),
      'wrangler.toml': 'name = "app"',
      'src/main.ts': 'export const x = 1;',
    });

    const { map } = await buildInputMap(dir);
    const note = map!.coverage.notes.find((n) => n.includes('deploymentShapes'));

    // The whole point of the field, written where a consumer reading the document will see it.
    expect(note, 'the map must say what the field does and does not mean').toBeDefined();
    expect(note).toContain('POSITIVE EVIDENCE ONLY');
    expect(note).toContain('never that the app has no server-side runtime');
  });

  it('keeps the field additive, so a v3 reader is unaffected', async () => {
    const { map } = await buildInputMap(project({ 'package.json': '{}' }));

    // Version stays 3 on purpose: a new optional field is not a silent-failure change, and bumping would
    // make every existing consumer reject the document instead.
    expect(map!.version).toBe(3);
    expect(map!.deploymentShapes).toEqual([]);
  });
});
