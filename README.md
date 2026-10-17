# Arcanist agent skills

Skills that let a coding agent (Claude Code, Codex, Cursor, and others that read `SKILL.md`) drive [Arcanist](https://tryarcanist.com) reviews.

| Skill | What it does |
| --- | --- |
| [`zeus-loop`](zeus-loop/SKILL.md) | Review a PR with Arcanist, fix every finding, push, and repeat until it says **Ready to merge**. Works with the `arcanist` CLI or with `gh` alone. |

## Install

Claude Code:

```bash
git clone https://github.com/tryarcanist/skills ~/.arcanist-skills
mkdir -p ~/.claude/skills && ln -s ~/.arcanist-skills/zeus-loop ~/.claude/skills/zeus-loop
```

Codex: link the same folder into `~/.codex/skills/`. Then ask the agent to "run the zeus loop on this PR".

## Requirements

- `node` 22 or newer, and an authenticated `gh` CLI.
- Arcanist installed on the repository.
- Optional: `npm install -g @tryarcanist/cli` and `arcanist auth login`. With the CLI the loop reads findings straight from Arcanist; without it the loop uses the PR comment trigger and the `Arcanist review` check.

## Try one review without the loop

```bash
node zeus-loop/scripts/zeus-review.mjs https://github.com/<owner>/<repo>/pull/<n>
```

Exit code 0 means no blocking finding, 1 means Arcanist says hold off, 2 a tool error, 3 a timeout.
