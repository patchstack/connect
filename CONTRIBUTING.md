# Contributing to @patchstack/connect

## Prerequisites

- Node.js ≥ 18
- npm ≥ 9

## Setup

```bash
git clone https://github.com/patchstack/connect.git
cd connect
npm install
```

## Development workflow

```bash
npm run typecheck   # type-check without emitting
npm test            # run the full test suite
npm run build       # compile to dist/
```

Keep `npm run typecheck` passing at all times. The CI workflow enforces it on every PR.

## Making changes

1. Fork the repo and create a branch from `main`.
2. Write or update tests for any behaviour change.
3. Make sure `npm run typecheck && npm test && npm run build` all pass locally.
4. Open a pull request against `main`. One approving review is required before merge.

## Commit style

Use short imperative subject lines (`Add yarn.lock parser`, `Fix timeout default`). No ticket prefix required.

## Reporting bugs

Open an issue at <https://github.com/patchstack/connect/issues> with:
- Node and npm versions (`node -v && npm -v`)
- The lockfile type in use (npm, pnpm, yarn, bun)
- Steps to reproduce
- Expected vs actual behaviour

For security vulnerabilities see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
