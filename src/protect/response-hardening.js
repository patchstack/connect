// Which response rules can be decided without the body.
//
// Header hardening does not read the body: `X-Frame-Options`, a stripped `Access-Control-Allow-*`, an
// `HttpOnly` flag on a cookie are all decided from the response's status and headers. So they apply to a
// response whose body could not be screened — over the cap, binary, a live stream, a failed read. The cap
// is there because buffering a hostile body costs memory, and a header does not become expensive because
// the body beside it is large.
//
// The test is whether a rule READS the body, not whether it happens to match. A body rule evaluated
// against an empty body is not undecided but wrongly decided: `not_contains` matches everything when
// there is nothing there.

import { readRuleParameters } from './rule-parameters.js';

/**
 * Response parameters that are available whether or not the body was read.
 *
 * A whitelist, so a source added to the contract later is body-dependent until somebody says otherwise.
 * The other direction — assuming a new source is safe — is how a rule gets applied on a reading nobody
 * had.
 */
const BODY_INDEPENDENT = Object.freeze(['response.status', 'response.headers']);
const BODY_INDEPENDENT_PREFIX = 'response.header.';

/** Actions that only rewrite headers, and therefore need no body to carry out. */
const HEADER_ACTIONS = Object.freeze(['set-header', 'remove-header', 'harden-cookie']);

/**
 * Can this rule be decided, and carried out, with the headers alone?
 *
 * Both halves matter. A rule that reads only the status but redacts a body span needs the body to act on;
 * a rule that hardens a cookie but keys off `response.body` needs it to decide. Only a rule that is
 * header-only in both respects belongs on the path where there is no body.
 */
export function hardensWithoutBody(rule) {
  if (!rule || !HEADER_ACTIONS.includes(rule.action)) return false;

  const { parameters, complete } = readRuleParameters(rule);

  // An incomplete walk is not an empty one. A rule nested past the contract's bound has conditions this
  // never saw, and a list missing a body condition is indistinguishable from a rule that reads no body,
  // so an incomplete answer makes the rule ineligible. Rules reach the runtime unvalidated, so the bound
  // is reachable here even though a served bundle could not carry one.
  if (!complete) return false;

  // A parameterless match — `cross_origin`, `off_origin`, `cors_reflected` — reads the request's origin
  // and the response's own headers, so it carries no parameter and needs no body.
  return parameters.every(
    (parameter) => BODY_INDEPENDENT.includes(parameter) || parameter.startsWith(BODY_INDEPENDENT_PREFIX),
  );
}
