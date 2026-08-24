#!/usr/bin/env node
// Turn a directory of per-PR label files into the reviewer scorecard.
//
// All arithmetic lives here on purpose. Summing a few hundred labelled findings
// by hand is wrong often enough that one bad cell discredits the whole report,
// and a reader who disputes a number needs to be able to re-derive it.
//
// THE PRIMARY METRIC IS THE COMMON-SET HIT RATE.
//
// Reviewers do not get the same number of looks at a PR. One runs once at open;
// another re-runs on every push and reviews five times as many commits, at five
// times the compute. A defect introduced by the fourth push was never the
// once-at-open reviewer's to find, and charging it for that measures trigger
// configuration, not review quality.
//
// Opportunity-adjusted recall — each reviewer scored against its OWN set of
// defects-it-could-have-seen — fixes the denominator but not the set: the tools
// end up graded on different collections of defects, so a reviewer whose set is
// harder looks worse for reasons that have nothing to do with how well it
// reviews. And any raw per-PR count is worse still, because it pays a reviewer
// for being triggered more often.
//
// So the ranking metric is the COMMON SET: defects that EVERY compared reviewer
// was eligible to catch. Identical denominator, identical defects, no credit for
// arriving more often. Everything computed on a reviewer's own opportunity set
// is still reported — it is the right way to understand one tool — but it is
// printed below a divider and marked not comparable, because a reader who does
// not know each tool's trigger configuration will otherwise read a coverage
// difference as a quality difference, and they will not catch the error.
//
// Input:  one JSON file per PR matching the schema in references/agent-prompt.md
// Usage:  score-corpus.mjs --dir /tmp/rv/prs [--out report.md] [--json totals.json]

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEV = { blocking: 4, major: 3, minor: 2, nit: 1 };
const SEV_ORDER = ["blocking", "major", "minor", "nit"];
const MATERIAL = new Set(["blocking", "major"]);
const LABELS = ["confirmed", "below_bar", "incorrect", "unverified", "drifted", "out_of_scope"];
const OUTCOMES = new Set([
  "fixed", "fixed_claimed_not_real", "accepted", "rejected", "discussed", "none",
]);
// Below this many opportunities a recall percentage is not reportable: the
// confidence interval spans most of the range and the ordering it produces is
// noise. Flagged in every table rather than silently printed to one decimal.
const MIN_N = 12;

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write("usage: score-corpus.mjs --dir <dir> [--out report.md] [--json totals.json]\n");
  process.exit(2);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === "--dir") args.dir = process.argv[(i += 1)];
  else if (a === "--out") args.out = process.argv[(i += 1)];
  else if (a === "--json") args.json = process.argv[(i += 1)];
  else if (a === "--engagement") args.engagement = process.argv[(i += 1)];
  else if (a === "--prs") args.prs = process.argv[(i += 1)];
  else usage(`unknown arg ${a}`);
}
if (!args.dir) usage("need --dir");

let files = readdirSync(args.dir).filter((f) => f.endsWith(".json")).sort();
if (!files.length) usage(`no .json label files in ${args.dir}`);

// The corpus must be stated, not inferred from whatever happens to be on disk.
// These directories are long-lived and reused; a previous run's label files sit
// in the same place and get globbed into the next report without a word. That
// silently mixes two windows, two reviewer rosters, and two versions of the
// skill into one table — the exact "never carry a number across runs" failure
// the report rules forbid, and nothing else here would catch it.
const corpusNote = [];
if (args.prs) {
  const want = new Set(
    args.prs.split(",").map((s) => s.trim()).filter(Boolean).map(String),
  );
  const have = new Map(files.map((f) => [String(f.replace(/\.json$/, "")), f]));
  const extra = [...have.keys()].filter((k) => !want.has(k));
  const missing = [...want].filter((k) => !have.has(k));
  if (extra.length) {
    corpusNote.push(
      `${extra.length} label file(s) in ${args.dir} are not in the declared PR list and were ignored: ${extra.join(", ")}`,
    );
  }
  if (missing.length) {
    process.stderr.write(`error: declared PR(s) with no label file: ${missing.join(", ")}\n`);
    process.exit(2);
  }
  files = [...want].map((k) => have.get(k)).sort();
} else {
  corpusNote.push(
    `No --prs list given: every .json file in ${args.dir} was scored. If this directory has been reused, ` +
      `an earlier run's files are in this report. Declare the corpus with --prs to make it auditable.`,
  );
}

const prs = [];
const problems = [];
const fatalProblems = [];

// EVERY join in this script is on a commit sha, and the labelling agents write
// those shas by hand. A short sha, a rebased sha, or a typo used to fall through
// `indexOf(...) === -1` and silently remove the defect from every numerator AND
// every denominator with no output at all — the report then claimed to have
// audited a PR that contributed nothing. So: resolve prefixes against
// commitOrder, and make anything unresolvable loud rather than invisible.
function shaResolver(order) {
  const byPrefix = new Map();
  for (const full of order) {
    const f = String(full).toLowerCase();
    for (let n = 4; n <= f.length; n += 1) {
      const p = f.slice(0, n);
      // An ambiguous prefix must not silently pick a winner.
      byPrefix.set(p, byPrefix.has(p) && byPrefix.get(p) !== f ? "__AMBIGUOUS__" : f);
    }
  }
  return (sha) => {
    if (!sha) return null;
    const hit = byPrefix.get(String(sha).toLowerCase());
    if (hit === "__AMBIGUOUS__") return "__AMBIGUOUS__";
    return hit || null;
  };
}

for (const f of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(args.dir, f), "utf8"));
  } catch (e) {
    problems.push(`${f}: unparseable (${e.message})`);
    continue;
  }
  if (!doc.pr) problems.push(`${f}: missing "pr"`);
  doc.defects ||= [];
  doc.instances ||= [];
  doc.reviewEvents ||= [];
  doc.reviewersByCommit ||= {};
  doc.commitOrder ||= [];

  const tag = `PR ${doc.pr ?? f}`;

  if (!doc.skeptic || !["upheld", "revised", "rejected", "not_run"].includes(doc.skeptic.status)) {
    fatalProblems.push(`${tag}: missing valid skeptic status`);
  } else if (doc.skeptic.status === "not_run") {
    fatalProblems.push(`${tag}: skeptic not run`);
  } else if (doc.skeptic.status === "rejected") {
    fatalProblems.push(`${tag}: skeptic rejected the observation; reconcile it and mark the rewritten result revised`);
  }

  doc.commitOrder = doc.commitOrder.map((s) => String(s).toLowerCase());

  // No commit order means presence cannot be evaluated at all. Scoring the PR
  // anyway silently applies a different rule to it than to the rest of the
  // corpus, so drop it and say so.
  if (!doc.commitOrder.length) {
    problems.push(`${tag}: no commitOrder — PR excluded from all scoring (agent must copy \`commits\` from the raw file)`);
    doc.__excluded = "no commitOrder";
    prs.push(doc);
    continue;
  }

  const resolve = shaResolver(doc.commitOrder);
  const fix = (sha, where) => {
    if (!sha) return null;
    const r = resolve(sha);
    if (r === "__AMBIGUOUS__") {
      problems.push(`${tag}: sha "${sha}" at ${where} is an ambiguous prefix of two commits — treated as unresolvable`);
      return null;
    }
    if (!r) {
      problems.push(`${tag}: sha "${sha}" at ${where} is not in commitOrder (force-push, rebase, or a hand-typed sha)`);
      return null;
    }
    return r;
  };

  for (const d of doc.defects) {
    const introRaw = d.introducedAt || d.commit;
    d.introducedAt = fix(introRaw, `defect ${d.id} introducedAt`);
    d.commit = fix(d.commit, `defect ${d.id} commit`) || d.introducedAt;
    d.fixedAt = d.fixedAt ? fix(d.fixedAt, `defect ${d.id} fixedAt`) : null;
    // Unresolvable introduction point => presence is undefined. Mark it
    // ambiguous so it is excluded explicitly and counted in the report,
    // instead of evaporating.
    if (!d.introducedAt) {
      d.presenceAmbiguous = true;
      problems.push(`${tag}: defect ${d.id} has no resolvable introducedAt — excluded as presence-ambiguous`);
    }
    if (introRaw && d.fixedAt === null && d.fixedAtRaw) {
      problems.push(`${tag}: defect ${d.id} fixedAt unresolvable — defect treated as never fixed, which overcharges later reviewers`);
    }
  }
  for (const i of doc.instances) i.reviewedCommit = fix(i.reviewedCommit, `instance ${i.id} reviewedCommit`);
  for (const ev of doc.reviewEvents) ev.reviewedCommit = fix(ev.reviewedCommit, `review event reviewedCommit`);

  const rbc = {};
  for (const [sha, list] of Object.entries(doc.reviewersByCommit)) {
    const full = fix(sha, `reviewersByCommit key`);
    if (!full) continue; // already reported; a commit not in the PR grants no opportunity
    rbc[full] = [...new Set([...(rbc[full] || []), ...list])];
  }
  doc.reviewersByCommit = rbc;

  prs.push(doc);
}

if (fatalProblems.length) {
  for (const problem of fatalProblems) process.stderr.write(`error: ${problem}\n`);
  process.stderr.write("error: scoring stopped because unreviewed negative claims cannot enter headline metrics\n");
  process.exit(2);
}

// Human response to each finding, keyed "<pr>|<instanceId>". Optional: the report
// degrades to structural metrics without it, but this is the strongest evidence of
// value there is — an engineer who fixed code, or argued back, has told you what the
// finding was worth far more reliably than any label the audit assigns.
const engagement = new Map();
const engagementPrs = new Set();
let agentAuthoredPrs = 0;
if (args.engagement) {
  for (const f of readdirSync(args.engagement).filter((x) => x.endsWith(".json"))) {
    let e;
    try { e = JSON.parse(readFileSync(join(args.engagement, f), "utf8")); } catch { continue; }
    engagementPrs.add(String(e.pr));
    if (e.authorIsBot) agentAuthoredPrs += 1;
    for (const x of e.findings || []) {
      // Keyed by repo as well as PR: two repos audited into one directory with
      // overlapping PR numbers would otherwise attach human outcomes to the
      // wrong findings, silently.
      const key = `${e.repo || ""}|${e.pr}|${x.instanceId}`;
      if (engagement.has(key)) {
        problems.push(`engagement: duplicate entry for ${key} — later one wins`);
      }
      engagement.set(key, { ...x, authorIsBot: !!e.authorIsBot });
    }
  }
}

const reviewers = new Map();
const R = (login) => {
  if (!reviewers.has(login)) {
    reviewers.set(login, {
      login,
      prs: new Set(),
      instances: 0,
      labels: Object.fromEntries(LABELS.map((l) => [l, 0])),
      runtimeVerified: 0,
      sevAudited: Object.fromEntries(SEV_ORDER.map((s) => [s, 0])),
      inflation: [],
      claimedSeverityKnown: 0,
      classes: new Map(),
      latencies: [],
      // opportunity-adjusted coverage
      opportunity: 0,
      found: 0,
      unique: 0,
      uniqueContested: 0,
      soleEligible: 0,
      shared: 0,
      missed: 0,
      repeatInstances: 0,
      engMissing: 0,
      oppBySev: Object.fromEntries(SEV_ORDER.map((s) => [s, 0])),
      foundBySev: Object.fromEntries(SEV_ORDER.map((s) => [s, 0])),
      missedByClass: new Map(),
      commitsReviewed: new Set(),
      reviewEvents: 0,
      clearEvents: 0,
      falseClears: 0,
      actionedFound: 0,
      actionableFound: 0,
      perPrRecall: [],
      eng: { n: 0, fixed: 0, accepted: 0, rejected: 0, discussed: 0, none: 0, falseFix: 0,
             humanWords: 0, hN: 0, hFixed: 0, hRejected: 0, noiseN: 0, noiseFixed: 0, realN: 0, realFixed: 0,
             hRealN: 0, hRealFixed: 0, realFixedWithWords: 0, realFixedSilent: 0 },
      firstLook: { opp: 0, found: 0 },
      // Scored only on defects every compared reviewer was eligible to catch.
      commonOpp: 0,
      commonFound: 0,
      commonUnique: 0,
      commonOppBySev: Object.fromEntries(SEV_ORDER.map((s) => [s, 0])),
      commonFoundBySev: Object.fromEntries(SEV_ORDER.map((s) => [s, 0])),
      pairFound: new Map(), pairOpp: new Map(), pairBoth: new Map(), pairOnlyA: new Map(),
    });
  }
  return reviewers.get(login);
};

// ---- helpers ---------------------------------------------------------------

// A defect is present from the commit that introduced it until the commit that
// fixed it. Agents record `introducedAt` (falling back to `commit`) and `fixedAt`
// (null when it was never fixed inside the PR). Presence is evaluated against the
// PR's commit order so "later than" is well defined.
// Every sha reaching this point has already been resolved against commitOrder or
// nulled during load, so an unresolvable pin can no longer masquerade as "the
// defect was simply never live anywhere."
const presenceCache = new WeakMap();
function presenceSet(doc, d) {
  let perDoc = presenceCache.get(doc);
  if (!perDoc) presenceCache.set(doc, (perDoc = new Map()));
  const key = d.id || `${d.introducedAt}|${d.fixedAt}`;
  if (perDoc.has(key)) return perDoc.get(key);

  const order = doc.commitOrder;
  const intro = d.introducedAt;
  const out = new Set();
  const iIntro = intro ? order.indexOf(intro) : -1;

  if (iIntro >= 0) {
    const iFixed = d.fixedAt ? order.indexOf(d.fixedAt) : -1;
    // A fix recorded at or before the introduction is contradictory data. The
    // old code "rescued" it by resurrecting the defect at `intro`, inventing
    // opportunity plus a guaranteed miss for whoever reviewed there.
    if (iFixed >= 0 && iFixed <= iIntro) {
      // Fixed at or before it was introduced is contradictory. Usually it means
      // commitOrder is inverted — which a rebase produces whenever the ordering
      // was derived from author dates rather than committer dates. Exclude it
      // and say so, rather than silently returning an empty presence window that
      // reads as "no reviewer was eligible."
      d.presenceAmbiguous = true;
      d.__orderContradiction = true;
    } else {
      for (const sha of Object.keys(doc.reviewersByCommit)) {
        const i = order.indexOf(sha);
        if (i < iIntro) continue; // defect did not exist yet
        if (iFixed >= 0 && i >= iFixed) continue; // already fixed
        out.add(sha);
      }
    }
  }
  perDoc.set(key, out);
  return out;
}

const scorable = (doc) => !doc.__excluded;

// ---- precision, profile, latency: every PR the reviewer touched -------------

for (const doc of prs) {
  if (!scorable(doc)) continue;
  const seen = new Set();
  for (const ev of doc.reviewEvents) {
    seen.add(ev.reviewer);
    const r = R(ev.reviewer);
    r.reviewEvents += 1;
    if (typeof ev.minutesToReview === "number" && ev.minutesToReview >= 0) r.latencies.push(ev.minutesToReview);
    if (ev.verdict === "clear") r.clearEvents += 1;
  }
  for (const [sha, list] of Object.entries(doc.reviewersByCommit)) {
    for (const login of list) {
      R(login).commitsReviewed.add(`${doc.pr}:${sha}`);
      // Reviewing a commit is participation. Deriving `prs` only from review
      // events and non-duplicate instances left a reviewer whose findings were
      // all repeat-posts with opportunity and misses on a PR that never entered
      // its PR count, inflating every per-PR rate that divides by it.
      seen.add(login);
    }
  }

  for (const inst of doc.instances) {
    seen.add(inst.reviewer); // counted before the duplicate filter, not after
    if (inst.duplicateOf) {
      R(inst.reviewer).repeatInstances += 1;
      continue; // a repeat of the same mechanism, not a new claim
    }
    const r = R(inst.reviewer);
    r.instances += 1;
    const label = LABELS.includes(inst.label) ? inst.label : "unverified";
    if (!LABELS.includes(inst.label)) problems.push(`PR ${doc.pr} ${inst.id}: unknown label ${inst.label}`);
    r.labels[label] += 1;
    if (label !== "confirmed") continue;

    if (inst.runtimeVerified) r.runtimeVerified += 1;
    const sev = SEV[inst.auditedSeverity] ? inst.auditedSeverity : null;
    if (sev) r.sevAudited[sev] += 1;
    else problems.push(`PR ${doc.pr} ${inst.id}: confirmed with no audited severity`);
    if (sev && SEV[inst.claimedSeverity]) {
      r.inflation.push(SEV[inst.claimedSeverity] - SEV[sev]);
      r.claimedSeverityKnown += 1;
    }
    const cls = inst.class || "unclassified";
    r.classes.set(cls, (r.classes.get(cls) || 0) + 1);
  }

  // engagement is recorded against every non-duplicate instance, whatever its label
  const engRan = engagementPrs.has(String(doc.pr));
  for (const inst of doc.instances) {
    if (inst.duplicateOf) continue;
    const e = engagement.get(`${doc.repo || ""}|${doc.pr}|${inst.id}`) || engagement.get(`${doc.pr}|${inst.id}`);
    const r = R(inst.reviewer);
    // An instance the engagement pass never wrote an entry for used to be
    // skipped entirely, so a pass-3 agent that only recorded findings which got
    // a response drove "silently ignored" toward zero and made every reviewer
    // look engaged with. Absence of evidence of engagement IS "none" — but it
    // is counted separately so the report can show how much of the engagement
    // data is inferred rather than observed.
    if (!e) {
      if (!engRan) continue; // pass 3 never ran on this PR at all
      r.engMissing += 1;
      problems.push(`PR ${doc.pr} ${inst.id}: no engagement entry (counted as "none"; agent-prompt requires one per instance)`);
    }
    const o = String((e && e.outcome) || "none");
    if (e && !OUTCOMES.has(o)) {
      problems.push(`PR ${doc.pr} ${inst.id}: unknown engagement outcome "${o}" — counted as "none"`);
    }
    const g = r.eng;
    g.n += 1;
    if (o.startsWith("fixed_claimed")) g.falseFix += 1;
    else if (o === "fixed") g.fixed += 1;
    else if (o === "accepted") g.accepted += 1;
    else if (o === "rejected") g.rejected += 1;
    else if (o === "discussed") g.discussed += 1;
    else g.none += 1;
    if (e && e.humanWords) g.humanWords += 1;
    // A person owning the code is stronger evidence than one agent answering
    // another. On repos where agents open most PRs, pooling the two makes the
    // headline value metric substantially one bot agreeing with another, so the
    // human-authored subset is tracked separately for EVERY engagement row —
    // not just for the two that used to be gated.
    const humanAuthored = !(e && e.authorIsBot);
    if (humanAuthored) {
      g.hN += 1;
      if (o === "fixed") g.hFixed += 1;
      if (o === "rejected") g.hRejected += 1;
    }
    // Did the team spend work on something the audit says did not matter?
    const lbl = LABELS.includes(inst.label) ? inst.label : "unverified";
    if (lbl === "confirmed") {
      g.realN += 1;
      if (o === "fixed") {
        g.realFixed += 1;
        // "The team fixed it" is only an endorsement if a person was involved.
        // Where an automated fixer consumes reviewer findings and pushes commits,
        // a `fixed` outcome with no human words is one bot acting on another —
        // real evidence the finding was actionable, but NOT evidence an engineer
        // judged it worth acting on. Kept apart so the two are never pooled.
        if (e && e.humanWords) g.realFixedWithWords += 1;
        else g.realFixedSilent += 1;
      }
      if (humanAuthored) { g.hRealN += 1; if (o === "fixed") g.hRealFixed += 1; }
    } else if (lbl === "below_bar" || lbl === "incorrect") {
      g.noiseN += 1;
      if (o === "fixed") g.noiseFixed += 1;
    }
  }

  for (const login of seen) R(login).prs.add(`${doc.repo || ""}#${doc.pr}`);
}

// ---- opportunity-adjusted coverage -----------------------------------------

// THE LEVEL PLAYING FIELD.
//
// Reviewers do not see the same code. One runs once at open; another is
// re-triggered on every push and reviews five times as many commits. Any
// per-PR count of what a reviewer found therefore mixes two different things —
// how well it reviews, and how often it was invited to. Opportunity-adjusted
// recall fixes the denominator but not the *set*: each reviewer is scored on a
// different collection of defects, so a reviewer whose set happens to be harder
// looks worse for no reason connected to its quality.
//
// The common set removes both problems at once: only defects that EVERY
// compared reviewer was eligible to catch. Identical denominator, identical
// defects, no credit for arriving more often. It is the only cut in this report
// that can be read as a quality ranking without knowing each tool's trigger
// configuration — which the reader generally does not.
const rosterLogins = [...reviewers.values()].filter((r) => r.prs.size > 0).map((r) => r.login);
let commonSetSize = 0;

let allDefects = 0;
let eligibleDefects = 0; // defects at least one reviewer could have caught
let missedByAllCount = 0;
let preExistingSkipped = 0;
let ambiguousSkipped = 0;
let noEligibleReviewer = 0;
let contradictions = 0;
const missedByAll = [];

for (const doc of prs) {
  if (!scorable(doc)) continue;
  const perPr = new Map(); // login -> {opp, found}

  for (const d of doc.defects) {
    // A defect that already existed on the base branch is not one this PR
    // introduced, so no reviewer of this PR is scored on it either way.
    if (d.preExisting) {
      preExistingSkipped += 1;
      continue;
    }
    // A branch rewrite can leave a defect whose introduce/fix commits cannot be
    // ordered against each other. Scoring it would guess at who had the chance.
    if (d.presenceAmbiguous) {
      ambiguousSkipped += 1;
      continue;
    }
    allDefects += 1;
    const present = presenceSet(doc, d);
    // Everyone who reviewed any commit where this defect was live.
    const hadChance = new Set();
    for (const sha of present) for (const login of doc.reviewersByCommit[sha] || []) hadChance.add(login);

    // Publishing a confirmed finding is itself proof of eligibility — you cannot
    // miss what you found. Coverage is otherwise inferred only from commits a
    // reviewer left a *pinned* trace on, and a reviewer that publishes its
    // findings in summary comments carries no commit pin at all. Without this,
    // such a reviewer's own confirmed catches were read as a data contradiction
    // and dropped from scoring entirely. Adding the finder increments numerator
    // and denominator together, so it cannot be used to dodge a miss.
    for (const login of d.foundBy || []) hadChance.add(login);

    const claimed = d.foundBy || [];
    const found = claimed.filter((x) => hadChance.has(x));
    if (!SEV[d.severity]) problems.push(`PR ${doc.pr} defect ${d.id}: unknown severity "${d.severity}" — treated as minor`);
    const sev = SEV[d.severity] ? d.severity : "minor";
    const cls = d.class || "unclassified";

    // A reviewer named in `foundBy` that is not eligible is a contradiction in
    // the data, not a miss: it means the presence window and the coverage map
    // disagree. Publishing it anyway put defects a reviewer demonstrably
    // reported into the "nobody caught this" table — the report's most quoted
    // section and the fastest way to lose a reader who recognises their own
    // comment there.
    const phantom = claimed.filter((x) => !hadChance.has(x));
    if (phantom.length) {
      contradictions += 1;
      problems.push(
        `PR ${doc.pr} defect ${d.id}: foundBy names ${phantom.join(", ")} but the presence window says they were not eligible ` +
          `— defect excluded from "missed by everyone" (check introducedAt/fixedAt and reviewersByCommit)`,
      );
    }

    // In the common set only if every compared reviewer could have caught it.
    const isCommon = rosterLogins.length > 0 && rosterLogins.every((l) => hadChance.has(l));
    if (isCommon) {
      commonSetSize += 1;
      for (const login of rosterLogins) {
        const r = R(login);
        r.commonOpp += 1;
        r.commonOppBySev[sev] += 1;
        if (found.includes(login)) {
          r.commonFound += 1;
          r.commonFoundBySev[sev] += 1;
          if (found.length === 1) r.commonUnique += 1;
        }
      }
    }

    if (!hadChance.size) {
      noEligibleReviewer += 1;
    } else {
      eligibleDefects += 1;
      if (!found.length && !phantom.length) {
        missedByAllCount += 1;
        missedByAll.push({ pr: doc.pr, title: d.title, severity: sev, class: cls, url: doc.url, eligible: hadChance.size });
      }
    }

    for (const login of hadChance) {
      const r = R(login);
      r.opportunity += 1;
      r.oppBySev[sev] += 1;
      if (!perPr.has(login)) perPr.set(login, { opp: 0, found: 0 });
      perPr.get(login).opp += 1;
      if (found.includes(login)) {
        r.found += 1;
        r.foundBySev[sev] += 1;
        perPr.get(login).found += 1;
        if (found.length === 1) {
          r.unique += 1;
          // "Only it found this" is only a quality claim when somebody else
          // could have. Where a reviewer was the sole eligible one — exactly
          // what re-running on every push buys you on the late commits — the
          // uniqueness is an artefact of trigger configuration, the very bias
          // opportunity-adjusted recall exists to remove. Counted apart so it
          // cannot walk back in through the row that drives the verdict.
          if (hadChance.size > 1) r.uniqueContested += 1;
          else r.soleEligible += 1;
        } else r.shared += 1;
        if (typeof d.actioned === "boolean") {
          r.actionableFound += 1;
          if (d.actioned) r.actionedFound += 1;
        }
      } else {
        r.missed += 1;
        r.missedByClass.set(cls, (r.missedByClass.get(cls) || 0) + 1);
      }
    }
  }

  for (const [login, v] of perPr) if (v.opp > 0) R(login).perPrRecall.push(v.found / v.opp);

  // FIRST LOOK — one pass each. Neutralises the reviewer that re-runs on every push:
  // each reviewer is scored only on what it caught at its OWN earliest review of this PR.
  const firstCommitOf = {};
  for (const [sha, list] of Object.entries(doc.reviewersByCommit)) {
    const j = (doc.commitOrder || []).indexOf(sha);
    if (j < 0) continue;
    for (const login of list) {
      const cur = firstCommitOf[login];
      if (cur === undefined || j < (doc.commitOrder || []).indexOf(cur)) firstCommitOf[login] = sha;
    }
  }
  const confirmedAt = {};
  for (const i of doc.instances || []) {
    if (i.defectId && i.label === "confirmed") (confirmedAt[i.defectId] ||= []).push(i);
  }
  for (const [login, sha] of Object.entries(firstCommitOf)) {
    const r = R(login);
    for (const d of doc.defects) {
      if (d.preExisting || d.presenceAmbiguous) continue;
      if (!presenceSet(doc, d).has(sha)) continue;
      r.firstLook.opp += 1;
      // Credit requires a confirmed instance from this reviewer at this commit.
      // Demanding an exact `reviewedCommit` match structurally scored 0% for
      // summary-comment reviewers, whose findings carry no commit pin at all —
      // the precise class of reviewer this metric is advertised as treating
      // fairly. An instance with no resolvable commit is attributed to that
      // reviewer's first look rather than thrown away.
      const hit = (confirmedAt[d.id] || []).some(
        (i) => i.reviewer === login && (i.reviewedCommit === sha || !i.reviewedCommit),
      );
      if (hit) r.firstLook.found += 1;
    }
  }

  // PAIRWISE — restricted to defects live on a commit BOTH reviewers reviewed.
  //
  // The old version took the union of everyone who reviewed any commit in the
  // presence window, so A reviewing only c1 and B only c3 counted as "both had
  // it", and it used A's find-count as the denominator. That is a directed
  // containment ratio over A's home turf, not the symmetric comparison
  // report.md advertises. Both are fixed here: `shared` is a genuine
  // intersection over commits, and both a symmetric shared-opportunity
  // denominator and the directed conditional are recorded.
  for (const d of doc.defects) {
    if (d.preExisting || d.presenceAmbiguous) continue;
    const present = presenceSet(doc, d);
    const had = new Set();
    for (const sha of present) for (const login of doc.reviewersByCommit[sha] || []) had.add(login);
    const foundSet = new Set((d.foundBy || []).filter((x) => had.has(x)));
    for (const a of had) {
      for (const b of had) {
        if (a === b) continue;
        // Did some single commit in the presence window carry both of them?
        const together = [...present].some((sha) => {
          const l = doc.reviewersByCommit[sha] || [];
          return l.includes(a) && l.includes(b);
        });
        if (!together) continue;
        const r = R(a);
        r.pairBoth.set(b, (r.pairBoth.get(b) || 0) + 1);
        if (foundSet.has(a)) r.pairOpp.set(b, (r.pairOpp.get(b) || 0) + 1);
        if (foundSet.has(a) && foundSet.has(b)) r.pairFound.set(b, (r.pairFound.get(b) || 0) + 1);
        if (foundSet.has(a) && !foundSet.has(b)) r.pairOnlyA.set(b, (r.pairOnlyA.get(b) || 0) + 1);
      }
    }
  }

  // A false clear: reviewer published "clear" on a commit where a minor-or-worse
  // defect that SOMEBODY ELSE independently established was live.
  //
  // report.md promises exactly that — "a clear verdict is only counted false
  // when somebody else established a defect on that exact commit" — and the old
  // code checked none of it. It fired on cold-review-only defects (the
  // least-corroborated entries in the corpus) and on `preExisting` defects the
  // same script excludes from every other metric, turning an honest "I found
  // nothing in this diff" into an accusation of dishonesty. This is the one
  // number in the report that reads as bad faith; it now matches its promise.
  const corroborated = new Set(
    doc.instances.filter((i) => i.label === "confirmed" && i.defectId).map((i) => i.defectId),
  );
  for (const ev of doc.reviewEvents) {
    if (ev.verdict !== "clear" || !ev.reviewedCommit) continue;
    const live = doc.defects.filter((d) => {
      if (d.preExisting || d.presenceAmbiguous) return false;
      if (!SEV[d.severity] || SEV[d.severity] < SEV.minor) return false;
      // Established by a reviewer other than the one being charged.
      const byOther =
        corroborated.has(d.id) && (d.foundBy || []).some((x) => x !== ev.reviewer);
      if (!byOther) return false;
      return presenceSet(doc, d).has(ev.reviewedCommit);
    });
    if (live.length) R(ev.reviewer).falseClears += 1;
  }
}

// ---- render ----------------------------------------------------------------

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "-");
// A percentage without its denominator is the easiest number in this report to
// misquote, and on a short window the denominators are small enough that the
// ordering they produce is noise. Every rate that drives a verdict prints n,
// and anything under MIN_N is marked rather than presented as a result.
const rate = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}% (${n}/${d})${d < MIN_N ? " ⚠" : ""}` : `- (0)`);
// Wilson 95% interval — the honest width of a recall estimate at these sample
// sizes. Two reviewers whose intervals overlap are not ranked by this report.
const wilson = (n, d) => {
  if (!d) return null;
  const z = 1.96;
  const p = n / d;
  const denom = 1 + (z * z) / d;
  const centre = (p + (z * z) / (2 * d)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / d + (z * z) / (4 * d * d))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
};
const ci = (n, d) => {
  const w = wilson(n, d);
  return w ? `${(w[0] * 100).toFixed(0)}–${(w[1] * 100).toFixed(0)}%` : "-";
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dur = (mins) => {
  if (mins == null) return "-";
  if (mins < 90) return `${Math.round(mins)}m`;
  if (mins < 60 * 48) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
};
const topN = (map, n = 3) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ") || "-";

const scoredPrs = prs.filter(scorable);
const corpusPrs = scoredPrs.length;
// Sorted by the common-set hit rate: the same defects for every reviewer. Column
// order is the report's implicit ranking, so it must not be set by a number that
// moves with how often a tool happened to be triggered. Both earlier sorts —
// opportunity-adjusted recall, then raw defects per PR — did exactly that.
const rows = [...reviewers.values()].sort(
  (a, b) => b.commonFound / (b.commonOpp || 1) - a.commonFound / (a.commonOpp || 1),
);
const L = [];

L.push(`# AI code reviewer scorecard`, "");
L.push(
  `${corpusPrs} PR(s) scored, ${rows.length} reviewer(s), ${allDefects} audited defect(s) introduced by these PRs` +
    (preExistingSkipped ? `, plus ${preExistingSkipped} pre-existing defect(s) excluded` : "") +
    (ambiguousSkipped ? `, and ${ambiguousSkipped} excluded for an unorderable presence window after a branch rewrite` : "") +
    `.`,
  "",
);
for (const n of corpusNote) L.push(`> **Corpus.** ${n}`, "");
const excludedPrs = prs.length - corpusPrs;
if (excludedPrs || noEligibleReviewer || contradictions) {
  L.push(
    `> **Data exclusions.** ` +
      [
        excludedPrs ? `${excludedPrs} PR(s) dropped entirely (no usable commit order)` : null,
        noEligibleReviewer
          ? `${noEligibleReviewer} defect(s) had no eligible reviewer and are excluded from the "missed by everyone" rate`
          : null,
        contradictions
          ? `${contradictions} defect(s) name a finder the presence window says was ineligible — excluded rather than reported as missed`
          : null,
      ]
        .filter(Boolean)
        .join("; ") + `. See **Data problems** below; these are corpus bugs, not reviewer results.`,
    "",
  );
}
if (engagement.size) {
  const totalEng = rows.reduce((a, r) => a + r.eng.n, 0);
  const missing = rows.reduce((a, r) => a + r.engMissing, 0);
  L.push(
    `> **Engagement basis.** ${agentAuthoredPrs} of ${engagementPrs.size} PR(s) with engagement data were opened by an agent, ` +
      `not a person. On those, "the team fixed it" can mean one bot answering another — read the human-authored row beneath it. ` +
      (missing ? `${missing} of ${totalEng} instance(s) had no engagement entry and are counted as "none".` : ""),
    "",
  );
}

// ---------------- headline ----------------
// ---------------- the one table ----------------
L.push(`## Comparable quality — same eligible defects`, "");
L.push(
  `**Rows above the divider are the only ones comparable between reviewers.** They are scored on the ` +
    `**common set**: the ${commonSetSize} defect(s) that *every* reviewer here was eligible to catch — same defects, ` +
    `same denominator for all of them. That matters because these tools are not triggered the same way. A reviewer ` +
    `re-run on every push sees more commits than one that runs once when the PR opens, so any raw per-PR count ` +
    `rewards being invited more often, not reviewing better. Check the passes-per-PR row to see how far apart they are.`,
  "",
  `Rows **below** the divider are each reviewer measured on its own terms. They are useful for understanding a ` +
    `single tool and must not be read as a ranking.`,
  "",
);
L.push(`| | ${rows.map((r) => r.login).join(" | ")} |`);
L.push(`|---|${rows.map(() => "---:").join("|")}|`);
const line = (label, fn) => L.push(`| ${label} | ${rows.map(fn).join(" | ")} |`);
// LEVEL FIELD FIRST. Same defects, same denominator, for every reviewer.
line(
  commonSetSize < MIN_N
    ? "**Caught, of the same defects** ⚠ too few to rank"
    : "**Caught, of the same defects**",
  (r) => `**${rate(r.commonFound, r.commonOpp)}**`,
);
line("— 95% CI", (r) => ci(r.commonFound, r.commonOpp));
line("— material only (blocking+major)", (r) => {
  const o = SEV_ORDER.filter((x) => MATERIAL.has(x)).reduce((a, x) => a + r.commonOppBySev[x], 0);
  const f = SEV_ORDER.filter((x) => MATERIAL.has(x)).reduce((a, x) => a + r.commonFoundBySev[x], 0);
  return rate(f, o);
});
line("— only it found", (r) => String(r.commonUnique));
line("**— per PR**", (r) => (corpusPrs ? `**${(r.commonFound / corpusPrs).toFixed(2)}**` : "-"));
line("PRs covered (of corpus)", (r) => rate(r.prs.size, corpusPrs));
line("Passes per PR", (r) => (r.prs.size ? (r.reviewEvents / r.prs.size).toFixed(1) : "-"));
line("Findings per PR", (r) => (r.prs.size ? (r.instances / r.prs.size).toFixed(1) : "-"));
line("Precision (adjudicated in-scope claims)", (r) =>
  rate(r.labels.confirmed, r.labels.confirmed + r.labels.below_bar + r.labels.incorrect));
// below_bar and incorrect are kept apart here, not summed. The skill's own
// rules say collapsing them "punishes a cautious reviewer exactly as hard as a
// hallucinating one" — and the headline row used to do exactly that.
line("**Nitpicks per PR**", (r) => (r.prs.size ? `**${(r.labels.below_bar / r.prs.size).toFixed(1)}**` : "-"));
line("**Wrong claims per PR**", (r) => (r.prs.size ? `**${(r.labels.incorrect / r.prs.size).toFixed(1)}**` : "-"));
line("Repeat comments per PR", (r) => (r.prs.size ? (r.repeatInstances / r.prs.size).toFixed(1) : "-"));
if (engagement.size) {
  line("Team fixed it (of real findings)", (r) => rate(r.eng.realFixed, r.eng.realN));
  line("↳ a person said something too", (r) => rate(r.eng.realFixedWithWords, r.eng.realN));
  line("↳ fixed silently (may be automation)", (r) => String(r.eng.realFixedSilent));
  line("↳ human-authored PRs only", (r) => rate(r.eng.hRealFixed, r.eng.hRealN));
  line("Human argued back", (r) => rate(r.eng.hRejected, r.eng.hN));
  line("Silently ignored", (r) => rate(r.eng.none, r.eng.n));
  line("Noise the team fixed anyway", (r) => String(r.eng.noiseFixed));
  line("Claimed fixed, mechanism survived", (r) => String(r.eng.falseFix));
}
L.push(`| _— not comparable across reviewers —_ |${rows.map(() => " |").join("")}`);
// Everything below this line is affected by how often each tool was triggered,
// and is printed for diagnosis, not for ranking.
line("Total defects caught per PR", (r) => (r.prs.size ? (r.found / r.prs.size).toFixed(2) : "-"));
line("Recall on its own opportunity set", (r) => rate(r.found, r.opportunity));
line("Recall — one pass each", (r) => rate(r.firstLook.found, r.firstLook.opp));
line("Defects per pass", (r) => (r.reviewEvents ? (r.found / r.reviewEvents).toFixed(2) : "-"));
line("Unique catches (contested)", (r) => String(r.uniqueContested));
line("↳ sole-eligible (trigger artefact)", (r) => String(r.soleEligible));
line("Showed it ran code", (r) => pct(r.runtimeVerified, r.labels.confirmed));
line("Severity over-rating", (r) => {
  const inf = avg(r.inflation);
  return inf == null ? "-" : (inf > 0 ? "+" : "") + inf.toFixed(2);
});
L.push("");

L.push(`## Redundancy — of what A found, how much did B also find?`, "");
L.push(
  `Restricted to defects live on a commit **both** reviewers actually reviewed. A reviewer highly contained in another ` +
    `is a candidate to drop — but only if the containment holds in both directions and the counts are large enough to mean ` +
    `anything. Check the "only A found" table beneath before cutting.`,
  "",
);
L.push(`| Of what A found, B also found | ${rows.map((r) => r.login).join(" | ")} |`);
L.push(`|---|${rows.map(() => "---:").join("|")}|`);
for (const a of rows) {
  const cells = rows.map((b) => {
    if (a.login === b.login) return "—";
    const o = a.pairOpp.get(b.login) || 0; // defects A found, among those both were live on a shared commit
    const both = a.pairBoth.get(b.login) || 0;
    if (!both) return "-";
    if (!o) return `n/a (A found 0 of ${both})`;
    return `${pct(a.pairFound.get(b.login) || 0, o)} of ${o}`;
  });
  L.push(`| **${a.login}** | ${cells.join(" | ")} |`);
}
L.push("");
L.push(
  `Read as: of the defects **A** found where both reviewers were live on a shared commit, this share **B** also found. ` +
    `The trailing count is A's find total on that shared set, not the shared opportunity — the two are different and the ` +
    `directed ratio is not symmetric, so read both A→B and B→A before calling anything redundant. A reviewer that finds ` +
    `little, all of it also found by another, reads as highly contained; that is a small-sample artefact as often as it ` +
    `is genuine redundancy.`,
  "",
);
L.push(`| Defects only A found (of the shared set) | ${rows.map((r) => r.login).join(" | ")} |`);
L.push(`|---|${rows.map(() => "---:").join("|")}|`);
for (const a of rows) {
  const cells = rows.map((b) =>
    a.login === b.login ? "—" : String(a.pairOnlyA.get(b.login) || 0),
  );
  L.push(`| **${a.login}** | ${cells.join(" | ")} |`);
}
L.push("");
L.push(`## Comparable quality detail — the same ${commonSetSize} defect(s), scored for everyone`, "");
if (commonSetSize < MIN_N) {
  // The whole point of this table is that it is the one safe thing to rank on.
  // At a handful of defects it is not: the intervals cover most of the range and
  // the ordering is noise. Refusing here is the only honest move, because a
  // reader shown "100%" over n=1 will quote the 100%.
  L.push(
    `> **This corpus cannot rank these reviewers.** Only ${commonSetSize} defect(s) were live on commits *every* ` +
      `reviewer reviewed, which is too few to distinguish them — the confidence intervals below overlap almost ` +
      `entirely. This usually means the tools are triggered very differently (compare passes per PR) or the window is ` +
      `too short. Widen the corpus, or report each reviewer separately and state plainly that no comparison was ` +
      `possible. Do not present the ordering below as a result.`,
    "",
  );
} else {
  L.push(
    `Every reviewer here was eligible to catch every defect in this set, so the denominators are identical and no one ` +
      `is credited for being triggered more often. **This is the table to rank on.**`,
    "",
  );
}
L.push(`| Reviewer | Common opportunity | Found | **Hit rate** | 95% CI | Material | Only it found |`);
L.push(`|---|---:|---:|---:|---:|---:|---:|`);
for (const r of rows) {
  const mo = SEV_ORDER.filter((s) => MATERIAL.has(s)).reduce((a, s) => a + r.commonOppBySev[s], 0);
  const mf = SEV_ORDER.filter((s) => MATERIAL.has(s)).reduce((a, s) => a + r.commonFoundBySev[s], 0);
  L.push(
    `| ${r.login} | ${r.commonOpp} | ${r.commonFound} | **${pct(r.commonFound, r.commonOpp)}** | ` +
      `${ci(r.commonFound, r.commonOpp)} | ${mf}/${mo} | ${r.commonUnique} |`,
  );
}
L.push("");
L.push(
  `The common set is ${commonSetSize} of ${allDefects} audited defect(s). The rest were live only on commits some ` +
    `reviewer never saw, so no fair comparison is possible on them.`,
  "",
);

L.push(`## Installed value — configured coverage and review cost`, "");
L.push(`### Each reviewer on its own terms — NOT comparable between reviewers`, "");
L.push(
  `Each reviewer's denominator here is **its own opportunity set**: defects that were live in the code at a commit ` +
    `that reviewer actually reviewed. A defect introduced by a push a reviewer never saw is not counted against it. ` +
    `That makes the number fair to each tool individually, but the sets differ between tools — a reviewer re-run on ` +
    `every push is scored on a larger and different collection of defects. **Do not rank reviewers with this table;** ` +
    `use the common-set table above.`,
  "",
);
L.push(
  `| Reviewer | Commits reviewed | Opportunity | Found | **Recall** | 95% CI | Recall (per-PR mean) | Only it found (contested) | Sole-eligible |`,
);
L.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
for (const r of rows) {
  const macro = avg(r.perPrRecall);
  L.push(
    `| ${r.login} | ${r.commitsReviewed.size} | ${r.opportunity} | ${r.found} | **${pct(r.found, r.opportunity)}** | ` +
      `${ci(r.found, r.opportunity)} | ${macro == null ? "-" : (macro * 100).toFixed(1) + "%"} | ` +
      `${r.uniqueContested} | ${r.soleEligible} |`,
  );
}
L.push("");

L.push(`### Material defects only (blocking + major), own opportunity set`, "");
L.push(
  `A reviewer that files many small observations is neither rewarded nor punished here — only defects that cause real ` +
    `harm count. Still each reviewer's own set, so still not a ranking: the material column of the common-set table ` +
    `above is the comparable version.`,
  "",
);
L.push(`| Reviewer | Material opportunity | Found | **Material recall** |`);
L.push(`|---|---:|---:|---:|`);
for (const r of rows) {
  const opp = SEV_ORDER.filter((s) => MATERIAL.has(s)).reduce((a, s) => a + r.oppBySev[s], 0);
  const fnd = SEV_ORDER.filter((s) => MATERIAL.has(s)).reduce((a, s) => a + r.foundBySev[s], 0);
  L.push(`| ${r.login} | ${opp} | ${fnd} | **${pct(fnd, opp)}** |`);
}
L.push("");

L.push(`### Recall by severity`, "");
L.push(`| Reviewer | ${SEV_ORDER.map((s) => s[0].toUpperCase() + s.slice(1)).join(" | ")} |`);
L.push(`|---|${SEV_ORDER.map(() => "---:").join("|")}|`);
for (const r of rows) {
  const cells = SEV_ORDER.map((s) =>
    r.oppBySev[s] ? `${r.foundBySev[s]}/${r.oppBySev[s]} (${pct(r.foundBySev[s], r.oppBySev[s])})` : "-",
  );
  L.push(`| ${r.login} | ${cells.join(" | ")} |`);
}
L.push("");

// ---------------- cost side ----------------
L.push(`## What it costs to read — precision and noise`, "");
L.push(
  `Recall is only half the trade. **Noise per PR** is the absolute number of published comments that did not ` +
    `describe a real defect, which is what a reader actually experiences. \`below_bar\` is a real mechanism with no ` +
    `material harm — a nitpick. \`incorrect\` is a claim the code disproves. They are counted separately on purpose: ` +
    `a cautious reviewer and a hallucinating one should not score the same.`,
  "",
);
L.push(
  `| Reviewer | PRs | Findings | Findings/PR | Confirmed | Nitpicks | Wrong | Unverified | Drifted | Out of scope | Precision | **Noise/PR** | Defects per noisy comment |`,
);
L.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
for (const r of rows) {
  const noise = r.labels.below_bar + r.labels.incorrect;
  const precisionDenominator = r.labels.confirmed + r.labels.below_bar + r.labels.incorrect;
  const n = r.prs.size || 1;
  L.push(
    `| ${r.login} | ${r.prs.size} | ${r.instances} | ${(r.instances / n).toFixed(1)} | ${r.labels.confirmed} | ` +
      `${r.labels.below_bar} | ${r.labels.incorrect} | ${r.labels.unverified} | ${r.labels.drifted} | ${r.labels.out_of_scope} | ` +
      `${pct(r.labels.confirmed, precisionDenominator)} | ` +
      `**${(noise / n).toFixed(1)}** | ${noise ? (r.labels.confirmed / noise).toFixed(2) : "-"} |`,
  );
}
L.push("");

L.push(`## Effort — reviewers do not spend the same compute`, "");
L.push(
  `Passes and commits reviewed are the clearest available proxy for how much work each reviewer does. They explain ` +
    `differences in absolute defects found across a repo, and they are already neutralised in the recall table above.`,
  "",
);
L.push(`| Reviewer | Review passes | Commits reviewed | Passes/PR | Clear verdicts | Clear rate | False clears |`);
L.push(`|---|---:|---:|---:|---:|---:|---:|`);
for (const r of rows) {
  const n = r.prs.size || 1;
  L.push(
    `| ${r.login} | ${r.reviewEvents} | ${r.commitsReviewed.size} | ${(r.reviewEvents / n).toFixed(1)} | ` +
      `${r.clearEvents} | ${pct(r.clearEvents, r.reviewEvents)} | ${r.falseClears} |`,
  );
}
L.push("");
L.push(
  `A reviewer that never issues a clear verdict cannot record a false clear. Read the false-clear column only ` +
    `against the clear-verdict count beside it; \`0 of 0\` is an abstention, not an accuracy record.`,
  "",
);

L.push(`## What each reviewer looks for`, "");
L.push(`| Reviewer | Blocking | Major | Minor | Nit | Showed execution evidence | Top classes | Median time to first comment |`);
L.push(`|---|---:|---:|---:|---:|---:|---|---:|`);
for (const r of rows) {
  L.push(
    `| ${r.login} | ${r.sevAudited.blocking} | ${r.sevAudited.major} | ${r.sevAudited.minor} | ${r.sevAudited.nit} | ` +
      `${pct(r.runtimeVerified, r.labels.confirmed)} | ${topN(r.classes)} | ${dur(median(r.latencies))} |`,
  );
}
L.push("");

L.push(`### Severity rating accuracy (reported separately — not part of recall)`, "");
L.push(
  `Mean signed gap between the severity a reviewer claimed and the severity the audit assigned, on ` +
    `blocking=4 to nit=1. Positive means the reviewer over-rates its own findings. **Vendors use different scales ` +
    `(P1/P2 badges, high/medium/low, tags), mapped onto this one by the auditing agent, so small differences between ` +
    `reviewers are not meaningful.** Coverage shows how much of each reviewer's output carried a stated severity at all.`,
  "",
);
L.push(`| Reviewer | Severity gap | Confirmed findings with a stated severity | Coverage |`);
L.push(`|---|---:|---:|---:|`);
for (const r of rows) {
  const inf = avg(r.inflation);
  L.push(
    `| ${r.login} | ${inf == null ? "-" : (inf > 0 ? "+" : "") + inf.toFixed(2)} | ` +
      `${r.claimedSeverityKnown} of ${r.labels.confirmed} | ${pct(r.claimedSeverityKnown, r.labels.confirmed)} |`,
  );
}
L.push("");

L.push(`## Blind spots`, "");
L.push(`| Reviewer | Most-missed classes | Acted on by author |`);
L.push(`|---|---|---:|`);
for (const r of rows) {
  L.push(`| ${r.login} | ${topN(r.missedByClass)} | ${pct(r.actionedFound, r.actionableFound)} |`);
}
L.push("");

L.push(`## What every reviewer with the chance to see it missed`, "");
L.push(
  `${missedByAllCount} of ${eligibleDefects} defect(s) that at least one reviewer was eligible to catch ` +
    `(${pct(missedByAllCount, eligibleDefects)}) were live on a commit that reviewer reviewed, and none of the eligible ` +
    `reviewers found them. The denominator is eligible defects, not all audited defects: a defect nobody could have seen ` +
    `belongs in neither half of this fraction.`,
  "",
  `This rests entirely on the independent review pass, so it is the most fragile number here as well as the most useful. ` +
    `Every row must carry file-level evidence and have survived the refute pass. Defects whose recorded finder the presence ` +
    `window says was ineligible are excluded rather than listed — that is a corpus bug, not a miss.`,
  "",
);
if (missedByAll.length) {
  L.push(`| PR | Severity | Class | Reviewers with the chance | Defect |`, `|---|---|---|---:|---|`);
  for (const m of missedByAll.sort((a, b) => SEV[b.severity] - SEV[a.severity]).slice(0, 40)) {
    L.push(`| [${m.pr}](${m.url}) | ${m.severity} | ${m.class} | ${m.eligible} | ${String(m.title).replace(/\|/g, "\\|")} |`);
  }
  if (missedByAll.length > 40) L.push("", `_${missedByAll.length - 40} further defect(s) omitted from this table._`);
  L.push("");
}

L.push(`## Limits of these numbers`, "");
L.push(
  `- The audited defect set is a **lower bound**. It is the union of every reviewer's confirmed findings and an independent review of each diff. Thorough review is not exhaustive, so recall here is recall against the audited set, not against all defects that exist.`,
  `- A high-volume reviewer contributes more of the audited set, so the set partly reflects what it looks for. Report the share of the set each reviewer sole-sourced alongside these numbers.`,
  `- There is no true-negative count, so no specificity and no F1. False clears are reported directly, against their clear-verdict denominator.`,
  `- Severity is re-rated by the audit. The severity-gap column compares each reviewer against the audit, never against another vendor's published scale.`,
  `- Opportunity is computed from the commits a reviewer demonstrably reviewed. **There is no evidence source for "ran on this commit and found nothing"** — coverage is inferred from published output, so a reviewer that stays silent when it finds nothing accrues no opportunity and cannot be charged a single silent-pass miss. This inflates recall, and inflates it most for the reviewer that comments least.`,
  `- **The audited defect set is produced by an LLM reading each diff.** It is therefore shaped like what a diff-reading model can establish. Defects that need execution, load, real provider responses, or repo-wide invariants are under-represented or land as \`unverified\`. This changes the *composition* of the set, not just its size, so it can change the ranking and not merely the level.`,
  `- **Defect** here means a reachable wrong output or violated contract that the PR introduces. Missing tests, hardening with no currently-reachable exploit, dependency findings, maintainability, API design, docs, and pre-existing bugs the diff merely surfaces are **out of scope by definition** — a reviewer selling those cannot score on the benefit side while its comments still count on the cost side. Weigh those categories outside this report.`,
  `- Findings delivered as **check runs or annotations** rather than comments are invisible to the collector. A reviewer publishing that way will show zero findings and zero recall, which is a collection gap, not a result.`,
  `- Every label here is an LLM judgement (defect existence, severity, same-mechanism merging, presence window, human outcome). There is **no gold set, no repeated labelling, and therefore no inter-rater agreement or run-to-run variance estimate**. Two runs can produce different keep/cut orderings wherever confidence intervals overlap.`,
  `- The auditing model is not recorded and may share a model family with a reviewed reviewer. Self-preference in LLM-as-judge is well documented; state which model judged whenever this report is shared.`,
  `- Cost, price, and time-to-review-relative-to-merge are **not measured**. A keep/cut decision needs all three and this report supplies none of them.`,
  `- Reviewer behaviour changes as vendors ship. A long window pools several versions of each tool into one row.`,
  "",
);

if (problems.length) {
  L.push(`## Data problems`, "");
  for (const p of problems.slice(0, 50)) L.push(`- ${p}`);
  if (problems.length > 50) L.push(`- _${problems.length - 50} more_`);
  L.push("");
}

const md = L.join("\n");
if (args.out) {
  writeFileSync(args.out, md);
  process.stderr.write(`wrote ${args.out}\n`);
} else {
  process.stdout.write(md);
}

if (args.json) {
  writeFileSync(
    args.json,
    JSON.stringify(
      {
        prs: prs.length,
        allDefects,
        missedByAllCount,
        reviewers: rows.map((r) => ({
          ...r,
          prs: r.prs.size,
          commitsReviewed: r.commitsReviewed.size,
          classes: Object.fromEntries(r.classes),
          missedByClass: Object.fromEntries(r.missedByClass),
          inflation: avg(r.inflation),
          recall: r.opportunity ? r.found / r.opportunity : null,
          recallPerPrMean: avg(r.perPrRecall),
          perPrRecall: undefined,
          medianMinutesToReview: median(r.latencies),
        })),
      },
      null,
      2,
    ) + "\n",
  );
  process.stderr.write(`wrote ${args.json}\n`);
}

if (problems.length) process.stderr.write(`\n${problems.length} data problem(s) — see the report's Data problems section\n`);
