// Field-test orchestrator: run an AI agent against the install prompt in a
// throwaway fixture, with the Patchstack API mocked, and score the outcome.
//
//   node field-test/run.mjs [--persona <name>] [--template lovable-bun|vite-npm]
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
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockApi } from './mock-api.mjs';
import { makeFixture, TEMPLATES } from './fixture.mjs';

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
    else if (arg === '--rounds') opts.rounds = Number(argv[++i]);
    else if (arg === '--agent-cmd') opts.agentCmd = argv[++i];
    else if (arg === '--timeout') opts.timeoutMinutes = Number(argv[++i]);
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

function runAgent(agentCmd, promptText, fixtureDir, endpoint, timeoutMs) {
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

/** Bounded search for `needle` in the fixture's source files (skips node_modules etc.). */
function fixtureContains(dir, needle) {
  const skipped = new Set(['node_modules', '.git', 'dist', 'build', '.output', 'coverage']);
  const walk = (current, depth) => {
    if (depth > 5) return false;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipped.has(entry.name) || entry.name.startsWith('.')) continue;
        if (walk(full, depth + 1)) return true;
      } else if (entry.isFile() && statSync(full).size < 512 * 1024) {
        try {
          if (readFileSync(full, 'utf8').includes(needle)) return true;
        } catch {
          // unreadable — skip
        }
      }
    }
    return false;
  };
  return walk(dir, 0);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Score one completed run. Every check is { pass, detail }. */
function verify(fixtureDir, mock, agentOutput) {
  const pkg = readJsonSafe(path.join(fixtureDir, 'package.json')) ?? {};
  const rc = readJsonSafe(path.join(fixtureDir, '.patchstackrc.json')) ?? {};
  const scripts = pkg.scripts ?? {};
  const dep =
    pkg.devDependencies?.['@patchstack/connect'] ?? pkg.dependencies?.['@patchstack/connect'];

  const provisionPosts = mock.requests.filter(
    (request) => request.method === 'POST' && request.url === '/monitor/pulse/manifest',
  ).length;

  const scanWired = ['prebuild', 'build'].some((key) =>
    (scripts[key] ?? '').includes('patchstack-connect scan'),
  );
  const markWired = ['postbuild', 'build'].some((key) =>
    (scripts[key] ?? '').includes('patchstack-connect mark-build'),
  );

  const checks = {
    installed: {
      pass: dep !== undefined,
      detail: dep !== undefined ? `declared ${dep}` : 'not in package.json',
    },
    provisioned: {
      pass: rc.siteUuid === mock.uuid,
      detail: `rc siteUuid=${rc.siteUuid ?? '(none)'}, mock uuid=${mock.uuid}, provision POSTs=${provisionPosts}`,
    },
    provisionedOnce: {
      pass: provisionPosts <= 1,
      detail: `${provisionPosts} provisioning POST(s) — more than one means a duplicate site`,
    },
    hooksWired: {
      pass: scanWired && markWired,
      detail: `scan wired=${scanWired}, mark-build wired=${markWired}`,
    },
    widgetInstalled: {
      pass: fixtureContains(fixtureDir, 'patchstack-widget'),
      detail: 'widget script tag present in source',
    },
    widgetTokenMatches: {
      pass: fixtureContains(fixtureDir, mock.uuid),
      detail: 'provisioned UUID appears in source (userToken)',
    },
    claimUrlSurfaced: {
      pass: agentOutput.includes('/monitor/claim?site='),
      detail: 'claim URL appears in the agent\'s final output',
    },
    noProductionLeak: {
      pass: !agentOutput.includes('api.patchstack.com/monitor/claim'),
      detail: 'agent never surfaced a production claim URL (would mean it bypassed the mock)',
    },
  };

  const refused = !checks.provisioned.pass && /refus|stall|declin/i.test(agentOutput);
  const passed = Object.values(checks).filter((check) => check.pass).length;

  // A round where nothing was installed cannot say anything about the SHIPPED DOCS.
  //
  // Agents `npm pack` the tarball and audit it, and a contradiction between the docs and `dist/` — an
  // undisclosed command, an overbroad privacy claim — is a recorded refusal driver (mode 6). That is the
  // thing the documentation gate exists to detect. But an agent that refuses on the PROMPT never obtains
  // the tarball, so it never reads the docs at all, and its scorecard is identical to one produced by a
  // doc regression: `2/8 REFUSED` either way, with no field distinguishing them.
  //
  // Gating "must pass N rounds" on that number therefore cannot fail for a documentation reason. Such a
  // round is VOID — neither evidence for nor against the docs — and is retried rather than counted.
  const audited = checks.installed.pass;
  return { checks, refused, passed, total: Object.keys(checks).length, audited };
}

function printScorecard(round, result, verdict) {
  const voided = verdict.audited ? '' : ' — VOID: never installed, so the shipped docs were never read';
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

  const agentPrompt = personaTemplate
    .replaceAll('{{FIXTURE_DIR}}', fixtureDir)
    .replaceAll('{{INSTALL_PROMPT}}', installPrompt);

  console.log('running agent…');
  const result = await runAgent(
    opts.agentCmd,
    agentPrompt,
    fixtureDir,
    mock.endpoint,
    opts.timeoutMinutes * 60 * 1000,
  );
  let verdict = verify(fixtureDir, mock, result.output);

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
    verdict = verify(fixtureDir, mock, `${result.output}\n${confirmResult.output}`);
  }

  printScorecard(round, result, verdict);
  if (confirmResult) {
    console.log(`  (score includes a second, user-confirmation turn${confirmResult.timedOut ? ' — TIMED OUT' : ''})`);
  }

  const roundDir = path.join(resultsDir, `round-${round}`);
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
  writeFileSync(
    path.join(roundDir, 'scorecard.json'),
    JSON.stringify({ ...verdict, exitCode: result.exitCode, timedOut: result.timedOut, confirmTurn: confirmResult !== null, fixtureDir }, null, 2),
  );
  summary.push({ round, attempt, passed: verdict.passed, total: verdict.total, refused: verdict.refused, timedOut: result.timedOut, confirmTurn: confirmResult !== null, audited: verdict.audited });

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

writeFileSync(
  path.join(resultsDir, 'summary.json'),
  JSON.stringify({ persona: opts.persona, template: opts.template, agentCmd: opts.agentCmd, prompt: installPrompt, rounds: summary }, null, 2),
);

const conclusive = summary.filter((round) => round.audited);
const voided = summary.length - conclusive.length;
const fullPasses = conclusive.filter((round) => round.passed === round.total).length;
console.log(
  `\n${fullPasses}/${conclusive.length} conclusive round(s) fully green`
  + (voided > 0 ? `; ${voided} void (never installed, so the shipped docs were never read)` : '')
  + `. Full results: ${resultsDir}`,
);
if (conclusive.length === 0) {
  console.log(
    'INCONCLUSIVE: no round installed the package, so this run is not evidence about the shipped docs.\n'
    + 'It is neither a pass nor a failure of the documentation gate. Re-run, or use a persona that installs.',
  );
}
// 2 = inconclusive, distinct from 1 (a real failure): a caller gating a release must not read "the agent
// refused before installing" as "the docs are wrong", nor as "the docs are fine".
process.exit(conclusive.length === 0 ? 2 : fullPasses === conclusive.length ? 0 : 1);
