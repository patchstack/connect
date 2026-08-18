import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { countComputedSpecifiers } from '../../src/map/imports.js';

// Detection of imports whose module name is computed at runtime.
//
// This exists to clear `coverage.importsComplete`, which is the one field licensing a NEGATIVE
// conclusion — "the package is not imported, so the vulnerability does not apply". A computed
// specifier is invisible to both import scanners, so without this the map reports a complete
// inventory for an app whose dependencies it could not enumerate.
//
// Both directions are load-bearing, in opposite ways. A miss (undercount) is silent and unsafe: the
// flag stays true and a real finding is closed. A false positive is loud and permanent: the flag can
// never become true for an app that merely mentions `require` in a comment, so every negative
// conclusion is blocked forever and the field becomes noise a consumer learns to ignore. That is why
// this tokenises instead of matching text.

const count = (src: string) => countComputedSpecifiers(src, ts as never);

describe('a computed specifier is detected', () => {
  it.each([
    ['a property lookup', 'const p = require(REGISTRY[kind]);'],
    ['a bare identifier', 'const p = require(name);'],
    ['a template with a substitution', 'const p = require(`./plugins/${name}`);'],
    ['a call result', 'const p = require(resolveName());'],
    ['string concatenation', 'const p = require("node-" + "serialize");'],
    ['a dynamic import expression', 'const m = await import(specifier);'],
  ])('%s', (_label, src) => {
    // `require("node-" + "serialize")` is genuinely computed, even though a human can read the value:
    // the scanner does not constant-fold, and treating it as knowable would mean claiming an import
    // this map never resolved.
    expect(count(src)).toBe(1);
  });
});

describe('a resolvable specifier is not', () => {
  it.each([
    ['a string literal require', 'const e = require("express");'],
    ['a literal dynamic import', 'const m = await import("./routes.js");'],
    ['a template with no substitution', 'const e = require(`express`);'],
    ['a static ESM import', 'import qs from "qs";\nimport { z } from "zod";'],
    ['a require in a line comment', '// call require(whatever) to load a plugin\nconst e = require("qs");'],
    ['a require in a block comment', '/* require(name) is the dynamic form */\nconst e = require("qs");'],
    ['a require inside a string', 'const doc = "use require(name) to load";'],
    ['an unrelated call', 'const x = compute(REGISTRY[kind]);'],
  ])('%s', (_label, src) => {
    // The comment and string cases are the reason this is tokenised. A regex over source text counts
    // prose, and a project with one such comment could never report a complete inventory again.
    expect(count(src)).toBe(0);
  });
});

// The three call forms, each tested in both polarities. One token of history cannot tell them apart:
// the deciding token is between the name and the paren in the optional form, and before the name in the
// member form. Both mistakes are real and they fail in opposite directions — a missed optional require
// leaves the inventory certified complete over an import nobody can resolve, while a counted app method
// makes completeness unreachable for that project forever.
describe('call forms are distinguished', () => {
  it.each([
    ['optional require, computed', 'const p = require?.(REGISTRY[kind]);', 1],
    ['optional require, literal', 'const e = require?.("express");', 0],
    ['optional import, computed', 'const m = await import?.(name);', 1],
    ['direct require, computed', 'const p = require(REGISTRY[kind]);', 1],
    ['direct require, literal', 'const e = require("express");', 0],
  ])('%s', (_label, src, want) => {
    expect(count(src)).toBe(want);
  });

  it.each([
    ['a method named require', 'const p = loader.require(name);'],
    ['an optional method named require', 'const p = loader?.require(name);'],
    ['an optional call on a method named require', 'const p = loader.require?.(name);'],
    ['a nested method named require', 'const p = app.loaders.require(name);'],
    ['a method named import', 'const p = registry.import(name);'],
  ])('%s is not module loading', (_label, src) => {
    // An app method that happens to share the name says nothing about which module is loaded. Counting
    // it would hold `importsComplete` false on evidence of nothing, and a flag that is always false
    // stops being read — costing the true positives it exists to carry.
    expect(count(src)).toBe(0);
  });

  it('counts a real computed require in a file that also has a require-named method', () => {
    const src = `
      const a = loader.require(name);
      const b = require?.(REGISTRY[kind]);
    `;

    // Both rules at once, which is the case a single-token implementation cannot get right in either
    // direction: exactly one of these two lines is an unresolvable module specifier.
    expect(count(src)).toBe(1);
  });
});

// An aliased loader is a gap, not a clean file.
//
// Once `require` is behind another name, following it needs dataflow this scan does not do. The choice
// here is deliberate and conservative: report the gap at the point the loader ESCAPES, rather than try
// to track the alias. It costs a false "incomplete" on code that aliases `require` and only ever calls
// it with literals — accepted, because the alternative is certifying an inventory as complete when a
// single line of indirection could be loading anything.
describe('an aliased loader is reported as a gap', () => {
  it.each([
    ['assigned to a variable', 'const r = require;\nr(REGISTRY[kind]);'],
    ['parenthesised callee', '(require)(REGISTRY[kind]);'],
    ['assigned then called with a literal', 'const r = require;\nr("express");'],
    ['re-exported', 'module.exports = require;'],
    ['passed to a function', 'register(require, exports);'],
    ['stored on an object', 'const box = { load: require };'],
  ])('%s', (_label, src) => {
    // Reported once, at the escape. The later `r(…)` is not counted again: it is the same single piece
    // of missing knowledge, and the count is a diagnostic a human reads, not a tally of call sites.
    expect(count(src)).toBe(1);
  });

  it('does not fire on loader properties that load nothing', () => {
    // `require.resolve` returns a path and `require.cache` is a map — neither pulls in a module, so
    // neither leaves the inventory unable to answer.
    expect(count('const p = require.resolve("express");\ndelete require.cache[p];')).toBe(0);
  });

  it('does not fire on a static ESM import or import.meta', () => {
    // The reason this rule is asked about `require` only: `import` appears without a following paren in
    // ordinary ESM, so applying it there would report a gap for every normal file and make the flag
    // useless in the other direction.
    expect(count('import qs from "qs";\nconst here = import.meta.url;')).toBe(0);
  });
});

describe('counting', () => {
  it('reports each computed specifier, not just whether one exists', () => {
    const src = `
      const a = require("qs");
      const b = require(FIRST[k]);
      const c = require(second);
      const d = await import("./ok.js");
    `;

    // The count reaches the reader as a diagnostic, so it has to be the real number: "2 imports could
    // not be resolved" is actionable in a way "some import could not be resolved" is not.
    expect(count(src)).toBe(2);
  });

  it('survives source it cannot tokenise cleanly', () => {
    // Fail-open, like every other path in the extractor: unbalanced source must not throw out of the
    // scan. Whatever was counted before the scanner gave up still counts, since a partial count clears
    // the completeness flag just as a full one does.
    expect(() => count('const a = require(X[k]); function ( { unterminated `')).not.toThrow();
  });
});
