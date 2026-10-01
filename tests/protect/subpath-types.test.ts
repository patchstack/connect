import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

it.each([ts.ModuleResolutionKind.Node10, ts.ModuleResolutionKind.Bundler])(
  'resolves the protection subpath and root types with moduleResolution %s', resolution => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-next-types-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'node_modules', '@patchstack'), { recursive: true });
    symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), join(dir, 'node_modules', '@patchstack', 'connect'), 'junction');
    for (const [specifier, declaration] of [
      ['@patchstack/connect/protect', 'protect.d.ts'],
      ['@patchstack/connect', 'index.d.ts'],
    ]) {
      const found = ts.resolveModuleName(specifier!, join(dir, 'consumer.ts'), {
        module: ts.ModuleKind.ESNext, moduleResolution: resolution,
      }, ts.sys).resolvedModule;
      expect(found?.resolvedFileName.replace(/\\/g, '/')).toMatch(new RegExp(`/dist/${declaration!.replaceAll('.', '\\.')}$`));
    }
  },
);
