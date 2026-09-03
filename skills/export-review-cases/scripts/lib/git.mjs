// Local git access for export-review-cases.
//
// Two facts in this file decide whether a case is real:
//
//   1. `blameRange` names the commit that wrote the lines a fix later changed.
//      That is the claim "this PR introduced the bug", and it is only as good
//      as the clone. A shallow clone blames everything onto the graft
//      boundary, which manufactures false origins. `assertUsableClone` refuses
//      to let that happen quietly.
//
//   2. `isAncestor` decides whether the buggy commit was already in the tree at
//      a commit a reviewer demonstrably reviewed. That is the whole eligibility
//      test for a missed-bug case: a reviewer that ran before the bug existed
//      did not miss it, and charging it anyway is the easiest way to produce a
//      case set that teaches the wrong lesson.

import { execFileSync } from "node:child_process";

const MAX_BUFFER = 128 * 1024 * 1024;

export function git(repoPath, args, { tolerate = false } = {}) {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (tolerate) return null;
    const detail = (e.stderr || e.message || "").toString().trim().slice(0, 300);
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export function assertUsableClone(repoPath) {
  const inside = git(repoPath, ["rev-parse", "--is-inside-work-tree"], { tolerate: true });
  if (!inside || inside.trim() !== "true") {
    throw new Error(`${repoPath} is not a git work tree. Run this from a clone of the audited repo.`);
  }
  const shallow = git(repoPath, ["rev-parse", "--is-shallow-repository"], { tolerate: true });
  if (shallow && shallow.trim() === "true") {
    throw new Error(
      `${repoPath} is a shallow clone. git blame would attribute every line to the graft boundary ` +
        `and invent origin commits. Run: git -C ${repoPath} fetch --unshallow`,
    );
  }
}

export function hasCommit(repoPath, sha) {
  const out = git(repoPath, ["cat-file", "-e", `${sha}^{commit}`], { tolerate: true });
  return out !== null;
}

// Fetch a commit that is not local yet. Intermediate commits of a force-pushed
// or fork PR are frequently unreachable; the caller must handle `false` rather
// than fall back to reading whatever the work tree currently holds.
export function ensureCommit(repoPath, sha) {
  if (hasCommit(repoPath, sha)) return true;
  git(repoPath, ["fetch", "--quiet", "origin", sha], { tolerate: true });
  return hasCommit(repoPath, sha);
}

// true / false / null. null means one of the commits is not present locally,
// which is a measurement gap, not a negative answer.
export function isAncestor(repoPath, ancestor, descendant) {
  if (!hasCommit(repoPath, ancestor) || !hasCommit(repoPath, descendant)) return null;
  try {
    execFileSync("git", ["-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
    });
    return true;
  } catch (e) {
    // Exit 1 is a clean "no". Anything else is a broken invocation.
    return e.status === 1 ? false : null;
  }
}

export function commitMeta(repoPath, sha) {
  const out = git(repoPath, ["show", "-s", "--format=%H%x00%aI%x00%an%x00%s", sha], {
    tolerate: true,
  });
  if (!out) return null;
  const [full, authoredAt, author, subject] = out.trim().split("\0");
  return { sha: full, authoredAt, author, subject };
}

// Per-line blame for the pre-image lines a later fix rewrote. `rev` must be
// the commit the fix was applied to, not the fix itself: blaming after the fix
// names the fix.
export function blameLines(repoPath, rev, path, start, end) {
  const out = git(
    repoPath,
    ["blame", "-w", "--line-porcelain", "-L", `${start},${end}`, rev, "--", path],
    { tolerate: true },
  );
  if (!out) return null;
  const lines = [];
  let current = null;
  let boundary = false;
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      current = { sha: header[1], line: Number(header[3]), boundary: false };
      boundary = false;
      continue;
    }
    if (line === "boundary") boundary = true;
    // The porcelain payload line for the entry starts with a tab and closes it.
    if (line.startsWith("\t") && current) {
      lines.push({ ...current, boundary });
      current = null;
      boundary = false;
    }
  }
  return lines;
}

// Contiguous runs of consecutive lines attributed to one commit. A run is the
// unit used for the content-presence test, because a mixed range that another
// commit partly rewrote will never match verbatim at an earlier head.
export function contiguousRuns(blamed, sha) {
  const runs = [];
  let run = null;
  for (const entry of blamed) {
    if (entry.sha !== sha) {
      run = null;
      continue;
    }
    if (run && entry.line === run.end + 1) run.end = entry.line;
    else {
      run = { start: entry.line, end: entry.line };
      runs.push(run);
    }
  }
  return runs.sort((a, b) => b.end - b.start - (a.end - a.start));
}

// File content at a commit, or null when the commit or path is not reachable.
export function fileAt(repoPath, rev, path) {
  return git(repoPath, ["show", `${rev}:${path}`], { tolerate: true });
}

const normalize = (text) =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l.length > 0)
    .join("\n");

// Did this exact block of code already exist at `rev`?
//
// This is the fallback eligibility test for a squash-merged repository, where
// the commit blame names is a squash commit on the default branch and the
// commits a reviewer read live on a branch that is not its ancestor. Ancestry
// cannot answer there; verbatim content can.
export function blockPresentAt(repoPath, rev, path, block) {
  const content = fileAt(repoPath, rev, path);
  if (content === null) return { present: null, reason: "path-or-commit-unreachable" };
  const needle = normalize(block);
  if (!needle) return { present: null, reason: "block-is-blank" };
  return { present: normalize(content).includes(needle), reason: null };
}

// Pre-image line ranges touched by a unified diff patch, i.e. the lines that
// existed before the fix and therefore carry the bug's authorship. A hunk that
// only adds lines has no pre-image range of its own; we return the single line
// above the insertion point so blame still has an anchor, flagged so the
// adjudicator knows the attribution is weaker.
export function preImageRanges(patch) {
  const ranges = [];
  if (!patch) return ranges;
  const lines = patch.split("\n");
  let oldLine = 0;
  let pendingStart = null;
  let pendingEnd = null;
  const flush = () => {
    if (pendingStart !== null) ranges.push({ start: pendingStart, end: pendingEnd, anchorOnly: false });
    pendingStart = null;
    pendingEnd = null;
  };
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("-")) {
      if (pendingStart === null) pendingStart = oldLine;
      pendingEnd = oldLine;
      oldLine += 1;
    } else if (line.startsWith("+")) {
      if (pendingStart === null && oldLine > 1) {
        ranges.push({ start: oldLine - 1, end: oldLine - 1, anchorOnly: true });
      }
    } else if (line.startsWith(" ")) {
      flush();
      oldLine += 1;
    }
  }
  flush();
  return ranges;
}
