import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createProtection } from '../../src/protect/runtime.js';
import { runDemoBundle } from '../../examples/protect/demo-runner.mjs';

// Guarantees the shipped demo/showcase rule set (examples/protect/demo-rules.json) stays honest:
// every rule must block/redact its own exploit AND allow its benign twin. A broken demo rule
// (missed exploit or false positive) fails CI here, not in front of an audience. The gallery
// (examples/protect/gallery.mjs) demonstrates the exact same bundle through the same runner.

const bundle = JSON.parse(
  readFileSync(new URL('../../examples/protect/demo-rules.json', import.meta.url), 'utf8'),
);

describe('demo rule set (examples/protect/demo-rules.json)', () => {
  const withDemo = bundle.firewall.filter((r: any) => r._demo);

  it('has demo vectors on every rule and covers all three phases', () => {
    expect(withDemo.length).toBe(bundle.firewall.length);
    const phases = new Set(withDemo.map((r: any) => r.phase ?? 'request'));
    expect(phases).toEqual(new Set(['request', 'response', 'egress']));
  });

  it('every rule blocks/redacts its exploit and allows its benign', async () => {
    const results = await runDemoBundle(bundle, createProtection as any);
    const failures = results.filter((r) => !r.pass);
    // Surface exactly which rule failed (and how) if this ever regresses.
    expect(failures.map((f) => ({ id: f.id, exploitCaught: f.exploitCaught, benignOk: f.benignOk }))).toEqual([]);
    expect(results.length).toBe(withDemo.length);
  });

  it('the scaffolded demo template (templates/demo-rules.json) matches this bundle, minus _demo', () => {
    // `protect --demo` ships src/protect/templates/demo-rules.json; keep it in lockstep with this
    // validated bundle so the scaffolded sample rules are exactly the ones proven above.
    const tmpl = JSON.parse(
      readFileSync(new URL('../../src/protect/templates/demo-rules.json', import.meta.url), 'utf8'),
    );
    const stripped = bundle.firewall.map(({ _demo, ...rule }: any) => rule);
    expect(tmpl.firewall).toEqual(stripped);
  });
});
