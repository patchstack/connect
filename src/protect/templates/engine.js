// @patchstack/protect — the runtime protection engine.
//
// One pure function: evaluate(ctx, rules, manifest) -> Verdict.
// No framework coupling — the framework adapter (the guard) builds `ctx` and acts on the
// Verdict. This is the offsite-frozen contract between Group 1 (engine) and Group 2 (surface).
//
// SCOPE OF THIS BUILD: implements the two demo-critical pieces from the prototype —
//   - `inline_xss`   (ps-node never implemented it; npm XSS attacks need it)
//   - `package_cond` (the line between virtual patching and a dumb wall)
// plus `equals` / `contains` and the `urldecode` mutation. The full rule_v2 zoo
// (AND/OR, nested rules, whitelists, the ~15 other match types) lands when the
// ps-node RuleEngine is ported in — this file keeps the same signature so that swap
// is drop-in.

/** @type {{ALLOW:'ALLOW',LOG:'LOG',BLOCK:'BLOCK',REDIRECT:'REDIRECT'}} */
export const ACTIONS = { ALLOW: "ALLOW", LOG: "LOG", BLOCK: "BLOCK", REDIRECT: "REDIRECT" };

/** Iteratively URL-decode (catches %2527 -> %27 -> '). Safe on malformed input. */
export function urldecode(value) {
  let out = String(value);
  for (let i = 0; i < 5; i++) {
    let next;
    try {
      next = decodeURIComponent(out.replace(/\+/g, " "));
    } catch {
      break;
    }
    if (next === out) break;
    out = next;
  }
  return out;
}

const MUTATIONS = { urldecode };

function applyMutations(value, mutations) {
  let v = String(value ?? "");
  for (const m of mutations ?? []) {
    if (MUTATIONS[m]) v = MUTATIONS[m](v);
  }
  return v;
}

// Heuristic script-injection detector. Deliberately simple and readable for the demo;
// the ported engine replaces this with the audited ps-node inline_xss implementation.
const XSS_PATTERNS = [
  /<\s*script\b/i,
  /<\s*\/\s*script\s*>/i,
  /\bon\w+\s*=/i, // onerror=, onload=, ...
  /javascript\s*:/i,
  /<\s*img\b[^>]*\bon\w+\s*=/i,
  /<\s*svg\b[^>]*\bon\w+\s*=/i,
  /\bdata\s*:\s*text\/html/i,
];

function looksLikeInlineXss(value) {
  const v = String(value ?? "");
  return XSS_PATTERNS.some((re) => re.test(v));
}

// Resolve a rule parameter like "insert.title" or "body.content" against ctx.
// The guard normalizes framework specifics into ctx.body; parameters read from there.
function resolveParameter(ctx, parameter) {
  const [, ...rest] = String(parameter).split(".");
  const key = rest.length ? rest.join(".") : parameter;
  const body = ctx?.body ?? {};
  if (key in body) return body[key];
  // shallow scan for nested payloads (e.g. { record: { title } })
  for (const v of Object.values(body)) {
    if (v && typeof v === "object" && key in v) return v[key];
  }
  return undefined;
}

function matchCondition(ctx, cond) {
  const params = Array.isArray(cond.parameter) ? cond.parameter : [cond.parameter];
  for (const param of params) {
    const raw = resolveParameter(ctx, param);
    if (raw == null) continue;
    const value = applyMutations(raw, cond.mutations);
    const type = cond.match?.type;
    let hit = false;
    if (type === "inline_xss") hit = looksLikeInlineXss(value);
    else if (type === "contains") hit = value.includes(cond.match.value);
    else if (type === "equals") hit = value === cond.match.value;
    if (hit) {
      return { param, type, value };
    }
  }
  return null;
}

// package_cond: only fire if the app actually has the vulnerable package@version.
// If no manifest is supplied, fail-open on the gate (assume present) — detection already
// flagged it; the guard can tighten this once it passes the real manifest.
function packageCondSatisfied(pkgCond, manifest) {
  if (!pkgCond) return true;
  if (!manifest || !manifest.packages) return true;
  const installed = manifest.packages[pkgCond.package];
  if (installed == null) return false;
  if (!pkgCond.vulnerable_versions) return true;
  return pkgCond.vulnerable_versions.includes(installed);
}

/**
 * Evaluate one request against the rule set.
 * @param {import('./index.js').RequestContext} ctx
 * @param {import('./index.js').Rule[]} rules
 * @param {import('./index.js').Manifest} [manifest]
 * @returns {import('./index.js').Verdict}
 */
export function evaluate(ctx, rules, manifest) {
  const trace = [];
  for (const rule of rules ?? []) {
    if (!packageCondSatisfied(rule.package_cond, manifest)) {
      trace.push({ rule_id: rule.id, skipped: "package_cond not satisfied" });
      continue;
    }
    for (const cond of rule.rule_v2 ?? []) {
      const m = matchCondition(ctx, cond);
      if (m) {
        return {
          matched: true,
          action: ACTIONS.BLOCK,
          rule_id: rule.id,
          vulnerability_id: rule.vulnerability_id ?? null,
          package: rule.package_cond?.package ?? null,
          version: manifest?.packages?.[rule.package_cond?.package] ?? null,
          explain: [`${m.param} matched ${m.type}${cond.mutations?.length ? ` after ${cond.mutations.join("+")}` : ""}`],
          trace,
        };
      }
    }
    trace.push({ rule_id: rule.id, matched: false });
  }
  return { matched: false, action: ACTIONS.ALLOW, rule_id: null, vulnerability_id: null, package: null, version: null, explain: [], trace };
}
