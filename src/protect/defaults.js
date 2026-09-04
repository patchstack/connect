// Default response- and egress-phase rule bundles, as JS constants (not JSON files) so
// tsup bundles them into dist/protect.js without a copy step. These are just rules —
// override per app via createProtection({ responseRules, egressRules }) or extend by
// adding phase-tagged rules to the delivered bundle. Patterns are high-precision
// (low false positive): structural markers a real secret has and normal content doesn't.
//
// Each rule carries a `prefilter`: cheap literal anchor(s) that MUST appear in the body for the
// regex to have any chance of matching. The response screener runs the (expensive) regex only when
// an anchor is present (case-insensitive), so a body with no candidate — the common case — skips
// the scan entirely. This cuts CPU/latency and shrinks the regex/ReDoS surface. (Honored by the
// response phase once the prefilter mechanism lands; a no-op before that.)

// Response phase — secret / info exposure.
//
// `redact` masks the span a pattern matched and serves the rest of the page. It is used only where the
// match is the whole of the disclosure, which holds for a credential with a grammar: a provider token
// has a prefix, an alphabet and a length, so matching it matches all of it.
//
// `block` withholds the response and replaces it with a generic error. It is used where a pattern can
// identify a disclosure but not delimit it — a private key, a stack trace, a database error, an
// exception dump, a connection URI in free text. The material that matters sits after the part the
// pattern can recognise, so a mask would leave file names, line numbers, query text, frames, key
// material or a host and database name in a response that reports itself protected.
export const DEFAULT_RESPONSE_RULES = [
  {
    id: 'resp-private-key',
    title: 'Private key in response body',
    phase: 'response',
    category: 'secret-exposure',
    // Withheld: the key material sits after the marker and this pattern does not delimit it.
    action: 'block',
    prefilter: ['PRIVATE KEY'],
    // Matches a PEM BEGIN line whose label contains `PRIVATE KEY`, with up to 32 further label
    // characters — uppercase letters, digits, spaces and hyphens — on either side of it. That covers
    // the enumerated types (`RSA`, `EC`, `OPENSSH`, `DSA`, `ENCRYPTED`), a label carrying words after
    // `PRIVATE KEY` (`PGP PRIVATE KEY BLOCK`), a hyphenated or otherwise unlisted type, and a bare
    // `-----BEGIN PRIVATE KEY-----`. `PUBLIC KEY` and `CERTIFICATE` do not match, and neither does
    // prose that mentions a private key without a BEGIN line.
    //
    // No footer required: a truncated response or an absent END marker does not make the material
    // above it less of a key. Two bounded character classes rather than a repeated group — a
    // quantifier inside a quantified group is the shape the engine refuses as a backtracking risk, and
    // a refused pattern is a rule that never fires.
    //
    // A lowercase label, or one longer than 32 characters on either side, is not matched.
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/-----BEGIN [A-Z0-9 -]{0,32}PRIVATE KEY[A-Z0-9 -]{0,32}-----/' } }]
  },
  {
    id: 'resp-aws-access-key',
    title: 'AWS access key id in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    prefilter: ['AKIA', 'ASIA'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b/' } }]
  },
  {
    id: 'resp-gcp-api-key',
    title: 'Google API key in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    prefilter: ['AIza'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\bAIza[0-9A-Za-z_-]{35}\\b/' } }]
  },
  {
    id: 'resp-vendor-api-key',
    title: 'Vendor API key / token in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    // High-signal, prefix-anchored provider tokens that never legitimately appear in a response
    // body: Stripe (sk_live_/rk_live_), GitHub (gh[opsu]_ / github_pat_), GitLab (glpat-),
    // Slack (xox[baprs]-), Anthropic (sk-ant-), Google OAuth (ya29.), npm (npm_). Trailing
    // (?![0-9A-Za-z]) instead of \\b since some tokens end in - / _ .
    prefilter: ['sk_live_', 'rk_live_', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'github_pat_', 'glpat-', 'xox', 'sk-ant-', 'ya29.', 'npm_'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\b(?:sk_live_[0-9A-Za-z]{16,}|rk_live_[0-9A-Za-z]{16,}|gh[opsu]_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{60,}|glpat-[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|sk-ant-[0-9A-Za-z_-]{20,}|ya29\\.[0-9A-Za-z_-]{20,}|npm_[0-9A-Za-z]{36})(?![0-9A-Za-z])/' } }]
  },
  {
    id: 'resp-supabase-secret-key',
    title: 'Supabase secret key in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    // Supabase's opaque key format, which is not a JWT and so is not covered by the JWT rule below.
    // `sb_secret_` is the elevated one — documented as full access, bypassing Row Level Security,
    // backend-only — while `sb_publishable_` is meant for public clients and must pass untouched.
    // Both key systems are live at once: new keys sit alongside the legacy `anon` / `service_role`
    // JWTs rather than replacing them, so this rule and the JWT rule cover different halves.
    //
    // The documented grammar is the prefix, 22 base64url characters, `_`, then an 8-character
    // base64url checksum. Matching it exactly is what keeps the mask on the key and off the response
    // around it: a variable-length suffix would either run past the key into adjacent syntax or stop
    // short and leave the tail of a real key visible. The trailing guard rejects a longer run of key
    // characters, which is not this format.
    prefilter: ['sb_secret_'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\bsb_secret_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}(?![A-Za-z0-9_-])/' } }]
  },
  {
    id: 'resp-supabase-service-role-key',
    title: 'Supabase service_role key in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    // Scoped to the one role that must never leave: `service_role` bypasses Row Level Security
    // entirely. A JWT in a response body is not inherently a leak — the Supabase `anon` key is public
    // by design and a login response carries the user's own access token — so this decides on the
    // decoded payload rather than on the shape of the token.
    //
    // `jwt_claim_equals` also yields the matching token spans, which is what lets `redact` mask those
    // tokens and serve the rest of the response.
    //
    // A broad any-JWT rule is a reasonable thing to want; it belongs in the managed hardening bundle as
    // an opt-in, observe-only rule rather than an on-by-default mask.
    prefilter: ['eyJ'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'jwt_claim_equals', claim: 'role', value: 'service_role' } }]
  },
  {
    id: 'resp-db-connection-string',
    title: 'Database connection string with credentials in response body',
    phase: 'response',
    category: 'secret-exposure',
    // Withheld. The credentials are only the first half of the disclosure — the host, port, database
    // name and query name the system they open — and a URI's own grammar admits commas, parentheses
    // and semicolons, so no end-of-URI character class delimits it in free text without either
    // stopping inside a real URI or consuming the punctuation around it. The pattern therefore
    // identifies the URI and the response is withheld rather than partly rewritten.
    action: 'block',
    prefilter: ['mongodb', 'postgres', 'mysql', 'redis', 'amqp'],
    // A scheme this application connects with, a user, a password and an `@`. Credentials are
    // required, so a URL without them is not matched.
    //
    // The username is the userinfo grammar without `:`; the password is the same grammar with it. Every
    // other character either class admits may appear raw in a real credential, so a narrower one turns
    // a live credential into a rule that says nothing — `postgres://user:p;ss@host` is an ordinary DSN.
    //
    // The first raw colon separates username from password. Excluding it from the username makes the
    // separator unambiguous and keeps matching linear; the password continues to admit raw colons. A
    // username that contains a colon carries it as `%3A`.
    //
    // Both classes admitting `:` would leave every colon available as the separator, so a candidate
    // run with no `@` is re-split at every position. The screening cap does not bound that: a rule may
    // raise it with `max_bytes` or remove it with `bypass_limit`.
    //
    // What terminates a candidate is everything the grammar excludes: whitespace, `/`, `?`, `#`, `@`,
    // quotes, backslashes, angle and square brackets and braces. That is what keeps the run inside one
    // value. Expressed as "anything but `:`, `@`, `/` and whitespace" it crosses structure instead: in
    // `{"docs":"postgres://db.internal","contact":"user@example.com"}` it consumes the closing quote,
    // the comma and the next key, reaching the `:` and `@` of an unrelated property and withholding a
    // response that discloses nothing.
    //
    // The consequence is deliberate: a run of punctuation-joined text that parses as a credential URI
    // is treated as one. `postgres://db.internal;contact:admin@example.com` has username
    // `db.internal;contact`, password `admin` and host `example.com` — indistinguishable from a leak,
    // so it is withheld. Ordinary prose separates with whitespace, which terminates the candidate.

    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\b(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis|amqps?):\\/\\/[A-Za-z0-9._~%!$&\'()*+,;=-]+:[A-Za-z0-9._~%!$&\'()*+,;=:-]+@/i' } }]
  },
  {
    id: 'resp-stack-trace',
    title: 'Node stack trace leaking in response body',
    phase: 'response',
    category: 'info-exposure',
    // Withheld. A frame is recognised by its shape and the trace has no end the pattern can rely on,
    // so masking the frames it happens to match leaves the message, the remaining frames and every
    // path and line number in them.
    action: 'block',
    // No prefilter: a Node stack frame has no single distinctive literal (` at ` is too common to
    // gate on). The pattern is linearly bounded per line, so it runs on every screened body.
    //
    // Accepts a real newline and a JSON-escaped one. Most traces reach a client inside a JSON error
    // body, where the newline is the two characters `\` and `n`.
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/(?:\\n|\\\\n)\\s*at\\s+.+\\(.+:\\d+:\\d+\\)/' } }]
  },
  {
    id: 'resp-sql-error',
    title: 'SQL / ORM error disclosure in response body',
    phase: 'response',
    category: 'info-exposure',
    // Withheld. The signature is the start of the disclosure: masking `SQLSTATE[23000]` and serving
    // the constraint name, the column and the offending value discloses the schema anyway.
    action: 'block',
    prefilter: ['SQLSTATE', 'Sequelize', 'ER_', 'ORA-', 'PG::', 'SQLITE_ERROR', 'SQL syntax'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/(SQLSTATE\\[[0-9A-Z]+\\]|SequelizeDatabaseError|ER_[A-Z_]+|ORA-\\d{5}|PG::[A-Za-z]+Error|SQLITE_ERROR|You have an error in your SQL syntax)/i' } }]
  },
  {
    id: 'resp-exception-trace',
    title: 'Backend exception / stack trace disclosure in response body',
    phase: 'response',
    category: 'info-exposure',
    // Withheld, for the same reason as the trace above: the marker opens the dump and the file names,
    // line numbers and frames after it are the disclosure.
    action: 'block',
    // Multi-language exception/traceback signatures a normal API response never carries:
    // Python traceback, Java "Exception in thread", .NET System.*Exception, JVM stack frames,
    // Go goroutine dumps. (Node `at fn (file:line:col)` frames are handled by resp-stack-trace.)
    prefilter: ['Traceback', 'Exception in thread', 'System.', 'goroutine ', '.java:', '.kt:', '.scala:', '.rb:', '.py:', '.cs:'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/(Traceback \\(most recent call last\\)|Exception in thread "|System\\.[A-Za-z.]+Exception|\\bat [\\w.$]+\\([\\w]+\\.(?:java|kt|scala|rb|py|cs):\\d+\\)|goroutine \\d+ \\[)/' } }]
  }
];

// Egress phase — SSRF: block the app's outbound calls to internal / metadata addresses.
export const DEFAULT_EGRESS_RULES = [
  {
    id: 'egress-internal-address',
    title: 'Outbound request to an internal / metadata address (SSRF)',
    phase: 'egress',
    category: 'ssrf',
    rule_v2: [{ parameter: 'egress.host', match: { type: 'internal_host' } }]
  }
];
