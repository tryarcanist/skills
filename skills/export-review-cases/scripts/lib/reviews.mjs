// One reviewer's published output on one pull request, pinned to the commit it
// actually ran against.
//
// The pin is `commit_id` on a review and `original_commit_id` on an inline
// comment. GitHub re-anchors inline comment lines onto the current head as a PR
// evolves, so the line a comment points at today is often not the line it was
// written against. Every downstream presence and eligibility test joins on
// these SHAs, so nothing here substitutes head when a pin is missing.

import { ghJson } from "./gh.mjs";

export const MAX_BODY_CHARS = 20000;

function clip(body) {
  const text = String(body || "");
  if (text.length <= MAX_BODY_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_BODY_CHARS)}\n\n[truncated at ${MAX_BODY_CHARS} characters]`, truncated: true };
}

// Every published surface a reviewer may use: review bodies, inline review
// comments, and top-level issue comments. A reviewer that publishes only
// through a surface not listed here is not a silent reviewer; it is an
// unmeasured one, and the caller must say so rather than record a zero.
export function fetchReviewerOutput(repo, pr, roster) {
  const base = `repos/${repo}/pulls/${pr}`;
  const reviews = ghJson(`${base}/reviews?per_page=100`, { tolerate: true })
    .filter((r) => roster.has(r.user?.login))
    .map((r) => {
      const { text, truncated } = clip(r.body);
      return {
        kind: "review",
        id: `review-${r.id}`,
        reviewer: r.user.login,
        state: r.state,
        reviewedCommit: r.commit_id || null,
        submittedAt: r.submitted_at || null,
        url: r.html_url,
        body: text,
        bodyTruncated: truncated,
      };
    });

  const inline = ghJson(`${base}/comments?per_page=100`, { tolerate: true })
    .filter((c) => roster.has(c.user?.login))
    .map((c) => {
      const { text, truncated } = clip(c.body);
      return {
        kind: "inline",
        id: `inline-${c.id}`,
        reviewer: c.user.login,
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        side: c.side || null,
        reviewedCommit: c.original_commit_id || c.commit_id || null,
        submittedAt: c.created_at || null,
        url: c.html_url,
        body: text,
        bodyTruncated: truncated,
      };
    });

  const issue = ghJson(`repos/${repo}/issues/${pr}/comments?per_page=100`, { tolerate: true })
    .filter((c) => roster.has(c.user?.login))
    .map((c) => {
      const { text, truncated } = clip(c.body);
      return {
        kind: "summary",
        id: `comment-${c.id}`,
        reviewer: c.user.login,
        reviewedCommit: null, // no pin on this surface; the caller must treat it as unpinned
        submittedAt: c.created_at || null,
        url: c.html_url,
        body: text,
        bodyTruncated: truncated,
      };
    });

  return [...reviews, ...inline, ...issue].sort((a, b) =>
    String(a.submittedAt).localeCompare(String(b.submittedAt)),
  );
}

// Distinct commits a reviewer demonstrably read, oldest publication first.
// An unpinned surface contributes no commit: publication proves a run, but an
// unpinned publication does not prove which commit that run saw.
export function reviewedCommitsByReviewer(output) {
  const byReviewer = new Map();
  for (const item of output) {
    if (!byReviewer.has(item.reviewer)) {
      byReviewer.set(item.reviewer, { pinned: new Map(), unpinnedPublications: 0 });
    }
    const entry = byReviewer.get(item.reviewer);
    if (!item.reviewedCommit) {
      entry.unpinnedPublications += 1;
      continue;
    }
    if (!entry.pinned.has(item.reviewedCommit)) {
      entry.pinned.set(item.reviewedCommit, item.submittedAt);
    }
  }
  return [...byReviewer.entries()].map(([reviewer, entry]) => ({
    reviewer,
    reviewedCommits: [...entry.pinned.entries()].map(([sha, firstSeenAt]) => ({ sha, firstSeenAt })),
    unpinnedPublications: entry.unpinnedPublications,
  }));
}
