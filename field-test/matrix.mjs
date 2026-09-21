// Matrix runner: personas × agent CLIs, one run.mjs invocation per cell.
//
//   node field-test/matrix.mjs [--personas bolt-diy,lovable,replit] [--agents claude,codex,gemini]
//                              [--rounds N] [--prompt <file>] [--template lovable-bun|vite-npm|express-npm]
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
import { cellGreen, positiveNumber } from './outcomes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const AGENTS = {
  claude: { executable: 'claude', command: 'claude -p --dangerously-skip-permissions' },
  codex: { executable: 'codex', command: 'codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox' },
  gemini: { executable: 'gemini', command: 'gemini --yolo' },
  stub: { executable: process.execPath, command: `${shellQuote(process.execPath)} ${shellQuote(path.join(HERE, 'stub-compliant.mjs'))}` },
};

export function loadAgents(file) {
  if (!file) return { ...AGENTS };
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (config === null || Array.isArray(config) || typeof config !== 'object') {
    throw new Error('--agent-config must contain an object of named agent commands');
  }
  for (const [name, agent] of Object.entries(config)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || typeof agent?.command !== 'string' ||
        !agent.command.trim() || typeof agent?.executable !== 'string' || !agent.executable.trim()) {
      throw new Error('Each agent needs a simple name, a non-empty command, and an executable');
    }
  }
  return { ...AGENTS, ...config };
}

export function parseArgs(argv) {
  const opts = {
    personas: ['bolt-diy', 'lovable', 'replit'],
    agents: ['claude'],
    rounds: 1,
    prompt: null,
    template: null,
    timeoutMinutes: null,
    agentConfig: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--personas') opts.personas = argv[++i].split(',').map((name) => name.trim());
    else if (arg === '--agents') opts.agents = argv[++i].split(',').map((name) => name.trim());
    else if (arg === '--rounds') opts.rounds = positiveNumber(argv[++i], '--rounds', true);
    else if (arg === '--agent-config') opts.agentConfig = path.resolve(argv[++i]);
    else if (arg === '--prompt') opts.prompt = path.resolve(argv[++i]);
    else if (arg === '--template') opts.template = argv[++i];
    else if (arg === '--timeout') opts.timeoutMinutes = positiveNumber(argv[++i], '--timeout');
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if ([...opts.personas, ...opts.agents].some((name) => !/^[a-zA-Z0-9_-]+$/.test(name))) {
    throw new Error('Persona and agent lists must contain non-empty names');
  }
  opts.personas = [...new Set(opts.personas)];
  opts.agents = [...new Set(opts.agents)];
  return opts;
}

function checkPersona(name) {
  const file = path.join(HERE, 'personas', `${name}.md`);
  if (!existsSync(file)) {
    console.error(`No such persona: ${name} (expected ${file})`);
    process.exit(1);
  }
}

function checkAgent(name, agents) {
  const agent = agents[name];
  if (!agent) {
    console.error(`No such agent: ${name}. Known agents: ${Object.keys(agents).join(', ')}`);
    process.exit(1);
  }
  const found = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', agent.executable], { stdio: 'ignore' });
  return found.status === 0;
}

/** Run one cell via run.mjs, streaming its output, and collect its summary. */
function runCell(persona, agentName, opts, agents) {
  return new Promise((resolve) => {
    const args = [
      path.join(HERE, 'run.mjs'),
      '--persona', persona,
      '--agent-cmd', agents[agentName].command,
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

export function cellLabel(cell) {
  if (cell.unavailable) return 'UNAVAILABLE';
  if (cell.exitCode === 2) return 'INCONCLUSIVE';
  if (!cell.rounds) return 'ERROR';
  return cell.rounds
    .map((round) => `${round.passed}/${round.total}${!round.audited ? ' VOID' : ''}${round.refused ? ' R' : ''}${round.timedOut || round.confirmTimedOut ? ' T' : ''}${round.exitCode !== 0 || (round.confirmTurn && round.confirmExitCode !== 0) ? ' E' : ''}`)
    .join(', ');
}

async function main() {
  const opts = parseArgs(process.argv);
  const agents = loadAgents(opts.agentConfig);
  opts.personas.forEach(checkPersona);

  const unavailable = opts.agents.filter((name) => !checkAgent(name, agents));
  if (unavailable.length > 0) {
    console.warn(`agents unavailable (matrix cannot pass): ${unavailable.join(', ')}`);
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
      cells.push(unavailable.includes(agent)
        ? { persona, agent, exitCode: null, resultsDir: null, rounds: null, unavailable: true }
        : await runCell(persona, agent, opts, agents));
    }
  }

  const header = `| persona | ${opts.agents.join(' | ')} |`;
  const divider = `|---|${opts.agents.map(() => '---').join('|')}|`;
  const rows = opts.personas.map((persona) => {
    const labels = opts.agents.map((agent) => {
      const cell = cells.find((c) => c.persona === persona && c.agent === agent);
      return `${cellGreen(cell, opts.rounds) ? '✅' : '❌'} ${cellLabel(cell)}`;
    });
    return `| ${persona} | ${labels.join(' | ')} |`;
  });

  const table = [header, divider, ...rows].join('\n');
  const legend = 'Each cell: checks passed per attempt (`R` = refused, `T` = timed out, `E` = process error, `VOID` = package not unpacked). INCONCLUSIVE = insufficient conclusive rounds; UNAVAILABLE = missing CLI; ERROR = no scorecard. ✅ requires every requested round, a successful process, and no void attempts.';
  const dirList = cells
    .map((cell) => `- ${cell.persona} × ${cell.agent}: ${cell.resultsDir ?? '(no results dir)'}`)
    .join('\n');

  writeFileSync(
    path.join(matrixDir, 'matrix.md'),
    `# Field-test matrix — ${stamp}\n\nrounds per cell: ${opts.rounds}\n\n${table}\n\n${legend}\n\n## Per-cell results\n\n${dirList}\n`,
  );
  writeFileSync(path.join(matrixDir, 'matrix.json'), JSON.stringify({ opts, agents, cells }, null, 2));

  console.log(`\n\n${table}\n\n${legend}`);
  console.log(`\nAggregate written to ${matrixDir}`);

  process.exit(cells.length > 0 && cells.every((cell) => cellGreen(cell, opts.rounds)) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
