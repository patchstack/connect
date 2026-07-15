import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProtect } from '../../src/protect/install/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-install-'));
  mkdirSync(join(dir, 'src/integrations/supabase'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@tanstack/react-start': '^1' } }));
  writeFileSync(join(dir, 'src/start.ts'),
    'import { createStart, createMiddleware } from "@tanstack/react-start";\n' +
    'export const startInstance = createStart(() => ({ functionMiddleware: [], requestMiddleware: [] }));\n');
  writeFileSync(join(dir, 'src/integrations/supabase/client.ts'),
    "const headers = new Headers();\n    headers.set('apikey', supabaseKey);\n");
  // A real site UUID, matching what `patchstack-connect scan` actually writes.
  writeFileSync(join(dir, '.patchstackrc.json'), JSON.stringify({ siteUuid: '3f1a9c2e-1b4d-4c8a-9e2f-7a6b5c4d3e2f' }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runProtect bakes the site UUID', () => {
  it('replaces the placeholder in guard.ts with the .patchstackrc.json uuid', () => {
    runProtect(dir);
    const guard = readFileSync(join(dir, 'src/integrations/patchstack/guard.ts'), 'utf8');
    expect(guard).toContain('3f1a9c2e-1b4d-4c8a-9e2f-7a6b5c4d3e2f');
    expect(guard).not.toContain('__PATCHSTACK_SITE_UUID__');
  });

  it('leaves the placeholder inert (empty) when there is no .patchstackrc.json', () => {
    rmSync(join(dir, '.patchstackrc.json'));
    runProtect(dir);
    const guard = readFileSync(join(dir, 'src/integrations/patchstack/guard.ts'), 'utf8');
    // unbaked placeholder must not crash the guard: it is treated as "no uuid"
    expect(guard).toContain('__PATCHSTACK_SITE_UUID__');
  });

  it('leaves the placeholder inert when the siteUuid is malformed', () => {
    // A non-UUID value must not be baked into the TS literal (broken build / replace-token hazard).
    writeFileSync(join(dir, '.patchstackrc.json'), JSON.stringify({ siteUuid: 'not-a-uuid"; drop()' }));
    runProtect(dir);
    const guard = readFileSync(join(dir, 'src/integrations/patchstack/guard.ts'), 'utf8');
    expect(guard).toContain('__PATCHSTACK_SITE_UUID__');
    expect(guard).not.toContain('drop()');
  });
});
