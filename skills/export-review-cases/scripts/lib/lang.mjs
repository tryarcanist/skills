// Comment syntax, per language, so that prose cannot be mistaken for code.
//
// This is the most convention-bound part of the skill and the first thing that
// breaks on an unfamiliar repository. It is data, not logic, so a run that hits
// an unsupported language can be repaired by adding an entry to the config
// file rather than by editing this file.
//
// An unknown extension falls back to the union of every comment style below.
// That masks more than it should and loses needles; it never invents one, which
// is the direction to be wrong in.

const C_LIKE = [
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".cs", ".go", ".rs", ".swift", ".kt", ".kts", ".scala", ".php", ".css", ".scss", ".less",
  ".dart", ".groovy", ".m", ".mm", ".proto", ".sol",
];

export const BUILT_IN_LANGUAGES = [
  { ext: [".py", ".pyi"], line: ["#"], block: [['"""', '"""'], ["'''", "'''"]] },
  { ext: [".rb", ".rake"], line: ["#"], block: [["=begin", "=end"]] },
  { ext: C_LIKE, line: ["//"], block: [["/*", "*/"]] },
  { ext: [".sql"], line: ["--", "#"], block: [["/*", "*/"]] },
  { ext: [".hs", ".elm", ".purs"], line: ["--"], block: [["{-", "-}"]] },
  { ext: [".lua"], line: ["--"], block: [["--[[", "]]"]] },
  { ext: [".clj", ".cljs", ".cljc", ".edn", ".lisp", ".el", ".scm"], line: [";"], block: [] },
  { ext: [".html", ".htm", ".xml", ".vue", ".svelte", ".md", ".mdx"], line: [], block: [["<!--", "-->"]] },
  { ext: [".ex", ".exs"], line: ["#"], block: [['"""', '"""']] },
  { ext: [".erl", ".hrl"], line: ["%"], block: [] },
  { ext: [".tex"], line: ["%"], block: [] },
  { ext: [".sh", ".bash", ".zsh", ".fish", ".yaml", ".yml", ".toml", ".tf", ".tfvars", ".ini", ".conf", ".r", ".pl", ".pm", ".ps1"], line: ["#"], block: [] },
];

// Used when the extension is unrecognised: mask anything that could be a
// comment in any supported language.
const FALLBACK = {
  line: ["//", "#", "--", ";", "%"],
  block: [["/*", "*/"], ['"""', '"""'], ["'''", "'''"], ["<!--", "-->"], ["=begin", "=end"], ["{-", "-}"]],
};

export function languageFor(path, extraLanguages = []) {
  const name = String(path || "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  for (const lang of [...extraLanguages, ...BUILT_IN_LANGUAGES]) {
    if ((lang.ext || []).some((e) => e.toLowerCase() === ext)) {
      return { ...lang, matched: true, ext };
    }
  }
  return { ...FALLBACK, matched: false, ext };
}

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Which lines of a file are inside a comment, docstring, or block comment.
//
// Computed over the whole file, never over a candidate block: a single line
// lifted from the middle of a docstring carries no fence, so a block-local scan
// cannot tell prose from code, and a sentence of documentation would then be
// allowed to decide whether a reviewer had seen a bug.
export function commentMask(content, path, extraLanguages = []) {
  const lang = languageFor(path, extraLanguages);
  const lines = String(content || "").split("\n");
  const mask = new Array(lines.length).fill(false);
  const lineStarts = lang.line || [];
  const blocks = lang.block || [];

  let open = null; // the [start, end] pair currently open
  lines.forEach((raw, i) => {
    const line = raw.trim();

    if (open) {
      mask[i] = true;
      if (line.includes(open[1])) open = null;
      return;
    }
    if (!line.length) return;

    // Block openers are checked before line comments, and a block opener that
    // begins the line wins over one appearing mid-line. Lua's `--[[` opens a
    // block and also starts with its line-comment marker `--`; Python's
    // `# """` is a line comment that merely mentions a fence. Ordering is what
    // separates the two.
    const startsBlock = blocks.find((pair) => line.startsWith(pair[0]));
    const startsLine = lineStarts.some((marker) => line.startsWith(marker));
    if (!startsBlock && startsLine) {
      mask[i] = true;
      return;
    }
    for (const pair of startsBlock ? [startsBlock] : blocks) {
      const [start, end] = pair;
      if (!line.includes(start)) continue;
      mask[i] = true;
      // A symmetric fence (""" ... """) closes on this line only if it appears
      // an even number of times; an asymmetric one (/* ... */) closes if the
      // terminator appears after the opener.
      if (start === end) {
        const count = (line.match(new RegExp(escape(start), "g")) || []).length;
        if (count % 2 === 1) open = pair;
      } else if (!line.includes(end, line.indexOf(start) + start.length)) {
        open = pair;
      }
      return;
    }
  });
  return mask;
}
