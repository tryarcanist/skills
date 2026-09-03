#!/usr/bin/env node
// Trace one merged fix back to the change that introduced the bug, then
// establish which reviewers had a real chance to catch it.
//
// The chain this builds is the entire claim behind a missed-bug case:
//
//   a merged fix  ->  the lines it rewrote  ->  the commit that wrote them
//                 ->  the PR that shipped that commit
//                 ->  the exact commits each reviewer read on that PR
//                 ->  whether the buggy lines already existed at those commits
//
// The last link is the one people skip, and skipping it is how a case set ends
// up teaching a reviewer to find bugs that did not exist when it ran. A
// reviewer whose only run predates the buggy lines did not miss anything.
//
// Two independent presence tests, because repositories merge differently:
//
//   ancestry  The origin commit is an ancestor of a commit the reviewer read.
//             Exact. Works on merge-commit repositories.
//   content   The buggy lines appear verbatim at a commit the reviewer read.
//             Approximate. This is the only test available on a squash-merge
//             repository, where blame names a squash commit on the default
//             branch and the reviewed commits live on a branch that is not its
//             ancestor.
//
// Neither test firing is `presence: null` -- unmeasured, not innocent.
//
// Usage:
//   trace-origin.mjs --repo owner/repo --pr <fix-pr> --only "arcanist[bot],cursor[bot]" \
//     [--repo-path .] [--max-origins 5] [--min-lines 2] --out file
//   trace-origin.mjs --self-test

import { writeFileSync } from "node:fs";
import { ghJson, ghOne, makeRoster, parseArgs, warn, warnings } from "./lib/gh.mjs";
import {
  assertUsableClone, blameLines, blockPresentAt, commitMeta, contiguousRuns,
  ensureCommit, fileAt, git, isAncestor, preImageRanges,
} from "./lib/git.mjs";
import { fetchReviewerOutput, reviewedCommitsByReviewer } from "./lib/reviews.mjs";

const DEFAULT_MAX_ORIGINS = 5;
const DEFAULT_MIN_LINES = 2;

// Files whose blame says nothing about who introduced a defect.
const UNINFORMATIVE_PATH =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$|\.(snap|lock|svg|png|jpe?g|gif|ico|pdf|min\.js|min\.css)$/i;

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: trace-origin.mjs --repo owner/repo --pr <fix-pr> --only \"bot-a,bot-b\"\n" +
      "                       [--repo-path .] [--max-origins N] [--min-lines N] --out file\n" +
      "       trace-origin.mjs --self-test\n",
  );
  process.exit(2);
}

function selfTest() {
  const cases = [];
  const eq = (name, actual, expected) =>
    cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

  eq("lock files are excluded", ["a/package-lock.json", "x/pnpm-lock.yaml", "ui/logo.svg", "t/__snapshots__/a.snap"].map((p) => UNINFORMATIVE_PATH.test(p)), [true, true, true, true]);
  eq("source files are kept", ["src/app.ts", "core/pkg/lock.go", "a/locking.py"].map((p) => UNINFORMATIVE_PATH.test(p)), [false, false, false]);
  eq("a squash subject yields its PR number", squashPrNumber("Fix stale cache key (#13375)"), 13375);
  eq("a subject without a PR number yields null", squashPrNumber("Fix stale cache key"), null);
  eq("only the trailing PR reference is used", squashPrNumber("Revert (#10) broke things (#4200)"), 4200);

  for (const c of cases) process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.name}\n`);
  const failed = cases.filter((c) => !c.ok);
  for (const c of failed) process.stdout.write(`     actual=${JSON.stringify(c.actual)} expected=${JSON.stringify(c.expected)}\n`);
  process.exit(failed.length ? 1 : 0);
}

// GitHub's squash subject carries the PR number. Used only as a fallback when
// the commits/{sha}/pulls association is unavailable, and recorded as such.
function squashPrNumber(subject) {
  const matches = String(subject || "").match(/\(#(\d+)\)/g);
  if (!matches || matches.length === 0) return null;
  return Number(matches[matches.length - 1].replace(/\D/g, ""));
}

const args = parseArgs(process.argv.slice(2), {
  repo: "value", pr: "value", only: "value", repoPath: "value",
  maxOrigins: "value", minLines: "value", out: "value", selfTest: "flag",
});
if (args.error) usage(args.error);
if (args.selfTest) selfTest();
if (!args.repo) usage("--repo is required");
if (!args.pr) usage("--pr is required");
if (!args.only) usage("--only is required");
if (!args.out) usage("--out is required");

const repoPath = args.repoPath || ".";
const maxOrigins = Number(args.maxOrigins || DEFAULT_MAX_ORIGINS);
const minLines = Number(args.minLines || DEFAULT_MIN_LINES);
const roster = makeRoster(args.only);
const prNum = String(args.pr).match(/(\d+)(?!.*\d)/)?.[1];
if (!prNum) usage(`could not read a PR number from ${args.pr}`);

assertUsableClone(repoPath);

const fixPr = ghOne(`repos/${args.repo}/pulls/${prNum}`);
if (!fixPr) usage(`PR ${prNum} could not be read`);
if (!fixPr.merged_at) warn(`PR ${prNum} is not merged; a fix that never landed is weak ground truth`);

// Blame must run against the tree the fix was applied to. Blaming the fix
// itself, or current head, names the fix as the author of its own bug.
let preFixSha = null;
let preFixSource = null;
if (fixPr.merge_commit_sha && ensureCommit(repoPath, fixPr.merge_commit_sha)) {
  const parent = git(repoPath, ["rev-parse", `${fixPr.merge_commit_sha}^1`], { tolerate: true });
  if (parent) {
    preFixSha = parent.trim();
    preFixSource = "merge-commit-first-parent";
  }
}
if (!preFixSha && fixPr.base?.sha && ensureCommit(repoPath, fixPr.base.sha)) {
  preFixSha = fixPr.base.sha;
  preFixSource = "pr-base-sha";
  warn(`fell back to the PR base sha for PR ${prNum}; it may be behind the tree the fix actually landed on`);
}
if (!preFixSha) {
  process.stderr.write(`error: neither the merge commit nor the base sha of PR ${prNum} is reachable locally\n`);
  process.exit(1);
}

const files = ghJson(`repos/${args.repo}/pulls/${prNum}/files?per_page=100`);
const fileObservations = [];
const originStats = new Map();

for (const file of files) {
  const prePath = file.previous_filename || file.filename;
  if (file.status === "added") {
    fileObservations.push({ path: file.filename, prePath, status: file.status, state: "no-pre-image" });
    continue;
  }
  if (UNINFORMATIVE_PATH.test(prePath)) {
    fileObservations.push({ path: file.filename, prePath, status: file.status, state: "uninformative-path" });
    continue;
  }
  if (!file.patch) {
    fileObservations.push({ path: file.filename, prePath, status: file.status, state: "no-patch-returned" });
    continue;
  }
  const ranges = preImageRanges(file.patch);
  const observed = [];
  for (const range of ranges) {
    const blamed = blameLines(repoPath, preFixSha, prePath, range.start, range.end);
    if (!blamed) {
      observed.push({ ...range, state: "blame-failed" });
      warn(`blame failed for ${prePath}:${range.start},${range.end} at ${preFixSha.slice(0, 10)}`);
      continue;
    }
    observed.push({ ...range, state: "observed", lines: blamed.length });
    for (const entry of blamed) {
      if (!originStats.has(entry.sha)) {
        originStats.set(entry.sha, { sha: entry.sha, lines: 0, boundary: false, evidence: [] });
      }
      const stat = originStats.get(entry.sha);
      stat.lines += 1;
      stat.boundary = stat.boundary || entry.boundary;
    }
    for (const stat of originStats.values()) {
      const runs = contiguousRuns(blamed, stat.sha);
      if (runs.length) stat.evidence.push({ path: prePath, runs, anchorOnly: range.anchorOnly });
    }
  }
  fileObservations.push({ path: file.filename, prePath, status: file.status, state: "observed", ranges: observed });
}

const totalBlamedLines = [...originStats.values()].reduce((n, s) => n + s.lines, 0);
const ranked = [...originStats.values()]
  .filter((s) => s.lines >= minLines)
  .sort((a, b) => b.lines - a.lines)
  .slice(0, maxOrigins);

if (ranked.some((s) => s.boundary)) {
  warn("at least one origin commit is a blame boundary; its authorship is a graft artefact, not a real origin");
}

// Extract the buggy block from the tree the fix was applied to. This is the
// text the content-presence test looks for at each reviewed commit.
//
// Pick the longest contiguous run the origin owns, not the first one found. A
// one-line needle is the failure mode here: it matches boilerplate anywhere in
// a large file and it stops matching after any cosmetic edit, so a block that
// is too small to identify anything is reported as unusable rather than
// silently answering the presence question wrong in either direction.
const MIN_BLOCK_CHARS = 40;

function bestBlock(stat) {
  const options = [];
  for (const ev of stat.evidence) {
    for (const run of ev.runs) options.push({ path: ev.path, run, anchorOnly: ev.anchorOnly });
  }
  options.sort((a, b) => b.run.end - b.run.start - (a.run.end - a.run.start));
  for (const option of options) {
    const content = fileAt(repoPath, preFixSha, option.path);
    if (content === null) continue;
    const block = content.split("\n").slice(option.run.start - 1, option.run.end).join("\n");
    const weight = block.replace(/\s+/g, " ").trim().length;
    if (weight < MIN_BLOCK_CHARS) continue;
    return {
      path: option.path, start: option.run.start, end: option.run.end,
      block, anchorOnly: option.anchorOnly, lines: option.run.end - option.run.start + 1,
    };
  }
  return null;
}

function presenceAt(stat, block, reviewedCommit) {
  if (!ensureCommit(repoPath, reviewedCommit)) {
    return { present: null, method: "unmeasurable", reason: "reviewed-commit-unreachable" };
  }
  const ancestry = isAncestor(repoPath, stat.sha, reviewedCommit);
  if (ancestry === true) return { present: true, method: "ancestry", reason: null };
  if (!block) return { present: null, method: "unmeasurable", reason: "no-block-large-enough-to-identify" };
  const content = blockPresentAt(repoPath, reviewedCommit, block.path, block.block);
  if (content.present === null) return { present: null, method: "unmeasurable", reason: content.reason };
  return {
    present: content.present,
    method: "content",
    reason: content.present ? null : "block-absent-at-reviewed-commit",
  };
}

const origins = [];
for (const stat of ranked) {
  const meta = commitMeta(repoPath, stat.sha);
  const block = bestBlock(stat);

  const associated = ghJson(`repos/${args.repo}/commits/${stat.sha}/pulls?per_page=100`, { tolerate: true });
  let originPrs = associated.map((p) => ({
    number: p.number, title: p.title, url: p.html_url,
    author: p.user?.login || null, mergedAt: p.merged_at || null, source: "commit-pulls-api",
  }));
  if (originPrs.length === 0) {
    const guessed = squashPrNumber(meta?.subject);
    if (guessed) {
      originPrs = [{ number: guessed, title: meta.subject, url: null, author: null, mergedAt: null, source: "squash-subject" }];
      warn(`origin ${stat.sha.slice(0, 10)} had no PR association; used its squash subject to guess PR ${guessed}`);
    }
  }
  if (originPrs.length === 0) warn(`origin ${stat.sha.slice(0, 10)} has no associated PR; it cannot become a reviewer case`);

  for (const originPr of originPrs) {
    if (originPr.number === Number(prNum)) {
      originPr.selfReference = true;
      continue;
    }
    const output = fetchReviewerOutput(args.repo, originPr.number, roster);
    originPr.reviewerOutput = output;
    originPr.reviewers = reviewedCommitsByReviewer(output).map((r) => {
      const commits = r.reviewedCommits.map((c) => ({ ...c, ...presenceAt(stat, block, c.sha) }));
      const withOpportunity = commits.filter((c) => c.present === true);
      return {
        reviewer: r.reviewer,
        reviewedCommits: commits,
        unpinnedPublications: r.unpinnedPublications,
        hadOpportunity: withOpportunity.length > 0
          ? true
          : commits.some((c) => c.present === null) ? null : false,
        firstOpportunity: withOpportunity[0] || null,
      };
    });
    for (const login of roster.logins) {
      if (!originPr.reviewers.some((r) => r.reviewer.toLowerCase().replace(/\[bot\]$/, "") === login)) {
        originPr.reviewers.push({
          reviewer: login, reviewedCommits: [], unpinnedPublications: 0,
          hadOpportunity: false, firstOpportunity: null, note: "no published output on this PR",
        });
      }
    }
  }

  origins.push({
    sha: stat.sha,
    lines: stat.lines,
    shareOfBlamedLines: totalBlamedLines ? Number((stat.lines / totalBlamedLines).toFixed(3)) : null,
    boundary: stat.boundary,
    authoredAt: meta?.authoredAt || null,
    author: meta?.author || null,
    subject: meta?.subject || null,
    buggyBlock: block,
    originPrs,
  });
}

const out = {
  schemaVersion: "review-cases-origin-v1",
  repo: args.repo,
  roster: roster.logins,
  fix: {
    pr: Number(prNum), title: fixPr.title, url: fixPr.html_url,
    author: fixPr.user?.login || null, mergedAt: fixPr.merged_at,
    mergeCommit: fixPr.merge_commit_sha || null,
    changedFiles: fixPr.changed_files, additions: fixPr.additions, deletions: fixPr.deletions,
    body: fixPr.body || "",
  },
  preFix: { sha: preFixSha, source: preFixSource },
  files: fileObservations,
  totalBlamedLines,
  origins,
  warnings,
  generatedAt: new Date().toISOString(),
};

writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
const opportunities = origins.flatMap((o) =>
  (o.originPrs || []).flatMap((p) => (p.reviewers || []).filter((r) => r.hadOpportunity === true).map((r) => `${p.number}:${r.reviewer}`)),
);
process.stderr.write(
  `fix PR ${prNum}: ${origins.length} origin(s), ${opportunities.length} reviewer opportunity(ies) [${[...new Set(opportunities)].join(", ") || "none"}] -> ${args.out}\n`,
);
