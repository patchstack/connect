// What the runtime check will and will not launch.
//
// The negatives are the point. This resolver decides what a verification command executes in somebody
// else's repository, so every case that must come back `unavailable` is written down: TypeScript
// entries, framework launchers, anything reached through a package manager, and anything outside the
// project. A resolver that reached for one more of those to raise its hit rate would be running code
// the author never asked it to run.
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveEntry } from '../../src/protect/install/runtime/entry.js';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-runtime-entry-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }

  return dir;
}

const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: 'app', ...fields });

describe('an entry it will launch', () => {
  it('takes the start script when it is a plain node invocation', () => {
    const dir = project({ 'package.json': pkg({ scripts: { start: 'node dist/server.js' } }), 'dist/server.js': '', 'server.js': '' });
    expect(resolveEntry(dir)).toEqual({
      kind: 'entry',
      file: join(dir, 'dist/server.js'),
      nodeArgs: [],
      appArgs: [],
      from: 'the "start" script',
    });
  });

  it('passes the script’s own node flags through', () => {
    const dir = project({ 'package.json': pkg({ scripts: { start: 'node --enable-source-maps app.js' } }), 'app.js': '' });
    expect(resolveEntry(dir)).toMatchObject({ kind: 'entry', nodeArgs: ['--enable-source-maps'] });
  });

  it('falls back to the package main field', () => {
    const dir = project({ 'package.json': pkg({ main: 'lib/entry.mjs' }), 'lib/entry.mjs': '' });
    expect(resolveEntry(dir)).toMatchObject({ kind: 'entry', file: join(dir, 'lib/entry.mjs'), from: 'the package "main" field' });
  });

  it('falls back to a conventional entry, naming which one', () => {
    const dir = project({ 'package.json': pkg({}), 'src/index.js': '' });
    expect(resolveEntry(dir)).toMatchObject({ kind: 'entry', file: join(dir, 'src/index.js'), from: 'src/index.js' });
  });

  it('passes a self-contained flag through', () => {
    const dir = project({ 'package.json': pkg({ scripts: { start: 'node --max-old-space-size=4096 app.js' } }), 'app.js': '' });
    expect(resolveEntry(dir)).toMatchObject({ kind: 'entry', file: join(dir, 'app.js'), nodeArgs: ['--max-old-space-size=4096'] });
  });

  it('follows a symlink that stays inside the project', () => {
    const dir = project({ 'package.json': pkg({ scripts: { start: 'node server.js' } }), 'src/real.js': '' });
    symlinkSync(join(dir, 'src/real.js'), join(dir, 'server.js'));
    expect(resolveEntry(dir)).toMatchObject({ kind: 'entry', file: join(dir, 'server.js') });
  });

  it('passes the app’s own arguments through, in order', () => {
    const dir = project({ 'package.json': pkg({ scripts: { start: 'node server.js --port 8080' } }), 'server.js': '' });
    expect(resolveEntry(dir)).toMatchObject({ kind: 'entry', file: join(dir, 'server.js'), appArgs: ['--port', '8080'] });
  });

  it('prefers start over serve when a project has both', () => {
    const dir = project({
      'package.json': pkg({ scripts: { start: 'node start.js', serve: 'node serve.js' } }),
      'start.js': '',
      'serve.js': '',
    });
    expect(resolveEntry(dir)).toMatchObject({ file: join(dir, 'start.js'), from: 'the "start" script' });
  });

  it('reads serve only when there is no start script', () => {
    const dir = project({ 'package.json': pkg({ scripts: { serve: 'node run.cjs' } }), 'run.cjs': '' });
    expect(resolveEntry(dir)).toMatchObject({ kind: 'entry', from: 'the "serve" script' });
  });
});

describe('what it refuses to launch', () => {
  const refuses = (files: Record<string, string>, matching: RegExp) => {
    const result = resolveEntry(project(files));
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toMatch(matching);
  };

  it('will not run a framework launcher', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'next start' } }), 'server.js': '' }, /outside the bounded/);
  });

  it('will not run a TypeScript entry through a loader', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'tsx server.ts' } }), 'server.ts': '' }, /own toolchain/);
  });

  it('will not run a TypeScript entry named as node would not load it', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'node server.ts' } }), 'server.ts': '' }, /own toolchain/);
  });

  it('will not run another runtime', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'bun server.js' } }), 'server.js': '' }, /outside the bounded/);
  });

  it('will not run a watcher that would restart the app under it', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'nodemon server.js' } }), 'server.js': '' }, /outside the bounded/);
  });

  it('will not half-run a compound command', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'node server.js && echo started' } }), 'server.js': '' }, /own toolchain/);
  });

  it('will not start a REPL', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'node --experimental-repl-await' } }) }, /own toolchain/);
  });

  it('will not reach a sibling directory whose name starts with the project’s', () => {
    // The sibling is named so that a bare prefix comparison against the project root accepts it, and it
    // holds a real file, so nothing else in the resolver would refuse it.
    const dir = project({});
    const sibling = `${dir}-staging`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'server.js'), '');
    writeFileSync(join(dir, 'package.json'), pkg({ scripts: { start: `node ../${basename(sibling)}/server.js` } }));
    try {
      expect(resolveEntry(dir).kind).toBe('unavailable');
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('will not read a flag’s operand as the entry file', () => {
    // `--require` takes the NEXT token, so a whitespace split reads `boot.cjs` as the entry and would
    // launch a different program than the script describes. Both forms are refused, and for the same
    // reason a preload runs project code before the listener reporter is in place.
    for (const start of ['node --require ./boot.cjs server.js', 'node -r ./boot.cjs server.js', 'node --require=./boot.cjs server.js']) {
      const result = resolveEntry(project({ 'package.json': pkg({ scripts: { start } }), 'boot.cjs': '', 'server.js': '' }));
      expect(result.kind, start).toBe('unavailable');
    }
  });

  it('will not let a flag replace the entry it is about to report', () => {
    // `--eval` takes the program out of the file named on the command line: node runs the string and
    // leaves `server.js` as an ordinary argument. So this script starts `alternate.js` while the file
    // the resolver would report is `server.js`. A pass reported against an entry that never ran is the
    // worst answer this command can give, so a flag that can do this is not passable in any form.
    const start = 'node --eval=import(process.argv[2]) server.js ./alternate.js';
    const result = resolveEntry(project({ 'package.json': pkg({ scripts: { start } }), 'server.js': '', 'alternate.js': '' }));
    expect(result.kind).toBe('unavailable');
  });

  it('will not run a valued flag that evaluates or prints a program', () => {
    for (const start of [
      'node --eval=0 server.js',
      'node --print=0 server.js',
      'node -e=0 server.js',
      'node -p=0 server.js',
      'node --import=./boot.mjs server.js',
      'node --experimental-loader=./loader.mjs server.js',
    ]) {
      const result = resolveEntry(project({ 'package.json': pkg({ scripts: { start } }), 'server.js': '', 'boot.mjs': '', 'loader.mjs': '' }));
      expect(result.kind, start).toBe('unavailable');
    }
  });

  it('will not pass on a valued flag it does not recognise', () => {
    // The allowlist is the whole guard: a `--name=value` this has never heard of may do anything,
    // including changing which file Node treats as the program.
    for (const start of ['node --experimental-policy=./p.json server.js', 'node --env-file=.env server.js', 'node --made-up=1 server.js']) {
      const result = resolveEntry(project({ 'package.json': pkg({ scripts: { start } }), 'server.js': '', '.env': '', 'p.json': '' }));
      expect(result.kind, start).toBe('unavailable');
    }
  });

  it('will not run a flag it cannot tell takes an operand', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'node --experimental-specifier-resolution node server.js' } }), 'server.js': '' }, /own toolchain/);
  });

  it('will not open a debugger port', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'node --inspect server.js' } }), 'server.js': '' }, /own toolchain/);
  });

  it('will not read past a bare `--`', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'node -- server.js' } }), 'server.js': '' }, /own toolchain/);
  });

  it('will not guess at shell syntax it is not evaluating', () => {
    for (const start of [
      'node "my server.js"',
      'node $ENTRY',
      'node dist/*.js',
      'node dist/[ab].js',
      'node ${ENTRY}',
      'node server.js # the shell ignores this',
      'node server.js one\\ argument',
      'node server.js (one)',
      'node server.js ~/config.json',
      'node server.js\nnode alternate.js',
    ]) {
      const result = resolveEntry(
        project({ 'package.json': pkg({ scripts: { start } }), 'server.js': '', 'alternate.js': '', 'my server.js': '' }),
      );
      expect(result.kind, start).toBe('unavailable');
    }
  });

  it('will not follow a symlink out of the project', () => {
    // The written path is inside the project; the file that would run is not. Only the real paths say so.
    const dir = project({ 'package.json': pkg({ scripts: { start: 'node server.js' } }) });
    const outside = mkdtempSync(join(tmpdir(), 'ps-runtime-entry-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'target.js'), '');
    symlinkSync(join(outside, 'target.js'), join(dir, 'server.js'));
    expect(resolveEntry(dir).kind).toBe('unavailable');
  });

  it('will not go through a package manager', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'npm run serve' } }), 'server.js': '' }, /outside the bounded/);
  });

  it('does not copy an unavailable start command into its diagnostic', () => {
    const secret = 'ps-secret-5d2a9f';
    const dir = project({
      'package.json': pkg({ scripts: { start: `node --made-up=${secret} server.js` } }),
      'server.js': '',
    });
    const result = resolveEntry(dir);
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).not.toContain(secret);
  });

  it('will not run a script that builds first', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'npm run build && node dist/index.js' } }), 'dist/index.js': '' }, /own toolchain/);
  });

  it('will not run a script wrapped in an environment shim', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'cross-env NODE_ENV=production node app.js' } }), 'app.js': '' }, /outside the bounded/);
  });

  it('will not fall back past a declared script it cannot run', () => {
    // `server.js` exists and would otherwise be launched. The project said it runs Next; that is the answer.
    refuses({ 'package.json': pkg({ scripts: { start: 'next start' } }), 'server.js': '', 'src/index.js': '' }, /outside the bounded/);
  });

  it('will not follow a start script out of the project', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'node ../elsewhere/server.js' } }) }, /own toolchain/);
  });

  it('will not follow an absolute path', () => {
    refuses({ 'package.json': pkg({ scripts: { start: 'node /usr/local/bin/thing.js' } }) }, /own toolchain/);
  });

  it('will not launch a directory that only looks like an entry', () => {
    // `main: "."` and `node .` both resolve through package semantics rather than to a file.
    refuses({ 'package.json': pkg({ main: '.', scripts: { start: 'node .' } }) }, /own toolchain/);
  });

  it('says so when the project has no loadable entry at all', () => {
    refuses({ 'package.json': pkg({}), 'src/index.ts': '' }, /declare one as a "start" script/);
  });

  it('reads a directory with no package.json as the wrong directory', () => {
    refuses({ 'src/index.ts': '' }, /no package.json/);
  });

  it('still launches a loadable entry when there is no package.json', () => {
    // The manifest is how a project DECLARES its entry; it is not what makes a file loadable.
    expect(resolveEntry(project({ 'server.js': '' }))).toMatchObject({ kind: 'entry', from: 'server.js' });
  });

  it('says so when package.json cannot be read as JSON', () => {
    refuses({ 'package.json': '{ not json', 'src/index.ts': '' }, /declare one as a "start" script/);
  });
});
