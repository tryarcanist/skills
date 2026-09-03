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
import { ghJson, ghOne, makeRoster, normalizeLogin, parseArgs, warn, warnings } from "./lib/gh.mjs";
import {
  assertUsableClone, blameLines, blockPresentAt, commitMeta, contiguousRuns,
  ensureCommit, fileAt, git, isAncestor, preImageRanges,
} from "./lib/git.mjs";
import { fetchReviewerOutput, reviewedCommitsByReviewer } from "./lib/reviews.mjs";

const DEFAULT_MAX_ORIGINS = 5;
const DEFAULT_MIN_LINES = 2;
const DEFAULT_MIN_SHARE = 0.1;
const MIN_BLOCK_CHARS = 40;

// Files whose blame says nothing about who introduced a defect.
const UNINFORMATIVE_PATH =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$|\.(snap|lock|svg|png|jpe?g|gif|ico|pdf|min\.js|min\.css)$/i;

// Non-product files. A fix almost always touches its own tests, and blaming
// those tests attributes the bug to whoever last edited a fixture. In testing
// this produced eligibility verdicts decided by a mock branch, a docstring and
// a bare comment -- charging reviewers with missing bugs in files that did not
// exist when they ran. The mechanism lives in product code; nothing else is
// traced.
const NON_PRODUCT_PATH =
  /(^|\/)(tests?|__tests__|spec|specs|e2e|integration_tests|fixtures?|testdata|test_data|mocks?|__mocks__|docs?|examples?|samples?|vendor|third_party|node_modules|generated|__generated__|\.github)\/|(^|\/)(MIGRATION_HISTORY|CHANGELOG|README)[^/]*$|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(go|py|rb)$|\.stories\.[jt]sx?$/i;

// Commits that rewrote history rather than wrote code. A subtree import or a
// merge commit can own thousands of lines and has no reviewable pull request.
const HISTORY_ARTIFACT_SUBJECT =
  /^(squashed '.*' (content|changes)|merge (branch|pull request|remote-tracking|commit)|initial commit|import(ing)? |bulk (re)?format|apply (prettier|black|gofmt)|migrate to |rename .* directory)/i;

// Lines that appear in every large file and therefore identify nothing.
const NOISE_LINE =
  /^\s*(?:\/\/|#(?!\s*(?:if|include|define))|\*|\/\*|--|<!--|"{3}|'{3}|import\s|from\s+\S+\s+import\s|export\s*\{|use\s+\w|package\s+\w|require\(|@\w+\s*$|[{}()\[\];,]*$)/;

// How much of a block is actually distinguishing code, after dropping comments,
// imports, docstrings and punctuation-only lines. A needle made of boilerplate
// answers the presence question by accident, in whichever direction the file
// happens to fall.
export function substantiveLength(block) {
  return String(block || "")
    .split("\n")
    .filter((l) => l.trim().length > 0 && !NOISE_LINE.test(l))
    .map((l) => l.trim().replace(/\s+/g, " "))
    .join("\n").length;
}

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: trace-origin.mjs --repo owner/repo --pr <fix-pr> --only \"bot-a,bot-b\"\n" +
      "                       [--repo-path .] [--max-origins N] [--min-lines N] [--min-share 0.1] --out file\n" +
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
  eq("test and fixture paths are not traced",
    ["core/tests/api/test_x.py", "src/__tests__/a.ts", "web/a.test.tsx", "docs/guide.md", "core/migrations/MIGRATION_HISTORY", "pkg/thing_test.go"].map((f) => NON_PRODUCT_PATH.test(f)),
    [true, true, true, true, true, true]);
  eq("product paths are still traced",
    ["core/src/lib/latest.py", "apps/worker/src/protest.ts", "src/contest/index.ts"].map((f) => NON_PRODUCT_PATH.test(f)),
    [false, false, false]);
  eq("a subtree import is a history artefact", HISTORY_ARTIFACT_SUBJECT.test("Squashed 'core/' content from commit 37b26f93"), true);
  eq("a normal fix subject is not", HISTORY_ARTIFACT_SUBJECT.test("Fix stale cache key after fallback"), false);
  eq("an import line is not substantive", substantiveLength('import { a, b, c } from "some/long/module/path";'), 0);
  eq("a comment line is not substantive", substantiveLength("// Yield so the first run entered the workflow and claimed the slot."), 0);
  eq("a docstring line is not substantive", substantiveLength('"""Create an organization in the database for integration tests."""'), 0);
  eq("real code is substantive", substantiveLength("if (!member) return { ok: true };\n  ledger.record(member.id, now);") >= MIN_BLOCK_CHARS, true);

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
  maxOrigins: "value", minLines: "value", minShare: "value", out: "value", selfTest: "flag",
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
const minShare = args.minShare === undefined ? DEFAULT_MIN_SHARE : Number(args.minShare);
const roster = makeRoster(args.only);
const prNum = String(args.pr).match(/(\d+)(?!.*\d)/)?.[1];
if (!prNum) usage(`could not read a PR number from ${args.pr}`);

assertUsableClone(repoPath);

const fixPr = ghOne(`repos/${args.repo}/pulls/${prNum}`);
if (!fixPr) usage(`PR ${prNum} could not be read`);
// The first invariant is that the fix is the ground truth. An unmerged PR has
// no merge commit in the repository's history -- `merge_commit_sha` is
// GitHub's ephemeral test-merge -- so everything downstream would be traced
// against a tree that exists on no branch.
if (!fixPr.merged_at) {
  process.stderr.write(
    `error: PR ${prNum} is not merged. Nothing landed, so there is no evidence a bug was ever real, ` +
      `and no merge commit to blame against. Pick a merged fix.\n`,
  );
  process.exit(2);
}

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
  if (NON_PRODUCT_PATH.test(prePath)) {
    fileObservations.push({ path: file.filename, prePath, status: file.status, state: "non-product-path" });
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
    // Only the commits this range actually blames to. Walking every origin
    // accumulated so far made evidence collection quadratic in origin count.
    for (const sha of new Set(blamed.map((b) => b.sha))) {
      const runs = contiguousRuns(blamed, sha);
      if (runs.length) originStats.get(sha).evidence.push({ path: prePath, runs, anchorOnly: range.anchorOnly });
    }
  }
  fileObservations.push({ path: file.filename, prePath, status: file.status, state: "observed", ranges: observed });
}

const totalBlamedLines = [...originStats.values()].reduce((n, s) => n + s.lines, 0);
for (const stat of originStats.values()) {
  const meta = commitMeta(repoPath, stat.sha);
  stat.subject = meta?.subject || null;
  stat.meta = meta;
  stat.share = totalBlamedLines ? Number((stat.lines / totalBlamedLines).toFixed(3)) : null;
  stat.historyArtifact = HISTORY_ARTIFACT_SUBJECT.test(stat.subject || "");
}

const artefacts = [...originStats.values()].filter((x) => x.historyArtifact);
for (const a of artefacts) {
  warn(`origin ${a.sha.slice(0, 10)} is a history artefact (${a.subject}); excluded from ranking`);
}

const ranked = [...originStats.values()]
  .filter((x) => x.lines >= minLines && !x.historyArtifact)
  .sort((a, b) => b.lines - a.lines)
  .slice(0, maxOrigins);

if (ranked.some((s) => s.boundary)) {
  warn("at least one origin commit is a blame boundary; its authorship is a graft artefact, not a real origin");
}

// Extract the buggy block from the tree the fix was applied to. This is the
// text the content-presence test looks for at each reviewed commit.
//
// Only a deletion range may supply it. An anchor range is the line above a pure
// insertion -- it locates roughly where a fix went, and says nothing about what
// was wrong. Using one as a needle is how an unrelated import line came to
// decide, in testing, that two reviewers had opposite eligibility for the same
// bug on the same pull request while the rewritten line was identical at both
// of their commits.
//
// The block must also carry real code. A needle made of comments, imports or
// docstrings matches boilerplate anywhere in a large file, so it answers the
// presence question by accident.
function bestBlock(stat) {
  const options = [];
  for (const ev of stat.evidence) {
    if (ev.anchorOnly) continue;
    for (const run of ev.runs) options.push({ path: ev.path, run });
  }
  options.sort((a, b) => b.run.end - b.run.start - (a.run.end - a.run.start));
  const rejected = [];
  for (const option of options) {
    const content = fileAt(repoPath, preFixSha, option.path);
    if (content === null) continue;
    const block = content.split("\n").slice(option.run.start - 1, option.run.end).join("\n");
    const weight = substantiveLength(block);
    if (weight < MIN_BLOCK_CHARS) {
      rejected.push({ path: option.path, start: option.run.start, end: option.run.end, substantiveChars: weight });
      continue;
    }
    return {
      block: {
        path: option.path, start: option.run.start, end: option.run.end,
        block, substantiveChars: weight, lines: option.run.end - option.run.start + 1,
      },
      rejected,
    };
  }
  return { block: null, rejected };
}

function presenceAt(stat, block, reviewedCommit) {
  if (!ensureCommit(repoPath, reviewedCommit)) {
    return { present: null, method: "unmeasurable", reason: "reviewed-commit-unreachable" };
  }
  const ancestry = isAncestor(repoPath, stat.sha, reviewedCommit);
  if (ancestry === true) return { present: true, method: "ancestry", reason: null };
  if (!block) return { present: null, method: "unmeasurable", reason: "no-block-carrying-identifiable-code" };
  const content = blockPresentAt(repoPath, reviewedCommit, block.path, block.block);
  if (content.present === null) return { present: null, method: "unmeasurable", reason: content.reason };
  return {
    present: content.present,
    method: "content",
    reason: content.present ? null : "block-absent-at-reviewed-commit",
  };
}

const origins = [];
const presenceMethodCounts = { ancestry: 0, content: 0, unmeasurable: 0 };

for (const stat of ranked) {
  const meta = stat.meta;
  const { block, rejected: rejectedBlocks } = bestBlock(stat);

  // An origin that owns a sliver of the blamed lines is usually a file the fix
  // brushed, not the change that caused the bug. Presence is still measured and
  // reported, but it may not on its own assert that a reviewer had the bug.
  const shareOk = stat.share === null ? false : stat.share >= minShare;
  if (!shareOk) {
    warn(
      `origin ${stat.sha.slice(0, 10)} owns ${Math.round((stat.share || 0) * 100)}% of blamed lines ` +
        `(below --min-share ${minShare}); its reviewer opportunities are reported as unmeasured`,
    );
  }

  const associated = ghJson(`repos/${args.repo}/commits/${stat.sha}/pulls?per_page=100`, { tolerate: true });
  let originPrs = associated.map((pr) => ({
    number: pr.number, title: pr.title, url: pr.html_url,
    author: pr.user?.login || null, mergedAt: pr.merged_at || null, source: "commit-pulls-api",
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
    const seen = new Set();
    originPr.reviewers = reviewedCommitsByReviewer(output).map((r) => {
      seen.add(normalizeLogin(r.reviewer));
      const commits = r.reviewedCommits.map((c) => {
        const result = presenceAt(stat, block, c.sha);
        presenceMethodCounts[result.method === "unmeasurable" ? "unmeasurable" : result.method] += 1;
        return { ...c, ...result };
      });
      const withOpportunity = commits.filter((c) => c.present === true);

      // Three distinct negatives that must not collapse into one. A reviewer
      // that published only on an unpinned surface cannot be placed on any
      // commit, so nothing is known about what it saw -- reporting that as
      // `false` reads as "it ran and the bug was not there yet", which is a
      // different and unearned claim.
      let hadOpportunity;
      let reason = null;
      if (!shareOk) {
        hadOpportunity = null;
        reason = "origin-share-below-threshold";
      } else if (withOpportunity.length > 0) {
        hadOpportunity = true;
      } else if (commits.length === 0 && r.unpinnedPublications > 0) {
        hadOpportunity = null;
        reason = "published-only-on-an-unpinned-surface";
      } else if (commits.length === 0) {
        hadOpportunity = false;
        reason = "no-published-output-on-this-pr";
      } else if (commits.some((c) => c.present === null)) {
        hadOpportunity = null;
        reason = "presence-could-not-be-established";
      } else {
        hadOpportunity = false;
        reason = "buggy-lines-absent-at-every-reviewed-commit";
      }

      return {
        reviewer: roster.spell(r.reviewer),
        publishedAs: r.reviewer,
        reviewedCommits: commits,
        unpinnedPublications: r.unpinnedPublications,
        hadOpportunity,
        reason,
        firstOpportunity: withOpportunity[0] || null,
      };
    });
    for (const login of roster.logins) {
      if (!seen.has(login)) {
        originPr.reviewers.push({
          reviewer: roster.spell(login), publishedAs: null,
          reviewedCommits: [], unpinnedPublications: 0,
          hadOpportunity: false, reason: "no-published-output-on-this-pr", firstOpportunity: null,
        });
      }
    }
  }

  origins.push({
    sha: stat.sha,
    lines: stat.lines,
    shareOfBlamedLines: stat.share,
    shareAboveThreshold: shareOk,
    boundary: stat.boundary,
    authoredAt: meta?.authoredAt || null,
    author: meta?.author || null,
    subject: meta?.subject || null,
    buggyBlock: block,
    rejectedBlocks,
    originPrs,
  });
}

if (presenceMethodCounts.ancestry === 0 && presenceMethodCounts.content > 0) {
  warn(
    "ancestry never fired: every presence verdict in this trace rests on the approximate verbatim-content test. " +
      "This is expected on a squash-merge repository and means a reformatted line reads as absent.",
  );
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
  thresholds: { maxOrigins, minLines, minShare, minBlockChars: MIN_BLOCK_CHARS },
  presenceMethodCounts,
  historyArtefactsExcluded: artefacts.map((a) => ({ sha: a.sha, lines: a.lines, subject: a.subject })),
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
