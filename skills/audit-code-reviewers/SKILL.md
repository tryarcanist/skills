---
name: audit-code-reviewers
description: Compare every AI code reviewer active on a GitHub repository and decide which are worth keeping. Uses exact reviewed commits, blind defect discovery, symmetric adjudication, a common eligible defect set, operational coverage, noise, human response, and reviewer redundancy. Use for repository-wide reviewer evaluations, vendor comparisons, and keep/change/cut decisions. Do not use to review one PR or investigate one reviewer incident.
---

# Audit code reviewers

Answer two different questions without mixing them:

1. **Comparable quality:** if every reviewer had a chance to see the same defects, which reviewed them best?
2. **Installed value:** as configured on this repository, which prevented useful defects from reaching main, with how much noise, latency, duplication, and human cost?

No reviewer is privileged. A scorecard that cannot conclude that any named reviewer performed worst is not an audit.

## Portable contract

This skill is self-contained. It requires only authenticated `gh`, `git`, Node.js, and read access to the target repository. It must not rely on private vendor APIs, internal telemetry, or an internal database.

Use the directory containing this file as `<SKILL_DIR>` in every command. Use a fresh `<RUN_DIR>` for every audit. Do not assume the skill is installed under `.claude`, `.codex`, or any fixed home-directory path.

Before collecting comment bodies from a repository the user does not own, confirm that the user is authorized to audit it. The audit is read-only. It must not trigger reviews, edit pull requests, post comments, or change repository state.

## Measurement rules

Read [references/methodology.md](references/methodology.md) before running the audit. Give per-PR workers the exact prompt in [references/agent-prompt.md](references/agent-prompt.md). Follow [references/report.md](references/report.md) when writing the conclusion.

The rules below are invariants:

- Freeze the corpus, reviewer roster, method version, evaluator identity, and source hashes before adjudication.
- Perform blind review before exposing the evaluator to any reviewer output or PR discussion.
- Reviewer comments are defect candidates, not truth. Reviewer agreement has no evidentiary weight.
- Judge each claim against the exact commit the reviewer saw. Current head is not a substitute.
- A comment is a finding instance. Recall uses deduplicated defects. Precision and noise use non-duplicate instances.
- Deduplicate symmetrically within and across reviewers by failure mechanism. Two findings are one defect when one corrected predicate, guard, line, or configuration value resolves both.
- Keep `confirmed`, `below_bar`, `incorrect`, `duplicate`, `unverified`, `drifted`, and `out_of_scope` distinct.
- Use `observed`, `derived`, `not_measurable`, `collection_failed`, and `not_applicable` for measurement state. Missing data is never zero, false, success, or an observed empty list.
- A material miss, incorrect finding, unique catch, blocking or major severity, disputed cluster, or presence interval cannot affect a headline result until an independent skeptic upholds it.
- Store structured per-PR observations before aggregation. Markdown is never a source of numbers.
- Sum component counts, then calculate ratios. Do not average percentages across PRs or carry numbers between runs.

## 1. Declare the population

Choose one mode and state it in the report:

- `complete`: every eligible PR in the frozen window.
- `sample`: a deterministic declared sample. Record the population, selection rule, seed, strata, and selected PRs. Never silently stop after the first N PRs or describe a sample as every PR.

Run the collector once to discover the roster:

```bash
node <SKILL_DIR>/scripts/collect-review-corpus.mjs \
  --repo <owner/repo> --since "90 days ago" --until <exclusive-end> \
  --out <RUN_DIR>/corpus-discovery.json
```

Read the roster. Include an identity when it publishes claims about the correctness or quality of a diff. Exclude status bots, deployment bots, issue sync, merge queues, dependency update authors, and auto-fixers that only consume another reviewer's findings. Check installed integrations for reviewers posting from ordinary user accounts.

Record every kept and excluded identity with a reason. Then recollect with the frozen reviewer list:

```bash
node <SKILL_DIR>/scripts/collect-review-corpus.mjs \
  --repo <owner/repo> --since "90 days ago" --until <exclusive-end> \
  --only "reviewer-a[bot],reviewer-b[bot]" \
  --out <RUN_DIR>/corpus.json
```

The corpus is every eligible PR, including single-reviewer PRs, explicit clear reviews, failed collections, and reviewers that skipped work. Use `--exclude-authors` only for declared synthetic or vendor-authored test PRs, and print every exclusion.

Review `excluded[]`, `warnings[]`, sweep caps, window-edge drops, and delivery surfaces before continuing. Reviewers that publish only through an unsupported surface such as uncollected check annotations are `not_measurable`; they are not zero-recall reviewers.

Write `<RUN_DIR>/manifest.json` using [references/methodology.md](references/methodology.md). Freeze the exact PR list before reading reviewer bodies.

## 2. Collect exact review evidence

For every frozen PR:

```bash
node <SKILL_DIR>/scripts/fetch-pr-reviews.mjs \
  --repo <owner/repo> --pr <number> \
  --only "reviewer-a[bot],reviewer-b[bot]" \
  --out <RUN_DIR>/raw/<number>.json
```

Pass the same normalized roster to every collection command. Preserve collection warnings. An API failure is `collection_failed`; a successful empty result is an observed empty result; an unsupported or unavailable historical source is `not_measurable`.

Hash the finalized corpus and raw files into the manifest. If source evidence changes later, create a new run identity instead of overwriting the old run.

## 3. Blind review and adjudication

Run one isolated worker per PR where possible. Sequential fresh contexts are acceptable when delegation is unavailable.

The worker must write its cold findings before it may read `<RUN_DIR>/raw/<number>.json`. If it sees reviewer output, verdicts, comments, or discussion first, mark blind recall `not_measurable` for contamination.

After freezing the cold result, expose the raw reviewer evidence and have the worker:

- enumerate every distinct inline and summary claim;
- adjudicate each claim at its exact reviewed commit;
- cluster claims and cold findings by failure mechanism;
- calculate `introducedAt` and `fixedAt` from the PR commit history;
- record exactly which reviewers had an opportunity while the defect was live; and
- write `<RUN_DIR>/observations/prs/<number>.json`.

Unreachable force-pushed commits and ambiguous presence intervals remain explicit and are excluded from affected metrics. Never use current head as a substitute.

## 4. Skeptic and human-response passes

Give a fresh evaluator the targeted skeptic prompt in [references/agent-prompt.md](references/agent-prompt.md). It must independently inspect code for every conclusion-bearing negative claim. Record `upheld`, `revised`, `rejected`, or `not_run`. A claim with `not_run`, `revised`, or `rejected` cannot enter a headline metric in its original form.

Then record human response for every non-duplicate finding instance:

- fixed and verified in code;
- accepted in words;
- rejected with a reason;
- discussed without a clear result;
- fixed claimed but mechanism survives; or
- no observed engagement.

Distinguish human-authored PRs from agent-authored PRs. Summary-only findings are not individually replyable, so code changes and top-level discussion count as engagement evidence. Human response is supporting evidence, not ground truth and not another reviewer.

Write the engagement result to `<RUN_DIR>/observations/engagement/<number>.json`.

## 5. Validate and score

Run the scorer against the exact frozen PR list:

```bash
node <SKILL_DIR>/scripts/score-corpus.mjs \
  --dir <RUN_DIR>/observations/prs \
  --engagement <RUN_DIR>/observations/engagement \
  --prs "101,104,109" \
  --json <RUN_DIR>/aggregate.json \
  --out <RUN_DIR>/report.generated.md
```

Treat every reported data problem as a measurement problem, not a reviewer failure. Do not finalize a report whose declared PR observation is missing. Keep the generated aggregate and report with the manifest and observations.

## 6. Interpret without collapsing the questions

### Comparable quality

Rank only on the **common set**: defects every compared reviewer was eligible to catch. This gives every reviewer the same defects and denominator. Report confirmed and material recall with `n` and a confidence interval, plus incorrect and below-bar instances per PR.

If the common set is too small, trigger overlap is weak, or confidence intervals overlap materially, say the corpus cannot distinguish the reviewers. Do not let table sort order imply a statistically unsupported ranking.

### Installed value

Report separately:

- PR and commit coverage;
- review rounds per PR and time to first review;
- defects caught outside the common set;
- defects introduced after another reviewer's final run;
- confirmed, incorrect, and below-bar comments per PR;
- verified human fixes and explicit accept/reject outcomes;
- pairwise overlap and contested unique catches; and
- material defects every eligible reviewer missed.

Extra reruns can prevent more bugs and are operationally valuable. They are a coverage advantage the buyer may be able to purchase for any tool by changing its trigger, not evidence that the underlying reviewer reasons better.

Price and vendor-reported compute are optional customer-supplied inputs. Never invent them. A keep/change/cut recommendation must identify whether it rests on comparable quality, configured coverage, team response, redundancy, price, or an explicit combination chosen by the customer.

## 7. Report

Lead with what to keep, change, cut, or leave undecided. Put the two buyer questions in separate sections. Print the frozen population, roster decisions, exclusions, warnings, evaluator and method versions, unsupported delivery surfaces, incomplete observations, and measurement-state counts before conclusions that depend on them.

Always state:

- the audited defect set is a lower bound, not true recall;
- the evaluator is an LLM and may share a model family with a reviewed product;
- the defect definition excludes valuable categories such as maintainability, documentation, and speculative hardening unless the customer explicitly expands it before the run;
- no true-negative count exists, so specificity and F1 are unavailable; and
- a repository and time window do not establish how a reviewer will perform elsewhere or after its behavior changes.

The final recommendation is an evidence-backed decision, not an automatic weighted score. Where the evidence cannot separate reviewers, say so.
