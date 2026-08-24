#!/usr/bin/env node
// Emit every AI reviewer's activity on one PR, pinned to the commit each review
// event actually ran against, plus the human evidence needed to judge what
// happened to each finding.
//
// The commit pin is the whole point. GitHub re-anchors inline comments onto the
// current head as a PR evolves, so the line a comment points at today is not
// necessarily the line it was written against. `original_commit_id` preserves
// the commit the reviewer saw; a judgement made against anything else silently
// credits or blames a reviewer for code it never read.
//
// Contract (everything downstream joins on commit SHA, so fidelity is the job):
//   - Every commit-ish field is emitted as a FULL 40-char SHA whenever the SHA
//     resolves to a member of `commits`: reviewEvents[].reviewedCommit,
//     findingInstances[].reviewedCommit / .currentCommit,
//     summaryComments[].claimedCommits, and the keys of reviewersByCommit.
//     A SHA that does not resolve is passed through untouched AND recorded in
//     `collectionWarnings` (force-push, truncated commit list, bad marker...).
//   - `collectionWarnings: string[]` is the single place every degraded-data
//     condition is recorded: tolerated API failures, unresolvable SHAs,
//     time-inferred summary pins, a failed GraphQL thread-metadata call, and a
//     commit list that hit the 250-commit ceiling. An empty output array means
//     the collection was clean; a non-empty one means downstream numbers are
//     partial and must say so.
//   - `summaryComments[]` carries `reviewedCommit` + `reviewedCommitSource`
//     ("claimed" | "inferred-by-time" | null) so summary-only reviewers can be
//     scored on first-look the same way inline reviewers are.
//   - `findingInstances[]` carries the comment geometry (`side`, `originalSide`,
//     `originalPosition`, `subjectType`, `scope`) because a LEFT-side comment
//     points at the BASE file while `git show <commit>:<path>` shows the RIGHT
//     side, and a file-scoped comment has no line by design rather than by
//     parse failure (`scope: "file"` vs `scope: "unknown"`).
//   - `findingInstances[]` also carries the disposition signals a GraphQL pass
//     adds: `resolved`, `minimized`, `minimizedReason`, `reactions {up, down}`.
//     Resolving a thread is the cheapest strong "accepted" signal; hiding a
//     comment is the cheapest "rejected" signal. Null means unknown, not false.
//   - `humanComments[]` holds human top-level issue comments and human review
//     bodies, which is where "a human addressed that finding elsewhere on the
//     PR" lives. `humanReplies[]` (threaded replies to a bot) stays as-is but
//     now carries id/url/authorAssociation/isPrAuthor.
//
// Usage:
//   fetch-pr-reviews.mjs --repo owner/repo --pr <number> [--bots <regex>] [--only "a,b"] [--out file]
//   fetch-pr-reviews.mjs --self-test
//
// Pass the same --only list used to build the corpus. If the two passes disagree
// on who counts as a reviewer, the coverage map credits or blames the wrong set.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const GH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const SECONDARY_RATE_LIMIT_DELAY_MS = 60000;
const COMMITS_PAGE_CEILING = 250; // pulls/{n}/commits stops here no matter the pagination
const MAX_GRAPHQL_PAGES = 20;

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: fetch-pr-reviews.mjs --repo owner/repo --pr <number> [--bots regex] [--only \"a,b\"] [--out file]\n" +
      "       fetch-pr-reviews.mjs --self-test\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[(i += 1)];
    else if (a === "--pr") out.pr = argv[(i += 1)];
    else if (a === "--bots") out.bots = argv[(i += 1)];
    else if (a === "--non-humans") out.nonHumans = argv[(i += 1)];
    else if (a === "--only") out.only = argv[(i += 1)];
    else if (a === "--out") out.out = argv[(i += 1)];
    else if (a === "--self-test") out.selfTest = true;
    else usage(`unknown arg ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure helpers (exercised by --self-test; no network, no argv).
// ---------------------------------------------------------------------------

// Several reviewers post one summary comment and EDIT IT IN PLACE on every later
// round rather than posting a new one. created_at then points at round 1 while the
// body describes round 5, which silently understates how many commits that reviewer
// reviewed — and therefore how many defects it had the chance to catch. updatedAt
// and any in-body "reviewed commit" marker are the only signals that survive.
//
// The separator between the label and the SHA must not be able to swallow hex, or
// it eats the head of the SHA and yields a mid-SHA fragment that joins to nothing.
// Hence [^0-9a-f] (case-insensitive, so A-F is excluded too) plus a word boundary.
// One label can introduce a comma/whitespace-separated list of SHAs.
// The optional trailing noun ("commit", "sha", "id") is matched as a word rather
// than left to the separator class, because "commit" is itself made of hex letters.
const SHA_LABELLED_LIST =
  /(?:\b(?:(?:last|latest|most\s+recent)\s+)?reviewed\s+(?:commits?|shas?|ids?|hash(?:es)?)|\bcommits?\s+reviewed|\breviewed\s+(?:up\s+to|through)(?:\s+(?:commits?|shas?))?|\bas\s+of\s+commits?)[^0-9a-f]{0,20}?\b([0-9a-f]{7,40}\b(?:[,\s]+[0-9a-f]{7,40}\b)*)/gi;

// Vendors that keep their state in the comment body fence it in HTML comments,
// e.g. <!-- commit_ids_reviewed_start --> ... <!-- commit_ids_reviewed_end -->.
// Treat a missing end marker as "runs to the end of the body" rather than as no
// match at all, since a truncated or reformatted body is common.
const COMMIT_MARKER_BLOCK =
  /<!--\s*[a-z0-9_\- ]*commit[a-z0-9_\- ]*start\s*-->([\s\S]*?)(?:<!--\s*[a-z0-9_\- ]*commit[a-z0-9_\- ]*end\s*-->|$)/gi;
const BARE_SHA = /\b[0-9a-f]{7,40}\b/gi;

const shasInBody = (body) => {
  const text = String(body || "");
  const out = new Set();
  for (const m of text.matchAll(SHA_LABELLED_LIST)) {
    for (const sha of m[1].split(/[,\s]+/)) {
      if (sha) out.add(sha.toLowerCase());
    }
  }
  for (const block of text.matchAll(COMMIT_MARKER_BLOCK)) {
    for (const sha of (block[1] || "").match(BARE_SHA) || []) out.add(sha.toLowerCase());
  }
  return [...out];
};

// Every prefix from 7 chars up to the full SHA is a key, so one lookup resolves
// any abbreviation length. Anything not in this map is not a commit of this PR.
function makeShaIndex(commits) {
  const shaByPrefix = new Map();
  for (const c of commits) {
    const sha = String(c.sha || "");
    for (let n = 7; n <= sha.length; n += 1) shaByPrefix.set(sha.slice(0, n).toLowerCase(), sha);
  }
  return shaByPrefix;
}

const resolveSha = (shaByPrefix, sha) =>
  sha ? shaByPrefix.get(String(sha).toLowerCase()) || null : null;

// The commit a summary comment was written against: the newest commit it claims,
// else the newest commit that already existed when the body was last edited.
function pickSummaryPin({ claimedCommits, commits, updatedAt }) {
  const order = new Map(commits.map((c, i) => [c.sha, i]));
  let best = null;
  for (const sha of claimedCommits || []) {
    if (!order.has(sha)) continue;
    if (best === null || order.get(sha) > order.get(best)) best = sha;
  }
  if (best) return { reviewedCommit: best, reviewedCommitSource: "claimed" };

  const at = Date.parse(updatedAt || "");
  if (Number.isFinite(at)) {
    let inferred = null;
    for (const c of commits) {
      const t = Date.parse(c.authoredAt || "");
      if (!Number.isFinite(t) || t > at) continue;
      inferred = c.sha; // commits arrive oldest-first, so the last match is newest
    }
    if (inferred) return { reviewedCommit: inferred, reviewedCommitSource: "inferred-by-time" };
  }
  return { reviewedCommit: null, reviewedCommitSource: null };
}

// A comment with no line is only a parse failure when GitHub did not tell us it
// was file-scoped (or PR-scoped) on purpose.
const commentScope = (line, subjectType) => {
  if (line != null) return "line";
  if (subjectType === "file") return "file";
  if (subjectType) return String(subjectType);
  return "unknown";
};

function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function selfTest() {
  const cases = [];
  const eq = (name, actual, expected) =>
    cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

  eq(
    "full 40-char sha is not clipped",
    shasInBody("Last reviewed commit: deadbeefcafe1234567890abcdefabcdef123456"),
    ["deadbeefcafe1234567890abcdefabcdef123456"],
  );
  eq("all-hex-letter sha survives", shasInBody("Last reviewed commit: abcdefabcdefabcd"), [
    "abcdefabcdefabcd",
  ]);
  eq("plural label with a list", shasInBody("Commits reviewed: 8f3a1c2, 9b2d4e1"), [
    "8f3a1c2",
    "9b2d4e1",
  ]);
  eq(
    "html marker without an end marker",
    shasInBody("<!-- commit_ids_reviewed_start -->\n7f3a9c2\n"),
    ["7f3a9c2"],
  );
  eq(
    "html marker block captures every sha",
    shasInBody(
      "intro\n<!-- commit_ids_reviewed_start -->\n<!-- 7f3a9c2 -->\n<!-- 1122334 -->\n<!-- commit_ids_reviewed_end -->\ntrailer deadbeefcafe",
    ),
    ["7f3a9c2", "1122334"],
  );
  eq("newline separated list after one label", shasInBody("Reviewed commits:\n8f3a1c2\n9b2d4e1\n"), [
    "8f3a1c2",
    "9b2d4e1",
  ]);
  eq("singular legacy phrasing still works", shasInBody("Reviewed up to commit 1a2b3c4d5e"), [
    "1a2b3c4d5e",
  ]);
  eq("prose without a sha captures nothing", shasInBody("Reviewed commit history is unavailable."), []);
  eq("unlabelled sha outside a marker is ignored", shasInBody("see deadbeefcafe for context"), []);
  eq(
    "a bare 'reviewed' plus a long number is not a commit pin",
    shasInBody("Reviewed 12 files and 1234567 lines of diff."),
    [],
  );

  const commits = [
    { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", authoredAt: "2026-01-01T00:00:00Z" },
    { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2", authoredAt: "2026-01-02T00:00:00Z" },
    { sha: "ccccccccccccccccccccccccccccccccccccccc3", authoredAt: "2026-01-03T00:00:00Z" },
  ];
  const idx = makeShaIndex(commits);
  eq("short prefix resolves to full sha", resolveSha(idx, "bbbbbbb"), commits[1].sha);
  eq("full sha resolves to itself", resolveSha(idx, commits[2].sha), commits[2].sha);
  eq("foreign sha does not resolve", resolveSha(idx, "0123456"), null);

  eq(
    "summary pin prefers the newest claimed commit",
    pickSummaryPin({
      claimedCommits: [commits[1].sha, commits[0].sha],
      commits,
      updatedAt: "2026-01-05T00:00:00Z",
    }),
    { reviewedCommit: commits[1].sha, reviewedCommitSource: "claimed" },
  );
  eq(
    "summary pin falls back to time inference",
    pickSummaryPin({ claimedCommits: [], commits, updatedAt: "2026-01-02T12:00:00Z" }),
    { reviewedCommit: commits[1].sha, reviewedCommitSource: "inferred-by-time" },
  );
  eq(
    "summary pin gives up when nothing predates the comment",
    pickSummaryPin({ claimedCommits: [], commits, updatedAt: "2025-12-31T00:00:00Z" }),
    { reviewedCommit: null, reviewedCommitSource: null },
  );

  eq("file-scoped comment is not a parse failure", commentScope(null, "file"), "file");
  eq("missing line with no subject type stays unknown", commentScope(null, null), "unknown");
  eq("a line always wins", commentScope(12, "file"), "line");

  let failed = 0;
  for (const c of cases) {
    if (c.ok) {
      process.stdout.write(`PASS  ${c.name}\n`);
    } else {
      failed += 1;
      process.stdout.write(
        `FAIL  ${c.name}\n        expected ${JSON.stringify(c.expected)}\n        actual   ${JSON.stringify(c.actual)}\n`,
      );
    }
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} passed\n`);
  process.exit(failed ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) selfTest();
if (!args.repo || !/^[^/\s]+\/[^/\s]+$/.test(args.repo)) usage("need --repo owner/repo");
const prNum = String(args.pr || "").match(/(\d+)(?!.*\d)/)?.[1];
if (!prNum) usage(`cannot read a PR number from ${args.pr}`);

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

// Every degraded-data condition lands here. A silent [] on a failed endpoint
// deletes findings while the output file still looks complete.
const collectionWarnings = [];
const warn = (msg) => {
  collectionWarnings.push(msg);
  process.stderr.write(`warn: ${msg}\n`);
};

function runGh(ghArgs, { maxBuffer = 128 * 1024 * 1024 } = {}) {
  let detail = "";
  for (let attempt = 0; attempt < GH_ATTEMPTS; attempt += 1) {
    try {
      return execFileSync("gh", ghArgs, { encoding: "utf8", maxBuffer });
    } catch (e) {
      detail = (e.stderr || e.message || "").toString().trim().slice(0, 300);
      if (attempt === GH_ATTEMPTS - 1) break;
      const secondary =
        /secondary rate limit|abuse detection|was submitted too quickly|rate limit exceeded|retry-after/i.test(
          detail,
        );
      const delay = secondary
        ? Math.max(SECONDARY_RATE_LIMIT_DELAY_MS, RETRY_DELAYS_MS[attempt])
        : RETRY_DELAYS_MS[attempt];
      process.stderr.write(
        `gh api failed (attempt ${attempt + 1}/${GH_ATTEMPTS}${secondary ? ", secondary rate limit" : ""}), ` +
          `retrying in ${Math.round(delay / 1000)}s: ${detail}\n`,
      );
      sleepSync(delay);
    }
  }
  const err = new Error(detail || "gh api failed");
  err.detail = detail;
  throw err;
}

// gh --paginate --slurp returns one array per page; flatten. No text rewriting,
// so bracket sequences inside comment bodies (mock.calls[0][0], markdown refs)
// survive untouched.
function ghJson(path, { tolerate = false } = {}) {
  let raw;
  try {
    raw = runGh(["api", path, "--paginate", "--slurp"]);
  } catch (e) {
    const detail = e.detail || e.message || "";
    if (tolerate) {
      warn(`GET ${path} failed after ${GH_ATTEMPTS} attempt(s) and was treated as empty: ${detail}`);
      return [];
    }
    process.stderr.write(`gh api ${path} failed: ${detail}\n`);
    process.exit(1);
  }
  raw = raw.trim();
  if (!raw) return [];
  try {
    const pages = JSON.parse(raw);
    return Array.isArray(pages) ? pages.flat() : [];
  } catch {
    warn(`could not parse gh output for ${path}; treated as empty`);
    return [];
  }
}

const extraBotRe = args.bots ? new RegExp(args.bots, "i") : null;
const only = (args.only || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// Machine accounts that GitHub reports as type "User" with no "[bot]" suffix —
// orchestrators, PAT-backed integrations, in-house automation. They are not
// reviewers, but they are emphatically not people either, and the engagement
// pass treats "a human wrote words about this finding" as the strongest
// evidence in the audit. Left undeclared, an orchestrator posting "@reviewer
// /review" on every head becomes hundreds of rows of human engagement evidence.
const nonHumanRe = args.nonHumans ? new RegExp(args.nonHumans, "i") : null;
const anyBot = (u) =>
  u?.type === "Bot" ||
  /\[bot\]$/i.test(u?.login || "") ||
  (nonHumanRe ? nonHumanRe.test(u?.login || "") : false);
const isBot = (u) => {
  const login = (u?.login || "").toLowerCase();
  if (only.length) return only.includes(login);
  return anyBot(u) || (extraBotRe ? extraBotRe.test(login) : false);
};
// A bot excluded by --only is still not a person: it must not be counted as
// author evidence just because it is not on the reviewer list.
const isHuman = (u) => !anyBot(u) && !isBot(u);

const base = `repos/${args.repo}/pulls/${prNum}`;

const pr = JSON.parse(
  runGh(
    [
      "api",
      base,
      "--jq",
      "{number,title,html_url,body,created_at,merged_at,state,author:.user.login,authorType:.user.type,head:.head.sha,base:.base.sha,baseRef:.base.ref,additions,deletions,changed_files}",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  ),
);

const prAuthor = (pr.author || "").toLowerCase();
const isPrAuthorLogin = (login) => Boolean(prAuthor) && (login || "").toLowerCase() === prAuthor;

const commits = ghJson(`${base}/commits?per_page=100`).map((c) => ({
  sha: c.sha,
  message: (c.commit?.message || "").split("\n")[0],
  authoredAt: c.commit?.author?.date || null,
  // Order commits by COMMITTER date, never author date. A rebase preserves the
  // author date, so a rebased commit and the pre-rebase original it replaced
  // carry identical author dates while the committer dates differ by the rebase.
  // Sorting on author date therefore inverts the two, and an inverted order
  // makes `fixedAt` precede `introducedAt` — which silently voids the defect's
  // whole presence window.
  committedAt: c.commit?.committer?.date || c.commit?.author?.date || null,
}));
if (commits.length >= COMMITS_PAGE_CEILING) {
  warn(
    `commit list hit the ${COMMITS_PAGE_CEILING}-commit ceiling of ${base}/commits; ` +
      "the commit list is truncated and any pin outside it will not resolve",
  );
}

// The SHA index has to exist before anything is normalised: every commit-ish
// field downstream joins on a full 40-char SHA.
const shaByPrefix = makeShaIndex(commits);
const normalizeSha = (sha, context) => {
  if (!sha) return null;
  const full = resolveSha(shaByPrefix, sha);
  if (full) return full;
  warn(`${context} is pinned to commit ${sha} which is not in the PR commit list (force-push?)`);
  return sha;
};

const rawReviews = ghJson(`${base}/reviews?per_page=100`);
const rawInline = ghJson(`${base}/comments?per_page=100`);
const rawIssue = ghJson(`repos/${args.repo}/issues/${prNum}/comments?per_page=100`, { tolerate: true });

// Resolved threads, hidden comments, and thumbs are the cheapest disposition
// signals on a PR, and none of them exist in the REST payloads.
const GRAPHQL_THREADS = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          isResolved
          comments(first:100){
            nodes{
              databaseId
              isMinimized
              minimizedReason
              reactionGroups{content reactors{totalCount}}
            }
          }
        }
      }
    }
  }
}`;

function fetchThreadMeta() {
  const [owner, name] = args.repo.split("/");
  const meta = new Map();
  let cursor = null;
  for (let page = 0; page < MAX_GRAPHQL_PAGES; page += 1) {
    const ghArgs = [
      "api",
      "graphql",
      "-f",
      `query=${GRAPHQL_THREADS}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${Number(prNum)}`,
    ];
    if (cursor) ghArgs.push("-F", `cursor=${cursor}`);
    const parsed = JSON.parse(runGh(ghArgs, { maxBuffer: 64 * 1024 * 1024 }));
    if (parsed?.errors?.length) throw new Error(JSON.stringify(parsed.errors).slice(0, 300));
    const conn = parsed?.data?.repository?.pullRequest?.reviewThreads;
    if (!conn) break;
    for (const thread of conn.nodes || []) {
      for (const c of thread.comments?.nodes || []) {
        if (c?.databaseId == null) continue;
        const groups = c.reactionGroups || [];
        const count = (content) =>
          groups.find((g) => g.content === content)?.reactors?.totalCount ?? 0;
        meta.set(c.databaseId, {
          resolved: Boolean(thread.isResolved),
          minimized: Boolean(c.isMinimized),
          minimizedReason: c.minimizedReason ?? null,
          reactions: { up: count("THUMBS_UP"), down: count("THUMBS_DOWN") },
        });
      }
    }
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return meta;
}

let threadMeta = null;
try {
  threadMeta = fetchThreadMeta();
} catch (e) {
  threadMeta = null;
  warn(
    "GraphQL reviewThreads query failed; resolved/minimized/reactions are unknown for every finding: " +
      ((e.detail || e.message || "").toString().slice(0, 300)),
  );
}
const UNKNOWN_DISPOSITION = { resolved: null, minimized: null, minimizedReason: null, reactions: null };

// A review event is one reviewer's pass over one commit: the unit everything
// downstream is counted against.
const reviewEvents = rawReviews
  .filter((r) => isBot(r.user))
  .map((r) => ({
    id: r.id,
    reviewer: r.user.login,
    reviewedCommit: normalizeSha(r.commit_id || null, `review ${r.id}`),
    state: r.state,
    submittedAt: r.submitted_at || null,
    url: r.html_url,
    body: r.body || "",
  }))
  .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));

const inlineById = new Map(rawInline.map((c) => [c.id, c]));

const findingInstances = rawInline
  .filter((c) => isBot(c.user))
  // A reply inside an existing thread continues a finding; it is not a new one.
  .filter((c) => {
    if (!c.in_reply_to_id) return true;
    const parent = inlineById.get(c.in_reply_to_id);
    return !parent || !isBot(parent.user);
  })
  .map((c) => {
    const line = c.original_line ?? c.line ?? null;
    const disposition = threadMeta ? threadMeta.get(c.id) || UNKNOWN_DISPOSITION : UNKNOWN_DISPOSITION;
    return {
      id: `inline-${c.id}`,
      commentId: c.id,
      reviewer: c.user.login,
      kind: "inline",
      // original_commit_id is the commit the reviewer saw; commit_id is where
      // GitHub has since re-anchored the thread. Judge against the former.
      reviewedCommit: normalizeSha(
        c.original_commit_id || c.commit_id || null,
        `inline comment ${c.id}`,
      ),
      currentCommit: normalizeSha(c.commit_id || null, `inline comment ${c.id} (current anchor)`),
      reviewId: c.pull_request_review_id || null,
      path: c.path,
      line,
      startLine: c.original_start_line ?? c.start_line ?? null,
      // LEFT means the comment points at the BASE file. `git show <commit>:<path>`
      // shows the RIGHT side, so downstream must not read a LEFT comment there.
      side: c.side ?? null,
      originalSide: c.original_side ?? null,
      originalPosition: c.original_position ?? null,
      subjectType: c.subject_type ?? null,
      // "file" means file-scoped by design; "unknown" means we failed to parse it.
      scope: commentScope(line, c.subject_type ?? null),
      diffHunk: c.diff_hunk || "",
      createdAt: c.created_at,
      url: c.html_url,
      body: c.body || "",
      resolved: disposition.resolved,
      minimized: disposition.minimized,
      minimizedReason: disposition.minimizedReason,
      reactions: disposition.reactions,
    };
  });

// Human replies are evidence for a label (an author confirming, rejecting, or
// fixing a finding), never a scorecard participant.
const humanReplies = rawInline
  .filter((c) => isHuman(c.user) && c.in_reply_to_id)
  .filter((c) => isBot(inlineById.get(c.in_reply_to_id)?.user))
  .map((c) => ({
    id: `inline-${c.id}`,
    replyTo: `inline-${c.in_reply_to_id}`,
    author: c.user.login,
    authorAssociation: c.author_association || null,
    isPrAuthor: isPrAuthorLogin(c.user.login),
    createdAt: c.created_at,
    url: c.html_url,
    body: c.body || "",
  }));

// The engagement pass also needs human comments made ANYWHERE on the PR, not just
// threaded replies: "we already fixed that" is usually a top-level comment.
const humanComments = [
  ...rawIssue
    .filter((c) => isHuman(c.user))
    .map((c) => ({
      id: `issue-${c.id}`,
      author: c.user.login,
      authorAssociation: c.author_association || null,
      isPrAuthor: isPrAuthorLogin(c.user.login),
      createdAt: c.created_at,
      url: c.html_url,
      body: c.body || "",
      kind: "issue",
    })),
  ...rawReviews
    .filter((r) => isHuman(r.user) && (r.body || "").trim())
    .map((r) => ({
      id: `review-${r.id}`,
      author: r.user.login,
      authorAssociation: r.author_association || null,
      isPrAuthor: isPrAuthorLogin(r.user.login),
      createdAt: r.submitted_at || null,
      url: r.html_url,
      body: r.body || "",
      kind: "review",
    })),
].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

const summaryComments = rawIssue
  .filter((c) => isBot(c.user))
  .map((c) => {
    const claimedCommits = shasInBody(c.body).map((sha) =>
      normalizeSha(sha, `summary comment ${c.id} claim`),
    );
    const updatedAt = c.updated_at || c.created_at;
    const pin = pickSummaryPin({ claimedCommits, commits, updatedAt });
    if (pin.reviewedCommitSource === "inferred-by-time") {
      warn(
        `summary comment ${c.id} by ${c.user.login} claims no commit; ` +
          `pinned to ${pin.reviewedCommit} by edit time (${updatedAt})`,
      );
    }
    return {
      id: `issue-${c.id}`,
      reviewer: c.user.login,
      kind: "summary",
      createdAt: c.created_at,
      // An edited summary is a later review round wearing an earlier timestamp.
      updatedAt,
      editedInPlace: Boolean(c.updated_at && c.updated_at !== c.created_at),
      // Commits this body claims to have reviewed. Treated as real exposure below.
      claimedCommits,
      // The commit this summary is judged against, and how solid that pin is.
      reviewedCommit: pin.reviewedCommit,
      reviewedCommitSource: pin.reviewedCommitSource,
      url: c.html_url,
      body: c.body || "",
    };
  });

// Which reviewers ran against which commit — the "had the chance to catch it"
// map. A reviewer can only miss a defect on a commit it actually reviewed.
const reviewersByCommit = {};
for (const ev of reviewEvents) {
  if (!ev.reviewedCommit) continue;
  (reviewersByCommit[ev.reviewedCommit] ||= new Set()).add(ev.reviewer);
}
for (const f of findingInstances) {
  if (!f.reviewedCommit) continue;
  (reviewersByCommit[f.reviewedCommit] ||= new Set()).add(f.reviewer);
}
// A commit a summary body says it reviewed is exposure, even when no inline comment
// landed on it. Without this, a reviewer that edits one summary in place looks like it
// reviewed the PR once and is never charged for anything it missed on later heads.
for (const s of summaryComments) {
  for (const claimed of s.claimedCommits || []) {
    if (shaByPrefix.has(claimed.toLowerCase())) {
      (reviewersByCommit[claimed] ||= new Set()).add(s.reviewer);
    }
  }
}
// A summary comment whose commit we could only infer from its edit time is still
// exposure. Excluding it looks conservative and is not: a reviewer that publishes
// findings in summaries carries no commit pin anywhere, so its opportunity set
// collapses to the few commits it happened to leave an inline comment on. That
// shrinks its denominator — INFLATING its recall — and makes its own confirmed
// catches read as defects it was never eligible for. Counted, and tracked, so the
// report can say how much of each reviewer's coverage rests on inference.
const inferredCoverage = {};
for (const s of summaryComments) {
  if (s.reviewedCommitSource !== "inferred-by-time" || !s.reviewedCommit) continue;
  const had = reviewersByCommit[s.reviewedCommit];
  if (had && had.has(s.reviewer)) continue; // already established by a pinned trace
  (reviewersByCommit[s.reviewedCommit] ||= new Set()).add(s.reviewer);
  inferredCoverage[s.reviewer] = (inferredCoverage[s.reviewer] || 0) + 1;
}
if (Object.keys(inferredCoverage).length) {
  collectionWarnings.push(
    `coverage inferred from summary edit time (no commit pin published): ` +
      Object.entries(inferredCoverage).map(([r, n]) => `${r} +${n} commit(s)`).join(", "),
  );
}
const coverageMap = Object.fromEntries(
  Object.entries(reviewersByCommit).map(([sha, set]) => [sha, [...set].sort()]),
);

const pairedCommits = Object.entries(coverageMap)
  .filter(([, r]) => r.length > 1)
  .map(([sha, reviewers]) => ({ sha, reviewers }));

// COMMIT ORDER — the chronology every presence window is evaluated against.
//
// `pulls/{n}/commits` returns only commits currently reachable from the PR head.
// On a repo that rebases or force-pushes mid-review — which is normal wherever an
// automated fixer pushes commits — the sha a reviewer actually read is frequently
// NOT in that list. Ordering against the list alone then makes those reviews
// unplaceable: the defect drops out of every opportunity set, and a reviewer that
// demonstrably published the finding is recorded as having missed it.
//
// The rewritten commits are almost always still fetchable by sha, so their real
// committer dates are recoverable. commitOrder is therefore the union of the PR's
// commits and every reviewed commit we can still resolve, sorted by committer
// date. Anything unreachable is listed in `unresolvableCommits` so downstream can
// exclude it explicitly instead of silently mis-scoring it.
const referenced = new Set();
for (const ev of reviewEvents) if (ev.reviewedCommit) referenced.add(ev.reviewedCommit);
for (const f of findingInstances) if (f.reviewedCommit) referenced.add(f.reviewedCommit);
for (const s of summaryComments) if (s.reviewedCommit) referenced.add(s.reviewedCommit);

const known = new Map(commits.map((c) => [c.sha, c.committedAt]));
const rewrittenCommits = [];
const unresolvableCommits = [];
for (const sha of referenced) {
  if (known.has(sha)) continue;
  let date = null;
  try {
    date = execFileSync("gh", ["api", `repos/${args.repo}/commits/${sha}`, "--jq", ".commit.committer.date"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    date = null;
  }
  if (date) {
    known.set(sha, date);
    rewrittenCommits.push({ sha, date });
  } else {
    unresolvableCommits.push(sha);
    collectionWarnings.push(
      `reviewed commit ${sha} is not in the PR commit list and is no longer fetchable; ` +
        `defects pinned to it cannot be ordered and must be excluded`,
    );
  }
}
if (rewrittenCommits.length) {
  collectionWarnings.push(
    `${rewrittenCommits.length} reviewed commit(s) are not in the PR commit list (rebase or force-push) ` +
      `but were resolved by sha and placed in commitOrder by committer date: ` +
      rewrittenCommits.map((c) => c.sha.slice(0, 8)).join(", "),
  );
}
const commitOrder = [...known.entries()]
  .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
  .map(([sha]) => sha);

const out = {
  repo: args.repo,
  pr: Number(prNum),
  url: pr.html_url,
  title: pr.title,
  author: pr.author,
  authorType: pr.authorType || null,
  createdAt: pr.created_at,
  mergedAt: pr.merged_at,
  state: pr.state,
  headSha: pr.head,
  baseSha: pr.base,
  baseRef: pr.baseRef,
  size: { additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changed_files },
  commits,
  reviewEvents,
  findingInstances,
  summaryComments,
  humanReplies,
  humanComments,
  reviewersByCommit: coverageMap,
  pairedCommits,
  // Copy this straight into the label file's `commitOrder`. Do not rebuild it
  // from `commits` — that drops every pre-rebase commit a reviewer actually read.
  commitOrder,
  rewrittenCommits,
  unresolvableCommits,
  inferredCoverage,
  collectionWarnings,
};

const json = JSON.stringify(out, null, 2);
if (args.out) {
  writeFileSync(args.out, json + "\n");
  process.stderr.write(`wrote ${args.out}\n`);
} else {
  process.stdout.write(json + "\n");
}

const byReviewer = {};
for (const f of findingInstances) byReviewer[f.reviewer] = (byReviewer[f.reviewer] || 0) + 1;
process.stderr.write(
  `PR #${prNum}: ${reviewEvents.length} review event(s), ${findingInstances.length} inline finding instance(s), ` +
    `${summaryComments.length} summary, ${humanReplies.length} human repl(y/ies), ` +
    `${humanComments.length} human comment(s), ${pairedCommits.length} paired commit(s), ` +
    `${collectionWarnings.length} collection warning(s)\n`,
);
for (const [r, n] of Object.entries(byReviewer).sort((a, b) => b[1] - a[1])) {
  process.stderr.write(`  ${r}: ${n} inline finding(s)\n`);
}
