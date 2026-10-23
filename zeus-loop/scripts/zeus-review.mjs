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
//
// --no-trigger  wait for a review that is already running instead of asking for one.
// --any-head    accept the latest published review on an earlier commit of the PR (Arcanist reviews
//               a PR on open and does not re-review every push); the result names the reviewed head.
// --app arcanist-qa targets Arcanist's QA deployment. With the cli backend that needs
//               ARCANIST_API_URL pointing at the QA host and a matching ARCANIST_TOKEN.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APPS = {
  // REST reports the bot as "arcanist[bot]"; GraphQL reports it as "arcanist". `botLogin` matches both.
  arcanist: {
    bot: "arcanist[bot]",
    check: "Arcanist review",
    marker: "arcanist-zeus:v1",
    mention: "@tryarcanist /review",
  },
  "arcanist-qa": {
    bot: "arcanist-qa[bot]",
    check: "Arcanist review (qa)",
    marker: "arcanist-zeus-qa:v1",
    mention: "@arcanist-qa /review",
  },
};
const HOLD_HEADLINE = "Hold off on merging";

const USAGE =
  "usage: zeus-review.mjs [<pr-url|number>] [--repo owner/repo] [--backend auto|cli|gh] [--app arcanist|arcanist-qa] [--timeout seconds] [--interval seconds] [--no-trigger] [--any-head]\n";

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { backend: "auto", app: "arcanist", timeout: 1800, interval: 30, trigger: true, anyHead: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (arg === "--repo") out.repo = argv[(i += 1)];
    else if (arg === "--backend") out.backend = argv[(i += 1)];
    else if (arg === "--app") out.app = argv[(i += 1)];
    else if (arg === "--timeout") out.timeout = Number(argv[(i += 1)]);
    else if (arg === "--interval") out.interval = Number(argv[(i += 1)]);
    else if (arg === "--no-trigger") out.trigger = false;
    else if (arg === "--any-head") out.anyHead = true;
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
  const viewArgs = [
    "pr",
    "view",
    ...(input ? [input] : []),
    ...(repoFlag ? ["--repo", repoFlag] : []),
    "--json",
    "number,url",
  ];
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
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `pr=${pr}`,
    ];
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
      return {
        file: thread.path,
        line: thread.line ?? thread.originalLine ?? null,
        title: titleOf(body),
        body,
        threadId: thread.id,
      };
    });
}

function summaryFromComment(comment, app, sha, anyHead) {
  if (comment.user?.login !== app.bot) return null;
  const body = comment.body ?? "";
  const marker = app.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactRe = new RegExp(`<!-- ${marker} [^>]*head=${sha} verdict=(\\w+) -->`);
  const anyRe = new RegExp(`<!-- ${marker} [^>]*head=([0-9a-f]+) verdict=(\\w+) -->`);
  const exact = exactRe.exec(body);
  const any = anyHead ? anyRe.exec(body) : null;
  const match = exact ?? any;
  if (!match) return null;
  const verdict = exact ? exact[1] : any[2];
  const head = exact ? sha : any[1];
  const headline = /^## (.+?)(?: <a |$)/m.exec(body)?.[1]?.trim() ?? null;
  return { verdict, headline, head };
}

function summaryFor(repo, pr, app, sha, anyHead = false) {
  const comments = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments`])).flat();
  for (const comment of comments.reverse()) {
    const summary = summaryFromComment(comment, app, sha, anyHead);
    if (summary) return summary;
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

// The reviewed sha and its conclusion, or null. With anyHead and no check on the current head, the
// head named in the latest summary comment wins: it survives a rebase, and a stack parent's own
// check on an ancestor commit never stands in for this PR's review.
function findCompleted(repo, pr, head, app, anyHead) {
  const conclusion = completedCheck(repo, head, app);
  if (conclusion) return { sha: head, conclusion };
  if (!anyHead) return null;
  const published = summaryFor(repo, pr, app, head, true);
  if (!published) return null;
  return { sha: published.head, conclusion: completedCheck(repo, published.head, app) ?? "published" };
}

function reviewViaGh(repo, pr, options) {
  const app = APPS[options.app];
  const head = headSha(repo, pr);
  const deadline = Date.now() + options.timeout * 1000;
  let done = findCompleted(repo, pr, head, app, options.anyHead);
  if (!done && options.trigger) {
    gh(["pr", "comment", String(pr), "--repo", repo, "--body", app.mention]);
    process.stderr.write(`posted "${app.mention}" on ${repo}#${pr} head ${head.slice(0, 7)}\n`);
  }
  while (!done) {
    if (Date.now() > deadline) {
      process.stderr.write(`timed out after ${options.timeout}s waiting for "${app.check}" on ${head.slice(0, 7)}\n`);
      process.exit(3);
    }
    process.stderr.write(`waiting for "${app.check}" on ${head.slice(0, 7)}\n`);
    sleep(options.interval);
    done = findCompleted(repo, pr, head, app, options.anyHead);
  }
  const { sha, conclusion } = done;
  // The summary comment lands right after the check completes; give it a few polls.
  let summary = summaryFor(repo, pr, app, sha, options.anyHead);
  for (let attempt = 0; !summary && attempt < 6; attempt += 1) {
    sleep(10);
    summary = summaryFor(repo, pr, app, sha, options.anyHead);
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

function parseJson(text) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return null;
  }
}

function reviewViaCli(repo, pr, options) {
  const app = APPS[options.app];
  const url = `https://github.com/${repo}/pull/${pr}`;
  const result = spawnSync("arcanist", ["review", url, "--wait", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) usage(`arcanist failed to start: ${result.error.message}`);
  // The CLI prints a result on stdout and an {error} object on stderr.
  const payload = [result.stdout, result.stderr].map(parseJson).find(Boolean);
  if (!payload) {
    process.stderr.write(result.stderr ?? "");
    usage(`arcanist review exited ${result.status} without JSON`);
  }
  if (payload.error?.code === "conflict") {
    // A review for this head is already running or was replaced by a newer one: wait on it, never re-trigger.
    process.stderr.write(`arcanist review: ${payload.error.message}; waiting on the running review via gh\n`);
    return reviewViaGh(repo, pr, { ...options, trigger: false });
  }
  if (payload.error) usage(`arcanist review: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  const findings = payload.findings ?? [];
  const blocking = findings.some((finding) => finding.blocksMerge === true);
  // Thread ids come from GitHub so the loop can resolve them after a fix.
  const threads = unresolvedThreads(repo, pr, app.bot);
  const threadFor = (finding) =>
    threads.find(
      (thread) => thread.file === finding.file && (thread.line === finding.line || thread.title === finding.title),
    )?.threadId ?? null;
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

export { summaryFromComment };

// argv[1] keeps a symlinked path while import.meta.url is the real file, so compare real paths.
const runAsScript =
  process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (runAsScript) {
  const options = parseArgs(process.argv.slice(2));
  const { repo, pr } = resolvePr(options.pr, options.repo);
  const backend =
    options.backend === "auto" ? (options.app === "arcanist" && cliAvailable() ? "cli" : "gh") : options.backend;
  if (backend === "cli" && options.app === "arcanist-qa" && !/\/\/qa\./.test(process.env.ARCANIST_API_URL ?? "")) {
    usage("--app arcanist-qa with the cli backend needs ARCANIST_API_URL set to the QA host (and a QA ARCANIST_TOKEN)");
  }
  const result = backend === "cli" ? reviewViaCli(repo, pr, options) : reviewViaGh(repo, pr, options);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.blocking ? 1 : 0;
}
