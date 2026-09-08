import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script, no declarations
import {
  describeUnexpectedChange,
  recordPublishedVersion,
  temporaryRef,
  EXPECTED_CHANGED_LINES,
} from '../scripts/record-published-version.mjs';

/**
 * The sequence that opens the version-record pull request.
 *
 * What is being defended is an ORDER, not a result. The commit has to be staged somewhere else, checked
 * while only that staging ref exists, and then moved onto the pull request branch in one lease-protected
 * step — so that anything going wrong leaves the branch exactly as it was. None of that is visible from
 * the outside, which is why these tests assert the calls rather than the outcome.
 *
 * The failure it replaced: a commit made with the git CLI and `GITHUB_TOKEN` cannot be signed, and the
 * default branch requires signatures, so every pull request this workflow opened was unmergeable and
 * said nothing about why.
 */

const MAIN = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NEW = 'c'.repeat(40);

const patchFor = (from: string, to: string, times: number) =>
  Array.from({ length: times }, () => `-  "version": "${from}",\n+  "version": "${to}",`).join('\n');

/** A compare result that is exactly the version change, as the real one is when nothing is wrong. */
const cleanCompare = (from = '1.0.0', to = '1.0.1') => [
  { filename: 'package.json', patch: patchFor(from, to, EXPECTED_CHANGED_LINES['package.json']) },
  {
    filename: 'package-lock.json',
    patch: patchFor(from, to, EXPECTED_CHANGED_LINES['package-lock.json']),
  },
];

function fakeApi(overrides: Record<string, unknown> = {}, refs: Record<string, string> = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
  };

  const api = {
    calls,
    refs,
    ref: async (name: string) => {
      calls.push({ op: 'ref', args: [name] });

      return refs[name] ?? null;
    },
    createRef: async (name: string, oid: string) => {
      calls.push({ op: 'createRef', args: [name, oid] });
      refs[name] = oid;
    },
    updateRef: async (name: string, before: string | null, after: string) => {
      calls.push({ op: 'updateRef', args: [name, before, after] });
      refs[name] = after;
    },
    deleteRef: async (name: string) => {
      calls.push({ op: 'deleteRef', args: [name] });
      delete refs[name];
    },
    commit: async (input: Record<string, unknown>) => {
      calls.push({ op: 'commit', args: [input] });

      return { oid: NEW, verified: true, parents: [MAIN] };
    },
    compare: async (base: string, head: string) => {
      calls.push({ op: 'compare', args: [base, head] });

      return cleanCompare();
    },
    ...overrides,
  };
  // Overrides declared above lose the call recording, so re-wrap them.
  for (const key of Object.keys(overrides)) {
    const fn = (overrides as Record<string, (...a: unknown[]) => unknown>)[key];
    if (typeof fn !== 'function') continue;
    (api as Record<string, unknown>)[key] = async (...args: unknown[]) => {
      record(key)(...args);

      return fn(...args);
    };
  }

  return api;
}

const run = (api: unknown, extra: Record<string, unknown> = {}) =>
  recordPublishedVersion({
    api,
    branchRef: 'refs/heads/chore/record-published-version',
    mainOid: MAIN,
    version: '1.0.1',
    previousVersion: '1.0.0',
    files: [
      { path: 'package.json', contents: '{"version":"1.0.1"}' },
      { path: 'package-lock.json', contents: '{"version":"1.0.1"}' },
    ],
    runId: '77-1',
    ...extra,
  });

const ops = (api: { calls: Array<{ op: string }> }) => api.calls.map((call) => call.op);

describe('the staging sequence', () => {
  it('moves an existing branch straight onto the signed commit', async () => {
    const api = fakeApi({}, { 'refs/heads/chore/record-published-version': OLD });

    const result = await run(api);

    expect(result).toEqual({ oid: NEW, branchExisted: true });
    // Read, stage, commit, check, move, clean up — in that order.
    expect(ops(api)).toEqual([
      'ref',
      'createRef',
      'commit',
      'compare',
      'updateRef',
      'deleteRef',
    ]);
    // The move is leased on where the branch actually was.
    expect(api.calls.find((c) => c.op === 'updateRef')!.args).toEqual([
      'refs/heads/chore/record-published-version',
      OLD,
      NEW,
    ]);
  });

  it('creates the branch when it does not exist yet', async () => {
    // The first release after this lands has no branch to move, and a lease against a branch that is
    // absent is not a lease — it is a refusal.
    const api = fakeApi();

    const result = await run(api);

    expect(result).toEqual({ oid: NEW, branchExisted: false });
    expect(ops(api)).not.toContain('updateRef');
    const created = api.calls.filter((c) => c.op === 'createRef').map((c) => c.args);
    expect(created).toEqual([
      [temporaryRef('77-1'), MAIN],
      ['refs/heads/chore/record-published-version', NEW],
    ]);
  });

  it('never points the pull request branch at main, even for an instant', async () => {
    // Reset to its own base, a pull request has no commits and GitHub closes it. Every write to the
    // branch must therefore name the new commit, never the base it was staged from.
    for (const refs of [{}, { 'refs/heads/chore/record-published-version': OLD }]) {
      const api = fakeApi({}, refs);
      await run(api);

      const writes = api.calls.filter(
        (c) =>
          (c.op === 'createRef' || c.op === 'updateRef') &&
          c.args[0] === 'refs/heads/chore/record-published-version',
      );
      expect(writes).not.toHaveLength(0);
      for (const write of writes) {
        expect(write.args.at(-1)).toBe(NEW);
        expect(write.args).not.toContain(MAIN);
      }
    }
  });

  it('stages on a ref no other run can be using', () => {
    expect(temporaryRef('77-1')).not.toBe(temporaryRef('77-2'));
    expect(temporaryRef('77-1')).toContain('77-1');
    // A run id is required: a fixed staging name would let two runs write each other's commit.
    expect(() => temporaryRef('')).toThrow(/run id/);
    expect(() => temporaryRef('../main')).toThrow(/run id/);
  });
});

describe('what stops the branch being touched', () => {
  const leaves = async (api: unknown, matching: RegExp) => {
    await expect(run(api)).rejects.toThrow(matching);
    const calls = (api as { calls: Array<{ op: string; args: unknown[] }> }).calls;
    // The branch is untouched...
    expect(
      calls.filter(
        (c) =>
          (c.op === 'updateRef' || c.op === 'createRef') &&
          c.args[0] === 'refs/heads/chore/record-published-version',
      ),
    ).toHaveLength(0);
    // ...and the staging ref is not left behind.
    expect(calls.filter((c) => c.op === 'deleteRef').map((c) => c.args[0])).toEqual([
      temporaryRef('77-1'),
    ]);
  };

  it('refuses a commit GitHub did not sign', async () => {
    // The whole reason this script exists. An unsigned commit cannot merge into a branch that requires
    // signatures, and a pull request carrying one looks ready and is not.
    await leaves(
      fakeApi(
        { commit: async () => ({ oid: NEW, verified: false, parents: [MAIN] }) },
        { 'refs/heads/chore/record-published-version': OLD },
      ),
      /not verified/,
    );
  });

  it('refuses a commit staged on something other than the main it was told', async () => {
    await leaves(
      fakeApi(
        { commit: async () => ({ oid: NEW, verified: true, parents: ['d'.repeat(40)] }) },
        { 'refs/heads/chore/record-published-version': OLD },
      ),
      /parent is/,
    );
  });

  it('refuses a commit that changed anything but the version', async () => {
    // The lockfile carries a version line for every dependency that happens to sit at the same number,
    // so a change beyond the package's own entries means something else was rewritten.
    await leaves(
      fakeApi(
        {
          compare: async () => [
            { filename: 'package.json', patch: patchFor('1.0.0', '1.0.1', 1) },
            { filename: 'package-lock.json', patch: patchFor('1.0.0', '1.0.1', 3) },
          ],
        },
        { 'refs/heads/chore/record-published-version': OLD },
      ),
      /changes more than the version/,
    );
  });

  it('reports an API failure instead of leaving the staging ref behind', async () => {
    await leaves(
      fakeApi(
        {
          commit: async () => {
            throw new Error('GitHub returned 502');
          },
        },
        { 'refs/heads/chore/record-published-version': OLD },
      ),
      /502/,
    );
  });

  it('surfaces a stale lease rather than forcing past it', async () => {
    // Another run moved the branch between the read and the move. The refusal comes from the API's own
    // compare-and-swap; this asserts it is not swallowed.
    const api = fakeApi(
      {
        updateRef: async () => {
          throw new Error('is at a different object than expected');
        },
      },
      { 'refs/heads/chore/record-published-version': OLD },
    );

    await expect(run(api)).rejects.toThrow(/different object/);
    // The staging ref is still cleaned up, even though the failure came after the checks.
    expect(api.calls.filter((c) => c.op === 'deleteRef').map((c) => c.args[0])).toEqual([
      temporaryRef('77-1'),
    ]);
  });

  it('does not fail the run because cleanup failed', async () => {
    // The commit is either moved or it is not, and that is settled before this runs. A staging ref that
    // could not be deleted is worth saying and not worth failing over.
    const api = fakeApi(
      {
        deleteRef: async () => {
          throw new Error('ref already gone');
        },
      },
      { 'refs/heads/chore/record-published-version': OLD },
    );
    const said: string[] = [];

    await expect(run(api, { log: (m: string) => said.push(m) })).resolves.toMatchObject({ oid: NEW });
    expect(said.join('\n')).toContain('could not remove');
  });
});

describe('the queries themselves', () => {
  // The tests above inject a fake API, so nothing in them reaches GitHub's schema. These pin the two
  // details of it that a plausible edit gets wrong and that no fake can reject.
  const source = readFileSync(new URL('../scripts/record-published-version.mjs', import.meta.url), 'utf8');

  it('names a ref update with the scalar the schema requires', () => {
    // `RefUpdate.name` is `GitRefname!`. Declared `String!` the mutation is refused outright, and the
    // only place that surfaces is a release.
    const mutation = source.slice(source.indexOf('updateRefs(input:') - 200, source.indexOf('updateRefs(input:'));
    expect(mutation).toContain('$ref:GitRefname!');
    expect(mutation).not.toContain('$ref:String!');
  });

  it('names the lease when a ref move is refused', () => {
    // GitHub answers a refused compare-and-swap with a generic query failure, which at release time
    // reads as an outage instead of as the branch having moved.
    const move = source.slice(source.indexOf('async updateRef('), source.indexOf('async deleteRef('));
    expect(move).toContain('no longer at');
    // And the original message survives, for when it is something else.
    expect(move).toContain('GitHub said:');
  });

  it('asks the commit for what it then checks', () => {
    // The verified/parent checks are only as good as the fields requested alongside the commit.
    const mutation = source.slice(source.indexOf('mutation($input: CreateCommitOnBranchInput!)'));
    expect(mutation).toContain('signature { isValid state }');
    expect(mutation).toContain('parents(first: 5)');
    expect(mutation).toContain('expectedHeadOid');
  });
});

describe('the version-only check', () => {
  it('accepts exactly the change npm version makes', () => {
    expect(describeUnexpectedChange(cleanCompare(), { from: '1.0.0', to: '1.0.1' })).toBeNull();
  });

  it.each([
    ['a file that should not be there', [...cleanCompare(), { filename: 'src/index.ts', patch: '' }]],
    ['a missing file', [cleanCompare()[0]]],
    [
      'a changed line that is not a version',
      [
        cleanCompare()[0],
        { filename: 'package-lock.json', patch: '-  "resolved": "a",\n+  "resolved": "b",' },
      ],
    ],
  ])('rejects %s', (_label, files) => {
    expect(describeUnexpectedChange(files as never, { from: '1.0.0', to: '1.0.1' })).not.toBeNull();
  });

  it('rejects a version that is not the one published', () => {
    // Guards the case where the files were generated for a different release than the tag being recorded.
    expect(describeUnexpectedChange(cleanCompare('1.0.0', '9.9.9'), { from: '1.0.0', to: '1.0.1' }))
      .toMatch(/expected 1\.0\.1/);
  });
});
