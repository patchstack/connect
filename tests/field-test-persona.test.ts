import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { composeAgentPrompt, stripPersonaMeta, META_OPEN } from '../field-test/persona.mjs';
import { runAgent } from '../field-test/agent.mjs';

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

  it('throws on an unterminated block rather than truncating the persona', () => {
    // Truncating cannot leak, which is why it looked sufficient. It is not loud, though: a malformed block
    // after both substitutions and enough policy text leaves a persona that passes every length and
    // substitution check, and the harness then evaluates a silently incomplete policy — measuring a
    // pressure nobody wrote.
    const late = `You are an agent. Work in {{FIXTURE_DIR}}.\n${'Policy line.\n'.repeat(40)}{{INSTALL_PROMPT}}\n<!-- field-test:meta\nSECRET RATIONALE`;

    expect(() => stripPersonaMeta(late)).toThrow(/Unterminated/);

    // And the case that made truncation look adequate: composed output would otherwise have satisfied the
    // shape checks, so those checks could not have caught it.
    let composed = '';
    try {
      composed = composeAgentPrompt({ persona: late, fixtureDir: '/tmp/f', installPrompt: 'BODY' });
    } catch {
      composed = '';
    }
    expect(composed).toBe('');
  });
});

/**
 * What the child process actually receives.
 *
 * The previous version of this checked SOURCE STRINGS — that the runner mentions the composer and has no
 * second `replaceAll`. That stays true while a later edit hands `runAgent` a raw persona, or a new call
 * site skips the composer, and neither shows up anywhere else. Source text is not the seam;
 * `child.stdin.write` is.
 *
 * So the guard now sits at the seam and this drives it directly: no fixture, no `npm install`, no network,
 * which is what lets it run in the always-run suite rather than as a manual command.
 */
describe('the stdin the agent is actually given', () => {
  const captureStub = path.join(here, '..', 'field-test', 'stub-capture.mjs');

  async function capture(promptText: string): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), 'ps-capture-'));
    const target = path.join(dir, 'captured.txt');
    try {
      const result = await runAgent(
        `PS_CAPTURE_STDIN=${target} node ${JSON.stringify(captureStub)}`,
        promptText,
        dir,
        'http://127.0.0.1:1/mock',
        20000,
      );
      expect(result.timedOut, `capture stub timed out: ${result.stderr}`).toBe(false);

      return readFileSync(target, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each(personas)('%s reaches the agent with its policy and no provenance', async (file) => {
    const persona = readFileSync(path.join(personaDir, file), 'utf8');
    const composed = composeAgentPrompt({
      persona,
      fixtureDir: '/tmp/fixture',
      installPrompt: 'INSTALL PROMPT BODY',
    });

    const seen = await capture(composed);

    // Byte-for-byte: this is the only assertion that covers the write itself, so an encoding or truncation
    // problem in the pipe shows up here rather than as a mysterious refusal in a real run.
    expect(seen).toBe(composed);
    expect(seen).not.toContain(META_OPEN);
    for (const block of metaBlocks(persona)) {
      for (const line of block.split('\n').map((l) => l.trim()).filter((l) => l.length > 12)) {
        expect(seen, `provenance reached the agent from ${file}: ${line}`).not.toContain(line);
      }
    }
    expect(seen).toContain('/tmp/fixture');
    expect(seen).toContain('INSTALL PROMPT BODY');
  });

  it('refuses to send a persona that skipped the composer', async () => {
    // The exact mistake the source-string test could not see: a caller handing over the raw file. The
    // refusal is at the seam, so it holds for every call site, including ones not written yet.
    const raw = readFileSync(path.join(personaDir, 'lovable.md'), 'utf8');

    expect(raw).toContain(META_OPEN);
    await expect(capture(raw)).rejects.toThrow(/refusing to send persona provenance/);
  });

  it('refuses to send nothing at all', async () => {
    // An agent given an empty prompt refuses, and that refusal is indistinguishable from a finding.
    await expect(capture('')).rejects.toThrow(/empty prompt/);
  });
});
