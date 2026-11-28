import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const skill = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40);
const ra = "reviewer-a[bot]",
  rb = "reviewer-b[bot]";
const repo = "fixture/repo";
const url = "https://github.com/fixture/repo/pull/1";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const put = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
function doc() {
  return {
    repo,
    pr: 1,
    url,
    authorType: "Bot",
    createdAt: "2026-01-02T00:00:00Z",
    skeptic: {
      status: "upheld",
      evaluator: "independent-fixture",
      evidence: "Inspected fixture mechanisms.",
      changes: [],
    },
    coldReview: { state: "observed", commits: [A], artifact: "cold/1.json" },
    commitOrder: [A, B],
    reviewersByCommit: { [A]: [ra, rb] },
    reviewEvents: [ra, rb].map((reviewer, i) => ({
      id: `review-${i + 1}`,
      reviewer,
      reviewedCommit: A,
      reviewedCommitSource: "native",
      submittedAt: "2026-01-02T00:01:00Z",
      verdict: "unknown",
      minutesToReview: 1,
    })),
    instances: [],
    defects: [],
  };
}
function defect(id = "d1", foundBy = [ra]) {
  return {
    id,
    title: `Wrong output ${id}`,
    commit: A,
    introducedAt: A,
    fixedAt: null,
    presentAt: [A],
    absentAt: [B],
    severity: "major",
    class: "correctness",
    foundBy,
    evidence: "src/value.js:1 returns 0 for a positive input.",
    evidenceUrl: `https://github.com/${repo}/blob/${A}/src/value.js#L1`,
  };
}
function inst(reviewer = ra, id = "i1", defectId = "d1") {
  return {
    id,
    reviewer,
    label: "confirmed",
    defectId,
    reviewedCommit: A,
    reviewEventId: reviewer === ra ? "review-1" : "review-2",
    auditedSeverity: "major",
    class: "correctness",
    url: `${url}#discussion_r${id}`,
    evidence: "Read src/value.js:1 at the pinned commit.",
    duplicateOf: null,
  };
}
function fixture(d = doc(), reviewers = [ra, rb]) {
  const root = mkdtempSync(join(tmpdir(), "reviewer-audit-test-"));
  const dir = join(root, "observations/prs");
  mkdirSync(dir, { recursive: true });
  put(join(dir, "1.json"), d);
  put(join(root, "raw/1.json"), {
    ...d,
    headSha: B,
    baseSha: C,
    findingInstances: d.instances,
    summaryComments: [],
    collectionWarnings: [],
  });
  put(join(root, "cold/1.json"), {
    repo,
    pr: 1,
    commits: [A],
    defects: [],
    state: "observed",
  });
  put(join(root, "corpus.json"), { repo, prs: [{ number: 1 }], warnings: [] });
  const manifest = {
    schemaVersion: "reviewer-audit-run-v3",
    methodVersion: "installed-reviewer-audit-v3",
    runId: "fixture-run",
    repo,
    mode: "sample",
    window: {
      field: "explicit_prs",
      from: "2026-01-01T00:00:00Z",
      toExclusive: "2026-02-01T00:00:00Z",
    },
    populationPrs: [1],
    selectedPrs: [1],
    sample: { rule: "explicit PR selection" },
    scope: "introduced correctness defects",
    reviewers: reviewers.map((id) => ({
      id,
      logins: [id],
      reason: "fixture reviewer",
      state: "observed",
    })),
    evaluator: { provider: "fixture", model: "fixture" },
    collectorWarnings: [],
    excludedPrs: [],
    excludedIdentities: [],
    sourceHashes: Object.fromEntries(
      ["corpus.json", "raw/1.json", "cold/1.json"].map((p) => [
        p,
        hash(readFileSync(join(root, p))),
      ]),
    ),
  };
  put(join(root, "manifest.json"), manifest);
  return { root, dir, manifest };
}
function score(f, extra = []) {
  const p = spawnSync(
    process.execPath,
    [
      join(skill, "scripts/score-corpus.mjs"),
      "--dir",
      f.dir,
      "--prs",
      "1",
      "--out",
      join(f.root, "report.md"),
      "--json",
      join(f.root, "aggregate.json"),
      ...extra,
    ],
    { encoding: "utf8" },
  );
  return {
    ...p,
    aggregate: existsSync(join(f.root, "aggregate.json"))
      ? read(join(f.root, "aggregate.json"))
      : null,
    report: existsSync(join(f.root, "report.md"))
      ? readFileSync(join(f.root, "report.md"), "utf8")
      : "",
  };
}
const row = (r, login = ra) =>
  r.aggregate.reviewers.find((x) => x.login === login);
const ok = (r) => assert.equal(r.status, 0, r.stderr);

test("extra attempts remain installed performance, never a quality ranking", () => {
  const d = doc();
  d.defects = Array.from({ length: 12 }, (_, i) => defect(`d${i}`, [rb]));
  d.instances = d.defects.map((x, i) => inst(rb, `i${i}`, x.id));
  const r = score(fixture(d));
  ok(r);
  assert.equal(r.aggregate.rankingAllowed, false);
  assert.doesNotMatch(
    r.report,
    /table to rank on|no one is credited for being triggered more often/,
  );
});
test("a later run on the same SHA receives no first-event credit", () => {
  const d = doc();
  d.defects = [defect()];
  d.reviewEvents.push({
    ...d.reviewEvents[0],
    id: "review-3",
    submittedAt: "2026-01-03T00:00:00Z",
  });
  d.instances = [{ ...inst(), reviewEventId: "review-3", reviewId: 3 }];
  const r = score(fixture(d));
  ok(r);
  assert.deepEqual(row(r).firstLook, { opp: 1, found: 0 });
});
test("an unresolved fix cannot become a miss for a later reviewer", () => {
  const d = doc();
  d.reviewersByCommit = { [A]: [ra], [B]: [rb] };
  d.defects = [
    { ...defect(), fixedAt: C, presentAt: undefined, absentAt: undefined },
  ];
  d.instances = [inst()];
  const r = score(fixture(d));
  ok(r);
  assert.equal(row(r, rb).opportunity, 0);
  assert.match(r.report, /unresolved|ambiguous|not measurable/i);
});
test("a missing engagement entry stays unknown, including author type", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [inst()];
  const f = fixture(d);
  put(join(f.root, "observations/engagement/1.json"), {
    repo,
    pr: 1,
    authorIsBot: true,
    findings: [],
  });
  const r = score(f, ["--engagement", join(f.root, "observations/engagement")]);
  ok(r);
  assert.equal(row(r).eng.none, 0);
  assert.equal(row(r).eng.userAccountN, 0);
  assert.equal(row(r).engMissing, 1);
});
test("an invalid declared observation stops the report", () => {
  const f = fixture();
  f.manifest.selectedPrs.push(2);
  f.manifest.populationPrs.push(2);
  put(join(f.root, "manifest.json"), f.manifest);
  writeFileSync(join(f.dir, "2.json"), "{broken");
  const r = score(f, ["--prs", "1,2"]);
  assert.notEqual(r.status, 0);
  assert.equal(r.aggregate, null);
});
test("stale foundBy credit without a confirmed instance stops the report", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [{ ...inst(), label: "incorrect", defectId: null }];
  const r = score(fixture(d));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /foundBy|confirmed/);
});
test("pairwise counts survive the JSON export", () => {
  const d = doc();
  d.defects = [defect("d1", [ra, rb])];
  d.instances = [inst(), inst(rb, "i2")];
  const r = score(fixture(d));
  ok(r);
  assert.equal(row(r).pairFound[rb], 1);
  assert.equal(row(r).pairOpp[rb], 1);
});
test("a manifest reviewer with unavailable evidence remains visible", () => {
  const f = fixture(doc(), [ra, rb, "reviewer-c[bot]"]);
  f.manifest.reviewers[2].state = "not_measurable";
  put(join(f.root, "manifest.json"), f.manifest);
  const r = score(f);
  ok(r);
  assert.equal(r.aggregate.reviewers.length, 3);
  assert.match(r.report, /not_measurable/);
});
test("a changed frozen source stops the report", () => {
  const f = fixture();
  put(join(f.root, "raw/1.json"), { changed: true });
  const r = score(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /hash|changed/);
});
test("an observation from another repository stops the report", () => {
  const d = doc();
  d.repo = "other/repo";
  const r = score(fixture(d));
  assert.notEqual(r.status, 0);
});
test("a verified catch has claim and code evidence in the report", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [inst()];
  const r = score(fixture(d));
  ok(r);
  assert.ok(r.report.includes(d.instances[0].url));
  assert.ok(r.report.includes(d.defects[0].evidenceUrl));
});
test("known price produces conditional savings and unique coverage at risk", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [inst()];
  const f = fixture(d);
  put(join(f.root, "prices.json"), {
    currency: "USD",
    reviewers: [
      {
        reviewer: ra,
        monthlyCost: 100,
        avoidableMonthlyCost: 80,
        source: "Customer invoice",
      },
    ],
  });
  const r = score(f, ["--prices", join(f.root, "prices.json")]);
  ok(r);
  const s = r.aggregate.savings.find((x) => x.reviewer === ra);
  assert.equal(s.conditionalAnnualSavings, 960);
  assert.equal(s.uniqueCatchesAtRisk, 1);
  assert.match(r.report, /conditional/i);
});

function githubFixture({
  summary = "",
  oldReview = false,
  checks = [],
  annotations = [],
} = {}) {
  const f = fixture();
  mkdirSync(join(f.root, "bin"));
  const data = {
    checks,
    annotations,
    pr: {
      number: 1,
      title: "Fixture",
      html_url: url,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-04T00:00:00Z",
      author: "human",
      authorType: "User",
      user: { login: "human" },
      head: B,
      base: "0".repeat(40),
      baseRef: "main",
    },
    commits: [A, B].map((sha, i) => ({
      sha,
      commit: {
        message: "Fixture",
        author: { date: i ? "2025-12-01T00:00:00Z" : "2026-01-01T00:00:00Z" },
        committer: {
          date: i ? "2026-01-03T00:00:00Z" : "2026-01-01T00:00:00Z",
        },
      },
    })),
    comments: summary
      ? [
          {
            id: 1,
            user: { login: ra, type: "Bot" },
            body: summary,
            created_at: "2026-01-02T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
            html_url: `${url}#issuecomment-1`,
          },
        ]
      : [],
    reviews: oldReview
      ? [
          {
            id: 7,
            user: { login: ra, type: "Bot" },
            commit_id: A,
            submitted_at: "2025-12-01T00:00:00Z",
          },
        ]
      : [],
  };
  put(join(f.root, "github.json"), data);
  writeFileSync(
    join(f.root, "bin/gh"),
    `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const f = JSON.parse(fs.readFileSync(path.join(__dirname,'../github.json'))); const a=process.argv.slice(2), p=a[1]; let v;
if (p === 'graphql') v={data:{repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}};
else if (p === 'repos/fixture/repo/pulls/1') v=f.pr;
else if (p.startsWith('repos/fixture/repo/pulls?')) v=[f.pr];
else if (p.includes('/check-runs?')) v={check_runs:f.checks.filter(c=>p.includes(c.head_sha))};
else if (p.includes('/annotations?')) v=f.annotations;
else if (p.includes('/commits?')) v=f.commits;
else if (p.includes('/reviews?')) v=f.reviews;
else if (p.startsWith('repos/fixture/repo/issues/1/comments?')) v=f.comments;
else if (p.includes('/comments?') || p.includes('/timeline?')) v=[];
else { process.stderr.write('Unexpected request '+p); process.exit(1); }
process.stdout.write(JSON.stringify(a.includes('--slurp')?[v]:v));
`,
    { mode: 0o755 },
  );
  return {
    ...f,
    env: { ...process.env, PATH: join(f.root, "bin") + ":" + process.env.PATH },
  };
}
function fetch(f, reviewers = ra) {
  const p = spawnSync(
    process.execPath,
    [
      join(skill, "scripts/fetch-pr-reviews.mjs"),
      "--repo",
      repo,
      "--pr",
      "1",
      "--only",
      reviewers,
      "--out",
      join(f.root, "fetched.json"),
    ],
    { encoding: "utf8", env: f.env },
  );
  assert.equal(p.status, 0, p.stderr);
  return read(join(f.root, "fetched.json"));
}
test("an unpinned summary does not invent reviewed-commit exposure", () => {
  const r = fetch(githubFixture({ summary: "There is a wrong output." }));
  assert.equal(r.summaryComments[0].reviewedCommit, null);
  assert.deepEqual(r.reviewersByCommit, {});
});
test("a pinned summary has a review event and publication latency", () => {
  const r = fetch(
    githubFixture({
      summary: `Reviewed commit: ${A}. There is a wrong output.`,
    }),
  );
  assert.equal(r.reviewEvents.length, 1);
  assert.equal(r.reviewEvents[0].id, "issue-1");
  assert.equal(r.reviewEvents[0].minutesToReview, 1440);
});
test("summary publication markers retain the exact reviewed head", () => {
  for (const marker of [
    `<!-- arcanist-review-qa:v1 owner=fixture repo=repo pr=1 head=${A} verdict=clear -->`,
    `<!-- arcanist-review-publication:v2 head=${A} session=fixture -->`,
  ]) {
    const r = fetch(githubFixture({ summary: marker }));
    assert.equal(r.summaryComments[0].reviewedCommit, A);
    assert.equal(r.reviewEvents[0].reviewedCommit, A);
    assert.deepEqual(r.reviewersByCommit, { [A]: [ra] });
  }
});
test("a summary retains a full historical pin after a force push", () => {
  const r = fetch(githubFixture({ summary: `Reviewed commit: ${C}` }));
  assert.equal(r.summaryComments[0].reviewedCommit, C);
  assert.equal(r.reviewEvents[0].reviewedCommit, C);
  assert.deepEqual(r.unresolvableCommits, [C]);
});
test("unrelated or malformed head metadata cannot grant reviewed exposure", () => {
  for (const summary of [
    `<!-- build:v1 head=${A} -->`,
    `<!-- arcanist-review-publication:v2 head=${A}f session=fixture -->`,
    `Current head=${A}`,
  ]) {
    const r = fetch(githubFixture({ summary }));
    assert.equal(r.summaryComments[0].reviewedCommit, null);
    assert.deepEqual(r.reviewersByCommit, {});
  }
});
test("native reviews outside the window do not enter the roster", () => {
  const f = githubFixture({ oldReview: true });
  const p = spawnSync(
    process.execPath,
    [
      join(skill, "scripts/collect-review-corpus.mjs"),
      "--repo",
      repo,
      "--since",
      "2026-01-01",
      "--until",
      "2026-02-01",
      "--only",
      ra,
      "--out",
      join(f.root, "collected.json"),
    ],
    { encoding: "utf8", env: f.env },
  );
  assert.equal(p.status, 0, p.stderr);
  assert.equal(read(join(f.root, "collected.json")).roster.length, 0);
});
test("PRs with no published reviewer output remain in the population", () => {
  const f = githubFixture();
  const p = spawnSync(
    process.execPath,
    [
      join(skill, "scripts/collect-review-corpus.mjs"),
      "--repo",
      repo,
      "--since",
      "2026-01-01",
      "--until",
      "2026-02-01",
      "--only",
      ra,
      "--out",
      join(f.root, "collected.json"),
    ],
    { encoding: "utf8", env: f.env },
  );
  assert.equal(p.status, 0, p.stderr);
  assert.equal(read(join(f.root, "collected.json")).prs.length, 1);
});

test("a fabricated claim source stops the report", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [inst()];
  const f = fixture(d);
  d.instances[0].url = `${url}#invented`;
  put(join(f.dir, "1.json"), d);
  const r = score(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /frozen source/);
});
test("an omitted published claim stops the report", () => {
  const d = doc();
  d.instances = [{ ...inst(), label: "incorrect", defectId: null }];
  const f = fixture(d);
  d.instances = [];
  put(join(f.dir, "1.json"), d);
  const r = score(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /disposition/);
});
test("an unrun skeptic cannot produce the report", () => {
  const d = doc();
  d.skeptic = { status: "not_run" };
  const r = score(fixture(d));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /skeptic/);
});
test("a missing cold review cannot produce the report", () => {
  const d = doc();
  delete d.coldReview;
  const r = score(fixture(d));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cold/i);
});
test("a frozen cold finding cannot disappear from the report", () => {
  const f = fixture();
  const cold = read(join(f.root, "cold/1.json"));
  cold.defects = [
    {
      id: "cold-1",
      title: "Wrong output",
      evidence: "src/value.js:1 returns 0.",
    },
  ];
  put(join(f.root, "cold/1.json"), cold);
  f.manifest.sourceHashes["cold/1.json"] = hash(
    readFileSync(join(f.root, "cold/1.json")),
  );
  put(join(f.root, "manifest.json"), f.manifest);
  const r = score(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cold.*(finding|defect|disposition)/i);
});
test("an incorrect claim requires its exact published commit", () => {
  const d = doc();
  d.instances = [
    {
      ...inst(),
      label: "incorrect",
      defectId: null,
      reviewedCommit: null,
      reviewEventId: null,
    },
  ];
  const r = score(fixture(d));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exact|commit/i);
});
test("a changed observation cannot erase the frozen commit identities", () => {
  const f = fixture();
  const d = read(join(f.dir, "1.json"));
  d.commitOrder = [];
  put(join(f.dir, "1.json"), d);
  const r = score(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /commit/i);
});
test("a claim cannot move to another publication on the same commit", () => {
  const d = doc();
  d.defects = [defect()];
  d.reviewEvents.push({
    ...d.reviewEvents[0],
    id: "review-3",
    submittedAt: "2026-01-03T00:00:00Z",
  });
  d.instances = [{ ...inst(), reviewEventId: "review-3" }];
  const f = fixture(d);
  d.instances[0].reviewEventId = "review-1";
  put(join(f.dir, "1.json"), d);
  const r = score(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /event|publication/i);
});
test("edited publication metadata stays frozen when observations omit it", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [inst()];
  d.reviewEvents[0].kind = "summary";
  d.reviewEvents[0].editedInPlace = true;
  const f = fixture(d);
  delete d.reviewEvents[0].editedInPlace;
  d.reviewEvents[0].minutesToReview = 0;
  put(join(f.dir, "1.json"), d);
  const r = score(f);
  ok(r);
  assert.deepEqual(row(r).firstLook, { opp: 0, found: 0 });
  assert.equal(row(r).medianMinutesToReview, 1);
});
test("cold findings can be merged or explicitly rejected with evidence", () => {
  for (const disposition of [false, true]) {
    const d = doc();
    if (disposition)
      d.coldDispositions = [
        {
          coldDefectId: "cold-1",
          state: "incorrect",
          evidence: "src/value.js:2 checks the input first.",
        },
      ];
    else d.defects = [{ ...defect("merged", []), coldDefectIds: ["cold-1"] }];
    const f = fixture(d);
    const cold = read(join(f.root, "cold/1.json"));
    cold.defects = [
      {
        id: "cold-1",
        title: "Wrong output",
        evidence: "src/value.js:1 returns 0.",
      },
    ];
    put(join(f.root, "cold/1.json"), cold);
    f.manifest.sourceHashes["cold/1.json"] = hash(
      readFileSync(join(f.root, "cold/1.json")),
    );
    put(join(f.root, "manifest.json"), f.manifest);
    const r = score(f);
    ok(r);
    assert.equal(r.aggregate.allDefects, disposition ? 0 : 1);
  }
});
test("duplicate delivery counts one catch and one repeated instance", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [
    inst(),
    { ...inst(ra, "repeat"), label: "duplicate", duplicateOf: "i1" },
  ];
  const r = score(fixture(d));
  ok(r);
  assert.equal(row(r).installedFound, 1);
  assert.equal(row(r).instances, 1);
  assert.equal(row(r).repeatInstances, 1);
});
test("unknown avoidable cost stays unknown and invalid prices stop reporting", () => {
  const f = fixture();
  const path = join(f.root, "prices.json");
  put(path, {
    currency: "USD",
    reviewers: [
      { reviewer: ra, monthlyCost: 100, source: "Synthetic invoice" },
    ],
  });
  const r = score(f, ["--prices", path]);
  ok(r);
  assert.equal(r.aggregate.savings[0].conditionalAnnualSavings, null);
  for (const avoidableMonthlyCost of [-1, 101, "10"]) {
    put(path, {
      currency: "USD",
      reviewers: [
        {
          reviewer: ra,
          monthlyCost: 100,
          avoidableMonthlyCost,
          source: "Synthetic invoice",
        },
      ],
    });
    const invalid = score(f, ["--prices", path]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /avoidable/i);
  }
});
test("a User account does not establish human authorship", () => {
  const d = doc();
  d.authorType = "User";
  d.defects = [defect()];
  d.instances = [inst()];
  const f = fixture(d);
  put(join(f.root, "observations/engagement/1.json"), {
    repo,
    pr: 1,
    authorIsBot: false,
    findings: [
      {
        instanceId: "i1",
        reviewer: ra,
        outcome: "fixed",
        humanWords: false,
        evidence: "Automated reply and inspected fix.",
      },
    ],
  });
  const r = score(f, ["--engagement", join(f.root, "observations/engagement")]);
  ok(r);
  assert.equal(row(r).eng.hN, undefined);
  assert.equal(row(r).eng.userAccountN, 1);
  assert.equal(row(r).eng.humanWords, 0);
});
test("an unavailable blind review remains an explicit report limitation", () => {
  const d = doc();
  const reason = "Reviewer output entered context before code inspection.";
  d.coldReview = {
    state: "not_measurable",
    artifact: "cold/1.json",
    commits: [],
  };
  const f = fixture(d);
  put(join(f.root, "cold/1.json"), {
    repo,
    pr: 1,
    state: "not_measurable",
    reason,
    defects: [],
  });
  f.manifest.sourceHashes["cold/1.json"] = hash(
    readFileSync(join(f.root, "cold/1.json")),
  );
  put(join(f.root, "manifest.json"), f.manifest);
  const r = score(f);
  ok(r);
  assert.equal(r.aggregate.evaluations?.[0].coldReview.state, "not_measurable");
  assert.ok(r.report.includes(reason));
});
test("malformed engagement cannot silently disappear", () => {
  const f = fixture();
  mkdirSync(join(f.root, "observations/engagement"));
  writeFileSync(join(f.root, "observations/engagement/1.json"), "{broken");
  const r = score(f, ["--engagement", join(f.root, "observations/engagement")]);
  assert.notEqual(r.status, 0);
});
test("complete population preparation requires affirmative collection proof", () => {
  for (const details of [
    { collectionComplete: false },
    { collectionComplete: true, totals: { sweep: { capHit: true } } },
    {},
  ]) {
    const f = fixture();
    put(join(f.root, "population.json"), {
      repo,
      prs: [{ number: 1 }],
      windowAppliedTo: "activity",
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00Z",
      ...details,
    });
    const p = spawnSync(
      process.execPath,
      [
        join(skill, "scripts/audit-reviewers.mjs"),
        "prepare",
        "--repo",
        repo,
        "--only",
        `${ra},${rb}`,
        "--provider",
        "fixture",
        "--model",
        "fixture",
        "--corpus",
        join(f.root, "population.json"),
        "--raw-dir",
        join(f.root, "raw"),
        "--out",
        join(f.root, "prepared"),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /collection|cap/i);
  }
});
test("window preparation keeps the start, excludes the end and preserves later discussion", () => {
  const d = doc();
  const start = "2026-01-01T00:00:00Z",
    end = "2026-02-01T00:00:00Z";
  d.reviewEvents[0].submittedAt = start;
  d.reviewEvents[1].submittedAt = end;
  const edited = {
    id: "issue-3",
    kind: "summary",
    reviewer: ra,
    reviewedCommit: B,
    submittedAt: "2026-02-02T00:00:00Z",
    body: "New body after the window",
    url: `${url}#issuecomment-3`,
  };
  d.reviewEvents.push(edited);
  const f = fixture(d),
    raw = read(join(f.root, "raw/1.json"));
  raw.summaryComments = [
    {
      ...edited,
      createdAt: start,
      updatedAt: edited.submittedAt,
      editedInPlace: true,
    },
  ];
  put(join(f.root, "raw/1.json"), raw);
  put(join(f.root, "population.json"), {
    repo,
    prs: [{ number: 1 }],
    collectionComplete: true,
    since: start,
    until: end,
    windowAppliedTo: "activity",
  });
  const run = join(f.root, "prepared");
  const p = spawnSync(
    process.execPath,
    [
      join(skill, "scripts/audit-reviewers.mjs"),
      "prepare",
      "--repo",
      repo,
      "--only",
      `${ra},${rb}`,
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "--corpus",
      join(f.root, "population.json"),
      "--raw-dir",
      join(f.root, "raw"),
      "--out",
      run,
    ],
    { encoding: "utf8" },
  );
  assert.equal(p.status, 0, p.stderr);
  const actual = read(join(run, "raw/1.json"));
  assert.deepEqual(
    actual.reviewEvents.map((x) => x.id),
    ["review-1"],
  );
  assert.equal(actual.summaryComments.length, 0);
  assert.deepEqual(actual.reviewersByCommit, { [A]: [ra] });
  assert.equal(actual.followupEvidence.reviewEvents.length, 3);
  assert.equal(actual.followupEvidence.summaryComments[0].body, edited.body);
});
test("a fresh copied installation runs prepare, cold freeze and report offline", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [inst()];
  const f = fixture(d);
  const installed = join(f.root, "fresh installation");
  cpSync(skill, installed, { recursive: true });
  const run = join(f.root, "complete run");
  const invoke = (...args) =>
    spawnSync(
      process.execPath,
      [join(installed, "scripts/audit-reviewers.mjs"), ...args],
      { encoding: "utf8", cwd: tmpdir() },
    );
  let p = invoke(
    "prepare",
    "--repo",
    repo,
    "--only",
    `${ra},${rb}`,
    "--provider",
    "fixture",
    "--model",
    "deterministic truth",
    "--prs",
    "1",
    "--raw-dir",
    join(f.root, "raw"),
    "--out",
    run,
  );
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(read(join(run, "inputs/1.json")).commits, [A, B]);
  assert.equal(
    readFileSync(join(run, "inputs/1.json"), "utf8").includes("Wrong output"),
    false,
  );
  p = invoke("report", "--run", run);
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /skeptic/);
  put(join(f.root, "incomplete-cold.json"), {
    repo,
    pr: 1,
    state: "observed",
    commits: [B],
    defects: [],
  });
  p = invoke(
    "freeze-cold",
    "--run",
    run,
    "--pr",
    "1",
    "--file",
    join(f.root, "incomplete-cold.json"),
  );
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /historical commit/);
  put(join(f.root, "complete-cold.json"), {
    repo,
    pr: 1,
    state: "observed",
    commits: [A, B],
    defects: [],
  });
  p = invoke(
    "freeze-cold",
    "--run",
    run,
    "--pr",
    "1",
    "--file",
    join(f.root, "complete-cold.json"),
  );
  assert.equal(p.status, 0, p.stderr);
  const cold = read(join(run, "observations/prs/1.json")).coldReview;
  put(join(run, "observations/prs/1.json"), { ...d, coldReview: cold });
  p = invoke("report", "--run", run);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(read(join(run, "aggregate.json")).reviewers[0].found, 1);
  assert.ok(read(join(run, "result-hashes.json")).hashes["report.md"]);
  assert.equal(
    read(join(run, "result-hashes.json")).toolHashes?.[
      "scripts/lib/run-contract.mjs"
    ],
    hash(readFileSync(join(installed, "scripts/lib/run-contract.mjs"))),
  );
  p = invoke(
    "prepare",
    "--repo",
    repo,
    "--only",
    ra,
    "--provider",
    "fixture",
    "--model",
    "fixture",
    "--prs",
    "1",
    "--out",
    run,
  );
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /exists/);
});

function reviewerCheck(overrides = {}) {
  return {
    id: 99,
    name: "AI code review",
    app: { slug: "fixture-reviewer" },
    head_sha: A,
    status: "completed",
    conclusion: "success",
    completed_at: "2026-01-02T00:02:00Z",
    html_url: `${url}/checks?check_run_id=99`,
    output: {
      title: "Review",
      summary: "AI review ran and left 0 comments",
      text: null,
      annotations_count: 0,
    },
    ...overrides,
  };
}
test("check-only reviews grant exact-commit coverage without a manual import", () => {
  const r = fetch(
    githubFixture({ checks: [reviewerCheck()] }),
    "app:fixture-reviewer",
  );
  assert.deepEqual(r.reviewersByCommit, { [A]: ["app:fixture-reviewer"] });
  assert.equal(r.reviewEvents[0].verdict, "clear");
  assert.equal(r.checkRuns.length, 1);
});
test("skipped, failed and unrecognized checks never grant review coverage", () => {
  for (const check of [
    reviewerCheck({ conclusion: "skipped" }),
    reviewerCheck({
      conclusion: "failure",
      output: { summary: "Service failed", annotations_count: 0 },
    }),
    reviewerCheck({ output: { summary: "OK", annotations_count: 0 } }),
    reviewerCheck({
      output: {
        summary: "No findings available: request did not run",
        annotations_count: 0,
      },
    }),
    reviewerCheck({ completed_at: null }),
  ]) {
    const r = fetch(githubFixture({ checks: [check] }), "app:fixture-reviewer");
    assert.deepEqual(r.reviewersByCommit, {});
    assert.equal(r.checkRuns.length, 1);
    assert.notEqual(r.checkRuns[0].reviewState, "reviewed");
  }
});
test("check annotations preserve findings and exact code identity", () => {
  const r = fetch(
    githubFixture({
      checks: [
        reviewerCheck({
          conclusion: "failure",
          output: { summary: "1 issue found", annotations_count: 1 },
        }),
      ],
      annotations: [
        {
          path: "src/value.js",
          start_line: 2,
          end_line: 2,
          annotation_level: "failure",
          title: "Wrong output",
          message: "Returns zero for positive input",
        },
      ],
    }),
    "app:fixture-reviewer",
  );
  assert.equal(r.findingInstances.length, 1);
  assert.equal(r.findingInstances[0].reviewedCommit, A);
  assert.match(r.findingInstances[0].body, /Returns zero/);
});
test("discovery includes a check-only reviewer and excludes ordinary CI", () => {
  const f = githubFixture({
    checks: [
      reviewerCheck(),
      reviewerCheck({
        id: 101,
        name: "Macroscope - Correctness Check",
        app: { slug: "macroscopeapp" },
      }),
      reviewerCheck({
        id: 100,
        name: "build",
        app: { slug: "github-actions" },
      }),
    ],
  });
  const p = spawnSync(
    process.execPath,
    [
      join(skill, "scripts/collect-review-corpus.mjs"),
      "--repo",
      repo,
      "--since",
      "2026-01-01",
      "--until",
      "2026-02-01",
      "--no-ready-timeline",
      "--out",
      join(f.root, "collected.json"),
    ],
    { encoding: "utf8", env: f.env },
  );
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(
    read(join(f.root, "collected.json")).roster.map((r) => r.login),
    ["app:fixture-reviewer", "app:macroscopeapp"],
  );
});
test("all check attempts are retained and an unfamiliar app can be selected explicitly", () => {
  const r = fetch(
    githubFixture({
      checks: [
        reviewerCheck({ name: "Inspector", id: 99 }),
        reviewerCheck({ name: "Inspector", id: 100 }),
      ],
    }),
    "app:fixture-reviewer",
  );
  assert.deepEqual(
    r.reviewEvents.map((e) => e.id),
    ["check-99", "check-100"],
  );
  assert.deepEqual(r.reviewersByCommit, { [A]: ["app:fixture-reviewer"] });
});
test("preparation marks a failed-only check reviewer not measurable", () => {
  const f = githubFixture({
    checks: [reviewerCheck({ conclusion: "timed_out" })],
  });
  const run = join(f.root, "prepared-checks");
  const p = spawnSync(
    process.execPath,
    [
      join(skill, "scripts/audit-reviewers.mjs"),
      "prepare",
      "--repo",
      repo,
      "--prs",
      "1",
      "--only",
      "app:fixture-reviewer",
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "--out",
      run,
    ],
    { encoding: "utf8", env: f.env },
  );
  assert.equal(p.status, 0, p.stderr);
  assert.equal(
    read(join(run, "manifest.json")).reviewers[0].state,
    "not_measurable",
  );
  assert.deepEqual(read(join(run, "raw/1.json")).reviewersByCommit, {});
});
test("check pagination keeps every page and rejects malformed responses", async () => {
  const { checkPages } = await import("../scripts/lib/reviewer-checks.mjs");
  assert.deepEqual(
    checkPages([
      { check_runs: [reviewerCheck()] },
      { check_runs: [reviewerCheck({ id: 100 })] },
    ]).map((c) => c.id),
    [99, 100],
  );
  assert.throws(() => checkPages([{ message: "Forbidden" }]), /Malformed/);
});
test("an incomplete annotation read stops collection instead of losing findings", () => {
  const f = githubFixture({
    checks: [
      reviewerCheck({
        output: { summary: "1 issue found", annotations_count: 1 },
      }),
    ],
  });
  const p = spawnSync(
    process.execPath,
    [
      join(skill, "scripts/fetch-pr-reviews.mjs"),
      "--repo",
      repo,
      "--pr",
      "1",
      "--only",
      "app:fixture-reviewer",
    ],
    { encoding: "utf8", env: f.env },
  );
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /annotation collection is incomplete/);
});

test("Macroscope completed reviews grant coverage for clean and issue results", () => {
  for (const title of [
    "No issues identified (3 code objects reviewed).",
    "1 issue identified (1 code object reviewed).",
    "2 issues identified (7 code objects reviewed).",
  ]) {
    const r = fetch(
      githubFixture({
        checks: [
          reviewerCheck({
            app: { slug: "macroscopeapp" },
            output: {
              title,
              summary: "Merge Base: abc; Head: def",
              annotations_count: 0,
            },
          }),
        ],
      }),
      "app:macroscopeapp",
    );
    assert.deepEqual(r.reviewersByCommit, { [A]: ["app:macroscopeapp"] });
    assert.equal(
      r.reviewEvents[0].verdict,
      title.startsWith("No") ? "clear" : "issues_found",
    );
  }
});

test("Bugbot final results grant coverage without inferring it from check success", () => {
  for (const [summary, verdict] of [
    [
      "**Final Result:** Bugbot completed review - no issues found! ✅",
      "clear",
    ],
    [
      "**Final Result:** Bugbot completed review and found 4 potential issues.",
      "issues_found",
    ],
  ]) {
    const r = fetch(
      githubFixture({
        checks: [
          reviewerCheck({
            app: { slug: "cursor" },
            output: { title: "Bugbot Review", summary, annotations_count: 0 },
          }),
        ],
      }),
      "app:cursor",
    );
    assert.deepEqual(r.reviewersByCommit, { [A]: ["app:cursor"] });
    assert.equal(r.reviewEvents[0].verdict, verdict);
  }
});

test("Macroscope status-only and zero-object checks do not create review coverage", () => {
  for (const output of [
    {
      title: "No outstanding review comments.",
      summary:
        "No new review ran — only the status of those comments was re-checked.",
      text: "1 issue found",
      annotations_count: 0,
    },
    {
      title: "No issues identified (0 code objects reviewed).",
      annotations_count: 0,
    },
    { title: "Needs Human Approval", annotations_count: 0 },
  ]) {
    const r = fetch(
      githubFixture({
        checks: [reviewerCheck({ app: { slug: "macroscopeapp" }, output })],
      }),
      "app:macroscopeapp",
    );
    assert.deepEqual(r.reviewersByCommit, {});
  }
});

test("completed reviews with no new issues or published comments keep an unknown verdict", () => {
  for (const summary of [
    "**Final Result:** Bugbot completed review - no new issues found! ✅",
    "AI review ran and left 2 comments",
  ]) {
    const r = fetch(
      githubFixture({
        checks: [reviewerCheck({ output: { summary, annotations_count: 0 } })],
      }),
      "app:fixture-reviewer",
    );
    assert.deepEqual(r.reviewersByCommit, { [A]: ["app:fixture-reviewer"] });
    assert.equal(r.reviewEvents[0].verdict, "unknown");
  }
});

test("Bugbot failures and cancellations stay explicit even with a neutral check", () => {
  for (const [summary, state] of [
    ["**Result:** Bugbot failed to run", "failed"],
    [
      "**Result:** Bugbot run cancelled because a new commit was pushed to the PR",
      "not_run",
    ],
  ]) {
    const r = fetch(
      githubFixture({
        checks: [
          reviewerCheck({
            conclusion: "neutral",
            output: { summary, annotations_count: 0 },
          }),
        ],
      }),
      "app:fixture-reviewer",
    );
    assert.deepEqual(r.reviewersByCommit, {});
    assert.equal(r.reviewEvents[0].reviewState, state);
  }
});

test("filtered candidates do not count as posted catches, noise, or engagement", () => {
  const d = doc();
  d.defects = [defect("d1", [])];
  d.instances = [
    { ...inst(), delivery: "filtered_candidate" },
    { ...inst(ra, "i2"), defectId: undefined, label: "incorrect", delivery: "filtered_candidate" },
  ];
  const f = fixture(d);
  put(join(f.root, "observations/engagement/1.json"), {
    repo, pr: 1, authorIsBot: true,
    findings: d.instances.map(i => ({ instanceId: i.id, reviewer: ra, outcome: "none", evidence: "No posted finding." })),
  });
  const r = score(f, ["--engagement", join(f.root, "observations/engagement")]);
  ok(r);
  assert.equal(row(r).installedFound, 0);
  assert.equal(row(r).instances, 0);
  assert.equal(row(r).labels.incorrect, 0);
  assert.equal(row(r).eng.n, 0);
  assert.equal(row(r).engMissing, 0);
  assert.equal(r.aggregate.filteredCandidates.length, 2);
  assert.match(r.report, /Filtered candidates are not posted findings/);
});

test("a later posted finding receives credit even after a filtered candidate", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [
    { ...inst(), delivery: "filtered_candidate" },
    { ...inst(ra, "i2"), delivery: "published" },
  ];
  const r = score(fixture(d));
  ok(r);
  assert.equal(row(r).instances, 1);
  assert.equal(row(r).installedFound, 1);
  assert.equal(r.aggregate.filteredCandidates.length, 1);
});

test("unknown delivery values and duplicate links across delivery types fail closed", () => {
  for (const badDelivery of ["filtered", "", null]) {
    const d = doc();
    d.defects = [defect()];
    d.instances = [{ ...inst(), delivery: badDelivery }];
    assert.notEqual(score(fixture(d)).status, 0);
  }
  const d = doc();
  d.defects = [defect("d1", [])];
  d.instances = [
    { ...inst(), delivery: "filtered_candidate" },
    { ...inst(ra, "i2"), label: "duplicate", duplicateOf: "i1", delivery: "published" },
  ];
  assert.notEqual(score(fixture(d)).status, 0);
});

test("a native inline pin can retain catch credit when its linked event has another commit", () => {
  const d = doc();
  d.reviewEvents[0].reviewedCommit = B;
  d.reviewEvents.push({ ...d.reviewEvents[0], id: "review-3", reviewedCommit: A, submittedAt: "2026-01-02T00:00:30Z" });
  d.reviewersByCommit[B] = [ra];
  d.defects = [defect()];
  d.instances = [{ ...inst(), kind: "inline" }];
  const f = fixture(d);
  d.instances[0].reviewEventId = null;
  put(join(f.dir, "1.json"), d);
  const r = score(f);
  ok(r);
  assert.equal(row(r).installedFound, 1);
  assert.deepEqual(row(r).firstLook, { opp: 0, found: 0 });
});

test("a consistent publication cannot discard its event attribution", () => {
  const d = doc();
  d.defects = [defect()];
  d.instances = [{ ...inst(), kind: "inline" }];
  const f = fixture(d);
  d.instances[0].reviewEventId = null;
  put(join(f.dir, "1.json"), d);
  const r = score(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /event|publication/i);
});
