// The exact lowest Node version `engines.node` admits, for CI to install and test the claim on.
//
// A hard-coded version in the workflow is not bound to the claim: raise the floor and the job keeps
// testing the old one, lower it and the job tests above the new one. Deriving it means the claim and the
// runtime it is tested on cannot drift apart — moving `engines.node` moves this job.
//
// Only `>=` with one to three components is read, because that is the shape of a floor. Anything else —
// a caret, a range with an upper bound, a disjunction — is refused rather than guessed at: guessing
// would put a number in front of CI that nobody stated, and a green job on the wrong runtime is worse
// than a red one that says why.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifest = path.join(process.cwd(), 'package.json');
const declared = JSON.parse(readFileSync(manifest, 'utf8')).engines?.node;

export function floorOf(range) {
  if (typeof range !== 'string') throw new Error('engines.node is not declared');
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!match) {
    throw new Error(
      `engines.node is "${range}", which is not a plain \`>=\` floor. ` +
        'Either express it as one, or decide deliberately which version CI should test the claim on.',
    );
  }
  const [, major, minor = '0', patch = '0'] = match;

  return `${major}.${minor}.${patch}`;
}

// `fileURLToPath`, not `new URL(...).pathname`: the pathname keeps a path's spaces percent-encoded, so
// the comparison fails and this prints nothing while exiting 0 — a value the caller then reads as empty.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${floorOf(declared)}\n`);
}
