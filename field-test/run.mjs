// Field-test orchestrator: run an AI agent against the install prompt in a
// throwaway fixture, with the Patchstack API mocked, and score the outcome.
//
//   node field-test/run.mjs [--persona standard|hostile] [--template lovable-bun|vite-npm]
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
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') opts.keep = true;
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
  const markWired = ['postbuild', 'build'].some((key) => {
    const script = scripts[key] ?? '';
    return (
      script.includes('patchstack-connect mark-build') &&
      /(?:^|\s)--strict(?=\s|$)/.test(script)
    );
  });

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
      detail: `scan wired=${scanWired}, strict mark-build wired=${markWired}`,
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

  const refused = !checks.provisioned.pass && /refus/i.test(agentOutput);
  const passed = Object.values(checks).filter((check) => check.pass).length;
  return { checks, refused, passed, total: Object.keys(checks).length };
}

function printScorecard(round, result, verdict) {
  console.log(`\n— round ${round}: ${verdict.passed}/${verdict.total} checks passed${verdict.refused ? ' (agent REFUSED)' : ''}${result.timedOut ? ' (TIMED OUT)' : ''}`);
  for (const [name, check] of Object.entries(verdict.checks)) {
    console.log(`  ${check.pass ? '✔' : '✖'} ${name} — ${check.detail}`);
  }
}

const opts = parseArgs(process.argv);
const personaFile = path.join(HERE, 'personas', `${opts.persona}.md`);
const personaTemplate = readFileSync(personaFile, 'utf8');
const installPrompt = readFileSync(opts.prompt, 'utf8').trim();

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const resultsDir = path.join(HERE, 'results', `${stamp}-${opts.persona}`);
mkdirSync(resultsDir, { recursive: true });

console.log(`persona=${opts.persona} template=${opts.template} rounds=${opts.rounds}`);
console.log(`agent: ${opts.agentCmd}`);
console.log(`prompt: ${opts.prompt}`);
console.log(`results: ${resultsDir}`);

const summary = [];
for (let round = 1; round <= opts.rounds; round++) {
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
  const verdict = verify(fixtureDir, mock, result.output);
  printScorecard(round, result, verdict);

  const roundDir = path.join(resultsDir, `round-${round}`);
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(path.join(roundDir, 'report.md'), result.output);
  if (result.stderr.length > 0) {
    writeFileSync(path.join(roundDir, 'stderr.log'), result.stderr);
  }
  writeFileSync(path.join(roundDir, 'requests.json'), JSON.stringify(mock.requests, null, 2));
  writeFileSync(
    path.join(roundDir, 'scorecard.json'),
    JSON.stringify({ ...verdict, exitCode: result.exitCode, timedOut: result.timedOut, fixtureDir }, null, 2),
  );
  summary.push({ round, passed: verdict.passed, total: verdict.total, refused: verdict.refused, timedOut: result.timedOut });

  await mock.close();
  if (opts.keep) {
    console.log(`kept fixture: ${fixtureDir}`);
  } else {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

writeFileSync(
  path.join(resultsDir, 'summary.json'),
  JSON.stringify({ persona: opts.persona, template: opts.template, agentCmd: opts.agentCmd, prompt: installPrompt, rounds: summary }, null, 2),
);

const fullPasses = summary.filter((round) => round.passed === round.total).length;
console.log(`\n${fullPasses}/${summary.length} round(s) fully green. Full results: ${resultsDir}`);
process.exit(fullPasses === summary.length ? 0 : 1);
