// Syntax highlighting for a diff, in GitHub's colors: a small tokenizer per language, run over each side of a hunk in order.

// GitHub's Primer syntax colors.
export const SYNTAX = {
  light: { comment: "#59636e", keyword: "#cf222e", string: "#0a3069", constant: "#0550ae", entity: "#6639ba", tag: "#116329", variable: "#953800" },
  dark: { comment: "#9198a1", keyword: "#ff7b72", string: "#a5d6ff", constant: "#79c0ff", entity: "#d2a8ff", tag: "#7ee787", variable: "#ffa657" },
};

const words = (s) => new Set(s.split(" "));
const C_OPS = /^(?:[=!<>]=?=?|&&|\|\||[-+*/%]=?|\?\??|=>|->|::|\.\.\.|[&|^~])/;
const DEFS = words("def class function fn func struct enum trait interface type impl module");

// Each language: comments, strings (`multi` ones may span lines), keywords, constants, and which other rules apply.
const LANGS = {
  js: {
    line: ["//"], block: [["/*", "*/"]], strings: ['"', "'"], multi: [["`", "`"]], calls: true, ops: C_OPS,
    keywords: words("import export from as default const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends super this async await yield try catch finally throw void static get set type interface enum implements declare readonly keyof namespace satisfies"),
    constants: words("true false null undefined NaN Infinity"),
  },
  py: {
    line: ["#"], multi: [['"""', '"""'], ["'''", "'''"]], strings: ['"', "'"], prefixes: /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/,
    calls: true, decorators: true, ops: /^(?:[=!<>]=?|->|[-+*/%@&|^~]=?|\*\*=?|\/\/=?|:=)/,
    keywords: words("import from as def class return if elif else for while in not and or is with try except finally raise pass break continue lambda yield global nonlocal assert del async await match case"),
    constants: words("True False None self cls"),
  },
  elm: {
    line: ["--"], block: [["{-", "-}"]], multi: [['"""', '"""']], strings: ['"', "'"], caps: "constant",
    ops: /^(?:\|>|<\||->|<-|::|==|\/=|<=|>=|&&|\|\||\+\+|>>|<<|[=+\-*/<>|^])/,
    keywords: words("module exposing import as port type alias case of let in if then else"),
    constants: words(""),
  },
  nix: {
    line: ["#"], block: [["/*", "*/"]], multi: [["''", "''"]], strings: ['"'], ident: /^[A-Za-z_][\w'-]*/,
    ops: /^(?:==|!=|<=|>=|&&|\|\||->|\/\/|\+\+|[=?:@])/,
    keywords: words("let in with rec inherit if then else assert import or"),
    constants: words("true false null"),
  },
  sh: {
    line: ["#"], strings: ['"', "'"], variables: true,
    keywords: words("if then else elif fi for while until do done case esac in function return export local readonly declare set unset source exit shift"),
    constants: words("true false"),
  },
  ruby: {
    line: ["#"], strings: ['"', "'"], calls: true, ops: C_OPS,
    keywords: words("def class module end if elsif else unless case when while until for in do return yield begin rescue ensure raise require require_relative include extend attr_reader attr_accessor private protected then and or not"),
    constants: words("true false nil self"),
  },
  sql: {
    line: ["--"], block: [["/*", "*/"]], strings: ["'", '"'], nocase: true, calls: true,
    keywords: words("select from where and or not insert into values update set delete create alter drop table index view on join left right inner outer full group by order having limit offset as distinct union all case when then else end primary key foreign references default unique exists in is like between returning cascade constraint add column if begin commit rollback with"),
    constants: words("null true false"),
  },
  css: {
    line: [], block: [["/*", "*/"]], strings: ['"', "'"], ident: /^-?[A-Za-z_][\w-]*/, css: true,
    keywords: words("important"), constants: words(""),
  },
  json: { line: [], strings: ['"'], keys: true, keywords: words(""), constants: words("true false null") },
  yaml: { line: ["#"], strings: ['"', "'"], keys: true, keywords: words(""), constants: words("true false null yes no on off ~") },
  toml: { line: ["#", ";"], strings: ['"', "'"], multi: [['"""', '"""']], keys: true, sections: true, keywords: words(""), constants: words("true false") },
  make: { line: ["#"], strings: ['"', "'"], variables: true, targets: true, keywords: words("ifeq ifneq ifdef ifndef else endif include define endef export override"), constants: words("") },
  docker: {
    line: ["#"], strings: ['"', "'"], variables: true, nocase: true, first: true,
    keywords: words("from run cmd label expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell as"),
    constants: words(""),
  },
  html: { markup: true },
  md: { markdown: true },
};
const C_LIKE = (keywords, constants = "true false null") => ({ line: ["//"], block: [["/*", "*/"]], strings: ['"', "'"], multi: [["`", "`"]], calls: true, ops: C_OPS, keywords: words(keywords), constants: words(constants) });
LANGS.rust = C_LIKE("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while", "true false None Some Ok Err");
LANGS.go = C_LIKE("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var", "true false nil iota");
LANGS.c = C_LIKE("auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual override template typename namespace using new delete this throw try catch include define ifdef ifndef endif bool final import package extends implements interface abstract var val fun let guard func struct protocol extension self", "true false null nullptr NULL nil");

const EXT = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  py: "py", pyi: "py", elm: "elm", nix: "nix", sh: "sh", bash: "sh", zsh: "sh", fish: "sh", envrc: "sh",
  rb: "ruby", rake: "ruby", sql: "sql", css: "css", scss: "css", less: "css",
  json: "json", jsonc: "json", lock: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "toml", cfg: "toml", conf: "toml",
  mk: "make", dockerfile: "docker", html: "html", htm: "html", xml: "html", svg: "html", pt: "html", jinja: "html", jinja2: "html", j2: "html", vue: "html",
  md: "md", markdown: "md", rs: "rust", go: "go",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", java: "c", kt: "c", kts: "c", swift: "c", cs: "c", php: "c", scala: "c", dart: "c", zig: "c",
};
const NAMES = { makefile: "make", gnumakefile: "make", dockerfile: "docker", containerfile: "docker", ".bashrc": "sh", ".zshrc": "sh", ".profile": "sh", ".envrc": "sh", justfile: "make" };

// The language of a path, by its name or extension; null for one this doesn't know.
export function languageOf(path) {
  const name = path.split("/").pop().toLowerCase();
  const key = NAMES[name] ?? EXT[name.includes(".") ? name.split(".").pop() : ""] ?? (name.startsWith("dockerfile") ? "docker" : null);
  return key ? LANGS[key] : null;
}

const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z%]*/;
const IDENT = /^[A-Za-z_$][\w$]*/;

// The string or comment a line opens without closing, carried to the next line of the same side.
// A line's tokens are [start, end, kind] for every span that isn't plain text.
function tokenize(text, lang, state) {
  const out = [], push = (a, b, kind) => { if (b > a) out.push([a, b, kind]); };
  if (lang.markup) return markup(text, state, push), out;
  if (lang.markdown) return markdown(text, state, push), out;
  let i = 0, prev = "", pre = null;
  if (state.open) {
    const end = text.indexOf(state.open.close);
    if (end < 0) return push(0, text.length, state.open.kind), out;
    i = end + state.open.close.length; push(0, i, state.open.kind); state.open = null;
  }
  const n = text.length, rest = () => text.slice(i);
  const starts = (s) => text.startsWith(s, i);
  const lead = /^\s*/.exec(text)[0].length;
  if (lang.sections && text[lead] === "[") return push(lead, n, "entity"), out;
  if (lang.targets && i === 0 && /^[\w./%-]+\s*:(?!=)/.test(text)) { const m = /^[\w./%-]+/.exec(text)[0]; push(0, m.length, "entity"); i = m.length; }
  // A bare key at the start of a line; a quoted one is a string followed by a colon, below.
  const bare = lang.keys && /^(\s*(?:-\s+)?)([\w.$@\/-]+)\s*(?=[:=](?!:))/.exec(text.slice(i));
  if (bare) { push(i + bare[1].length, i + bare[1].length + bare[2].length, "tag"); i += bare[1].length + bare[2].length; }
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t") { i++; continue; }
    // Comments, then strings that may span lines, then the rest.
    if (lang.line?.some((m) => starts(m) && (m !== "#" || lang === LANGS.py || lang === LANGS.nix || i === 0 || /\s/.test(text[i - 1])))) { push(i, n, "comment"); return out; }
    const block = lang.block?.find(([o]) => starts(o));
    if (block) {
      const end = text.indexOf(block[1], i + block[0].length);
      if (end < 0) { push(i, n, "comment"); state.open = { close: block[1], kind: "comment" }; return out; }
      push(i, end + block[1].length, "comment"); i = end + block[1].length; prev = ""; continue;
    }
    const multi = lang.multi?.find(([o]) => starts(o));
    if (multi) {
      const end = closing(text, i + multi[0].length, multi[1]);
      if (end < 0) { push(i, n, "string"); state.open = { close: multi[1], kind: "string" }; return out; }
      push(i, end, "string"); i = end; prev = "str"; continue;
    }
    if (lang.strings?.includes(c) && !(c === "'" && lang === LANGS.nix)) {
      const end = closing(text, i + 1, c), stop = end < 0 ? n : end;
      push(pre ?? i, stop, lang.keys && /^\s*:/.test(text.slice(stop)) ? "tag" : "string"); i = stop; pre = null; prev = "str"; continue;
    }
    if (lang.variables && c === "$") {
      const m = /^\$(?:\{[^}]*\}|\([^)]*\)|[\w@#?*!$-])[\w]*/.exec(rest());
      if (m) { push(i, i + m[0].length, "variable"); i += m[0].length; continue; }
    }
    if (lang.decorators && c === "@" && i === lead) {
      const m = /^@[\w.]+/.exec(rest());
      if (m) { push(i, i + m[0].length, "entity"); i += m[0].length; continue; }
    }
    if (lang.css && (c === "#" || c === "@" || c === "!")) {
      const m = /^[#@!][\w-]+/.exec(rest());
      if (m) { push(i, i + m[0].length, c === "#" && /^#[\da-fA-F]{3,8}$/.test(m[0]) ? "constant" : c === "#" ? "entity" : "keyword"); i += m[0].length; continue; }
    }
    if (/\d/.test(c) && !/[\w$]/.test(text[i - 1] ?? "")) {
      const m = NUMBER.exec(rest());
      push(i, i + m[0].length, "constant"); i += m[0].length; prev = "num"; continue;
    }
    const id = (lang.ident ?? IDENT).exec(rest());
    if (id) {
      const w = id[0], key = lang.nocase ? w.toLowerCase() : w, end = i + w.length;
      const after = text.slice(end).trimStart()[0];
      if (lang.prefixes?.test(w) && lang.strings.includes(text[end])) { pre = i; i = end; continue; }
      const member = text[i - 1] === "." && text[i - 2] !== ".";
      if (lang.first && i === lead) { if (lang.keywords.has(key)) push(i, end, "keyword"); }
      else if (!member && lang.keywords.has(key)) push(i, end, "keyword");
      else if (!member && lang.constants.has(key)) push(i, end, "constant");
      else if (DEFS.has(prev)) push(i, end, "entity");
      else if (lang.css && after === ":" && /^[{;]?$/.test(text.slice(0, i).trim().slice(-1)) && !/^[^;}]*\{/.test(text.slice(end))) push(i, end, "constant");
      else if (lang.calls && after === "(") push(i, end, "entity");
      else if (lang.caps && /^[A-Z]/.test(w)) push(i, end, lang.caps);
      prev = key; i = end; continue;
    }
    const op = lang.ops?.exec(rest());
    if (op) { push(i, i + op[0].length, "keyword"); i += op[0].length; prev = ""; continue; }
    if (c !== ".") prev = "";
    i++;
  }
  return out;
}

// Where a string closes: just past its closing quote, skipping escaped ones; -1 when the line ends first.
function closing(text, from, close) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\" && close !== "''") { i++; continue; }
    if (text.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

// HTML, XML and templates: comments, tag names, attribute names and their values; a tag may span lines.
function markup(text, state, push) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (state.open) {
      const end = text.indexOf(state.open.close, i);
      if (end < 0) return push(i, n, state.open.kind);
      push(i, end + state.open.close.length, state.open.kind); i = end + state.open.close.length; state.open = null; continue;
    }
    if (state.tag) {
      const s = text.slice(i), ws = /^\s+/.exec(s);
      if (ws) { i += ws[0].length; continue; }
      const close = /^\/?>|^\?>/.exec(s);
      if (close) { push(i, i + close[0].length, "tag"); i += close[0].length; state.tag = false; continue; }
      const attr = /^[^\s=>"'/]+/.exec(s);
      if (attr) { push(i, i + attr[0].length, "entity"); i += attr[0].length; continue; }
      if (s[0] === '"' || s[0] === "'") {
        const end = text.indexOf(s[0], i + 1);
        if (end < 0) { push(i, n, "string"); state.open = { close: s[0], kind: "string" }; return; }
        push(i, end + 1, "string"); i = end + 1; continue;
      }
      i++; continue;
    }
    if (text.startsWith("<!--", i)) { state.open = { close: "-->", kind: "comment" }; continue; }
    if (text.startsWith("{#", i)) { state.open = { close: "#}", kind: "comment" }; continue; }
    const tag = /^<[/!?]?[\w:.-]+/.exec(text.slice(i));
    if (tag) { push(i, i + tag[0].length, "tag"); i += tag[0].length; state.tag = true; continue; }
    const tpl = /^(\{\{|\{%|\$\{)/.exec(text.slice(i));
    if (tpl) {
      const close = { "{{": "}}", "{%": "%}", "${": "}" }[tpl[0]], end = text.indexOf(close, i);
      const stop = end < 0 ? n : end + close.length;
      push(i, stop, "variable"); i = stop; continue;
    }
    const plain = /^[^<{$]+|^./.exec(text.slice(i));
    i += plain[0].length;
  }
}

// Markdown: headings, list markers, quotes, inline code, links and fenced code.
function markdown(text, state, push) {
  if (/^\s*(```|~~~)/.test(text)) { state.fence = !state.fence; return push(0, text.length, "string"); }
  if (state.fence) return push(0, text.length, "string");
  const head = /^#{1,6}\s/.exec(text);
  if (head) return push(0, text.length, "constant");
  if (/^\s*>/.test(text)) return push(0, text.length, "tag");
  const list = /^\s*([-*+]|\d+[.)])\s/.exec(text);
  if (list) push(list[0].indexOf(list[1]), list[0].indexOf(list[1]) + list[1].length, "variable");
  for (const m of text.matchAll(/`[^`]+`|\[[^\]]*\]\([^)]*\)/g)) push(m.index, m.index + m[0].length, m[0][0] === "`" ? "string" : "constant");
}

// Gives each row of a file's diff its `tokens`, once. Each side keeps its own state: a context line is on both.
export function highlight(rows, path) {
  if (rows.lit) return rows;
  rows.lit = true;
  const lang = languageOf(path);
  if (!lang) return rows;
  let old = {}, now = {};
  for (const row of rows) {
    if (row.kind === "@") { old = {}; now = {}; continue; }
    if (!row.side || row.text.length > 1000) continue;
    if (row.kind === "-") row.tokens = tokenize(row.text, lang, old);
    else { row.tokens = tokenize(row.text, lang, now); if (row.kind === " ") old = { ...now }; }
  }
  return rows;
}
