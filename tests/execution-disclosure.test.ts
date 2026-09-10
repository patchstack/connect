// Anything in this package that starts a process has to be classified — call site by call site — and
// anything that runs the PROJECT'S OWN code has to be disclosed in the shipped docs.
//
// Agents `npm pack` the tarball and audit it before installing. "This CLI executes your application" is
// the most consequential capability the package has, and one that appeared in `dist/` without a mention
// would read as misrepresentation: it gets installs refused, and the refusal would be correct.
//
// The polarity is inverted deliberately, following the endpoint disclosure test: an exact inventory of
// launch sites is discovered from the SYNTAX, and it must equal the inventory declared below. A new
// `spawn` — including a second one in a file that already has a classified launch — changes the
// inventory and stops the suite until someone writes down what it launches. Files are also gated: a
// file may import `node:child_process` only if it appears in the table, which catches the call forms a
// walk over syntax could still miss (a computed member, a name passed around as a value).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every function `node:child_process` exports that starts something. */
const LAUNCHERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

/**
 * Both specifiers load the same module. A scan that knew only the prefixed one would miss the other,
 * and `child_process` is what a lot of existing code is written with.
 */
const MODULE_SPECIFIERS = ['node:child_process', 'child_process'];

/** The substring every specifier contains, for the cheap reject before the syntax is parsed. */
const MODULE = 'child_process';

interface Site {
  file: string;
  line: number;
  /** The exported name being called, however it was bound locally. */
  call: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);

    return /\.(?:ts|js|cjs|mjs)$/.test(name) ? [path] : [];
  });
}

/**
 * Launch sites in one file, from its syntax.
 *
 * Both halves matter. First the local names for the module's launchers are collected — a named import
 * with or without an alias, a namespace import, `require` destructured with either quote style, a
 * dynamic `import()` awaited or `.then`-ed, `require(...).spawn` used inline. Then every call whose
 * callee is one of those names, or a property of a namespace bound to the module, is a site.
 */
function launchSitesIn(file: string, source: string): Site[] {
  return analyse(file, source).sites;
}

/** Whether a file really imports the module, as opposed to naming it in a string. */
export function importsModuleIn(file: string, source: string): boolean {
  return analyse(file, source).imports;
}

function analyse(file: string, source: string): { imports: boolean; sites: Site[] } {
  const kind = file.endsWith('.cjs') ? ts.ScriptKind.JS : undefined;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const direct = new Map<string, string>(); // local name -> exported launcher name
  const namespaces = new Set<string>(); // local name bound to the whole module
  const sites: Site[] = [];
  let imports = false;
  const isModule = (node: ts.Node): boolean =>
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && MODULE_SPECIFIERS.includes(node.text);

  /** `{ spawn, exec: run }` in an import clause or a destructuring pattern. */
  const bindFromPattern = (node: ts.Node): void => {
    if (ts.isObjectBindingPattern(node)) {
      for (const element of node.elements) {
        const exported = element.propertyName ?? element.name;
        if (ts.isIdentifier(exported) && ts.isIdentifier(element.name)) direct.set(element.name.text, exported.text);
      }
      return;
    }
    if (ts.isNamedImports(node)) {
      for (const element of node.elements) direct.set(element.name.text, (element.propertyName ?? element.name).text);
      return;
    }
    if (ts.isIdentifier(node)) namespaces.add(node.text);
  };

  const collectBindings = (node: ts.Node): void => {
    // The module reached at all, in any of the forms that actually load it. A string that merely spells
    // its name — a fixture, a message, a pattern the map looks for in OTHER people's code — is not this.
    if (ts.isImportDeclaration(node) && isModule(node.moduleSpecifier)) imports = true;
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      isModule(node.arguments[0]!) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      imports = true;
    }
    // import … from 'node:child_process'
    if (ts.isImportDeclaration(node) && isModule(node.moduleSpecifier) && node.importClause) {
      const { name, namedBindings } = node.importClause;
      if (name) namespaces.add(name.text);
      if (namedBindings && ts.isNamespaceImport(namedBindings)) namespaces.add(namedBindings.name.text);
      if (namedBindings && ts.isNamedImports(namedBindings)) bindFromPattern(namedBindings);
    }
    // const … = require('node:child_process') / await import('node:child_process')
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isCallExpression(init) && init.arguments.length === 1 && isModule(init.arguments[0]!)) {
        const callee = init.expression;
        const requiring =
          (ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword;
        if (requiring) bindFromPattern(node.name);
      }
    }
    // import('node:child_process').then(({ spawn }) => …) and .then((cp) => …)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'then' &&
      ts.isCallExpression(node.expression.expression) &&
      node.expression.expression.arguments.length === 1 &&
      isModule(node.expression.expression.arguments[0]!)
    ) {
      const [callback] = node.arguments;
      if (callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const [parameter] = callback.parameters;
        if (parameter !== undefined) bindFromPattern(parameter.name);
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(tree);

  const lineOf = (node: ts.Node): number => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

  /** The launcher a member expression names, written either way: `cp.spawn` or `cp['spawn']`. */
  const launcherMember = (callee: ts.Expression): { name: string; receiver: ts.Expression } | null => {
    if (ts.isPropertyAccessExpression(callee) && LAUNCHERS.has(callee.name.text)) {
      return { name: callee.name.text, receiver: callee.expression };
    }
    if (ts.isElementAccessExpression(callee)) {
      const key = callee.argumentExpression;
      const literal = ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : null;
      if (literal !== null && LAUNCHERS.has(literal)) return { name: literal, receiver: callee.expression };
    }

    return null;
  };

  /** Whether a member expression's receiver is the module itself — a namespace, or an inline require. */
  const throughModule = (receiver: ts.Expression): boolean =>
    (ts.isIdentifier(receiver) && namespaces.has(receiver.text)) ||
    (ts.isCallExpression(receiver) && receiver.arguments.length === 1 && isModule(receiver.arguments[0]!));

  const collectCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const member = launcherMember(callee);
      if (ts.isIdentifier(callee) && direct.has(callee.text)) {
        sites.push({ file, line: lineOf(node), call: direct.get(callee.text)! });
      } else if (member !== null && throughModule(member.receiver)) {
        // `childProcess.spawn(…)`, `childProcess['spawn'](…)`, and the inline `require(…).spawn(…)`.
        sites.push({ file, line: lineOf(node), call: member.name });
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(tree);

  /**
   * A launcher binding that is not being called, which the walk above cannot classify.
   *
   * `const launch = spawn` puts a launcher somewhere this scan will not follow, and so does passing one
   * as an argument. Neither is a launch by itself, and either can become one out of sight of the
   * syntax — so an unclassified use is recorded like a launch is, and has to be written down before the
   * suite will pass. The binding site itself is not a use.
   */
  const collectEscapes = (node: ts.Node): void => {
    const { parent } = node;
    const called = parent !== undefined && ts.isCallExpression(parent) && parent.expression === node;
    const binding =
      parent !== undefined &&
      ((ts.isImportClause(parent) && parent.name === node) ||
        (ts.isNamespaceImport(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node));
    const namedMember =
      parent !== undefined &&
      ((ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
        (ts.isElementAccessExpression(parent) && parent.expression === node));

    if (ts.isIdentifier(node) && LAUNCHERS.has(direct.get(node.text) ?? '')) {
      const declaring =
        parent !== undefined && (ts.isImportSpecifier(parent) || ts.isBindingElement(parent) || ts.isNamespaceImport(parent));
      if (!called && !declaring) sites.push({ file, line: lineOf(node), call: `${direct.get(node.text)!} (not called)` });
    } else if (ts.isIdentifier(node) && namespaces.has(node.text) && !binding) {
      // A named property can be classified by the member walk below. Handing the whole module away, or
      // indexing it dynamically, can put any launcher beyond this scan and must change the inventory.
      const member = namedMember ? launcherMember(parent as ts.Expression) : null;
      const staticallyNonLauncher =
        namedMember &&
        member === null &&
        (ts.isPropertyAccessExpression(parent!) ||
          (ts.isElementAccessExpression(parent!) &&
            (ts.isStringLiteral(parent!.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(parent!.argumentExpression))));
      if (!namedMember || (!staticallyNonLauncher && member === null)) {
        sites.push({ file, line: lineOf(node), call: 'child_process namespace (not called)' });
      }
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      isModule(node.arguments[0]!) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      // The call itself may bind the module, select one statically named member, or feed a `.then`
      // callback; those forms are classified elsewhere. Passing the whole result directly, or reaching
      // through a dynamic key, can hide any launcher and therefore changes the inventory.
      const throughAwait = parent !== undefined && ts.isAwaitExpression(parent) ? parent.parent : parent;
      const binds = throughAwait !== undefined && ts.isVariableDeclaration(throughAwait) && throughAwait.initializer !== undefined;
      const member =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
          (ts.isElementAccessExpression(parent) && parent.expression === node))
          ? parent
          : null;
      const thenCallback = member !== null && ts.isPropertyAccessExpression(member) && member.name.text === 'then';
      const staticMember =
        member !== null &&
        (ts.isPropertyAccessExpression(member) ||
          (ts.isElementAccessExpression(member) &&
            (ts.isStringLiteral(member.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(member.argumentExpression))));
      if (!binds && !thenCallback && !staticMember) {
        sites.push({ file, line: lineOf(node), call: 'child_process namespace (not called)' });
      }
    } else if (!called && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      // The same recognition the call walk uses, applied where the launcher is NOT being called:
      // `register(cp.spawn)`, `const launch = cp['spawn']`, `cp.spawn.call(…)`. A launcher reached
      // through the module and then handed somewhere else is as unclassifiable as one reached through
      // a binding, and a namespace is how an already-allowed file most naturally reaches it.
      const member = launcherMember(node);
      if (member !== null && throughModule(member.receiver)) {
        sites.push({ file, line: lineOf(node), call: `${member.name} (not called)` });
      }
    }
    ts.forEachChild(node, collectEscapes);
  };
  collectEscapes(tree);

  return { imports, sites: sites.sort((a, b) => a.line - b.line) };
}

/** Files that reference the module at all, and every launch site in them. */
function scan(): { importers: string[]; sites: Site[] } {
  const importers: string[] = [];
  const sites: Site[] = [];
  for (const path of sourceFiles(join(root, 'src'))) {
    const source = readFileSync(path, 'utf8');
    // A cheap reject first, then the syntax decides: a file that never spells the name cannot import it.
    if (!source.includes(MODULE)) continue;
    const file = relative(root, path).replace(/\\/g, '/');
    const { imports, sites: found } = analyse(file, source);
    if (!imports) continue;
    importers.push(file);
    sites.push(...found);
  }

  return { importers, sites };
}

/**
 * What each launch site does, and whether it runs code the project wrote.
 *
 * Keyed by file and by the launcher called, with the number of times. A file may hold more than one
 * entry; what it may not do is hold an unlisted launch.
 */
const DECLARED: Array<{ file: string; call: string; times: number; executesProjectCode: boolean; what: string }> = [
  {
    file: 'src/protect/install/source-scope.ts',
    call: 'execFileSync',
    times: 1,
    executesProjectCode: false,
    what: '`node --check <file>` parses a file and exits; it never evaluates it',
  },
  {
    file: 'src/protect/install/runtime/probe.ts',
    call: 'spawn',
    times: 1,
    executesProjectCode: true,
    what: "`protect --check --runtime` starts the project's entry to see whether a request reaches the guard",
  },
  {
    file: 'src/protect/install/runtime/report-listeners.cjs',
    call: 'child_process namespace (not called)',
    times: 2,
    executesProjectCode: false,
    what: 'indexes the fixed launcher list to replace each function with the runtime verifier refusal',
  },
];

/** Files allowed to reference the module, including ones that launch nothing themselves. */
const ALLOWED_IMPORTERS: Record<string, string> = {
  'src/protect/install/source-scope.ts': 'the syntax check above',
  'src/protect/install/runtime/probe.ts': 'the runtime check above',
  'src/protect/install/runtime/report-listeners.cjs':
    'wraps the module in the verification child so a process the app starts is reported; every launch through it is the app’s own call, made with the app’s own arguments',
};

const inventory = (sites: Site[]): Record<string, number> =>
  sites.reduce<Record<string, number>>((acc, site) => ({ ...acc, [`${site.file} ${site.call}`]: (acc[`${site.file} ${site.call}`] ?? 0) + 1 }), {});

describe('every process this package can start', () => {
  it('is discovered by the scan at all — the scan itself has to work', () => {
    // Both known sites, so a walk that quietly stops recognising a call form cannot leave the
    // assertions below standing on nothing.
    expect(inventory(scan().sites)).toMatchObject({
      'src/protect/install/runtime/probe.ts spawn': 1,
      'src/protect/install/source-scope.ts execFileSync': 1,
    });
  });

  it('matches the declared inventory exactly, site for site', () => {
    const declared = DECLARED.reduce<Record<string, number>>((acc, entry) => ({ ...acc, [`${entry.file} ${entry.call}`]: entry.times }), {});
    expect(inventory(scan().sites)).toEqual(declared);
  });

  it('is only reachable from a file that was allowed to reach it', () => {
    const unexpected = scan().importers.filter((file) => ALLOWED_IMPORTERS[file] === undefined);
    expect(unexpected).toEqual([]);
  });

  it('has no allowance standing for a file that no longer references it', () => {
    // Otherwise the table becomes a list of things that used to be true.
    const importers = new Set(scan().importers);
    expect(Object.keys(ALLOWED_IMPORTERS).filter((file) => !importers.has(file))).toEqual([]);
  });

  it('says of exactly one site that it runs the project’s own code', () => {
    expect(DECLARED.filter((entry) => entry.executesProjectCode).map((entry) => entry.file)).toEqual([
      'src/protect/install/runtime/probe.ts',
    ]);
  });
});

describe('the scan recognises the forms a launch can take', () => {
  const found = (source: string) => launchSitesIn('probe.ts', source).map((site) => site.call);

  it.each([
    ['a named import', `import { spawn } from 'node:child_process';\nspawn('x');`],
    ['an aliased named import', `import { spawn as go } from 'node:child_process';\ngo('x');`],
    ['a namespace import', `import * as cp from 'node:child_process';\ncp.execFile('x');`],
    ['a default import', `import cp from 'node:child_process';\ncp.fork('x');`],
    ['a destructured require', `const { execSync } = require('node:child_process');\nexecSync('x');`],
    ['a destructured require in double quotes', `const { execSync } = require("node:child_process");\nexecSync('x');`],
    ['an aliased destructured require', `const { spawn: launch } = require('node:child_process');\nlaunch('x');`],
    ['a whole-module require', `const cp = require('node:child_process');\ncp.spawnSync('x');`],
    ['an inline require', `require('node:child_process').spawn('x');`],
    ['a dynamic import', `const { spawn } = await import('node:child_process');\nspawn('x');`],
    ['a namespace dynamic import', `const cp = await import('node:child_process');\ncp.spawn('x');`],
    ['a call split over lines', `import { spawn } from 'node:child_process';\nspawn(\n  'x',\n  [],\n);`],
    ['the specifier without the node: prefix', `import { spawn } from 'child_process';\nspawn('x');`],
    ['a destructured require without the prefix', `const { execSync } = require('child_process');\nexecSync('x');`],
    ['a computed member with a literal key', `import * as cp from 'node:child_process';\ncp['spawn']('x');`],
    ['a computed member on an inline require', `require('node:child_process')['exec']('x');`],
    ['a destructuring .then callback', `import('node:child_process').then(({ spawn }) => spawn('x'));`],
    ['an aliasing .then callback', `import('node:child_process').then(({ spawn: go }) => go('x'));`],
    ['a namespace .then callback', `import('node:child_process').then((cp) => cp.fork('x'));`],
  ])('finds %s', (_label, source) => {
    expect(found(source)).toHaveLength(1);
  });

  it('finds a second launch in a file that already has one', () => {
    expect(found(`import { spawn, execFile } from 'node:child_process';\nspawn('a');\nexecFile('b');`)).toEqual(['spawn', 'execFile']);
  });

  it.each([
    ['a computed member', `import * as cp from 'node:child_process';\ncp.spawn('a');\ncp['exec']('b');`, ['spawn', 'exec']],
    ['a .then callback', `import { spawn } from 'node:child_process';\nspawn('a');\nimport('node:child_process').then(({ fork }) => fork('b'));`, ['spawn', 'fork']],
    ['the unprefixed specifier', `import { spawn } from 'node:child_process';\nspawn('a');\nconst { exec } = require('child_process');\nexec('b');`, ['spawn', 'exec']],
  ])('finds a second launch written as %s in a file that already has one', (_label, source, expected) => {
    // The file-level allowance lets an already-classified file import the module, so a form the walk
    // misses in one of those files is an extra launch that changes no inventory and stops no suite.
    expect(found(source)).toEqual(expected);
  });

  it.each([
    ['assigned to another name', `import { spawn } from 'node:child_process';\nconst launch = spawn;\nlaunch('x');`],
    ['passed as an argument', `import { spawn } from 'node:child_process';\nregister(spawn);`],
    ['put in an object', `const { spawn } = require('node:child_process');\nmodule.exports = { launch: spawn };`],
  ])('records a launcher %s, which it cannot classify', (_label, source) => {
    // Not a launch by itself, and not something this scan can follow either. Recorded like a launch, so
    // it has to be written down before the suite passes.
    expect(found(source)).toEqual(['spawn (not called)']);
  });

  it.each([
    ['a namespace member passed as an argument', `import * as cp from 'node:child_process';\nregister(cp.spawn);`],
    ['a namespace member assigned away', `import * as cp from 'node:child_process';\nconst launch = cp['spawn'];`],
    ['a namespace member invoked through call', `import * as cp from 'node:child_process';\ncp.spawn.call(null, 'x');`],
    ['a namespace member invoked through apply', `const cp = require('node:child_process');\ncp.spawn.apply(null, ['x']);`],
    ['an inline require member passed along', `register(require('child_process').spawn);`],
  ])('records %s, which it cannot classify either', (_label, source) => {
    // A namespace is how a file that is already allowed to import the module reaches a launcher, so a
    // non-call use through one is exactly the shape that could add a launch without changing the table.
    expect(found(source)).toEqual(['spawn (not called)']);
  });

  it.each([
    ['a namespace assigned away', `import * as cp from 'node:child_process';\nconst other = cp;\nother.spawn('x');`],
    ['a namespace passed as an argument', `const cp = require('node:child_process');\nregister(cp);`],
    ['a namespace indexed dynamically', `import cp from 'node:child_process';\ncp[name]('x');`],
    ['an inline module passed as an argument', `register(require('node:child_process'));`],
  ])('records %s, which can hide any launcher', (_label, source) => {
    expect(found(source)).toEqual(['child_process namespace (not called)']);
  });

  it('does not mistake the binding itself for an unclassified use', () => {
    expect(found(`import { spawn } from 'node:child_process';\nspawn('x');`)).toEqual(['spawn']);
    expect(found(`import { spawn as go } from 'node:child_process';\ngo('x');`)).toEqual(['spawn']);
    expect(found(`const { spawn: go } = require('node:child_process');\ngo('x');`)).toEqual(['spawn']);
  });

  it('does not mistake a same-named function from somewhere else', () => {
    expect(found(`import { spawn } from './my-pool.js';\nspawn('x');`)).toEqual([]);
    expect(found(`const { exec } = require('./sql.js');\nexec('select 1');`)).toEqual([]);
  });

  it('does not mistake a regular expression for a launch', () => {
    expect(found(`import { spawn } from 'node:child_process';\nconst m = /x(y)/.exec('xy');\nspawn('a');`)).toEqual(['spawn']);
  });
});

describe('the docs', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const agentInstall = readFileSync(join(root, 'AGENT-INSTALL.md'), 'utf8');

  it('disclose that the runtime check starts the application', () => {
    for (const [name, text] of [
      ['README.md', readme],
      ['AGENT-INSTALL.md', agentInstall],
    ] as const) {
      expect(text, `${name} does not mention the flag`).toContain('--check --runtime');
      expect(text, `${name} does not say it starts the app`).toMatch(/START(S)? THE APP|start(s|ing)? the app/i);
    }
  });

  it('say which commands do not start it, since that is the question an auditor asks', () => {
    expect(readme).toMatch(/No other command runs your application/);
    expect(agentInstall).toMatch(/Nothing else runs the application/);
  });

  it('claim only traversal for a pass, in both places', () => {
    for (const text of [readme, agentInstall]) {
      expect(text).toContain('runtime traversal reached the scaffolded guard seam');
      expect(text).toMatch(/does not say\s+rules were delivered|It does not say\s*\n?rules were delivered/);
    }
  });

  it('do not claim the run covers listeners it cannot see', () => {
    // The run answers for one process. A claim about "every listener the app opens" would cover a
    // listener held by a process it can neither count nor ask.
    for (const text of [readme, agentInstall]) {
      expect(text).not.toMatch(/every (?:HTTP )?listener/i);
      expect(text).toMatch(/one process is the scope|answers for one process/i);
    }
  });

  it('name the other two ways a listener can fall outside that scope', () => {
    // A worker thread and a late listener are both inside "one process", so the process claim alone
    // reads as covering them. Each one ends a run at `2`, and a reader deciding whether to trust a pass
    // has to be able to find that out from the documents rather than from the source.
    for (const text of [readme, agentInstall]) {
      expect(text, 'a worker thread is not mentioned').toMatch(/worker thread/i);
      expect(text, 'the discovery window is not mentioned').toMatch(/discovery window/i);
    }
  });

  it('disclose that another process is refused rather than started for a partial answer', () => {
    for (const [name, text] of [
      ['README.md', readme],
      ['AGENT-INSTALL.md', agentInstall],
    ] as const) {
      expect(text, `${name} does not state the process refusal`).toMatch(
        /attempts? to start\s+another process[\s\S]{0,120}(?:launch is\s+)?refused/i,
      );
      expect(text, `${name} does not state what the app observes`).toContain('EPERM');
    }
  });

  it('disclose that an inherited NODE_OPTIONS decides whether the run happens at all', () => {
    // Node reads it before the command line, so a preload in the environment runs before the listener
    // handling. Refusing that is a behaviour of the command, and one an auditor would want stated.
    for (const text of [readme, agentInstall]) {
      expect(text).toContain('NODE_OPTIONS');
    }
  });
});
