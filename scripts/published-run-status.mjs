import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkPublishedRun({ repo, pr, sha, runId, api, report }) {
  if (!/^[1-9]\d*$/.test(String(runId ?? ''))) {
    report('The version record has no valid publishing run.');
    return false;
  }
  const path = `repos/${repo}/actions/runs/${runId}`;
  const run = await api(path);
  const eligible = (candidate) => candidate.name === 'Publish' &&
    candidate.path === '.github/workflows/publish.yml' && candidate.repository?.full_name === repo &&
    candidate.status === 'completed';
  if (!eligible(run)) return false;
  if (run.conclusion === 'success') return true;

  report(`The publishing run for #${pr} has not passed: https://github.com/${repo}/actions/runs/${runId}`);
  if (run.conclusion !== 'failure') return false;
  if (run.run_attempt !== 1) {
    report('The automatic verification retry is exhausted; a maintainer must investigate.');
    return false;
  }

  const { jobs, total_count: count } = await api(`${path}/jobs?filter=latest&per_page=100`);
  if (count !== jobs.length) return false;
  const failures = jobs.filter((job) => job.conclusion === 'failure');
  const verification = failures[0];
  // Retrying failed jobs must never re-run publication or hide an assertion failure.
  if (failures.length !== 1 || verification.name !== 'Verify the published tarball' ||
      !jobs.some((job) => job.name === 'Publish to npm' && job.conclusion === 'success') ||
      jobs.some((job) => !['success', 'skipped', 'failure'].includes(job.conclusion)) ||
      !verification.steps.some((step) => step.name === 'Fetch the published package' && step.conclusion === 'failure') ||
      !verification.steps.some((step) => step.name === 'Canary — the PUBLISHED tarball blocks the exploit' && step.conclusion === 'skipped') ||
      verification.steps.some((step) => step.conclusion === 'failure' && step.name !== 'Fetch the published package')) {
    return false;
  }

  const current = await api(`repos/${repo}/pulls/${pr}`);
  const fresh = await api(path);
  if (current.state !== 'open' || current.head?.sha !== sha || !eligible(fresh) ||
      fresh.conclusion !== 'failure' || fresh.run_attempt !== 1) {
    report('The proposal or publishing run changed; no retry requested.');
    return false;
  }
  await api(`${path}/rerun-failed-jobs`, 'POST');
  report('Requested the one automatic retry after the package-fetch failure. Verification and CI must still pass before merging.');
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
    const ready = await checkPublishedRun({
      repo: process.env.REPO, pr: process.env.PR, sha: process.env.PR_SHA,
      runId: process.env.PUBLISH_RUN, api, report,
    });
    process.exitCode = ready ? 0 : 3;
  } catch (error) {
    report(`Could not assess published-package verification: ${error.message}`);
    process.exitCode = 1;
  }
}
