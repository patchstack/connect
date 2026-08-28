// Does `sideEffects: false` tell a bundler the truth?
//
// That field is a promise: if a consumer imports nothing from a module, the bundler may drop the module
// without evaluating it. Declaring it when it is false does not produce a build error — it produces an
// application missing a side effect it depended on, at run time, in the consumer's build and not ours.
// For a package whose job is to be present and screening requests, "silently not there" is the worst
// available failure, so the field is only defensible with evidence behind it.
//
// This is a TRIPWIRE, not a proof. It reports constructs that execute when a module is evaluated, and it
// is deliberately built to over-report: it walks the region of the AST that runs at import time and flags
// anything that can execute, rather than recognising a list of shapes it believes are safe. An allowlist
// gets this wrong in the dangerous direction — `export default init()`, `class C extends init()` and
// `import './register.js'` all look like plain declarations to one, and all three run code.
//
// What it cannot do is prove purity. It sees one bundle's syntax, not what a called function does, and a
// clean report means "nothing here obviously executes", never "this module is safe to drop". The evidence
// that the package survives a bundler is `npm run test:bundled`, which attacks the bundled guard.
//
// Run as `npm run audit:side-effects` after a build.
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Constructors that build a value and touch nothing else. Everything else, including any call, is
 * reported — the audit does not try to decide whether a function is pure.
 */
const PURE_CONSTRUCTORS = new Set(['Set', 'Map', 'WeakSet', 'WeakMap', 'RegExp', 'Error', 'Date', 'URL']);

/**
 * esbuild's lazy CommonJS wrapper. `__commonJS({ 'x'() { … } })` stores a module body in a memoised
 * loader and returns it WITHOUT running it; the body executes on the first call.
 *
 * Narrow on purpose, and the narrowness is the point: the sibling helper `__toESM(require_x())` DOES
 * invoke the body at module scope, so only the wrapper itself is exempt and never a call to what it
 * returns.
 */
const LAZY_WRAPPERS = new Set(['__commonJS', '__esm']);

/**
 * `Object.freeze(<literal>)` — the one call shape this audit accepts, and only over an argument that is
 * constructed in place.
 *
 * The exemption is provable rather than assumed: freezing an object or array literal that no other code
 * has a reference to yet cannot be observed from anywhere else, so evaluating it has no effect a bundler
 * could drop. Nesting is handled by the ordinary recursion, so `Object.freeze(Object.freeze([…]))` is
 * accepted for the same reason at each level.
 *
 * `Object.freeze(someImportedThing)` is NOT accepted: that mutates an object someone else can see, which
 * is exactly the kind of import-time effect this exists to find.
 */
function isFreezeOfLiteral(node) {
  if (node.expression.getText() !== 'Object.freeze') return false;
  const [arg, ...rest] = node.arguments ?? [];

  return rest.length === 0 && arg !== undefined
    && (ts.isObjectLiteralExpression(arg) || ts.isArrayLiteralExpression(arg));
}

/**
 * Find everything that executes when this source file is evaluated.
 *
 * Two halves. `skip` prunes the subtrees that do NOT run at import time — function and method bodies,
 * instance field initialisers — so a module full of functions reports nothing. Everything still in scope
 * after that pruning is checked for constructs that execute.
 *
 * A class is the case worth naming: its method bodies do not run, but its `extends` clause, its computed
 * member names, its static field initialisers and its static blocks all do.
 */
function findExecutable(sf) {
  const found = [];
  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const text = (node) => node.getText().slice(0, 100).replace(/\s+/g, ' ');

  const visit = (node) => {
    // --- Regions that are NOT evaluated when the module is.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      // The body does not run at evaluation time, and neither do default parameter values — those are
      // evaluated per call. A COMPUTED NAME does run, because the key has to exist before the object or
      // class does.
      if (node.name && ts.isComputedPropertyName(node.name)) visit(node.name.expression);

      return;
    }

    // A non-static property initialiser runs on construction, not on evaluation.
    if (ts.isPropertyDeclaration(node)) {
      const isStatic = (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) !== 0;
      if (node.name && ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      if (isStatic && node.initializer) visit(node.initializer);

      return;
    }

    // --- Constructs that DO execute at evaluation time.
    switch (node.kind) {
      case ts.SyntaxKind.ImportDeclaration: {
        // A side-effect import — `import './register.js'` with no bindings — exists only to run another
        // module. An import WITH bindings is a dependency edge rather than a statement of its own, and is
        // reported separately as context.
        if (node.importClause === undefined) {
          found.push({ line: at(node), text: text(node), why: 'side-effect import: runs another module' });
        }

        return;
      }
      case ts.SyntaxKind.CallExpression: {
        const callee = node.expression.getText();
        if (isFreezeOfLiteral(node)) {
          // Keep walking the literal: the freeze is accepted, what is inside it may not be.
          for (const a of node.arguments ?? []) visit(a);

          return;
        }
        if (LAZY_WRAPPERS.has(callee)) {
          // The wrapper does not run its argument, but the argument may still contain code that runs for
          // other reasons, so keep walking it.
          for (const a of node.arguments ?? []) visit(a);

          return;
        }
        found.push({ line: at(node), text: text(node), why: `call at module scope: ${callee.slice(0, 40)}` });

        return;
      }
      case ts.SyntaxKind.NewExpression: {
        const ctor = node.expression.getText();
        if (!PURE_CONSTRUCTORS.has(ctor)) {
          found.push({ line: at(node), text: text(node), why: `construction at module scope: new ${ctor.slice(0, 40)}` });

          return;
        }
        break;
      }
      case ts.SyntaxKind.TaggedTemplateExpression:
        found.push({ line: at(node), text: text(node), why: 'tagged template: invokes the tag function' });

        return;
      case ts.SyntaxKind.AwaitExpression:
        found.push({ line: at(node), text: text(node), why: 'top-level await' });

        return;
      case ts.SyntaxKind.ClassStaticBlockDeclaration:
        found.push({ line: at(node), text: text(node), why: 'static initialisation block' });

        return;
      case ts.SyntaxKind.DeleteExpression:
        found.push({ line: at(node), text: text(node), why: 'delete: mutates an object' });

        return;
      case ts.SyntaxKind.BinaryExpression:
        // Assignment to anything reachable from outside — `module.exports = …`, `globalThis.x = …`.
        if (
          ts.isPropertyAccessExpression(node.left) ||
          ts.isElementAccessExpression(node.left)
        ) {
          const op = node.operatorToken.kind;
          const assigns =
            op === ts.SyntaxKind.EqualsToken ||
            (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment);
          if (assigns) {
            found.push({ line: at(node), text: text(node), why: 'assignment to a property at module scope' });
          }
        }
        break;
      case ts.SyntaxKind.PrefixUnaryExpression:
      case ts.SyntaxKind.PostfixUnaryExpression:
        if (
          node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken
        ) {
          found.push({ line: at(node), text: text(node), why: 'increment or decrement at module scope' });

          return;
        }
        break;
      default:
        break;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  return found;
}

/**
 * The audit's own tests.
 *
 * A tripwire that cannot fire is the same defect as no tripwire, and this one is easy to break in the
 * silent direction: every one of the CASES below was reported clean by an earlier version of this script
 * that recognised "safe" shapes instead of walking for executable ones. They are pinned here so that
 * cannot come back unnoticed.
 */
const CASES = [
  { src: "import './register.js';", flagged: true, what: 'side-effect import' },
  { src: 'export default initialize();', flagged: true, what: 'call in a default export' },
  { src: 'class C extends initialize() {}', flagged: true, what: 'call in a heritage clause' },
  { src: 'const x = { ...initialize() };', flagged: true, what: 'call in an object spread' },
  { src: 'const x = `${initialize()}`;', flagged: true, what: 'call in a template interpolation' },
  { src: 'class D { [initialize()] = 1; }', flagged: true, what: 'call in a computed member name' },
  { src: 'class E { static p = initialize(); }', flagged: true, what: 'call in a static field initialiser' },
  { src: 'class F { static { initialize(); } }', flagged: true, what: 'static initialisation block' },
  { src: 'globalThis.patched = true;', flagged: true, what: 'assignment to a global' },
  { src: 'const x = tag`text`;', flagged: true, what: 'tagged template' },
  { src: 'const x = await ready();', flagged: true, what: 'top-level await' },
  { src: 'const x = new Thing();', flagged: true, what: 'construction of an unknown class' },
  { src: 'delete globalThis.x;', flagged: true, what: 'delete' },
  { src: 'counter++;', flagged: true, what: 'increment' },

  { src: 'export function a(x = compute()) { return initialize(); }', flagged: false, what: 'a function body and its parameter defaults' },
  { src: 'export const b = () => initialize();', flagged: false, what: 'an arrow body' },
  { src: 'class G { p = initialize(); m() { return initialize(); } get g() { return initialize(); } }', flagged: false, what: 'instance fields and method bodies' },
  { src: "import { readFileSync } from 'node:fs';", flagged: false, what: 'an import with bindings' },
  { src: "const s = new Set(['a']); const r = new RegExp('x');", flagged: false, what: 'value-constructing built-ins' },
  { src: 'const o = Object.freeze({ a: Object.freeze([1, 2]) });', flagged: false, what: 'freezing a fresh literal' },
  { src: 'const o = { k: 1, n: { d: [1, 2] } };', flagged: false, what: 'plain data' },
  { src: 'const t = `plain ${name} text`;', flagged: false, what: 'a template over an identifier' },

  { src: 'Object.freeze(someImportedThing);', flagged: true, what: 'freezing something others can see' },
];

if (process.argv.includes('--selftest')) {
  let failures = 0;
  for (const { src, flagged, what } of CASES) {
    const sf = ts.createSourceFile('case.js', src, ts.ScriptTarget.ESNext, true);
    const got = findExecutable(sf).length > 0;
    const ok = got === flagged;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${flagged ? 'flags  ' : 'allows '} ${what}`);
  }
  console.log(failures === 0 ? `\n  all ${CASES.length} audit cases behave as specified.` : `\n  ${failures} case(s) wrong.`);
  process.exit(failures === 0 ? 0 : 1);
}

let bad = 0;
const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('usage: node scripts/side-effect-audit.mjs <file> [file ...]');
  process.exit(2);
}

for (const file of files) {
  if (!existsSync(file)) {
    console.log(`  ${file}: MISSING`);
    bad++;

    continue;
  }
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true);
  const effects = findExecutable(sf);
  console.log(`\n  ${file}  (${(src.length / 1024).toFixed(0)} kB, ${sf.statements.length} top-level statements)`);

  if (effects.length === 0) {
    console.log('    nothing that executes at module scope');

    continue;
  }
  bad += effects.length;
  // Capped, because a CommonJS bundle produces a long and uninformative list and the first few say it.
  for (const e of effects.slice(0, 12)) {
    console.log(`    L${String(e.line).padEnd(6)} ${e.why}`);
    console.log(`            ${e.text}`);
  }
  if (effects.length > 12) console.log(`    … and ${effects.length - 12} more`);
}

process.exit(bad > 0 ? 1 : 0);
