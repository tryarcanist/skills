# Arcanist skills

Public agent skills Arcanist uses to ship code.

These skills are written for coding agents (Claude Code, Codex, and similar). Copy a skill directory into your agent’s skills path, or clone this repo and point your agent at it.

## Skills

### `audit-code-reviewers`

Compare every AI code reviewer active on a GitHub repository and decide which are worth keeping.

- The audit pins each finding to the exact commit that the reviewer saw.
- The audit looks for defects before it reads reviewer output.
- The quality comparison uses only defects that every reviewer could have caught.
- The report separates review quality from trigger coverage and rerun frequency.
- The report measures wrong claims, nitpicks, human response, latency, and overlap.
- Each run produces a local manifest, structured observations, an aggregate, and a report.
- The skill only requires authenticated `gh`, `git`, and Node.js.

**Install (Claude Code):**

```bash
mkdir -p .claude/skills
cp -R skills/audit-code-reviewers .claude/skills/
```

**Install (Codex):**

```bash
mkdir -p .agents/skills
cp -R skills/audit-code-reviewers .agents/skills/
```

**Run:**

```text
/audit-code-reviewers owner/repo --since "90 days ago"
```

### `export-review-cases`

Build a shareable set of paired pull requests: a bug that shipped past an AI code reviewer, and the later pull request that fixed it — alongside the bugs the reviewer did catch.

- A preflight step reports whether the skill's assumptions fit your repository before you trust its output.
- Conventions it gets wrong — where tests live, how fixes are titled, how a language writes a comment — are fixed in a config file, not in skill code.
- The set is mined backwards from merged fixes, so it can surface bugs no reviewer ever mentioned.
- Each missed case names the exact commit the reviewer read and proves the buggy lines already existed there.
- Presence is established by commit ancestry or by verbatim content, so squash-merge repositories work too.
- Tests, fixtures, comments and imports cannot decide whether a reviewer saw a bug.
- "The reviewer read this and the bug was not there" and "nothing is known" stay separate answers.
- The window is collected completely rather than truncated to its most recent days.
- Cases are generated as stubs from the evidence, not written by hand.
- A second reader has to try to overturn every case, and the bundler re-checks each one against the code before export.
- Source patches are opt-in, and scoped to the files each case names.
- The bundle is a lower bound on what happened, not a recall measurement, and it says so.
- The skill only requires authenticated `gh`, `git`, and Node.js, run from a full clone.

**Install (Claude Code):**

```bash
mkdir -p .claude/skills
cp -R skills/export-review-cases .claude/skills/
```

**Install (Codex):**

```bash
mkdir -p .agents/skills
cp -R skills/export-review-cases .agents/skills/
```

**Run:**

```text
/export-review-cases owner/repo --since 2026-08-01 --until 2026-09-01
```

Start with the preflight, which tells you how well the defaults suit the repository:

```bash
node skills/export-review-cases/scripts/preflight.mjs \
  --repo owner/repo --since 2026-08-01 --until 2026-09-01 --repo-path .
```

Requires authenticated `gh` with read access to the target repository. The audit is read-only and does not trigger reviews or modify pull requests.

### `resolve-comments`

Handle every actionable PR review comment before merge.

- Reads unresolved inline threads and top-level conversation findings
- Dedupes exact duplicate feedback
- Fixes code, replies, or tracks out-of-scope work
- Assesses whether Zeus's inline agent prompts are complete handoffs for another coding agent
- Resolves threads and labels the PR when the run is complete
- Works with human reviewers and bots, including [Zeus](https://tryarcanist.com) (`@arcanist /review`)

**Install (Claude Code):**

```bash
mkdir -p .claude/skills
cp -R skills/resolve-comments .claude/skills/
```

**Run:**

```text
/resolve-comments
/resolve-comments 123
/resolve-comments https://github.com/owner/repo/pull/123
```

Requires authenticated `gh` with write access to the PR branch.

## Principles

- One skill does one job.
- Prefer exact commands and failure modes over vague guidance.
- Zeus and other bot reviewers are first-class feedback sources.
- Graphite is optional for skills that need stacks; this first skill needs only GitHub.

## License

MIT
