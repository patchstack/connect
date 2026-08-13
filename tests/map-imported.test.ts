import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../src/map/index.js';

// AI-generated apps put data access in a sibling module, so a handler's real sink is one file away.
// Following one cross-file hop is what keeps those endpoints from looking sink-free.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-imp-'));
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14' } }));

  // The helper module: exported fn hits supabase; a second exported fn delegates to a local helper.
  writeFileSync(join(dir, 'src', 'lib', 'db.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const client = createClient(process.env.URL, process.env.KEY);
    export function saveOrder(o) { return client.from("orders").insert(o); }
    function reallyPurge(id) { return client.from("orders").delete().eq("id", id); }
    export function purgeOrder(id) { return reallyPurge(id); }
  `);

  // Handler imports both — note the TS-ESM `.js` specifier for one of them.
  writeFileSync(join(dir, 'src', 'route.ts'), `
    import { saveOrder } from "./lib/db.js";
    import { purgeOrder } from "./lib/db";
    export async function POST(request) {
      const body = await request.json();
      return saveOrder({ note: body.note });
    }
    export async function DELETE(request) {
      return purgeOrder(request.query.id);
    }
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('imported-helper tracing', () => {
  it('attributes a sink reached through an imported module (incl. a .js specifier)', async () => {
    const { map } = await buildInputMap(dir);
    const post = map!.endpoints.find((e) => e.name === 'POST')!;
    expect(post.sinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'db', package: '@supabase/supabase-js', table: 'orders', op: 'insert' }),
      ]),
    );
  });

  it('follows one same-file hop inside the imported module', async () => {
    const { map } = await buildInputMap(dir);
    const del = map!.endpoints.find((e) => e.name === 'DELETE')!;
    expect(del.sinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'db', package: '@supabase/supabase-js', table: 'orders', op: 'delete' }),
      ]),
    );
  });

  it('states the hop limit in coverage notes', async () => {
    const { map } = await buildInputMap(dir);
    expect(map!.coverage.notes.join(' ')).toMatch(/ONE hop into an imported relative module/i);
  });
});
