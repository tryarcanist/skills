#!/usr/bin/env node
// Discover every AI reviewer active on a repo and every PR worth auditing.
//
// How the corpus is actually built (three passes, in this order):
//
//   1. Two repo-wide paginated comment feeds (pulls/comments, issues/comments)
//      give candidate PR numbers cheaply. One call per PR up front would be
//      hundreds of requests before we know which PRs even matter.
//   2. A sweep of PRs updated inside the window (pulls?state=all&sort=updated)
//      catches what the feeds structurally cannot: a reviewer that publishes
//      only as a review body (APPROVE / REQUEST_CHANGES with a body and no
//      inline comment) on a PR no other bot touched, and PRs where every
//      reviewer was clear. Without the sweep the corpus is only ever PRs that
//      already had a bot comment, which biases defect density upward. The sweep
//      costs one reviews call per swept PR, so it is capped by --max-sweep.
//   3. One metadata call per candidate PR, which is also what proves a
//      candidate is a pull request at all. The repo-wide issues/comments feed
//      mixes real issues in with PRs and carries no `pull_request` key to tell
//      them apart, so real issues are only dropped here.
//
// Reviewer identity comes from GitHub's own account type rather than a
// hardcoded vendor list, so a reviewer nobody mentioned still shows up in the
// roster. --bots is a FULL-MATCH regex against the login: it is anchored, so
// --bots "ai" matches the login "ai" and not the human "aidan".
//
// The roster is rebuilt from the PRs that survive every filter, so roster
// counts and totals.prs always agree. Everything dropped along the way is
// reported in the corpus itself (excluded[], warnings[]), never only on stderr,
// because the operator reads the roster to choose --only and reads the report,
// not the terminal scrollback.
//
// Window semantics: the API `since` parameter filters on updated_at, but
// membership in the corpus is decided on created_at (a comment's real review
// event time). Comments that are fetched by `since` and then dropped by the
// created_at test are counted in totals.windowDrops so the report can say so.
// The corpus records windowAppliedTo for the same reason.
//
// Latency: minutesToFirstComment measures from when the PR became reviewable,
// not from created_at, so a PR opened as a draft and readied a week later does
// not report a week of reviewer latency. That costs one timeline call per PR;
// pass --no-ready-timeline to skip it, in which case latencyBasis is
// "created_at", wasDraft is only known for still-draft PRs, and a warning says
// so.
//
// Usage:
// Run it once bare to see the roster, then re-run with --only once you know
// which logins are reviewers: the first pass always picks up bots that post
// status rather than findings (merge queues, issue trackers, CI), and counting
// those as reviewers wrecks every denominator.
//
// Usage:
//   collect-review-corpus.mjs --repo owner/repo --since "90 days ago" \
//     [--until <when>] [--bots <full-match regex>] [--only "a,b"] \
//     [--exclude-authors "a,b"] [--max-sweep 300] [--no-ready-timeline] [--out corpus.json]

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const DEFAULT_MAX_SWEEP = 300;
const GH_ATTEMPTS = 3;
const GH_BACKOFF_MS = [2000, 4000, 8000];

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: collect-review-corpus.mjs --repo owner/repo [--since T] [--until T] [--bots regex] [--only csv] [--exclude-authors csv] [--max-sweep n] [--no-ready-timeline] [--out file]\n" +
      "  T: \"90 days ago\" | \"6 hours ago\" | \"now\" | ISO date | epoch\n" +
      "  --bots: FULL-MATCH regex on the login (anchored). \"ai\" matches \"ai\", not \"aidan\"; use \".*ai.*\" for substring.\n" +
      `  --max-sweep: cap on PRs swept for review-only reviewers (default ${DEFAULT_MAX_SWEEP})\n`,
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[(i += 1)];
    else if (a === "--since") out.since = argv[(i += 1)];
    else if (a === "--until") out.until = argv[(i += 1)];
    else if (a === "--bots") out.bots = argv[(i += 1)];
    else if (a === "--only") out.only = argv[(i += 1)];
    else if (a === "--exclude-authors") out.excludeAuthors = argv[(i += 1)];
    else if (a === "--max-sweep") out.maxSweep = argv[(i += 1)];
    else if (a === "--no-ready-timeline") out.noReadyTimeline = true;
    else if (a === "--out") out.out = argv[(i += 1)];
    else usage(`unknown arg ${a}`);
  }
  return out;
}

// Accept "90 days ago", "now", ISO, or epoch. Returns an ISO string or null.
// Months are real calendar months (setUTCMonth), not a 30-day approximation:
// "3 months ago" on a 31-day run was silently short by three days, which drops
// whole PRs off the front of the window.
function toIso(s) {
  if (!s) return null;
  const t = s.trim();
  const rel = /^(\d+)\s+(hour|day|week|month)s?\s+ago$/i.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    if (unit === "month") {
      const d = new Date();
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - n);
      // Clamp Mar 31 -> Feb 28/29 rather than rolling into the next month.
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay));
      return d.toISOString();
    }
    const ms = { hour: 3600000, day: 86400000, week: 7 * 86400000 }[unit];
    return new Date(Date.now() - n * ms).toISOString();
  }
  if (/^now$/i.test(t)) return new Date().toISOString();
  const d = new Date(/^\d+$/.test(t) ? Number(t) * (t.length <= 10 ? 1000 : 1) : t);
  if (Number.isNaN(d.getTime())) usage(`cannot read a time from ${s}`);
  return d.toISOString();
}

// Every degradation lands here and is emitted in the corpus. stderr alone never
// reaches the report, and a silently-degraded corpus reads as a clean one.
const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  process.stderr.write(`warning: ${msg}\n`);
};

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const errText = (e) => (e?.stderr || e?.message || "").toString();
// A 404/410 is a fact about the resource, not a transient failure; retrying it
// just burns rate limit that the paginated feeds need.
const isPermanent = (detail) => /HTTP (?:404|410)|Not Found|Gone/i.test(detail);

// Runs `gh api` with 3 attempts and 2s/4s/8s backoff. Repo-wide paginated feeds
// over a 90-day window reliably hit secondary rate limits; a single unretried
// failure here empties the roster.
function ghRaw(ghArgs, { label, maxBuffer = 64 * 1024 * 1024 } = {}) {
  let lastDetail = "";
  for (let attempt = 0; attempt < GH_ATTEMPTS; attempt += 1) {
    try {
      return { ok: true, raw: execFileSync("gh", ghArgs, { encoding: "utf8", maxBuffer }) };
    } catch (e) {
      lastDetail = errText(e).slice(0, 300).trim();
      if (isPermanent(lastDetail)) return { ok: false, detail: lastDetail, permanent: true };
      if (attempt < GH_ATTEMPTS - 1) {
        const waitMs = GH_BACKOFF_MS[attempt];
        process.stderr.write(`retrying ${label} in ${waitMs}ms after: ${lastDetail}\n`);
        sleepSync(waitMs);
      }
    }
  }
  return { ok: false, detail: lastDetail, permanent: false };
}

// Returns { ok, items }. ok=false means the call or the parse failed after
// retries; callers decide whether that is fatal. A non-array 200 body counts as
// a failure rather than an empty result, because "no data" and "shape we did
// not expect" bias the corpus in opposite directions.
function ghJson(path, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  const res = ghRaw(["api", path, "--paginate", "--slurp"], { label: `gh api ${path}`, maxBuffer });
  if (!res.ok) {
    warn(`gh api ${path} failed after ${GH_ATTEMPTS} attempt(s): ${res.detail}`);
    return { ok: false, items: [] };
  }
  const raw = res.raw.trim();
  if (!raw) return { ok: true, items: [] };
  let pages;
  try {
    pages = JSON.parse(raw);
  } catch {
    warn(`could not parse gh output for ${path} (${raw.length} byte(s))`);
    return { ok: false, items: [] };
  }
  if (!Array.isArray(pages)) {
    warn(`gh api ${path} returned a non-array body; treating as a failed fetch`);
    return { ok: false, items: [] };
  }
  return { ok: true, items: pages.flat() };
}

// One page, no --paginate: the sweep must stop reading pages as soon as
// updated_at falls before `since`, which --paginate cannot do.
function ghPage(path) {
  const res = ghRaw(["api", path], { label: `gh api ${path}`, maxBuffer: 64 * 1024 * 1024 });
  if (!res.ok) {
    warn(`gh api ${path} failed after ${GH_ATTEMPTS} attempt(s): ${res.detail}`);
    return { ok: false, items: [] };
  }
  const raw = res.raw.trim();
  if (!raw) return { ok: true, items: [] };
  try {
    const body = JSON.parse(raw);
    if (!Array.isArray(body)) {
      warn(`gh api ${path} returned a non-array body; treating as a failed fetch`);
      return { ok: false, items: [] };
    }
    return { ok: true, items: body };
  } catch {
    warn(`could not parse gh output for ${path}`);
    return { ok: false, items: [] };
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.repo || !/^[^/\s]+\/[^/\s]+$/.test(args.repo)) usage("need --repo owner/repo");
const since = toIso(args.since || "90 days ago");
const until = toIso(args.until);
const maxSweep = args.maxSweep === undefined ? DEFAULT_MAX_SWEEP : Number(args.maxSweep);
if (!Number.isFinite(maxSweep) || maxSweep < 0) usage(`--max-sweep must be a non-negative number, got ${args.maxSweep}`);
const readyTimeline = !args.noReadyTimeline;

// Anchored: --bots is full-match on the login. An unanchored "ai" matched the
// human login "aidan", which both fabricated finding instances for that human
// and removed them from human-evidence capture downstream.
let extraBotRe = null;
if (args.bots) {
  try {
    extraBotRe = new RegExp(`^(?:${args.bots})$`, "i");
  } catch (e) {
    usage(`--bots is not a valid regex: ${errText(e).slice(0, 160)}`);
  }
}
const excludedAuthors = new Set(
  (args.excludeAuthors || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// GitHub marks App accounts as type "Bot"; the "[bot]" suffix is the fallback
// for accounts the API reports as User (some reviewers post via a PAT).
const only = (args.only || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const detected = (u) =>
  u?.type === "Bot" || /\[bot\]$/i.test(u?.login || "") || (extraBotRe ? extraBotRe.test(u?.login || "") : false);
const isBot = (u) => {
  const login = (u?.login || "").toLowerCase();
  if (only.length) return only.includes(login);
  return detected(u);
};

const inWindow = (iso) => {
  if (!iso) return false;
  if (iso < since) return false;
  if (until && iso > until) return false;
  return true;
};

const prNumFromUrl = (url) => {
  const m = /\/(?:pulls|issues)\/(\d+)(?:$|[^0-9])/.exec(url || "");
  return m ? Number(m[1]) : null;
};

process.stderr.write(`scanning ${args.repo} since ${since}${until ? ` until ${until}` : ""}\n`);

// Everything dropped, with the reason, so the report can print it.
const excluded = [];
const drop = (number, reason, author = null) => excluded.push({ number, reason, author });

const q = `since=${encodeURIComponent(since)}&per_page=100`;
const reviewCommentsRes = ghJson(`repos/${args.repo}/pulls/comments?${q}&sort=created&direction=asc`);
const issueCommentsRes = ghJson(`repos/${args.repo}/issues/comments?${q}&sort=created&direction=asc`);

// A repo-wide feed that failed entirely empties the roster while everything
// downstream still looks healthy. Fail loudly instead of writing a corpus that
// reads as "this repo has no reviewers".
if (!reviewCommentsRes.ok || !issueCommentsRes.ok) {
  process.stderr.write(
    `fatal: a repo-wide comment feed failed (pulls/comments ok=${reviewCommentsRes.ok}, issues/comments ok=${issueCommentsRes.ok}); ` +
      "the corpus would be silently empty. Not writing output.\n",
  );
  process.exit(1);
}
const reviewComments = reviewCommentsRes.items;
const issueComments = issueCommentsRes.items;

process.stderr.write(`fetched ${reviewComments.length} review comment(s), ${issueComments.length} issue comment(s)\n`);

// prNumber -> { botLogin -> {inline, summary, first} }
const prs = new Map();
// Provenance per candidate: did it come from a comment feed, or only the sweep?
const source = new Map();

function note(prNumber, login, kind, createdAt) {
  if (!prs.has(prNumber)) prs.set(prNumber, new Map());
  const byBot = prs.get(prNumber);
  if (!byBot.has(login)) byBot.set(login, { inline: 0, summary: 0, first: createdAt });
  const rec = byBot.get(login);
  rec[kind] += 1;
  if (createdAt && (!rec.first || createdAt < rec.first)) rec.first = createdAt;
}

// `since` filters on updated_at; membership is decided on created_at. An
// edited-but-old comment is therefore fetched and then dropped. Count those:
// the drop is not neutral, it removes a reviewer's earliest comment on a PR,
// which biases minutesToFirstComment upward for reviewers that comment at open.
const windowDrops = { reviewComments: 0, issueComments: 0 };

for (const c of reviewComments) {
  if (!isBot(c.user)) continue;
  if (!inWindow(c.created_at)) {
    windowDrops.reviewComments += 1;
    continue;
  }
  const n = prNumFromUrl(c.pull_request_url);
  if (n) {
    note(n, c.user.login, "inline", c.created_at);
    source.set(n, "comment");
  }
}
for (const c of issueComments) {
  // issues/comments mixes real issues in with PRs, and this feed carries no
  // `pull_request` key to separate them (the per-issue endpoint does). The old
  // /\/issues\/\d+$/ test matched real issues just as happily, so real issues
  // became roster rows with inflated prsCommentedOn — in the exact table the
  // operator reads to pick --only. Candidacy is provisional here; the
  // repos/{repo}/pulls/{n} call below is what proves it is a pull request, and
  // the roster is not built until after that.
  if (!isBot(c.user)) continue;
  if (!inWindow(c.created_at)) {
    windowDrops.issueComments += 1;
    continue;
  }
  const n = prNumFromUrl(c.issue_url);
  if (n) {
    note(n, c.user.login, "summary", c.created_at);
    source.set(n, "comment");
  }
}

process.stderr.write(`candidate PRs from comments: ${prs.size}\n`);

// ---------------------------------------------------------------------------
// Sweep. Top-level review submissions (APPROVE / REQUEST_CHANGES with a body
// and no inline comment) appear in NEITHER repo-wide feed. Without this pass a
// reviewer that only posts summary reviews is invisible on any PR no other bot
// commented on, and PRs where every reviewer was clear never enter the corpus
// at all — so defect density is computed over a denominator of "PRs that had a
// bot comment", which is not the population anyone means.
// ---------------------------------------------------------------------------
const reviewsCache = new Map();
function reviewsFor(number) {
  if (reviewsCache.has(number)) return reviewsCache.get(number);
  const res = ghJson(`repos/${args.repo}/pulls/${number}/reviews?per_page=100`);
  if (!res.ok) warn(`could not read reviews for PR ${number}; its review-only reviewers are missing from the corpus`);
  reviewsCache.set(number, res);
  return res;
}

let sweptPrs = 0;
let sweepAddedPrs = 0;
let sweepCapHit = false;
let sweepConsidered = 0;

if (maxSweep > 0) {
  process.stderr.write(`sweeping PRs updated since ${since} (cap ${maxSweep})…\n`);
  let page = 1;
  let done = false;
  while (!done) {
    const res = ghPage(`repos/${args.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!res.ok) {
      warn(`sweep stopped at page ${page}: PR listing failed, so review-only reviewers may be under-counted`);
      break;
    }
    if (res.items.length === 0) break;
    for (const pr of res.items) {
      // Sorted by updated_at desc, so the first PR older than `since` ends it.
      if (!pr.updated_at || pr.updated_at < since) {
        done = true;
        break;
      }
      sweepConsidered += 1;
      if (prs.has(pr.number)) continue;
      if (sweptPrs >= maxSweep) {
        sweepCapHit = true;
        done = true;
        break;
      }
      sweptPrs += 1;
      const revRes = reviewsFor(pr.number);
      let added = false;
      for (const r of revRes.items) {
        if (!isBot(r.user)) continue;
        note(pr.number, r.user.login, "summary", r.submitted_at);
        added = true;
      }
      if (added) {
        sweepAddedPrs += 1;
        source.set(pr.number, "sweep");
      } else {
        // No bot reviewed it: not a corpus PR, and not an exclusion either.
        prs.delete(pr.number);
      }
    }
    if (res.items.length < 100) break;
    page += 1;
  }
  if (sweepCapHit) {
    warn(
      `--max-sweep cap of ${maxSweep} hit after ${sweepConsidered} PR(s) updated in the window; ` +
        "PRs beyond the cap were never checked for review-only reviewers. Raise --max-sweep or narrow --since.",
    );
  }
  process.stderr.write(`swept ${sweptPrs} PR(s), added ${sweepAddedPrs} not seen in the comment feeds\n`);
} else {
  warn("--max-sweep 0: the sweep was skipped, so review-only reviewers and clean PRs are missing from the corpus");
}

process.stderr.write(`candidate PRs after sweep: ${prs.size}\n`);

// ---------------------------------------------------------------------------
// Metadata pass. This is also the pull-request proof for issues/comments
// candidates: repos/{repo}/pulls/{n} 404s on a real issue.
// ---------------------------------------------------------------------------
function prMeta(number) {
  const res = ghRaw(
    [
      "api",
      `repos/${args.repo}/pulls/${number}`,
      "--jq",
      "{number,title,html_url,created_at,updated_at,merged_at,state,draft,author:.user.login,head:.head.sha,base:.base.ref,additions,deletions,changed_files}",
    ],
    { label: `gh api repos/${args.repo}/pulls/${number}`, maxBuffer: 16 * 1024 * 1024 },
  );
  if (!res.ok) return { ok: false, permanent: Boolean(res.permanent), detail: res.detail };
  try {
    return { ok: true, pr: JSON.parse(res.raw) };
  } catch {
    return { ok: false, permanent: false, detail: "unparseable metadata" };
  }
}

// When a PR was opened as a draft, reviewer latency must start at
// ready_for_review, not created_at: a draft readied a week later otherwise
// reports a week of reviewer latency that no reviewer could have avoided.
// A PR opened non-draft and later converted then readied keeps created_at,
// since it was reviewable from open.
function readyState(number, currentlyDraft) {
  if (!readyTimeline) return { wasDraft: Boolean(currentlyDraft), readyForReviewAt: null, basis: "created_at" };
  const res = ghJson(`repos/${args.repo}/issues/${number}/timeline?per_page=100`, { maxBuffer: 64 * 1024 * 1024 });
  if (!res.ok) {
    warn(`could not read the timeline for PR ${number}; its latency is measured from created_at`);
    return { wasDraft: Boolean(currentlyDraft), readyForReviewAt: null, basis: "created_at" };
  }
  const events = res.items
    .filter((e) => e.event === "ready_for_review" || e.event === "convert_to_draft")
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const wasDraft = Boolean(currentlyDraft) || events.length > 0;
  // Opened as a draft iff the first draft-lifecycle event is the readying.
  if (events.length && events[0].event === "ready_for_review" && events[0].created_at) {
    return { wasDraft, readyForReviewAt: events[0].created_at, basis: "ready_for_review" };
  }
  return { wasDraft, readyForReviewAt: null, basis: "created_at" };
}

if (!readyTimeline) {
  warn(
    "--no-ready-timeline: minutesToFirstComment is measured from created_at, so PRs opened as drafts overstate " +
      "reviewer latency. wasDraft is only reliable for still-draft PRs; exclude wasDraft PRs downstream.",
  );
}

const meta = [];
for (const [number, byBot] of [...prs.entries()].sort((a, b) => a[0] - b[0])) {
  const res = prMeta(number);
  if (!res.ok) {
    if (res.permanent) {
      // Not a pull request (a real issue from the issues/comments feed), or
      // deleted. Either way it is not corpus material and must not sit in the
      // roster inflating prsCommentedOn.
      drop(number, "not_a_pull_request");
    } else {
      drop(number, "metadata_unavailable");
      warn(`PR ${number} dropped: metadata unavailable after ${GH_ATTEMPTS} attempt(s): ${res.detail}`);
    }
    continue;
  }
  const pr = res.pr;

  if (excludedAuthors.has((pr.author || "").toLowerCase())) {
    drop(number, "excluded_author", pr.author || null);
    process.stderr.write(`excluding PR ${number} (author ${pr.author})\n`);
    continue;
  }

  // Reviews: needed for review-only reviewers on comment-feed candidates too,
  // not just swept PRs. Cached so a swept PR is not fetched twice.
  const revRes = reviewsFor(number);
  for (const r of revRes.items) {
    if (!isBot(r.user)) continue;
    const login = r.user.login;
    if (!byBot.has(login)) note(number, login, "summary", r.submitted_at);
  }

  const ready = readyState(number, pr.draft);
  const latencyFrom = ready.readyForReviewAt || pr.created_at;

  const reviewers = [...byBot.entries()]
    .map(([login, rec]) => ({
      login,
      inlineComments: rec.inline,
      summaryComments: rec.summary,
      firstCommentAt: rec.first,
      minutesToFirstComment:
        rec.first && latencyFrom
          ? Math.round((new Date(rec.first).getTime() - new Date(latencyFrom).getTime()) / 60000)
          : null,
    }))
    .sort((a, b) => a.login.localeCompare(b.login));

  meta.push({
    ...pr,
    wasDraft: ready.wasDraft,
    readyForReviewAt: ready.readyForReviewAt,
    latencyBasis: ready.basis,
    latencyFrom,
    discoveredVia: source.get(number) || "reviews",
    reviewers,
    reviewerCount: reviewers.length,
  });
}

// The roster is built HERE, from the PRs that survived every filter, not from
// note(). Building it during note() meant excluded vendor-authored PRs, real
// issues, and PRs whose metadata failed all still inflated prsCommentedOn while
// totals.prs counted something else.
const roster = new Map();
for (const p of meta) {
  for (const r of p.reviewers) {
    if (!roster.has(r.login)) roster.set(r.login, { prs: 0, inline: 0, summary: 0 });
    const row = roster.get(r.login);
    row.prs += 1;
    row.inline += r.inlineComments;
    row.summary += r.summaryComments;
  }
}

const rosterOut = [...roster.entries()]
  .map(([login, r]) => ({ login, prsCommentedOn: r.prs, inlineComments: r.inline, summaryComments: r.summary }))
  .sort((a, b) => b.prsCommentedOn - a.prsCommentedOn);

const excludedByReason = {};
for (const e of excluded) excludedByReason[e.reason] = (excludedByReason[e.reason] || 0) + 1;

const corpus = {
  repo: args.repo,
  since,
  until: until || null,
  windowAppliedTo: "comment created_at",
  windowFetchedBy: "API since= on updated_at",
  generatedAt: new Date().toISOString(),
  roster: rosterOut,
  prs: meta,
  // Downstream is required to print both of these. They are the record of what
  // the corpus is NOT, and a corpus is only readable next to its own holes.
  excluded,
  warnings,
  totals: {
    prs: meta.length,
    prsWithMultipleReviewers: meta.filter((p) => p.reviewerCount > 1).length,
    reviewers: rosterOut.length,
    excluded: excluded.length,
    excludedByReason,
    warnings: warnings.length,
    draftPrs: meta.filter((p) => p.wasDraft).length,
    windowDrops,
    sweep: {
      enabled: maxSweep > 0,
      max: maxSweep,
      consideredUpdatedInWindow: sweepConsidered,
      swept: sweptPrs,
      addedPrs: sweepAddedPrs,
      capHit: sweepCapHit,
    },
  },
};

const json = JSON.stringify(corpus, null, 2);
if (args.out) {
  writeFileSync(args.out, json + "\n");
  process.stderr.write(`wrote ${args.out}\n`);
} else {
  process.stdout.write(json + "\n");
}

process.stderr.write(`\nReviewer roster for ${args.repo}:\n`);
for (const r of rosterOut) {
  process.stderr.write(`  ${r.login.padEnd(28)} ${String(r.prsCommentedOn).padStart(4)} PRs  ${r.inlineComments} inline  ${r.summaryComments} summary\n`);
}
process.stderr.write(
  `\n${corpus.totals.prs} PR(s) in corpus; ${corpus.totals.prsWithMultipleReviewers} with 2+ reviewers (head-to-head subset)\n`,
);
if (excluded.length) {
  process.stderr.write(
    `${excluded.length} candidate(s) excluded: ${Object.entries(excludedByReason).map(([k, v]) => `${k}=${v}`).join(", ")}\n`,
  );
}
if (windowDrops.reviewComments || windowDrops.issueComments) {
  process.stderr.write(
    `${windowDrops.reviewComments + windowDrops.issueComments} comment(s) fetched by since= but dropped on created_at\n`,
  );
}
if (warnings.length) process.stderr.write(`${warnings.length} warning(s) recorded in the corpus\n`);
