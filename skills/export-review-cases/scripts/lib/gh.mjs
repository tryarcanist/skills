// Shared GitHub access for export-review-cases.
//
// Every script in this skill talks to GitHub through here so that retries,
// pagination, and degraded-data reporting behave identically. A tolerated
// failure is recorded as a warning and returns an empty result; it never
// returns a silent zero that a later count would read as "observed none".

import { execFileSync } from "node:child_process";

export const GH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const SECONDARY_RATE_LIMIT_DELAY_MS = 60000;
const MAX_BUFFER = 128 * 1024 * 1024;

export const warnings = [];

export function warn(msg) {
  warnings.push(msg);
  process.stderr.write(`warn: ${msg}\n`);
}

export function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A permanent answer is not a transient failure. Retrying a 404 three times
// costs six seconds of sleep to learn what the first response already said.
export function isPermanentFailure(detail) {
  const text = String(detail || "");
  if (/rate limit|abuse detection|retry-after|was submitted too quickly/i.test(text)) return false;
  return /HTTP 40[0134]|HTTP 422|Not Found|no such|Could not resolve to/i.test(text);
}

export function runGh(ghArgs) {
  let detail = "";
  let attempts = 0;
  for (let attempt = 0; attempt < GH_ATTEMPTS; attempt += 1) {
    attempts = attempt + 1;
    try {
      return execFileSync("gh", ghArgs, { encoding: "utf8", maxBuffer: MAX_BUFFER });
    } catch (e) {
      detail = (e.stderr || e.message || "").toString().trim().slice(0, 300);
      if (isPermanentFailure(detail)) break;
      if (attempt === GH_ATTEMPTS - 1) break;
      const secondary =
        /secondary rate limit|abuse detection|was submitted too quickly|rate limit exceeded|retry-after/i.test(
          detail,
        );
      const delay = secondary
        ? Math.max(SECONDARY_RATE_LIMIT_DELAY_MS, RETRY_DELAYS_MS[attempt])
        : RETRY_DELAYS_MS[attempt];
      process.stderr.write(
        `gh failed (attempt ${attempt + 1}/${GH_ATTEMPTS}${secondary ? ", secondary rate limit" : ""}), ` +
          `retrying in ${Math.round(delay / 1000)}s: ${detail}\n`,
      );
      sleepSync(delay);
    }
  }
  const err = new Error(detail || "gh failed");
  err.detail = detail;
  err.attempts = attempts;
  err.permanent = isPermanentFailure(detail);
  throw err;
}

function parseOrWarn(raw, label) {
  const text = (raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    warn(`could not parse gh output for ${label}; treated as empty`);
    return null;
  }
}

// Paginated list endpoint. --slurp returns one array per page, so flatten.
// No text rewriting, so bracket sequences inside comment bodies survive.
export function ghJson(path, { tolerate = false } = {}) {
  let raw;
  try {
    raw = runGh(["api", path, "--paginate", "--slurp"]);
  } catch (e) {
    const detail = e.detail || e.message || "";
    if (tolerate) {
      warn(`GET ${path} failed after ${e.attempts || 1} attempt(s)${e.permanent ? " (permanent)" : ""} and was treated as empty: ${detail}`);
      return [];
    }
    process.stderr.write(`gh api ${path} failed: ${detail}\n`);
    process.exit(1);
  }
  const pages = parseOrWarn(raw, path);
  if (pages === null) return [];
  return Array.isArray(pages) ? pages.flat() : [];
}

// Single-object endpoint. Returns null on a tolerated failure, which callers
// must distinguish from an object with empty fields.
export function ghOne(path, { tolerate = false } = {}) {
  let raw;
  try {
    raw = runGh(["api", path]);
  } catch (e) {
    const detail = e.detail || e.message || "";
    if (tolerate) {
      warn(`GET ${path} failed after ${e.attempts || 1} attempt(s)${e.permanent ? " (permanent)" : ""} and was treated as missing: ${detail}`);
      return null;
    }
    process.stderr.write(`gh api ${path} failed: ${detail}\n`);
    process.exit(1);
  }
  return parseOrWarn(raw, path);
}

// `gh pr list --json` is not the REST API and is not paginated the same way;
// it returns one JSON array capped by --limit.
export function ghPrList(ghArgs) {
  const raw = runGh(["pr", "list", ...ghArgs]);
  const parsed = parseOrWarn(raw, `gh pr list ${ghArgs.join(" ")}`);
  return Array.isArray(parsed) ? parsed : [];
}

export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) return { error: `unexpected argument ${a}` };
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in spec)) return { error: `unknown flag ${a}` };
    if (spec[key] === "flag") out[key] = true;
    else out[key] = argv[(i += 1)];
  }
  return out;
}

// A reviewer roster entry may be written with or without the [bot] suffix.
// Normalising both sides here keeps one spelling from silently scoring zero.
export function normalizeLogin(login) {
  return String(login || "")
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

// Keeps both spellings. `logins` is normalised for comparison; `spellings`
// preserves what the operator typed, so an output file never mixes "cursor"
// and "cursor[bot]" for the same identity in the same array.
export function makeRoster(only) {
  const spellings = String(only || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const logins = spellings.map(normalizeLogin);
  const spellingFor = new Map(logins.map((l, i) => [l, spellings[i]]));
  return {
    logins,
    spellings,
    has: (login) => logins.includes(normalizeLogin(login)),
    // The roster's own spelling for a login, so placeholder rows match real ones.
    spell: (login) => spellingFor.get(normalizeLogin(login)) || login,
    isEmpty: logins.length === 0,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A mistyped date and a genuinely empty window produce identical GitHub
// results, so the typo has to be caught here or it is never caught at all.
export function validateWindow(since, until) {
  const problems = [];
  for (const [name, value] of [["--since", since], ["--until", until]]) {
    if (!ISO_DATE.test(String(value || ""))) {
      problems.push(`${name} "${value}" is not a YYYY-MM-DD date (a zero-padded month and day are required)`);
    } else {
      // Date.parse rolls 2026-02-30 forward to March 2 rather than rejecting
      // it, so the guard has to round-trip. Without this a typo produces a
      // confidently empty, complete-looking run.
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        problems.push(`${name} "${value}" is not a real calendar date`);
      }
    }
  }
  if (!problems.length && Date.parse(`${since}T00:00:00Z`) >= Date.parse(`${until}T00:00:00Z`)) {
    problems.push(`--since ${since} is not before --until ${until} (--until is exclusive)`);
  }
  return problems;
}
