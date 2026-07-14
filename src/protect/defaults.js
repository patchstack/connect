// Default response- and egress-phase rule bundles, as JS constants (not JSON files) so
// tsup bundles them into dist/protect.js without a copy step. These are just rules —
// override per app via createProtection({ responseRules, egressRules }) or extend by
// adding phase-tagged rules to the delivered bundle. Patterns are high-precision
// (low false positive): structural markers a real secret has and normal content doesn't.

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
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/' } }]
  },
  {
    id: 'resp-aws-access-key',
    title: 'AWS access key id in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b/' } }]
  },
  {
    id: 'resp-gcp-api-key',
    title: 'Google API key in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\bAIza[0-9A-Za-z_-]{35}\\b/' } }]
  },
  {
    id: 'resp-jwt',
    title: 'JWT in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\beyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b/' } }]
  },
  {
    id: 'resp-db-connection-string',
    title: 'Database connection string with credentials in response body',
    phase: 'response',
    category: 'secret-exposure',
    action: 'redact',
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\b(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis|amqps?):\\/\\/[^\\s:@\\/]+:[^\\s:@\\/]+@/i' } }]
  },
  {
    id: 'resp-stack-trace',
    title: 'Node stack trace leaking in response body',
    phase: 'response',
    category: 'info-exposure',
    action: 'redact',
    rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/\\n\\s+at\\s+.+\\(.+:\\d+:\\d+\\)/' } }]
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
