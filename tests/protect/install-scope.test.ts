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

describe('a name in a comment is not wiring', () => {
  it('does not stop the installer from wiring the file', () => {
    // Reported. A mention of the guard's name was read as "already wired", so setup declined to edit a
    // file with no guard in it and reported success.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const app = express();',
        '// TODO: app.use(patchstackMiddleware) once we have decided about the guard',
        'app.use(express.json());',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    const source = readFileSync(join(cwd, 'src/server.js'), 'utf8');
    expect(source).toContain('#region patchstack');
    expect(expressAdapter.verify(cwd).wired).toBe(true);
  });

  it('does not verify a file whose only guard lines are commented out', () => {
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const app = express();',
        '// const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        'app.use(express.json());',
        '// app.use(patchstackMiddleware);',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    mkdirSync(join(cwd, 'src/patchstack'), { recursive: true });
    writeFileSync(join(cwd, 'src/patchstack/guard.cjs'), 'module.exports = { patchstackMiddleware: () => {} };\n');

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });

  it('does not verify a block comment holding both halves', () => {
    // Block comments have to keep their line count when stripped, or every index taken afterwards points
    // at the wrong line and the scope answers stop meaning anything.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        '/*',
        ' * const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        ' */',
        'const app = express();',
        'app.use(express.json());',
        '/* app.use(patchstackMiddleware); */',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    mkdirSync(join(cwd, 'src/patchstack'), { recursive: true });
    writeFileSync(join(cwd, 'src/patchstack/guard.cjs'), 'module.exports = { patchstackMiddleware: () => {} };\n');

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });

  it('finishes a file that has the import but no registration', () => {
    // Half the wiring is not wiring, and it happens — an interrupted install, a merge that kept one side.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        'const app = express();',
        'app.use(express.json());',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    const source = readFileSync(join(cwd, 'src/server.js'), 'utf8');
    // The registration was added, and the import it already had was not duplicated.
    expect(source).toContain('app.use(patchstackMiddleware);');
    expect(source.match(/require\("\.\/patchstack\/guard\.cjs"\)/g)).toHaveLength(1);
    expect(expressAdapter.verify(cwd).wired).toBe(true);
  });

  it('does not count another server as guarded because it mentions the name', () => {
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const app = express();',
        'app.use(express.json());',
        'app.listen(3000);',
        '',
      ].join('\n'),
      'src/admin.js': [
        "const express = require('express');",
        'const admin = express();',
        '// patchstackMiddleware belongs here too',
        'admin.use(express.json());',
        'admin.listen(4000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });
  it('does not verify a real import beside a commented-out registration', () => {
    // The half that only a comment supplies. The import is real and at module scope; the registration
    // exists only in a comment, so no guard runs — and the name being in the file is exactly what made
    // this read as wired.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        'const app = express();',
        'app.use(express.json());',
        '// app.use(patchstackMiddleware);',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    mkdirSync(join(cwd, 'src/patchstack'), { recursive: true });
    writeFileSync(join(cwd, 'src/patchstack/guard.cjs'), 'module.exports = { patchstackMiddleware: () => {} };\n');

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });

  it('replaces a commented-out registration with a real one', () => {
    // And the installer must not stop at it either: a comment is where somebody meant to wire the guard,
    // not where they did.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        'const app = express();',
        'app.use(express.json());',
        '// app.use(patchstackMiddleware);',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    const lines = readFileSync(join(cwd, 'src/server.js'), 'utf8').split('\n');
    expect(lines.some((line) => line.trim() === 'app.use(patchstackMiddleware);')).toBe(true);
    expect(expressAdapter.verify(cwd).wired).toBe(true);
  });

  it('reports an early route at its real line number below a block comment', () => {
    // Comment stripping has to keep the file's line count. Every index taken afterwards — which route is
    // above the guard, and which line to tell somebody to move — is a line number in the real file.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        '/*',
        ' * Server entry.',
        ' * Two more lines of preamble.',
        ' */',
        "const express = require('express');",
        'const app = express();',
        "app.get('/early', (req, res) => res.send('early'));",
        'app.use(express.json());',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);
    const report = expressAdapter.verify(cwd);
    const check = report.checks.find((c) => c.label.includes('every route registered after the guard'));

    expect(report.wired).toBe(false);
    const source = readFileSync(join(cwd, 'src/server.js'), 'utf8').split('\n');
    const actual = source.findIndex((line) => line.includes("app.get('/early'")) + 1;
    expect(check?.hint).toContain(`line ${actual}`);
  });
});

describe('the module a guard binding comes from', () => {
  it('is not any module that exports the same name', () => {
    // Reported. The name is not the module: a local file exporting `patchstackMiddleware` binds the same
    // identifier and screens nothing, and both install and `--check` called it wired.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/unrelated.cjs': 'module.exports = { patchstackMiddleware: (req, res, next) => next() };\n',
      'src/server.js': [
        "const express = require('express');",
        'const { patchstackMiddleware } = require("./unrelated.cjs");',
        'const app = express();',
        'app.use(express.json());',
        'app.use(patchstackMiddleware);',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    mkdirSync(join(cwd, 'src/patchstack'), { recursive: true });
    writeFileSync(join(cwd, 'src/patchstack/guard.cjs'), 'module.exports = { patchstackMiddleware: () => {} };\n');

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });

  it('is the scaffolded guard, whichever spelling of its path is used', () => {
    // The control. The specifier is resolved rather than compared as text, so an equivalent path — with or
    // without the extension — is the same module and passes.
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
    const wiredSource = readFileSync(join(cwd, 'src/server.js'), 'utf8');
    writeFileSync(
      join(cwd, 'src/server.js'),
      wiredSource.replace('./patchstack/guard.cjs', './patchstack/../patchstack/guard.cjs'),
    );

    expect(expressAdapter.verify(cwd).wired).toBe(true);
  });

  it('is not a registration that only exists inside a string', () => {
    // Comments were handled and string literals are deliberately kept — a `//` inside a URL is not a
    // comment — which leaves a string as the place to put code-shaped text that never runs. The import here
    // is real, so the module loads; the registration is a doc string, so no request is screened.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        'const app = express();',
        'app.use(express.json());',
        'const usage = "app.use(patchstackMiddleware);";',
        'module.exports = { usage };',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    mkdirSync(join(cwd, 'src/patchstack'), { recursive: true });
    writeFileSync(join(cwd, 'src/patchstack/guard.cjs'), 'module.exports = { patchstackMiddleware: () => {} };\n');

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });

  it('is not a string that looks like the import', () => {
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const hint = \'const { patchstackMiddleware } = require("./patchstack/guard.cjs");\';',
        'const app = express();',
        'app.use(express.json());',
        'app.use(patchstackMiddleware);',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    mkdirSync(join(cwd, 'src/patchstack'), { recursive: true });
    writeFileSync(join(cwd, 'src/patchstack/guard.cjs'), 'module.exports = { patchstackMiddleware: () => {} };\n');

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });
});

describe('a second server that only imports the guard', () => {
  const API = [
    "const express = require('express');",
    'const app = express();',
    'app.use(express.json());',
    'app.listen(3000);',
    '',
  ].join('\n');

  it('is not counted as guarded', () => {
    // Reported. A secondary server was checked for a binding only, so an import with nothing under it —
    // which loads the module and screens no request — passed.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': API,
      'src/admin.js': [
        "const express = require('express');",
        'const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        'const admin = express();',
        'admin.use(express.json());',
        'admin.listen(4000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);
    const report = expressAdapter.verify(cwd);

    expect(report.wired).toBe(false);
    expect(report.checks.find((c) => c.label.includes('every server in this project'))?.hint).toContain('src/admin.js');
  });

  it('is not counted as guarded when its guard sits above its body parser', () => {
    // The ordering question is the same question for a second server: the guard reads a parsed body.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': API,
      'src/admin.js': [
        "const express = require('express');",
        'const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        'const admin = express();',
        'admin.use(patchstackMiddleware);',
        'admin.use(express.json());',
        'admin.listen(4000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });

  it('is counted once it is registered in the right place', () => {
    // The control, so the check is one a project can actually satisfy.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': API,
      'src/admin.js': [
        "const express = require('express');",
        'const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        'const admin = express();',
        'admin.use(express.json());',
        'admin.use(patchstackMiddleware);',
        'admin.listen(4000);',
        '',
      ].join('\n'),
    });

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    expect(expressAdapter.verify(cwd).wired).toBe(true);
  });
});

describe('a guard already registered in the wrong place', () => {
  it('is named at install time instead of being called wired', () => {
    // The installer returned early on "both halves present" without asking whether the registration was
    // after the body parser, so it logged `already wired`, changed nothing, and left the verifier to
    // disagree with it.
    const cwd = project({
      'package.json': PACKAGE_JSON,
      'src/server.js': [
        "const express = require('express');",
        'const { patchstackMiddleware } = require("./patchstack/guard.cjs");',
        'const app = express();',
        'app.use(patchstackMiddleware);',
        'app.use(express.json());',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });

    mkdirSync(join(cwd, 'src/patchstack'), { recursive: true });
    writeFileSync(join(cwd, 'src/patchstack/guard.cjs'), 'module.exports = { patchstackMiddleware: () => {} };\n');

    const said: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void said.push(args.join(' '));
    try {
      expressAdapter.wire(cwd, { cwd, force: false } as never);
    } finally {
      console.log = original;
    }

    const output = said.join('\n');
    expect(output).not.toContain('already wired');
    expect(output).toContain('before the body parser');
    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });
});
