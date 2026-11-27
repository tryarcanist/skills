# Arcanist agent skills

Skills that let a coding agent (Claude Code, Codex, Cursor, and others that read `SKILL.md`) drive [Arcanist](https://tryarcanist.com) reviews.

| Skill | What it does |
| --- | --- |
| [`arcanist-review-loop`](arcanist-review-loop/SKILL.md) | Review a PR with Arcanist, fix every finding, push, and repeat until it says **Ready to merge**. Works with the `arcanist` CLI or with `gh` alone. |

## Audit your code reviewers

The [`audit-code-reviewers`](audit-code-reviewers/SKILL.md) skill compares verified catches, false positives, overlap, and gaps in your review history. It creates a local report with evidence links. It uses GitHub read access and your coding agent. No Arcanist account is required.

Give your coding agent this prompt with your repository open:

> Audit the code reviewers on this repository. Read https://www.tryarcanist.com/audit.md and follow the instructions.

The agent installs through the Arcanist CLI:

```bash
npx --yes @tryarcanist/cli@latest audit --json
```

The command installs into both `.agents/skills/audit-code-reviewers` and `.claude/skills/audit-code-reviewers` in the current project. No agent selector is needed. Use `--agent codex`, `--agent cursor`, or `--agent claude` to select one location.

The JSON response includes `auditStatus: "not_started"` and `nextAction`. The agent reads `nextAction.path` and follows the skill to complete the audit. The CLI installs the skill; the coding agent performs the analysis.

Try the synthetic report without GitHub access or model calls:

```bash
node audit-code-reviewers/scripts/demo.mjs --out /tmp/reviewer-audit-demo
node --test audit-code-reviewers/tests/integration.test.mjs
```

Use a new output directory for each demo.

## Install the review loop

Claude Code:

```bash
git clone https://github.com/tryarcanist/skills ~/.arcanist-skills
mkdir -p ~/.claude/skills && ln -s ~/.arcanist-skills/arcanist-review-loop ~/.claude/skills/arcanist-review-loop
```

Codex: link the same folder into `~/.codex/skills/`. Then ask the agent to "run the Arcanist review loop on this PR".

Devin and Cursor read `~/.agents/skills/<name>/SKILL.md`:

```bash
git clone https://github.com/tryarcanist/skills ~/.arcanist-skills
mkdir -p ~/.agents/skills && ln -s ~/.arcanist-skills/arcanist-review-loop ~/.agents/skills/arcanist-review-loop
```

To run the loop on every PR the agent opens, add an always-on rule to the repository, `.windsurf/rules/arcanist.md` (Devin) or `.cursor/rules/arcanist.md` (Cursor):

```markdown
After you open or update a pull request on this repository, run the `arcanist-review-loop` skill. Merge when it reports Ready to merge.
```

The loop merges only when the rule or the person says so.

## Requirements

- `node` 22 or newer, and an authenticated `gh` CLI.
- Arcanist installed on the repository.
- Optional: `npm install -g @tryarcanist/cli` and `arcanist auth login`. With the CLI the loop reads findings straight from Arcanist; without it the loop uses the PR comment trigger and the `Arcanist review` check.

## Try one review without the loop

```bash
node arcanist-review-loop/scripts/arcanist-review.mjs https://github.com/<owner>/<repo>/pull/<n>
```

Exit code 0 means no blocking finding, 1 means Arcanist says hold off, 2 a tool error, 3 a timeout.
