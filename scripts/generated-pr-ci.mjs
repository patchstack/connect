import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const passed = (check) => check.__typename === 'CheckRun'
  ? check.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion)
  : check.state === 'SUCCESS';

export async function checkGeneratedCi({ repo, pr, branch, workflow, proposal, api, report }) {
  const checks = proposal.statusCheckRollup ?? [];
  const blocked = checks.filter((check) => !passed(check));
  if (checks.length > 0 && blocked.length === 0) return true;
  report(`PR #${pr} is waiting for checks: ${blocked.map((check) =>
    `${check.name ?? check.context}: ${check.conclusion ?? check.state ?? check.status}`).join(', ') || 'no checks reported'}.`);

  // Retry interruptions, never failed assertions, and only once per workflow run.
  const interrupted = blocked.some((check) => ['CANCELLED', 'TIMED_OUT', 'STALE'].includes(check.conclusion));
  if (!interrupted || blocked.some((check) => check.conclusion === 'FAILURE' || check.state === 'FAILURE' || check.state === 'ERROR')) {
    return false;
  }
  const { workflow_runs: runs } = await api(
    `repos/${repo}/actions/workflows/${basename(workflow)}/runs?event=pull_request&head_sha=${proposal.headRefOid}&per_page=30`,
  );
  const eligible = (run) => run.event === 'pull_request' && run.path === workflow &&
    run.head_sha === proposal.headRefOid && run.head_branch === branch &&
    run.head_repository?.full_name === repo &&
    run.pull_requests?.some((pull) => pull.number === Number(pr));
  const matching = runs.filter(eligible).sort((a, b) => b.id - a.id);
  const run = matching[0];
  if (!run || run.status !== 'completed' || !['cancelled', 'timed_out'].includes(run.conclusion)) return false;
  if (run.run_attempt !== 1) {
    report(`PR #${pr}: automatic retry exhausted for run ${run.id}; a maintainer must investigate.`);
    return false;
  }
  const current = await api(`repos/${repo}/pulls/${pr}`);
  const fresh = await api(`repos/${repo}/actions/runs/${run.id}`);
  if (current.state !== 'open' || current.head?.sha !== proposal.headRefOid ||
      !eligible(fresh) || fresh.status !== 'completed' || fresh.run_attempt !== 1 ||
      !['cancelled', 'timed_out'].includes(fresh.conclusion)) {
    report(`PR #${pr}: state changed; no retry requested.`);
    return false;
  }
  await api(`repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`, 'POST');
  report(`PR #${pr}: requested the one automatic retry for interrupted CI run ${run.id}. Merging still requires passing checks.`);
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = (message) => {
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n\n');
  };
  const api = async (path, method = 'GET') => {
    const output = execFileSync('gh', ['api', '--method', method, path], { encoding: 'utf8' });
    return output.trim() ? JSON.parse(output) : null;
  };
  try {
    const ready = await checkGeneratedCi({
      repo: process.env.REPO, pr: process.env.PR, branch: process.env.BRANCH,
      workflow: process.env.CI_WORKFLOW, proposal: JSON.parse(process.env.PROPOSAL),
      api, report,
    });
    process.exitCode = ready ? 0 : 3;
  } catch (error) {
    report(`Could not assess generated-PR checks: ${error.message}`);
    process.exitCode = 1;
  }
}
