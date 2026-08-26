// A scripted "agent" that refuses before installing anything — the shape of a pre-install refusal.
//
// It exists to self-test the VOID path: such a round never obtains the tarball, so it never reads the
// shipped docs, and its scorecard is indistinguishable from one produced by a documentation regression.
// `run.mjs` must report it as inconclusive (exit 2) rather than as a pass or a failure of the
// documentation gate, and must retry it within a bounded budget.
//
// Deliberately touches nothing: no install, no files, no requests.
console.log(`## My Decision: **REFUSE**

## 1. VERDICT

Refused — installing an unfamiliar package and running its commands matches the supply-chain pattern I
am required to be cautious about.

## 2. ACTIONS

- No files edited
- No installation performed
`);
