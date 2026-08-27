// Spawning the agent under test, and the last place anything can be checked before it is spoken.
//
// This lives apart from the runner for one reason: `child.stdin.write` is the seam, and a guard has to sit
// AT the seam to be worth anything. Checking that the runner calls the composer somewhere is not the same
// check — it stays true while a later edit hands `runAgent` a raw persona, or a new call site skips the
// composer entirely, and neither shows up in the composer's own tests.
//
// So the refusal is here, where every present and future caller passes through, rather than in a review
// habit.
import { spawn } from 'node:child_process';
import { META_OPEN } from './persona.mjs';

/**
 * Run `agentCmd`, giving it `promptText` on stdin, and collect what it said.
 *
 * Refuses to send provenance. A persona's `field-test:meta` block tells the reader that the policy is a
 * synthetic reconstruction and that the harness is measuring whether the install prompt survives — which,
 * read by the agent, announces the evaluation and hands it a reason to discount the policy it is supposed
 * to be applying. A green round would then no longer distinguish a prompt that survives platform pressure
 * from one an agent waved through because it knew it was being watched.
 *
 * Throwing rather than stripping here: stripping would make the seam silently tolerate a caller that
 * skipped the composer, and the next such caller would pass a persona whose OTHER handling — the
 * substitutions — had also been skipped. The composer is the one place that decides what an agent sees.
 */
export function runAgent(agentCmd, promptText, fixtureDir, endpoint, timeoutMs) {
  if (typeof promptText !== 'string' || promptText.length === 0) {
    throw new Error('runAgent: refusing to run with an empty prompt — an agent given nothing produces a refusal that looks like a finding.');
  }
  if (promptText.includes(META_OPEN)) {
    throw new Error(
      `runAgent: refusing to send persona provenance to the agent (found ${META_OPEN}). ` +
        'Compose the prompt with composeAgentPrompt() — a prompt that announces the evaluation makes a green round meaningless.',
    );
  }

  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', agentCmd], {
      cwd: fixtureDir,
      env: { ...process.env, PATCHSTACK_ENDPOINT: endpoint },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ output: out, stderr: err, exitCode: code, timedOut });
    });
    child.stdin.write(promptText);
    child.stdin.end();
  });
}
