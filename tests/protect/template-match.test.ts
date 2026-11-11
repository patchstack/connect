import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { matchesGuardTemplate } from '../../src/protect/install/template-match.js';
import { templatesDir } from '../../src/protect/install/util.js';

/**
 * `protect --check` trusts a guard file only while it is still the template it was written from. The
 * documented reporting opt-outs are the one edit that keeps that trust: they switch reports off and change
 * nothing about what the guard screens, and the docs name them as the way to do it.
 */
describe('matchesGuardTemplate', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'ps-template-match-'));
    mkdirSync(path.join(cwd, 'src', 'patchstack'), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const guard = (template: string, edit: (source: string) => string = (source) => source): string => {
    const file = path.join('src', 'patchstack', `guard${path.extname(template)}`);
    const source = readFileSync(path.join(templatesDir(), template), 'utf8')
      .replace('"__PATCHSTACK_SITE_UUID__"', '"11111111-1111-4111-8111-111111111111"');
    writeFileSync(path.join(cwd, file), edit(source));
    return file;
  };

  const withOptions = (options: string) => (source: string): string => {
    expect(source).toContain('const common = { mode, egress: true, refreshMs }');
    return source.replace('const common = { mode, egress: true, refreshMs }', `const common = { mode, egress: true, refreshMs, ${options} }`);
  };

  for (const template of ['express-guard.ts', 'express-guard.js', 'generic-guard.ts']) {
    describe(template, () => {
      it('trusts the guard as written', () => {
        expect(matchesGuardTemplate(cwd, guard(template), template)).toBe(true);
      });

      it('still trusts it with reporting switched off', () => {
        const file = guard(template, withOptions('reportDetections: false, reportFirewallLog: false'));

        expect(matchesGuardTemplate(cwd, file, template)).toBe(true);
      });

      it('does not trust an option set to anything but false', () => {
        expect(matchesGuardTemplate(cwd, guard(template, withOptions('reportDetections: true')), template)).toBe(false);
        expect(matchesGuardTemplate(cwd, guard(template, withOptions('reportDetections: off')), template)).toBe(false);
      });

      it('does not trust any other change to what it screens', () => {
        const file = guard(template, (source) => source.replace('egress: true', 'egress: false'));

        expect(matchesGuardTemplate(cwd, file, template)).toBe(false);
      });
    });
  }
});
