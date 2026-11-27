#!/usr/bin/env node
// Run preparation and reporting use local files and read-only GitHub collection.
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  SCHEMA,
  METHOD,
  sha256,
  readJson,
  loadManifest,
  requireValue,
} from "./lib/run-contract.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
function scriptHashes(directory = scripts) {
  const hashes = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, scriptHashes(path));
    else if (entry.name.endsWith(".mjs"))
      hashes[`scripts/${relative(scripts, path)}`] = sha256(readFileSync(path));
  }
  return hashes;
}
const help = `Usage:
  audit-reviewers.mjs prepare --repo owner/repo --only login-a,login-b --model name --provider name --out run-dir
    Select --prs 1,2 for an explicit sample, or --corpus corpus.json for the declared population.
    Optional: --raw-dir raw-dir (local evidence import), --reviewers roster.json (states and reasons).
  audit-reviewers.mjs freeze-cold --run run-dir --pr 1 --file cold-result.json
  audit-reviewers.mjs status --run run-dir
  audit-reviewers.mjs report --run run-dir [--prices prices.json]

prepare creates a new run, exact-commit inputs, a frozen manifest and observation templates.
freeze-cold saves the evaluator's blind result before it reads raw reviewer output.
report validates the run and writes aggregate.json and report.md. It makes no model calls.
An invalid or incomplete run exits nonzero. Existing run directories are never replaced.
`;
const [command, ...argv] = process.argv.slice(2);
if (!command || command === "--help" || argv.includes("--help")) {
  process.stdout.write(help);
  process.exit(command ? 0 : 2);
}
const args = {};
const options = new Set([
  "repo",
  "only",
  "model",
  "provider",
  "out",
  "prs",
  "corpus",
  "raw-dir",
  "reviewers",
  "run",
  "pr",
  "file",
  "prices",
]);
try {
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2),
      value = argv[++i];
    requireValue(
      argv[i - 1].startsWith("--") &&
        options.has(key) &&
        value &&
        !value.startsWith("--"),
      `Invalid option ${argv[i - 1]}`,
    );
    requireValue(args[key] === undefined, `Repeated option --${key}`);
    args[key] = value;
  }
  const put = (path, value, exclusive = false) =>
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
      flag: exclusive ? "wx" : "w",
    });
  if (command === "prepare") {
    requireValue(
      args.repo && args.only && args.model && args.provider && args.out,
      "prepare requires --repo, --only, --model, --provider and --out",
    );
    requireValue(/^[\w.-]+\/[\w.-]+$/.test(args.repo), "Invalid repository");
    requireValue(
      Boolean(args.prs) !== Boolean(args.corpus),
      "Select exactly one of --prs or --corpus",
    );
    const selected = args.prs?.split(",").map(Number);
    requireValue(
      !selected ||
        (selected.length &&
          selected.every((n) => Number.isSafeInteger(n) && n > 0) &&
          new Set(selected).size === selected.length),
      "Invalid --prs",
    );
    const corpus = args.corpus
      ? readJson(resolve(args.corpus))
      : {
          repo: args.repo,
          prs: selected.map((number) => ({ number })),
          warnings: [],
          excluded: [],
          windowAppliedTo: "explicit_prs",
        };
    requireValue(
      corpus.repo === args.repo &&
        Array.isArray(corpus.prs) &&
        corpus.prs.length > 0,
      "Empty or mismatched corpus",
    );
    requireValue(
      !args.corpus || corpus.collectionComplete === true,
      "Population collection is incomplete or unknown. Correct the collection gap before preparation.",
    );
    requireValue(
      !corpus.totals?.sweep?.capHit,
      "Corpus sweep hit its cap. Narrow the window or raise --max-sweep before preparation.",
    );
    const logins = args.only
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    requireValue(
      logins.length > 0 && new Set(logins).size === logins.length,
      "Invalid reviewer list",
    );
    const reviewers = args.reviewers
      ? readJson(resolve(args.reviewers))
      : logins.map((id) => ({
          id,
          logins: [id],
          state: "observed",
          reason: "Selected as a code reviewer by the user or evaluator",
        }));
    requireValue(
      Array.isArray(reviewers) &&
        reviewers
          .flatMap((r) => r.logins)
          .every((x) => logins.includes(x.toLowerCase())) &&
        logins.every((x) => reviewers.some((r) => r.logins.includes(x))),
      "Roster and --only differ",
    );
    const root = resolve(args.out);
    requireValue(
      !existsSync(root),
      "Run directory exists. Choose a new directory.",
    );
    mkdirSync(root, { recursive: true });
    for (const dir of [
      "raw",
      "inputs",
      "cold",
      "observations/prs",
      "observations/engagement",
    ])
      mkdirSync(join(root, dir), { recursive: true });
    put(join(root, "corpus.json"), corpus, true);
    const capturedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: SCHEMA,
      methodVersion: METHOD,
      runId: randomUUID(),
      repo: args.repo,
      evidenceKind: args["raw-dir"] ? "imported" : "github",
      mode: args.prs ? "sample" : "complete",
      window: {
        field: corpus.windowAppliedTo,
        from: corpus.since || null,
        toExclusive: corpus.until || null,
      },
      populationPrs: corpus.prs.map((p) => p.number),
      selectedPrs: corpus.prs.map((p) => p.number),
      sample: args.prs
        ? {
            rule: "Explicit PR selection. Results apply only to this convenience sample.",
          }
        : null,
      scope:
        "Reachable wrong output or violated contract introduced by the PR. Style, docs, maintainability and speculative hardening are outside scope.",
      reviewers,
      excludedPrs: corpus.excluded || [],
      excludedIdentities: [],
      collectorWarnings: [...(corpus.warnings || [])],
      evaluator: { provider: args.provider, model: args.model },
      capturedAt,
      sourceHashes: {
        "corpus.json": sha256(readFileSync(join(root, "corpus.json"))),
      },
      toolHashes: scriptHashes(),
    };
    for (const n of manifest.selectedPrs) {
      const target = join(root, `raw/${n}.json`);
      if (args["raw-dir"]) {
        const imported = readJson(join(resolve(args["raw-dir"]), `${n}.json`));
        requireValue(
          imported.repo === args.repo && imported.pr === n,
          `Imported PR ${n} has the wrong identity`,
        );
        put(target, imported, true);
      } else {
        execFileSync(
          process.execPath,
          [
            join(scripts, "fetch-pr-reviews.mjs"),
            "--repo",
            args.repo,
            "--pr",
            String(n),
            "--only",
            logins.join(","),
            "--out",
            target,
          ],
          { stdio: ["ignore", "ignore", "inherit"] },
        );
      }
      const raw = readJson(target);
      // Keep full discussion for follow-up evidence. Window-filter publication events and candidates.
      const inWindow = (time) =>
        (!corpus.since || time >= corpus.since) &&
        (!corpus.until || time < corpus.until);
      if (corpus.since || corpus.until) {
        raw.followupEvidence = {
          reviewEvents: raw.reviewEvents,
          findingInstances: raw.findingInstances,
          summaryComments: raw.summaryComments,
        };
        raw.reviewEvents = raw.reviewEvents.filter(
          (e) => e.submittedAt && inWindow(e.submittedAt),
        );
        const events = new Set(raw.reviewEvents.map((e) => String(e.id)));
        raw.findingInstances = raw.findingInstances.filter(
          (i) => events.has(String(i.reviewEventId)) && inWindow(i.createdAt),
        );
        raw.summaryComments = raw.summaryComments.filter((s) =>
          events.has(String(s.id)),
        );
        raw.reviewersByCommit = {};
        for (const event of raw.reviewEvents)
          if (event.reviewedCommit) {
            const r = (raw.reviewersByCommit[event.reviewedCommit] ||= []);
            if (!r.includes(event.reviewer)) r.push(event.reviewer);
          }
        put(target, raw);
      }
      for (const warning of raw.collectionWarnings || [])
        manifest.collectorWarnings.push(`PR ${n}: ${warning}`);
      manifest.sourceHashes[`raw/${n}.json`] = sha256(readFileSync(target));
      // These inputs contain code identities only. No finding text, verdicts or PR title.
      const input = {
        repo: args.repo,
        pr: n,
        baseSha: raw.baseSha,
        headSha: raw.headSha,
        commits: [
          ...new Set(
            [...Object.keys(raw.reviewersByCommit || {}), raw.headSha].filter(
              Boolean,
            ),
          ),
        ],
        unavailableCommits: raw.unresolvableCommits || [],
      };
      put(join(root, `inputs/${n}.json`), input, true);
      manifest.sourceHashes[`inputs/${n}.json`] = sha256(
        readFileSync(join(root, `inputs/${n}.json`)),
      );
      put(
        join(root, `observations/prs/${n}.json`),
        {
          repo: args.repo,
          pr: n,
          url: raw.url,
          authorType: raw.authorType,
          createdAt: raw.createdAt,
          mergedAt: raw.mergedAt,
          commitOrder: raw.commitOrder,
          reviewersByCommit: raw.reviewersByCommit,
          reviewEvents: (raw.reviewEvents || []).map(({ body, ...event }) => ({
            ...event,
            verdict: event.verdict || "unknown",
          })),
          coldReview: {
            state: "not_measurable",
            reason: "Cold review is not complete",
          },
          defects: [],
          instances: [],
          skeptic: { status: "not_run" },
        },
        true,
      );
    }
    // A selected check app with no proven review cannot look like a zero-catch reviewer.
    for (const reviewer of manifest.reviewers) {
      if (
        reviewer.state !== "observed" ||
        !reviewer.logins.every((login) => login.startsWith("app:"))
      )
        continue;
      const measurable = manifest.selectedPrs.some((n) =>
        readJson(join(root, `raw/${n}.json`)).reviewEvents.some(
          (e) => reviewer.logins.includes(e.reviewer) && e.reviewedCommit,
        ),
      );
      if (!measurable) {
        reviewer.state = "not_measurable";
        reviewer.reason =
          "No completed code review with exact-commit evidence was collected. Check outputs and warnings describe pending, failed, skipped, absent or unknown results.";
      }
    }
    put(join(root, "manifest.json"), manifest, true);
    loadManifest(join(root, "manifest.json"));
    process.stdout.write(
      `Prepared ${manifest.selectedPrs.length} PR(s) in ${root}. Read inputs/ before raw/. Complete cold review and observations, then run report.\n`,
    );
  } else {
    requireValue(args.run, `${command} requires --run`);
    const root = resolve(args.run),
      { manifest } = loadManifest(join(root, "manifest.json"));
    if (command === "freeze-cold") {
      const n = Number(args.pr);
      requireValue(
        manifest.selectedPrs.includes(n) && args.file,
        "Select a declared --pr and a cold result --file",
      );
      const cold = readJson(resolve(args.file)),
        input = readJson(join(root, `inputs/${n}.json`));
      requireValue(
        cold.repo === manifest.repo &&
          cold.pr === n &&
          ["observed", "not_measurable"].includes(cold.state),
        "Invalid cold result identity or state",
      );
      requireValue(
        Array.isArray(cold.defects),
        "Cold result requires defects, including an empty array",
      );
      if (cold.state === "observed")
        requireValue(
          Array.isArray(cold.commits) &&
            input.commits.every((c) => cold.commits.includes(c)),
          "Cold review must cover every frozen historical commit",
        );
      else
        requireValue(
          cold.reason,
          "A non-measurable cold review requires a reason",
        );
      const path = `cold/${n}.json`;
      put(
        join(root, path),
        { ...cold, frozenAt: new Date().toISOString() },
        true,
      );
      manifest.sourceHashes[path] = sha256(readFileSync(join(root, path)));
      put(join(root, "manifest.json"), manifest);
      const observation = readJson(join(root, `observations/prs/${n}.json`));
      observation.coldReview = {
        state: cold.state,
        reason: cold.reason,
        artifact: path,
        commits: cold.commits || [],
      };
      put(join(root, `observations/prs/${n}.json`), observation);
      process.stdout.write(
        `Frozen cold result for PR ${n}. Reviewer evidence is in raw/${n}.json.\n`,
      );
    } else if (command === "status") {
      const rows = manifest.selectedPrs.map((n) => ({
        pr: n,
        cold: existsSync(join(root, `cold/${n}.json`)),
        skeptic:
          readJson(join(root, `observations/prs/${n}.json`)).skeptic?.status ||
          "not_run",
      }));
      process.stdout.write(
        JSON.stringify({ runId: manifest.runId, prs: rows }, null, 2) + "\n",
      );
    } else if (command === "report") {
      const extra = args.prices ? ["--prices", resolve(args.prices)] : [];
      execFileSync(
        process.execPath,
        [
          join(scripts, "score-corpus.mjs"),
          "--manifest",
          join(root, "manifest.json"),
          "--dir",
          join(root, "observations/prs"),
          "--engagement",
          join(root, "observations/engagement"),
          "--out",
          join(root, "report.md"),
          "--json",
          join(root, "aggregate.json"),
          ...extra,
        ],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      const result = {
        runId: manifest.runId,
        generatedAt: new Date().toISOString(),
        hashes: {},
        toolHashes: scriptHashes(),
      };
      for (const sub of ["observations/prs", "observations/engagement"])
        for (const file of readdirSync(join(root, sub)).filter((f) =>
          f.endsWith(".json"),
        )) {
          result.hashes[`${sub}/${file}`] = sha256(
            readFileSync(join(root, sub, file)),
          );
        }
      for (const file of ["manifest.json", "aggregate.json", "report.md"])
        result.hashes[file] = sha256(readFileSync(join(root, file)));
      if (args.prices)
        result.priceHash = sha256(readFileSync(resolve(args.prices)));
      put(join(root, "result-hashes.json"), result);
      process.stdout.write(`${join(root, "report.md")}\n`);
    } else throw new Error(`Unknown command ${command}`);
  }
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
}
