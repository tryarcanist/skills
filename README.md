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
