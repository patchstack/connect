#!/usr/bin/env node
// Opens the pull request that brings the repository's recorded version in line with what was published.
//
// The tag is what gets published; this makes a checkout agree with it, so a git installation, an SBOM
// built from a checkout, `npm pack` and `patchstack-connect --version` all report the released version.
//
// Every commit on the default branch must be signed. A commit made with the git CLI and `GITHUB_TOKEN`
// cannot be, so this goes through GraphQL `createCommitOnBranch`, whose commits GitHub signs itself.
// Nothing here generates the file contents: `npm version` does that before this runs, and it is the only
// thing that may. A version string appears in the lockfile for every dependency that happens to sit at
// the same number, so editing the text would rewrite a dependency's pin — and `npm version` is what
// knows the difference between the package's own version and a coincidence.
//
// The order is what keeps the pull request intact:
//
//   1. a unique temporary ref off the exact main OID
//   2. one commit on it, carrying both files
//   3. every check that must hold, BEFORE the pull request branch is touched at all
//   4. one lease-protected move of that branch straight onto the signed commit
//
// The branch is never pointed at main on the way. Reset to its own base a pull request has no commits
// and GitHub closes it, and a workflow that reopened it afterwards would be repairing damage it caused.
//
// Usage:
//   node scripts/record-published-version.mjs --version 1.2.3 --main <oid> --run-id <id> [--dry-run]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The files `npm version` writes, and the only ones this may commit. */
export const RECORDED_FILES = Object.freeze(['package.json', 'package-lock.json']);

/**
 * How many lines the version change may touch, per file.
 *
 * `package.json` carries the version once. The lockfile carries it twice — at the root and under the
 * root package entry — and `npm version` updates exactly those. A third changed line means something
 * else moved, which is the failure this bound exists to catch.
 */
export const EXPECTED_CHANGED_LINES = Object.freeze({ 'package.json': 1, 'package-lock.json': 2 });

const VERSION_LINE = /^[+-]\s*"version": "(\d+\.\d+\.\d+[^"]*)",?$/;

/** A branch name no other run can be using, so two runs cannot share a staging ref. */
export function temporaryRef(runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(runId ?? ''))) {
    throw new Error('a run id is required to name the temporary ref');
  }

  return `refs/heads/chore/record-published-version-staging-${runId}`;
}

/**
 * Whether a compare result is only the version change, and nothing else.
 *
 * Checked against what the API actually committed rather than against what was sent: the point is to
 * know what the pull request would carry, and the two are only the same thing while nothing is wrong.
 *
 * @param {Array<{filename: string, patch?: string}>} files
 * @param {{from: string, to: string}} versions
 */
export function describeUnexpectedChange(files, versions) {
  const names = files.map((file) => file.filename).sort();
  const expected = [...RECORDED_FILES].sort();
  if (names.length !== expected.length || names.some((name, i) => name !== expected[i])) {
    return `expected ${expected.join(' and ')} to change, got ${names.join(', ') || 'nothing'}`;
  }

  for (const file of files) {
    const changed = (file.patch ?? '')
      .split('\n')
      .filter((line) => /^[+-][^+-]/.test(line) || /^[+-]\s*"/.test(line));

    const allowed = EXPECTED_CHANGED_LINES[file.filename] * 2; // one removal and one addition each
    if (changed.length !== allowed) {
      return `${file.filename}: expected ${allowed} changed lines, got ${changed.length}`;
    }

    for (const line of changed) {
      const match = VERSION_LINE.exec(line.trim());
      if (match === null) {
        return `${file.filename}: changed a line that is not a version — ${line.trim()}`;
      }

      const want = line.startsWith('+') ? versions.to : versions.from;
      if (match[1] !== want) {
        return `${file.filename}: expected ${want} on a ${line[0]} line, got ${match[1]}`;
      }
    }
  }

  return null;
}

/**
 * Stage the commit, check it, and move the branch onto it.
 *
 * The API is injected so the sequence can be exercised without a repository: what matters here is the
 * ORDER of the calls and which of them are reached when a check fails, and that is not observable from
 * the outside.
 *
 * @param {{
 *   api: {
 *     ref(name: string): Promise<string | null>,
 *     createRef(name: string, oid: string): Promise<void>,
 *     updateRef(name: string, beforeOid: string | null, afterOid: string): Promise<void>,
 *     deleteRef(name: string): Promise<void>,
 *     commit(input: { branchRef: string, expectedHeadOid: string, message: object, files: Array<{path: string, contents: string}> }): Promise<{ oid: string, verified: boolean, parents: string[] }>,
 *     compare(baseOid: string, headOid: string): Promise<Array<{ filename: string, patch?: string }>>,
 *   },
 *   branchRef: string,
 *   mainOid: string,
 *   version: string,
 *   previousVersion: string,
 *   files: Array<{ path: string, contents: string }>,
 *   runId: string,
 *   log?: (message: string) => void,
 * }} input
 */
export async function recordPublishedVersion(input) {
  const { api, branchRef, mainOid, version, previousVersion, files, runId } = input;
  const log = input.log ?? (() => {});
  const stagingRef = temporaryRef(runId);

  // Read before anything is written. This is the lease: the branch has to still be where it was when
  // the move happens, or another run has been here and this one has nothing useful to say.
  const branchBefore = await api.ref(branchRef);
  log(branchBefore === null ? `${branchRef} does not exist yet` : `${branchRef} is at ${branchBefore}`);

  await api.createRef(stagingRef, mainOid);

  try {
    const commit = await api.commit({
      branchRef: stagingRef,
      expectedHeadOid: mainOid,
      message: {
        headline: `Record published version ${version}`,
        body: `Prepared automatically after publishing v${version}. Not auto-merged.`,
      },
      files,
    });

    // Everything below runs while only the staging ref exists. A failure here leaves the pull request
    // branch exactly as it was, which is the whole reason the commit is staged somewhere else first.
    if (commit.verified !== true) {
      throw new Error(
        `the commit GitHub returned is not verified (${commit.oid}). Refusing to move ${branchRef}: an ` +
          'unsigned commit cannot merge into a branch that requires signatures, and a pull request ' +
          'carrying one is worse than no pull request — it looks ready and is not.',
      );
    }

    if (commit.parents.length !== 1 || commit.parents[0] !== mainOid) {
      throw new Error(
        `the commit's parent is ${commit.parents.join(', ') || 'nothing'}, expected ${mainOid}. Staged on ` +
          'anything else, the diff is against a tree nobody reviewed.',
      );
    }

    const unexpected = describeUnexpectedChange(await api.compare(mainOid, commit.oid), {
      from: previousVersion,
      to: version,
    });
    if (unexpected !== null) {
      throw new Error(`the staged commit changes more than the version: ${unexpected}`);
    }

    log(`staged ${commit.oid}, verified, parented on main, version-only`);

    // One move, straight from where the branch was to the signed commit. Never by way of main: a branch
    // reset to its own base leaves the pull request with no commits and GitHub closes it.
    if (branchBefore === null) {
      await api.createRef(branchRef, commit.oid);
    } else {
      await api.updateRef(branchRef, branchBefore, commit.oid);
    }

    log(`${branchRef} now at ${commit.oid}`);

    return { oid: commit.oid, branchExisted: branchBefore !== null };
  } finally {
    // On both paths. A staging ref left behind is a branch nobody owns that the next run's uniqueness
    // check will not clean up either.
    try {
      await api.deleteRef(stagingRef);
      log(`removed ${stagingRef}`);
    } catch (error) {
      // Reported, never fatal: the commit is either moved or it is not, and that answer is already
      // settled by the time this runs.
      log(`could not remove ${stagingRef}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/** The GraphQL and REST calls, as the shape `recordPublishedVersion` expects. */
export function githubApi({ repository, token, fetchImpl = fetch }) {
  const [owner, name] = repository.split('/');

  const graphql = async (query, variables) => {
    const res = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    // A GraphQL error arrives with HTTP 200, so the status alone says nothing.
    if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);

    return body.data;
  };

  const rest = async (path) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      headers: { authorization: `bearer ${token}`, accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${path}`);

    return res.json();
  };

  let repositoryId = null;
  const id = async () => {
    repositoryId ??= (
      await graphql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}', {
        owner,
        name,
      })
    ).repository.id;

    return repositoryId;
  };

  return {
    async ref(refName) {
      const data = await graphql(
        'query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{oid}}}}',
        { owner, name, ref: refName },
      );

      return data.repository.ref?.target?.oid ?? null;
    },

    async createRef(refName, oid) {
      await graphql(
        'mutation($repo:ID!,$ref:String!,$oid:GitObjectID!){createRef(input:{repositoryId:$repo,name:$ref,oid:$oid}){clientMutationId}}',
        { repo: await id(), ref: refName, oid },
      );
    },

    async updateRef(refName, beforeOid, afterOid) {
      // `beforeOid` is the compare-and-swap: the update is refused if the branch moved since it was read.
      // `GitRefname!`, not `String!` — a ref update names its ref with its own scalar, and the mismatch
      // is rejected by the schema rather than coerced.
      try {
        await graphql(
          'mutation($repo:ID!,$ref:GitRefname!,$before:GitObjectID!,$after:GitObjectID!){updateRefs(input:{repositoryId:$repo,refUpdates:[{name:$ref,beforeOid:$before,afterOid:$after,force:true}]}){clientMutationId}}',
          { repo: await id(), ref: refName, before: beforeOid, after: afterOid },
        );
      } catch (error) {
        // A refused lease comes back as a generic query failure, which at release time reads as an
        // outage rather than as the one thing it usually is. The cause is named here; the original
        // message is kept, because if it is something else this is the only copy of it.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `could not move ${refName} from ${beforeOid} to ${afterOid}. The most likely cause is that ` +
            `${refName} is no longer at ${beforeOid} — another run moved it, and this one refused ` +
            `rather than overwrite it. GitHub said: ${detail}`,
        );
      }
    },

    async deleteRef(refName) {
      const data = await graphql(
        'query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){id}}}',
        { owner, name, ref: refName },
      );
      const refId = data.repository.ref?.id;
      if (!refId) return;

      await graphql('mutation($ref:ID!){deleteRef(input:{refId:$ref}){clientMutationId}}', { ref: refId });
    },

    async commit({ branchRef, expectedHeadOid, message, files }) {
      const data = await graphql(
        `mutation($input: CreateCommitOnBranchInput!) {
           createCommitOnBranch(input: $input) {
             commit { oid parents(first: 5) { nodes { oid } } signature { isValid state } }
           }
         }`,
        {
          input: {
            branch: { repositoryNameWithOwner: repository, branchName: branchRef },
            expectedHeadOid,
            message,
            fileChanges: {
              additions: files.map((file) => ({
                path: file.path,
                contents: Buffer.from(file.contents).toString('base64'),
              })),
            },
          },
        },
      );

      const commit = data.createCommitOnBranch.commit;

      return {
        oid: commit.oid,
        verified: commit.signature?.isValid === true && commit.signature?.state === 'VALID',
        parents: commit.parents.nodes.map((node) => node.oid),
      };
    },

    async compare(baseOid, headOid) {
      const data = await rest(`/compare/${baseOid}...${headOid}`);

      return (data.files ?? []).map((file) => ({ filename: file.filename, patch: file.patch }));
    },
  };
}

/* c8 ignore start -- the CLI wrapper; the sequence itself is covered above */
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (flag) => {
    const at = process.argv.indexOf(flag);

    return at === -1 ? undefined : process.argv[at + 1];
  };

  const version = arg('--version') ?? process.env.VERSION;
  const mainOid = arg('--main') ?? process.env.MAIN_OID;
  const previousVersion = arg('--previous') ?? process.env.PREVIOUS_VERSION;
  const runId = arg('--run-id') ?? process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const repository = process.env.GITHUB_REPOSITORY ?? 'patchstack/connect';
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const branchRef = `refs/heads/${process.env.BRANCH ?? 'chore/record-published-version'}`;

  for (const [flag, value] of [
    ['--version', version],
    ['--main', mainOid],
    ['--previous', previousVersion],
    ['--run-id', runId],
  ]) {
    if (!value) {
      console.error(`record-published-version: ${flag} is required`);
      process.exit(2);
    }
  }
  if (!token) {
    console.error('record-published-version: GH_TOKEN is required');
    process.exit(2);
  }

  const files = RECORDED_FILES.map((path) => ({
    path,
    contents: readFileSync(join(root, path), 'utf8'),
  }));

  try {
    const result = await recordPublishedVersion({
      api: githubApi({ repository, token }),
      branchRef,
      mainOid,
      version,
      previousVersion,
      files,
      runId: `${runId}-${attempt}`,
      log: (message) => console.log(message),
    });
    console.log(`commit=${result.oid}`);
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_OUTPUT, `commit=${result.oid}\n`);
    }
  } catch (error) {
    console.error(`record-published-version: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
/* c8 ignore stop */
