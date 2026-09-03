// Optional per-repository overrides.
//
// The defaults in this skill encode conventions -- where tests live, what a fix
// title looks like, how a language writes a comment -- and conventions are the
// part most likely to be wrong on a repository nobody has run this against. The
// point of this file is that an agent hitting one of those mismatches can fix
// it by writing a small JSON file, without editing skill code it does not own
// and cannot safely change.
//
// Every override is additive by default. Replacing a default takes an explicit
// `replace` key, so an unfamiliar config cannot silently disable a guard.
//
// Looked up in order: --config <path>, ./review-cases.config.json,
// <repo-path>/review-cases.config.json. A missing file is normal, not an error.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILENAME = "review-cases.config.json";

const EMPTY = {
  paths: { nonProductExtra: [], nonProductReplace: null, product: [] },
  languages: [],
  statementSignalExtra: null,
  fixSignalsExtra: [],
  minBlockChars: null,
  source: null,
};

function compile(patterns, label, problems) {
  const out = [];
  for (const pattern of patterns || []) {
    try {
      out.push(new RegExp(pattern, "i"));
    } catch (e) {
      problems.push(`${label}: ${pattern} is not a valid regular expression (${e.message})`);
    }
  }
  return out;
}

export function loadConfig({ explicit, repoPath } = {}) {
  const candidates = [
    explicit,
    join(process.cwd(), CONFIG_FILENAME),
    repoPath ? join(repoPath, CONFIG_FILENAME) : null,
  ].filter(Boolean);

  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    if (explicit) throw new Error(`--config ${explicit} does not exist`);
    return { ...EMPTY, problems: [], compiled: { nonProductExtra: [], product: [], nonProductReplace: null } };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(found, "utf8"));
  } catch (e) {
    throw new Error(`${found} is not valid JSON: ${e.message}`);
  }

  const problems = [];
  const config = {
    ...EMPTY,
    ...raw,
    paths: { ...EMPTY.paths, ...(raw.paths || {}) },
    source: found,
  };

  const compiled = {
    nonProductExtra: compile(config.paths.nonProductExtra, "paths.nonProductExtra", problems),
    product: compile(config.paths.product, "paths.product", problems),
    nonProductReplace: config.paths.nonProductReplace
      ? compile(config.paths.nonProductReplace, "paths.nonProductReplace", problems)
      : null,
  };

  if (config.statementSignalExtra) {
    try {
      new RegExp(config.statementSignalExtra);
    } catch (e) {
      problems.push(`statementSignalExtra is not a valid regular expression (${e.message})`);
      config.statementSignalExtra = null;
    }
  }
  for (const lang of config.languages || []) {
    if (!Array.isArray(lang.ext) || !lang.ext.length) {
      problems.push(`languages entry ${JSON.stringify(lang).slice(0, 60)} has no ext array`);
    }
  }

  return { ...config, compiled, problems };
}

// A path is non-product unless an explicit product pattern claims it. The
// allowlist wins, so a repository that ships code from `docs/` or `src/spec/`
// can say so without disabling the default filter everywhere else.
export function makePathPolicy(defaultNonProduct, config) {
  const { compiled } = config;
  const base = compiled.nonProductReplace || [defaultNonProduct, ...compiled.nonProductExtra];
  const list = compiled.nonProductReplace ? compiled.nonProductReplace : base;
  return {
    isNonProduct(path) {
      if (compiled.product.some((re) => re.test(path))) return false;
      return list.some((re) => re.test(path));
    },
    describe() {
      return {
        replacedDefault: Boolean(compiled.nonProductReplace),
        extraPatterns: (config.paths.nonProductExtra || []).length,
        productAllowlist: (config.paths.product || []).length,
      };
    },
  };
}
