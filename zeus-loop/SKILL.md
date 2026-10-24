---
name: zeus-loop
description: Loop an Arcanist (Zeus) review on a pull request until it says Ready to merge. Use for "zeus loop", "loop Arcanist on this PR", "iterate until Arcanist is clean", or after pushing a PR you want reviewed and fixed before merge. Works with the arcanist CLI or with gh alone.
---

# Zeus loop

Review, fix, push, repeat until Arcanist says **Ready to merge** or the lap cap stops you.

The script `zeus-review.mjs` in this skill's `scripts` folder runs one review and prints one JSON object. It picks the backend on its own: the `arcanist` CLI when it is installed and logged in, else `gh` (it comments `@tryarcanist /review`, waits on the `Arcanist review` check, and reads the summary and inline threads). Pass `--backend gh` or `--backend cli` to force one. Needs `node` 22+ and an authenticated `gh`.

```bash
node <skill-dir>/scripts/zeus-review.mjs <pr-url|pr-number> [--repo owner/repo] [--app arcanist|arcanist-qa]
```

Exit 0 means no blocking finding, 1 means a blocking finding, 2 a tool error, 3 a timeout (30 min default). The JSON carries `headSha` (the reviewed commit), `headline`, `blocking`, and `findings[]` with `file`, `line`, `title`, `body`, `blocksMerge`, `threadId`.

Two flags change what "one review" means. `--no-trigger` waits for a review that is already running instead of asking for one: use it right after opening a PR, since Arcanist reviews every new PR on its own. `--any-head` accepts a completed review on an earlier commit of the PR, because a workspace can turn off `Review each push of new commits`; the result's `headSha` says which commit it read. With the trigger on, the script asks for a review only when the head has no `Arcanist review` check yet. A queued or running review is waited on, never requested twice.

## When to ask for a review

Arcanist reviews a new PR on its own. Whether it reviews later pushes is the workspace switch `Review each push of new commits`. The loop does not rely on that switch: before each push, decide whether the new head needs a review, and ask only then. A review costs a full lap of model time, so fold every fix of a lap into one push and ask once, after it.

Ask for a review when the push can change the verdict:

- it fixes a blocking finding (every lap of this loop)
- it changes runtime code, a schema or migration, a prompt, a dependency, or a config value that ships
- it resolved a merge conflict by hand
- it weakens or deletes a test assertion

Skip the review when the push leaves the reviewed behavior in place:

- a test, typecheck, lint, or format fix for a red check, with no runtime change
- comments, docs, the PR body, or a commit message
- a rebase or restack with the same tree
- a change the last review itself asked for under a `Ready to merge` headline

A skipped push merges on the last verdict. The report names both commits, the reviewed head and the merged head, with the one-line reason for the skip.

## Loop

Keep a ledger across laps: finding title + file, and what you did about it. Cap: 5 laps.

One writer per branch. While the loop runs, nothing else may push to the PR branch. An agent with its own PR monitor turns it off first: Devin ticks `Disable automatic comment, CI, and merge conflict monitoring` on its PR comment before lap 1. Two writers race, and a push after **Ready to merge** lands unreviewed.

1. **Review the current head.** On the first lap of a PR Arcanist just reviewed on its own, add `--no-trigger --any-head`. Every later lap runs plain. On exit 2 or 3, stop and report the stderr line.
2. **Done check.** `blocking: false` and no unresolved finding you still owe a reply: stop, report the headline and the head SHA.
   **Merge, when asked.** Arm auto-merge only when the person or the playbook that started the loop said to merge. Then, on a PR that is not a draft: `gh pr merge <pr> --auto --squash`, and confirm with `gh pr view <pr> --json autoMergeRequest` (non-null). GitHub merges once the required checks pass. Report the arm in the final report.
3. **Dispose of every finding**, blocking or not, one at a time:
   - A real defect: fix it at the cause. Run the repo's own checks for the touched files.
   - A wrong or non-applicable finding: reply on the thread with the one-line reason and the evidence (a file and line, a command output). Resolve the thread.
   - A nit or a design note: apply it when it makes the code simpler, else reply with why not. Resolve the thread.

   Reply and resolve through `gh`: `gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:"<threadId>", body:"<text>"}) { comment { id } } }'` then `resolveReviewThread`. A finding with `threadId: null` has no thread; note it in the PR body instead.
4. **Repeat guard.** A finding whose title and file already sit in the ledger as fixed in an earlier lap: stop. Report that finding, your earlier fix commit, and Arcanist's new text. Someone must look.
5. **Commit and push** the fixes to the PR's head branch, one commit per lap, message `Fix Arcanist review findings (lap N)`. Then go to step 1: a fix for a blocking finding always gets a review, and the script asks for one when the workspace did not start it on the push.
6. **Out of laps.** Report what is still open with file and line, and the last headline.

## Report

End with: final headline, reviewed head SHA (and the merged head with the skip reason when they differ), laps used, findings fixed (count and titles), findings declined (titles and reasons), anything left open.
