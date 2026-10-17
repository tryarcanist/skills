---
name: zeus-loop
description: Loop an Arcanist (Zeus) review on a pull request until it says Ready to merge. Use for "zeus loop", "loop Arcanist on this PR", "iterate until Arcanist is clean", or after pushing a PR you want reviewed and fixed before merge. Works with the arcanist CLI or with gh alone.
---

# Zeus loop

Review, fix, push, repeat until Arcanist says **Ready to merge** or the lap cap stops you.

`scripts/zeus-review.mjs` runs one review and prints one JSON object. It picks the backend on its own: the `arcanist` CLI when it is installed and logged in, else `gh` (it comments `@tryarcanist /review`, waits on the `Arcanist review` check, and reads the summary and inline threads). Pass `--backend gh` or `--backend cli` to force one. Needs `node` 22+ and an authenticated `gh`.

```bash
node <skill-dir>/scripts/zeus-review.mjs <pr-url|pr-number> [--repo owner/repo] [--app arcanist|arcanist-qa]
```

Exit 0 means no blocking finding, 1 means a blocking finding, 2 a tool error, 3 a timeout (30 min default). The JSON carries `headline`, `blocking`, and `findings[]` with `file`, `line`, `title`, `body`, `blocksMerge`, `threadId`.

## Loop

Keep a ledger across laps: finding title + file, and what you did about it. Cap: 5 laps.

1. **Review the current head.** Run the script. On exit 2 or 3, stop and report the stderr line.
2. **Done check.** `blocking: false` and no unresolved finding you still owe a reply: stop, report the headline and the head SHA.
3. **Dispose of every finding**, blocking or not, one at a time:
   - A real defect: fix it at the cause. Run the repo's own checks for the touched files.
   - A wrong or non-applicable finding: reply on the thread with the one-line reason and the evidence (a file and line, a command output). Resolve the thread.
   - A nit or a design note: apply it when it makes the code simpler, else reply with why not. Resolve the thread.

   Reply and resolve through `gh`: `gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:"<threadId>", body:"<text>"}) { comment { id } } }'` then `resolveReviewThread`. A finding with `threadId: null` has no thread; note it in the PR body instead.
4. **Repeat guard.** A finding whose title and file already sit in the ledger as fixed in an earlier lap: stop. Report that finding, your earlier fix commit, and Arcanist's new text. Someone must look.
5. **Commit and push** the fixes to the PR's head branch, one commit per lap, message `Fix Arcanist review findings (lap N)`. Then go to step 1. The new head starts a new review.
6. **Out of laps.** Report what is still open with file and line, and the last headline.

## Report

End with: final headline, head SHA, laps used, findings fixed (count and titles), findings declined (titles and reasons), anything left open.
