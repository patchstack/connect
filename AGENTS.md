# Agent instructions for `@patchstack/connect`

Applies to every agent and automation working in this repository, whichever tool it runs under.
`CLAUDE.md` carries the same boundary plus Claude-specific working notes; this file exists so the rule
does not depend on which agent is reading.

## Public repository boundary

This repository, its Git history, code comments, test output, issue content, commit messages, and
pull-request titles and descriptions must be treated as public.

Do not include information copied or inferred from private Patchstack systems unless it is already
documented in this repository's public documentation or public API contract.

This includes:

- private repository names, paths, branches, pull requests, or source code;
- internal service topology, database schemas, queues, credentials, endpoints, deployment details, or
  operational runbooks;
- customer, production, incident, or vulnerability-review data;
- private reachability recipes, vPatch corpora, detection research, or rule-authoring rationale;
- local filesystem paths, developer usernames, tokens, environment values, or private ticket contents.

Use public product terminology such as "Patchstack SaaS," "Patchstack API," or "rules service." Describe
only the public contract Connect depends on — not how private systems implement it.

Code comments must explain the current invariant or externally observable behavior. Historical
investigation, review conversations, mutation notes, internal implementation details, and "how we found
this" belong in private engineering records, not source comments or public pull requests.

Fixtures must be synthetic or explicitly public. Never copy fixtures or implementation details from a
private repository merely to make a test realistic.

Do not commit third-party confidential or proprietary material, including copied system prompts, private
evaluation transcripts, unpublished documentation, or customer-provided integration details. Public
availability elsewhere must be verified rather than assumed. Use synthetic fixtures unless the material is
explicitly public and its license permits redistribution.

This is a separate obligation from the one above, not a special case of it. Material can be entirely free
of Patchstack internals and still be someone else's to publish — so a change can satisfy every rule above
and still be a disclosure.

Before committing or opening a pull request, inspect the complete staged diff, commit message, generated
files, test output, and proposed PR description for public-boundary violations. If completing a task
appears to require publishing private context, stop and ask for a public-safe abstraction.

This is guidance, not enforcement. Secret scanning catches credentials; nothing catches a paragraph of
architecture, so the review above is the only control that covers it.

## Where the rest of the guidance lives

- `CLAUDE.md` — commands, the tested install prompt, comment and explanation style, releasing.
- `MAINTAINING.md` — which onboarding and setup files are load-bearing, and how to change one safely.
- `RELEASING.md` — how a version is cut and published.
- `field-test/README.md` — the agent harness, its scoring contract, and why its personas are synthetic.
