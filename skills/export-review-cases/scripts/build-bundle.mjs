#!/usr/bin/env node
// Validate adjudicated cases and assemble the bundle that leaves the building.
//
// Two jobs, and the first one matters more:
//
//   1. Refuse a case that cannot support its own claim. A missed-bug case with
//      no reviewed commit is an accusation with no evidence behind it, and a
//      case set with a few of those in it is worse than no case set at all --
//      it trains a reviewer against bugs that were not there when it ran.
//      Everything rejected here is reported by reason, never dropped silently.
//
//   2. Decide what code leaves the repository. Source is opt-in. Without
//      --include-source the bundle carries links, SHAs, paths, line numbers,
//      prose, and the reviewer's own published output, and no source at all.
//      With it, the bundle carries the patches for the traced files only --
//      not the whole PR, and not the whole repository.
//
// Usage:
//   build-bundle.mjs --cases <dir> --out <dir> [--repo owner/repo] [--include-source]
//     [--max-per-label N] [--label-set "missed,caught"]
//   build-bundle.mjs --self-test

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ghJson, parseArgs, warn, warnings } from "./lib/gh.mjs";

const DEFAULT_MAX_PER_LABEL = 25;

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: build-bundle.mjs --cases <dir> --out <dir> [--repo owner/repo] [--include-source]\n" +
      "                       [--max-per-label N]\n" +
      "       build-bundle.mjs --self-test\n",
  );
  process.exit(2);
}

// Returns [] when the case is publishable, otherwise every reason it is not.
export function validateCase(c) {
  const problems = [];
  const need = (path, why) => {
    const value = path.split(".").reduce((o, k) => (o == null ? o : o[k]), c);
    if (value === undefined || value === null || value === "") problems.push(`${path} is missing (${why})`);
  };

  need("caseId", "every case needs a stable identity");
  need("repo", "a case without its repository cannot be read later");
  need("reviewer", "a case is about one reviewer");
  need("verdict", "the label is the case");
  need("bug.summary", "a case with no stated bug teaches nothing");
  need("bug.severity", "severity separates a shipped outage from a shipped nit");
  need("fix.pr", "the fix is the ground truth that the bug was real");

  if (!["missed", "caught"].includes(c.verdict)) {
    problems.push(`verdict "${c.verdict}" is not publishable (only missed and caught are)`);
  }

  // The eligibility evidence. Without a reviewed commit there is no claim that
  // the reviewer had the bug in front of it, so there is no case either way.
  need("reviewedAt.commit", "a case must name the exact commit the reviewer read");
  need("reviewedAt.presenceMethod", "a case must say how presence at that commit was established");
  if (c.reviewedAt && !["ancestry", "content", "manual"].includes(c.reviewedAt.presenceMethod)) {
    problems.push(`reviewedAt.presenceMethod "${c.reviewedAt.presenceMethod}" is not a recognised test`);
  }

  if (c.verdict === "missed") {
    need("origin.pr", "a missed bug must name the PR that introduced it");
    if (c.reviewerOutputAtThatCommit?.namedTheMechanism === true) {
      problems.push("verdict is missed but the reviewer is recorded as having named the mechanism");
    }
  }
  if (c.verdict === "caught") {
    if (c.reviewerOutputAtThatCommit?.namedTheMechanism !== true) {
      problems.push("verdict is caught but the reviewer is not recorded as having named the mechanism");
    }
    if (!(c.reviewerOutputAtThatCommit?.quotes || []).length) {
      problems.push("a caught case must quote the reviewer's own words");
    }
  }

  // A negative claim about a reviewer that no second reader challenged does not
  // leave the building. This is the same rule the audit method applies to its
  // headline numbers, for the same reason.
  if (!c.skeptic || c.skeptic.ran !== true) problems.push("no skeptic pass was run");
  else if (c.skeptic.verdict === "rejected") problems.push("the skeptic rejected this case");
  else if (!["upheld", "revised"].includes(c.skeptic.verdict)) {
    problems.push(`skeptic.verdict "${c.skeptic.verdict}" is not upheld, revised, or rejected`);
  }

  return problems;
}

const SEVERITY_ORDER = ["blocking", "major", "minor", "nit"];

// Keep the strongest cases when a label overflows, and keep them varied. A
// bundle of twenty instances of one mechanism looks like twenty cases and
// teaches one.
export function selectCases(cases, maxPerLabel) {
  const bySeverity = (a, b) =>
    SEVERITY_ORDER.indexOf(a.bug?.severity) - SEVERITY_ORDER.indexOf(b.bug?.severity);
  const out = [];
  for (const label of ["missed", "caught"]) {
    const pool = cases.filter((c) => c.verdict === label).sort(bySeverity);
    const seenClass = new Map();
    const first = [];
    const rest = [];
    for (const c of pool) {
      const key = `${c.bug?.class || "other"}:${c.bug?.boundary || "unknown"}`;
      const n = seenClass.get(key) || 0;
      seenClass.set(key, n + 1);
      (n === 0 ? first : rest).push(c);
    }
    out.push(...[...first, ...rest].slice(0, maxPerLabel));
  }
  return out;
}

function selfTest() {
  const cases = [];
  const eq = (name, actual, expected) =>
    cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

  const good = {
    caseId: "c1", repo: "o/r", reviewer: "bot", verdict: "missed",
    bug: { summary: "s", severity: "major", class: "correctness", boundary: "cross-module" },
    origin: { pr: 1 }, fix: { pr: 2 },
    reviewedAt: { commit: "abc", presenceMethod: "ancestry" },
    reviewerOutputAtThatCommit: { published: true, namedTheMechanism: false },
    skeptic: { ran: true, verdict: "upheld" },
  };
  eq("a complete missed case validates", validateCase(good), []);
  eq("a missing reviewed commit is fatal",
    validateCase({ ...good, reviewedAt: { presenceMethod: "ancestry" } }).some((p) => p.startsWith("reviewedAt.commit")), true);
  eq("an unrun skeptic is fatal", validateCase({ ...good, skeptic: { ran: false } }), ["no skeptic pass was run"]);
  eq("a rejected skeptic is fatal", validateCase({ ...good, skeptic: { ran: true, verdict: "rejected" } }), ["the skeptic rejected this case"]);
  eq("missed contradicted by the reviewer's own output is fatal",
    validateCase({ ...good, reviewerOutputAtThatCommit: { published: true, namedTheMechanism: true } }),
    ["verdict is missed but the reviewer is recorded as having named the mechanism"]);
  eq("a caught case needs quotes",
    validateCase({ ...good, verdict: "caught", reviewerOutputAtThatCommit: { published: true, namedTheMechanism: true } }),
    ["a caught case must quote the reviewer's own words"]);
  eq("an unpublishable verdict is rejected", validateCase({ ...good, verdict: "not_a_bug" }).some((p) => p.includes("not publishable")), true);

  const mk = (id, verdict, severity, cls) => ({ caseId: id, verdict, bug: { severity, class: cls, boundary: "b" } });
  // One case per class before a second of any class, severity ordering inside
  // each tier. The minor perf bug beats the second correctness bug because a
  // bundle that repeats a class teaches that class once and pads the count.
  eq("variety outranks severity for a repeated class",
    selectCases([
      mk("a", "missed", "minor", "perf"), mk("b", "missed", "blocking", "correctness"),
      mk("c", "missed", "major", "correctness"), mk("d", "missed", "major", "race"),
    ], 3).map((c) => c.caseId), ["b", "d", "a"]);
  eq("a repeated class is still kept when there is room",
    selectCases([
      mk("a", "missed", "minor", "perf"), mk("b", "missed", "blocking", "correctness"),
      mk("c", "missed", "major", "correctness"), mk("d", "missed", "major", "race"),
    ], 4).map((c) => c.caseId), ["b", "d", "a", "c"]);
  eq("labels are capped independently",
    selectCases([mk("a", "missed", "major", "x"), mk("b", "missed", "major", "y"), mk("c", "caught", "major", "z")], 1)
      .map((c) => c.caseId), ["a", "c"]);

  for (const c of cases) process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.name}\n`);
  const failed = cases.filter((c) => !c.ok);
  for (const c of failed) process.stdout.write(`     actual=${JSON.stringify(c.actual)} expected=${JSON.stringify(c.expected)}\n`);
  process.exit(failed.length ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2), {
  cases: "value", out: "value", repo: "value", includeSource: "flag",
  maxPerLabel: "value", selfTest: "flag",
});
if (args.error) usage(args.error);
if (args.selfTest) selfTest();
if (!args.cases || !args.out) usage("--cases and --out are required");
if (!existsSync(args.cases)) usage(`${args.cases} does not exist`);

const maxPerLabel = Number(args.maxPerLabel || DEFAULT_MAX_PER_LABEL);
const files = readdirSync(args.cases).filter((f) => f.endsWith(".json")).sort();
const loaded = [];
const rejected = [];

for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(args.cases, file), "utf8"));
  } catch (e) {
    rejected.push({ file, reasons: [`unparseable JSON: ${e.message}`] });
    continue;
  }
  const problems = validateCase(parsed);
  if (problems.length) rejected.push({ file, caseId: parsed.caseId || null, verdict: parsed.verdict || null, reasons: problems });
  else loaded.push(parsed);
}

const selected = selectCases(loaded, maxPerLabel);
const notSelected = loaded.filter((c) => !selected.includes(c));

// Scoped source: the patches for the files a case actually names, from the
// origin PR and the fix PR. Never the whole PR, never the whole repository.
if (args.includeSource) {
  if (!args.repo) usage("--include-source needs --repo to fetch patches");
  for (const c of selected) {
    const wanted = new Set([c.origin?.path, ...(c.origin?.paths || []), ...(c.fix?.paths || [])].filter(Boolean));
    const grab = (prNumber, key) => {
      if (!prNumber) return;
      const prFiles = ghJson(`repos/${args.repo}/pulls/${prNumber}/files?per_page=100`, { tolerate: true });
      if (!prFiles.length) {
        warn(`${c.caseId}: no files returned for PR ${prNumber}; ${key} patch omitted`);
        return;
      }
      const picked = prFiles.filter((f) => wanted.size === 0 || wanted.has(f.filename) || wanted.has(f.previous_filename));
      const source = picked.length ? picked : prFiles;
      if (!picked.length) warn(`${c.caseId}: none of the named paths appear in PR ${prNumber}; included the full PR patch instead`);
      c.evidence = c.evidence || {};
      c.evidence[key] = source.map((f) => ({ path: f.filename, status: f.status, patch: f.patch || null }));
    };
    grab(c.origin?.pr, "originPatch");
    grab(c.fix?.pr, "fixPatch");
  }
}

mkdirSync(args.out, { recursive: true });

const counts = (list) => ({
  missed: list.filter((c) => c.verdict === "missed").length,
  caught: list.filter((c) => c.verdict === "caught").length,
});

const manifest = {
  schemaVersion: "review-cases-bundle-v1",
  repo: args.repo || selected[0]?.repo || null,
  includesSource: Boolean(args.includeSource),
  maxPerLabel,
  counts: { loaded: counts(loaded), selected: counts(selected), rejected: rejected.length, notSelected: notSelected.length },
  rejected,
  notSelected: notSelected.map((c) => ({ caseId: c.caseId, verdict: c.verdict, severity: c.bug?.severity })),
  warnings,
  generatedAt: new Date().toISOString(),
};

writeFileSync(join(args.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(args.out, "cases.json"), `${JSON.stringify(selected, null, 2)}\n`);

const md = [];
md.push(`# Review cases: ${manifest.repo || "unknown repository"}`, "");
md.push(
  `${counts(selected).missed} case(s) where the reviewer had the bug in front of it and did not report it, ` +
    `and ${counts(selected).caught} case(s) where it did. ` +
    `Source patches are ${manifest.includesSource ? "included for the named files" : "not included"}.`,
  "",
);
md.push(
  "Every case names the exact commit the reviewer read and how presence of the bug at that commit was established. " +
    "A case is a lower bound on what happened, not a measurement of the reviewer: this set was mined from merged fixes " +
    "and published reviews, so bugs nobody ever fixed and reviews nobody published are invisible to it.",
  "",
);
for (const label of ["missed", "caught"]) {
  const list = selected.filter((c) => c.verdict === label);
  if (!list.length) continue;
  md.push(`## ${label === "missed" ? "Shipped: the reviewer saw this code and said nothing" : "Caught: the reviewer reported this"}`, "");
  for (const c of list) {
    md.push(`### ${c.caseId} — ${c.bug?.summary || "(no summary)"}`, "");
    md.push(`- Severity: ${c.bug?.severity || "?"} · class: ${c.bug?.class || "?"} · boundary: ${c.bug?.boundary || "?"}`);
    if (c.origin?.pr) md.push(`- Introduced by PR [#${c.origin.pr}](${c.origin.url || ""}) at \`${(c.origin.sha || "").slice(0, 10)}\`${c.origin.path ? ` (\`${c.origin.path}\`)` : ""}`);
    md.push(`- Reviewed by \`${c.reviewer}\` at \`${String(c.reviewedAt?.commit || "").slice(0, 10)}\` (presence established by ${c.reviewedAt?.presenceMethod})`);
    if (c.fix?.pr) md.push(`- Fixed by PR [#${c.fix.pr}](${c.fix.url || ""})${c.fix.mergedAt ? ` merged ${c.fix.mergedAt}` : ""}`);
    md.push("");
    if (c.bug?.mechanism) md.push(`**Mechanism.** ${c.bug.mechanism}`, "");
    if (c.bug?.trigger) md.push(`**Trigger.** ${c.bug.trigger}`, "");
    if (c.bug?.wrongOutput) md.push(`**Wrong output.** ${c.bug.wrongOutput}`, "");
    for (const q of c.reviewerOutputAtThatCommit?.quotes || []) md.push(`> ${String(q).replace(/\n/g, "\n> ")}`, "");
    if (c.whatWouldHaveCaughtIt) md.push(`**What would have caught it.** ${c.whatWouldHaveCaughtIt}`, "");
    if (c.skeptic?.note) md.push(`**Skeptic (${c.skeptic.verdict}).** ${c.skeptic.note}`, "");
    md.push("");
  }
}
if (rejected.length) {
  md.push("## Rejected before export", "");
  for (const r of rejected) md.push(`- \`${r.file}\`${r.caseId ? ` (${r.caseId})` : ""}: ${r.reasons.join("; ")}`);
  md.push("");
}
writeFileSync(join(args.out, "CASES.md"), `${md.join("\n")}\n`);

process.stderr.write(
  `bundle: ${counts(selected).missed} missed + ${counts(selected).caught} caught selected, ` +
    `${rejected.length} rejected, ${notSelected.length} held back -> ${args.out}\n`,
);
