# Security Policy

## Supported versions

Only the latest published version of `@patchstack/connect` on npm receives security fixes.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report them privately via GitHub's built-in security advisory feature:
<https://github.com/patchstack/connect/security/advisories/new>

Alternatively, email **security@patchstack.com** with:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Any suggested mitigations you have in mind

We aim to acknowledge reports within **2 business days** and to provide a resolution timeline within **7 business days**.

## Scope

This package runs as a dev-time CLI and library inside a user's own project. It sends only package names and versions to the Patchstack API — no source code, environment variables, or file paths. Findings of interest include:

- Credential or token leakage from the scan payload
- Supply-chain issues (typosquatting, dependency confusion)
- Remote code execution triggered by a crafted lockfile
- Insecure defaults that expose the site UUID

Out of scope: vulnerabilities in third-party lockfile formats themselves, or issues that require physical access to the developer's machine.
