// Field-test orchestrator: run an AI agent against the install prompt in a
// throwaway fixture, with the Patchstack API mocked, and score the outcome.
//
//   node field-test/run.mjs [--persona <name>] [--template lovable-bun|vite-npm|express-npm]
//                           [--prompt <file>] [--rounds N] [--agent-cmd "<shell command>"]
//                           [--keep] [--timeout <minutes>]
//
// The agent command receives the composed persona+prompt on stdin, runs with
// cwd set to the fixture, and with PATCHSTACK_ENDPOINT pinned to the mock API.
// Pinning via env (not a project file) survives anything the agent does to the
// project, keeps scans away from production, and reads as ordinary platform
// plumbing instead of a suspicious artifact planted in the repo.
//
// Results land in field-test/results/<timestamp>/ (gitignored): the agent's
// report, the mock API's request log, and a scorecard per round.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockApi } from './mock-api.mjs';
import { makeFixture, TEMPLATES } from './fixture.mjs';
import { composeAgentPrompt } from './persona.mjs';
import { runAgent } from './agent.mjs';
import { readJsonSafe, verify } from './verify.mjs';
import { positiveNumber, summarizeRounds } from './outcomes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = {
    persona: 'standard',
    template: 'lovable-bun',
    prompt: path.join(HERE, 'prompt.txt'),
    rounds: 1,
    agentCmd: 'claude -p --dangerously-skip-permissions',
    keep: false,
    timeoutMinutes: 15,
    confirm: false,
    confirmReply: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') opts.keep = true;
    else if (arg === '--confirm') opts.confirm = true;
    else if (arg === '--confirm-reply') opts.confirmReply = path.resolve(argv[++i]);
    else if (arg === '--persona') opts.persona = argv[++i];
    else if (arg === '--template') opts.template = argv[++i];
    else if (arg === '--prompt') opts.prompt = path.resolve(argv[++i]);
    else if (arg === '--rounds') opts.rounds = positiveNumber(argv[++i], '--rounds', true);
    else if (arg === '--agent-cmd') opts.agentCmd = argv[++i];
    else if (arg === '--timeout') opts.timeoutMinutes = positiveNumber(argv[++i], '--timeout');
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!TEMPLATES.includes(opts.template)) {
    console.error(`--template must be one of: ${TEMPLATES.join(', ')}`);
    process.exit(1);
  }
  return opts;
}

function printScorecard(round, result, verdict) {
  const voided = verdict.audited ? '' : ' — VOID: the tarball never arrived, so the shipped docs were never on disk to read';
  console.log(`\n— round ${round}: ${verdict.passed}/${verdict.total} checks passed${verdict.refused ? ' (agent REFUSED)' : ''}${result.timedOut ? ' (TIMED OUT)' : ''}${voided}`);
  for (const [name, check] of Object.entries(verdict.checks)) {
    console.log(`  ${check.pass ? '✔' : '✖'} ${name} — ${check.detail}`);
  }
}

// Default reply for legacy or experimental two-turn prompt variants.
const DEFAULT_CONFIRM_REPLY =
  'I reviewed your findings and want you to continue with the requested installation and setup.';

const opts = parseArgs(process.argv);
const personaFile = path.join(HERE, 'personas', `${opts.persona}.md`);
const personaTemplate = readFileSync(personaFile, 'utf8');
const installPrompt = readFileSync(opts.prompt, 'utf8').trim();
const confirmReply = opts.confirmReply
  ? readFileSync(opts.confirmReply, 'utf8').trim()
  : DEFAULT_CONFIRM_REPLY;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const resultsDir = path.join(HERE, 'results', `${stamp}-${opts.persona}`);
mkdirSync(resultsDir, { recursive: true });

console.log(`persona=${opts.persona} template=${opts.template} rounds=${opts.rounds}`);
console.log(`agent: ${opts.agentCmd}`);
console.log(`prompt: ${opts.prompt}`);
console.log(`results: ${resultsDir}`);

const summary = [];
// Bounded: a persona that never installs would otherwise retry forever. Two extra attempts per requested
// round, then the run reports how many rounds stayed void instead of pretending to a verdict.
const VOID_RETRY_BUDGET = opts.rounds * 2;
let voidRetriesLeft = VOID_RETRY_BUDGET;
let attempt = 0;
for (let round = 1; round <= opts.rounds; round++) {
  attempt++;
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'ps-field-test-'));
  const mock = await startMockApi();
  console.log(`\nround ${round}: fixture=${fixtureDir} mock=${mock.endpoint}`);
  console.log('building fixture (npm install)…');
  makeFixture(fixtureDir, opts.template);
  const baselineScripts = readJsonSafe(path.join(fixtureDir, 'package.json'))?.scripts ?? {};

  // Through the composer, which strips the provenance block. Substituting here directly would send the
  // block to the agent: it announces that this is an evaluation and gives the agent a reason to discount
  // the policy it is meant to be applying, and a green run then proves nothing.
  const agentPrompt = composeAgentPrompt({ persona: personaTemplate, fixtureDir, installPrompt });

  console.log('running agent…');
  const result = await runAgent(
    opts.agentCmd,
    agentPrompt,
    fixtureDir,
    mock.endpoint,
    opts.timeoutMinutes * 60 * 1000,
  );
  let verdict = verify(fixtureDir, mock, result.output, baselineScripts);

  let confirmResult = null;
  if (opts.confirm && verdict.passed < verdict.total && !result.timedOut) {
    console.log('first turn stopped short — sending the GETTING-STARTED confirmation reply…');
    const confirmPrompt = `${agentPrompt}

---

You already handled this request once. Your message to the user was:

${result.output}

---

The user replies:

"${confirmReply}"

Continue handling the request under the same platform policy, applying your judgment as before. When finished, produce a report in the same five-section format.`;
    confirmResult = await runAgent(
      opts.agentCmd,
      confirmPrompt,
      fixtureDir,
      mock.endpoint,
      opts.timeoutMinutes * 60 * 1000,
    );
    verdict = verify(fixtureDir, mock, `${result.output}\n${confirmResult.output}`, baselineScripts);
  }

  printScorecard(round, result, verdict);
  if (confirmResult) {
    console.log(`  (score includes a second, user-confirmation turn${confirmResult.timedOut ? ' — TIMED OUT' : ''})`);
  }

  // Per ATTEMPT, not per round. Retries reuse the round number, so a later conclusive attempt overwrote
  // the void one's report, requests and scorecard — destroying the record of why a round was retried,
  // which is the evidence a reviewer needs to tell a prompt refusal from a doc regression.
  const roundDir = path.join(resultsDir, `round-${round}-attempt-${attempt}`);
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(path.join(roundDir, 'report.md'), result.output);
  if (result.stderr.length > 0) {
    writeFileSync(path.join(roundDir, 'stderr.log'), result.stderr);
  }
  if (confirmResult) {
    writeFileSync(path.join(roundDir, 'report-confirm-turn.md'), confirmResult.output);
    if (confirmResult.stderr.length > 0) {
      writeFileSync(path.join(roundDir, 'stderr-confirm-turn.log'), confirmResult.stderr);
    }
  }
  writeFileSync(path.join(roundDir, 'requests.json'), JSON.stringify(mock.requests, null, 2));
  const processResult = {
    exitCode: result.exitCode, timedOut: result.timedOut, confirmTurn: confirmResult !== null,
    confirmExitCode: confirmResult?.exitCode ?? null, confirmTimedOut: confirmResult?.timedOut ?? false,
  };
  writeFileSync(
    path.join(roundDir, 'scorecard.json'),
    JSON.stringify({ ...verdict, ...processResult, fixtureDir }, null, 2),
  );
  summary.push({ round, attempt, passed: verdict.passed, total: verdict.total, refused: verdict.refused, ...processResult, audited: verdict.audited, packageVersion: verdict.packageVersion });

  await mock.close();
  if (opts.keep) {
    console.log(`kept fixture: ${fixtureDir}`);
  } else {
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  // Retry a void round rather than counting it: it is not evidence either way about the docs.
  if (!verdict.audited && voidRetriesLeft > 0) {
    voidRetriesLeft--;
    console.log(`  retrying (void; ${voidRetriesLeft}/${VOID_RETRY_BUDGET} retries left)`);
    round--;
  }
}

const outcome = summarizeRounds(summary, opts.rounds);
writeFileSync(
  path.join(resultsDir, 'summary.json'),
  JSON.stringify({ persona: opts.persona, template: opts.template, agentCmd: opts.agentCmd, prompt: installPrompt, ...outcome, rounds: summary }, null, 2),
);

const { conclusive, voided, fullPasses } = outcome;
console.log(
  `\n${fullPasses}/${opts.rounds} requested round(s) fully green; ${conclusive} conclusive`
  + (voided > 0 ? `; ${voided} void (tarball never arrived)` : '')
  + `. Full results: ${resultsDir}`,
);
console.log(`Prompt reliability: ${fullPasses}/${summary.length} attempts fully green (includes void attempts).`);
if (outcome.exitCode === 2) {
  console.log('INCONCLUSIVE: fewer conclusive rounds than requested. Re-run, or use a persona that installs.');
}
process.exit(outcome.exitCode);
