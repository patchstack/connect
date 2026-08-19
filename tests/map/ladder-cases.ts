// Apps whose reachability evidence should land on a known rung.
//
// The corpus in `corpus-cases.ts` measures whether a flow compiles to a rule. These cases measure
// something the map has never been tested on end to end: what the map SAYS about a dependency, which
// is what a consumer grades into a verdict. The two are different questions — a package can be
// plainly reachable and still produce no rule, and an app can produce no evidence at all.
//
// One case per rung, because each rung has a distinct way of being wrong:
//
//   reachable            untrusted input reaches the sink — must not read as a bare import
//   api-called           the API is invoked with no untrusted input — must not be promoted
//   imported             imported and never called — must not be demoted to "not imported"
//   not-a-code-question  the package IS the deployed app — no consumer artifact gates it
//   unknown              the call is invisible to static analysis — the map must DECLINE
//
// `unknown` is the load-bearing one. Every other rung is a positive claim, and a wrong positive shows
// up as a bad rule someone notices. A wrong `unknown` is a confident negative: the map reports "not
// imported" for code it simply cannot see, a real finding disappears, and nothing anywhere raises.

export interface LadderCase {
  /**
   * Stable identity, referenced from the assertions and from the platform-side ladder tests. Renaming
   * one breaks that reference loudly, which is the point.
   */
  id: string;
  /** The rung this app's evidence should support. */
  rung: 'reachable' | 'api-called' | 'imported' | 'not-a-code-question' | 'unknown';
  /** The fixture advisory this app pairs with, by CVE. */
  cve: string;
  /** The dependency under test. */
  pkg: string;
  name: string;
  packageJson: Record<string, unknown>;
  files: Record<string, string>;
  /**
   * What the map must show for this case to mean what it claims.
   *
   * `imports` and `invocations` are positive controls first and assertions second: an app that lands
   * on `imported` because the map failed to parse it at all would otherwise pass for the wrong reason.
   */
  expect: {
    /** Package names that must appear in the import inventory. */
    imports: string[];
    /** `package.symbol` entries that must appear in the invocation inventory. */
    invocations: string[];
    /** `package.symbol` entries that must NOT appear — the promotions each rung must resist. */
    absentInvocations?: string[];
    /** A flow from request input to a sink must exist (true) or must not (false). */
    provenFlow: boolean;
    /**
     * Whether that flow is at the tier a consumer may ACT on — `exact-local` and rule-generatable.
     *
     * Separate from `provenFlow` because the two came apart in practice, and the gap was invisible from
     * here: a proven `transformed-local` flow is real evidence that a consumer's own top verdict
     * deliberately refuses, since the transformation may be sanitising. Asserting only "a flow exists"
     * let a rung claim the top of the ladder while grading one step below it everywhere downstream.
     */
    actionableFlow?: boolean;
    /** Substrings that must appear in `coverage.apiInventoryLimitations`. */
    limitations?: RegExp[];
  };
}

export const LADDER_CASES: LadderCase[] = [
  {
    // TRANSFORMED, and kept for exactly that: the input is concatenated into the SQL, which is proven but
    // review-grade — the tier a rule generator refuses to pin because the transformation may be
    // sanitising. It is the only case pinning the boundary between "the map proved a flow" and "a consumer
    // will act on it", which is where a false confirmation would come from. See `ladder/reachable-exact`
    // for the actionable half; neither replaces the other.
    id: 'ladder/reachable-transformed',
    rung: 'reachable',
    cve: 'CVE-2019-10752',
    pkg: 'sequelize',
    name: 'request input is concatenated into a sequelize query',
    packageJson: { dependencies: { express: '4', sequelize: '4.44.0' } },
    files: {
      'src/server.js': `
        const express = require("express");
        const { Sequelize } = require("sequelize");
        const db = new Sequelize("postgres://localhost/app");
        const app = express();

        app.get("/search", async (req, res) => {
          // A modelled sink (db) reached by request input. Deliberately a SQL-injection advisory
          // rather than a prototype-pollution one: the map models db/fs/http/exec/eval sinks, so a
          // deep-merge flow cannot compile and would make this case assert a capability that does
          // not exist.
          const rows = await db.query("SELECT * FROM items WHERE name = '" + req.query.name + "'");
          res.json(rows);
        });

        module.exports = app;
      `,
    },
    expect: {
      imports: ['sequelize'],
      invocations: ['sequelize.query'],
      provenFlow: true,
      // Proven, and NOT actionable. Asserted rather than left implicit, because "a flow exists" reads as
      // the top of the ladder while a consumer keying on the actionable tier grades this one step lower.
      actionableFlow: false,
    },
  },

  {
    // The actionable half of the `reachable` rung: request input reaches the sink UNTRANSFORMED, which is
    // the tier a rule generator will pin and therefore the only shape that exercises a consumer's top
    // verdict end to end. Without it every ladder case graded at most one step below the top, and nothing
    // said so — the harness looked complete because a rung named `reachable` existed.
    id: 'ladder/reachable-exact',
    rung: 'reachable',
    cve: 'CVE-2020-28168',
    pkg: 'axios',
    name: 'request input reaches an axios request as the URL, untransformed',
    packageJson: { dependencies: { express: '4', axios: '0.21.0' } },
    files: {
      'src/server.js': `
        const express = require("express");
        const axios = require("axios");
        const app = express();

        app.post("/preview", async (req, res) => {
          // The whole request URL IS the input: no concatenation, no validation, nothing between the
          // parameter and the outbound call. That is what makes the flow pinnable — a rule can screen
          // \`post.target\` and know it is screening the value that reaches the sink.
          const response = await axios.get(req.body.target);
          res.json({ status: response.status });
        });

        module.exports = app;
      `,
    },
    expect: {
      imports: ['axios'],
      invocations: ['axios.get'],
      provenFlow: true,
      actionableFlow: true,
    },
  },

  {
    id: 'ladder/api-called',
    rung: 'api-called',
    cve: 'CVE-2022-46175',
    pkg: 'json5',
    name: 'json5 parse is called, but never on request input',
    packageJson: { dependencies: { express: '4', json5: '2.2.1' } },
    files: {
      'src/config.js': `
        const JSON5 = require("json5");
        const { readFileSync } = require("node:fs");

        // Called on a file this app ships. The API is invoked — that is real evidence — but no
        // untrusted input reaches it, so grading this as \`reachable\` would overclaim.
        function loadConfig() {
          return JSON5.parse(readFileSync("./config.json5", "utf8"));
        }

        module.exports = { loadConfig };
      `,
      'src/server.js': `
        const express = require("express");
        const { loadConfig } = require("./config");
        const app = express();

        app.get("/config", (req, res) => {
          // The request never reaches parse: the response is derived from the shipped file.
          res.json({ theme: loadConfig().theme });
        });

        module.exports = app;
      `,
    },
    expect: {
      imports: ['json5'],
      invocations: ['json5.parse'],
      // `loadConfig` is this app's own function. json5 has no such export, so recording it would hand a
      // consumer a name that is in no advisory while `parse` — the name that IS — went unreported.
      absentInvocations: ['json5.loadConfig'],
      // No flow from request input to the parse call. If one appears, the case has stopped testing
      // `api-called` and silently become a second `reachable` case.
      provenFlow: false,
    },
  },

  {
    id: 'ladder/imported',
    rung: 'imported',
    cve: 'CVE-2022-24999',
    pkg: 'qs',
    name: 'qs is imported and never called in traced code',
    packageJson: { dependencies: { express: '4', qs: '6.10.1' } },
    files: {
      'src/server.js': `
        const express = require("express");
        // Imported and unused here — the framework parses query strings internally, which is how a
        // consumer normally has this dependency without ever calling it.
        const qs = require("qs");
        const app = express();

        app.get("/items", (req, res) => {
          res.json({ status: req.query.status ?? "open" });
        });

        module.exports = { app, qs };
      `,
    },
    expect: {
      imports: ['qs'],
      invocations: [],
      // The demotion this rung must resist: an import with no call is still an import. Reporting
      // nothing here would read as "not installed", which is a different and false claim.
      absentInvocations: ['qs.parse'],
      provenFlow: false,
    },
  },

  {
    id: 'ladder/not-a-code-question',
    rung: 'not-a-code-question',
    cve: 'CVE-2021-39138',
    pkg: 'parse-server',
    name: 'parse-server is the deployed app, not a library this code calls',
    packageJson: { dependencies: { 'parse-server': '4.5.0', express: '4' } },
    files: {
      'index.js': `
        const express = require("express");
        const { ParseServer } = require("parse-server");

        // The flaw is inside the deployed service's own session handling. Nothing in this file gates
        // it: the app is configuration around a package that IS the application. Source analysis has
        // no artifact to look at, which is a property of the advisory, not a gap in the scan.
        const app = express();
        app.use("/parse", new ParseServer({
          databaseURI: process.env.DATABASE_URI,
          appId: process.env.APP_ID,
          masterKey: process.env.MASTER_KEY,
        }));

        app.listen(1337);
      `,
    },
    expect: {
      imports: ['parse-server'],
      // Constructing the server is the only call there is. It is evidence the package is deployed,
      // not evidence a vulnerable API was invoked — the distinction the rung exists to make.
      invocations: ['parse-server.ParseServer'],
      provenFlow: false,
    },
  },

  {
    id: 'ladder/unknown',
    rung: 'unknown',
    cve: 'CVE-2017-5941',
    pkg: 'node-serialize',
    name: 'node-serialize is reached through a computed require the map cannot see',
    packageJson: { dependencies: { express: '4', 'node-serialize': '0.0.4' } },
    files: {
      'src/plugins.js': `
        // The specifier is computed at runtime. No static analysis can resolve which package this is,
        // so the map must report that it could not tell — not that the package is unused.
        const REGISTRY = { serializer: "node-" + "serialize" };

        function loadPlugin(kind) {
          return require(REGISTRY[kind]);
        }

        module.exports = { loadPlugin };
      `,
      'src/server.js': `
        const express = require("express");
        const { loadPlugin } = require("./plugins");
        const app = express();

        app.post("/restore", (req, res) => {
          // Untrusted input reaches a deserializer, and the map still cannot say which one. Both
          // halves matter: there IS a real risk here, and the evidence for it is invisible.
          const plugin = loadPlugin("serializer");
          res.json(plugin.unserialize(req.body.state));
        });

        module.exports = app;
      `,
    },
    expect: {
      // Nothing to find: the require is computed, so no import is attributable.
      imports: [],
      invocations: [],
      // And critically, the invisible call must not be attributed to the package by name match.
      absentInvocations: ['node-serialize.unserialize'],
      provenFlow: false,
      // The map has to SAY it cannot see this shape. Absent this, a consumer reading an empty
      // inventory has no way to tell "nothing is called" from "nothing is visible".
      limitations: [/dynamic import/, /computed callee/],
    },
  },
];
