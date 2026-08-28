// Does `sideEffects: false` tell a bundler the truth?
//
// That field is a promise: if a consumer imports nothing from a module, the bundler may drop the module
// without evaluating it. Declaring it when it is false does not produce a build error — it produces an
// application missing a side effect it depended on, at run time, in the consumer's build and not ours.
// For a package whose job is to be present and screening requests, "silently not there" is the worst
// available failure, so the field is only defensible with an audit behind it.
//
// So this parses the PUBLISHED bundles (what a bundler actually sees, not the sources) and lists every
// top-level statement that is not a pure declaration. It is intentionally conservative: anything it
// cannot prove pure is reported for a human to read, and reporting something harmless costs a minute
// while missing something does not announce itself.
//
// Run as `npm run audit:side-effects` after a build.
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';

// What a bundler asks when it sees `sideEffects: false`: if nothing is imported FROM this module, is it
// safe to drop the module entirely? That is only true if evaluating it top to bottom does nothing
// observable. So: parse the published bundle and list every top-level statement that is not a pure
// declaration.
const DECL = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration, ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ExportDeclaration, ts.SyntaxKind.ExportAssignment, ts.SyntaxKind.EmptyStatement,
]);

// A `const x = <literal|function|class|pure call>` is a declaration whose initialiser must also be pure.
function initialiserIsPure(node) {
  if (!node) return true;
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral: case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.TrueKeyword: case ts.SyntaxKind.FalseKeyword: case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.ArrowFunction: case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassExpression: case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.RegularExpressionLiteral: case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return true;
    case ts.SyntaxKind.ObjectLiteralExpression:
      return node.properties.every((p) => !p.initializer || initialiserIsPure(p.initializer));
    case ts.SyntaxKind.ArrayLiteralExpression:
      return node.elements.every((e) => initialiserIsPure(e));
    case ts.SyntaxKind.NewExpression: {
      // `new Set([...])`, `new Map([...])`, `new RegExp(...)` construct a value and touch nothing else.
      const n = node.expression.getText();
      return ['Set', 'Map', 'WeakSet', 'WeakMap', 'RegExp', 'Error'].includes(n)
        && (node.arguments ?? []).every((a) => initialiserIsPure(a));
    }
    case ts.SyntaxKind.PropertyAccessExpression: case ts.SyntaxKind.ElementAccessExpression:
      return initialiserIsPure(node.expression);
    case ts.SyntaxKind.BinaryExpression:
      return initialiserIsPure(node.left) && initialiserIsPure(node.right);
    case ts.SyntaxKind.PrefixUnaryExpression: case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.AsExpression: case ts.SyntaxKind.NonNullExpression:
      return initialiserIsPure(node.expression ?? node.operand);
    case ts.SyntaxKind.ConditionalExpression:
      return initialiserIsPure(node.condition) && initialiserIsPure(node.whenTrue) && initialiserIsPure(node.whenFalse);
    case ts.SyntaxKind.CallExpression: {
      // A call at module scope is the interesting case. Object.freeze/keys/entries and Array/String
      // statics over pure arguments are value construction; anything else is reported for a human.
      const t = node.expression.getText();
      // esbuild's lazy CommonJS wrapper. `__commonJS({ 'x'() { … } })` stores the module body in a
      // memoised loader and returns it WITHOUT running it; the body executes on the first call, which
      // for these bundles is behind a dynamic import on the Node path only. Deliberately narrow: the
      // sibling helper `__toESM(require_x())` *does* invoke the body at module scope, and must keep
      // being reported — so this matches the wrapper alone and never a call to what it returns.
      if (t === '__commonJS' || t === '__esm') return true;
      const PURE = /^(Object\.(freeze|keys|values|entries|assign|create|fromEntries)|Array\.(from|isArray)|String|Number|Boolean|Symbol(\.for)?|JSON\.parse|Math\.\w+|\[[^\]]*\]\.(map|filter|flatMap|concat|join|slice))$/;
      return PURE.test(t) && (node.arguments ?? []).every((a) => initialiserIsPure(a));
    }
    default: return false;
  }
}

let bad = 0;
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) { console.log(`  ${file}: MISSING`); bad++; continue; }
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true);
  const effects = [];
  for (const st of sf.statements) {
    if (DECL.has(st.kind)) continue;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!initialiserIsPure(d.initializer)) {
          effects.push({ line: sf.getLineAndCharacterOfPosition(d.getStart()).line + 1, text: d.getText().slice(0, 110) });
        }
      }
      continue;
    }
    effects.push({ line: sf.getLineAndCharacterOfPosition(st.getStart()).line + 1, text: st.getText().slice(0, 110).replace(/\n/g, ' ') });
  }
  const kb = (src.length / 1024).toFixed(0);
  console.log(`\n  ${file}  (${kb} kB, ${sf.statements.length} top-level statements)`);
  if (effects.length === 0) console.log('    no import-time side effects');
  else { bad += effects.length; for (const e of effects) console.log(`    L${String(e.line).padEnd(6)} ${e.text}`); }
}
process.exit(bad > 0 ? 1 : 0);
