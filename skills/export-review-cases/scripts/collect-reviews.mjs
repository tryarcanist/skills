#!/usr/bin/env node
// Everything needed to judge whether a reviewer's finding on one PR was a real
// defect, and whether the team acted on it.
//
// This is the caught-bug counterpart to trace-origin.mjs. The ground truth here
// is weaker by construction -- the finding came from the reviewer, so the
// reviewer chose the subject -- and the adjudicator has to supply what the fix
// commit supplies on the shipped side. Two signals do most of that work and
// both are collected here:
//
//   commitsAfter   Commits pushed after the finding was published. A finding
//                  followed by a commit touching the same file is the cheapest
//                  evidence that a human agreed.
//   humanResponse  Replies and top-level comments from people, which is where
//                  an explicit "good catch" or "this is wrong" lives.
//
// Neither proves the finding was a defect. A team fixes nits, and a team
// ignores real bugs to ship. They are inputs to adjudication, not verdicts.
//
// Usage:
//   collect-reviews.mjs --repo owner/repo --pr <number> --only "arcanist[bot]" --out file
//   collect-reviews.mjs --self-test

import { writeFileSync } from "node:fs";
import { ghJson, ghOne, makeRoster, normalizeLogin, parseArgs, warnings } from "./lib/gh.mjs";
import { fetchReviewerOutput } from "./lib/reviews.mjs";

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: collect-reviews.mjs --repo owner/repo --pr <number> --only \"bot-a,bot-b\" --out file\n" +
      "       collect-reviews.mjs --self-test\n",
  );
  process.exit(2);
}

// A commit counts as a response only if it landed after the finding was
// published. Ordering by timestamp is the only ordering available across a
// force push, so an unparseable timestamp is dropped rather than guessed.
function commitsAfter(commits, publishedAt) {
  if (!publishedAt) return null;
  const cutoff = Date.parse(publishedAt);
  if (Number.isNaN(cutoff)) return null;
  return commits
    .filter((c) => c.committedAt && Date.parse(c.committedAt) > cutoff)
    .map((c) => ({ sha: c.sha, committedAt: c.committedAt, subject: c.subject, files: c.files }));
}

function selfTest() {
  const cases = [];
  const eq = (name, actual, expected) =>
    cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  const commits = [
    { sha: "a", committedAt: "2026-01-01T00:00:00Z", subject: "one", files: [] },
    { sha: "b", committedAt: "2026-01-03T00:00:00Z", subject: "two", files: [] },
  ];
  eq("only later commits count", commitsAfter(commits, "2026-01-02T00:00:00Z").map((c) => c.sha), ["b"]);
  eq("an unknown publication time is unmeasured, not empty", commitsAfter(commits, null), null);
  eq("an unparseable publication time is unmeasured", commitsAfter(commits, "whenever"), null);
  eq("nothing after the last commit", commitsAfter(commits, "2026-02-01T00:00:00Z"), []);

  for (const c of cases) process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.name}\n`);
  const failed = cases.filter((c) => !c.ok);
  for (const c of failed) process.stdout.write(`     actual=${JSON.stringify(c.actual)} expected=${JSON.stringify(c.expected)}\n`);
  process.exit(failed.length ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2), {
  repo: "value", pr: "value", only: "value", out: "value", selfTest: "flag",
});
if (args.error) usage(args.error);
if (args.selfTest) selfTest();
if (!args.repo || !args.pr || !args.only || !args.out) usage("--repo, --pr, --only and --out are required");

const roster = makeRoster(args.only);
const prNum = String(args.pr).match(/(\d+)(?!.*\d)/)?.[1];
if (!prNum) usage(`could not read a PR number from ${args.pr}`);

const pr = ghOne(`repos/${args.repo}/pulls/${prNum}`);
if (!pr) usage(`PR ${prNum} could not be read`);

const rawCommits = ghJson(`repos/${args.repo}/pulls/${prNum}/commits?per_page=100`);
const commits = rawCommits.map((c) => ({
  sha: c.sha,
  committedAt: c.commit?.committer?.date || null,
  subject: (c.commit?.message || "").split("\n")[0],
  files: null, // filled below only for commits that follow a finding
}));

const output = fetchReviewerOutput(args.repo, prNum, roster);

const fileCache = new Map();
function filesOf(sha) {
  if (fileCache.has(sha)) return fileCache.get(sha);
  const detail = ghOne(`repos/${args.repo}/commits/${sha}`, { tolerate: true });
  const files = detail?.files ? detail.files.map((f) => f.filename) : null;
  fileCache.set(sha, files);
  return files;
}

const findings = output.map((item) => {
  const after = commitsAfter(commits, item.submittedAt);
  if (after) for (const c of after) c.files = filesOf(c.sha);
  const touchedSamePath =
    item.path && after ? after.some((c) => (c.files || []).includes(item.path)) : null;
  return { ...item, commitsAfter: after, followedByCommitTouchingSamePath: touchedSamePath };
});

const isRoster = (login) => roster.has(login);
const humanReplies = ghJson(`repos/${args.repo}/pulls/${prNum}/comments?per_page=100`, { tolerate: true })
  .filter((c) => !isRoster(c.user?.login) && c.in_reply_to_id)
  .map((c) => ({
    id: `inline-${c.id}`, inReplyTo: `inline-${c.in_reply_to_id}`,
    author: c.user?.login || null, isPrAuthor: normalizeLogin(c.user?.login) === normalizeLogin(pr.user?.login),
    createdAt: c.created_at, body: c.body, url: c.html_url,
  }));

const humanComments = ghJson(`repos/${args.repo}/issues/${prNum}/comments?per_page=100`, { tolerate: true })
  .filter((c) => !isRoster(c.user?.login) && c.user?.type !== "Bot")
  .map((c) => ({
    id: `comment-${c.id}`, author: c.user?.login || null,
    isPrAuthor: normalizeLogin(c.user?.login) === normalizeLogin(pr.user?.login),
    createdAt: c.created_at, body: c.body, url: c.html_url,
  }));

const out = {
  schemaVersion: "review-cases-reviews-v1",
  repo: args.repo,
  roster: roster.logins,
  pr: {
    number: Number(prNum), title: pr.title, url: pr.html_url,
    author: pr.user?.login || null, mergedAt: pr.merged_at, mergeCommit: pr.merge_commit_sha || null,
    headSha: pr.head?.sha || null, baseSha: pr.base?.sha || null,
    changedFiles: pr.changed_files, additions: pr.additions, deletions: pr.deletions,
    body: pr.body || "",
  },
  commits: commits.map(({ files, ...rest }) => rest),
  // The roster's own spelling, so one file never carries both "cursor" and
  // "cursor[bot]" for the same identity.
  reviewersWithoutOutput: roster.logins
    .filter((l) => !output.some((o) => normalizeLogin(o.reviewer) === l))
    .map((l) => roster.spell(l)),
  findings,
  humanReplies,
  humanComments,
  warnings,
  generatedAt: new Date().toISOString(),
};

writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
process.stderr.write(`PR ${prNum}: ${findings.length} published item(s) from ${roster.logins.length} reviewer(s) -> ${args.out}\n`);
