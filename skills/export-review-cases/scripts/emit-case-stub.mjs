#!/usr/bin/env node
// Pre-fill everything about a case that is already known, so the adjudicator
// spends its attention on the parts that need judgement.
//
// Every mechanical field -- the repository, the reviewer, the origin commit and
// pull request, the exact reviewed commit, how presence was established, what
// the reviewer actually published at that commit, the fix and its paths --
// comes from the trace or reviews file. What is left is the judgement:
// what went wrong, what triggered it, what came out instead, and what would
// have caught it.
//
// Those judgement fields are emitted as "TODO:" strings, which fail
// `build-bundle.mjs` validation on purpose. A stub is not a case, and an
// unedited stub must never reach a bundle.
//
// Usage:
//   emit-case-stub.mjs --trace <RUN_DIR>/origins/<fix-pr>.json \
//     --origin <sha|index> --origin-pr <pr> --reviewer "<login>" --out <file>
//   emit-case-stub.mjs --reviews <RUN_DIR>/reviews/<pr>.json \
//     --finding <finding-id> --out <file>
//   emit-case-stub.mjs --self-test

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeLogin, parseArgs } from "./lib/gh.mjs";

const TODO = (what) => `TODO: ${what}`;
const EXCERPT_CHARS = 600;

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: emit-case-stub.mjs --trace <origins/N.json> --origin <sha|index> [--origin-pr N] --reviewer <login> --out <file>\n" +
      "       emit-case-stub.mjs --reviews <reviews/N.json> --finding <id> --out <file>\n" +
      "       emit-case-stub.mjs --self-test\n",
  );
  process.exit(2);
}

export function slug(text, max = 40) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

// What the reviewer published at or around the reviewed commit. A missed case
// has no quotes by definition, so without this the bundle carries no evidence
// of what the reviewer was doing instead -- which is the contrast that makes a
// miss legible to whoever has to improve the reviewer.
export function publishedItemsAt(reviewerOutput, reviewer, reviewedCommit) {
  return (reviewerOutput || [])
    .filter((item) => normalizeLogin(item.reviewer) === normalizeLogin(reviewer))
    .filter((item) => !reviewedCommit || !item.reviewedCommit || item.reviewedCommit === reviewedCommit)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      url: item.url,
      path: item.path || null,
      line: item.line ?? null,
      reviewedCommit: item.reviewedCommit || null,
      excerpt: String(item.body || "").slice(0, EXCERPT_CHARS),
      bodyTruncated: Boolean(item.bodyTruncated),
    }));
}

function selfTest() {
  const cases = [];
  const eq = (name, actual, expected) =>
    cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

  eq("slugs are safe for filenames", slug("Fix Modal control metadata path!"), "fix-modal-control-metadata-path");
  eq("slug trims trailing separators", slug("a --- b ---"), "a-b");

  const output = [
    { reviewer: "arcanist[bot]", id: "inline-1", kind: "inline", body: "x", reviewedCommit: "aaa", path: "a.ts", line: 3 },
    { reviewer: "arcanist[bot]", id: "inline-2", kind: "inline", body: "y", reviewedCommit: "bbb" },
    { reviewer: "cursor[bot]", id: "inline-3", kind: "inline", body: "z", reviewedCommit: "aaa" },
    { reviewer: "arcanist[bot]", id: "comment-4", kind: "summary", body: "w", reviewedCommit: null },
  ];
  eq("only this reviewer, only this commit, plus unpinned",
    publishedItemsAt(output, "arcanist", "aaa").map((i) => i.id), ["inline-1", "comment-4"]);
  eq("roster spelling does not change the match",
    publishedItemsAt(output, "arcanist[bot]", "aaa").map((i) => i.id), ["inline-1", "comment-4"]);
  eq("a reviewer with nothing published yields an empty list",
    publishedItemsAt(output, "greptile-apps", "aaa"), []);

  for (const c of cases) process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.name}\n`);
  const failed = cases.filter((c) => !c.ok);
  for (const c of failed) process.stdout.write(`     actual=${JSON.stringify(c.actual)} expected=${JSON.stringify(c.expected)}\n`);
  process.exit(failed.length ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2), {
  trace: "value", origin: "value", originPr: "value", reviewer: "value",
  reviews: "value", finding: "value", out: "value", selfTest: "flag",
});
if (args.error) usage(args.error);
if (args.selfTest) selfTest();
if (!args.out) usage("--out is required");

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
let stub;

if (args.trace) {
  if (!args.reviewer) usage("--reviewer is required with --trace");
  const trace = read(args.trace);
  const origin = /^\d+$/.test(String(args.origin || ""))
    ? trace.origins[Number(args.origin)]
    : trace.origins.find((o) => o.sha.startsWith(String(args.origin || "")));
  if (!origin) usage(`--origin ${args.origin} matched no origin in ${args.trace}`);

  const originPr = args.originPr
    ? origin.originPrs.find((p) => String(p.number) === String(args.originPr))
    : origin.originPrs.find((p) => !p.selfReference);
  if (!originPr) usage("no origin pull request to build a case from");

  const reviewer = originPr.reviewers?.find(
    (r) => normalizeLogin(r.reviewer) === normalizeLogin(args.reviewer),
  );
  if (!reviewer) usage(`--reviewer ${args.reviewer} has no row on origin PR ${originPr.number}`);
  if (reviewer.hadOpportunity !== true) {
    process.stderr.write(
      `error: ${args.reviewer} has hadOpportunity=${reviewer.hadOpportunity} (${reviewer.reason || "no reason recorded"}) ` +
        `on PR ${originPr.number}. Only a demonstrated opportunity can become a case.\n`,
    );
    process.exit(2);
  }

  const reviewedCommit = reviewer.firstOpportunity.sha;
  stub = {
    schemaVersion: "review-case-v1",
    caseId: `TODO-${trace.fix.pr}-${slug(trace.fix.title, 30)}`,
    repo: trace.repo,
    reviewer: reviewer.reviewer,
    verdict: TODO("missed or caught, after reading what the reviewer published below"),
    resolution: "fixed",
    confidence: TODO("high, medium or low"),
    bug: {
      summary: TODO("one line: what goes wrong, in the product's vocabulary"),
      mechanism: TODO("the specific code path; name the predicate, guard or value that is wrong"),
      trigger: TODO("the concrete input or state that reaches it"),
      wrongOutput: TODO("what the user, caller or stored record actually gets"),
      severity: TODO("blocking, major, minor or nit"),
      class: TODO("correctness, race, authz, data-money, perf, error-handling, api-contract, tests or other"),
      boundary: TODO("single-file, cross-function, cross-module, cross-service or infra-config"),
    },
    origin: {
      pr: originPr.number,
      url: originPr.url,
      sha: origin.sha,
      subject: origin.subject,
      path: origin.buggyBlock?.path || null,
      paths: origin.buggyBlock ? [origin.buggyBlock.path] : [],
      lines: origin.buggyBlock ? [origin.buggyBlock.start, origin.buggyBlock.end] : null,
      shareOfBlamedLines: origin.shareOfBlamedLines,
    },
    reviewedAt: {
      commit: reviewedCommit,
      reviewer: reviewer.reviewer,
      publishedAt: reviewer.firstOpportunity.firstSeenAt || null,
      presenceMethod: reviewer.firstOpportunity.method,
    },
    reviewerOutputAtThatCommit: {
      published: true,
      namedTheMechanism: TODO("true or false -- this mechanism, not this file or this function"),
      quotes: [],
      publishedItems: publishedItemsAt(originPr.reviewerOutput, reviewer.reviewer, reviewedCommit),
    },
    fix: {
      pr: trace.fix.pr,
      url: trace.fix.url,
      mergeCommit: trace.fix.mergeCommit,
      mergedAt: trace.fix.mergedAt,
      summary: TODO("what the fix changed, in one line"),
      paths: trace.files.filter((f) => f.state === "observed").map((f) => f.path),
    },
    whatWouldHaveCaughtIt: TODO("a concrete act: the command to run, the caller to open, the two paths to compare"),
    skeptic: { ran: false, verdict: null, note: null },
    provenance: {
      trace: args.trace,
      buggyBlock: origin.buggyBlock,
      rejectedBlocks: origin.rejectedBlocks,
      presenceReason: reviewer.reason,
    },
  };
} else if (args.reviews) {
  if (!args.finding) usage("--finding is required with --reviews");
  const reviews = read(args.reviews);
  const finding = reviews.findings.find((f) => f.id === args.finding);
  if (!finding) usage(`--finding ${args.finding} not found in ${args.reviews}`);

  stub = {
    schemaVersion: "review-case-v1",
    caseId: `TODO-${reviews.pr.number}-${slug(finding.path || finding.kind, 30)}`,
    repo: reviews.repo,
    reviewer: finding.reviewer,
    verdict: TODO('"caught" if this finding describes a real defect at the reviewed commit'),
    resolution: TODO("fixed, acknowledged, deferred or none"),
    resolutionEvidence: TODO("who acknowledged or fixed it, and where -- required unless resolution is fixed"),
    confidence: TODO("high, medium or low"),
    bug: {
      summary: TODO("one line, in your words, not the reviewer's"),
      mechanism: TODO("the specific code path"),
      trigger: TODO("the concrete input or state"),
      wrongOutput: TODO("what actually comes out"),
      severity: TODO("re-rate this yourself; reviewers over-rate"),
      class: TODO("correctness, race, authz, data-money, perf, error-handling, api-contract, tests or other"),
      boundary: TODO("single-file, cross-function, cross-module, cross-service or infra-config"),
    },
    origin: {
      pr: reviews.pr.number,
      url: reviews.pr.url,
      sha: finding.reviewedCommit,
      path: finding.path || null,
      paths: finding.path ? [finding.path] : [],
      lines: finding.line ? [finding.line, finding.line] : null,
    },
    fixedInSamePr: true,
    reviewedAt: {
      commit: finding.reviewedCommit,
      reviewer: finding.reviewer,
      publishedAt: finding.submittedAt,
      presenceMethod: "manual",
    },
    reviewerOutputAtThatCommit: {
      published: true,
      namedTheMechanism: true,
      quotes: [String(finding.body || "").slice(0, EXCERPT_CHARS)],
      publishedItems: publishedItemsAt(reviews.findings, finding.reviewer, finding.reviewedCommit),
    },
    fix: { pr: null, url: null, summary: TODO("what repaired it, or null if nothing did"), paths: finding.path ? [finding.path] : [] },
    whatWouldHaveCaughtIt: TODO("what this reviewer did that the others did not"),
    skeptic: { ran: false, verdict: null, note: null },
    provenance: {
      reviews: args.reviews,
      findingId: finding.id,
      commitsAfter: finding.commitsAfter,
      followedByCommitTouchingSamePath: finding.followedByCommitTouchingSamePath,
      bodyTruncated: Boolean(finding.bodyTruncated),
      humanReplies: (reviews.humanReplies || []).filter((r) => r.inReplyTo === finding.id),
    },
  };
} else {
  usage("either --trace or --reviews is required");
}

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(stub, null, 2)}\n`);
const todos = JSON.stringify(stub).match(/TODO:/g)?.length || 0;
process.stderr.write(`stub written to ${args.out} with ${todos} field(s) still to judge\n`);
