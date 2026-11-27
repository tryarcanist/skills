# Method and data contract

Method: `installed-reviewer-audit-v3`. Manifest schema: `reviewer-audit-run-v3`.

## What the report measures

The report describes the customer's installed reviewers on declared PRs.
Extra review attempts are part of that configuration.
Common opportunities do not remove differences in attempts or reviewed commits.

This version does not produce an ordinal vendor rank or confidence intervals.

A qualifying defect is a reachable wrong output or violated contract introduced by the PR.
Style, docs, maintainability, speculative hardening and pre-existing defects are outside the default scope.
Out-of-scope advice can have value. It is not an incorrect claim.

The audited defect set is a lower bound.
A blind code review and confirmed reviewer claims contribute to it.
Neither the evaluator nor the skeptic establishes exhaustive defect discovery.

A skeptic pass does not measure independent agreement or evaluator accuracy.

## Population and collection

The collector includes PRs with reviewer publications inside the window.
It also includes PRs whose observed `updated_at` is inside that window, including silent PRs.
The start is inclusive. The end is exclusive.

This is an activity population, not every PR ever open during the period.
A PR updated after the window with no retained review event can be absent from this population.
State the membership rule in the report.

For an explicit PR list, the runner declares a convenience sample.
A complete run requires the full declared activity population.
Collection caps and failed reads prevent a complete population claim.

The runner retains later discussion as follow-up evidence.
It excludes out-of-window publications from counts.
A summary edited after the window cannot establish the earlier body.

Publication events are not review-run counts. Multiple publications can belong to one run.
An edited summary can represent multiple runs. Its historical first event is unknown.

## Roster

The optional roster file is an array:

```json
[
  {"id":"reviewer-a", "logins":["reviewer-a[bot]"], "state":"observed", "reason":"Publishes code review claims"},
  {"id":"reviewer-b", "logins":["reviewer-b[bot]"], "state":"not_measurable", "reason":"Uses an uncollected delivery surface"}
]
```

Use `observed`, `not_measurable`, or `collection_failed` for reviewer collection state.
Use the manifest's canonical `id` in price entries.
The scorer normalizes observation logins through the frozen alias map.

Missing data cannot become a zero-performance claim.

## Frozen sources

`prepare` writes `manifest.json`, `corpus.json`, `raw/`, `inputs/`, and observation templates.
The manifest records the selected population, reviewer roster, evaluator, method, scope, and source hashes.
`freeze-cold` adds an immutable cold result and its hash.

The scorer checks every frozen source before aggregation.
The report command saves hashes of the observations, outputs and scripts used for that report.
A correction to an observation requires a new report. New raw evidence requires a new run.

## Exact code evidence

Use full commit SHAs. An explicit native review pin or summary commit marker establishes a code identity.
A timestamp does not establish which commit a summary reviewed.
An unpinned claim remains `unverified` or `drifted` until exact evidence exists.

For each defect, list `presentAt` for commits where the evaluator verified the mechanism.
List `absentAt` for inspected commits where it is absent.
A commit in neither list has unknown presence.

Do not infer ancestry from author dates or committer dates.
`introducedAt` and `fixedAt` describe verified boundaries. Unknown boundaries remain explicit.
An unresolved boundary or absent presence evidence excludes affected opportunity metrics.

The first-event metric credits only a claim tied to the first identified publication event.
A later event on the same SHA receives no first-event credit.
An edited summary or ambiguous event attribution makes that metric unavailable.

It is a descriptive metric, not an equal-attempt experiment.

## Labels and duplicates

- `confirmed`: exact code evidence proves an in-scope defect.
- `below_bar`: an in-scope mechanism falls below the declared materiality bar.
- `incorrect`: exact evidence disproves the claim.
- `unverified`: available evidence cannot establish or refute the claim.
- `drifted`: the claim refers to another code state without a usable historical pin.
- `out_of_scope`: the claim belongs to an excluded category.
- `duplicate`: this reviewer repeated the same mechanism. Set `duplicateOf` to the original instance.

Deduplicate within and across reviewers by failure mechanism.
One corrected predicate, guard or value that resolves both claims is evidence for a shared defect.
Two claims are separate when one mechanism survives the other's fix.

Only confirmed, non-duplicate instances supply `foundBy` credit.
Copied reactions to another reviewer's claim do not establish an independent catch.

## Team response

A response can be `fixed`, `fixed_claimed_not_real`, `accepted`, `rejected`, `discussed`, or `none`.
Use `none` only after the relevant discussion and code evidence were inspected.
A missing entry stays unknown and does not enter the response denominator.
GitHub account type does not prove human authorship. A User account can run automation.

A resolved thread alone does not prove acceptance. A hidden thread alone does not prove rejection.
Team response supports usefulness. It cannot define correctness or causal bug prevention.

## Prices and savings

Supply monthly costs from the customer:

```json
{
  "currency":"USD",
  "reviewers":[
    {"reviewer":"reviewer-a", "monthlyCost":100, "avoidableMonthlyCost":80, "source":"Customer invoice and cancellation terms"}
  ]
}
```

The example values are synthetic.
`monthlyCost` is the actual current charge.
`avoidableMonthlyCost` is the portion the customer can remove through cancellation or a plan change.

Omit an unknown avoidable charge. Unknown does not mean zero.
Conditional annual savings equal 12 times the avoidable monthly charge.
Other reviewer charges must remain unchanged for this calculation.

The report lists observed unique catches at risk beside savings.
These catches do not predict future losses or assign money to a missed defect.
