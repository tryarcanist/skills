# Case file schema

One JSON file per case, written to `<RUN_DIR>/cases/<caseId>.json`. `build-bundle.mjs` validates every file and refuses the ones that cannot support their own claim.

```json
{
  "schemaVersion": "review-case-v1",
  "caseId": "missed-12904-disclosure-mismatch",
  "repo": "owner/repo",
  "reviewer": "reviewer[bot]",
  "verdict": "missed",
  "confidence": "high",

  "bug": {
    "summary": "One line. What goes wrong, in the product's own vocabulary.",
    "mechanism": "The specific code path. Name the predicate, guard, or value that is wrong.",
    "trigger": "The input or state that reaches it. Concrete, not 'in some cases'.",
    "wrongOutput": "What the user, caller, or stored record actually gets.",
    "severity": "blocking | major | minor | nit",
    "class": "correctness | race | authz | data-money | perf | error-handling | api-contract | tests | other",
    "boundary": "single-file | cross-function | cross-module | cross-service | infra-config"
  },

  "origin": {
    "pr": 12904,
    "url": "https://github.com/owner/repo/pull/12904",
    "sha": "cc20909d5f...",
    "path": "src/app/persistence.py",
    "paths": ["src/app/persistence.py"],
    "lines": [74, 105]
  },

  "reviewedAt": {
    "commit": "e41d7559...",
    "reviewer": "reviewer[bot]",
    "publishedAt": "2026-08-20T11:04:00Z",
    "presenceMethod": "ancestry | content | manual"
  },

  "reviewerOutputAtThatCommit": {
    "published": true,
    "namedTheMechanism": false,
    "quotes": []
  },

  "fix": {
    "pr": 13283,
    "url": "https://github.com/owner/repo/pull/13283",
    "mergeCommit": "1d7590a...",
    "mergedAt": "2026-08-26T09:12:00Z",
    "summary": "What the fix changed, in one line.",
    "paths": ["src/app/persistence.py"]
  },

  "whatWouldHaveCaughtIt": "The concrete act: running the endpoint, reading the other caller, diffing the two code paths.",
  "skeptic": { "ran": true, "verdict": "upheld", "note": "What the skeptic checked and found." }
}
```

## Field notes

**`verdict`** is `missed` or `caught` to publish. Use `not_eligible` when the reviewer never had the code, and `not_a_bug` when the fix repaired something that was not a defect. Both are recorded and neither is exported — writing them down is what keeps the rejection count honest.

**`presenceMethod`** says how you established that the buggy lines were there when the reviewer ran. `ancestry` and `content` come from `trace-origin.mjs`. `manual` means you established it by reading the code yourself, and the case must say how.

**`reviewerOutputAtThatCommit.namedTheMechanism`** is the whole verdict, so answer it against the mechanism rather than the topic. A reviewer that commented on the same function about a different failure did not name this mechanism. A reviewer that described this failure in different words did.

**`quotes`** carries the reviewer's own sentences. Required for `caught`, because a catch that cannot be quoted is a claim about a reviewer rather than a record of one.

**`bug.boundary`** is the most useful field in the bundle for a vendor and the easiest to fill in lazily. It says how far apart the two facts sat that had to be held together to see the bug. A bug visible inside one function is a different failure from one that needs a caller in another service, and a set that does not distinguish them cannot show a reviewer where its reach ends.

**`whatWouldHaveCaughtIt`** must name an act, not an attitude. "Run the migration against a row with a null tenant" is useful. "Be more careful" is not.

**`confidence`** is `high` when the origin, the presence test, and the fix all agree; `medium` when one link rests on judgement; `low` when it rests on two. Send `low` cases only if they are labelled.
