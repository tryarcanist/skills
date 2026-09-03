# Adjudication prompts

Three prompts. Fill in `<REPO>`, `<RUN_DIR>`, `<SKILL_DIR>`, and the identifiers, and give each worker the prompt verbatim. Labels produced by paraphrased prompts cannot be collected into one bundle.

---

## Pass A — shipped candidate

You are deciding whether one merged fix should become a case about an AI code reviewer. You have no stake in the reviewer looking good or bad, and "no case here" is a correct and common answer.

**Repo:** `<REPO>` **Fix PR:** `<FIX_PR>` **Trace:** `<RUN_DIR>/origins/<FIX_PR>.json`

### Step 1 — establish that a real bug shipped

Read the fix and its origin before reading any reviewer output.

```bash
gh pr view <FIX_PR> --repo <REPO> --json title,body,url,mergedAt
gh pr diff <FIX_PR> --repo <REPO>
```

Answer, in your own words: what was wrong, what triggered it, and what the user, caller, or stored record got instead. If you cannot state a **reachable wrong output or a violated contract**, stop and write `verdict: "not_a_bug"`. A refactor, a rename, a defensive guard added for comfort, a test-only change, and a performance tidy-up are not bugs, however the pull request title is worded.

Watch for the fix that repairs something the fix's own pull request introduced earlier in its life. That never shipped, so no reviewer of the origin could have caught it.

### Step 2 — confirm the origin

The trace file names the commits that wrote the lines the fix rewrote, ranked by how many lines each contributed.

Blame names who last touched a line, which is not always who caused the bug. Check the top origin yourself:

```bash
git show <originSha> -- <path>
```

Ask whether that change actually introduced the mechanism you described in step 1, or merely touched a line near it. Where the true origin is a different commit than blame ranked first, say so and use the real one. Where the mechanism has no single origin — it emerged from two changes that were each fine alone — record `verdict: "not_eligible"` and say that; it is an interesting case for a different bundle.

### Step 3 — check the reviewer actually had it

Read `origins[].originPrs[].reviewers[]` in the trace file.

- `hadOpportunity: false` — write `verdict: "not_eligible"`. Do not argue around this. A reviewer that ran before the buggy lines existed did not miss them, and a case that says otherwise teaches a reviewer to find bugs that were not there.
- `hadOpportunity: null` — write `verdict: "not_eligible"` with the reason recorded. Unmeasured is not guilty.
- `hadOpportunity: true` — continue, and carry `firstOpportunity.sha` into `reviewedAt.commit`.

Confirm it yourself at that commit:

```bash
git show <reviewedCommit>:<path>
```

If the fetch fails, the commit is unreachable after a force push. Stop; do not read the working tree as a substitute.

### Step 4 — now read what the reviewer published

The trace file carries every published item from the roster on the origin pull request, each pinned to the commit it ran against.

Decide one thing: **did the reviewer name this mechanism?** Not this file, not this function, not this general area — this failure.

- It named the same failure in different words: `verdict: "caught"`, and quote it.
- It commented nearby about a different failure: `verdict: "missed"`. Say what it did comment on; that contrast is useful.
- It said nothing about this code: `verdict: "missed"`.
- It reviewed only a commit where the lines did not exist: back to step 3, `not_eligible`.

### Step 5 — write the case

Write `<RUN_DIR>/cases/<caseId>.json` in the shape at [case-schema.md](case-schema.md). Fill `whatWouldHaveCaughtIt` with a concrete act — the command to run, the caller to open, the two code paths to compare. If the honest answer is that only reading the file carefully would have caught it, write that; it is a real category.

---

## Pass B — caught candidate

Same standing, same detachment. A reviewer's own comment chose this subject, so the burden of proof sits higher than on a shipped candidate.

**Repo:** `<REPO>` **PR:** `<PR>` **Evidence:** `<RUN_DIR>/reviews/<PR>.json`

For each finding in the file:

1. Read the code at the finding's `reviewedCommit` — never at head. GitHub re-anchors comment lines as a pull request evolves, so the line the comment points at today may not be the line it was written against.
2. Decide whether a **reachable wrong output or violated contract** was really there. A real mechanism that produces no material harm is `not_a_bug` for this bundle, even when the team fixed it. So is a correct-sounding claim that the code disproves.
3. Re-rate the severity yourself. Reviewers rarely invent a bug; they routinely over-rate one. A real bug labelled critical that is really a nit is still a catch, at nit severity.
4. Check `commitsAfter`, `followedByCommitTouchingSamePath`, `humanReplies`, and `humanComments`. A later commit touching the same file is evidence a human agreed, not proof: teams fix nits to clear a queue and ignore real bugs to ship. Read the commit and see whether it repaired the mechanism.
5. Where several findings resolve with **one corrected predicate, guard, line, or value**, they are one case. Where fixing one leaves the other reachable, they are two.

Publish the strongest catches, not all of them. A case is worth exporting when it shows something a reviewer had to reason about — a cross-boundary contract, a state that only exists at runtime, a failure the diff alone does not reveal. Twelve variations on a missing null check are one case.

Write each surviving finding to `<RUN_DIR>/cases/<caseId>.json` with `verdict: "caught"` and the reviewer's own sentences in `quotes`.

---

## Pass C — skeptic

You are reading finished cases and trying to overturn them. A case you cannot break is worth sending; a case you can break would have been a false accusation or a false compliment, and catching it here is the point.

**Case:** `<RUN_DIR>/cases/<caseId>.json`

Inspect the code yourself. Do not accept the case's own summary of it.

For a `missed` case, try to establish any one of these:

- the buggy lines were **not** present at `reviewedAt.commit` — check the file at that commit and read it, rather than trusting the presence method;
- the reviewer **did** name the mechanism somewhere in its published output, including inside a long summary body;
- the origin is wrong, and the mechanism arrived in a different change;
- the fix was not repairing a defect — it was a refactor, a hardening pass, or a product change;
- the described wrong output is not actually reachable.

For a `caught` case, try to establish that the quoted finding does not describe a real defect at that commit, that the severity is inflated, or that the fix credited to it repaired something else.

Then set `skeptic` on the case:

- `upheld` — you tried the above and the case survived. Say what you checked.
- `revised` — the case is real but a field was wrong. Correct the field and say which.
- `rejected` — the case does not hold. It will not be exported.

`upheld` on a case you did not actually re-read is the one outcome that makes this pass worthless. If you could not reach the evidence, say so and use `rejected`.
