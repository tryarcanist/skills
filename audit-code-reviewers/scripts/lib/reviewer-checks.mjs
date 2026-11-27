// Check conclusion alone does not prove that a code review ran.
export function checkIdentity(check) {
  return check.app?.slug ? `app:${check.app.slug.toLowerCase()}` : null;
}
export function isReviewerCheck(check, selected = []) {
  const id = checkIdentity(check);
  if (!id) return false;
  if (selected.length) return selected.includes(id);
  return (
    check.app.slug !== "github-actions" &&
    /review|bugbot|correctness check/i.test(check.name || "")
  );
}
export function checkEvidence(check, annotations = []) {
  const body = [check.output?.title, check.output?.summary, check.output?.text]
    .filter(Boolean)
    .join("\n\n");
  const macroscopeResult =
    /^(No issues|[1-9]\d* issues?) identified \(([1-9]\d*) code objects? reviewed\)\.$/.exec(
      check.output?.title || "",
    );
  const bugbotClear =
    /^\*\*Final Result:\*\* Bugbot completed review - no issues found!\s*(?:✅)?\s*$/m.test(
      check.output?.summary || "",
    );
  const bugbotFindings =
    /^\*\*Final Result:\*\* Bugbot completed review and found [1-9]\d* potential issues?\.\s*$/m.test(
      check.output?.summary || "",
    );
  const bugbotNoNewIssues =
    /^\*\*Final Result:\*\* Bugbot completed review - no new issues found!\s*(?:✅)?\s*$/m.test(
      check.output?.summary || "",
    );
  const commentsPublished =
    /^AI review ran and left [1-9]\d* comments?\s*$/m.test(
      check.output?.summary || "",
    );
  const failed = /^\*\*Result:\*\* Bugbot failed to run\s*$/m.test(
    check.output?.summary || "",
  );
  const cancelled = /^\*\*Result:\*\* Bugbot run cancelled because /m.test(
    check.output?.summary || "",
  );
  const statusOnly = /\bNo new review ran\b/.test(check.output?.summary || "");
  const clear =
    bugbotClear ||
    macroscopeResult?.[1] === "No issues" ||
    /^\s*(?:AI review ran and left 0 comments|no (?:issues|bugs|findings)(?: were)? found|no findings)[.!]?\s*$/im.test(
      body,
    );
  const findings =
    bugbotFindings ||
    (Boolean(macroscopeResult) && macroscopeResult[1] !== "No issues") ||
    annotations.length > 0 ||
    /\b[1-9]\d* (?:issues?|bugs?|findings?) (?:were )?found\b/i.test(body);
  const terminal = check.status === "completed";
  const eligible =
    terminal &&
    Boolean(check.completed_at) &&
    ["success", "neutral", "failure"].includes(check.conclusion);
  const reviewed =
    eligible &&
    !statusOnly &&
    !failed &&
    !cancelled &&
    (findings ||
      ((clear || bugbotNoNewIssues || commentsPublished) &&
        check.conclusion !== "failure"));
  const reviewState = reviewed
    ? "reviewed"
    : !terminal
      ? "pending"
      : statusOnly ||
          cancelled ||
          ["skipped", "cancelled"].includes(check.conclusion)
        ? "not_run"
        : failed ||
            [
              "failure",
              "timed_out",
              "action_required",
              "startup_failure",
            ].includes(check.conclusion)
          ? "failed"
          : "unknown";
  return {
    body,
    reviewState,
    verdict: reviewed
      ? findings
        ? "issues_found"
        : clear
          ? "clear"
          : "unknown"
      : "unknown",
  };
}
export function checkPages(items) {
  if (!items.length || !items.every((p) => p && Array.isArray(p.check_runs)))
    throw new Error("Malformed check-runs response");
  return items.flatMap((p) => p.check_runs);
}
