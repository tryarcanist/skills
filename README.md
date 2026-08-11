# Arcanist skills

Public agent skills Arcanist uses to ship code.

These skills are written for coding agents (Claude Code, Codex, and similar). Copy a skill directory into your agent’s skills path, or clone this repo and point your agent at it.

## Skills

### `resolve-comments`

Handle every actionable PR review comment before merge.

- Reads unresolved inline threads and top-level conversation findings
- Dedupes exact duplicate feedback
- Fixes code, replies, or tracks out-of-scope work
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
