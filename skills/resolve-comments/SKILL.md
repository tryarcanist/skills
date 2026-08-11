---
name: resolve-comments
description: Resolve all actionable GitHub PR feedback when review threads or top-level comments need code fixes, replies, or tracked follow-ups.
user_invocable: true
argument: optional PR number, URL, or owner/repo#number; defaults to the PR for the current branch
---

# Resolve PR comments

Process every unresolved review comment and every actionable top-level PR conversation comment.

For each item: make a targeted code fix, reply explaining why no change is needed, or track the work and reply with the tracker link.

## When to use

- A human or bot left review feedback on a PR and you need it handled before merge.
- After Zeus (or another bot reviewer) posts findings, or after a short wait when automation should proceed with whatever feedback already exists.

Automation may invoke this skill once Zeus has responded, or after a 10-minute fallback window, whichever is first. In the fallback case, process whatever comments already exist; do not wait for more bot feedback.

## Prerequisites

- Authenticated `gh` with permission to read the PR, post replies, resolve threads, push to the PR branch, and add labels.
- Local git checkout that can fetch and push the PR branch.
- Optional: Linear MCP (or another issue tracker) for out-of-scope follow-ups. If no tracker is available, still do not dismiss valid out-of-scope feedback; open a GitHub issue in the same repo, or stop and ask the user how to track it.

## Step 1: Parse input and fetch PR context

Extract the PR number and owner/repo from input.

- No argument: use the PR for the current branch via `gh pr view --json number,headRefName,baseRefName,title,body,author,url`.
- Number only: infer owner/repo from `git remote -v` (prefer `origin`).
- URL or `owner/repo#N`: parse owner, repo, and number directly.

Run in parallel:

```bash
gh pr view <N> --repo <OWNER>/<REPO> --json title,body,headRefName,baseRefName,author,url
gh pr diff <N> --repo <OWNER>/<REPO>
gh api repos/<OWNER>/<REPO>/pulls/<N>/reviews
gh api repos/<OWNER>/<REPO>/issues/<N>/comments
gh api graphql -f query='
  query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            path
            comments(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes {
                databaseId
                url
                body
                author { login __typename }
                pullRequestReview { databaseId author { login } }
              }
            }
          }
        }
      }
    }
  }' -F owner=<OWNER> -F repo=<REPO> -F number=<N>
```

Inline review comments must come from the GraphQL `reviewThreads` query, not REST `pulls/<N>/comments`. The REST payload has no resolution state, so it cannot distinguish resolved from unresolved threads.

Paginate with `after` while `hasNextPage` is true. If a thread's nested `comments.pageInfo.hasNextPage` is true, fetch that thread's remaining comments before acting on it. Never treat a truncated thread as fully read.

## Step 2: Build the worklist

Build from both sources:

- **Review threads** from the GraphQL `reviewThreads` query, one work item per thread
- **Top-level PR conversation comments** from `issues/<N>/comments`

Skip only threads with `isResolved: true`. Do not skip a thread only because `isOutdated` is true: outdated marks a shifted diff context, not a handled concern. An unresolved outdated thread is still actionable.

For each remaining thread, keep its thread `id` and each comment's `databaseId` (the id the REST reply endpoint in Step 4 takes). Read the full thread before acting.

From top-level conversation comments, extract every actionable finding even when they are not review threads. Include sections such as `Comments Outside Diff`, `Issues found`, `P1` / `P2`, or other enumerated findings embedded in a single summary comment.

A review's own top-level **body** (from `pulls/<N>/reviews`) is usually a roll-up of that review's inline comments, not a separate actionable item. When a review has inline comments, answer those inline threads and do **not** echo body substance already covered by an inline thread in that same review. A review body can still carry standalone findings with **no** matching inline thread: extract and answer each such finding via the top-level reply path. Match inline comments to their parent review via the comment's `pullRequestReview.databaseId`, and let exact-duplicate dedupe collapse a body finding and its inline counterpart rather than answering it twice.

After extracting findings, dedupe exact duplicate feedback across all sources before deciding what to change. Exact duplicates are comments or findings with the same actionable text after trimming only leading/trailing whitespace. Do not dedupe comments that are merely similar, paraphrased, or overlapping.

Represent duplicate feedback as one work item with multiple source comments/threads. Address the concern once against the current PR head, then post a reply to (and resolve, for inline threads) every source comment/thread in the duplicate group. Do not make repeated or conflicting edits because multiple reviewers or bots posted the same feedback.

### Bot review comments

Process automated reviewers the same as human comments. Common sources:

- **Zeus / Arcanist review** (`arcanist[bot]`, `arcanist-dev[bot]`, `arcanist-staging[bot]`): verdict comments marked `<!-- arcanist-review -->`, and inline or body findings from the review. Process every finding. Ignore the pending placeholder (`<!-- arcanist-zeus-pending:v1 -->`); it is not a verdict.
- **ChatGPT Review** (`chatgpt-codex-connector[bot]`): inline review comments with P-level badges. Process each individually.
- **Graphite AI reviewer** (`graphite-app[bot]`): inline review comments, often with a `Suggested change` block. Extract the finding and ignore the boilerplate footer.

This list is illustrative, not exhaustive. Process every unresolved inline review comment and actionable top-level comment regardless of author, including bot reviewers not named here.

Do not assume "no work to do" only because review-thread APIs return no human comments. A PR can have zero review threads and still contain actionable bot feedback in top-level conversation comments.

Ignore:

- Resolved threads (an unresolved outdated thread is still actionable)
- Bot comments that are purely summary with no actionable finding (for example "Merge readiness: 5/5" with no findings)
- Purely positive comments (for example "LGTM", "nice")
- Pending Zeus placeholders that only acknowledge a review is in flight

## Step 3: Check out the PR branch

```bash
git fetch origin <headRefName>
git checkout <headRefName>
```

If checkout fails because another worktree already holds the branch, work in that worktree instead of forcing the branch free. Do not stash or discard unrelated local changes to take the branch.

## Step 4: Process each comment

For each unique item in the deduped worklist, decide: **code change**, **reply**, or **ticket + reply**. If a work item has multiple duplicate source comments/threads, apply the decision once and then acknowledge each source location.

### When to make a code change

- The comment identifies a bug, typo, or clear defect
- The comment requests a rename, style fix, or convention alignment
- The comment asks for a specific, scoped improvement within this PR

Make the fix. Only touch code directly related to the comment. Do not refactor surrounding code, fix unrelated issues, or improve code that was not flagged. Read the full file first, then edit; never edit blind.

### When to reply instead

- The behavior is intentional and the comment misunderstands the design
- The comment is already addressed elsewhere in the PR
- The suggestion would require a significant architectural change

Post a reply explaining the rationale. Concise, direct tone. First person. No filler.

For inline review comments, use the GitHub review-comment reply endpoint that includes the PR number in the path. Do not use `repos/<OWNER>/<REPO>/pulls/comments/<COMMENT_ID>/replies`; that abbreviated endpoint returns 404 for replies.

```bash
gh api repos/<OWNER>/<REPO>/pulls/<N>/comments/<COMMENT_ID>/replies \
  -f body="<reply text>"
```

For top-level PR conversation comments, post a new conversation comment that references the finding clearly:

```bash
gh api repos/<OWNER>/<REPO>/issues/<N>/comments \
  -f body="<reply text>"
```

### When to create a ticket and reply

If the comment identifies a valid improvement that is **out of scope for this PR** (affects other files, requires a broader refactor, or is cleanup that should be done separately):

1. Create a tracked follow-up in this order of preference:
   - **Linear** when a Linear integration is available: clear title, description with files/lines and a link to the PR comment, priority low unless urgent, assignee = original PR author when an exact Linear user match exists (GitHub login, then email, then exact display name; no fuzzy match). If assignee resolution fails, create the ticket unassigned and note that in the ticket and the PR reply. No labels unless the user requests them.
   - **GitHub issue** in the same repo when Linear is not available: same title/body/link requirements; assign the PR author only on an exact GitHub username match.
   - If neither tracker works, **stop and ask** how the user wants out-of-scope work tracked. Do not silently drop the finding.
2. Reply to the comment with a brief explanation of why it is out of scope, including a link to the created ticket or issue.

**Never dismiss valid feedback as "out of scope" without tracking it.** If the suggestion has merit, it gets a ticket or issue.

### Resolving threads

When an inline review thread has been fully addressed, resolve it with the thread `id` from Step 1. Resolve reply-only and ticket + reply threads right after their reply posts. Resolve a code-change thread only after Step 5's commit and push succeed, so an aborted run never leaves an unfixed finding hidden behind a resolved thread.

```bash
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
  }' -F threadId=<THREAD_ID>
```

Treat an "already resolved" error as success. Top-level conversation comments have no thread to resolve; the reply carrying the `(sent via resolve-comments)` signature is the machine-readable handled signal. A top-level finding already answered by a signed reply counts as handled. Do not reprocess it in a later run.

### Signature

Every comment you post must end with `(sent via resolve-comments)` on the last line.

### When to stop and ask

If a comment suggests a significant architectural change, or you are unsure whether to address it, **stop and ask the user**. Do not guess on high-impact changes.

## Step 5: Commit and push

After processing all comments that require code changes:

1. Stage only the files you modified (never `git add -A` or `git add .`).
2. Commit with a message prefixed with `[resolve-comments] - ` followed by a concise subject:

   ```text
   [resolve-comments] - Address PR review comments
   ```

   If you choose a different commit subject, keep the prefix format: `[resolve-comments] - {subject}`. If comments span multiple concerns, consider separate commits; use judgment.

3. Push to the PR branch.
4. If every deduped work item was fully handled in this run and nothing is listed as **Deferred (needs your input)**, ensure the PR has the `resolved-comments` label. If the repository does not have that label yet, create it first, then add it to the PR.

   ```bash
   gh api repos/<OWNER>/<REPO>/labels/resolved-comments >/dev/null 2>&1 || \
     gh label create resolved-comments --repo <OWNER>/<REPO> \
       --color 0E8A16 \
       --description "All actionable PR comments were handled by resolve-comments." \
       >/dev/null 2>&1 || true

   gh api repos/<OWNER>/<REPO>/labels/resolved-comments >/dev/null 2>&1 && \
     gh pr edit <N> --repo <OWNER>/<REPO> --add-label resolved-comments
   ```

If no code changes were needed, skip commit/push but still post replies and add the label once all items are fully handled. Do not add the label if the run stops early or any work item remains deferred.

Do not enable auto-merge from this skill. Merge belongs to the caller (human, Graphite merge skill, or other orchestrator) after this skill returns clean for the PR.

## Step 6: Summarize

Present a table with up to three sections.

### Code changes made

| Comment | File | What was changed |
| ------- | ---- | ---------------- |

### Replied without code change

| Comment | Rationale |
| ------- | --------- |

### Tickets created

| Comment | Ticket | Reason out of scope |
| ------- | ------ | ------------------- |

For deduped duplicate feedback, list it as a single row and mention the duplicate source count.

If you stopped to ask the user about any comments, list them as **Deferred (needs your input)**.
