---
name: export-review-cases
description: Build a shareable case set of bugs an AI code reviewer missed and bugs it caught, each paired with the merged fix that proves the bug was real. Mines merged fix pull requests backwards to the change that introduced the bug, then checks whether the reviewer had read that code. Use to give a reviewer's vendor concrete material to improve on, or to build a regression set for a reviewer you run yourself. Do not use to score, rank, or compare reviewers.
---

# Export review cases

Produce a bundle of paired pull requests:

- **shipped** — a bug reached the default branch, a later pull request fixed it, and the reviewer had that code in front of it and did not report it;
- **caught** — the reviewer reported a real defect and the team repaired or accepted it.

Both halves matter. A set of only misses tells a vendor where it failed and nothing about what to protect; a set of only catches is a testimonial. Ship a mix.

## What makes this different from scoring a reviewer

This skill mines **backwards from merged fixes**, not forwards from reviewer output.

A reviewer's comments can only tell you about bugs some reviewer already mentioned. A merged fix tells you about a bug that was real, that shipped, and that a human cared enough to repair — including bugs no reviewer ever mentioned. Those are the cases worth sending, and a reviewer-first search cannot see them.

The cost of mining this way is that it is not a measurement. Bugs nobody fixed are invisible, and so are bugs fixed silently inside an unrelated pull request. **Never report a recall rate from this bundle.** If someone wants comparable quality numbers, that is a different job with a different method.

## Portable contract

Requires authenticated `gh`, `git`, and Node.js, plus read access to the repository. No vendor APIs, no internal telemetry.

Use the directory containing this file as `<SKILL_DIR>` and a fresh directory as `<RUN_DIR>`. Do not assume the skill is installed under `.claude`, `.codex`, or any fixed path.

Run against a **full clone**. `git blame` on a shallow clone attributes every line to the graft boundary and invents origin commits; the scripts refuse to run rather than produce that, and the fix is `git fetch --unshallow`. Prefer an ordinary clone over `--filter=blob:none`, which makes blame fetch blobs one at a time and turns a ten-second trace into minutes.

The run is read-only. It must not trigger reviews, edit pull requests, post comments, or change repository state.

**Confirm before exporting.** The bundle leaves the repository. Get the owner's agreement on the window, the authors in scope, and whether source patches are included, before running `build-bundle.mjs`.

## Invariants

- The fix is the ground truth. A reviewer's silence is not evidence of anything on its own, and a reviewer's comment is not evidence that a bug existed.
- A missed case requires the exact commit the reviewer read **and** evidence that the buggy lines already existed at that commit. A reviewer whose only run predates the bug missed nothing.
- Presence is established by ancestry or by verbatim content. Neither firing is unmeasured, which drops the case. It is never "probably present".
- **`false` and `null` are different answers.** `false` means the reviewer read the code and the bug was not there. `null` means nothing is known. Collapsing the second into the first turns an absence of evidence into a finding of innocence, and it silently deletes the category this skill exists to be careful about.
- Judge every claim at the reviewed commit. Current head is not a substitute.
- A negative claim about a reviewer that no second reader challenged does not leave the building.
- Store the structured case file before writing any prose. The Markdown is generated from the cases, never the other way round.
- Report what was rejected and why, alongside what was exported.

## 1. Declare the scope

Fix three things before collecting, and record them.

**Window.** `--since` inclusive, `--until` exclusive. A calendar month or quarter is usually right. Leave time after the window for fixes to have landed — a bug that shipped last week has not been fixed yet, so a window ending yesterday finds almost nothing. Both dates must be `YYYY-MM-DD` with zero padding; anything else is rejected rather than silently searched.

**Authors.** `--authors` restricts to specific pull request authors. Use it when the team's habits differ enough to bias the set — for example when one engineer routinely tells their coding agent to address the reviewer's comments and another does not. It filters client-side after collection, so it narrows the corpus rather than widening the search. Say in the report which scope was used.

**Roster.** Discover the reviewer identities from the repository rather than guessing a login:

```bash
gh pr list --repo <owner/repo> --state merged \
  --search "merged:>=<since> merged:<<until>" --limit 200 --json number,reviews \
  --jq '[.[].reviews[].author.login] | group_by(.) | map({login: .[0], reviews: length}) | sort_by(-.reviews)'

gh api "repos/<owner/repo>/issues/comments?per_page=100&since=<since>T00:00:00Z" \
  --paginate --jq '[.[] | select(.user.type == "Bot") | .user.login] | group_by(.) | map({login: .[0], comments: length})'
```

Run both. The second one matters: a reviewer that publishes its whole verdict as one top-level comment appears nowhere in the first. Note also that `gh pr list` returns logins **without** the `[bot]` suffix while the REST API returns them **with** it; `--only` accepts either spelling, and some app reviewers have no `[bot]` suffix at all.

## 2. Propose candidates

```bash
node <SKILL_DIR>/scripts/find-candidates.mjs \
  --repo <owner/repo> --mode shipped \
  --since 2026-06-01 --until 2026-08-01 [--authors alice,bob] \
  --out <RUN_DIR>/candidates-shipped.json

node <SKILL_DIR>/scripts/find-candidates.mjs \
  --repo <owner/repo> --mode caught \
  --since 2026-06-01 --until 2026-08-01 [--authors alice,bob] \
  --only "<reviewer-a>,<reviewer-b>" \
  --out <RUN_DIR>/candidates-caught.json
```

`shipped` scores merged pull requests for fix signals: a revert, a bug label, a closed issue, fix language in the title, symptom language, a root cause in the body. `caught` finds pull requests where a roster reviewer published, on **either** surface — a review body or a top-level comment. Searching only for review bodies misses a summary-only reviewer entirely, which on one repository under test was a quarter of the merged population.

`gh` returns newest-first and stops at `--limit`, so a busy repository would answer a two-month question with its last two days. The collector splits the window and asks again until each sub-window fits, so you get the window you asked for. Check `population.complete` before describing the run as complete; if it is `false`, `population.subWindowsTruncated` names the days that overflowed and `--limit` needs raising.

These are leads. Most will not become cases, and that is the normal outcome, not a collection failure.

## 3. Trace each shipped candidate back to its origin

Work down the ranked list. Highest fix signal and smallest diff first: a two-file fix blames back to one origin commit, a two-hundred-file fix blames back to noise.

```bash
node <SKILL_DIR>/scripts/trace-origin.mjs \
  --repo <owner/repo> --pr <fix-pr> \
  --only "<reviewer-a>,<reviewer-b>" --repo-path <full-clone> \
  --out <RUN_DIR>/origins/<fix-pr>.json
```

It blames the lines the fix rewrote against the tree the fix landed on, ranks the commits that wrote them, finds the pull request that shipped each one, and for every reviewer reports the exact commits it read and whether the buggy lines existed at each.

Four things it deliberately refuses to trace, because each one manufactured false cases in testing:

- **Non-product files.** A fix almost always touches its own tests. Blaming those attributes the bug to whoever last edited a fixture, and eligibility ends up decided by a mock branch or a docstring. Tests, fixtures, docs, generated and vendored trees are skipped; you will see them as `non-product-path` in `files[]`.
- **Insertion anchors.** A hunk that only adds lines has no pre-image, so it cannot say what was wrong. An add-only fix may still rank an origin from the line above the insertion, but it can never build a needle from one — so presence comes back `null` with `no-block-carrying-identifiable-code`, and the fix yields no case. That is correct: a bug of omission has no origin commit. Do not go looking for one.
- **History artefacts.** Subtree imports, merge commits and bulk reformats own thousands of lines and have no reviewable pull request. They are excluded from ranking and listed in `historyArtefactsExcluded`.
- **Unidentifiable needles.** The content test needs a block of real code. A comment, an import, a decorator, or a line of prose from inside a docstring matches boilerplate anywhere in a large file, so a block with less than 40 characters of substantive code is rejected and listed in `origins[].rejectedBlocks`. Comment and docstring interiors are detected against the whole file, because a line lifted from the middle of a docstring carries no fence of its own.

`origins[].needleKind` says whether the chosen block contains executable logic (`statement`) or only declarations (`declaration`) — a type alias, an interface field, a css rule. Statement needles are preferred automatically. A `declaration` needle warns, and it is the one case where presence can be exactly right while the block is not the mechanism: **read `origins[].buggyBlock` before writing that case.**

Two thresholds exist and are **off by default**: `--min-lines` (1) and `--min-share` (0). Turning them up looks tempting and costs real cases — a one-line root cause inside a multi-file fix sits below any share threshold by construction, and that is the most common bug shape there is. `shareOfBlamedLines` measures how much of the fix's diff an origin wrote, which is not the same question as whether it caused the bug. Read the share; do not gate on it without a reason.

Read `origins[].originPrs[].reviewers[]`:

| `hadOpportunity` | `reason` | What it means |
| --- | --- | --- |
| `true` | — | The reviewer had this code in front of it. This can become a case. |
| `false` | `buggy-lines-absent-at-every-reviewed-commit` | It ran before the lines existed. Not a case. |
| `false` | `no-published-output-on-this-pr` | It never published here. Not a case. |
| `null` | `published-only-on-an-unpinned-surface` | It published, but with no commit pin, so nothing is known about what it saw. Not a case. |
| `null` | `origin-share-below-threshold` | This origin owns too little of the blamed lines to assert anything. Not a case. |
| `null` | `presence-could-not-be-established` | The commit or path could not be reached. Not a case. |

Only `true` proceeds. Do not argue around a `false` or promote a `null`.

Then check `presenceMethodCounts`. On a squash-merge repository `ancestry` will be `0` and every verdict rests on the approximate content test — the script warns when this happens. The content test looks for the buggy lines **verbatim**, so a line that was later reformatted reads as absent. That loses real cases and never invents one, which is the right direction to be wrong in.

## 4. Collect the caught candidates

```bash
node <SKILL_DIR>/scripts/collect-reviews.mjs \
  --repo <owner/repo> --pr <pr> --only "<reviewer-a>,<reviewer-b>" \
  --out <RUN_DIR>/reviews/<pr>.json
```

This adds what the shipped side gets from the fix commit: commits pushed after each finding, whether one of them touched the same file, and what humans said in reply. None of that proves the finding was a defect — teams fix nits and ignore real bugs — so it feeds adjudication rather than deciding it. On a long-lived branch where every commit touches the same large file, `followedByCommitTouchingSamePath` carries no information at all; read the commit instead.

Choose which candidates to collect. On a busy repository nearly every pull request carries a review, so review count sorts nothing; candidates are ranked by **disagreement** instead, putting pull requests where some roster reviewer stayed silent first (`rosterSilent`, and `surfaces` for which reviewer used which channel). Prefer those, and those whose findings drew a human reply.

## 5. Generate a stub, then adjudicate

Do not hand-write case files. Everything mechanical is already known:

```bash
node <SKILL_DIR>/scripts/emit-case-stub.mjs \
  --trace <RUN_DIR>/origins/<fix-pr>.json --origin <sha|index> --reviewer "<login>" \
  --out <RUN_DIR>/cases/<caseId>.json

node <SKILL_DIR>/scripts/emit-case-stub.mjs \
  --reviews <RUN_DIR>/reviews/<pr>.json --finding <finding-id> \
  --out <RUN_DIR>/cases/<caseId>.json
```

The stub carries the repository, reviewer, origin commit and pull request, the exact reviewed commit, how presence was established, **everything the reviewer published on that pull request** (flagged by whether each item landed on the reviewed commit), and the fix scoped to the file the needle came from. What is left is judgement, emitted as `TODO:` strings; the bundler rejects any case that still contains one, at any depth. It refuses to stub a reviewer whose `hadOpportunity` is not `true`.

A stub is not a case. Read the fix, the origin commit, the code at the reviewed commit, and every published item before replacing a single field.

Then give each stub to a worker with the exact prompt in [references/agent-prompt.md](references/agent-prompt.md). Do not paraphrase it per candidate; labels from divergent prompts do not belong in one bundle. The schema is in [references/case-schema.md](references/case-schema.md).

## 6. Run the skeptic

Give every case to a fresh worker with the skeptic prompt at the bottom of [references/agent-prompt.md](references/agent-prompt.md). It inspects the code itself and tries to overturn the verdict. Record `upheld`, `revised`, or `rejected`, **with a note saying what was actually checked**. An unrun skeptic, a rejected one, or an upheld one with an empty note all block export.

## 7. Build the bundle

```bash
node <SKILL_DIR>/scripts/build-bundle.mjs \
  --cases <RUN_DIR>/cases --out <RUN_DIR>/bundle \
  --repo <owner/repo> --repo-path <full-clone> --only "<reviewer-a>,<reviewer-b>" \
  --max-per-label 25 [--label-set "missed,caught"] [--include-source]
```

Shape validation is not enough — a case file is written by a language model and every field in it is a claim — so the bundler also reads the repository and GitHub. It re-runs the presence test at `reviewedAt.commit`, checks that `origin.sha` really belongs to `origin.pr`, that the fix pull request exists, merged, and touched a path the case names, that every quote appears in something the reviewer actually published, that `origin.path` exists at `origin.sha`, that the reviewer is on the roster, and that no field is still a generated placeholder. `--skip-truth-checks` exists for an offline run and stamps the manifest as unverified; do not send an unverified bundle.

Without `--include-source` the bundle carries links, SHAs, paths, line numbers, prose, and excerpts of the reviewer's own published output. With it, the bundle also carries the patches for the files each case names, from the origin pull request and the fix pull request only. A case whose named paths cannot be found in its pull request is **dropped**, not exported with the whole pull request attached — that fallback once put 487 files of a customer's source into a bundle built from a case that named one.

Read the rejection list. A high count usually means the adjudication prompt drifted, not that the repository is clean.

## 8. Hand it over

The bundle is `manifest.json`, `cases.json`, and `CASES.md`. Send all three; the Markdown is for reading and the JSON is what a vendor can build against.

Say plainly, every time:

- how the set was mined, and that it is therefore a lower bound rather than a measurement;
- the window, whether it was collected completely, the author scope, and the reviewer roster;
- how many candidates were examined to produce this many cases;
- how many cases were rejected and why;
- whether `ancestry` fired at all, or whether every verdict rests on the verbatim-content test — `CASES.md` states this for you;
- that add-only fixes and bugs of omission cannot appear in this bundle at all; and
- that no recall, precision, or ranking claim can be drawn from it.
