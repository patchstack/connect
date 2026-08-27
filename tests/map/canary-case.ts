/**
 * The one app the cross-repo canary runs on.
 *
 * The canary is a single vertical slice through the whole product claim: a reviewed advisory recipe, a
 * verdict and a generated rule from Patchstack SaaS, and the engine in this package blocking the
 * exploit — proved as one chain rather than three sets of green unit tests. CVE-2017-5941 is the slice,
 * because
 * `node-serialize`'s `unserialize` executes an embedded `$$ND_FUNC$$` function expression, so a request
 * body reaching it is remote code execution, and because it is public: the app, the rule and the requests
 * can all live in the open, while the review rationale and the detector recipe stay private.
 *
 * Deliberately the SIMPLEST app that carries the vulnerability. Nothing here is decoration — a wrapper, a
 * validation step or a rename would move the flow off `exact-local` and the canary would then be proving
 * that a review-grade flow generates a rule, which is a different and weaker claim.
 *
 * Exported as data because two things consume it and they must not drift: this package's own suite, which
 * asserts what the map SAYS about the app, and the emitter, which writes that map where the platform
 * vendors it. Generated from one definition, so a change to the app cannot update one and not the other.
 */
export const CANARY_CASE = {
  /** Stable identity, referenced from the emitted artifact and from the platform's fixtures. */
  id: 'canary/node-serialize',
  cve: 'CVE-2017-5941',
  pkg: 'node-serialize',
  /** The exact version the advisory covers, so the platform's manifest fixture and this agree. */
  pkgVersion: '0.0.4',
  name: 'a request body reaches node-serialize.unserialize with nothing in between',
  packageJson: {
    name: 'canary-node-serialize',
    private: true,
    dependencies: { express: '4.18.2', 'node-serialize': '0.0.4' },
  },
  files: {
    'src/server.js': `
      const express = require("express");
      const serialize = require("node-serialize");
      const app = express();

      app.post("/api/restore", (req, res) => {
        // CVE-2017-5941: unserialize() evaluates an embedded function expression, so the request body
        // reaching it is remote code execution. Passed straight through — no wrapper, no validation, no
        // rename — which is what keeps the flow on the one tier that may be promoted automatically.
        const state = serialize.unserialize(req.body.state);
        res.json({ restored: state });
      });

      module.exports = app;
    `,
  },
  /**
   * What the chain downstream depends on. Asserted in this package (so a change here fails HERE, with a
   * message about the map) and restated by the platform against the emitted document — the same
   * two-ends-must-agree split the ladder fixtures use.
   */
  expect: {
    route: '/api/restore',
    method: 'POST',
    runtimeParameter: 'post.state',
    inputId: 'post:state',
    sinkKind: 'eval',
    sinkOp: 'unserialize',
    argumentRole: 'code',
    candidateFamily: 'code-injection',
    confidence: 'exact-local',
    ruleGeneratable: true,
  },
} as const;
