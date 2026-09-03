---
name: export-review-cases
description: Build a shareable case set of bugs an AI code reviewer missed and bugs it caught, each paired with the merged fix that proves the bug was real. Mines merged fix pull requests backwards to the change that introduced the bug, then checks whether the reviewer had read that code. Use to give a reviewer's vendor concrete material to improve on, or to build a regression set for a reviewer you run yourself. Do not use to score, rank, or compare reviewers.
---

# Export review cases

Produce a bundle of paired pull requests:

- **shipped** — a bug reached the default branch, a later pull request fixed it, and the reviewer had that code in front of it and said nothing;
- **caught** — the reviewer reported a real defect and the team repaired it.

Both halves matter. A set of only misses tells a vendor where it failed and nothing about what to protect; a set of only catches is a testimonial. Ship a mix.

## What makes this different from scoring a reviewer

This skill mines **backwards from merged fixes**, not forwards from reviewer output.

A reviewer's comments can only tell you about bugs some reviewer already mentioned. A merged fix tells you about a bug that was real, that shipped, and that a human cared enough to repair — including bugs no reviewer ever mentioned. Those are the cases worth sending, and a reviewer-first search cannot see them.

The cost of mining this way is that it is not a measurement. Bugs nobody fixed are invisible, and so are bugs fixed silently inside an unrelated pull request. **Never report a recall rate from this bundle.** If someone wants comparable quality numbers, that is a different job with a different method.

## Portable contract

This skill is self-contained. It requires authenticated `gh`, `git`, Node.js, and read access to the repository. It must not rely on vendor APIs or internal telemetry.

Use the directory containing this file as `<SKILL_DIR>` and a fresh directory as `<RUN_DIR>`. Do not assume the skill is installed under `.claude`, `.codex`, or any fixed path.

Run every command from a **full clone** of the repository. `git blame` on a shallow clone attributes every line to the graft boundary and invents origin commits; the scripts refuse to run rather than produce that, and the fix is `git fetch --unshallow`.

The run is read-only. It must not trigger reviews, edit pull requests, post comments, or change repository state.

**Confirm before exporting.** The bundle leaves the repository. Get the owner's agreement on the window, the authors in scope, and whether source patches are included, before running `build-bundle.mjs`.

## Invariants

- The fix is the ground truth. A reviewer's silence is not evidence of anything on its own, and a reviewer's comment is not evidence that a bug existed.
- A missed case requires the exact commit the reviewer read **and** evidence that the buggy lines already existed at that commit. A reviewer whose only run predates the bug missed nothing.
- Establish presence by ancestry or by verbatim content. Neither firing is `unmeasured`, which drops the case. It is never "probably present".
- Judge every claim at the reviewed commit. Current head is not a substitute.
- A negative claim about a reviewer that no second reader challenged does not leave the building.
- Store the structured case file before writing any prose. The Markdown is generated from the cases, never the other way round.
- Report what was rejected and why, alongside what was exported.

## 1. Declare the scope

Fix three things before collecting, and record them:

- **Window.** `--since` inclusive, `--until` exclusive, so adjacent windows never double-count. A calendar month or quarter is usually right. Leave enough time after the window for fixes to have landed: a bug that shipped last week has not been fixed yet, so a window ending yesterday finds almost nothing.
- **Authors.** `--authors` restricts to specific pull request authors. Use it when the team's habits differ enough to bias the set — for example when one engineer routinely tells their coding agent to address the reviewer's comments and another does not. Say in the report which scope was used.
- **Roster.** `--only` names the reviewer identities, comma separated, with or without the `[bot]` suffix. Discover them from the pull requests themselves rather than guessing a login.

## 2. Propose candidates

Both modes, into the same run directory:

```bash
node <SKILL_DIR>/scripts/find-candidates.mjs \
  --repo <owner/repo> --mode shipped \
  --since 2026-08-01 --until 2026-09-01 \
  [--authors alice,bob] --limit 300 \
  --out <RUN_DIR>/candidates-shipped.json

node <SKILL_DIR>/scripts/find-candidates.mjs \
  --repo <owner/repo> --mode caught \
  --since 2026-08-01 --until 2026-09-01 \
  [--authors alice,bob] --only "<reviewer>[bot]" --limit 300 \
  --out <RUN_DIR>/candidates-caught.json
```

`shipped` mode scores merged pull requests for fix signals: a revert, a bug label, a closed issue, fix language in the title, symptom language, a root cause in the body. `caught` mode lists merged pull requests carrying a published review from the roster.

These are leads. Most will not become cases, and that is the normal outcome, not a collection failure. Check `population.limitReached` before describing the run as complete.

## 3. Trace each shipped candidate back to its origin

Work down the ranked list. Highest fix signal and smallest diff first: a two-file fix blames back to one origin commit, a two-hundred-file fix blames back to noise.

```bash
node <SKILL_DIR>/scripts/trace-origin.mjs \
  --repo <owner/repo> --pr <fix-pr> \
  --only "<reviewer>[bot]" --repo-path <full-clone> \
  --out <RUN_DIR>/origins/<fix-pr>.json
```

It blames the lines the fix rewrote against the tree the fix landed on, ranks the commits that wrote them, finds the pull request that shipped each one, and for every reviewer reports the exact commits it read and whether the buggy lines existed at each.

Read `origins[].originPrs[].reviewers[].hadOpportunity`:

- `true` — the reviewer had this code in front of it. This is a case.
- `false` — it ran before the lines existed, or it never published here. Not a case. Do not turn it into one.
- `null` — presence could not be established. Not a case. Record it as unmeasured.

The content test is deliberately strict: it looks for the buggy lines verbatim. A line that was later reformatted reads as absent even though the mechanism was present. That loses real cases and never invents one, which is the right direction to be wrong in.

## 4. Collect the caught candidates

```bash
node <SKILL_DIR>/scripts/collect-reviews.mjs \
  --repo <owner/repo> --pr <pr> --only "<reviewer>[bot]" \
  --out <RUN_DIR>/reviews/<pr>.json
```

This adds what the shipped side gets from the fix commit: commits pushed after each finding, whether one of them touched the same file, and what humans said in reply. None of that proves the finding was a defect — teams fix nits and ignore real bugs — so it feeds adjudication rather than deciding it.

## 5. Adjudicate

Give each candidate to a worker using the exact prompt in [references/agent-prompt.md](references/agent-prompt.md). Do not paraphrase it per candidate; labels from divergent prompts do not belong in one bundle.

The worker reads the code at the reviewed commit, decides whether a qualifying defect was there, decides whether the reviewer's published output named that mechanism, and writes one case file to `<RUN_DIR>/cases/<caseId>.json` in the shape defined by [references/case-schema.md](references/case-schema.md).

## 6. Run the skeptic

Give every case to a fresh worker with the skeptic prompt at the bottom of [references/agent-prompt.md](references/agent-prompt.md). It inspects the code itself and tries to overturn the verdict. Record `upheld`, `revised`, or `rejected` on the case. An unrun or rejected skeptic pass blocks export, and the bundler enforces that.

## 7. Build the bundle

```bash
node <SKILL_DIR>/scripts/build-bundle.mjs \
  --cases <RUN_DIR>/cases --out <RUN_DIR>/bundle \
  --repo <owner/repo> --max-per-label 25 [--include-source]
```

Without `--include-source` the bundle carries links, SHAs, paths, line numbers, prose, and the reviewer's own published output — no source. With it, the bundle also carries the patches for the files each case names, from the origin pull request and the fix pull request only. Ask the repository owner which one they want.

The bundler rejects a case that cannot support its claim and lists every rejection with its reason. Read that list: a high rejection count usually means the adjudication prompt drifted, not that the repository is clean.

## 8. Hand it over

The bundle is `manifest.json`, `cases.json`, and `CASES.md`. Send all three; the Markdown is for reading and the JSON is what a vendor can actually build against.

Say plainly, every time:

- how the set was mined, and that it is therefore a lower bound rather than a measurement;
- the window, the author scope, and the reviewer roster;
- how many candidates were examined to produce this many cases;
- how many cases were rejected and why;
- that presence at the reviewed commit was established by ancestry or verbatim content, and that the content test loses real cases; and
- that no recall, precision, or ranking claim can be drawn from this bundle.
