# Portable measurement method

Method version: `reviewer-audit-v2`

## Unit and identity

The unit of observation is one pull request. The unit of comparison is one deduplicated defect present during a known interval of that pull request's commit history.

A run identity is determined by:

- repository;
- inclusive start and exclusive end timestamps;
- window membership field;
- mode and, for a sample, its population, rule, seed, and strata;
- frozen PR numbers;
- normalized reviewer roster and aliases;
- collector and scorer versions;
- method, schema, prompt, and report versions;
- evaluator provider, model, and relevant settings; and
- hashes of the frozen corpus and raw evidence files.

Do not combine observations from different run identities. A correction creates a new run or an explicitly superseding observation; it does not silently replace evidence behind a published aggregate.

## Manifest

Write `manifest.json` before adjudication. Use this minimum shape:

```json
{
  "schemaVersion": "reviewer-audit-run-v2",
  "methodVersion": "reviewer-audit-v2",
  "repo": "owner/repo",
  "mode": "complete",
  "window": {
    "field": "review_comment_created_at",
    "from": "2026-01-01T00:00:00Z",
    "toExclusive": "2026-02-01T00:00:00Z",
    "timezone": "UTC"
  },
  "populationPrs": [1, 2, 3],
  "selectedPrs": [1, 2, 3],
  "sample": null,
  "reviewers": [
    {"id": "reviewer-a", "logins": ["reviewer-a[bot]"], "decision": "include", "reason": "publishes code-correctness claims"}
  ],
  "excludedIdentities": [],
  "excludedPrs": [],
  "collectorWarnings": [],
  "deliverySurfaces": [
    {"reviewer": "reviewer-a", "surface": "pull_request_review", "state": "observed"}
  ],
  "evaluator": {
    "provider": "unknown",
    "model": "unknown",
    "settings": {},
    "promptVersion": "reviewer-audit-v2"
  },
  "sourceHashes": {},
  "capturedAt": "2026-02-02T00:00:00Z"
}
```

For `sample` mode, `populationPrs` contains every eligible PR and `selectedPrs` contains the audited subset. `sample` records the deterministic selection algorithm, seed, and counts by declared stratum. A convenience sample is allowed only when named as such and must not produce repository-wide keep/cut claims.

## Measurement states

Every absent or incomplete measurement uses one of these states:

| State | Meaning |
| --- | --- |
| `observed` | Read successfully from the named source. An observed empty list is valid. |
| `derived` | Calculated from observed evidence using the declared method. |
| `not_measurable` | Required historical evidence was unavailable or the delivery surface is unsupported. |
| `collection_failed` | The evidence should have been available, but collection failed. |
| `not_applicable` | The measurement does not apply to this PR or reviewer. |

Do not convert the last three states to zero. Aggregates report the number of PRs and reviewer opportunities in every state.

## Defect universe

The audited set is the union of:

1. defects found by a blind evaluator before reviewer output is visible; and
2. reviewer candidates that survive symmetric adjudication.

It is a lower bound. Call metrics “recall against the audited set,” never true recall.

The default qualifying defect is a reachable wrong output or violated contract introduced by the PR. The user may expand this definition before the run, but the expanded categories must appear in the manifest and apply equally to every reviewer. Do not change the definition after seeing results.

## Exact-head and presence rules

Judge a finding at the commit the reviewer reviewed. A defect is eligible for a reviewer when:

1. its mechanism is present at one or more exact commits the reviewer demonstrably reviewed;
2. it had not yet been fixed at those commits; and
3. the evidence needed to order those commits is measurable.

`introducedAt` is the earliest PR commit containing the mechanism, not the first comment about it. `fixedAt` is the first commit resolving the mechanism. When a force push makes a needed object unreachable, mark the affected interval `not_measurable` rather than reading current head.

The collector cannot always observe silent successful review runs. Published review evidence proves a run; absence of publication does not prove no run. State this limitation and avoid charging silent reviewers with opportunities that cannot be established.

## Finding and defect labels

Use these instance results:

- `confirmed`: exact-head code establishes the qualifying defect;
- `below_bar`: the mechanism is real but does not meet the declared review bar;
- `incorrect`: exact-head evidence disproves the claim;
- `duplicate`: the same reviewer repeated the same mechanism or copied it between inline and summary output;
- `unverified`: reachable evidence cannot establish or refute the claim;
- `drifted`: the claim concerns a different head or code state and cannot be compared; and
- `out_of_scope`: the claim belongs to a category excluded by the frozen defect definition.

Only `confirmed` instances create or match defects. Keep `below_bar`, `incorrect`, `unverified`, `drifted`, and `out_of_scope` separate in the cost profile.

## Common-set comparison

The primary quality comparison uses defects every included reviewer was eligible to catch. Every reviewer receives the same defect set and denominator.

Report separately:

- confirmed common-set recall;
- material common-set recall;
- one-pass or first-look common-set recall when measurable;
- Wilson 95% intervals and raw numerator/denominator; and
- common-set size as a share of the complete audited set.

Opportunity-adjusted recall against each reviewer's own eligible defects is useful diagnostic information but not a cross-reviewer ranking. Place it below an explicit “not comparable” divider.

## Negative-claim control

A fresh evaluator must independently inspect every proposed:

- material miss;
- incorrect or below-bar finding used in a verdict;
- unique catch;
- blocking or major severity;
- introduced or fixed boundary that changes eligibility; and
- merge or split that changes reviewer credit.

Record `upheld`, `revised`, `rejected`, or `not_run` with exact commit and file evidence. Only the upheld or revised result enters the aggregate. Do not manufacture disagreement; an empty change list is valid.

## Human response

Human response can corroborate usefulness but cannot define correctness. Record whether a human fixed, accepted, rejected, discussed, or ignored each non-duplicate instance. Verify claimed fixes in code. Separate human-authored and agent-authored PRs, and record whether the original finding was individually replyable.

## Data sufficiency

Do not publish an ordinal quality ranking when any of these apply:

- fewer than 12 common-set opportunities;
- material confidence intervals overlap enough that the order is unstable;
- one or more reviewers have an uncollected primary delivery surface;
- exact reviewed commits or presence intervals are missing at a conclusion-changing rate;
- required PR observations are incomplete; or
- a sample does not support repository-wide inference.

Report the evidence and say the reviewers are indistinguishable or the comparison is not measurable.
