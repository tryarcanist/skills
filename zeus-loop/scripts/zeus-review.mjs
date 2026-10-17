#!/usr/bin/env node
// Run one Arcanist review on a pull request and print the result as JSON.
//
// Backends:
//   cli  - `arcanist review <pr> --wait --json` (needs the arcanist CLI, logged in)
//   gh   - `gh` only: comment `@<app> /review`, poll the "Arcanist review" check, read the summary and threads
//   auto - cli when `arcanist auth whoami` works, else gh (default)
//
// Output (stdout, one JSON object):
//   { backend, repo, pr, headSha, verdict, headline, blocking, findings: [{ file, line, title, body, blocksMerge, threadId }] }
// Exit codes: 0 no blocking finding, 1 blocking finding, 2 usage or tool error, 3 timeout.

import { execFileSync, spawnSync } from "node:child_process";

const APPS = {
  // REST reports the bot as "arcanist[bot]"; GraphQL reports it as "arcanist". `botLogin` matches both.
  arcanist: { bot: "arcanist[bot]", check: "Arcanist review", marker: "arcanist-zeus:v1", mention: "@tryarcanist /review" },
  "arcanist-qa": { bot: "arcanist-qa[bot]", check: "Arcanist review (qa)", marker: "arcanist-zeus-qa:v1", mention: "@arcanist-qa /review" },
};
const HOLD_HEADLINE = "Hold off on merging";

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write(
    "usage: zeus-review.mjs [<pr-url|number>] [--repo owner/repo] [--backend auto|cli|gh] [--app arcanist|arcanist-qa] [--timeout seconds] [--interval seconds] [--no-trigger]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { backend: "auto", app: "arcanist", timeout: 1800, interval: 30, trigger: true };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") out.repo = argv[(i += 1)];
    else if (arg === "--backend") out.backend = argv[(i += 1)];
    else if (arg === "--app") out.app = argv[(i += 1)];
    else if (arg === "--timeout") out.timeout = Number(argv[(i += 1)]);
    else if (arg === "--interval") out.interval = Number(argv[(i += 1)]);
    else if (arg === "--no-trigger") out.trigger = false;
    else if (arg.startsWith("--")) usage(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  if (!["auto", "cli", "gh"].includes(out.backend)) usage("--backend must be auto, cli, or gh");
  if (!APPS[out.app]) usage("--app must be arcanist or arcanist-qa");
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) usage("--timeout must be a positive number");
  if (!Number.isFinite(out.interval) || out.interval <= 0) usage("--interval must be a positive number");
  out.pr = positional[0];
  return out;
}

function run(cmd, args, { allowFailure = false } = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    if (allowFailure) return null;
    usage(`${cmd} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) return null;
    process.stderr.write(result.stderr ?? "");
    usage(`${cmd} ${args[0]} exited ${result.status}`);
  }
  return result.stdout;
}

function gh(args) {
  return run("gh", args);
}

function resolvePr(input, repoFlag) {
  const match = input ? /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(input) : null;
  if (match) return { repo: match[1].replace(/\.git$/, ""), pr: Number(match[2]) };
  const viewArgs = ["pr", "view", ...(input ? [input] : []), ...(repoFlag ? ["--repo", repoFlag] : []), "--json", "number,url"];
  const view = JSON.parse(gh(viewArgs));
  const fromUrl = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(view.url);
  return { repo: fromUrl[1], pr: view.number };
}

function headSha(repo, pr) {
  return JSON.parse(gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"])).headRefOid;
}

function cliAvailable() {
  return run("arcanist", ["auth", "whoami", "--json"], { allowFailure: true }) !== null;
}

function sleep(seconds) {
  // Synchronous sleep keeps the script dependency-free and simple to read.
  execFileSync("sleep", [String(seconds)]);
}

// Strip the folded "Agent prompt" block Zeus appends: it is presentation, not part of the finding.
function cleanFindingBody(body) {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .trim();
}

function titleOf(body) {
  const bold = /\*\*(.+?)\*\*/.exec(body);
  return bold ? bold[1].trim() : body.split("\n")[0].trim();
}

function botLogin(login) {
  return String(login ?? "").replace(/\[bot\]$/, "");
}

function unresolvedThreads(repo, pr, bot) {
  const [owner, name] = repo.split("/");
  const query = `
    query($owner: String!, $name: String!, $pr: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id isResolved path line originalLine
              comments(first: 1) { nodes { author { login } body } }
            }
          }
        }
      }
    }`;
  const threads = [];
  let after = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `pr=${pr}`];
    if (after) args.push("-F", `after=${after}`);
    const page = JSON.parse(gh(args)).data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return threads
    .filter((thread) => !thread.isResolved && botLogin(thread.comments.nodes[0]?.author?.login) === botLogin(bot))
    .map((thread) => {
      const body = cleanFindingBody(thread.comments.nodes[0].body);
      return { file: thread.path, line: thread.line ?? thread.originalLine ?? null, title: titleOf(body), body, threadId: thread.id };
    });
}

function summaryFor(repo, pr, app, sha) {
  const comments = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments`])).flat();
  const markerRe = new RegExp(`<!-- ${app.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} [^>]*head=${sha} verdict=(\\w+) -->`);
  for (const comment of comments.reverse()) {
    if (comment.user?.login !== app.bot) continue;
    const match = markerRe.exec(comment.body ?? "");
    if (!match) continue;
    const headline = /^## (.+?)(?: <a |$)/m.exec(comment.body)?.[1]?.trim() ?? null;
    return { verdict: match[1], headline };
  }
  return null;
}

function completedCheck(repo, sha, app) {
  const out = gh([
    "api",
    `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(app.check)}&per_page=100`,
    "--jq",
    `.check_runs[] | select(.name=="${app.check}" and .status=="completed") | .conclusion`,
  ]).trim();
  return out.length > 0 ? out.split("\n")[0] : null;
}

function reviewViaGh(repo, pr, options) {
  const app = APPS[options.app];
  const sha = headSha(repo, pr);
  const deadline = Date.now() + options.timeout * 1000;
  if (!completedCheck(repo, sha, app) && options.trigger) {
    gh(["pr", "comment", String(pr), "--repo", repo, "--body", app.mention]);
    process.stderr.write(`posted "${app.mention}" on ${repo}#${pr} head ${sha.slice(0, 7)}\n`);
  }
  let conclusion = completedCheck(repo, sha, app);
  while (!conclusion) {
    if (Date.now() > deadline) {
      process.stderr.write(`timed out after ${options.timeout}s waiting for "${app.check}" on ${sha.slice(0, 7)}\n`);
      process.exit(3);
    }
    process.stderr.write(`waiting for "${app.check}" on ${sha.slice(0, 7)}\n`);
    sleep(options.interval);
    conclusion = completedCheck(repo, sha, app);
  }
  // The summary comment lands right after the check completes; give it a few polls.
  let summary = summaryFor(repo, pr, app, sha);
  for (let attempt = 0; !summary && attempt < 6; attempt += 1) {
    sleep(10);
    summary = summaryFor(repo, pr, app, sha);
  }
  const findings = unresolvedThreads(repo, pr, app.bot);
  const headline = summary?.headline ?? null;
  const blocking = headline === HOLD_HEADLINE || (headline === null && conclusion === "action_required");
  return {
    backend: "gh",
    repo,
    pr,
    headSha: sha,
    verdict: summary?.verdict ?? (conclusion === "success" ? "clear" : "unknown"),
    headline,
    blocking,
    findings: findings.map((finding) => ({ ...finding, blocksMerge: blocking })),
  };
}

function reviewViaCli(repo, pr) {
  const url = `https://github.com/${repo}/pull/${pr}`;
  const result = spawnSync("arcanist", ["review", url, "--wait", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) usage(`arcanist failed to start: ${result.error.message}`);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(result.stderr ?? "");
    usage(`arcanist review exited ${result.status} without JSON`);
  }
  if (payload.error) usage(`arcanist review: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  const findings = payload.findings ?? [];
  const blocking = findings.some((finding) => finding.blocksMerge === true);
  // Thread ids come from GitHub so the loop can resolve them after a fix.
  const threads = unresolvedThreads(repo, pr, APPS.arcanist.bot);
  const threadFor = (finding) =>
    threads.find((thread) => thread.file === finding.file && (thread.line === finding.line || thread.title === finding.title))?.threadId ?? null;
  return {
    backend: "cli",
    repo,
    pr,
    headSha: payload.headSha ?? headSha(repo, pr),
    verdict: payload.verdict ?? "unknown",
    headline: blocking ? HOLD_HEADLINE : "Ready to merge",
    blocking,
    findings: findings.map((finding) => ({
      file: finding.file,
      line: finding.line ?? null,
      title: finding.title,
      body: finding.body,
      blocksMerge: finding.blocksMerge === true,
      nit: finding.nit === true,
      threadId: threadFor(finding),
    })),
  };
}

const options = parseArgs(process.argv.slice(2));
const { repo, pr } = resolvePr(options.pr, options.repo);
const backend = options.backend === "auto" ? (options.app === "arcanist" && cliAvailable() ? "cli" : "gh") : options.backend;
if (backend === "cli" && options.app !== "arcanist") usage("the cli backend reviews with the production app only; drop --app or use --backend gh");
const result = backend === "cli" ? reviewViaCli(repo, pr) : reviewViaGh(repo, pr, options);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exitCode = result.blocking ? 1 : 0;
