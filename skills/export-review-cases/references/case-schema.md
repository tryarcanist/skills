# Case file schema

One JSON file per case, written to `<RUN_DIR>/cases/<caseId>.json`.

**Do not write one by hand.** `emit-case-stub.mjs` fills every mechanical field from the trace or reviews file and leaves the judgement fields as `TODO:` strings. Replace those; keep the rest.

`build-bundle.mjs` validates every file for shape, then re-checks the factual fields against git and GitHub, and refuses the ones that cannot support their own claim. It also refuses any field still holding a generated `TODO:` placeholder, at any depth.

```json
{
  "schemaVersion": "review-case-v1",
  "caseId": "missed-12904-disclosure-mismatch",
  "repo": "owner/repo",
  "reviewer": "reviewer[bot]",
  "verdict": "missed",
  "resolution": "fixed",
  "resolutionEvidence": null,
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
    "quotes": [],
    "publishedItems": [
      {
        "id": "inline-3894866990",
        "kind": "inline",
        "url": "https://github.com/owner/repo/pull/12904#discussion_r3894866990",
        "path": "src/app/persistence.py",
        "line": 88,
        "reviewedCommit": "e41d7559...",
        "excerpt": "First 600 characters of what the reviewer actually said here.",
        "bodyTruncated": false
      }
    ]
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
  "skeptic": { "ran": true, "verdict": "upheld", "note": "What the skeptic checked and found." },
  "provenance": { "trace": "<RUN_DIR>/origins/13283.json", "buggyBlock": {}, "rejectedBlocks": [], "presenceReason": null }
}
```

## Field notes

**`resolution`** is `fixed`, `acknowledged`, `deferred`, or `none`, and it decides what proof of repair is required. A finding repaired before merge is genuinely `fixed`: set `fixedInSamePr: true` and `fix.commit` to the commit that repaired it, and leave `fix.pr` null. A **missed** case must be `fixed` — the merged fix is the only proof the bug was real, so there is no such thing as an unfixed missed case in this bundle. A **caught** case may be `acknowledged` or `deferred`: a reviewer finding that the author agreed with and filed a ticket for is a real catch even though nothing merged. Anything other than `fixed` needs `resolutionEvidence` naming who agreed and where. Do not point `fix.pr` at the pull request the finding was published on to satisfy the field; that corrupts what `fix` means across the whole bundle. Use `fixedInSamePr: true` when the finding was genuinely repaired before merge.

**`reviewerOutputAtThatCommit.publishedItems`** is what the reviewer actually said at that commit. A missed case has no `quotes` by definition, so without this the bundle carries no evidence of what the reviewer was doing instead — and "it commented three times on this file about something else" is the single most useful sentence you can hand a vendor. `emit-case-stub.mjs` fills it. If `bodyTruncated` is true on any item, refetch that comment before concluding the reviewer did not name the mechanism.

**`provenance`** carries the machine evidence the verdict rests on, including the `buggyBlock` used as the presence needle and any `rejectedBlocks`. The bundler re-runs the presence test against `buggyBlock` before exporting, so do not edit it. Its `needleKind` matters: `declaration` means presence may be exactly right while the block is not the mechanism. Look at the block before trusting the verdict: if the needle is not code you would call the bug, the origin is probably wrong even when the tooling said `true`.

**`verdict`** is `missed` or `caught` to publish. Use `not_eligible` when the reviewer never had the code, and `not_a_bug` when the fix repaired something that was not a defect. Both are recorded and neither is exported — writing them down is what keeps the rejection count honest.

**`presenceMethod`** says how you established that the buggy lines were there when the reviewer ran. `ancestry` and `content` come from `trace-origin.mjs`. `manual` means you established it by reading the code yourself, and the case must say how.

**`reviewerOutputAtThatCommit.namedTheMechanism`** is the whole verdict, so answer it against the mechanism rather than the topic. A reviewer that commented on the same function about a different failure did not name this mechanism. A reviewer that described this failure in different words did.

**`quotes`** carries the reviewer's own sentences. Required for `caught`, because a catch that cannot be quoted is a claim about a reviewer rather than a record of one.

**`bug.boundary`** is the most useful field in the bundle for a vendor and the easiest to fill in lazily. It says how far apart the two facts sat that had to be held together to see the bug. A bug visible inside one function is a different failure from one that needs a caller in another service, and a set that does not distinguish them cannot show a reviewer where its reach ends.

**`whatWouldHaveCaughtIt`** must name an act, not an attitude. "Run the migration against a row with a null tenant" is useful. "Be more careful" is not.

**`confidence`** is `high` when the origin, the presence test, and the fix all agree; `medium` when one link rests on judgement; `low` when it rests on two. Send `low` cases only if they are labelled.
