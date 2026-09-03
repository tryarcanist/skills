#!/usr/bin/env node
// Propose pull requests worth turning into review cases. Two modes, mined from
// opposite ends, because the two case types have different ground truth.
//
//   --mode shipped   Merged fix PRs. A merged fix is proof that a bug was real
//                    and that the team cared enough to repair it. Mining from
//                    fixes rather than from reviewer output is the point: it
//                    can surface a bug no reviewer ever mentioned, which is
//                    exactly the case a reviewer-first search cannot see.
//
//   --mode caught    Merged PRs carrying a published review from the roster.
//                    These become the counterweight cases, but only after
//                    adjudication confirms the finding was a real defect.
//
// This script proposes. It never labels. Every candidate here is a lead for
// trace-origin.mjs and a human-or-agent adjudication pass, and a candidate that
// survives neither is a normal outcome, not a collection failure.
//
// Usage:
//   find-candidates.mjs --repo owner/repo --mode shipped|caught \
//     --since 2026-08-01 --until 2026-09-01 [--authors a,b] \
//     [--only "arcanist[bot],cursor[bot]"] [--limit 300] --out file
//   find-candidates.mjs --self-test

import { writeFileSync } from "node:fs";
import { ghPrList, makeRoster, parseArgs, validateWindow, warn, warnings } from "./lib/gh.mjs";
import { loadConfig } from "./lib/config.mjs";

const DEFAULT_LIMIT = 1000;
const MIN_SPLIT_DAYS = 1;

// Signals that a merged PR repaired a defect. Weighted, because a title word is
// weak evidence on its own and a linked bug issue is strong.
const FIX_SIGNALS = [
  { name: "revert", weight: 4, test: (t) => /^revert\b|\brevert(s|ed|ing)?\b/i.test(t.title) },
  { name: "bug-label", weight: 4, test: (t) => t.labelText.some((l) => /bug|regression|incident|sev[0-9]|hotfix|outage/i.test(l)) },
  { name: "closes-issue", weight: 3, test: (t) => /\b(fix(es|ed)?|close[sd]?|resolve[sd]?)\s+#\d+/i.test(t.body) },
  { name: "title-fix", weight: 3, test: (t) => /\b(fix|fixes|fixed|bug|bugfix|hotfix|regression|revert|repair)\b/i.test(t.title) },
  { name: "title-symptom", weight: 2, test: (t) => /\b(crash|broken|breaks|incorrect|wrong|missing|leak|hang|stale|duplicate|race|deadlock|timeout|null|undefined|off-by-one|500|not working)\b/i.test(t.title) },
  { name: "body-symptom", weight: 1, test: (t) => /\b(root cause|regression|reproduce[sd]?|repro\b|stack trace|traceback|incident|postmortem)\b/i.test(t.body) },
];

// A merged PR whose title reads like routine upkeep is dropped before scoring.
// These produce traceable blame ranges and no bug, which wastes the expensive
// adjudication pass.
const UPKEEP_TITLE = /^(chore|docs?|style|refactor|test|ci|build|deps?|dependabot|bump|release|version|merge branch|revert "revert)\b/i;

// Repo-specific signals from the config file are compiled into the same shape,
// so a repository that names pull requests by ticket id alone can be scored
// without editing this file. `field` is title, body, or label.
export function compileExtraSignals(extras, onProblem) {
  const out = [];
  for (const extra of extras || []) {
    try {
      const re = new RegExp(extra.pattern, "i");
      const field = ["title", "body", "label"].includes(extra.field) ? extra.field : "title";
      out.push({
        name: extra.name || `config:${field}`,
        weight: Number(extra.weight) || 1,
        test: (t) =>
          field === "label" ? t.labelText.some((l) => re.test(l)) : re.test(field === "body" ? t.body : t.title),
      });
    } catch (e) {
      onProblem(`fixSignalsExtra ${JSON.stringify(extra).slice(0, 60)}: ${e.message}`);
    }
  }
  return out;
}

let activeSignals = FIX_SIGNALS;

function scoreFixSignals(pr) {
  const target = {
    title: pr.title || "",
    body: pr.body || "",
    labelText: (pr.labels || []).map((l) => l.name || ""),
  };
  const signals = activeSignals.filter((s) => s.test(target));
  return { signals: signals.map((s) => s.name), score: signals.reduce((n, s) => n + s.weight, 0) };
}

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: find-candidates.mjs --repo owner/repo --mode shipped|caught --since DATE --until DATE\n" +
      "                          [--authors a,b] [--only \"bot-a,bot-b\"] [--limit N] --out file\n" +
      "       find-candidates.mjs --self-test\n",
  );
  process.exit(2);
}

function selfTest() {
  const cases = [];
  const eq = (name, actual, expected) =>
    cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

  eq("a linked bug issue outscores a bare title word",
    scoreFixSignals({ title: "Fix retry", body: "Fixes #42", labels: [] }).score > 
      scoreFixSignals({ title: "Fix retry", body: "", labels: [] }).score, true);
  eq("a bug label is detected", scoreFixSignals({ title: "Adjust cap", body: "", labels: [{ name: "bug" }] }).signals, ["bug-label"]);
  eq("a revert is detected", scoreFixSignals({ title: 'Revert "Add cache"', body: "", labels: [] }).signals.includes("revert"), true);
  eq("a clean feature PR scores zero", scoreFixSignals({ title: "Add export button", body: "", labels: [] }).score, 0);
  eq("upkeep titles are recognised", ["chore: bump deps", "docs: readme", "Refactor client"].map((t) => UPKEEP_TITLE.test(t)), [true, true, true]);
  eq("a real fix title is not upkeep", UPKEEP_TITLE.test("Fix stale cache key after fallback"), false);
  eq("symptom words alone still qualify", scoreFixSignals({ title: "Stop the duplicate webhook", body: "", labels: [] }).score > 0, true);
  const extra = compileExtraSignals(
    [{ name: "jira-defect", weight: 3, field: "title", pattern: "^DEF-\\d+" },
     { name: "bad-regex", weight: 1, field: "title", pattern: "(unclosed" }],
    () => {},
  );
  eq("a valid config signal compiles and an invalid one is dropped", extra.length, 1);
  eq("a config signal matches its field",
    extra[0].test({ title: "DEF-4102 correct the payout split", body: "", labelText: [] }), true);
  eq("a config signal does not match other text",
    extra[0].test({ title: "Add export button", body: "DEF-4102", labelText: [] }), false);

  for (const c of cases) process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.name}\n`);
  const failed = cases.filter((c) => !c.ok);
  for (const c of failed) process.stdout.write(`     actual=${JSON.stringify(c.actual)} expected=${JSON.stringify(c.expected)}\n`);
  process.exit(failed.length ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2), {
  repo: "value", mode: "value", since: "value", until: "value",
  authors: "value", only: "value", limit: "value", config: "value", out: "value", selfTest: "flag",
});
if (args.error) usage(args.error);
if (args.selfTest) selfTest();
if (!args.repo) usage("--repo is required");
if (!["shipped", "caught"].includes(args.mode)) usage("--mode must be shipped or caught");
if (!args.since || !args.until) usage("--since and --until are required");
if (!args.out) usage("--out is required");

const windowProblems = validateWindow(args.since, args.until);
if (windowProblems.length) usage(windowProblems.join("; "));

const config = loadConfig({ explicit: args.config });
for (const problem of config.problems) warn(`config: ${problem}`);
const extraSignals = compileExtraSignals(config.fixSignalsExtra, (p) => warn(`config: ${p}`));
activeSignals = [...FIX_SIGNALS, ...extraSignals];
if (config.source) process.stderr.write(`using overrides from ${config.source} (${extraSignals.length} extra fix signal(s))\n`);

const limit = Number(args.limit || DEFAULT_LIMIT);
const roster = makeRoster(args.only);
if (args.mode === "caught" && roster.isEmpty) usage("--only is required in caught mode");

const authorFilter = String(args.authors || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// `--until` is exclusive so that adjacent windows never double-count a PR.
//
// `gh pr list` returns newest first and stops at --limit, so a busy repository
// silently answers a two-month question with its last two days. Rather than
// warn about that and move on, split the window and ask again: the operator
// gets the window they asked for, or an explicit statement of which sub-window
// could not be exhausted.
const fields = ["number", "title", "body", "url", "author", "labels", "mergedAt", "mergeCommit", "changedFiles", "additions", "deletions", "baseRefName"];
if (args.mode === "caught") fields.push("reviews");

const dayjs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const spanDays = (from, to) => Math.round((dayjs(to) - dayjs(from)) / 86400000);

const exhausted = [];
const unexhausted = [];
let searchCalls = 0;

function listWindow(from, toExclusive, extraQualifiers = "") {
  searchCalls += 1;
  const search = `merged:>=${from} merged:<${toExclusive}${extraQualifiers ? ` ${extraQualifiers}` : ""}`;
  return ghPrList([
    "--repo", args.repo, "--state", "merged", "--search", search,
    "--limit", String(limit), "--json", fields.join(","),
  ]);
}

function collectWindow(from, toExclusive, extraQualifiers = "") {
  const page = listWindow(from, toExclusive, extraQualifiers);
  if (page.length < limit) {
    exhausted.push({ from, toExclusive, returned: page.length });
    return page;
  }
  const days = spanDays(from, toExclusive);
  if (days <= MIN_SPLIT_DAYS) {
    unexhausted.push({ from, toExclusive, returned: page.length });
    warn(
      `${from}..${toExclusive} returned ${page.length} PRs at --limit ${limit} and cannot be split further; ` +
        `this sub-window is truncated to its most recent PRs. Raise --limit to cover it.`,
    );
    return page;
  }
  const mid = isoDay(dayjs(from) + Math.floor((dayjs(toExclusive) - dayjs(from)) / 2 / 86400000) * 86400000);
  const split = mid === from ? isoDay(dayjs(from) + 86400000) : mid;
  return [...collectWindow(from, split, extraQualifiers), ...collectWindow(split, toExclusive, extraQualifiers)];
}

const byNumber = new Map();
const commentedBy = new Map(); // pr number -> roster spellings that commented on it
const absorb = (list) => {
  for (const pr of list) if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr);
};

absorb(collectWindow(args.since, args.until));

// `gh pr list --json reviews` carries review bodies only. A reviewer that
// publishes its whole verdict as a single top-level comment has no review at
// all, so a reviews-only sweep is structurally blind to it -- on one repository
// under test that was a quarter of the merged population. The commenter search
// qualifier finds those PRs; the union is what caught mode actually needs.
if (args.mode === "caught") {
  const hasRosterReviewBody = (pr) =>
    (pr.reviews || []).some((r) => roster.has(r.author?.login) && String(r.body || "").trim().length > 0);

  for (const spelling of roster.spellings) {
    // GitHub's commenter: qualifier wants the account's real login. A roster
    // written without the [bot] suffix -- which this skill documents as valid,
    // because some app reviewers genuinely have no suffix -- would otherwise
    // search a different account and quietly return nothing, losing exactly
    // the summary-only population this sweep exists to recover.
    const attempts = spelling.endsWith("[bot]") ? [spelling] : [spelling, `${spelling}[bot]`];
    let found = [];
    let usedSpelling = spelling;
    for (const attempt of attempts) {
      found = collectWindow(args.since, args.until, `commenter:${attempt}`);
      usedSpelling = attempt;
      if (found.length) break;
    }
    if (!found.length) {
      warn(`commenter:${attempts.join(" and commenter:")} matched no PRs; check the reviewer login spelling`);
      continue;
    }
    if (usedSpelling !== spelling) {
      warn(`commenter:${spelling} matched nothing; used commenter:${usedSpelling} instead`);
    }
    absorb(found);
    for (const pr of found) {
      if (!commentedBy.has(pr.number)) commentedBy.set(pr.number, []);
      commentedBy.get(pr.number).push(spelling);
    }
    // The base sweep has already loaded every merged PR, so "how many did this
    // add to the set" is always zero and says nothing. What matters is how many
    // of these have no review body at all -- those are invisible without it.
    const bodyless = found.filter((pr) => !hasRosterReviewBody(pr)).length;
    process.stderr.write(
      `commenter:${usedSpelling}: ${found.length} PR(s), ${bodyless} of which publish no roster review body ` +
        `and are visible only through this sweep\n`,
    );
  }
}

const prs = [...byNumber.values()];

const authorLogin = (pr) => String(pr.author?.login || "").toLowerCase();
const inAuthorScope = (pr) => authorFilter.length === 0 || authorFilter.includes(authorLogin(pr));

const scoped = prs.filter(inAuthorScope);
const droppedByAuthor = prs.length - scoped.length;
if (authorFilter.length && scoped.length === 0 && prs.length > 0) {
  warn(
    `--authors ${authorFilter.join(",")} matched none of the ${prs.length} merged PR(s) in this window; ` +
      `check the login spelling before reading this as "this author shipped no fixes"`,
  );
}

let candidates;
if (args.mode === "shipped") {
  candidates = scoped
    .filter((pr) => !UPKEEP_TITLE.test(pr.title || ""))
    .map((pr) => ({ pr, ...scoreFixSignals(pr) }))
    .filter((c) => c.score > 0)
    .map(({ pr, signals, score }) => ({
      pr: pr.number, url: pr.url, title: pr.title, author: authorLogin(pr),
      mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid || null,
      baseRef: pr.baseRefName, changedFiles: pr.changedFiles,
      additions: pr.additions, deletions: pr.deletions,
      labels: (pr.labels || []).map((l) => l.name), signals, score,
    }))
    // Strongest signal first, then smallest diff: a two-file fix blames back to
    // one origin commit, a two-hundred-file fix blames back to noise.
    .sort((a, b) => b.score - a.score || a.changedFiles - b.changedFiles);
} else {
  candidates = scoped
    .map((pr) => {
      const reviews = (pr.reviews || []).filter(
        (r) => roster.has(r.author?.login) && String(r.body || "").trim().length > 0,
      );
      return { pr, reviews, commenters: commentedBy.get(pr.number) || [] };
    })
    // A PR qualifies on either surface. Requiring a review body here is what
    // made a summary-only reviewer invisible to this mode.
    .filter((c) => c.reviews.length > 0 || c.commenters.length > 0)
    .map(({ pr, reviews, commenters }) => {
      const fromReviews = reviews.map((r) => roster.spell(r.author.login));
      const fromComments = commenters.map((c) => roster.spell(c));
      return {
        pr: pr.number, url: pr.url, title: pr.title, author: authorLogin(pr),
        mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid || null,
        baseRef: pr.baseRefName, changedFiles: pr.changedFiles,
        additions: pr.additions, deletions: pr.deletions,
        labels: (pr.labels || []).map((l) => l.name),
        reviewers: [...new Set([...fromReviews, ...fromComments])],
        reviewBodies: reviews.length,
        // Surfaces matter downstream: a reviewer seen only here published
        // without a commit pin, so its findings cannot be placed on a commit.
        surfaces: {
          reviewBody: [...new Set(fromReviews)],
          topLevelCommentOnly: fromComments.filter((c) => !fromReviews.includes(c)),
        },
      };
    })
    // Rank by disagreement, not agreement. A pull request every reviewer
    // commented on teaches little; one where a reviewer published and another
    // stayed silent is where the interesting comparison lives.
    .map((c) => ({ ...c, rosterSilent: roster.logins.length - c.reviewers.length }))
    .sort((a, b) =>
      (b.rosterSilent > 0 ? 1 : 0) - (a.rosterSilent > 0 ? 1 : 0) ||
      b.reviewers.length - a.reviewers.length ||
      a.changedFiles - b.changedFiles);
}

const out = {
  schemaVersion: "review-cases-candidates-v1",
  mode: args.mode,
  repo: args.repo,
  window: { field: "merged_at", from: args.since, toExclusive: args.until },
  authorScope: authorFilter.length ? authorFilter : "all",
  roster: roster.logins,
  configSource: config.source,
  population: {
    mergedPrsScanned: prs.length,
    droppedByAuthorScope: droppedByAuthor,
    limit,
    searchCalls,
    subWindowsExhausted: exhausted.length,
    subWindowsTruncated: unexhausted,
    complete: unexhausted.length === 0,
  },
  candidateCount: candidates.length,
  candidates,
  warnings,
  generatedAt: new Date().toISOString(),
};

writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
process.stderr.write(
  `${args.mode}: ${candidates.length} candidate(s) from ${prs.length} merged PR(s) -> ${args.out}\n`,
);
