# Report

`score-corpus.mjs` produces every table. This file covers what goes around them: how to open, what each metric actually means when someone pushes on it, and what not to claim.

## Structure

The report answers two questions separately: **which reviewer is better on the same eligible defects**, and **which reviewer delivers more value under its installed trigger and delivery configuration**. It ends in an evidence-backed keep/change/cut/undecided opinion, not a blended leaderboard.

0. **What this measured.** Before any table: run identity, complete versus sampled mode, window and timezone, frozen PR population, roster decision (every login, kept or cut, with the reason), PR exclusions, collector warnings, delivery-surface states, judging model, method version, and scope disclaimer from `SKILL.md`. Short, and first. A reader who discovers any of this later discounts everything above it.
1. **Comparable quality.** Every reviewer as a column, using only the common eligible defect set: recall with numerator, denominator, and interval; material recall; first-look recall when measurable; nitpicks and wrong claims as separate rows. If the data-sufficiency gate fails, say “not distinguishable” instead of ranking.
2. **Installed value.** Coverage, passes per PR, commits reviewed, defects caught outside the common set, latency, engagement, avoidable code changes, pairwise redundancy, and customer-supplied price. These may support a deployment decision but do not prove better underlying review quality.
3. **Redundancy matrix.** Pairwise containment. A reviewer largely inside another is the cut candidate, and this is the table that shows it.
4. **One section per reviewer.** Three or four paragraphs: what it is for, **where it spikes** (the defect class it beats everyone on), what it costs, and a blunt **keep / cut / change / undecided** verdict. Name the spike concretely — "the only reviewer that catches races, 4 of 6" beats "good at concurrency" — and check that the spike is contested before claiming it: a catch nobody else was eligible for is a trigger-configuration artefact, not a strength.

   State the expected loss from cutting it in the same terms the tables measure ("we would give up the 3 blocking defects it sole-sourced, and lose 4 nitpick comments per PR"). Do not present it as a computed quantity — nothing here prices a missed defect, and the report has neither cost nor latency data. If the team has not supplied price and time-to-review, say the verdict is incomplete without them rather than issuing it anyway.
5. **What every reviewer missed.** The defects that were live in front of them and survived anyway. Usually the most valuable section and no vendor dashboard shows it.
6. **Is the audit trustworthy?** Cross-tabulate the audit's own labels against what humans did. If `confirmed` is not fixed far more often than `below_bar`, the labels are wrong and the report should not be published.
7. **Limits.** As generated. Do not delete it, do not soften it.

## What each number means when challenged

**Confirmed rate** is precision over published finding instances. It is not "how good the reviewer is" — a reviewer that only ever posts obvious nits scores near 100% and is nearly worthless. Never report it alone; always next to the severity profile.

**"Caught, of the same defects"** is the only number in this report that ranks reviewers. It is scored on the **common set**: defects that *every* compared reviewer was eligible to catch. Same defects, same denominator, for all of them.

This exists because the tools are not triggered alike. One runs once when the PR opens; another is re-run on every push and sees several times as many commits. Any raw per-PR count then measures how often a tool was *invited* as much as how well it reviews — and the reader of this report usually has no idea what each tool's trigger configuration is, so they will read that difference as quality. Opportunity-adjusted recall fixes the denominator but not the *set*: each reviewer is scored on a different collection of defects, so a reviewer whose set is harder looks worse for reasons unconnected to its quality. The common set fixes both.

Expect the common set to be substantially smaller than the audited set, and say how much smaller. If it collapses to a handful of defects, the reviewers' triggers barely overlap and the honest answer is that this corpus cannot rank them — say that instead of ranking them anyway.

**Recall on its own opportunity set** — found ÷ defects live at a commit that reviewer actually reviewed — sits below the divider and is **not** comparable between reviewers. Use it to understand one tool, never to rank two. Same for total defects per PR, defects per pass, and unique catches: every one of them moves with trigger configuration. If a reviewer's opportunity count is far below the others', say so in the same breath — a small denominator makes the percentage volatile.

Whatever the numbers say, recall here is recall *against the audited defect set*, which is a lower bound on all defects that exist. If someone quotes it as "finds 80% of all bugs," correct it.

**The set-definition caveat, which must be stated wherever recall is.** The audited defect set is the union of every reviewer's confirmed findings and the independent review. A reviewer that publishes several times more findings than the others contributes more of that set, so the set partly reflects what it looks for. Report the share of the set each reviewer sole-sourced next to its recall.

The pairwise matrix restricts to defects live on a commit **both** reviewers actually reviewed, which removes the coverage difference. It does **not** remove the set-definition problem, and it is **not symmetric**: each cell is a directed conditional — of the defects A found, the share B also found — so its denominator is A's find count on the shared set, not the shared opportunity. Read both directions plus the "only A found" counts before calling anything redundant. A reviewer that finds few defects, all of which another also found, reads as highly contained on a handful of defects; that is usually a small-sample artefact, not a reason to cut.

**Noise per PR** is the absolute count of published comments that did not describe a real defect. Report it as a count, not only as a precision percentage: "seven non-defect comments per PR" is a thing a team can feel, "45% precision" is not. Split it into nitpicks and wrong claims, and let the reader decide whether the trade is worth it — that judgement is theirs, not the report's.

**Severity gap** is the mean signed difference between claimed and audited severity, on `blocking`=4 to `nit`=1. `+1.2` means that reviewer routinely rates its findings more than one full rank above what they are. This predicts whether a team will start ignoring a reviewer — it is a trust problem, and it is independent of whether the reviewer finds real bugs. Report it apart from recall and do not let it colour the recall verdict.

Two caveats to state whenever you quote it. Vendors publish on different scales — P1/P2 badges, high/medium/low, bracket tags — and the mapping onto the 4-point scale is a judgement the auditing agent makes, so small differences between reviewers are noise. And it is computed only over findings that carried a stated severity at all; if one reviewer states severity on 76% of its findings and another on 100%, the two means are over different populations.

**False clears** must always be read against the clear-verdict count beside them. A reviewer that never publishes "I found nothing" has a structurally perfect false-clear record, which is an abstention rather than an accuracy result. Never print `0 of 0` next to another reviewer's `27 of 41` without saying so.

**Ran code** is the share of confirmed findings whose published comment carries execution evidence — a command and its output, a reproduction. Assertions of confidence do not count. Read it as a measure of **what the reviewer showed its work for**, not of whether it ran anything: a reviewer that reproduces a bug and does not paste the transcript scores zero, and nothing here verifies that a pasted transcript was real. Report it as a transparency signal and do not let it carry a keep/cut verdict on its own. Do not predict the result before running.

**False clears** counts review events where a reviewer said it found nothing on a commit that carries a `minor`-or-worse defect **that another reviewer independently established**. Cold-review-only defects and pre-existing defects do not count, and neither does a defect the same reviewer found elsewhere. It is a hard lower bound and the true rate is higher; say so rather than implying the counted number is complete. This is the one row that reads as an accusation of bad faith, so it must never fire on a defect only the audit believes in.

**Missed by everyone** is the report's most valuable number and the most fragile. It rests entirely on the independent review pass, so every defect in it must carry file-level evidence and have survived the refute pass. One soft entry here and a skeptical reader discards the section.

## Honesty rules

These are not stylistic. They are what makes the report usable in front of someone who disagrees with it.

- **Labels are frozen before the framing is chosen.** Write the verdict from the scored tables, never rescore to fit a verdict you already have. If a run's numbers are unflattering to whichever reviewer you were hoping would win, that is the result.
- **Report the counterweight in the same breath as the win.** A reviewer that adds the most unique catches and also has the worst precision gets both stated in the verdict paragraph, not one in the headline and one in a footnote.
- **Never carry a number across runs.** Coverage and precision move as tools ship changes. Re-derive everything.
- **Name what you could not verify.** `unverified` findings and any PR that failed to fetch go in the report explicitly.
- **State the window and the exclusions.** Which date range, which PRs were dropped and why. A corpus quietly filtered to flattering PRs is the easiest way to produce a wrong report.

## If a single reviewer dominates the corpus

Common on repos where one tool was installed months before the others. The precision half stays valid — it needs no pairing. The coverage half becomes thin and the eligible-defects column shows it. Say so directly rather than reporting a share number computed from a handful of paired defects.
