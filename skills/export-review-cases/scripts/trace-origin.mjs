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
import { loadConfig, makePathPolicy } from "./lib/config.mjs";
import { commentMask, languageFor } from "./lib/lang.mjs";

const DEFAULT_MAX_ORIGINS = 5;
// A one-line root cause is the most common bug shape there is, and pooling
// share across every file of a multi-file fix puts one below any threshold by
// construction. Both gates cost real cases in testing and neither was load
// bearing once non-product paths, deletion-only ranges and needle substance
// were enforced, so both default to off.
const DEFAULT_MIN_LINES = 1;
const DEFAULT_MIN_SHARE = 0;
const MIN_BLOCK_CHARS = 40;

// Files whose blame says nothing about who introduced a defect.
const UNINFORMATIVE_PATH =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$|\.(snap|lock|svg|png|jpe?g|gif|ico|pdf|min\.js|min\.css)$/i;

// CI and workflow files are deliberately NOT excluded: `bug.boundary` offers
// `infra-config`, and a bug introduced in a workflow is a real shipped bug.
//
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
  /^\s*(?:\/\/|#(?!\s*(?:if|include|define))|\*|\/\*|--|<!--|import\s|from\s+\S+\s+import\s|export\s*\{|use\s+\w|package\s+\w|require\(|@\w+\s*$|[{}()\[\];,]*$)/;

// Executable logic: a call, a branch, a comparison, an assignment to a member
// or index, a channel or short-variable operator. Its absence does not
// disqualify a needle, but its presence is what separates "the code that
// misbehaves" from "a declaration the fix happened to touch" -- a widened type
// alias, an interface field, a css rule. Add repo-specific syntax with
// `statementSignalExtra` in the config file rather than editing this.
const STATEMENT_SIGNAL =
  /\b(if|else|for|while|return|throw|await|switch|case|try|catch|finally|yield|raise|assert|def|func|function|lambda|match|unless|elsif|when)\b|=>|->|<-|:=|\w\s*\(|[!<>]=|==|&&|\|\||\?\?|\+=|-=|\.\w+\(|[\w\]\)](?:\.\w+|\[[^\]]+\])\s*=[^=]/;

// Substantive code lines of one run, given the file's comment mask.
// Populated once the config is read; empty until then so the exported helpers
// stay usable from a self-test.
let extraLanguages = [];
let extraStatementSignal = null;
const isStatement = (line) =>
  STATEMENT_SIGNAL.test(line) || (extraStatementSignal ? extraStatementSignal.test(line) : false);

function runCodeLines(lines, mask, start, end) {
  const out = [];
  for (let n = start; n <= end && n <= lines.length; n += 1) {
    const raw = lines[n - 1];
    if (mask[n - 1] || !raw || !raw.trim() || NOISE_LINE.test(raw)) continue;
    out.push(raw.trim().replace(/\s+/g, " "));
  }
  return out;
}

// Block-local versions, for callers with no surrounding file. `path` lets the
// language table pick the right comment syntax; without one the mask falls back
// to every style at once, which masks more and invents nothing.
function codeLines(block, path = "") {
  const lines = String(block || "").split("\n");
  return runCodeLines(lines, commentMask(block, path, extraLanguages), 1, lines.length);
}

// How much of a block is actually distinguishing code. A needle made of
// boilerplate answers the presence question by accident, in whichever
// direction the file happens to fall.
export function substantiveLength(block, path = "") {
  return codeLines(block, path).join("\n").length;
}

// Does the block contain executable logic, or only declarations?
export function needleKind(block, path = "") {
  return codeLines(block, path).some((l) => isStatement(l)) ? "statement" : "declaration";
}

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: trace-origin.mjs --repo owner/repo --pr <fix-pr> --only \"bot-a,bot-b\"\n" +
      "                       [--repo-path .] [--max-origins N] [--min-lines N] [--min-share 0.1]\n" +
      "                       [--config review-cases.config.json] --out file\n" +
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
  eq("a docstring line is not substantive", substantiveLength('"""Create an organization in the database for integration tests."""', "a.py"), 0);
  eq("real code is substantive", substantiveLength("if (!member) return { ok: true };\n  ledger.record(member.id, now);") >= MIN_BLOCK_CHARS, true);
  eq("prose inside a docstring is not substantive",
    substantiveLength('"""\nRetries are dispatched hourly so that a failed report is picked up\nby the next scheduled run without operator action.\n"""'), 0);
  eq("a block comment interior is not substantive",
    substantiveLength("/*\n  This explains at length why the cadence was chosen.\n*/"), 0);
  eq("code after a docstring survives",
    needleKind('"""Doc."""\nif (retry.count > limit) { return null; }'), "statement");
  eq("a statement needle is a statement", needleKind('queryClient.invalidateQueries({ queryKey: ["a"] });'), "statement");
  eq("a type alias is only a declaration", needleKind('type JobStatus = "active" | "terminal_failed";'), "declaration");
  eq("an interface field list is only a declaration", needleKind("  retries: number;\n  lastRunAt: string;"), "declaration");
  eq("a css rule is only a declaration", needleKind(".panel { margin-top: 12px; }"), "declaration");
  eq("an object member the fix rewrote is still a usable declaration needle",
    [needleKind("staleTime: Infinity,"), substantiveLength("staleTime: Infinity,") > 0], ["declaration", true]);
  eq("assignment to a member or index is a statement",
    needleKind('response.headers["Cache-Control"] = "public, max-age=3600"'), "statement");
  const pyFile = [
    "def options(db):",
    '    """Return all integration vendor options.',
    "",
    "    Public endpoint. Integration enum values are static;",
    "    group list requires a DB query.",
    '    """',
    '    response.headers["Cache-Control"] = "public, max-age=3600"',
  ].join("\n");
  eq("a ruby =begin block is masked", commentMask(["def f", "=begin", "prose", "=end", "1"].join("\n"), "a.rb").map((m) => (m ? 1 : 0)), [0, 1, 1, 1, 0]);
  eq("a lua long comment is masked, not read as a line comment",
    commentMask(["local a", "--[[", "prose", "]]", "local b"].join("\n"), "a.lua").map((m) => (m ? 1 : 0)), [0, 1, 1, 1, 0]);
  eq("an unknown extension masks conservatively",
    commentMask(["code", "% prose", "code"].join("\n"), "a.unknownext").map((m) => (m ? 1 : 0)), [0, 1, 0]);
  eq("go short assignment reads as a statement", needleKind("count := len(rows)\nif count > cap { return errTooMany }", "a.go"), "statement");
  eq("a ruby guard reads as a statement", needleKind("raise ArgumentError unless member.admin?", "a.rb"), "statement");
  eq("a docstring interior is masked across the whole file",
    commentMask(pyFile).map((m) => (m ? 1 : 0)), [0, 1, 1, 1, 1, 1, 0]);

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
  maxOrigins: "value", minLines: "value", minShare: "value", config: "value",
  out: "value", selfTest: "flag",
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

const config = loadConfig({ explicit: args.config, repoPath });
for (const problem of config.problems) warn(`config: ${problem}`);
if (config.source) process.stderr.write(`using overrides from ${config.source}\n`);
extraLanguages = config.languages || [];
if (config.statementSignalExtra) extraStatementSignal = new RegExp(config.statementSignalExtra);
const minBlockChars = config.minBlockChars ?? MIN_BLOCK_CHARS;
const pathPolicy = makePathPolicy(NON_PRODUCT_PATH, config);

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
  if (pathPolicy.isNonProduct(prePath)) {
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

// Counted after history artefacts are identified below, so that a subtree
// import the script has already decided to ignore cannot dilute a real
// origin's share.
let totalBlamedLines = 0;
for (const stat of originStats.values()) {
  const meta = commitMeta(repoPath, stat.sha);
  stat.subject = meta?.subject || null;
  stat.meta = meta;
  stat.historyArtifact = HISTORY_ARTIFACT_SUBJECT.test(stat.subject || "");
}

totalBlamedLines = [...originStats.values()].filter((x) => !x.historyArtifact).reduce((n, x) => n + x.lines, 0);
for (const stat of originStats.values()) {
  stat.share = totalBlamedLines && !stat.historyArtifact ? Number((stat.lines / totalBlamedLines).toFixed(3)) : null;
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
  const rejected = [];
  const usable = [];
  const fileCache = new Map();
  for (const option of options) {
    if (!fileCache.has(option.path)) {
      const text = fileAt(repoPath, preFixSha, option.path);
      fileCache.set(
        option.path,
        text === null
          ? null
          : {
              lines: text.split("\n"),
              mask: commentMask(text, option.path, extraLanguages),
              language: languageFor(option.path, extraLanguages),
            },
      );
    }
    const file = fileCache.get(option.path);
    if (file === null) continue;
    const block = file.lines.slice(option.run.start - 1, option.run.end).join("\n");
    const kept = runCodeLines(file.lines, file.mask, option.run.start, option.run.end);
    const weight = kept.join("\n").length;
    const kind = kept.some((l) => isStatement(l)) ? "statement" : "declaration";
    if (weight < minBlockChars) {
      rejected.push({ path: option.path, start: option.run.start, end: option.run.end, substantiveChars: weight, needleKind: kind });
      continue;
    }
    usable.push({
      path: option.path, start: option.run.start, end: option.run.end,
      block, substantiveChars: weight, needleKind: kind,
      languageRecognised: file.language.matched, languageExt: file.language.ext,
      lines: option.run.end - option.run.start + 1,
    });
  }
  // Sorting by raw run length steered toward comment blocks, which are the
  // longest single-author runs in most files. Prefer executable logic, then
  // the most distinguishing code.
  usable.sort((a, b) => {
    if (a.needleKind !== b.needleKind) return a.needleKind === "statement" ? -1 : 1;
    return b.substantiveChars - a.substantiveChars;
  });
  return { block: usable[0] || null, rejected };
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
  const shareOk = minShare <= 0 ? true : stat.share !== null && stat.share >= minShare;
  if (!shareOk) {
    warn(
      `origin ${stat.sha.slice(0, 10)} owns ${Math.round((stat.share || 0) * 100)}% of blamed lines ` +
        `(below --min-share ${minShare}); its reviewer opportunities are reported as unmeasured`,
    );
  }

  if (block && block.needleKind === "declaration") {
    warn(
      `origin ${stat.sha.slice(0, 10)}: the only usable needle is a declaration ` +
        `(${block.path}:${block.start}-${block.end}), not executable logic. Presence may be exact while the ` +
        `block is not the mechanism -- read origins[].buggyBlock before writing a case.`,
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
        // Report the underlying cause rather than a generic one: "no usable
        // needle" and "commit unreachable" call for different next steps.
        const causes = [...new Set(commits.filter((c) => c.present === null).map((c) => c.reason))];
        reason = causes.length === 1 ? causes[0] : "presence-could-not-be-established";
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
    needleKind: block?.needleKind || null,
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
  thresholds: { maxOrigins, minLines, minShare, minBlockChars },
  config: config.source ? { source: config.source, paths: pathPolicy.describe(), problems: config.problems } : null,
  unrecognisedLanguages: [
    ...new Set(
      origins
        .filter((o) => o.buggyBlock && o.buggyBlock.languageRecognised === false)
        .map((o) => o.buggyBlock.languageExt || "(no extension)"),
    ),
  ],
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
