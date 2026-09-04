---
name: export-review-cases
description: Find concrete cases where an AI code reviewer did well and where it did badly on a repository, each backed by evidence, to hand to the reviewer's vendor or use as a regression set. Works from the reviewer's own published reviews. Use when someone asks for examples of a reviewer catching or missing bugs. Do not use to score or rank reviewers.
---

# Find review cases

Produce a handful of concrete cases about one AI code reviewer:

- **good** — it reported a real defect and the team acted on it;
- **bad** — it reviewed the code and said nothing, or said something wrong, or missed what mattered.

Two or three of each, each backed by evidence someone can check, beats a survey. Read the pull requests. There is no pipeline here.

## Start from what the reviewer reviewed

That set is the whole population and it is one query:

```bash
gh api "search/issues?q=repo:<owner/repo>+is:pr+reviewed-by:<bot-login>&per_page=100" \
  --jq '.items[] | {n:.number, t:.title, merged:(.pull_request.merged_at != null)}'
```

It is usually small — on one customer repository it was 41 pull requests against thousands merged. Small enough to look at all of them, which is the point: nothing has to be inferred or sampled.

Then, per pull request, collect what it said and what happened next: `pulls/<n>/reviews` (review bodies), `pulls/<n>/comments` (inline findings — `original_commit_id` is the commit each was written against), `issues/<n>/comments` (some reviewers publish everything here), plus human replies and the PR's commits with timestamps.

## Sort before you read

Cheap signals that say where the interesting cases are:

- **Humans replied to a finding** → likely a real catch. An author replying "fixed in `<sha>`" is the strongest cheap signal there is.
- **The reviewer published nothing, or a clear verdict** → miss candidate.
- **Findings with no reply and no follow-up commit** → either noise the team correctly ignored, or something real that got dropped. Both are worth knowing; they need reading to tell apart.
- **The head moved after the last review** → whatever shipped may never have been reviewed at all. Worth counting across the corpus; it is often the biggest story.

## Then read them, and judge

For a **good** case, establish: the defect was real at the commit the reviewer saw, it was material rather than a nit, the team agreed, and — the part worth writing down — *what kind of reasoning the catch took*. A framework contract, a race, a trace across files or services, a consequence followed into another language. That is what a vendor can act on.

For a **bad** case, establish: the code was there at the commit the reviewer saw, something later repaired it, and what the reviewer would have had to do differently. A fix landing in the same pull request shortly after a clean verdict is excellent evidence — better than a fix months later on the default branch, because there is no ambiguity about what was being fixed.

Also read the reviewer's own review body on the misses. The most useful case found this way was one where the reviewer had *tested the exact scenario*, described the mechanism correctly, and then classified it as intended behaviour. "It never looked" and "it looked and drew the wrong conclusion" are different product problems, and only the review body distinguishes them.

## Things that will bite

- **Judge at the commit the reviewer saw, never at head.** GitHub re-anchors inline comments as a pull request evolves, so the line a comment points at today may not be the line it was written against. Use `original_commit_id` and `git show <sha>:<path>`.
- **Those commits are often not in your clone.** After a squash merge the reviewed commits are not reachable from the default branch — on one repository 44 of 60 were missing. Fetch them: `git fetch origin <full-sha>`, or `git fetch origin refs/pull/<n>/head` once the branch is deleted. Full SHAs only; `git fetch` cannot resolve an abbreviated one. A fetch that fails on credentials looks identical to a commit that is genuinely gone — check which you have before recording a case as unverifiable.
- **A force-pushed commit may be unreachable for good.** Say so rather than judging against head.
- **The reviewer's claims are candidates, not truth**, in both directions. A confident finding can be wrong; the strongest case found this way was a reviewer's own claim that its verdict *held*.
- **A finding can be true and worthless.** Seven findings against a gitignored single-commit scratch directory were all technically correct and all noise. Check what the file is for before counting a finding against the reviewer either way.
- **Human silence proves nothing.** Teams fix nits to clear a queue and ignore real bugs to ship.
- **Agent-drafted replies.** "Fixed in `<sha>`" replies are increasingly written by coding agents. Check the SHA contains the described change before treating the reply as agreement.

## Write it up

Per case: the pull request, the exact reviewed commit, what the bug was, what it would have broken, the evidence the team agreed or repaired it, and why it took the reasoning it took. Link everything so a reader can check it.

Then say plainly what the set is and is not. It is a handful of read pull requests, not a measurement: no recall rate, no precision, no ranking. If you counted something across the corpus — how often the head moved after review, how many findings drew replies — give the numerator and denominator and say it is what you looked at.

Ask the repository owner before sending anything outside the company, and prefer links, paths and prose over pasted source.
