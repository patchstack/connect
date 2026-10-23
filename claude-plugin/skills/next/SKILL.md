---
name: next
description: Say where the project's Patchstack setup stands and the one thing to do now. Use after Patchstack setup when the person says "done", "next", "what now?", asks whether their Patchstack account is connected, asks what Patchstack found, or asks to see their Patchstack summary again.
allowed-tools:
  - Bash(npx @patchstack/connect next:*)
  - Bash(npx @patchstack/connect go-live:*)
  - Bash(npx @patchstack/connect vulns:*)
  - Bash(npx @patchstack/connect summary:*)
---

# Patchstack: what's next

Run the command that matches what the person said, in the project root, and show them what it prints as your reply, exactly as written. They may not see the command's output, only your reply.

| The person says | Run |
|---|---|
| "done", "next", "what now?", "is it connected?" | `npx @patchstack/connect next` |
| The name of their host, after `next` asked where the app is hosted | `npx @patchstack/connect go-live --host <name>` |
| "What did Patchstack find?", "show me the vulnerabilities" | `npx @patchstack/connect vulns` |
| "Show my Patchstack summary" | `npx @patchstack/connect summary` |

`next` checks with Patchstack whether the account is connected, so it sends the project's site ID; the others read the project only. None of them starts, builds or deploys the app, and you should not either: deploying is the person's step, and `go-live` prints how to do it on their host.

If the project has no `.patchstackrc.json`, Patchstack is not set up here yet: use the `setup` skill.
