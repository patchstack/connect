// Records every Connect command the agent runs, with its output and exit code, without changing it.
//
// A wrapper named `npx` goes first on the agent's PATH. For a command that mentions Connect it saves the
// arguments, both output streams and the exit status, then returns them unchanged; anything else goes
// straight to the real npx. The log path is written into the wrapper itself, so nothing in the agent's
// environment names the harness (see agent.mjs for why the agent must not be told it is under test).
//
// This sees `npx …` invocations only. Connect's own install and build hooks run from package.json scripts
// and do not pass through it.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Create the wrapper. Returns the directory to prepend to PATH and the directory the log is written to. */
export function createCliLog(logDir) {
  mkdirSync(logDir, { recursive: true });
  const realNpx = execFileSync('sh', ['-c', 'command -v npx'], { encoding: 'utf8' }).trim();
  const binDir = mkdtempSync(path.join(tmpdir(), 'node-bin-'));
  const q = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  writeFileSync(path.join(binDir, 'npx'), `#!/usr/bin/env bash
case "$*" in
  *patchstack*) ;;
  *) exec ${q(realNpx)} "$@" ;;
esac
log=${q(logDir)}
n=$(${q(process.execPath)} -p 'String(Date.now()).padStart(15, "0")')-$$
printf '%s\\n' "$PWD" "$@" > "$log/$n.args"
${q(realNpx)} "$@" > >(tee "$log/$n.out") 2> >(tee "$log/$n.err" >&2)
status=$?
wait
echo "$status" > "$log/$n.status"
exit "$status"
`);
  chmodSync(path.join(binDir, 'npx'), 0o755);
  return { binDir, logDir };
}

/** The recorded commands in the order they ran: { args, cwd, status, stdout, stderr }. */
export function readCliLog(logDir) {
  if (!existsSync(logDir)) return [];
  const read = (file) => { try { return readFileSync(path.join(logDir, file), 'utf8'); } catch { return ''; } };
  return readdirSync(logDir).filter((file) => file.endsWith('.args')).sort().map((file) => {
    const id = file.slice(0, -'.args'.length);
    const [cwd, ...args] = read(file).replace(/\n$/, '').split('\n');
    const status = read(`${id}.status`).trim();
    return { args, cwd, status: status === '' ? null : Number(status), stdout: read(`${id}.out`), stderr: read(`${id}.err`) };
  });
}
