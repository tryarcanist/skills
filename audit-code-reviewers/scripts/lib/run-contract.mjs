import { readFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

export const SCHEMA = "reviewer-audit-run-v3";
export const METHOD = "installed-reviewer-audit-v3";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
export function inside(root, path) {
  const full = resolve(root, path),
    rel = relative(root, full);
  requireValue(
    rel && !rel.startsWith("..") && !isAbsolute(rel),
    `Path must be inside the run: ${path}`,
  );
  return full;
}
export function loadManifest(path) {
  const manifest = readJson(path),
    root = dirname(resolve(path));
  requireValue(
    manifest.schemaVersion === SCHEMA && manifest.methodVersion === METHOD,
    "Unsupported manifest version. Prepare a new v3 run.",
  );
  requireValue(
    typeof manifest.runId === "string" && manifest.runId.length > 0,
    "Missing runId",
  );
  requireValue(
    /^[\w.-]+\/[\w.-]+$/.test(manifest.repo),
    "Invalid manifest repository",
  );
  requireValue(
    ["complete", "sample"].includes(manifest.mode),
    "Invalid population mode",
  );
  for (const key of ["selectedPrs", "populationPrs"]) {
    requireValue(
      Array.isArray(manifest[key]) &&
        manifest[key].every((n) => Number.isSafeInteger(n) && n > 0),
      `Invalid ${key}`,
    );
    requireValue(
      new Set(manifest[key]).size === manifest[key].length,
      `Duplicate ${key}`,
    );
  }
  requireValue(
    manifest.selectedPrs.length > 0,
    "No PRs selected. There is no audit to score.",
  );
  requireValue(
    manifest.selectedPrs.every((n) => manifest.populationPrs.includes(n)),
    "Selected PR outside the population",
  );
  requireValue(
    manifest.mode !== "complete" ||
      manifest.selectedPrs.length === manifest.populationPrs.length,
    "Incomplete population cannot use complete mode",
  );
  requireValue(
    manifest.mode !== "sample" || manifest.sample?.rule,
    "A sample requires its selection rule",
  );
  requireValue(
    manifest.window?.field &&
      manifest.scope &&
      manifest.evaluator?.provider &&
      manifest.evaluator?.model,
    "Missing window, scope, or evaluator",
  );
  requireValue(
    Array.isArray(manifest.reviewers) && manifest.reviewers.length > 0,
    "No declared reviewers",
  );
  const aliases = new Map();
  for (const r of manifest.reviewers) {
    requireValue(
      r.id &&
        r.reason &&
        ["observed", "not_measurable", "collection_failed"].includes(r.state),
      "Reviewer requires id, reason and measurement state",
    );
    requireValue(
      Array.isArray(r.logins) && r.logins.length > 0,
      `No logins for ${r.id}`,
    );
    for (const login of new Set(
      [r.id, ...r.logins].map((x) => String(x).toLowerCase()),
    )) {
      requireValue(!aliases.has(login), `Repeated reviewer alias ${login}`);
      aliases.set(login, r.id);
    }
  }
  requireValue(
    manifest.sourceHashes && typeof manifest.sourceHashes === "object",
    "Missing source hashes",
  );
  const required = [
    "corpus.json",
    ...manifest.selectedPrs.map((n) => `raw/${n}.json`),
  ];
  for (const file of required)
    requireValue(
      manifest.sourceHashes[file],
      `Missing frozen hash for ${file}`,
    );
  for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
    requireValue(/^[a-f0-9]{64}$/.test(expected), `Invalid hash for ${file}`);
    requireValue(
      sha256(readFileSync(inside(root, file))) === expected,
      `Frozen source hash changed: ${file}`,
    );
  }
  const corpus = readJson(inside(root, "corpus.json"));
  requireValue(
    corpus.repo === manifest.repo,
    "Corpus repository differs from manifest",
  );
  return { manifest, root, aliases };
}

export function validateObservation(doc, file, context) {
  const { manifest, aliases, root } = context;
  requireValue(
    doc.repo === manifest.repo &&
      manifest.selectedPrs.includes(doc.pr) &&
      file === `${doc.pr}.json`,
    `${file}: repository or PR differs from manifest`,
  );
  requireValue(
    ["upheld", "revised"].includes(doc.skeptic?.status),
    `PR ${doc.pr}: skeptic must uphold or reconcile the observations`,
  );
  requireValue(
    doc.skeptic.evaluator && doc.skeptic.evidence,
    `PR ${doc.pr}: skeptic requires evaluator and code evidence`,
  );
  for (const key of ["defects", "instances", "reviewEvents", "commitOrder"])
    requireValue(Array.isArray(doc[key]), `PR ${doc.pr}: missing ${key}`);
  requireValue(
    doc.reviewersByCommit && typeof doc.reviewersByCommit === "object",
    `PR ${doc.pr}: missing coverage map`,
  );
  const raw = readJson(inside(root, `raw/${doc.pr}.json`));
  requireValue(
    raw.repo === doc.repo && raw.pr === doc.pr,
    `PR ${doc.pr}: frozen source identity differs`,
  );
  requireValue(
    JSON.stringify(doc.commitOrder) === JSON.stringify(raw.commitOrder),
    `PR ${doc.pr}: commit identities differ from the frozen source`,
  );
  const canonical = (login) => {
    const id = aliases.get(String(login).toLowerCase());
    requireValue(id, `PR ${doc.pr}: undeclared reviewer ${login}`);
    return id;
  };
  for (const values of Object.values(doc.reviewersByCommit))
    requireValue(Array.isArray(values), "Invalid coverage map");
  doc.reviewersByCommit = Object.fromEntries(
    Object.entries(doc.reviewersByCommit).map(([sha, values]) => [
      sha,
      [...new Set(values.map(canonical))],
    ]),
  );
  const frozenCoverage = Object.fromEntries(
    Object.entries(raw.reviewersByCommit || {}).map(([sha, values]) => [
      sha,
      values.map(canonical),
    ]),
  );
  for (const [sha, values] of Object.entries(doc.reviewersByCommit)) {
    requireValue(
      values.every((id) => frozenCoverage[sha]?.includes(id)),
      `PR ${doc.pr}: coverage has no frozen source at ${sha}`,
    );
  }
  for (const [sha, values] of Object.entries(frozenCoverage))
    requireValue(
      values.every((id) => doc.reviewersByCommit[sha]?.includes(id)),
      `PR ${doc.pr}: frozen coverage omitted at ${sha}`,
    );
  const ids = new Set(),
    defects = new Map();
  for (const d of doc.defects) {
    requireValue(
      d.id && !defects.has(d.id),
      `PR ${doc.pr}: duplicate or missing defect id`,
    );
    requireValue(
      d.title &&
        d.evidence &&
        /^https:\/\//.test(d.evidenceUrl || "") &&
        ["blocking", "major", "minor", "nit"].includes(d.severity),
      `PR ${doc.pr} ${d.id}: missing defect evidence URL or severity`,
    );
    defects.set(d.id, d);
  }
  const events = new Map();
  for (const [index, event] of doc.reviewEvents.entries()) {
    event.reviewer = canonical(event.reviewer);
    requireValue(
      event.id != null && !events.has(String(event.id)),
      `PR ${doc.pr}: duplicate or missing review event id`,
    );
    const source = (raw.reviewEvents || []).find(
      (e) => String(e.id) === String(event.id),
    );
    requireValue(
      source &&
        canonical(source.reviewer) === event.reviewer &&
        source.reviewedCommit === event.reviewedCommit &&
        source.submittedAt === event.submittedAt,
      `PR ${doc.pr}: event ${event.id} differs from the frozen source`,
    );
    const { body, ...publication } = source;
    const validatedEvent = {
      ...publication,
      reviewer: event.reviewer,
      verdict: event.verdict,
    };
    doc.reviewEvents[index] = validatedEvent;
    events.set(String(event.id), validatedEvent);
  }
  requireValue(
    events.size === (raw.reviewEvents || []).length,
    `PR ${doc.pr}: review event omitted from observation`,
  );
  const confirmed = new Map();
  const sources = [
    ...(raw.findingInstances || []),
    ...(raw.summaryComments || []),
    ...(raw.reviewEvents || []).filter((e) => e.body?.trim()),
  ];
  for (const i of doc.instances) {
    requireValue(
      i.id && !ids.has(i.id),
      `PR ${doc.pr}: duplicate or missing instance id`,
    );
    ids.add(i.id);
    requireValue(
      i.delivery === undefined || ["published", "filtered_candidate"].includes(i.delivery),
      `PR ${doc.pr} ${i.id}: unknown delivery`,
    );
    i.reviewer = canonical(i.reviewer);
    requireValue(
      [
        "confirmed",
        "below_bar",
        "incorrect",
        "duplicate",
        "unverified",
        "drifted",
        "out_of_scope",
      ].includes(i.label),
      `PR ${doc.pr} ${i.id}: unknown label`,
    );
    requireValue(
      i.url && /^https:\/\//.test(i.url) && i.evidence,
      `PR ${doc.pr} ${i.id}: missing claim URL or evidence`,
    );
    const source = sources.find(
      (s) => String(s.id) === String(i.sourceId || i.id),
    );
    requireValue(
      source &&
        canonical(source.reviewer) === i.reviewer &&
        source.url === i.url,
      `PR ${doc.pr} ${i.id}: claim has no matching frozen source`,
    );
    const sourceEventId =
      source.reviewEventId ??
      ((raw.reviewEvents || []).some((e) => String(e.id) === String(source.id))
        ? source.id
        : null);
    if (sourceEventId != null) {
      requireValue(
        String(i.reviewEventId) === String(sourceEventId),
        `PR ${doc.pr} ${i.id}: publication event differs from frozen source`,
      );
    }
    if (i.reviewEventId != null) {
      const ev = events.get(String(i.reviewEventId));
      requireValue(
        ev &&
          ev.reviewer === i.reviewer &&
          ev.reviewedCommit === i.reviewedCommit,
        `PR ${doc.pr} ${i.id}: review event does not match`,
      );
    }
    if (
      ["confirmed", "incorrect", "below_bar"].includes(i.label) &&
      !i.duplicateOf
    ) {
      requireValue(
        /^[a-f0-9]{40}$/i.test(i.reviewedCommit || "") &&
          source.reviewedCommit === i.reviewedCommit &&
          doc.reviewersByCommit[i.reviewedCommit]?.includes(i.reviewer),
        `PR ${doc.pr} ${i.id}: ${i.label} requires the exact published commit`,
      );
    }
    if (i.label === "confirmed" && !i.duplicateOf) {
      requireValue(
        defects.has(i.defectId),
        `PR ${doc.pr} ${i.id}: confirmed instance has no defect`,
      );
      requireValue(
        i.reviewedCommit &&
          doc.reviewersByCommit[i.reviewedCommit]?.includes(i.reviewer),
        `PR ${doc.pr} ${i.id}: confirmed instance has no exact reviewed commit`,
      );
      requireValue(
        source.reviewedCommit === i.reviewedCommit,
        `PR ${doc.pr} ${i.id}: claim commit differs from frozen source`,
      );
      const set = confirmed.get(i.defectId) || new Set();
      if (i.delivery !== "filtered_candidate") set.add(i.reviewer);
      confirmed.set(i.defectId, set);
    } else if (!i.duplicateOf)
      requireValue(
        !i.defectId,
        `PR ${doc.pr} ${i.id}: only confirmed claims can credit a defect`,
      );
  }
  const disposition = doc.sourceDispositions || [];
  for (const source of sources) {
    if (
      doc.instances.some(
        (i) => String(i.sourceId || i.id) === String(source.id),
      )
    )
      continue;
    requireValue(
      disposition.some(
        (d) =>
          String(d.sourceId) === String(source.id) &&
          d.reason &&
          ["no_claims", "status_only", "duplicate_delivery"].includes(d.state),
      ),
      `PR ${doc.pr}: source ${source.id} requires claims or an explicit disposition`,
    );
  }
  for (const i of doc.instances) {
    if (i.label === "duplicate")
      requireValue(
        i.duplicateOf,
        `PR ${doc.pr} ${i.id}: duplicate requires duplicateOf`,
      );
    if (i.duplicateOf) {
      const original = doc.instances.find((x) => x.id === i.duplicateOf);
      requireValue(
        original &&
          !original.duplicateOf &&
          original.reviewer === i.reviewer &&
          (original.delivery ?? "published") === (i.delivery ?? "published") &&
          i.id !== i.duplicateOf,
        `PR ${doc.pr} ${i.id}: invalid duplicate target`,
      );
    }
  }
  for (const d of doc.defects) {
    const actual = [...(confirmed.get(d.id) || [])].sort();
    if (d.foundBy !== undefined)
      requireValue(
        JSON.stringify([...new Set(d.foundBy.map(canonical))].sort()) ===
          JSON.stringify(actual),
        `PR ${doc.pr} ${d.id}: foundBy disagrees with confirmed instances`,
      );
    d.foundBy = actual;
    if (Array.isArray(d.presentAt)) {
      requireValue(
        d.presentAt.every((sha) => doc.commitOrder.includes(sha)),
        `PR ${doc.pr} ${d.id}: unknown presence commit`,
      );
      requireValue(
        !(d.absentAt || []).some((sha) => d.presentAt.includes(sha)),
        `PR ${doc.pr} ${d.id}: conflicting presence evidence`,
      );
      requireValue(
        doc.instances
          .filter((i) => i.label === "confirmed" && i.defectId === d.id)
          .every((i) => d.presentAt.includes(i.reviewedCommit)),
        `PR ${doc.pr} ${d.id}: confirmed catch outside known presence`,
      );
    }
  }
  const coldPath = `cold/${doc.pr}.json`;
  requireValue(
    doc.coldReview?.artifact === coldPath && manifest.sourceHashes[coldPath],
    `PR ${doc.pr}: cold evidence is not frozen`,
  );
  const cold = readJson(inside(root, coldPath));
  requireValue(
    cold.repo === doc.repo &&
      cold.pr === doc.pr &&
      ["observed", "not_measurable"].includes(cold.state) &&
      doc.coldReview.state === cold.state &&
      Array.isArray(cold.defects),
    `PR ${doc.pr}: invalid cold evidence`,
  );
  if (cold.state === "observed") {
    requireValue(
      JSON.stringify(doc.coldReview.commits) === JSON.stringify(cold.commits),
      `PR ${doc.pr}: cold commit identities differ from frozen evidence`,
    );
  } else
    requireValue(
      cold.reason,
      `PR ${doc.pr}: cold limitation requires a reason`,
    );
  doc.coldReview = {
    state: cold.state,
    artifact: coldPath,
    commits: cold.commits || [],
    ...(cold.reason ? { reason: cold.reason } : {}),
  };
  const coldIds = new Set(cold.defects.map((d) => d.id));
  requireValue(
    coldIds.size === cold.defects.length &&
      cold.defects.every(
        (d) => typeof d.id === "string" && d.id && d.title && d.evidence,
      ),
    `PR ${doc.pr}: invalid frozen cold finding`,
  );
  const coldDispositions = doc.coldDispositions || [];
  requireValue(
    Array.isArray(coldDispositions),
    `PR ${doc.pr}: invalid cold dispositions`,
  );
  for (const d of doc.defects) {
    requireValue(
      d.coldDefectIds === undefined ||
        (Array.isArray(d.coldDefectIds) &&
          d.coldDefectIds.every((id) => coldIds.has(id))),
      `PR ${doc.pr} ${d.id}: unknown cold finding reference`,
    );
  }
  for (const disposition of coldDispositions) {
    requireValue(
      coldIds.has(disposition.coldDefectId) &&
        disposition.evidence &&
        ["incorrect", "unverified", "out_of_scope"].includes(disposition.state),
      `PR ${doc.pr}: invalid cold finding disposition`,
    );
  }
  for (const id of coldIds) {
    const mapped = doc.defects.filter(
      (d) => d.id === id || d.coldDefectIds?.includes(id),
    );
    const dispositions = coldDispositions.filter((d) => d.coldDefectId === id);
    requireValue(
      mapped.length + dispositions.length === 1,
      `PR ${doc.pr}: cold finding ${id} requires one defect mapping or disposition`,
    );
  }
  doc.authorType = raw.authorType ?? doc.authorType ?? null;
  return doc;
}
