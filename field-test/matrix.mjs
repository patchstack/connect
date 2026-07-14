// Matrix runner: personas × agent CLIs, one run.mjs invocation per cell.
//
//   node field-test/matrix.mjs [--personas bolt-diy,lovable,replit] [--agents claude,codex,gemini]
//                              [--rounds N] [--prompt <file>] [--template lovable-bun|vite-npm]
//                              [--timeout <minutes>]
//
// Personas are files in personas/<name>.md. Agents are named entries in the
// AGENTS table below — each must be a CLI that reads the composed prompt from
// stdin and prints the agent's output to stdout (the same contract as
// run.mjs --agent-cmd). Cells run sequentially; each cell's full output goes
// to its own run.mjs results directory, and the aggregate lands in
// field-test/results/matrix-<timestamp>/ (gitignored) as matrix.md + matrix.json.
//
// Auth prerequisites (checked at startup; unauthenticated agents fail their
// cells, they don't block the matrix):
//   claude — logged-in Claude Code (`claude` interactive at least once)
//   codex  — `codex login` (ChatGPT account) or OPENAI_API_KEY
//   gemini — `gemini` login flow completed once interactively, or GEMINI_API_KEY;
//            Google Workspace accounts also need GOOGLE_CLOUD_PROJECT
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const AGENTS = {
  claude: 'claude -p --dangerously-skip-permissions',
  codex: 'codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox',
  gemini: 'gemini --yolo',
  stub: `node ${path.join(HERE, 'stub-compliant.mjs')}`,
};

function parseArgs(argv) {
  const opts = {
    personas: ['bolt-diy', 'lovable', 'replit'],
    agents: ['claude'],
    rounds: 1,
    prompt: null,
    template: null,
    timeoutMinutes: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--personas') opts.personas = argv[++i].split(',').map((name) => name.trim());
    else if (arg === '--agents') opts.agents = argv[++i].split(',').map((name) => name.trim());
    else if (arg === '--rounds') opts.rounds = Number(argv[++i]);
    else if (arg === '--prompt') opts.prompt = path.resolve(argv[++i]);
    else if (arg === '--template') opts.template = argv[++i];
    else if (arg === '--timeout') opts.timeoutMinutes = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

function checkPersona(name) {
  const file = path.join(HERE, 'personas', `${name}.md`);
  if (!existsSync(file)) {
    console.error(`No such persona: ${name} (expected ${file})`);
    process.exit(1);
  }
}

function checkAgent(name) {
  const cmd = AGENTS[name];
  if (!cmd) {
    console.error(`No such agent: ${name}. Known agents: ${Object.keys(AGENTS).join(', ')}`);
    process.exit(1);
  }
  const binary = cmd.split(' ')[0];
  const found = spawnSync('sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' });
  return found.status === 0;
}

/** Run one cell via run.mjs, streaming its output, and collect its summary. */
function runCell(persona, agentName, opts) {
  return new Promise((resolve) => {
    const args = [
      path.join(HERE, 'run.mjs'),
      '--persona', persona,
      '--agent-cmd', AGENTS[agentName],
      '--rounds', String(opts.rounds),
    ];
    if (opts.prompt) args.push('--prompt', opts.prompt);
    if (opts.template) args.push('--template', opts.template);
    if (opts.timeoutMinutes) args.push('--timeout', String(opts.timeoutMinutes));

    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    child.on('close', (exitCode) => {
      const resultsDir = out.match(/^results: (.+)$/m)?.[1]?.trim() ?? null;
      let rounds = null;
      if (resultsDir) {
        try {
          rounds = JSON.parse(readFileSync(path.join(resultsDir, 'summary.json'), 'utf8')).rounds;
        } catch {
          // run.mjs died before writing a summary — leave rounds null
        }
      }
      resolve({ persona, agent: agentName, exitCode, resultsDir, rounds });
    });
  });
}

function cellLabel(cell) {
  if (!cell.rounds) return 'ERROR';
  return cell.rounds
    .map((round) => `${round.passed}/${round.total}${round.refused ? ' R' : ''}${round.timedOut ? ' T' : ''}`)
    .join(', ');
}

function cellGreen(cell) {
  return cell.rounds !== null && cell.rounds.every((round) => round.passed === round.total);
}

const opts = parseArgs(process.argv);
opts.personas.forEach(checkPersona);

const unavailable = opts.agents.filter((name) => !checkAgent(name));
if (unavailable.length > 0) {
  console.warn(`skipping agents with no CLI on PATH: ${unavailable.join(', ')}`);
  opts.agents = opts.agents.filter((name) => !unavailable.includes(name));
}
if (opts.agents.length === 0) {
  console.error('No runnable agents.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const matrixDir = path.join(HERE, 'results', `matrix-${stamp}`);
mkdirSync(matrixDir, { recursive: true });

console.log(`matrix: ${opts.personas.length} persona(s) × ${opts.agents.length} agent(s) × ${opts.rounds} round(s)`);
console.log(`personas: ${opts.personas.join(', ')}`);
console.log(`agents: ${opts.agents.join(', ')}`);
console.log(`aggregate: ${matrixDir}\n`);

const cells = [];
for (const persona of opts.personas) {
  for (const agent of opts.agents) {
    console.log(`\n=== cell: persona=${persona} agent=${agent} ===`);
    cells.push(await runCell(persona, agent, opts));
  }
}

const header = `| persona | ${opts.agents.join(' | ')} |`;
const divider = `|---|${opts.agents.map(() => '---').join('|')}|`;
const rows = opts.personas.map((persona) => {
  const labels = opts.agents.map((agent) => {
    const cell = cells.find((c) => c.persona === persona && c.agent === agent);
    return `${cellGreen(cell) ? '✅' : '❌'} ${cellLabel(cell)}`;
  });
  return `| ${persona} | ${labels.join(' | ')} |`;
});

const table = [header, divider, ...rows].join('\n');
const legend = 'Each cell: checks passed per round (`R` = agent refused, `T` = timed out, `ERROR` = run died before scoring). ✅ = every round fully green.';
const dirList = cells
  .map((cell) => `- ${cell.persona} × ${cell.agent}: ${cell.resultsDir ?? '(no results dir)'}`)
  .join('\n');

writeFileSync(
  path.join(matrixDir, 'matrix.md'),
  `# Field-test matrix — ${stamp}\n\nrounds per cell: ${opts.rounds}\n\n${table}\n\n${legend}\n\n## Per-cell results\n\n${dirList}\n`,
);
writeFileSync(path.join(matrixDir, 'matrix.json'), JSON.stringify({ opts, cells }, null, 2));

console.log(`\n\n${table}\n\n${legend}`);
console.log(`\nAggregate written to ${matrixDir}`);

process.exit(cells.every(cellGreen) ? 0 : 1);
