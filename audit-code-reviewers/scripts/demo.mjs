#!/usr/bin/env node
// Exercise the full local workflow with synthetic evidence. No network or model calls.
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
if (argv[0] === "--help") {
  process.stdout.write(
    "Usage: node demo.mjs --out <new-run-directory>\nCreates a clearly marked synthetic report through prepare, freeze-cold and report. No network or model calls.\n",
  );
  process.exit(0);
}
if (argv.length !== 2 || argv[0] !== "--out") {
  process.stderr.write("Usage: node demo.mjs --out <new-run-directory>\n");
  process.exit(2);
}
const out = resolve(argv[1]),
  scripts = dirname(fileURLToPath(import.meta.url));
if (existsSync(out)) {
  process.stderr.write("error: output already exists\n");
  process.exit(2);
}
const source = mkdtempSync(join(tmpdir(), "reviewer-audit-demo-"));
const put = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const invoke = (...args) =>
  execFileSync(
    process.execPath,
    [join(scripts, "audit-reviewers.mjs"), ...args],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
const repo = "example/synthetic-reviewer-audit",
  pr = 1,
  url = `https://github.com/${repo}/pull/1`;
const A = "a".repeat(40),
  B = "b".repeat(40),
  base = "c".repeat(40);
const ra = "reviewer-a[bot]",
  rb = "reviewer-b[bot]";
const events = [
  {
    id: "review-1",
    reviewer: ra,
    reviewedCommit: A,
    submittedAt: "2026-01-02T00:01:00Z",
    minutesToReview: 1,
    verdict: "clear",
    body: "",
  },
  {
    id: "review-2",
    reviewer: rb,
    reviewedCommit: A,
    submittedAt: "2026-01-02T00:02:00Z",
    minutesToReview: 2,
    verdict: "issues_found",
    body: "",
  },
  {
    id: "review-3",
    reviewer: ra,
    reviewedCommit: A,
    submittedAt: "2026-01-02T00:03:00Z",
    minutesToReview: 3,
    verdict: "issues_found",
    body: "",
  },
  {
    id: "issue-4",
    reviewer: ra,
    reviewedCommit: B,
    submittedAt: "2026-01-02T00:04:00Z",
    minutesToReview: 4,
    verdict: "issues_found",
    body: "",
  },
];
const instances = [
  {
    id: "inline-1",
    sourceId: "inline-1",
    reviewer: ra,
    reviewedCommit: A,
    reviewEventId: "review-3",
    url: `${url}#discussion_r1`,
    label: "confirmed",
    defectId: "shared",
    evidence: "Synthetic src/balance.js:8 permits a refund above the balance.",
    auditedSeverity: "major",
  },
  {
    id: "inline-2",
    sourceId: "inline-2",
    reviewer: rb,
    reviewedCommit: A,
    reviewEventId: "review-2",
    url: `${url}#discussion_r2`,
    label: "confirmed",
    defectId: "shared",
    evidence: "Synthetic src/balance.js:8 permits the same refund error.",
    auditedSeverity: "major",
  },
  {
    id: "inline-3",
    sourceId: "inline-3",
    reviewer: rb,
    reviewedCommit: A,
    reviewEventId: "review-2",
    url: `${url}#discussion_r3`,
    label: "incorrect",
    defectId: null,
    evidence:
      "Synthetic fixture has an explicit zero guard, contrary to the claim.",
  },
  {
    id: "issue-4-item-1",
    sourceId: "issue-4",
    reviewer: ra,
    reviewedCommit: B,
    reviewEventId: "issue-4",
    url: `${url}#issuecomment-4`,
    label: "confirmed",
    defectId: "unique",
    evidence: "Synthetic src/account.js:5 returns the previous account object.",
    auditedSeverity: "major",
  },
];
const defects = [
  {
    id: "shared",
    title: "Synthetic example: refund exceeds remaining balance",
    commit: A,
    introducedAt: A,
    fixedAt: null,
    presentAt: [A, B],
    absentAt: [],
    severity: "major",
    class: "correctness",
    foundBy: [ra, rb],
    evidence: "Synthetic input: refund 20 from balance 10 returns success.",
    evidenceUrl: `https://github.com/${repo}/blob/${A}/src/balance.js#L8`,
  },
  {
    id: "unique",
    title: "Synthetic example: wrong account after a switch",
    commit: B,
    introducedAt: B,
    fixedAt: null,
    presentAt: [B],
    absentAt: [A],
    severity: "major",
    class: "correctness",
    foundBy: [ra],
    evidence: "Synthetic input: switch from account X to Y returns X.",
    evidenceUrl: `https://github.com/${repo}/blob/${B}/src/account.js#L5`,
  },
];
const raw = {
  repo,
  pr,
  url,
  createdAt: "2026-01-02T00:00:00Z",
  authorType: "User",
  headSha: B,
  baseSha: base,
  commitOrder: [A, B],
  reviewEvents: events,
  reviewersByCommit: { [A]: [ra, rb], [B]: [ra] },
  findingInstances: instances.filter((i) => i.id.startsWith("inline-")),
  summaryComments: [
    {
      id: "issue-4",
      reviewer: ra,
      reviewedCommit: B,
      url: `${url}#issuecomment-4`,
      body: "Synthetic account defect.",
    },
  ],
  collectionWarnings: [],
};
mkdirSync(join(source, "raw"));
put(join(source, "raw/1.json"), raw);
try {
  invoke(
    "prepare",
    "--repo",
    repo,
    "--only",
    `${ra},${rb}`,
    "--provider",
    "synthetic-fixture",
    "--model",
    "deterministic expected labels",
    "--prs",
    "1",
    "--raw-dir",
    join(source, "raw"),
    "--out",
    out,
  );
  const manifest = read(join(out, "manifest.json"));
  manifest.evidenceKind = "synthetic";
  put(join(out, "manifest.json"), manifest);
  const cold = join(source, "cold.json");
  put(cold, {
    repo,
    pr,
    state: "observed",
    commits: [A, B],
    defects: defects.map(({ id, title, evidence }) => ({
      id,
      title,
      evidence,
    })),
    note: "Synthetic expected truth. No model or person evaluated these examples.",
  });
  invoke("freeze-cold", "--run", out, "--pr", "1", "--file", cold);
  const observation = read(join(out, "observations/prs/1.json"));
  put(join(out, "observations/prs/1.json"), {
    ...observation,
    reviewEvents: events,
    instances,
    defects,
    skeptic: {
      status: "upheld",
      evaluator: "synthetic expected truth",
      evidence:
        "Synthetic fixture labels supplied for the pipeline test. No real independent judge.",
      changes: [],
    },
  });
  put(join(out, "observations/engagement/1.json"), {
    repo,
    pr,
    authorIsBot: false,
    findings: instances.map((i) => ({
      instanceId: i.id,
      reviewer: i.reviewer,
      outcome: i.label === "incorrect" ? "rejected" : "none",
      humanWords: i.label === "incorrect",
      evidence: "Synthetic fixture outcome.",
    })),
  });
  put(join(out, "prices.json"), {
    currency: "USD",
    reviewers: [
      {
        reviewer: ra,
        monthlyCost: 200,
        avoidableMonthlyCost: 200,
        source: "Synthetic example price",
      },
      {
        reviewer: rb,
        monthlyCost: 100,
        avoidableMonthlyCost: 100,
        source: "Synthetic example price",
      },
    ],
  });
  invoke("report", "--run", out, "--prices", join(out, "prices.json"));
  process.stdout.write(`Synthetic example: ${join(out, "report.md")}\n`);
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
}
