# Adapting the skill to a repository

The defaults encode conventions: where tests live, what a fix title looks like, how a language writes a comment, how pull requests merge. On a repository that shares them the run is good. On one that does not, the failure is quiet — fewer candidates, more `null`, a thin bundle that looks exactly like a clean repository.

`preflight.mjs` finds those mismatches. This file is how you repair them, without editing skill code.

## Where the config lives

`review-cases.config.json`, looked up in this order:

1. `--config <path>`, on any script that takes it
2. `./review-cases.config.json`
3. `<repo-path>/review-cases.config.json`

A missing file is normal. An explicit `--config` that does not exist is an error. Every override is **additive** unless it says `Replace`, so an unfamiliar config cannot silently switch off a guard.

## The whole file

```json
{
  "paths": {
    "nonProductExtra": ["(^|/)legacy/", "(^|/)codegen/"],
    "product": ["(^|/)docs/site/src/"],
    "nonProductReplace": null
  },
  "languages": [
    { "ext": [".zig"], "line": ["//"], "block": [] },
    { "ext": [".jinja", ".j2"], "line": [], "block": [["{#", "#}"]] }
  ],
  "statementSignalExtra": "\\bwhen\\b|\\|>",
  "fixSignalsExtra": [
    { "name": "jira-defect", "weight": 3, "field": "title", "pattern": "^DEF-\\d+" },
    { "name": "incident-label", "weight": 4, "field": "label", "pattern": "^sev-[12]$" }
  ],
  "minBlockChars": 40
}
```

## What each key fixes

### `paths.product` — the one you will need most

Preflight reports what fraction of the tree the non-product filter excludes. If product code sits in a directory the filter catches — a documentation site whose source is the product, a `spec/` directory holding real modules, an `examples/` tree that ships — no bug there can **ever** become a case, and nothing else will tell you.

The allowlist wins over the default filter, so name the exception rather than disabling the rule:

```json
{ "paths": { "product": ["(^|/)docs/site/src/", "(^|/)src/spec/"] } }
```

### `paths.nonProductExtra` — generated or vendored trees the defaults miss

Anything whose blame names a code generator rather than an author. Adding to this loses nothing you wanted.

### `paths.nonProductReplace` — a last resort

Replaces the built-in filter entirely. Use it only when the repository's layout shares no conventions with the defaults, and say so in the report, because it turns off every path guard at once.

### `languages` — comment syntax for an unrecognised file type

Presence is decided by matching a block of code at the reviewed commit. If the skill cannot tell a comment from code in that language, a paragraph of prose can decide whether a reviewer saw a bug. An unknown extension falls back to masking every comment style at once, which loses usable needles rather than inventing them — safe, but it costs cases.

`line` markers comment to end of line. `block` pairs are `[open, close]`; a symmetric fence like `"""` is written `["\"\"\"", "\"\"\""]`. Block openers are matched before line markers, so a language like Lua where `--[[` opens a block and `--` starts a comment works correctly.

### `statementSignalExtra` — syntax that marks executable logic

Needles containing executable logic are preferred over needles that are only declarations, because a declaration the fix happened to touch is often not the mechanism. The built-in pattern covers C-family, Python, Go, Ruby, and Rust syntax. Add pipelines, pattern matches, or operators specific to the repository's languages here.

### `fixSignalsExtra` — how this repository names a fix

Fix scoring keys on English title words, bug labels, and linked issues. A repository whose pull requests are titled by ticket id alone scores near zero, and preflight will say so. `field` is `title`, `body`, or `label`; `weight` is added to the candidate's score.

### `minBlockChars` — how much code a needle must carry

Default 40. Lower it only on a repository of very terse code, and expect more false eligibility. Raising it is safe and loses cases.

## What config cannot fix

- **Rebase-merged repositories**, where the commits a reviewer read are rewritten and unreachable. Presence comes back `null`; there is no override. Preflight reports the merge strategy so you learn this before spending an afternoon.
- **Reviewers that publish only through check-run annotations.** Not collected at all. Such a reviewer is unmeasured, not silent — say so rather than recording a zero.
- **A repository with no merged fixes in the window.** Nothing to mine. Widen the window, or accept that this repository cannot produce shipped cases yet.
