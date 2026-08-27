import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { composeAgentPrompt, stripPersonaMeta, META_OPEN } from '../field-test/persona.mjs';

/**
 * The agent under test must never be told it is under test.
 *
 * Each persona carries provenance for maintainers — that the policy is a synthetic reconstruction, why it
 * is weaker than a real platform policy, what the harness is trying to prove. The runner used to read the
 * file and send it to the agent whole, HTML comment included, which announced the evaluation and handed
 * the agent a reason to discount the policy it was supposed to be applying. A green run then no longer
 * distinguishes a prompt that survives platform pressure from one an agent waved through because it knew
 * it was being measured.
 *
 * An HTML comment is not a hiding place. A model reads it like any other text.
 *
 * `field-test/` is dev-only and never ships, but this guard belongs in the suite that always runs: the
 * harness is what gates changes to the install prompt, so a harness that has quietly stopped
 * discriminating is worse than no harness — it reports the same green either way.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const personaDir = path.join(here, '..', 'field-test', 'personas');
const personas = readdirSync(personaDir).filter((f) => f.endsWith('.md'));

/** The meta blocks, located independently of the code under test — otherwise this asserts self-agreement. */
function metaBlocks(text: string): string[] {
  return [...text.matchAll(/<!-- field-test:meta[\s\S]*?-->/g)].map((m) => m[0]);
}

describe('persona provenance never reaches the agent', () => {
  it('finds the personas, so an empty directory cannot pass', () => {
    expect(personas.length).toBeGreaterThanOrEqual(7);
  });

  it.each(personas)('%s composes without any provenance text', (file) => {
    const persona = readFileSync(path.join(personaDir, file), 'utf8');
    const composed = composeAgentPrompt({
      persona,
      fixtureDir: '/tmp/fixture',
      installPrompt: 'INSTALL PROMPT BODY',
    });

    expect(composed).not.toContain(META_OPEN);

    // Every non-trivial line from inside a block must be gone. Line-level rather than block-level, because
    // a partial strip — the marker removed and the prose left — is the failure that would still look right.
    for (const block of metaBlocks(persona)) {
      for (const line of block.split('\n').map((l) => l.trim()).filter((l) => l.length > 12)) {
        expect(composed, `provenance line leaked from ${file}: ${line}`).not.toContain(line);
      }
    }
  });

  it.each(personas)('%s still carries its policy and both substitutions', (file) => {
    // The other direction: stripping must not eat the persona. A composer that returned nothing would pass
    // every assertion above.
    const persona = readFileSync(path.join(personaDir, file), 'utf8');
    const composed = composeAgentPrompt({
      persona,
      fixtureDir: '/tmp/fixture',
      installPrompt: 'INSTALL PROMPT BODY',
    });

    expect(composed).toContain('/tmp/fixture');
    expect(composed).toContain('INSTALL PROMPT BODY');
    expect(composed).not.toContain('{{FIXTURE_DIR}}');
    expect(composed).not.toContain('{{INSTALL_PROMPT}}');
    expect(composed.length).toBeGreaterThan(400);
  });

  it('leaves an unmarked comment alone', () => {
    // Not "strip all HTML comments": a persona may need an inline note the agent should see, and deleting
    // it would silently change the pressure under test.
    const composed = stripPersonaMeta('<!-- keep me -->\npolicy text');

    expect(composed).toContain('<!-- keep me -->');
  });

  it('drops the remainder of an unterminated block rather than leaking it', () => {
    const composed = stripPersonaMeta('policy\n<!-- field-test:meta\nSECRET RATIONALE\nmore');

    expect(composed).not.toContain('SECRET RATIONALE');
  });

  it('is what the runner actually uses', () => {
    // Wiring, not definition. A perfect composer nothing calls is the shape of the original defect: the
    // runner had its own `replaceAll` chain and never consulted anything.
    const runner = readFileSync(path.join(here, '..', 'field-test', 'run.mjs'), 'utf8');

    expect(runner).toContain("from './persona.mjs'");
    expect(runner).toContain('composeAgentPrompt({');
    // And no second composition path that could bypass the strip.
    expect(runner).not.toContain("replaceAll('{{INSTALL_PROMPT}}'");
  });
});
