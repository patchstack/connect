// What do the published bundles execute when they are merely imported?
//
// The question exists because of `sideEffects: false`. That field is a promise: if a consumer imports
// nothing from a module, the bundler may drop the module without evaluating it. Declaring it when it is
// false does not produce a build error — it produces an application missing a side effect it depended on,
// at run time, in the consumer's build and not ours. For a package whose job is to be present and
// screening requests, "silently not there" is the worst available failure.
//
// This is a REPORT, not a verdict, and the distinction is load-bearing rather than modest. It walks the
// region of the AST that runs at import time and names anything that can execute, deliberately
// over-reporting rather than recognising shapes it believes are safe: an allowlist gets this wrong in the
// dangerous direction, and an earlier version of this script called `export default init()`,
// `class C extends init()` and a bare `import './register.js'` all clean.
//
// What it cannot do is prove purity. It sees syntax, not behaviour: a call it reports may be harmless and
// a call it accepts may not be. Read it before declaring `sideEffects: false`. Do not rely on it instead.
// The evidence that this package survives a bundler is `npm run test:bundled`, which attacks the bundled
// guard rather than reading it.
//
// `npm run audit:side-effects` runs the self-test and then reports on every emitted artifact.
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Constructors that build a value and touch nothing else — PROVIDED their arguments are local literals.
 * `new Set([1, 2])` builds a set; `new Set(somethingFromElsewhere)` walks an iterator that may be
 * somebody else's code.
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
 * Whether an expression is built here and now, out of things this file can see.
 *
 * The distinction matters wherever a value is CONSUMED rather than merely referenced: a spread runs an
 * iterator or a getter, and so does a built-in over a non-literal. Both are code, and if the value came
 * from an import then it is code this file cannot see.
 *
 * `locals` carries the module-scope names already proven to hold local literals — see
 * `localLiteralBindings`. Anything unresolved is treated as foreign, which is the conservative direction.
 */
function isLocalLiteral(node, locals = new Map()) {
  if (node === undefined) return true;
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return true;
    case ts.SyntaxKind.Identifier:
      // A module-scope name in THIS file bound to a local literal is itself a local literal. An import, a
      // parameter, or a name bound to a call never enters the map and so stays foreign. Bundles are full of
      // `new Set(PHASES)` over a frozen array declared above it, and reporting those makes the report
      // unreadable — which is its own way of not being a tripwire.
      return locals.get(node.text) === true;
    case ts.SyntaxKind.ArrayLiteralExpression:
      return node.elements.every((e) => isLocalLiteral(e, locals));
    case ts.SyntaxKind.ObjectLiteralExpression:
      return node.properties.every(
        (prop) =>
          !ts.isSpreadAssignment(prop) &&
          (!('initializer' in prop) || prop.initializer === undefined || isLocalLiteral(prop.initializer, locals)),
      );
    case ts.SyntaxKind.BinaryExpression:
      // String building out of local pieces, which is how a bundler emits a composed pattern.
      return (
        node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        isLocalLiteral(node.left, locals) &&
        isLocalLiteral(node.right, locals)
      );
    case ts.SyntaxKind.ParenthesizedExpression:
      return isLocalLiteral(node.expression, locals);
    case ts.SyntaxKind.CallExpression:
      // The one exempt call form, so the exemption composes with itself: the engine's constant tables are
      // written as `Object.freeze({ … Object.freeze([…]) … })` several levels deep.
      return isFreezeOfLiteral(node, locals);
    default:
      return false;
  }
}

/**
 * `Object.freeze(<literal>)` — the one call shape this audit accepts, and only over an argument that is
 * constructed in place.
 *
 * The exemption is provable rather than assumed: freezing an object or array literal that no other code
 * has a reference to yet cannot be observed from anywhere else, so evaluating it has no effect a bundler
 * could drop.
 *
 * `Object.freeze(someImportedThing)` is NOT accepted: that mutates an object someone else can see.
 * Neither is `Object.freeze({ ...imported })`, which runs somebody else's getters before it freezes
 * anything — the freeze being harmless says nothing about the spread.
 *
 * Mutually recursive with `isLocalLiteral`; both are hoisted declarations, so the order here is free.
 */
function isFreezeOfLiteral(node, locals = new Map()) {
  if (node.expression.getText() !== 'Object.freeze') return false;
  const [arg, ...rest] = node.arguments ?? [];

  return (
    rest.length === 0 &&
    arg !== undefined &&
    (ts.isObjectLiteralExpression(arg) || ts.isArrayLiteralExpression(arg)) &&
    isLocalLiteral(arg, locals)
  );
}

/**
 * Module-scope names in this file that are provably bound to a local literal.
 *
 * One pass, in source order, so a constant built from constants above it resolves while anything else is
 * simply left out. No ordering or reassignment analysis: a name is either provably a local literal or it
 * is not, and everything unproven is treated as foreign by the caller.
 */
function localLiteralBindings(sf) {
  const locals = new Map();

  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue;
      locals.set(d.name.text, isLocalLiteral(d.initializer, locals));
    }
  }

  return locals;
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
 *
 * Findings carry a severity. `executes` is code in this file. `elsewhere` is an import: it evaluates
 * another module, and what that evaluation does is not visible from here — reported rather than accepted,
 * because in a bundle the remaining imports are externals and treating them as findings would drown the
 * report, while calling them safe would be a claim this cannot support.
 */
function findExecutable(sf) {
  const found = [];
  const locals = localLiteralBindings(sf);
  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const text = (node) => node.getText().slice(0, 100).replace(/\s+/g, ' ');
  const flag = (node, why, severity = 'executes') => found.push({ line: at(node), text: text(node), why, severity });

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
      // evaluated per call. A COMPUTED NAME does run, because the key has to exist before the class does.
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
      case ts.SyntaxKind.ImportDeclaration:
        // Both forms evaluate the target module. A side-effect import — no bindings — exists ONLY to do
        // that, so it is a finding outright; one with bindings is reported at `elsewhere`.
        flag(
          node,
          node.importClause === undefined
            ? 'side-effect import: exists only to run another module'
            : 'imports and therefore evaluates another module, whose contents are not visible here',
          node.importClause === undefined ? 'executes' : 'elsewhere',
        );

        return;
      case ts.SyntaxKind.ThrowStatement:
        flag(node, 'throw at module scope: evaluating this module fails');

        return;
      case ts.SyntaxKind.CallExpression: {
        const callee = node.expression.getText();
        if (isFreezeOfLiteral(node, locals)) {
          // Accepted, but keep walking the literal: what is inside it may not be.
          for (const a of node.arguments ?? []) visit(a);

          return;
        }
        if (LAZY_WRAPPERS.has(callee)) {
          // The wrapper does not run its argument, but the argument may contain code that runs for other
          // reasons, so keep walking it.
          for (const a of node.arguments ?? []) visit(a);

          return;
        }
        flag(node, `call at module scope: ${callee.slice(0, 40)}`);

        return;
      }
      case ts.SyntaxKind.NewExpression: {
        const ctor = node.expression.getText();
        if (!PURE_CONSTRUCTORS.has(ctor)) {
          flag(node, `construction at module scope: new ${ctor.slice(0, 40)}`);

          return;
        }
        if ((node.arguments ?? []).some((a) => !isLocalLiteral(a, locals))) {
          flag(node, `new ${ctor} over a value from elsewhere: may run its iterator or getters`);

          return;
        }
        break;
      }
      case ts.SyntaxKind.SpreadElement:
      case ts.SyntaxKind.SpreadAssignment:
        // `[...x]` walks x's iterator and `{ ...x }` runs x's getters. Both are code, and if x came from
        // elsewhere it is not code this file can see.
        if (!isLocalLiteral(node.expression, locals)) {
          flag(node, 'spread of a value from elsewhere: runs its iterator or getters');

          return;
        }
        break;
      case ts.SyntaxKind.TaggedTemplateExpression:
        flag(node, 'tagged template: invokes the tag function');

        return;
      case ts.SyntaxKind.AwaitExpression:
        flag(node, 'top-level await');

        return;
      case ts.SyntaxKind.ClassStaticBlockDeclaration:
        flag(node, 'static initialisation block');

        return;
      case ts.SyntaxKind.DeleteExpression:
        flag(node, 'delete: mutates an object');

        return;
      case ts.SyntaxKind.BinaryExpression: {
        // Assignment to anything reachable from outside — `module.exports = …`, `globalThis.x = …`.
        if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
          const op = node.operatorToken.kind;
          const assigns =
            op === ts.SyntaxKind.EqualsToken ||
            (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment);
          if (assigns) flag(node, 'assignment to a property at module scope');
        }
        break;
      }
      case ts.SyntaxKind.PrefixUnaryExpression:
      case ts.SyntaxKind.PostfixUnaryExpression:
        if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
          flag(node, 'increment or decrement at module scope');

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
 * The audit's own tests, and the only part of this script with teeth.
 *
 * A tripwire that cannot fire is the same defect as no tripwire, and this one is easy to break in the
 * silent direction: many of the cases below were reported clean by an earlier version that recognised
 * "safe" shapes instead of walking for executable ones. They are pinned so that cannot come back
 * unnoticed.
 *
 * Three outcomes, not two. `elsewhere` exists so that a bound import is neither treated as a finding nor
 * declared safe — importing evaluates the target, and this script cannot see what that does.
 */
const CASES = [
  { src: "import './register.js';", expect: 'executes', what: 'side-effect import' },
  { src: 'export default initialize();', expect: 'executes', what: 'call in a default export' },
  { src: 'class C extends initialize() {}', expect: 'executes', what: 'call in a heritage clause' },
  { src: 'const x = { ...initialize() };', expect: 'executes', what: 'call in an object spread' },
  { src: 'const x = `${initialize()}`;', expect: 'executes', what: 'call in a template interpolation' },
  { src: 'class D { [initialize()] = 1; }', expect: 'executes', what: 'call in a computed member name' },
  { src: 'class E { static p = initialize(); }', expect: 'executes', what: 'call in a static field initialiser' },
  { src: 'class F { static { initialize(); } }', expect: 'executes', what: 'static initialisation block' },
  { src: 'globalThis.patched = true;', expect: 'executes', what: 'assignment to a global' },
  { src: 'const x = tag`text`;', expect: 'executes', what: 'tagged template' },
  { src: 'const x = await ready();', expect: 'executes', what: 'top-level await' },
  { src: 'const x = new Thing();', expect: 'executes', what: 'construction of an unknown class' },
  { src: 'delete globalThis.x;', expect: 'executes', what: 'delete' },
  { src: 'counter++;', expect: 'executes', what: 'increment' },
  { src: "throw new Error('boom');", expect: 'executes', what: 'throw at module scope' },
  { src: 'const s = new Set(importedIterable);', expect: 'executes', what: 'a built-in consuming a value from elsewhere' },
  { src: 'const a = [...importedIterable];', expect: 'executes', what: 'array spread of a value from elsewhere' },
  { src: 'const o = { ...importedObject };', expect: 'executes', what: 'object spread of a value from elsewhere' },
  { src: 'const o = Object.freeze({ ...importedObject });', expect: 'executes', what: 'freezing a spread of a value from elsewhere' },
  { src: 'Object.freeze(someImportedThing);', expect: 'executes', what: 'freezing something others can see' },

  // NOT 'clean'. Importing evaluates the target, and an earlier version of this list called that safe.
  { src: "import { readFileSync } from 'node:fs';", expect: 'elsewhere', what: 'an import with bindings' },

  { src: 'export function a(x = compute()) { return initialize(); }', expect: 'clean', what: 'a function body and its parameter defaults' },
  { src: 'export const b = () => initialize();', expect: 'clean', what: 'an arrow body' },
  { src: 'class G { p = initialize(); m() { return initialize(); } get g() { return initialize(); } }', expect: 'clean', what: 'instance fields and method bodies' },
  { src: "const s = new Set(['a', 'b']);", expect: 'clean', what: 'a built-in over its own literal' },
  { src: 'const a = [...[1, 2]];', expect: 'clean', what: 'spread of a literal' },
  { src: 'const o = Object.freeze({ a: Object.freeze([1, 2]) });', expect: 'clean', what: 'freezing a fresh literal, nested' },
  { src: "const P = ['a', 'b']; const s = new Set(P);", expect: 'clean', what: 'a built-in over a local constant' },
  { src: "const G = 'x'; const r = new RegExp('(' + G + ')');", expect: 'clean', what: 'a pattern composed from local constants' },
  { src: 'const o = { k: 1, n: { d: [1, 2] } };', expect: 'clean', what: 'plain data' },
  { src: 'const t = `plain ${name} text`;', expect: 'clean', what: 'a template over an identifier' },
];

if (process.argv.includes('--selftest')) {
  let failures = 0;
  const label = { executes: 'flags  ', elsewhere: 'notes  ', clean: 'allows ' };

  for (const { src, expect: wanted, what } of CASES) {
    const sf = ts.createSourceFile('case.js', src, ts.ScriptTarget.ESNext, true);
    const found = findExecutable(sf);
    const got = found.some((e) => e.severity === 'executes')
      ? 'executes'
      : found.length > 0
        ? 'elsewhere'
        : 'clean';
    const ok = got === wanted;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label[wanted]} ${what}${ok ? '' : ` — got ${got}`}`);
  }
  console.log(
    failures === 0
      ? `\n  all ${CASES.length} audit cases behave as specified.`
      : `\n  ${failures} case(s) wrong.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('usage: node scripts/side-effect-audit.mjs [--selftest] <file> [file ...]');
  process.exit(2);
}

/**
 * This REPORTS. It does not pass or fail on what it finds.
 *
 * Which was tempting to do differently, and every version of that gate was wrong:
 *
 *   - A CommonJS bundle executes at module scope by construction — `module.exports = …`, `require(…)`,
 *     definitions on the exports object. No version of it does not.
 *   - `dist/cli.js` ends in `main().then(…)`. It is a bin; executing on evaluation is its entire job.
 *   - The library entries are clean today, but a benign lazy-init call is indistinguishable here from a
 *     harmful one, so gating on them would mean either an allowlist — which is what made an earlier
 *     version of this script report `export default init()` as pure — or a red build for a call nobody
 *     needs to act on.
 *
 * So the exit code speaks only for what is unambiguously wrong: a file that does not exist, or the
 * self-test failing.
 */
const isCommonJs = (file) => file.endsWith('.cjs');

let missing = 0;
let reported = 0;

for (const file of files) {
  if (!existsSync(file)) {
    console.log(`  ${file}: MISSING`);
    missing++;

    continue;
  }
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true);
  const effects = findExecutable(sf);
  const executes = effects.filter((e) => e.severity === 'executes');
  const elsewhere = effects.filter((e) => e.severity === 'elsewhere');

  console.log(
    `\n  ${file}  (${(src.length / 1024).toFixed(0)} kB, ${sf.statements.length} top-level statements)` +
      `${isCommonJs(file) ? '  [CommonJS: executes by construction]' : ''}`,
  );

  if (executes.length === 0) {
    console.log(
      elsewhere.length === 0
        ? '    nothing that executes at module scope'
        : `    nothing that executes here; ${elsewhere.length} import(s) evaluate modules this cannot see`,
    );

    continue;
  }

  reported += executes.length;
  // Capped, because a CommonJS bundle produces a long and uninformative list and the first few say it.
  for (const e of executes.slice(0, 10)) {
    console.log(`    L${String(e.line).padEnd(6)} ${e.why}`);
    console.log(`            ${e.text}`);
  }
  if (executes.length > 10) console.log(`    … and ${executes.length - 10} more`);
  // Never hidden behind the findings above. Imports are the part this script explicitly cannot see into,
  // so leaving them out whenever there is something louder to print would understate what is unknown.
  if (elsewhere.length > 0) {
    console.log(`    plus ${elsewhere.length} import(s) that evaluate modules this cannot see`);
  }
}

console.log(`\n  ${reported} construct(s) that execute at module scope, across ${files.length} artifact(s).`);
console.log('  This is a report, not a verdict. A clean line means nothing there obviously executes — not');
console.log('  that a module is safe to drop, because what a called function does is invisible from one');
console.log("  bundle's syntax. Read it before declaring `sideEffects: false`; do not rely on it instead.");

// Only the unambiguous failure. See the note above `isCommonJs`.
process.exit(missing > 0 ? 1 : 0);
