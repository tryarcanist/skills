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
    /review|bugbot/i.test(check.name || "")
  );
}
export function checkEvidence(check, annotations = []) {
  const body = [check.output?.title, check.output?.summary, check.output?.text]
    .filter(Boolean)
    .join("\n\n");
  const clear =
    /^\s*(?:AI review ran and left 0 comments|no (?:issues|bugs|findings)(?: were)? found|no findings)[.!]?\s*$/im.test(
      body,
    );
  const findings =
    annotations.length > 0 ||
    /\b[1-9]\d* (?:issues?|bugs?|findings?) (?:were )?found\b/i.test(body);
  const terminal = check.status === "completed";
  const eligible =
    terminal &&
    Boolean(check.completed_at) &&
    ["success", "neutral", "failure"].includes(check.conclusion);
  const reviewed =
    eligible && (findings || (clear && check.conclusion !== "failure"));
  const reviewState = reviewed
    ? "reviewed"
    : !terminal
      ? "pending"
      : ["skipped", "cancelled"].includes(check.conclusion)
        ? "not_run"
        : [
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
    verdict: reviewed ? (findings ? "issues_found" : "clear") : "unknown",
  };
}
export function checkPages(items) {
  if (!items.length || !items.every((p) => p && Array.isArray(p.check_runs)))
    throw new Error("Malformed check-runs response");
  return items.flatMap((p) => p.check_runs);
}
