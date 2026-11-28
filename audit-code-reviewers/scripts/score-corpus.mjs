#!/usr/bin/env node
// Validate frozen evidence, then describe observed installed reviewer performance.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadManifest,
  validateObservation,
  readJson,
  requireValue,
} from "./lib/run-contract.mjs";

const SEV = { blocking: 4, major: 3, minor: 2, nit: 1 };
const SEV_ORDER = ["blocking", "major", "minor", "nit"];
const MATERIAL = new Set(["blocking", "major"]);
const LABELS = [
  "confirmed",
  "below_bar",
  "incorrect",
  "unverified",
  "drifted",
  "out_of_scope",
];
const OUTCOMES = new Set([
  "fixed",
  "fixed_claimed_not_real",
  "accepted",
  "rejected",
  "discussed",
  "none",
]);
function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: score-corpus.mjs --dir <run>/observations/prs [--manifest manifest.json] [--prices prices.json] [--engagement dir] [--out report.md] [--json totals.json]\n",
  );
  process.exit(msg ? 2 : 0);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === "--help") usage();
  else if (a === "--manifest") args.manifest = process.argv[(i += 1)];
  else if (a === "--prices") args.prices = process.argv[(i += 1)];
  else if (a === "--dir") args.dir = process.argv[(i += 1)];
  else if (a === "--out") args.out = process.argv[(i += 1)];
  else if (a === "--json") args.json = process.argv[(i += 1)];
  else if (a === "--engagement") args.engagement = process.argv[(i += 1)];
  else if (a === "--prs") args.prs = process.argv[(i += 1)];
  else usage(`unknown arg ${a}`);
}
if (!args.dir) usage("need --dir");
let context;
try {
  context = loadManifest(
    args.manifest || resolve(args.dir, "../../manifest.json"),
  );
  if (args.prs)
    requireValue(
      JSON.stringify(
        args.prs
          .split(",")
          .map(Number)
          .sort((a, b) => a - b),
      ) ===
        JSON.stringify([...context.manifest.selectedPrs].sort((a, b) => a - b)),
      "--prs differs from frozen manifest",
    );
  args.prs = context.manifest.selectedPrs.join(",");
} catch (error) {
  usage(error.message);
}
const { manifest } = context;

let files = readdirSync(args.dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
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
    args.prs
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(String),
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
    process.stderr.write(
      `error: declared PR(s) with no label file: ${missing.join(", ")}\n`,
    );
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
      byPrefix.set(
        p,
        byPrefix.has(p) && byPrefix.get(p) !== f ? "__AMBIGUOUS__" : f,
      );
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
    doc = validateObservation(
      JSON.parse(readFileSync(join(args.dir, f), "utf8")),
      f,
      context,
    );
  } catch (e) {
    fatalProblems.push(`${f}: ${e.message}`);
    continue;
  }
  if (!doc.pr) problems.push(`${f}: missing "pr"`);
  doc.defects ||= [];
  doc.instances ||= [];
  doc.reviewEvents ||= [];
  doc.reviewersByCommit ||= {};
  doc.commitOrder ||= [];

  const tag = `PR ${doc.pr ?? f}`;

  if (
    !doc.skeptic ||
    !["upheld", "revised", "rejected", "not_run"].includes(doc.skeptic.status)
  ) {
    fatalProblems.push(`${tag}: missing valid skeptic status`);
  } else if (doc.skeptic.status === "not_run") {
    fatalProblems.push(`${tag}: skeptic not run`);
  } else if (doc.skeptic.status === "rejected") {
    fatalProblems.push(
      `${tag}: skeptic rejected the observation; reconcile it and mark the rewritten result revised`,
    );
  }

  doc.commitOrder = doc.commitOrder.map((s) => String(s).toLowerCase());

  // No commit order means presence cannot be evaluated at all. Scoring the PR
  // anyway silently applies a different rule to it than to the rest of the
  // corpus, so drop it and say so.
  if (!doc.commitOrder.length) {
    problems.push(
      `${tag}: no commitOrder — PR excluded from all scoring (agent must copy \`commits\` from the raw file)`,
    );
    doc.__excluded = "no commitOrder";
    prs.push(doc);
    continue;
  }

  const resolve = shaResolver(doc.commitOrder);
  const fix = (sha, where) => {
    if (!sha) return null;
    const r = resolve(sha);
    if (r === "__AMBIGUOUS__") {
      problems.push(
        `${tag}: sha "${sha}" at ${where} is an ambiguous prefix of two commits — treated as unresolvable`,
      );
      return null;
    }
    if (!r) {
      problems.push(
        `${tag}: sha "${sha}" at ${where} is not in commitOrder (force-push, rebase, or a hand-typed sha)`,
      );
      return null;
    }
    return r;
  };

  for (const d of doc.defects) {
    const introRaw = d.introducedAt || d.commit;
    d.introducedAt = fix(introRaw, `defect ${d.id} introducedAt`);
    d.commit = fix(d.commit, `defect ${d.id} commit`) || d.introducedAt;
    const fixedRaw = d.fixedAt;
    d.fixedAt = fixedRaw ? fix(fixedRaw, `defect ${d.id} fixedAt`) : null;
    if ((fixedRaw && !d.fixedAt) || !Array.isArray(d.presentAt)) {
      d.presenceAmbiguous = true;
      problems.push(
        `${tag}: defect ${d.id} has unresolved or missing presence evidence; opportunity is not measurable`,
      );
    }
    // Unresolvable introduction point => presence is undefined. Mark it
    // ambiguous so it is excluded explicitly and counted in the report,
    // instead of evaporating.
    if (!d.introducedAt) {
      d.presenceAmbiguous = true;
      problems.push(
        `${tag}: defect ${d.id} has no resolvable introducedAt — excluded as presence-ambiguous`,
      );
    }
  }
  for (const i of doc.instances)
    i.reviewedCommit = fix(i.reviewedCommit, `instance ${i.id} reviewedCommit`);
  for (const ev of doc.reviewEvents)
    ev.reviewedCommit = fix(ev.reviewedCommit, `review event reviewedCommit`);

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
  for (const problem of fatalProblems)
    process.stderr.write(`error: ${problem}\n`);
  process.stderr.write(
    "error: scoring stopped because unreviewed negative claims cannot enter headline metrics\n",
  );
  process.exit(2);
}

// Missing engagement stays unknown. Team response supports usefulness, not truth.
const engagement = new Map();
const engagementPrs = new Set();
let agentAuthoredPrs = 0;
if (args.engagement) {
  for (const f of readdirSync(args.engagement).filter((x) =>
    x.endsWith(".json"),
  )) {
    if (!manifest.selectedPrs.some((n) => f === `${n}.json`)) continue;
    let e;
    try {
      e = JSON.parse(readFileSync(join(args.engagement, f), "utf8"));
    } catch (error) {
      usage(`engagement ${f}: ${error.message}`);
    }
    if (e.repo !== manifest.repo || f !== `${e.pr}.json`)
      usage(`engagement ${f}: repository or PR differs from manifest`);
    if (!Array.isArray(e.findings)) usage(`engagement ${f}: missing findings`);
    const doc = prs.find((p) => p.pr === e.pr);
    const authorIsBot =
      doc.authorType === "Bot"
        ? true
        : doc.authorType === "User"
          ? false
          : null;
    if (
      authorIsBot !== null &&
      e.authorIsBot != null &&
      e.authorIsBot !== authorIsBot
    )
      usage(`engagement ${f}: author type differs from frozen source`);
    engagementPrs.add(`${e.repo}|${e.pr}`);
    if (authorIsBot) agentAuthoredPrs += 1;
    for (const x of e.findings || []) {
      const instance = doc.instances.find((i) => i.id === x.instanceId);
      if (
        !instance ||
        instance.duplicateOf ||
        context.aliases.get(String(x.reviewer).toLowerCase()) !==
          instance.reviewer
      )
        usage(`engagement ${f}: invalid finding ${x.instanceId}`);
      if (!OUTCOMES.has(x.outcome) || !x.evidence)
        usage(
          `engagement ${f}: outcome and evidence required for ${x.instanceId}`,
        );
      // Keyed by repo as well as PR: two repos audited into one directory with
      // overlapping PR numbers would otherwise attach human outcomes to the
      // wrong findings, silently.
      const key = `${e.repo || ""}|${e.pr}|${x.instanceId}`;
      if (engagement.has(key)) {
        usage(`engagement: duplicate entry for ${key}`);
      }
      engagement.set(key, { ...x, authorIsBot });
    }
  }
}

// Keep diagnostic candidates in the evidence appendix, outside delivered metrics.
// Validate their sources and engagement first so this cannot hide malformed evidence.
const filteredCandidates = prs.flatMap((doc) =>
  doc.instances.filter((i) => i.delivery === "filtered_candidate").map((i) => ({ ...i, pr: doc.pr })),
);
for (const doc of prs) doc.instances = doc.instances.filter((i) => i.delivery !== "filtered_candidate");

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
      eng: {
        n: 0,
        fixed: 0,
        accepted: 0,
        rejected: 0,
        discussed: 0,
        none: 0,
        falseFix: 0,
        humanWords: 0,
        userAccountN: 0,
        userAccountFixed: 0,
        userAccountRejected: 0,
        noiseN: 0,
        noiseFixed: 0,
        realN: 0,
        realFixed: 0,
        userAccountConfirmed: 0,
        userAccountConfirmedFixed: 0,
        realFixedWithWords: 0,
        realFixedSilent: 0,
      },
      firstLook: { opp: 0, found: 0 },
      // Scored only on defects every compared reviewer was eligible to catch.
      commonOpp: 0,
      commonFound: 0,
      commonUnique: 0,
      commonOppBySev: Object.fromEntries(SEV_ORDER.map((s) => [s, 0])),
      commonFoundBySev: Object.fromEntries(SEV_ORDER.map((s) => [s, 0])),
      pairFound: new Map(),
      pairOpp: new Map(),
      pairBoth: new Map(),
      pairOnlyA: new Map(),
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

  // Presence comes from code inspected at each reviewed commit, never date order.
  const out = new Set(d.presenceAmbiguous ? [] : d.presentAt || []);
  perDoc.set(key, out);
  return out;
}

const scorable = (doc) => !doc.__excluded;
for (const reviewer of manifest.reviewers) R(reviewer.id);

// ---- precision, profile, latency: every PR the reviewer touched -------------

for (const doc of prs) {
  if (!scorable(doc)) continue;
  const seen = new Set();
  for (const ev of doc.reviewEvents) {
    seen.add(ev.reviewer);
    const r = R(ev.reviewer);
    r.reviewEvents += 1;
    if (typeof ev.minutesToReview === "number" && ev.minutesToReview >= 0)
      r.latencies.push(ev.minutesToReview);
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
    if (!LABELS.includes(inst.label))
      problems.push(`PR ${doc.pr} ${inst.id}: unknown label ${inst.label}`);
    r.labels[label] += 1;
    if (label !== "confirmed") continue;

    if (inst.runtimeVerified) r.runtimeVerified += 1;
    const sev = SEV[inst.auditedSeverity] ? inst.auditedSeverity : null;
    if (sev) r.sevAudited[sev] += 1;
    else
      problems.push(
        `PR ${doc.pr} ${inst.id}: confirmed with no audited severity`,
      );
    if (sev && SEV[inst.claimedSeverity]) {
      r.inflation.push(SEV[inst.claimedSeverity] - SEV[sev]);
      r.claimedSeverityKnown += 1;
    }
    const cls = inst.class || "unclassified";
    r.classes.set(cls, (r.classes.get(cls) || 0) + 1);
  }

  // engagement is recorded against every non-duplicate instance, whatever its label
  const engRan = engagementPrs.has(`${doc.repo}|${doc.pr}`);
  for (const inst of doc.instances) {
    if (inst.duplicateOf) continue;
    const e =
      engagement.get(`${doc.repo || ""}|${doc.pr}|${inst.id}`) ||
      engagement.get(`${doc.pr}|${inst.id}`);
    const r = R(inst.reviewer);
    if (!e || !OUTCOMES.has(e.outcome)) {
      r.engMissing += 1;
      if (engRan)
        problems.push(`PR ${doc.pr} ${inst.id}: engagement is unknown`);
      continue;
    }
    const o = e.outcome;
    const g = r.eng;
    g.n += 1;
    if (o.startsWith("fixed_claimed")) g.falseFix += 1;
    else if (o === "fixed") g.fixed += 1;
    else if (o === "accepted") g.accepted += 1;
    else if (o === "rejected") g.rejected += 1;
    else if (o === "discussed") g.discussed += 1;
    else g.none += 1;
    if (e && e.humanWords) g.humanWords += 1;
    // User accounts can run automation; account type does not prove authorship.
    const userAccountAuthored = e.authorIsBot === false;
    if (userAccountAuthored) {
      g.userAccountN += 1;
      if (o === "fixed") g.userAccountFixed += 1;
      if (o === "rejected") g.userAccountRejected += 1;
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
      if (userAccountAuthored) {
        g.userAccountConfirmed += 1;
        if (o === "fixed") g.userAccountConfirmedFixed += 1;
      }
    } else if (lbl === "below_bar" || lbl === "incorrect") {
      g.noiseN += 1;
      if (o === "fixed") g.noiseFixed += 1;
    }
  }

  for (const login of seen) R(login).prs.add(`${doc.repo || ""}#${doc.pr}`);
}

// ---- opportunity-adjusted coverage -----------------------------------------

// Shared observed opportunities remain a description of the installed tools.
// Extra attempts and different commits still affect catches. This is not a ranking.
const rosterLogins = manifest.reviewers.map((r) => r.id);
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
    for (const sha of present)
      for (const login of doc.reviewersByCommit[sha] || [])
        hadChance.add(login);

    const claimed = d.foundBy || [];
    const found = claimed.filter((x) => hadChance.has(x));
    if (!SEV[d.severity])
      problems.push(
        `PR ${doc.pr} defect ${d.id}: unknown severity "${d.severity}" — treated as minor`,
      );
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
    const isCommon =
      rosterLogins.length > 0 && rosterLogins.every((l) => hadChance.has(l));
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
        missedByAll.push({
          pr: doc.pr,
          title: d.title,
          severity: sev,
          class: cls,
          url: doc.url,
          eligible: hadChance.size,
        });
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

  for (const [login, v] of perPr)
    if (v.opp > 0) R(login).perPrRecall.push(v.found / v.opp);

  // Credit only the identified first publication event, including repeat runs at one SHA.
  for (const login of rosterLogins) {
    const events = doc.reviewEvents
      .filter((e) => e.reviewer === login)
      .sort((a, b) =>
        String(a.submittedAt).localeCompare(String(b.submittedAt)),
      );
    const first = events[0];
    if (!first?.reviewedCommit || !first.submittedAt || first.editedInPlace)
      continue;
    if (events.length > 1 && events[1].submittedAt === first.submittedAt)
      continue;
    for (const d of doc.defects) {
      if (
        d.preExisting ||
        d.presenceAmbiguous ||
        !presenceSet(doc, d).has(first.reviewedCommit)
      )
        continue;
      const claims = doc.instances.filter(
        (i) =>
          i.label === "confirmed" &&
          i.defectId === d.id &&
          i.reviewer === login &&
          !i.duplicateOf,
      );
      if (claims.some((i) => i.reviewEventId == null)) continue;
      R(login).firstLook.opp += 1;
      if (claims.some((i) => String(i.reviewEventId) === String(first.id)))
        R(login).firstLook.found += 1;
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
    for (const sha of present)
      for (const login of doc.reviewersByCommit[sha] || []) had.add(login);
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
        if (foundSet.has(a) && foundSet.has(b))
          r.pairFound.set(b, (r.pairFound.get(b) || 0) + 1);
        if (foundSet.has(a) && !foundSet.has(b))
          r.pairOnlyA.set(b, (r.pairOnlyA.get(b) || 0) + 1);
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
    doc.instances
      .filter((i) => i.label === "confirmed" && i.defectId)
      .map((i) => i.defectId),
  );
  for (const ev of doc.reviewEvents) {
    if (ev.verdict !== "clear" || !ev.reviewedCommit) continue;
    const live = doc.defects.filter((d) => {
      if (d.preExisting || d.presenceAmbiguous) return false;
      if (!SEV[d.severity] || SEV[d.severity] < SEV.minor) return false;
      // Established by a reviewer other than the one being charged.
      const byOther =
        corroborated.has(d.id) &&
        (d.foundBy || []).some((x) => x !== ev.reviewer);
      if (!byOther) return false;
      return presenceSet(doc, d).has(ev.reviewedCommit);
    });
    if (live.length) R(ev.reviewer).falseClears += 1;
  }
}

// The report has no vendor rank. The customer can inspect the evidence for each action.
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const average = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const rows = [...reviewers.values()].sort((a, b) =>
  a.login.localeCompare(b.login),
);
const definitions = new Map(manifest.reviewers.map((r) => [r.id, r]));
const defects = prs.flatMap((doc) =>
  doc.defects.map((d) => ({
    ...d,
    pr: doc.pr,
    prUrl: doc.url,
    claims: doc.instances
      .filter(
        (i) => i.label === "confirmed" && !i.duplicateOf && i.defectId === d.id,
      )
      .map((i) => ({
        reviewer: i.reviewer,
        url: i.url,
        evidence: i.evidence,
        reviewedCommit: i.reviewedCommit,
      })),
  })),
);
let prices = null;
if (args.prices) {
  try {
    prices = readJson(args.prices);
    requireValue(
      /^[A-Z]{3}$/.test(prices.currency) && Array.isArray(prices.reviewers),
      "Prices require a currency and reviewers array",
    );
    const seen = new Set();
    for (const price of prices.reviewers) {
      requireValue(
        definitions.has(price.reviewer) && !seen.has(price.reviewer),
        "Price has an unknown or duplicate reviewer",
      );
      seen.add(price.reviewer);
      requireValue(
        Number.isFinite(price.monthlyCost) &&
          price.monthlyCost >= 0 &&
          price.source,
        "Price requires a nonnegative monthly cost and customer source",
      );
      if (price.avoidableMonthlyCost != null)
        requireValue(
          Number.isFinite(price.avoidableMonthlyCost) &&
            price.avoidableMonthlyCost >= 0 &&
            price.avoidableMonthlyCost <= price.monthlyCost,
          "Avoidable monthly cost must be between zero and the current monthly cost",
        );
    }
  } catch (error) {
    usage(error.message);
  }
}
const savings = rows.map((r) => {
  const price = prices?.reviewers.find((p) => p.reviewer === r.login);
  return {
    reviewer: r.login,
    currency: prices?.currency ?? null,
    monthlyCost: price?.monthlyCost ?? null,
    conditionalMonthlySavings: price?.avoidableMonthlyCost ?? null,
    conditionalAnnualSavings:
      price?.avoidableMonthlyCost == null
        ? null
        : Math.round(price.avoidableMonthlyCost * 1200) / 100,
    uniqueCatchesAtRisk:
      definitions.get(r.login).state === "observed"
        ? defects.filter(
            (d) =>
              !d.preExisting &&
              d.foundBy.length === 1 &&
              d.foundBy[0] === r.login,
          ).length
        : null,
    source: price?.source ?? null,
    assumptions:
      "Requires cancellation or a plan change that removes this charge. Other reviewer bills stay the same. Future defect loss is unknown.",
  };
});
const decisions = rows.map((r) => {
  const state = definitions.get(r.login).state;
  const unique = savings.find(
    (s) => s.reviewer === r.login,
  ).uniqueCatchesAtRisk;
  let action = "undecided",
    reason = "This sample does not establish a keep or cut decision.";
  if (state !== "observed")
    reason = "Collect the missing delivery surface before a decision.";
  else if (unique > 0) {
    action = "keep";
    reason = `${unique} verified defect(s) had no other observed finder in this audit.`;
  } else if (r.found > 0) {
    action = "inspect overlap";
    reason =
      "Other reviewers also found the verified catches. Inspect coverage and excluded categories before a trial change.";
  } else if (r.labels.incorrect + r.labels.below_bar > 0) {
    action = "change configuration";
    reason =
      "Inspect the linked incorrect and below-bar claims. This sample does not prove zero future value.";
  }
  return {
    reviewer: r.login,
    action,
    reason,
    basis: "observed installed performance",
    scope:
      manifest.mode === "sample"
        ? "selected PRs only"
        : "declared population only",
  };
});
const aggregate = {
  schemaVersion: "reviewer-audit-result-v3",
  runId: manifest.runId,
  repo: manifest.repo,
  rankingAllowed: false,
  mode: manifest.mode,
  prs: prs.length,
  allDefects,
  missedByAllCount,
  commonSetSize,
  ambiguousSkipped,
  excludedPrs: prs.filter((p) => p.__excluded).map((p) => p.pr),
  manifest,
  problems,
  evaluations: prs.map((doc) => ({
    pr: doc.pr,
    coldReview: doc.coldReview,
    coldDispositions: doc.coldDispositions || [],
    skeptic: doc.skeptic,
    notes: doc.evaluationNotes || [],
  })),
  defects,
  filteredCandidates,
  decisions,
  savings,
  reviewers: rows.map((r) => ({
    ...r,
    state: definitions.get(r.login).state,
    installedFound: defects.filter(
      (d) => !d.preExisting && d.foundBy.includes(r.login),
    ).length,
    prs: r.prs.size,
    commitsReviewed: r.commitsReviewed.size,
    classes: Object.fromEntries(r.classes),
    missedByClass: Object.fromEntries(r.missedByClass),
    pairFound: Object.fromEntries(r.pairFound),
    pairOpp: Object.fromEntries(r.pairOpp),
    pairBoth: Object.fromEntries(r.pairBoth),
    pairOnlyA: Object.fromEntries(r.pairOnlyA),
    inflation: average(r.inflation),
    recall: r.opportunity ? r.found / r.opportunity : null,
    recallPerPrMean: average(r.perPrRecall),
    perPrRecall: undefined,
    medianMinutesToReview: median(r.latencies),
  })),
};
const cell = (x) =>
  String(x ?? "unknown")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const link = (title, url) =>
  /^https:\/\//.test(url || "")
    ? `[${cell(title).replaceAll("[", "\\[").replaceAll("]", "\\]")}](${url.replaceAll(")", "%29")})`
    : cell(title);
const ratio = (n, d) =>
  d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "not measurable";
const L = [
  "# Your code review audit",
  "",
  "## Suggested actions",
  "",
  "These actions describe the selected history. They do not establish future savings or a general vendor rank.",
  "",
  "| Reviewer | Action | Evidence basis |",
  "|---|---|---|",
];
if (manifest.evidenceKind === "synthetic")
  L.splice(
    2,
    0,
    "**Synthetic example. Counts, prices and links demonstrate the workflow. They are not customer evidence.**",
    "",
  );
for (const d of decisions)
  L.push(`| ${cell(d.reviewer)} | ${d.action} | ${cell(d.reason)} |`);
L.push(
  "",
  "## What this audit covers",
  "",
  `Repository: ${cell(manifest.repo)}. Run: ${cell(manifest.runId)}. Mode: ${manifest.mode}.`,
  "",
  `${manifest.selectedPrs.length} selected PR(s) from ${manifest.populationPrs.length} declared PR(s). ${cell((manifest.sample?.rule || "Complete declared population").replace(/\.$/, ""))}.`,
  "",
  `Scope: ${cell(manifest.scope.replace(/\.$/, ""))}. Evaluator: ${cell(manifest.evaluator.provider)} / ${cell(manifest.evaluator.model)}. Method: ${manifest.methodVersion}.`,
  "",
  manifest.window.field === "explicit_prs"
    ? "Selection: explicit PRs. Review history is not restricted to a date window."
    : `Window field: ${cell(manifest.window.field)}. Window: ${cell(manifest.window.from)} to ${cell(manifest.window.toExclusive)} (exclusive).`,
  "",
  "The frozen manifest records the roster, exclusions and source hashes. An unsupported delivery surface stays not measurable.",
  "",
  "| Reviewer | Collection state | Inclusion reason |",
  "|---|---|---|",
);
for (const r of manifest.reviewers)
  L.push(`| ${cell(r.id)} | ${r.state} | ${cell(r.reason)} |`);
for (const warning of [...(manifest.collectorWarnings || []), ...corpusNote])
  L.push("", `Collection note: ${cell(warning)}`);
for (const exclusion of [
  ...(manifest.excludedPrs || []),
  ...(manifest.excludedIdentities || []),
])
  L.push("", `Excluded: ${cell(JSON.stringify(exclusion))}`);
L.push(
  "",
  "## Evaluation checks",
  "",
  "| PR | Blind code review | Independent check | Limit |",
  "|---|---|---|---|",
);
for (const e of aggregate.evaluations) {
  L.push(
    `| #${e.pr} | ${cell(e.coldReview.state)} | ${cell(e.skeptic.status)} by ${cell(e.skeptic.evaluator)} | ${cell(e.coldReview.reason || "Bounded inspection; not exhaustive defect discovery")} |`,
  );
  for (const d of e.coldDispositions)
    L.push(
      "",
      `Cold finding ${cell(d.coldDefectId)} on #${e.pr}: ${cell(d.state)}. ${cell(d.evidence)}`,
    );
}
L.push(
  "",
  "## Observed catches, noise and coverage",
  "",
  "Repeat reviews can add catches. These totals measure the installed configuration, including extra attempts.",
  "",
  "| Reviewer | PRs with output | Published events | Verified defects | Unique catches | Incorrect claims | Below bar | Out of scope | Unverified |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
);
for (const r of rows) {
  const counts =
    definitions.get(r.login).state === "observed"
      ? [
          r.prs.size,
          r.reviewEvents,
          aggregate.reviewers.find((x) => x.login === r.login).installedFound,
          savings.find((x) => x.reviewer === r.login).uniqueCatchesAtRisk,
          r.labels.incorrect,
          r.labels.below_bar,
          r.labels.out_of_scope,
          r.labels.unverified,
        ]
      : Array(8).fill("not measurable");
  L.push(`| ${cell(r.login)} | ${counts.join(" | ")} |`);
}
L.push(
  "",
  "Publication events are not review-run counts. One run can publish several events, and one edited summary can represent several runs.",
  "",
  "## Opportunities with exact code evidence",
  "",
  "The defect set is a lower bound. Unknown runs and unknown defect presence cannot count as misses.",
  "",
  "| Reviewer | Caught / observed opportunities | First identified event | Common set catches |",
  "|---|---|---|---|",
);
for (const r of rows)
  L.push(
    `| ${cell(r.login)} | ${ratio(r.found, r.opportunity)} | ${ratio(r.firstLook.found, r.firstLook.opp)} | ${ratio(r.commonFound, r.commonOpp)} |`,
  );
L.push(
  "",
  "The common set still includes different commits and attempt counts. It cannot establish a quality ranking.",
  "",
  `${ambiguousSkipped} defect(s) have ambiguous or unresolved presence evidence.`,
  "",
  "## Overlap on shared reviewed commits",
  "",
  "| Reviewer A | Reviewer B | Both eligible | A caught | Both caught | Only A caught |",
  "|---|---|---:|---:|---:|---:|",
);
for (const a of rows)
  for (const b of rows)
    if (a.login !== b.login) {
      const n = a.pairBoth.get(b.login) || 0;
      L.push(
        `| ${cell(a.login)} | ${cell(b.login)} | ${n || "not measurable"} | ${n ? a.pairOpp.get(b.login) || 0 : "not measurable"} | ${n ? a.pairFound.get(b.login) || 0 : "not measurable"} | ${n ? a.pairOnlyA.get(b.login) || 0 : "not measurable"} |`,
      );
    }
L.push(
  "",
  "## Spend and conditional savings",
  "",
  "Prices come from the customer. Avoidable charges require a cancellation or plan change. Audit costs are not included.",
  "",
  "| Reviewer | Current monthly cost | Conditional monthly savings | Conditional annual savings | Unique catches at risk | Source |",
  "|---|---:|---:|---:|---:|---|",
);
const money = (n) =>
  n == null ? "unknown" : `${prices.currency} ${n.toFixed(2)}`;
for (const s of savings)
  L.push(
    `| ${cell(s.reviewer)} | ${money(s.monthlyCost)} | ${money(s.conditionalMonthlySavings)} | ${money(s.conditionalAnnualSavings)} | ${cell(s.uniqueCatchesAtRisk)} | ${cell(s.source)} |`,
  );
L.push(
  "",
  "Unique catches are historical evidence at risk. They do not predict bugs after a reviewer is removed.",
  "",
  "## Evidence behind the counts",
  "",
);
for (const d of defects) {
  L.push(
    `### ${cell(d.title)}`,
    "",
    `${link(`PR #${d.pr}`, d.prUrl)}. Severity: ${cell(d.severity)}. Finder(s): ${cell(d.foundBy.join(", ") || "audit only")}.`,
    "",
    `${link("Code evidence", d.evidenceUrl)}: ${cell(d.evidence)}`,
    "",
  );
  for (const c of d.claims)
    L.push(
      `- ${link(c.reviewer, c.url)} at ${cell(c.reviewedCommit)}: ${cell(c.evidence)}`,
    );
  L.push("");
}
if (!defects.length)
  L.push(
    "No verified defects in this audit. This does not prove that the PRs have no defects.",
    "",
  );
if (filteredCandidates.length) {
  L.push("### Filtered candidates", "",
    "Filtered candidates are not posted findings. They do not count toward catches, noise, overlap, or team response.", "",
    "| Reviewer | Label | Candidate | Evidence |", "|---|---|---|---|");
  for (const i of filteredCandidates)
    L.push(`| ${cell(i.reviewer)} | ${cell(i.label)} | ${link(i.id, i.url)} | ${cell(i.evidence)} |`);
  L.push("");
}
L.push(
  "### Other claims",
  "",
  "| Reviewer | Label | Claim | Evidence |",
  "|---|---|---|---|",
);
for (const doc of prs)
  for (const i of doc.instances)
    if (i.label !== "confirmed")
      L.push(
        `| ${cell(i.reviewer)} | ${cell(i.label)} | ${link(i.id, i.url)} | ${cell(i.evidence)} |`,
      );
L.push(
  "",
  "## Team response",
  "",
  "| Reviewer | Observed responses | Verified fixes | No observed response | Unknown response |",
  "|---|---:|---:|---:|---:|",
);
for (const r of rows)
  L.push(
    `| ${cell(r.login)} | ${r.eng.n} | ${r.eng.fixed} | ${r.eng.none} | ${r.engMissing} |`,
  );
L.push(
  "",
  "Team response supports usefulness. It does not determine correctness. GitHub User accounts can run automation; account type does not establish human authorship or approval.",
  "",
  "## Limits",
  "",
  "- The evaluator can make errors. A skeptic pass does not measure independent agreement or accuracy.",
  "- The audited set excludes valuable advice outside the declared defect scope. Out-of-scope advice is not an incorrect claim.",
  "- A missing publication does not prove that a reviewer skipped a PR or found no defects.",
  "- This audit does not prove that a review prevented a production bug.",
  "- Precision uses claims and opportunity coverage uses defects. This report does not combine those units into F1.",
  "- Runtime, model cost and future defect loss are not measured by this scorer.",
  "- Results apply to the declared history and configuration. A convenience sample does not support a repository-wide cut decision.",
  "",
);
if (problems.length)
  L.push("## Data problems", "", ...problems.map((p) => `- ${cell(p)}`), "");
const markdown = L.join("\n");
if (args.out) writeFileSync(args.out, markdown);
else process.stdout.write(markdown);
if (args.json)
  writeFileSync(args.json, JSON.stringify(aggregate, null, 2) + "\n");
process.stderr.write(
  `Scored ${prs.length} PR(s), ${rows.length} reviewer(s), ${problems.length} data problem(s). No quality ranking.\n`,
);
