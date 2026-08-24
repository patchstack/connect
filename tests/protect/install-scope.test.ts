import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lastTopLevelImportLine,
  isTopLevelLine,
  inSameBlockAfter,
  parses,
} from '../../src/protect/install/source-scope.js';
import { expressAdapter } from '../../src/protect/install/adapters/express.js';

/**
 * Where the installer is allowed to add a binding, and what it does when its own edit breaks the file.
 *
 * The installer edits somebody else's entry point. A binding it places inside a function is not in scope
 * where the registration runs, so the name is undefined at request time — and because the symbol IS
 * present in the file, a verification that searched the text reported the guard wired. Protection that
 * reports itself installed and screens nothing is the failure this whole surface exists to avoid.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-install-'));
  dirs.push(dir);

  for (const [rel, contents] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }

  return dir;
}

const PACKAGE_JSON = JSON.stringify({
  name: 'fixture',
  dependencies: { express: '^4.19.2' },
});

describe('finding a place for a top-level binding', () => {
  it('ignores a require inside a function', () => {
    // The reported case. The last line that LOOKS like an import is the one in the helper, and inserting
    // after it puts the binding inside the helper.
    const source = [
      "const express = require('express');",
      '',
      'function loadConfig() {',
      "  const fs = require('node:fs');",
      "  return JSON.parse(fs.readFileSync('config.json', 'utf8'));",
      '}',
      '',
      'const app = express();',
    ].join('\n');

    expect(lastTopLevelImportLine(source)).toBe(0);
  });

  it('takes the last import that really is top level', () => {
    const source = [
      "import a from 'a';",
      'function helper() {',
      "  const b = require('b');",
      '  return b;',
      '}',
      "import c from 'c';",
      'const app = a();',
    ].join('\n');

    expect(lastTopLevelImportLine(source)).toBe(5);
  });

  it('is not fooled by brackets inside strings, comments or template literals', () => {
    // Depth counting is what makes the scope answer right, so anything that can push the count off is a way
    // back to inserting inside a function.
    const source = [
      "import a from 'a';",
      "const brace = '{';",
      'const tpl = `${a} } ) ]`;',
      '// } ) ]',
      '/* {{{ */',
      "import b from 'b';",
      'const app = a();',
    ].join('\n');

    expect(lastTopLevelImportLine(source)).toBe(5);
  });

  it('refuses a file whose brackets do not balance', () => {
    // Such a file does not parse either. Answering "top level" for it would be a guess, and the caller
    // treats -1 as "put this at the top" rather than "put it anywhere".
    expect(lastTopLevelImportLine("import a from 'a';\nfunction broken() {\n")).toBe(-1);
  });

  it('answers whether a known line is nested', () => {
    const source = ['function outer() {', "  const guard = require('./guard');", '  return guard;', '}', 'const x = 1;'].join('\n');

    expect(isTopLevelLine(source, 1)).toBe(false);
    expect(isTopLevelLine(source, 4)).toBe(true);
  });
});

describe('checking the file after editing it', () => {
  it('reports a real syntax error', () => {
    const dir = project({ 'broken.js': 'const a = (' });

    expect(parses(join(dir, 'broken.js'))).toBe(false);
  });

  it('reports a valid file as parsing, module syntax included', () => {
    const dir = project({
      'ok.cjs': "const a = require('a');\nmodule.exports = { a };\n",
      'ok.mjs': "import a from 'a';\nexport default a;\n",
    });

    expect(parses(join(dir, 'ok.cjs'))).toBe(true);
    expect(parses(join(dir, 'ok.mjs'))).toBe(true);
  });

  it('says it could not check a TypeScript entry rather than passing it', () => {
    // Parsing TypeScript needs a compiler this package must not require of a consumer project. Null is
    // "unchecked", and the caller treats it differently from a pass: it does not revert, and it does not
    // claim the file was verified.
    const dir = project({ 'entry.ts': 'const a: number = 1;\n' });

    expect(parses(join(dir, 'entry.ts'))).toBeNull();
  });
});

describe('wiring an Express entry', () => {
  it('puts the binding at module scope even when a helper requires something', () => {
    // End to end, on the shape that produced the defect: install, then read the file back and check the
    // binding is not inside the helper.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        '',
        'function loadConfig() {',
        "  const fs = require('node:fs');",
        '  return fs.existsSync("config.json");',
        '}',
        '',
        'const app = express();',
        'app.use(express.json());',
        "app.get('/', (req, res) => res.send(loadConfig() ? 'yes' : 'no'));",
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    expect(expressAdapter.wire(cwd, { cwd, force: false } as never).ok).toBe(true);

    const source = readFileSync(join(cwd, 'src/server.js'), 'utf8');
    const lines = source.split('\n');
    const bindingIndex = lines.findIndex((line) => line.includes('patchstackMiddleware') && !line.includes('app.use'));

    expect(bindingIndex).toBeGreaterThan(-1);
    expect(isTopLevelLine(source, bindingIndex)).toBe(true);
    // And the file still parses, which is the other half of not breaking somebody's app.
    expect(parses(join(cwd, 'src/server.js'))).toBe(true);
  });

  it('verifies green only when both the binding and the registration are top level', () => {
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const app = express();',
        'app.use(express.json());',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    expect(expressAdapter.verify(cwd).wired).toBe(true);
  });

  it('refuses to verify a binding somebody moved inside a function', () => {
    // The control for the verification half. The symbol is still in the file — that is exactly why a text
    // search said wired — and it is undefined where the registration runs.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const app = express();',
        'function setup() {',
        '  const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        '  return patchstackMiddleware;',
        '}',
        'app.use(express.json());',
        '// #region patchstack (managed by patchstack-connect protect — do not edit)',
        'app.use(patchstackMiddleware);',
        '// #endregion patchstack',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    mkdirSync(join(cwd, 'src/patchstack'), { recursive: true });
    writeFileSync(join(cwd, 'src/patchstack/guard.cjs'), 'module.exports = { patchstackMiddleware: () => {} };\n');

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });
});

describe('where a registration is allowed to live', () => {
  it('accepts one in the same block as the app it registers on', () => {
    // Not every framework has an app at module scope: some only have one inside an async bootstrap
    // function, and the registration belongs there with it.
    const source = [
      "import { NestFactory } from '@nestjs/core';",
      "import { patchstackMiddleware } from './patchstack/guard';",
      'async function bootstrap() {',
      '  const app = await NestFactory.create(AppModule);',
      '  app.use(patchstackMiddleware);',
      '  await app.listen(3000);',
      '}',
      'bootstrap();',
    ].join('\n');

    expect(inSameBlockAfter(source, 3, 4)).toBe(true);
  });

  it('rejects one in a different function from the app', () => {
    // The same depth as the app instance, and a different scope — which is why this cannot be answered by
    // comparing depths alone.
    const source = [
      'async function bootstrap() {',
      '  const app = await NestFactory.create(AppModule);',
      '  await app.listen(3000);',
      '}',
      'function somethingElse() {',
      '  app.use(patchstackMiddleware);',
      '}',
    ].join('\n');

    expect(inSameBlockAfter(source, 1, 5)).toBe(false);
  });

  it('rejects one that runs before the app exists', () => {
    const source = ['app.use(patchstackMiddleware);', 'const app = express();'].join('\n');

    expect(inSameBlockAfter(source, 1, 0)).toBe(false);
  });
});

describe('a project that starts more than one server', () => {
  const API = [
    "const express = require('express');",
    'const app = express();',
    'app.use(express.json());',
    "app.get('/api', (req, res) => res.json({ ok: true }));",
    'app.listen(3000);',
    '',
  ].join('\n');

  const ADMIN = [
    "const express = require('express');",
    'const admin = express();',
    'admin.use(express.json());',
    'admin.listen(4000);',
    '',
  ].join('\n');

  it('wires the one that serves and names the one it did not', () => {
    // Two servers, and the alphabetically first is not a reason to choose either. Wiring one and reporting
    // the project protected would leave the other serving every request unscreened.
    const cwd = project({ 'package.json': PACKAGE_JSON, 'src/admin.js': ADMIN, 'src/server.js': API });

    expressAdapter.wire(cwd, { cwd, force: false } as never);
    const report = expressAdapter.verify(cwd);

    expect(readFileSync(join(cwd, 'src/server.js'), 'utf8')).toContain('app.use(patchstackMiddleware)');
    expect(report.wired).toBe(false);
    const check = report.checks.find((c) => c.label.includes('every server in this project has a guard'));
    expect(check?.ok).toBe(false);
    expect(check?.hint).toContain('src/admin.js');
  });

  it('is fully wired once the second one has a guard too', () => {
    // The control. Without it the check would be one nothing can satisfy, which is a check people learn to
    // ignore rather than act on.
    const cwd = project({ 'package.json': PACKAGE_JSON, 'src/admin.js': ADMIN, 'src/server.js': API });

    expressAdapter.wire(cwd, { cwd, force: false } as never);
    writeFileSync(
      join(cwd, 'src/admin.js'),
      ADMIN.replace(
        'admin.use(express.json());',
        [
          'const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
          'admin.use(express.json());',
          'admin.use(patchstackMiddleware);',
        ].join('\n'),
      ),
    );

    expect(expressAdapter.verify(cwd).wired).toBe(true);
  });

  it('does not count a file that builds an app for somebody else to mount', () => {
    // A factory or a plugin is served through whichever app mounts it, and its traffic is screened by that
    // app's guard. Reported as a second server it would be a check that cannot be satisfied.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/routes.js': ["const express = require('express');", 'const router = express();', 'module.exports = router;', ''].join('\n'),
      'src/server.js': API,
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);
    const report = expressAdapter.verify(cwd);

    expect(report.wired).toBe(true);
    expect(report.checks.some((c) => c.label.includes('every server in this project has a guard'))).toBe(false);
  });
});

describe('choosing between candidate entries', () => {
  it('takes the file the package itself names', () => {
    // Better than any guess made from the file name: the project has already answered which file it starts.
    const cwd = project({
      'package.json': JSON.stringify({
        name: 'fixture',
        dependencies: { express: '^4.19.2' },
        scripts: { start: 'node src/boot.js' },
      }),
      'src/boot.js': [
        "const express = require('express');",
        'const boot = express();',
        'boot.use(express.json());',
        'boot.listen(3000);',
        '',
      ].join('\n'),
      'src/server.js': [
        "const express = require('express');",
        'const app = express();',
        'app.use(express.json());',
        'app.listen(4000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    expect(readFileSync(join(cwd, 'src/boot.js'), 'utf8')).toContain('boot.use(patchstackMiddleware)');
  });
});
