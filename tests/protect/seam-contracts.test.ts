import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genericVerify, scaffoldGeneric } from '../../src/protect/install/generic.js';
import { runVerify } from '../../src/protect/install/index.js';
import { expressAdapter } from '../../src/protect/install/adapters/express.js';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * What the scaffolded seams hand the engine, and what `--check` will call wired.
 *
 * Both were places where the structure was right and the runtime property was not: a response rule scoped
 * to a route cannot apply its scope unless the seam passes the request, and a verification that searched
 * source text for a path turned green on a comment.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-seam-'));
  dirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }

  return dir;
}

function template(name: string): string {
  return readFileSync(new URL(`../../src/protect/templates/${name}`, import.meta.url), 'utf8');
}

describe('the request a response seam passes on', () => {
  it('is threaded through every generated seam', () => {
    // Asserted per template because each is scaffolded independently: the one an app receives is the one
    // that has to carry it, and fixing three of four leaves a stack silently unscoped.
    const seams: Array<[string, RegExp]> = [
      ['astro-middleware.ts', /screenResponse\(await next\(\), context\.request\)/],
      ['sveltekit-hooks.ts', /screenResponse\(await resolve\(event\), event\.request\)/],
      ['generic-guard.ts', /screenResponse\(await handler\(request, \.\.\.rest\) as Response, request\)/],
      ['generic-guard.js', /screenResponse\(await handler\(request, \.\.\.rest\), request\)/],
      ['generic-guard.cjs', /screenResponse\(await handler\(request, \.\.\.rest\), request\)/],
    ];

    for (const [name, pattern] of seams) {
      expect(template(name), name).toMatch(pattern);
    }
  });

  it('is accepted by the guard the seams call', async () => {
    // The other half: a seam passing an argument the runtime ignores would look fixed and change nothing.
    // A response rule scoped to one route, and a response from another, is the observable difference.
    const protection = await createProtection({
      mode: 'block',
      rules: {
        firewall: [
          {
            id: 'rm-seam-scope',
            title: 'test rule',
            phase: 'response',
            action: 'block',
            when: { path: '/api/reports' },
            rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'SENTINEL' } }],
          },
        ],
        whitelists: [],
      } as never,
    });

    // A withheld response, not a 403: the request was fine and the response is what must not leave, so the
    // status describes a server-side refusal to serve it.
    const onScope = await protection.screenResponse(
      new Response('SENTINEL', { headers: { 'content-type': 'text/plain' } }),
      new Request('http://app.test/api/reports'),
    );
    expect(onScope.status).toBe(500);
    expect(await onScope.text()).not.toContain('SENTINEL');

    // Off-scope: the same body on a route the rule does not name, served untouched.
    const offScope = await protection.screenResponse(
      new Response('SENTINEL', { headers: { 'content-type': 'text/plain' } }),
      new Request('http://app.test/api/other'),
    );
    expect(offScope.status).toBe(200);
    expect(await offScope.text()).toContain('SENTINEL');

    protection.stop();
  });

  it('is what makes a scoped rule apply at all', async () => {
    // The control that names the defect: with no request, the scope cannot be evaluated, and this is what
    // every generated seam was doing.
    const protection = await createProtection({
      mode: 'block',
      rules: {
        firewall: [
          {
            id: 'rm-seam-scope',
            title: 'test rule',
            phase: 'response',
            action: 'block',
            when: { path: '/api/reports' },
            rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'SENTINEL' } }],
          },
        ],
        whitelists: [],
      } as never,
    });

    const unscoped = await protection.screenResponse(
      new Response('SENTINEL', { headers: { 'content-type': 'text/plain' } }),
    );

    expect(unscoped.status).toBe(200);
    expect(await unscoped.text()).toContain('SENTINEL');

    protection.stop();
  });
});

describe('what counts as the generic guard being wired', () => {
  function scaffolded(files: Record<string, string> = {}): string {
    const cwd = project({ 'package.json': JSON.stringify({ name: 'fixture' }), ...files });
    scaffoldGeneric(cwd, { cwd, force: false } as never, 'generic-guard.ts');

    return cwd;
  }

  it('is not satisfied by a comment mentioning the path', () => {
    // Reported, and reproduced with one line: the check searched every source file for the guard's path,
    // and a note about it is not an import.
    const cwd = scaffolded({ 'src/server.ts': '// TODO import from src/patchstack/guard\nexport {};\n' });

    expect(genericVerify(cwd).wired).toBe(false);
  });

  it('is not satisfied by an import nothing calls', () => {
    // It type-checks, it ships, and it wraps no request. An import on its own is not a request path.
    const cwd = scaffolded({
      'src/server.ts': 'import { protectFetch } from "./patchstack/guard";\nexport default {};\n',
    });

    expect(genericVerify(cwd).wired).toBe(false);
  });

  it('is not satisfied by a file that is not the running app', () => {
    // A guard wired in a test protects the test. Build output is the same: it is regenerated, and what is
    // in it says nothing about the source the next build compiles.
    const cwd = scaffolded({
      'src/__tests__/server.test.ts': 'import { protectFetch } from "../patchstack/guard";\nprotectFetch(() => new Response("ok"));\n',
      'dist/server.js': 'const { protectFetch } = require("./patchstack/guard");\nprotectFetch(handler);\n',
    });

    expect(genericVerify(cwd).wired).toBe(false);
  });

  it('is satisfied by an import that is called', () => {
    // The control. Without it every refusal above would also be satisfied by a check that never passes,
    // which would make `--check` unusable rather than merely optimistic.
    const cwd = scaffolded({
      'src/server.ts': [
        'import { protectFetch } from "./patchstack/guard";',
        '',
        'export default { fetch: protectFetch(async () => new Response("ok")) };',
        '',
      ].join('\n'),
    });

    expect(genericVerify(cwd).wired).toBe(true);
  });

  it('is satisfied through a require, too', () => {
    const cwd = scaffolded({
      'server.cjs': [
        'const { patchstackMiddleware } = require("./patchstack/guard");',
        'app.use(patchstackMiddleware);',
        '',
      ].join('\n'),
    });

    expect(genericVerify(cwd).wired).toBe(true);
  });

  it('is not satisfied by two names in one import clause', () => {
    // Reported. Inside an import clause a name is followed by a comma, and the use test accepted a comma
    // as use — so importing two exports counted as using them both while calling neither.
    const cwd = scaffolded({
      'src/server.ts': [
        'import { protectFetch, screenResponse } from "./patchstack/guard";',
        'export default {};',
        '',
      ].join('\n'),
    });

    expect(genericVerify(cwd).wired).toBe(false);
  });

  it('accepts a guard imported under another name and called', () => {
    // The alias control. The exported name is not necessarily the name the code calls, and refusing an
    // aliased binding would fail a correctly wired app — which is the other half of this check being usable.
    const cwd = scaffolded({
      'src/server.ts': [
        'import { protectFetch as shield } from "./patchstack/guard";',
        '',
        'export default { fetch: shield(async () => new Response("ok")) };',
        '',
      ].join('\n'),
    });

    expect(genericVerify(cwd).wired).toBe(true);
  });

  it('accepts a namespace import whose member is called', () => {
    const cwd = scaffolded({
      'src/server.ts': [
        'import * as guard from "./patchstack/guard";',
        '',
        'export default { fetch: guard.protectFetch(async () => new Response("ok")) };',
        '',
      ].join('\n'),
    });

    expect(genericVerify(cwd).wired).toBe(true);
  });

  it('accepts a renamed destructured require', () => {
    const cwd = scaffolded({
      'server.cjs': [
        'const { patchstackMiddleware: shield } = require("./patchstack/guard");',
        'app.use(shield);',
        '',
      ].join('\n'),
    });

    expect(genericVerify(cwd).wired).toBe(true);
  });

  it('is not satisfied by a guard export name that came from somewhere else', () => {
    // The binding has to be the imported one. A local function that happens to share a name with a guard
    // export is not the guard, and counting it would make the check satisfiable without the guard at all.
    const cwd = scaffolded({
      'src/server.ts': [
        'import { screenResponse } from "./patchstack/guard";',
        '',
        'function protectFetch(handler) { return handler; }',
        'export default { fetch: protectFetch(async () => new Response("ok")) };',
        '',
      ].join('\n'),
    });

    expect(genericVerify(cwd).wired).toBe(false);
  });

  it('is not fooled by a commented-out import beside a real mention', () => {
    // Comment stripping has to be string-aware: a `//` inside a URL is not a comment, and blanking the rest
    // of that line could hide a real import — or reveal a commented one.
    const cwd = scaffolded({
      'src/server.ts': [
        'const docs = "https://example.test//guide";',
        '// import { protectFetch } from "./patchstack/guard";',
        'export default { docs };',
        '',
      ].join('\n'),
    });

    expect(genericVerify(cwd).wired).toBe(false);
  });
});

describe('routes registered before the guard', () => {
  function expressProject(serverLines: string[]): string {
    return project({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { express: '^4.19.2' } }),
      'src/server.js': serverLines.join('\n'),
    });
  }

  it('are reported, not counted as wired', () => {
    // "After the body parser" was the only ordering checked, and it is half the question: a route above the
    // guard is served without it, and the guard cannot move above the parser because it reads the parsed
    // body. Reporting the app fully wired would name protection this route does not have.
    const cwd = expressProject([
      "const express = require('express');",
      'const app = express();',
      "app.get('/early', (req, res) => res.send('early'));",
      'app.use(express.json());',
      'app.listen(3000);',
      '',
    ]);

    expressAdapter.wire(cwd, { cwd, force: false } as never);
    const report = expressAdapter.verify(cwd);

    expect(report.wired).toBe(false);
    const check = report.checks.find((c) => c.label.includes('every route registered after the guard'));
    expect(check?.ok).toBe(false);
    // Line 4 after patching: the guard's own import shifted the file down by one.
    expect(check?.hint).toMatch(/line 4/);
  });

  it('include a mounted router, which registers everything in it', () => {
    const cwd = expressProject([
      "const express = require('express');",
      'const app = express();',
      "app.use('/api', require('./routes'));",
      'app.use(express.json());',
      'app.listen(3000);',
      '',
    ]);

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    expect(expressAdapter.verify(cwd).wired).toBe(false);
  });

  it('do not include plain middleware, which the parser anchor already orders', () => {
    // The control. `app.use(fn)` is middleware, not a route, and treating it as one would report every
    // ordinary app as having unprotected routes — which makes the check noise.
    const cwd = expressProject([
      "const express = require('express');",
      'const app = express();',
      'app.use(cors());',
      'app.use(express.json());',
      "app.get('/late', (req, res) => res.send('late'));",
      'app.listen(3000);',
      '',
    ]);

    expressAdapter.wire(cwd, { cwd, force: false } as never);

    expect(expressAdapter.verify(cwd).wired).toBe(true);
  });
});

describe('a check this machine cannot answer', () => {
  it('is reported as neither passing nor failing', () => {
    // The runtimes that cannot read a config file need the credential as a deployment environment variable,
    // and the CLI cannot see a hosting platform's environment. Reported as a tick it would claim something
    // nobody established; as a cross it would fail a correctly configured app and train people to ignore
    // the output.
    const cwd = project({
      'package.json': JSON.stringify({ name: 'fixture' }),
      'src/server.ts':
        'import { protectFetch } from "./patchstack/guard";\nexport default { fetch: protectFetch(async () => new Response("ok")) };\n',
    });
    scaffoldGeneric(cwd, { cwd, force: false } as never, 'generic-guard.ts');

    const report = runVerify(cwd);
    const note = report.checks.find((c) => c.unverifiable);

    expect(note).toBeDefined();
    expect(note?.label).toMatch(/PATCHSTACK_API_KEY/);
    // And it does not decide the verdict either way.
    expect(report.wired).toBe(true);
  });

  it('is absent for a runtime that reads the file itself', () => {
    // The control: a Node app reads its own config, so there is no unanswerable question to raise — and a
    // note printed everywhere would be a note nobody reads.
    const cwd = project({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { express: '^4.19.2' } }),
      'src/server.js': [
        "const express = require('express');",
        'const app = express();',
        'app.use(express.json());',
        'app.listen(3000);',
        '',
      ].join('\n'),
    });
    expressAdapter.wire(cwd, { cwd, force: false } as never);

    expect(runVerify(cwd).checks.some((c) => c.unverifiable)).toBe(false);
  });
});
