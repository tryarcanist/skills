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

It is usually a small fraction of what the repository merges, and often small enough to look at every one. That is the point: nothing has to be inferred or sampled.

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

Always read the reviewer's own review body on a miss. The most valuable case of all is the one where the reviewer *tested the exact scenario*, described the mechanism correctly, and then classified it as intended behaviour — usually by taking a code comment as the specification. "It never looked" and "it looked and drew the wrong conclusion" are different product problems, and only the review body tells them apart.

## Use subagents

Reading one pull request properly — the diff at the reviewed commit, the review body, the replies, the commits that followed — is most of the work here, and it parallelises cleanly. Hand one pull request to one subagent, with the same instructions every time, so the verdicts that come back can sit in the same writeup.

Two roles worth spending an extra agent on:

- **A skeptic**, before you keep any case. Its only job is to overturn it: was the code really there at that commit, did the reviewer really not mention it anywhere including a long summary body, is the commit credited as the fix really fixing this. A case that survives is worth sending; one that does not would have been a false accusation, and finding that out yourself is much cheaper than having the vendor find it. Use a fresh agent — the one that wrote the case will agree with itself.
- **A cold reader**, when you want to know what everyone missed. Have it find defects in the diff *before* it sees any reviewer output. Once it has read the reviewer it will anchor on that framing and stop looking.

Keep the judgement in one place. Subagents gather and challenge; you decide which cases to keep and write them up, or the set will not hold together.

## Things that will bite

- **Judge at the commit the reviewer saw, never at head.** GitHub re-anchors inline comments as a pull request evolves, so the line a comment points at today may not be the line it was written against. Use `original_commit_id` and `git show <sha>:<path>`.
- **Those commits are often not in your clone, and on a squash-merging repository most of them will not be.** Reviewed commits sit on pull request branches and are not reachable from the default branch. Fetch them: `git fetch origin <full-sha>`, or `git fetch origin refs/pull/<n>/head` once the branch is deleted. Full SHAs only; `git fetch` cannot resolve an abbreviated one. A fetch that fails on credentials looks identical to a commit that is genuinely gone — check which you have before recording a case as unverifiable.
- **A force-pushed commit may be unreachable for good.** Say so rather than judging against head.
- **The reviewer's claims are candidates, not truth**, in both directions. A confident finding can be wrong, and so can a confident all-clear.
- **A finding can be true and worthless.** A batch of technically correct findings against an excluded scratch tree, a vendored copy, or generated output is noise, and a team is right to ignore it. Check what the file is for before counting a finding either way.
- **Human silence proves nothing.** Teams fix nits to clear a queue and ignore real bugs to ship.
- **Agent-drafted replies.** "Fixed in `<sha>`" replies are increasingly written by coding agents. Check the SHA contains the described change before treating the reply as agreement.

## Write it up

Per case: the pull request, the exact reviewed commit, what the bug was, what it would have broken, the evidence the team agreed or repaired it, and why it took the reasoning it took. Link everything so a reader can check it.

Then say plainly what the set is and is not. It is a handful of read pull requests, not a measurement: no recall rate, no precision, no ranking. If you counted something across the corpus — how often the head moved after review, how many findings drew replies — give the numerator and denominator and say it is what you looked at.

Ask the repository owner before sending anything outside the company, and prefer links, paths and prose over pasted source.
