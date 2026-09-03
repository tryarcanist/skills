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
//      Shape is not enough. A case whose commit is unreachable, whose path does
//      not exist at the commit it names, or whose fix never merged, is shaped
//      correctly and false, so the checks here read git and GitHub rather than
//      trusting the case file that a language model wrote.
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
import { ghJson, ghOne, makeRoster, parseArgs, warn, warnings } from "./lib/gh.mjs";
import { assertUsableClone, blockPresentAt, ensureCommit, fileAt } from "./lib/git.mjs";
import { fetchReviewerOutput } from "./lib/reviews.mjs";

const DEFAULT_MAX_PER_LABEL = 25;

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: build-bundle.mjs --cases <dir> --out <dir> --repo owner/repo --repo-path <full-clone>\n" +
      "                       [--include-source] [--max-per-label N] [--label-set \"missed,caught\"]\n" +
      "                       [--only \"bot-a,bot-b\"] [--skip-truth-checks]\n" +
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
  // A caught finding the team acknowledged but has not repaired is still a real
  // case; requiring a fix PR for it forced a reviewer's own PR into the field
  // during testing, which quietly corrupted what `fix` means across a bundle.
  const resolution = c.resolution || (c.fix?.pr ? "fixed" : null);
  if (!resolution) {
    problems.push("resolution is missing (fixed, acknowledged, deferred, or none)");
  } else if (!["fixed", "acknowledged", "deferred", "none"].includes(resolution)) {
    problems.push(`resolution "${resolution}" is not recognised`);
  }
  if (c.verdict === "missed" && resolution !== "fixed") {
    problems.push("a missed case must be resolved by a merged fix; the fix is the only proof the bug was real");
  }
  // A finding repaired before merge has no separate fix PR. Requiring one
  // forced genuinely-fixed cases to be recorded as merely acknowledged.
  if (resolution === "fixed" && !c.fix?.pr && !(c.fixedInSamePr === true && c.fix?.commit)) {
    problems.push("a fixed case must name fix.pr, or set fixedInSamePr with the fix.commit that repaired it");
  }
  if (resolution !== "fixed" && !c.resolutionEvidence) {
    problems.push(`resolution "${resolution}" needs resolutionEvidence (who acknowledged it, and where)`);
  }

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
  } else if (!String(c.skeptic.note || "").trim()) {
    problems.push("skeptic.note is empty; an upheld verdict with nothing checked is the outcome that makes the pass worthless");
  }

  if (c.verdict === "missed" && !(c.reviewerOutputAtThatCommit?.publishedItems || []).length
      && c.reviewerOutputAtThatCommit?.published === true) {
    problems.push("the reviewer published at this commit but the case records none of what it said");
  }

  // An unedited stub is not a case. `need()` only catches empty values, and
  // a generated placeholder is a perfectly good non-empty string.
  for (const at of placeholderPaths(c)) {
    problems.push(`${at} is still the generated placeholder; a stub is not a case`);
  }

  return problems;
}

// Every string an unedited stub left behind. `need()` only catches empty
// values, and a placeholder is a perfectly good non-empty string -- which is
// how "TODO: one line: what goes wrong" reached a customer-facing heading in
// testing. This is the same "shape is not truth" failure the truth checks
// exist for, reproduced inside the stub path built to reduce hand-editing.
export function placeholderPaths(value, path = "") {
  if (typeof value === "string") {
    return /^TODO\b/i.test(value.trim()) ? [path || "(root)"] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => placeholderPaths(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => placeholderPaths(v, path ? `${path}.${k}` : k));
  }
  return [];
}

const MIN_VERIFIABLE_QUOTE = 25;
const normalizeQuote = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();

// A quote is the whole evidence of a catch, and it is the one field a language
// model can produce out of nothing that looks entirely convincing. Every
// segment long enough to be distinctive has to appear in what the reviewer
// actually published.
export function unverifiedQuotes(quotes, publishedText) {
  const haystack = normalizeQuote(publishedText);
  const missing = [];
  for (const quote of quotes || []) {
    const segments = String(quote)
      .split(/\u2026|\.\.\.|\[\u2026\]/)
      .map(normalizeQuote)
      .filter((seg) => seg.length >= MIN_VERIFIABLE_QUOTE);
    if (!segments.length) continue;
    if (!segments.every((seg) => haystack.includes(seg))) missing.push(String(quote).slice(0, 120));
  }
  return missing;
}

const SEVERITY_ORDER = ["blocking", "major", "minor", "nit"];

// Keep the strongest cases when a label overflows, and keep them varied. A
// bundle of twenty instances of one mechanism looks like twenty cases and
// teaches one.
export function selectCases(cases, maxPerLabel) {
  // An unrecognised severity sorts last, not first. `indexOf` returns -1 for an
  // unknown value, which would rank a typo above `blocking`.
  const rank = (c) => {
    const i = SEVERITY_ORDER.indexOf(c.bug?.severity);
    return i === -1 ? SEVERITY_ORDER.length : i;
  };
  const bySeverity = (a, b) => rank(a) - rank(b);
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
    caseId: "c1", repo: "o/r", reviewer: "bot", verdict: "missed", resolution: "fixed",
    bug: { summary: "s", severity: "major", class: "correctness", boundary: "cross-module" },
    origin: { pr: 1 }, fix: { pr: 2 },
    reviewedAt: { commit: "abc", presenceMethod: "ancestry" },
    reviewerOutputAtThatCommit: {
      published: true, namedTheMechanism: false,
      publishedItems: [{ id: "inline-1", excerpt: "unrelated remark about the same file" }],
    },
    skeptic: { ran: true, verdict: "upheld", note: "re-read the file at the reviewed commit" },
  };
  eq("a complete missed case validates", validateCase(good), []);
  eq("a missing reviewed commit is fatal",
    validateCase({ ...good, reviewedAt: { presenceMethod: "ancestry" } }).some((p) => p.startsWith("reviewedAt.commit")), true);
  eq("an unrun skeptic is fatal", validateCase({ ...good, skeptic: { ran: false } }), ["no skeptic pass was run"]);
  eq("a rejected skeptic is fatal", validateCase({ ...good, skeptic: { ran: true, verdict: "rejected" } }), ["the skeptic rejected this case"]);
  eq("an upheld skeptic with no note is fatal",
    validateCase({ ...good, skeptic: { ran: true, verdict: "upheld", note: "  " } }),
    ["skeptic.note is empty; an upheld verdict with nothing checked is the outcome that makes the pass worthless"]);
  eq("a missed case must record what the reviewer did say",
    validateCase({ ...good, reviewerOutputAtThatCommit: { published: true, namedTheMechanism: false } }),
    ["the reviewer published at this commit but the case records none of what it said"]);
  eq("a missed case without a merged fix is fatal",
    validateCase({ ...good, resolution: "acknowledged", resolutionEvidence: "author replied", fix: {} })
      .includes("a missed case must be resolved by a merged fix; the fix is the only proof the bug was real"), true);
  eq("an acknowledged caught case is publishable without a fix PR",
    validateCase({
      ...good, verdict: "caught", resolution: "acknowledged", resolutionEvidence: "author replied Valid and filed ENG-6216",
      fix: {}, origin: { pr: 1 },
      reviewerOutputAtThatCommit: { published: true, namedTheMechanism: true, quotes: ["the guard admits email too"] },
    }), []);
  eq("an acknowledged case with no evidence is fatal",
    validateCase({ ...good, verdict: "caught", resolution: "acknowledged", fix: {},
      reviewerOutputAtThatCommit: { published: true, namedTheMechanism: true, quotes: ["q"] } })
      .includes('resolution "acknowledged" needs resolutionEvidence (who acknowledged it, and where)'), true);
  eq("an unedited stub placeholder is fatal",
    validateCase({ ...good, bug: { ...good.bug, summary: "TODO: one line: what goes wrong" } }),
    ["bug.summary is still the generated placeholder; a stub is not a case"]);
  eq("a placeholder caseId is fatal",
    validateCase({ ...good, caseId: "TODO-9662-fix-the-crash" }),
    ["caseId is still the generated placeholder; a stub is not a case"]);
  eq("placeholders are found at any depth",
    placeholderPaths({ a: { b: ["ok", "TODO: fill me"] } }), ["a.b[1]"]);
  eq("a fixed case repaired before merge needs a commit, not a fix PR",
    validateCase({ ...good, verdict: "caught", resolution: "fixed", fix: { commit: "abc123" }, fixedInSamePr: true,
      reviewerOutputAtThatCommit: { published: true, namedTheMechanism: true, quotes: ["q"] } }), []);
  eq("a fixed case with neither is fatal",
    validateCase({ ...good, verdict: "caught", resolution: "fixed", fix: {},
      reviewerOutputAtThatCommit: { published: true, namedTheMechanism: true, quotes: ["q"] } }),
    ["a fixed case must name fix.pr, or set fixedInSamePr with the fix.commit that repaired it"]);
  eq("a real quote verifies against what was published",
    unverifiedQuotes(["the guard admits email too"], "I think the guard admits email too, which breaks the SMS-only rule."), []);
  eq("an invented quote is caught",
    unverifiedQuotes(["this will corrupt the ledger on retry"], "Nice work, one small nit about naming here.").length, 1);
  eq("an ellipsised quote verifies segment by segment",
    unverifiedQuotes(["the compound message rules cite an SMS-only tool ... gated on a predicate that also admits email"],
      "Note the compound message rules cite an SMS-only tool, but injection is gated on a predicate that also admits email."), []);
  eq("a quote too short to be distinctive is not checked", unverifiedQuotes(["nit"], "unrelated"), []);
  eq("an unknown severity sorts last, not first",
    selectCases([
      { caseId: "typo", verdict: "missed", bug: { severity: "Major", class: "a", boundary: "b" } },
      { caseId: "real", verdict: "missed", bug: { severity: "blocking", class: "c", boundary: "d" } },
    ], 2).map((c) => c.caseId), ["real", "typo"]);
  eq("missed contradicted by the reviewer's own output is fatal",
    validateCase({ ...good, reviewerOutputAtThatCommit: { ...good.reviewerOutputAtThatCommit, namedTheMechanism: true } }),
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
  cases: "value", out: "value", repo: "value", repoPath: "value", only: "value",
  includeSource: "flag", maxPerLabel: "value", labelSet: "value", skipTruthChecks: "flag",
  selfTest: "flag",
});
if (args.error) usage(args.error);
if (args.selfTest) selfTest();
if (!args.cases || !args.out) usage("--cases and --out are required");
if (!existsSync(args.cases)) usage(`${args.cases} does not exist`);
if (!args.repo) usage("--repo is required");
if (!args.repoPath && !args.skipTruthChecks) {
  usage("--repo-path is required so that every case can be checked against the code it claims (or pass --skip-truth-checks and accept an unverified bundle)");
}
const labelSet = String(args.labelSet || "missed,caught").split(",").map((l) => l.trim()).filter(Boolean);
for (const label of labelSet) {
  if (!["missed", "caught"].includes(label)) usage(`--label-set value "${label}" is not missed or caught`);
}
const roster = makeRoster(args.only);
if (args.repoPath) assertUsableClone(args.repoPath);

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

// Shape checks read the case file. These read the repository, because the case
// file was written by a language model and every field in it is a claim.
function truthProblems(c) {
  const problems = [];
  if (!args.repoPath) return problems;

  const commit = c.reviewedAt?.commit;
  if (commit && !ensureCommit(args.repoPath, commit)) {
    problems.push(`reviewedAt.commit ${commit} is not reachable in the clone; it cannot be verified or re-read`);
  }
  if (c.origin?.sha && c.origin?.path) {
    if (!ensureCommit(args.repoPath, c.origin.sha)) {
      problems.push(`origin.sha ${c.origin.sha} is not reachable in the clone`);
    } else if (fileAt(args.repoPath, c.origin.sha, c.origin.path) === null) {
      problems.push(`origin.path ${c.origin.path} does not exist at origin.sha ${String(c.origin.sha).slice(0, 10)}`);
    }
  }
  if (c.origin?.pr && c.fix?.pr && c.origin.pr === c.fix.pr && c.fixedInSamePr !== true) {
    problems.push(`origin.pr and fix.pr are both ${c.fix.pr}; set fixedInSamePr if the finding was repaired before merge`);
  }
  if (!roster.isEmpty && c.reviewer && !roster.has(c.reviewer)) {
    problems.push(`reviewer "${c.reviewer}" is not on the roster (${roster.spellings.join(", ")})`);
  }
  // The central invariant, re-tested against the code rather than trusted from
  // the case file: were the buggy lines actually there when the reviewer ran?
  // Everything needed is already in the case, and skipping it let a case whose
  // reviewed commit predated the code by three months export cleanly.
  const needle = c.provenance?.buggyBlock;
  if (commit && needle?.block && needle?.path && ensureCommit(args.repoPath, commit)) {
    const check = blockPresentAt(args.repoPath, commit, needle.path, needle.block);
    if (check.present === false) {
      problems.push(
        `the buggy block is NOT present at reviewedAt.commit ${String(commit).slice(0, 10)} ` +
          `(${needle.path}:${needle.start}-${needle.end}); the reviewer cannot have missed it`,
      );
    } else if (check.present === null) {
      problems.push(`presence at reviewedAt.commit could not be re-established (${check.reason})`);
    }
  } else if (commit && c.reviewedAt?.presenceMethod === "content" && !needle?.block) {
    problems.push("presenceMethod is content but the case carries no provenance.buggyBlock to re-check");
  }

  // Does origin.sha actually belong to origin.pr?
  if (c.origin?.sha && c.origin?.pr) {
    const pulls = ghJson(`repos/${args.repo}/commits/${c.origin.sha}/pulls?per_page=100`, { tolerate: true });
    if (pulls.length && !pulls.some((pr) => pr.number === c.origin.pr)) {
      problems.push(
        `origin.sha ${String(c.origin.sha).slice(0, 10)} belongs to PR ${pulls.map((pr) => pr.number).join("/")}, not origin.pr ${c.origin.pr}`,
      );
    }
  }

  if (c.verdict === "caught" && (c.reviewerOutputAtThatCommit?.quotes || []).length && c.origin?.pr) {
    const output = fetchReviewerOutput(args.repo, c.origin.pr, makeRoster(c.reviewer));
    if (!output.length) {
      problems.push(`no published output by ${c.reviewer} found on PR ${c.origin.pr} to support the quoted finding`);
    } else {
      const missing = unverifiedQuotes(c.reviewerOutputAtThatCommit.quotes, output.map((o) => o.body).join("\n"));
      for (const q of missing) problems.push(`quote not found in anything ${c.reviewer} published on PR ${c.origin.pr}: "${q}"`);
    }
  }

  const resolution = c.resolution || (c.fix?.pr ? "fixed" : null);
  if (resolution === "fixed" && c.fix?.pr) {
    const pr = ghOne(`repos/${args.repo}/pulls/${c.fix.pr}`, { tolerate: true });
    if (!pr) problems.push(`fix.pr ${c.fix.pr} could not be read from ${args.repo}`);
    else if (!pr.merged_at) problems.push(`fix.pr ${c.fix.pr} is not merged, so nothing proves the bug was real`);
    else {
      // A real merged PR that fixed a different bug in a different file is the
      // most plausible fabrication available, so check that the fix touched
      // the code the case is about.
      const claimed = [...new Set([...(c.fix.paths || []), c.origin?.path].filter(Boolean))];
      if (claimed.length) {
        const prFiles = ghJson(`repos/${args.repo}/pulls/${c.fix.pr}/files?per_page=100`, { tolerate: true });
        const actual = new Set(prFiles.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
        if (actual.size && !claimed.some((path) => actual.has(path))) {
          problems.push(`fix.pr ${c.fix.pr} touches none of the paths this case names (${claimed.join(", ")})`);
        }
      }
    }
  }
  return problems;
}

if (args.repoPath) {
  for (let i = loaded.length - 1; i >= 0; i -= 1) {
    const problems = truthProblems(loaded[i]);
    if (problems.length) {
      rejected.push({ file: `${loaded[i].caseId}.json`, caseId: loaded[i].caseId, verdict: loaded[i].verdict, reasons: problems });
      loaded.splice(i, 1);
    }
  }
}

const inLabelSet = loaded.filter((c) => labelSet.includes(c.verdict));
const labelExcluded = loaded.filter((c) => !labelSet.includes(c.verdict));
const selected = selectCases(inLabelSet, maxPerLabel);
const notSelected = inLabelSet.filter((c) => !selected.includes(c));

// Scoped source: the patches for the files a case actually names, from the
// origin PR and the fix PR. Never the whole PR, never the whole repository.
const sourceProblems = [];
if (args.includeSource) {
  for (const c of selected) {
    const wanted = new Set([c.origin?.path, ...(c.origin?.paths || []), ...(c.fix?.paths || [])].filter(Boolean));
    const grab = (prNumber, key) => {
      if (!prNumber) return;
      const prFiles = ghJson(`repos/${args.repo}/pulls/${prNumber}/files?per_page=100`, { tolerate: true });
      if (!prFiles.length) {
        warn(`${c.caseId}: no files returned for PR ${prNumber}; ${key} patch omitted`);
        return;
      }
      const picked = prFiles.filter((f) => wanted.has(f.filename) || wanted.has(f.previous_filename));
      // Falling back to the whole pull request here once shipped 487 files of a
      // customer's source out of a case that named one. A path that does not
      // match is a broken case, not a licence to export everything.
      if (wanted.size === 0 || !picked.length) {
        sourceProblems.push({
          caseId: c.caseId,
          reason: wanted.size === 0
            ? `names no paths, so --include-source cannot scope its ${key}`
            : `none of its named paths (${[...wanted].join(", ")}) appear in PR ${prNumber}, so ${key} cannot be scoped`,
        });
        return;
      }
      c.evidence = c.evidence || {};
      c.evidence[key] = picked.map((f) => ({ path: f.filename, status: f.status, patch: f.patch || null }));
    };
    grab(c.origin?.pr, "originPatch");
    grab(c.fix?.pr, "fixPatch");
  }
  // Exporting a case whose source could not be scoped would hand over either
  // nothing or too much. Drop it and say so.
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    const problem = sourceProblems.find((sp) => sp.caseId === selected[i].caseId);
    if (problem) {
      rejected.push({ file: `${selected[i].caseId}.json`, caseId: selected[i].caseId, verdict: selected[i].verdict, reasons: [problem.reason] });
      selected.splice(i, 1);
    }
  }
}

// `provenance.buggyBlock.block` is verbatim repository source. SKILL.md
// promises a no-source bundle carries none, so it is removed unless source was
// explicitly requested. The location survives either way.
if (!args.includeSource) {
  for (const c of selected) {
    if (c.provenance?.buggyBlock?.block) {
      c.provenance.buggyBlock = { ...c.provenance.buggyBlock, block: null, blockOmitted: "source not included in this bundle" };
    }
    for (const r of c.provenance?.rejectedBlocks || []) delete r.block;
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
  truthChecks: args.repoPath ? "run" : "SKIPPED -- no case in this bundle was checked against the code it claims",
  labelSet,
  roster: roster.spellings,
  maxPerLabel,
  counts: {
    loaded: counts(loaded), selected: counts(selected), rejected: rejected.length,
    heldBackByCap: notSelected.length, excludedByLabelSet: labelExcluded.length,
  },
  presenceMethods: selected.reduce((acc, c) => {
    const m = c.reviewedAt?.presenceMethod || "unknown";
    acc[m] = (acc[m] || 0) + 1;
    return acc;
  }, {}),
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
    "and published reviews, so bugs nobody ever fixed and reviews nobody published are invisible to it. " +
    "Bugs of omission cannot appear at all, because a fix that only adds lines has no origin commit to trace.",
  "",
);
const methods = manifest.presenceMethods || {};
if (!methods.ancestry) {
  md.push(
    "**No case here rests on commit ancestry.** This repository squash-merges, so the exact presence test cannot fire: " +
      "the commit blame names is a squash commit on the default branch, and the commits a reviewer read live on a branch " +
      "that is not its ancestor. Every verdict below uses the approximate verbatim-content test, which reports a " +
      "reformatted line as absent — it loses real cases and does not invent them.",
    "",
  );
}
md.push(`Presence tests used: ${Object.entries(methods).map(([m, n]) => `${m} ${n}`).join(", ") || "none"}.`, "");
for (const label of ["missed", "caught"]) {
  const list = selected.filter((c) => c.verdict === label);
  if (!list.length) continue;
  md.push(`## ${label === "missed" ? "Shipped: the reviewer read this code and did not report this bug" : "Caught: the reviewer reported this"}`, "");
  for (const c of list) {
    md.push(`### ${c.caseId} — ${c.bug?.summary || "(no summary)"}`, "");
    md.push(`- Severity: ${c.bug?.severity || "?"} · class: ${c.bug?.class || "?"} · boundary: ${c.bug?.boundary || "?"}`);
    if (c.origin?.pr) {
      // For a caught case the reviewer's finding was published on this pull
      // request; calling that "introduced by" misreads the case entirely.
      const role = c.verdict === "caught" ? "Reported on PR" : "Introduced by PR";
      md.push(`- ${role} [#${c.origin.pr}](${c.origin.url || ""})${c.origin.sha ? ` at \`${String(c.origin.sha).slice(0, 10)}\`` : ""}${c.origin.path ? ` (\`${c.origin.path}\`)` : ""}`);
    }
    md.push(`- Reviewed by \`${c.reviewer}\` at \`${String(c.reviewedAt?.commit || "").slice(0, 10)}\` (presence established by ${c.reviewedAt?.presenceMethod})`);
    const resolution = c.resolution || (c.fix?.pr ? "fixed" : "unstated");
    if (c.fix?.pr) md.push(`- Resolution: ${resolution} — PR [#${c.fix.pr}](${c.fix.url || ""})${c.fix.mergedAt ? ` merged ${c.fix.mergedAt}` : ""}`);
    else if (c.fixedInSamePr && c.fix?.commit) md.push(`- Resolution: ${resolution} before merge, in \`${String(c.fix.commit).slice(0, 10)}\``);
    else md.push(`- Resolution: ${resolution}${c.resolutionEvidence ? ` — ${c.resolutionEvidence}` : ""}`);
    if (c.provenance?.buggyBlock?.needleKind === "declaration") {
      md.push(`- Presence was established from a declaration rather than executable logic; read the block before relying on this case.`);
    }
    md.push("");
    if (c.bug?.mechanism) md.push(`**Mechanism.** ${c.bug.mechanism}`, "");
    if (c.bug?.trigger) md.push(`**Trigger.** ${c.bug.trigger}`, "");
    if (c.bug?.wrongOutput) md.push(`**Wrong output.** ${c.bug.wrongOutput}`, "");
    for (const q of c.reviewerOutputAtThatCommit?.quotes || []) md.push(`> ${String(q).replace(/\n/g, "\n> ")}`, "");
    const said = c.reviewerOutputAtThatCommit?.publishedItems || [];
    if (c.verdict === "missed" && said.length) {
      md.push(`**What \`${c.reviewer}\` did publish at that commit** (${said.length} item(s)):`, "");
      for (const item of said) {
        const where = item.path ? ` \`${item.path}${item.line ? `:${item.line}` : ""}\`` : "";
        md.push(`- ${item.kind || "item"}${where}: ${String(item.excerpt || "").replace(/\n/g, " ").slice(0, 400)}`);
      }
      md.push("");
    }
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
