#!/usr/bin/env node
// Measure whether this skill actually fits this repository, before anyone
// trusts a case it produces.
//
// Every default in this skill encodes a convention: where tests live, what a
// fix title looks like, how a language writes a comment, how pull requests
// merge. On a repository that shares those conventions the run is good. On one
// that does not, the failure is quiet -- fewer candidates, more `null`, a thin
// bundle that looks exactly like a clean repository.
//
// This reports the mismatch instead. Each finding names the override that
// repairs it, so an agent can adapt the run without editing skill code.
//
// Usage:
//   preflight.mjs --repo owner/repo --since 2026-06-01 --until 2026-08-01 \
//     [--repo-path .] [--only "a,b"] [--config file] [--out file]
//   preflight.mjs --self-test

import { writeFileSync } from "node:fs";
import { ghJson, ghPrList, makeRoster, parseArgs, validateWindow, warn, warnings } from "./lib/gh.mjs";
import { assertUsableClone, git } from "./lib/git.mjs";
import { loadConfig, makePathPolicy, CONFIG_FILENAME } from "./lib/config.mjs";
import { languageFor } from "./lib/lang.mjs";

const SAMPLE_PRS = 40;
const NON_PRODUCT_SHARE_ALARM = 0.6;
const CANDIDATE_RATE_ALARM = 0.08;

// Kept in step with trace-origin.mjs. Duplicated deliberately: preflight must
// keep working if that file is mid-edit.
const NON_PRODUCT_PATH =
  /(^|\/)(tests?|__tests__|spec|specs|e2e|integration_tests|fixtures?|testdata|test_data|mocks?|__mocks__|docs?|examples?|samples?|vendor|third_party|node_modules|generated|__generated__)\/|(^|\/)(MIGRATION_HISTORY|CHANGELOG|README)[^/]*$|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(go|py|rb)$|\.stories\.[jt]sx?$/i;

// Mirrors find-candidates.mjs. Scoring a narrower signal set here would report
// a fix rate the real collector never sees, and a false alarm teaches an agent
// to ignore this report.
const FIX_TITLE = /\b(fix|fixes|fixed|bug|bugfix|hotfix|regression|revert|repair)\b/i;
const FIX_SYMPTOM = /\b(crash|broken|breaks|incorrect|wrong|missing|leak|hang|stale|duplicate|race|deadlock|timeout|null|undefined|off-by-one|500|not working)\b/i;
const BODY_SYMPTOM = /\b(root cause|regression|reproduce[sd]?|repro\b|stack trace|traceback|incident|postmortem)\b/i;
const UPKEEP_TITLE = /^(chore|docs?|style|refactor|test|ci|build|deps?|dependabot|bump|release|version|merge branch)\b/i;

// Extensions that have no comment syntax to miss. Reporting these as
// unsupported is noise, and noise in a diagnostic is worse than silence.
const COMMENTLESS = new Set([
  ".json", ".txt", ".csv", ".tsv", ".lock", ".sum", ".png", ".jpg", ".jpeg", ".gif", ".svg",
  ".ico", ".pdf", ".woff", ".woff2", ".ttf", ".zip", ".gz", ".snap", ".map", ".min",
]);
const UNKNOWN_EXT_ALARM = 0.05;

// Bots that post on pull requests without making claims about whether the code
// is correct. Listed in the report, never proposed as reviewers.
const NOT_A_REVIEWER =
  /^(github-actions|dependabot|renovate|codecov|coveralls|vercel|netlify|graphite-app|sonarcloud|snyk-bot|semantic-release|stale|mergify|allcontributors|changeset-bot|socket-security)(\[bot\])?$/i;

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: preflight.mjs --repo owner/repo --since DATE --until DATE [--repo-path .]\n" +
      "                    [--only \"a,b\"] [--config file] [--out file]\n" +
      "       preflight.mjs --self-test\n",
  );
  process.exit(2);
}

// merge_commit_sha with two parents means a merge commit, so commit ancestry
// can establish presence exactly. One parent means squash or rebase, where the
// commits a reviewer read are not ancestors of anything on the default branch
// and every verdict falls back to the approximate content test.
export function classifyMergeStrategy(samples) {
  const counts = { mergeCommit: 0, squashOrRebase: 0, unknown: 0 };
  for (const s of samples) {
    if (s.parents == null) counts.unknown += 1;
    else if (s.parents >= 2) counts.mergeCommit += 1;
    else counts.squashOrRebase += 1;
  }
  const measured = counts.mergeCommit + counts.squashOrRebase;
  if (!measured) return { strategy: "unknown", ancestryCanFire: null, counts };
  const mergeShare = counts.mergeCommit / measured;
  return {
    strategy: mergeShare > 0.8 ? "merge-commit" : mergeShare < 0.2 ? "squash-or-rebase" : "mixed",
    ancestryCanFire: counts.mergeCommit > 0,
    mergeCommitShare: Number(mergeShare.toFixed(2)),
    counts,
  };
}

export function summarise(findings) {
  return {
    blocking: findings.filter((f) => f.level === "blocking").length,
    adjust: findings.filter((f) => f.level === "adjust").length,
    note: findings.filter((f) => f.level === "note").length,
  };
}

function selfTest() {
  const cases = [];
  const eq = (name, actual, expected) =>
    cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

  eq("all merge commits means ancestry can fire",
    classifyMergeStrategy([{ parents: 2 }, { parents: 2 }, { parents: 2 }]).strategy, "merge-commit");
  eq("all single-parent means squash or rebase",
    classifyMergeStrategy([{ parents: 1 }, { parents: 1 }]).strategy, "squash-or-rebase");
  eq("ancestry is impossible when nothing is a merge commit",
    classifyMergeStrategy([{ parents: 1 }, { parents: 1 }]).ancestryCanFire, false);
  eq("a mixed repository is reported as mixed",
    classifyMergeStrategy([{ parents: 2 }, { parents: 1 }, { parents: 1 }]).strategy, "mixed");
  eq("no measurable sample is unknown, not zero",
    classifyMergeStrategy([{ parents: null }]).ancestryCanFire, null);
  eq("findings are counted by level",
    summarise([{ level: "blocking" }, { level: "adjust" }, { level: "adjust" }]),
    { blocking: 1, adjust: 2, note: 0 });

  for (const c of cases) process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.name}\n`);
  const failed = cases.filter((c) => !c.ok);
  for (const c of failed) process.stdout.write(`     actual=${JSON.stringify(c.actual)} expected=${JSON.stringify(c.expected)}\n`);
  process.exit(failed.length ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2), {
  repo: "value", since: "value", until: "value", repoPath: "value",
  only: "value", config: "value", out: "value", selfTest: "flag",
});
if (args.error) usage(args.error);
if (args.selfTest) selfTest();
if (!args.repo || !args.since || !args.until) usage("--repo, --since and --until are required");
const windowProblems = validateWindow(args.since, args.until);
if (windowProblems.length) usage(windowProblems.join("; "));

const repoPath = args.repoPath || ".";
const findings = [];
const add = (level, what, why, remedy) => findings.push({ level, what, why, remedy });

// --- clone health -----------------------------------------------------------
let cloneOk = true;
try {
  assertUsableClone(repoPath);
} catch (e) {
  cloneOk = false;
  add("blocking", "clone is unusable", e.message,
    "Run `git fetch --unshallow` in the clone, or point --repo-path at a full clone.");
}
const isBlobless = cloneOk
  && (git(repoPath, ["config", "--get", "remote.origin.promisor"], { tolerate: true }) || "").trim() === "true";
if (isBlobless) {
  add("adjust", "clone is blobless (--filter=blob:none)",
    "git blame fetches blobs one at a time, which turns a ten-second trace into minutes.",
    "Re-clone without --filter, or accept the slowdown.");
}

// --- config -----------------------------------------------------------------
const config = loadConfig({ explicit: args.config, repoPath });
for (const problem of config.problems) {
  add("blocking", "config file is invalid", problem, `Fix ${config.source} and rerun.`);
}
const pathPolicy = makePathPolicy(NON_PRODUCT_PATH, config);

// --- merge strategy ---------------------------------------------------------
const prs = ghPrList([
  "--repo", args.repo, "--state", "merged",
  "--search", `merged:>=${args.since} merged:<${args.until}`,
  "--limit", String(SAMPLE_PRS),
  "--json", "number,title,body,labels,mergeCommit,author,changedFiles,files",
]);

const samples = [];
for (const pr of prs.slice(0, 20)) {
  const sha = pr.mergeCommit?.oid;
  if (!sha || !cloneOk) {
    samples.push({ parents: null });
    continue;
  }
  const out = git(repoPath, ["rev-list", "--parents", "-n", "1", sha], { tolerate: true });
  samples.push({ parents: out ? out.trim().split(/\s+/).length - 1 : null });
}
const merge = classifyMergeStrategy(samples);
if (merge.ancestryCanFire === false) {
  add("note", "commit ancestry cannot establish presence here",
    `Merge strategy looks like ${merge.strategy}, so the commits a reviewer read are not ancestors of the default branch.`,
    "Expect every verdict to use the approximate verbatim-content test. Say so when handing over the bundle; CASES.md states it for you.");
} else if (merge.ancestryCanFire === null) {
  add("adjust", "merge strategy could not be measured",
    "No merge commit was reachable in the clone.",
    "Fetch the default branch (`git fetch origin`) and rerun preflight.");
}

// --- language coverage ------------------------------------------------------
// Only files that would actually be traced: product paths, in a language that
// could carry a comment.
const extCounts = new Map();
let tracedFiles = 0;
for (const pr of prs) {
  for (const f of pr.files || []) {
    if (pathPolicy.isNonProduct(f.path)) continue;
    const lang = languageFor(f.path, config.languages);
    if (COMMENTLESS.has(lang.ext)) continue;
    tracedFiles += 1;
    if (!lang.matched && lang.ext) extCounts.set(lang.ext, (extCounts.get(lang.ext) || 0) + 1);
  }
}
const unknownExts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
const unknownCount = [...extCounts.values()].reduce((n, v) => n + v, 0);
if (unknownExts.length && tracedFiles && unknownCount / tracedFiles >= UNKNOWN_EXT_ALARM) {
  add("adjust", `${Math.round((unknownCount / tracedFiles) * 100)}% of traced files have no comment syntax entry`,
    `Most common: ${unknownExts.map(([e, n]) => `${e} (${n})`).join(", ")}. Comment masking falls back to every style at once, which drops usable needles rather than inventing them.`,
    `Add a "languages" entry per extension in ${CONFIG_FILENAME}. See references/configuration.md.`);
}

// --- path filter impact -----------------------------------------------------
let pathReport = null;
if (cloneOk) {
  const tracked = (git(repoPath, ["ls-files"], { tolerate: true }) || "").split("\n").filter(Boolean);
  const excluded = tracked.filter((f) => pathPolicy.isNonProduct(f));
  const share = tracked.length ? excluded.length / tracked.length : 0;
  const topDirs = new Map();
  for (const f of excluded) {
    const dir = f.split("/").slice(0, 2).join("/");
    topDirs.set(dir, (topDirs.get(dir) || 0) + 1);
  }
  pathReport = {
    tracked: tracked.length,
    excluded: excluded.length,
    share: Number(share.toFixed(3)),
    topExcludedDirs: [...topDirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, n]) => ({ dir: d, files: n })),
  };
  if (share > NON_PRODUCT_SHARE_ALARM) {
    add("adjust", `the non-product filter excludes ${Math.round(share * 100)}% of tracked files`,
      `Top directories: ${pathReport.topExcludedDirs.slice(0, 5).map((d) => d.dir).join(", ")}. If product code lives in any of them, no bug there can ever become a case.`,
      `Add those directories to "paths.product" in ${CONFIG_FILENAME}; the allowlist wins over the default filter.`);
  }
}

// --- fix-signal yield -------------------------------------------------------
const looksLikeFix = prs.filter((pr) => {
  const title = pr.title || "";
  const body = pr.body || "";
  if (UPKEEP_TITLE.test(title)) return false;
  return FIX_TITLE.test(title)
    || FIX_SYMPTOM.test(title)
    || BODY_SYMPTOM.test(body)
    || (pr.labels || []).some((l) => /bug|regression|incident|hotfix|sev[0-9]|outage/i.test(l.name || ""))
    || /\b(fix(es|ed)?|close[sd]?|resolve[sd]?)\s+#\d+/i.test(body)
    || /^revert\b/i.test(title);
}).length;
const fixRate = prs.length ? looksLikeFix / prs.length : 0;
if (prs.length && fixRate < CANDIDATE_RATE_ALARM) {
  add("adjust", `only ${Math.round(fixRate * 100)}% of sampled pull requests look like fixes`,
    "Fix scoring keys on English title words, bug labels and linked issues. A repository that names pull requests by ticket id alone scores near zero.",
    `Add repo-specific patterns via "fixSignalsExtra" in ${CONFIG_FILENAME}, or widen the window.`);
}

// --- reviewer roster --------------------------------------------------------
const roster = makeRoster(args.only);
const reviewBodyAuthors = new Map();
const commentAuthors = new Map();
for (const pr of prs.slice(0, 20)) {
  for (const r of ghJson(`repos/${args.repo}/pulls/${pr.number}/reviews?per_page=100`, { tolerate: true })) {
    if (r.user?.type !== "Bot") continue;
    reviewBodyAuthors.set(r.user.login, (reviewBodyAuthors.get(r.user.login) || 0) + 1);
  }
  for (const c of ghJson(`repos/${args.repo}/issues/${pr.number}/comments?per_page=100`, { tolerate: true })) {
    if (c.user?.type !== "Bot") continue;
    commentAuthors.set(c.user.login, (commentAuthors.get(c.user.login) || 0) + 1);
  }
}
const discovered = [...new Set([...reviewBodyAuthors.keys(), ...commentAuthors.keys()])].map((login) => ({
  login,
  reviewBodies: reviewBodyAuthors.get(login) || 0,
  topLevelComments: commentAuthors.get(login) || 0,
  onRoster: roster.has(login),
}));
const commentOnly = discovered.filter(
  (d) => d.reviewBodies === 0 && d.topLevelComments > 0 && !NOT_A_REVIEWER.test(d.login) && (d.onRoster || d.topLevelComments >= 3),
);
for (const d of commentOnly) {
  add("note", `${d.login} publishes only top-level comments in this sample`,
    "Comments carry no commit pin, so nothing can be established about which commit that reviewer read.",
    "Expect `null / published-only-on-an-unpinned-surface` for it. It cannot produce missed cases; it can still produce caught ones.");
}
const missing = discovered.filter(
  (d) => !d.onRoster && !NOT_A_REVIEWER.test(d.login) && d.reviewBodies + d.topLevelComments >= 3,
);
if (!roster.isEmpty && missing.length) {
  add("adjust", `${missing.length} active reviewer(s) are not on --only`,
    `Seen publishing: ${missing.map((d) => d.login).join(", ")}.`,
    "Add them to --only, or state in the report that they were deliberately out of scope.");
}

// --- window sizing ----------------------------------------------------------
const days = Math.max(1, Math.round((Date.parse(`${args.until}T00:00:00Z`) - Date.parse(`${args.since}T00:00:00Z`)) / 86400000));
const perDay = prs.length >= SAMPLE_PRS ? null : Number((prs.length / days).toFixed(1));
if (perDay !== null && perDay < 0.2) {
  add("note", "this window holds very few merged pull requests",
    `About ${perDay} per day across ${days} days.`,
    "Widen the window. Leave at least two weeks after it so fixes have had time to land.");
}

const report = {
  schemaVersion: "review-cases-preflight-v1",
  repo: args.repo,
  window: { from: args.since, toExclusive: args.until, days },
  clone: { path: repoPath, usable: cloneOk, blobless: isBlobless },
  mergeStrategy: merge,
  paths: pathReport,
  configSource: config.source,
  unrecognisedFileTypes: unknownExts.map(([ext, files]) => ({ ext, files })),
  sampledPullRequests: prs.length,
  fixSignalRate: Number(fixRate.toFixed(2)),
  reviewersSeen: discovered
    .map((d) => ({ ...d, looksLikeAReviewer: !NOT_A_REVIEWER.test(d.login) }))
    .sort((a, b) => b.reviewBodies + b.topLevelComments - (a.reviewBodies + a.topLevelComments)),
  findings,
  summary: summarise(findings),
  warnings,
  generatedAt: new Date().toISOString(),
};

if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

const line = (s) => process.stdout.write(`${s}\n`);
line(`preflight: ${args.repo}  ${args.since}..${args.until}`);
line(`  clone            ${cloneOk ? "usable" : "UNUSABLE"}${isBlobless ? " (blobless)" : ""}`);
line(`  merge strategy   ${merge.strategy}; ancestry can fire: ${merge.ancestryCanFire === null ? "unknown" : merge.ancestryCanFire}`);
if (pathReport) line(`  path filter      excludes ${pathReport.excluded}/${pathReport.tracked} tracked files (${Math.round(pathReport.share * 100)}%)`);
line(`  sampled PRs      ${prs.length}; fix-signal rate ${Math.round(fixRate * 100)}%`);
line(`  reviewers seen   ${discovered.map((d) => `${d.login}(${d.reviewBodies}r/${d.topLevelComments}c)`).join(", ") || "none"}`);
line(`  config           ${config.source || "none (defaults only)"}`);
line("");
if (!findings.length) line("No mismatches found. The defaults suit this repository.");
for (const f of findings) {
  line(`[${f.level.toUpperCase()}] ${f.what}`);
  line(`  why:    ${f.why}`);
  line(`  remedy: ${f.remedy}`);
}
if (args.out) process.stderr.write(`\nreport written to ${args.out}\n`);
process.exit(summarise(findings).blocking > 0 ? 1 : 0);
