import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Every shell script embedded in a workflow has to parse.
 *
 * A `run:` block is a program that nothing checks. The compiler does not see it, the type checker does not
 * see it, and — this is the part that matters — CI usually does not either, because a job only runs on the
 * events it is configured for. A release-only job's script is first executed during a release, which is
 * the worst available moment to discover an unterminated quote.
 *
 * So this parses the workflows and puts every bash script through `bash -n`. It is a syntax check and
 * nothing more: it cannot tell whether a script does the right thing, only that it is a program. That is
 * enough to catch the class of error which is otherwise invisible until it fires.
 *
 * `bash -n` accepts `${{ … }}` as ordinary text, so the scripts are checked as written rather than with
 * expressions substituted — which keeps this from disagreeing with what the runner actually receives.
 */
const workflowDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

type Step = { run?: unknown; shell?: unknown; uses?: unknown; name?: unknown; if?: unknown; 'continue-on-error'?: unknown };
type Job = { steps?: Step[]; defaults?: { run?: { shell?: unknown } }; 'runs-on'?: unknown };
type Workflow = { jobs?: Record<string, Job>; defaults?: { run?: { shell?: unknown } } };

/**
 * The shell a step will actually run under, following the same precedence the runner uses: the step, then
 * the job, then the workflow, then the platform default — `pwsh` on Windows and `bash` everywhere else.
 */
function shellFor(workflow: Workflow, job: Job, step: Step): string {
  const declared = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
  if (typeof declared === 'string') return declared;

  const runsOn = JSON.stringify(job['runs-on'] ?? '');

  return /windows/i.test(runsOn) ? 'pwsh' : 'bash';
}

type Script = { file: string; job: string; step: string; shell: string; script: string };

function collectScripts(): Script[] {
  const out: Script[] = [];

  for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
    const workflow = parse(readFileSync(join(workflowDir, file), 'utf8')) as Workflow;

    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (typeof step.run !== 'string') continue;
        out.push({
          file,
          job: jobName,
          step: typeof step.name === 'string' ? step.name : `step ${index + 1}`,
          shell: shellFor(workflow, job, step),
          script: step.run,
        });
      }
    }
  }

  return out;
}

/**
 * Steps that must run even when an earlier step in their job has failed.
 *
 * GitHub ANDs an implicit `success()` into any step condition that contains no status-check function. So a
 * step whose `if` reads only `steps.x.outputs.y == 'true'` is silently also "and nothing has failed yet" —
 * which is the opposite of what these two need. They exist to record and report a state that has already
 * happened, and a failure earlier in the job is exactly when that recording matters.
 *
 * Named individually rather than checked as a rule, because "must run on failure" is a property of a
 * step's purpose and not something derivable from its text.
 */
const MUST_SURVIVE_FAILURE = [
  { workflow: 'publish.yml', job: 'record-version', step: 'Open or update the pull request' },
  { workflow: 'publish.yml', job: 'record-version', step: 'Fail if the invariant did not hold' },
];

describe('steps that must not be skipped by an implicit success()', () => {
  it.each(MUST_SURVIVE_FAILURE)('$step keeps a status function in its condition', ({ workflow, job, step }) => {
    const parsed = parse(readFileSync(join(workflowDir, workflow), 'utf8')) as Workflow;
    const found = (parsed.jobs?.[job]?.steps ?? []).find((s) => s.name === step);

    expect(found, `${workflow} › ${job} › ${step} not found — renamed?`).toBeDefined();

    const condition = String((found as { if?: unknown }).if ?? '');
    // `cancelled()`, `always()` or `failure()` — any of them suppresses the implicit `success()`.
    expect(condition, `condition was: ${condition || '(none)'}`).toMatch(/cancelled\(\)|always\(\)|failure\(\)/);
  });

  it('leaves the verification step free to fail without stopping the job', () => {
    // The other half. Without `continue-on-error` the job stops at that step whatever the conditions below
    // say, and the pull request is never opened.
    const parsed = parse(readFileSync(join(workflowDir, 'publish.yml'), 'utf8')) as Workflow;
    const verify = (parsed.jobs?.['record-version']?.steps ?? []).find(
      (s) => s.name === 'Check the invariant this change exists to satisfy',
    );

    expect((verify as { 'continue-on-error'?: unknown })?.['continue-on-error']).toBe(true);
  });
});

describe('embedded workflow shell scripts', () => {
  const scripts = collectScripts();

  it('finds the scripts to check', () => {
    // Without this the suite would pass by finding nothing — after a rename of the workflow directory, or
    // a parser change that silently returned no jobs.
    expect(scripts.length).toBeGreaterThan(10);
  });

  it('covers the jobs that only ever run on a release', () => {
    // The specific reason this file exists. None of these run on a pull request, so their scripts are never
    // executed by the checks that gate a merge — the first time they run is during a release. Naming them
    // means a rename or a split cannot quietly drop one from coverage.
    const jobs = new Set(scripts.map((s) => s.job));

    expect([...jobs]).toEqual(
      expect.arrayContaining(['publish', 'verify-published', 'record-version']),
    );
  });

  it('states which scripts it does not check, rather than skipping them silently', () => {
    // `bash -n` cannot check PowerShell, and `pwsh` is not present on every machine that runs this suite.
    // Pinning the exact list is what keeps the gap honest: a bash script that silently acquired a
    // `shell: pwsh` — or a new Windows job — would drop out of coverage without this failing.
    const unchecked = scripts
      .filter((s) => s.shell !== 'bash' && s.shell !== 'sh')
      .map((s) => `${s.file} › ${s.job} › ${s.step} (${s.shell})`);

    expect(unchecked).toEqual([
      'ci.yml › windows-smoke › Install dependencies (pwsh)',
      'ci.yml › windows-smoke › Consumer shapes against a packed tarball (pwsh)',
    ]);
  });

  it('parses every bash script', () => {
    const bash = scripts.filter((s) => s.shell === 'bash' || s.shell === 'sh');
    expect(bash.length).toBeGreaterThan(10);

    const dir = mkdtempSync(join(tmpdir(), 'ps-workflow-'));
    const broken: string[] = [];

    for (const [index, entry] of bash.entries()) {
      const path = join(dir, `script-${index}.sh`);
      writeFileSync(path, entry.script);
      const check = spawnSync('bash', ['-n', path], { encoding: 'utf8' });

      if (check.status !== 0) {
        broken.push(
          `${entry.file} › ${entry.job} › ${entry.step}\n${check.stderr.replaceAll(path, '<script>').trim()}`,
        );
      }
    }
    rmSync(dir, { recursive: true, force: true });

    expect(broken).toEqual([]);
  });
});
