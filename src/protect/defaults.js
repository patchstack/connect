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

// Response phase — secret / info exposure. Default action `redact` masks only the
// offending span and still serves the page (a legit response that leaks one key gets
// that key masked, not withheld). Use `action: "block"` to withhold the whole response.
export const DEFAULT_RESPONSE_RULES = [
  {
    id: 'resp-private-key',
    title: 'Private key in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    prefilter: ['PRIVATE KEY'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/' } }]
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
    id: 'resp-jwt',
    title: 'JWT in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    prefilter: ['eyJ'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\beyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b/' } }]
  },
  {
    id: 'resp-db-connection-string',
    title: 'Database connection string with credentials in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    prefilter: ['mongodb', 'postgres', 'mysql', 'redis', 'amqp'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\b(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis|amqps?):\\/\\/[^\\s:@\\/]+:[^\\s:@\\/]+@/i' } }]
  },
  {
    id: 'resp-stack-trace',
    title: 'Node stack trace leaking in response body',
    phase: 'response',
    category: 'info-exposure',
    action: 'redact',
    // No prefilter: a Node stack frame has no single distinctive literal (` at ` is too common to
    // gate on). The pattern is linearly bounded per line, so it runs on every screened body.
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\n\\s+at\\s+.+\\(.+:\\d+:\\d+\\)/' } }]
  },
  {
    id: 'resp-sql-error',
    title: 'SQL / ORM error disclosure in response body',
    phase: 'response',
    category: 'info-exposure',
    action: 'redact',
    prefilter: ['SQLSTATE', 'Sequelize', 'ER_', 'ORA-', 'PG::', 'SQLITE_ERROR', 'SQL syntax'],
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/(SQLSTATE\\[[0-9A-Z]+\\]|SequelizeDatabaseError|ER_[A-Z_]+|ORA-\\d{5}|PG::[A-Za-z]+Error|SQLITE_ERROR|You have an error in your SQL syntax)/i' } }]
  },
  {
    id: 'resp-exception-trace',
    title: 'Backend exception / stack trace disclosure in response body',
    phase: 'response',
    category: 'info-exposure',
    action: 'redact',
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
