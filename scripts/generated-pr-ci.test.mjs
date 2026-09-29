import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGeneratedCi } from './generated-pr-ci.mjs';

const sha = 'a'.repeat(40);
function fixture() {
  const run = {
    id: 12, event: 'pull_request', path: '.github/workflows/ci.yml', head_sha: sha,
    head_branch: 'chore/generated', head_repository: { full_name: 'example/package' },
    pull_requests: [{ number: 7 }], status: 'completed', conclusion: 'cancelled', run_attempt: 1,
  };
  const calls = [];
  const messages = [];
  const options = {
    repo: 'example/package', pr: 7, branch: run.head_branch, workflow: run.path,
    proposal: { headRefOid: sha, statusCheckRollup: [
      { __typename: 'CheckRun', name: 'Tests', status: 'COMPLETED', conclusion: 'CANCELLED' },
    ] },
    api: async (path, method = 'GET') => {
      calls.push({ path, method });
      if (path.includes('/workflows/')) return { workflow_runs: [run] };
      if (path.endsWith('/pulls/7')) return { state: 'open', head: { sha } };
      if (path.endsWith('/runs/12')) return { ...run };
      if (method === 'POST') return null;
      throw new Error('Unexpected request: ' + path);
    },
    report: (message) => messages.push(message),
  };
  return { run, options, calls, messages };
}
test('passing checks need no API calls', async () => {
  const f = fixture();
  f.options.proposal.statusCheckRollup[0].conclusion = 'SUCCESS';
  assert.equal(await checkGeneratedCi(f.options), true);
  assert.equal(f.calls.length, 0);
});
test('no checks is not success', async () => {
  const f = fixture();
  f.options.proposal.statusCheckRollup = [];
  assert.equal(await checkGeneratedCi(f.options), false);
  assert.equal(f.calls.length, 0);
});
test('interrupted trusted CI is retried once without making the PR mergeable', async () => {
  const f = fixture();
  assert.equal(await checkGeneratedCi(f.options), false);
  assert.deepEqual(f.calls.filter((call) => call.method === 'POST'),
    [{ path: 'repos/example/package/actions/runs/12/rerun-failed-jobs', method: 'POST' }]);
});
for (const [field, value] of [
  ['event', 'push'], ['path', '.github/workflows/another.yml'], ['head_sha', 'b'.repeat(40)],
  ['head_branch', 'other'], ['head_repository', { full_name: 'other/package' }],
  ['pull_requests', []], ['run_attempt', 2], ['run_attempt', undefined],
  ['status', 'in_progress'], ['conclusion', 'failure'],
]) {
  test('does not retry a run with mismatched ' + field, async () => {
    const f = fixture();
    f.run[field] = value;
    assert.equal(await checkGeneratedCi(f.options), false);
    assert.equal(f.calls.some((call) => call.method === 'POST'), false);
  });
}
test('failed assertions are not retried even beside an interruption', async () => {
  const f = fixture();
  f.options.proposal.statusCheckRollup.push({ __typename: 'CheckRun', name: 'Lint', status: 'COMPLETED', conclusion: 'FAILURE' });
  assert.equal(await checkGeneratedCi(f.options), false);
  assert.equal(f.calls.length, 0);
});
test('a newer queued attempt prevents retrying an older cancelled run', async () => {
  const f = fixture();
  const api = f.options.api;
  f.options.api = async (path, method) => path.includes('/workflows/')
    ? { workflow_runs: [f.run, { ...f.run, id: 13, status: 'queued' }] } : api(path, method);
  await checkGeneratedCi(f.options);
  assert.equal(f.calls.some((call) => call.method === 'POST'), false);
});
test('a moved PR head prevents retrying stale CI', async () => {
  const f = fixture();
  const api = f.options.api;
  f.options.api = async (path, method) => path.endsWith('/pulls/7')
    ? { state: 'open', head: { sha: 'b'.repeat(40) } } : api(path, method);
  await checkGeneratedCi(f.options);
  assert.equal(f.calls.some((call) => call.method === 'POST'), false);
});
test('a concurrent retry is detected before requesting another', async () => {
  const f = fixture();
  const api = f.options.api;
  f.options.api = async (path, method) => path.endsWith('/runs/12')
    ? { ...f.run, run_attempt: 2 } : api(path, method);
  await checkGeneratedCi(f.options);
  assert.equal(f.calls.some((call) => call.method === 'POST'), false);
});
test('API failures remain failures, not success or permission to merge', async () => {
  const f = fixture();
  f.options.api = async () => { throw new Error('Unavailable'); };
  await assert.rejects(checkGeneratedCi(f.options), /Unavailable/);
});
