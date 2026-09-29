import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM workflow helper
import { checkPublishedRun } from '../scripts/published-run-status.mjs';

function fixture() {
  const repo = 'example/connect';
  const path = `repos/${repo}/actions/runs/77`;
  const run = {
    name: 'Publish', path: '.github/workflows/publish.yml', repository: { full_name: repo },
    status: 'completed', conclusion: 'failure', run_attempt: 1,
  };
  const jobs = [
    { name: 'Publish to npm', conclusion: 'success', steps: [] },
    { name: 'Verify the published tarball', conclusion: 'failure', steps: [
      { name: 'Fetch the published package', conclusion: 'failure' },
      { name: 'Canary — the PUBLISHED tarball blocks the exploit', conclusion: 'skipped' },
    ] },
    { name: 'Record the published version on main', conclusion: 'success', steps: [] },
    { name: 'Notify configured release consumers', conclusion: 'skipped', steps: [] },
  ];
  const current = { state: 'open', head: { sha: 'current-head' } };
  const state = { run, fresh: run, current, jobs, count: jobs.length };
  let reads = 0;
  const api = vi.fn(async (url: string, method = 'GET') => {
    if (url === path && method === 'GET') return reads++ === 0 ? state.run : state.fresh;
    if (url === `${path}/jobs?filter=latest&per_page=100` && method === 'GET') return { jobs: state.jobs, total_count: state.count };
    if (url === `repos/${repo}/pulls/12` && method === 'GET') return state.current;
    if (url === `${path}/rerun-failed-jobs` && method === 'POST') return null;
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { state, path, input: { repo, pr: 12, sha: 'current-head', runId: '77', api, report: vi.fn() } };
}

describe('published verification retry', () => {
  it('retries only failed jobs once and still refuses to merge', async () => {
    const f = fixture();
    expect(await checkPublishedRun(f.input)).toBe(false);
    expect(f.input.api.mock.calls.filter((call) => call[1] === 'POST')).toEqual([
      [`${f.path}/rerun-failed-jobs`, 'POST'],
    ]);
    expect(f.input.report).toHaveBeenCalledWith(expect.stringContaining('one automatic retry'));
  });

  it('accepts a successful Publish run without requesting a retry', async () => {
    const f = fixture();
    f.state.run.conclusion = 'success';
    expect(await checkPublishedRun(f.input)).toBe(true);
    expect(f.input.api).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['workflow name', (f: ReturnType<typeof fixture>) => { f.state.run.name = 'Other workflow'; }],
    ['workflow path', (f: ReturnType<typeof fixture>) => { f.state.run.path = '.github/workflows/other.yml'; }],
    ['repository', (f: ReturnType<typeof fixture>) => { f.state.run.repository.full_name = 'other/connect'; }],
    ['running workflow', (f: ReturnType<typeof fixture>) => { f.state.run.status = 'in_progress'; }],
    ['cancelled workflow', (f: ReturnType<typeof fixture>) => { f.state.run.conclusion = 'cancelled'; }],
    ['second attempt', (f: ReturnType<typeof fixture>) => { f.state.run.run_attempt = 2; }],
    ['missing attempt', (f: ReturnType<typeof fixture>) => { f.state.run.run_attempt = 0; }],
    ['publication failure', (f: ReturnType<typeof fixture>) => { f.state.jobs[0].conclusion = 'failure'; }],
    ['publication skipped', (f: ReturnType<typeof fixture>) => { f.state.jobs[0].conclusion = 'skipped'; }],
    ['other failed job', (f: ReturnType<typeof fixture>) => { f.state.jobs[2].conclusion = 'failure'; }],
    ['cancelled job', (f: ReturnType<typeof fixture>) => { f.state.jobs[2].conclusion = 'cancelled'; }],
    ['other verification job', (f: ReturnType<typeof fixture>) => { f.state.jobs[1].name = 'Other job'; }],
    ['failed canary', (f: ReturnType<typeof fixture>) => { f.state.jobs[1].steps[1].conclusion = 'failure'; }],
    ['no fetch failure', (f: ReturnType<typeof fixture>) => { f.state.jobs[1].steps[0].conclusion = 'success'; }],
    ['other step failure', (f: ReturnType<typeof fixture>) => { f.state.jobs[1].steps.push({ name: 'Install dependencies', conclusion: 'failure' }); }],
    ['incomplete job list', (f: ReturnType<typeof fixture>) => { f.state.count++; }],
    ['changed PR', (f: ReturnType<typeof fixture>) => { f.state.current.head.sha = 'new-head'; }],
    ['closed PR', (f: ReturnType<typeof fixture>) => { f.state.current.state = 'closed'; }],
    ['retry already started', (f: ReturnType<typeof fixture>) => { f.state.fresh = { ...f.state.run, status: 'queued' }; }],
    ['attempt changed', (f: ReturnType<typeof fixture>) => { f.state.fresh = { ...f.state.run, run_attempt: 2 }; }],
  ])('does not retry or merge on %s', async (_name, change) => {
    const f = fixture();
    change(f);
    expect(await checkPublishedRun(f.input)).toBe(false);
    expect(f.input.api.mock.calls.filter((call) => call[1] === 'POST')).toEqual([]);
  });

  it.each(['', '0', '../77', '77\n'])('rejects an invalid run id %j before calling the API', async (runId) => {
    const f = fixture();
    f.input.runId = runId;
    expect(await checkPublishedRun(f.input)).toBe(false);
    expect(f.input.api).not.toHaveBeenCalled();
  });

  it('propagates API failures instead of allowing a merge', async () => {
    const f = fixture();
    f.input.api.mockRejectedValueOnce(new Error('API unavailable'));
    await expect(checkPublishedRun(f.input)).rejects.toThrow('API unavailable');
  });
});
