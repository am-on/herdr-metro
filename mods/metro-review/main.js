// A full-tab diff review: uncommitted changes, the last commit or the whole branch, comments on lines, sent to an agent.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { namer } from "./name.js";
import { spaces, panes, agents, focused, props, shared, setShared, nextCommand, knownAgents, run, exec, hc, readTextFile, watchFolder, theme, settings, notify, openOverlay, closeOverlay } from "herdr";

// Reads write nothing under .git, so the folder watch doesn't wake on its own refresh.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_LINES = 2000;
const ROW = 20;
const MODES = [{ id: "uncommitted", label: "Uncommitted" }, { id: "last", label: "Last commit" }, { id: "branch", label: "Branch" }];
// Agents Send can start, in a new tab with the comments as their first message; programs.json's `run` wins once known.
const STARTERS = [
  { key: "claude", name: "Claude Code", icon: "mods/metro-chrome/icons/claude.svg", tint: false, run: ["claude"] },
  { key: "codex", name: "Codex", icon: "mods/metro-chrome/icons/openai.svg", tint: true, run: ["codex"] },
];

// Numbers each diff line on both sides; a removed line is commented on by its old number, the rest by the new one.
function diffRows(lines) {
  let old = 0, next = 0;
  return markChanges(lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1) || " ";
    if (kind === "-") return { kind, side: "old", number: old, old: old++, new: null, text };
    if (kind === "+") return { kind, side: "new", number: next, old: null, new: next++, text };
    if (kind === " ") return { kind, side: "new", number: next, old: old++, new: next++, text };
    return { kind: "", text: line };
  }));
}

// GitHub's intraline highlight: where removed lines are replaced by as many added ones, each pair's differing middle.
function markChanges(rows) {
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== "-") { i++; continue; }
    let j = i; while (j < rows.length && rows[j].kind === "-") j++;
    let k = j; while (k < rows.length && rows[k].kind === "+") k++;
    if (k - j === j - i) for (let n = 0; n < j - i; n++) markPair(rows[i + n], rows[j + n]);
    i = Math.max(k, i + 1);
  }
  return rows;
}

// Lines with less than 40% in common past their indentation were rewritten, not edited, and get no highlight.
function markPair(a, b) {
  const x = a.text, y = b.text, shorter = Math.min(x.length, y.length);
  let pre = 0; while (pre < shorter && x[pre] === y[pre]) pre++;
  let suf = 0; while (suf < shorter - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const indent = Math.min(pre, /^\s*/.exec(x)[0].length);
  if ((pre + suf - indent) / (Math.max(x.length, y.length) - indent || 1) < 0.4) return;
  if (pre < x.length - suf) a.mark = [pre, x.length - suf];
  if (pre < y.length - suf) b.mark = [pre, y.length - suf];
}

// GitHub's diff colors: line, number gutter and changed words, for added, removed and hunk rows.
const COLORS = {
  light: { "+": ["#e6ffec", "#ccffd8", "#abf2bc"], "-": ["#ffebe9", "#ffd7d5", "#ff818266"], "@": ["#ddf4ff", "#b6e3ff"] },
  dark: { "+": ["#2ea04326", "#3fb9504d", "#2ea04366"], "-": ["#f851491a", "#f851494d", "#f8514966"], "@": ["#388bfd1a", "#388bfd66"] },
};
// A search match in the code, GitHub's find highlight.
const FOUND = { light: "#ffd33d99", dark: "#bb800999" };
// The match next and previous are on.
const CURRENT = { light: "#fb8f44", dark: "#db6d28" };
// Lines shown above and below each match in the results, and a file's name row there.
const CONTEXT = 2;
const RESULT_HEAD = 40;
const RESULT_GAP = 12; // the grey between two files' cards
const RESULT_X = 12; // the grey either side of a card
const RESULT_END = 10; // the white under a card's last line, its rounded bottom edge included

// Where the needle is in a line, case-insensitive, as [start, end) pairs.
function findIn(text, needle) {
  const out = [], hay = text.toLowerCase();
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
  return out;
}

// git's C-style quoting of an unusual path in a diff header, undone.
function unquote(path) {
  if (!path.startsWith('"')) return path;
  const bytes = [], body = path.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { bytes.push(...new TextEncoder().encode(body[i])); continue; }
    const c = body[++i];
    if (/[0-7]/.test(c)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 })[c] ?? c.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// A whole diff split by file: each file's hunks, from its first `@@` on.
function diffFiles(out) {
  const files = new Map();
  let path = null, lines = null, header = false;
  for (const l of out.split("\n")) {
    if (l.startsWith("diff --git ")) { header = true; path = null; lines = null; continue; }
    if (header) {
      if (l.startsWith("--- a/") || l.startsWith('--- "a/')) path = unquote(l.slice(4)).slice(2);
      else if (l.startsWith("+++ b/") || l.startsWith('+++ "b/')) path = unquote(l.slice(4)).slice(2);
      else if (l.startsWith("@@")) { header = false; if (path !== null) files.set(path, lines = [l]); }
      continue;
    }
    if (lines && (l[0] === "+" || l[0] === "-" || l[0] === " " || l.startsWith("@@"))) lines.push(l);
  }
  return files;
}

// A diff's lines as the review shows them: the first MAX_LINES, each cut at 2,000 characters.
const cut = (lines) => lines.slice(0, MAX_LINES).map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l));
const NUM = 52;
// Where a diff line's code starts: its 2px edge, both numbers and the sign; comments line up with it.
const CODE_X = 2 + NUM * 2 + 24;

// The folder this review looks at: the one it was opened in, else its own space's first terminal's.
function where(tab = localStorage.getItem("tab")) {
  const p = props() ?? {};
  if (p.folder) return { cwd: p.folder, on: p.machine ?? null };
  const all = spaces();
  const s = all.find((x) => x.id === p.space) ?? all.find((x) => x.tabs.some((c) => c.id === tab)) ?? all.find((x) => x.active);
  const tabs = new Set((s?.tabs ?? []).map((c) => c.id));
  return { cwd: panes().find((x) => tabs.has(x.tab) && x.cwd)?.cwd || s?.folder, on: s?.machine ?? null };
}

// Draft comments, shared by every review of a repo and kept until sent: "<machine>:<root>" -> comments.
// A comment is { id, path, from, to, lines, quote, body }: `from` and `to` are the anchors of its first and last line.
const DRAFTS = "metro-review.drafts";
const NONE = "#00000000";
const QUOTED = 60;
const CARD = 560; // a comment card's width, written or posted
const TEXTAREA_GUTTER = 12; // what a textarea keeps free at its right, so posted text wraps where it was typed
// A line is found again by its side, number and text, so a comment never lands on a line that moved under it.
const anchor = (row) => ({ side: row.side, number: row.number, kind: row.kind, text: row.text });
const anchorKey = (a) => `${a.side}\u0000${a.number}\u0000${a.text}`;

// "line 12", "lines 10–14", or "removed lines 9–10" when only removed lines are in it.
function linesLabel(rows) {
  const kept = rows.filter((r) => r.side === "new").map((r) => r.number), gone = rows.filter((r) => r.side === "old").map((r) => r.number);
  const nums = kept.length ? kept : gone, pre = kept.length ? "" : "removed ";
  if (!nums.length) return "";
  const a = Math.min(...nums), b = Math.max(...nums);
  return a === b ? `${pre}line ${a}` : `${pre}lines ${a}–${b}`;
}

// The lines a comment is about as the agent reads them: number, sign and code.
function quote(rows) {
  const shown = rows.slice(0, QUOTED).map((r) => (r.side ? `${String(r.number).padStart(5)} ${r.kind} ${r.text}` : r.text));
  if (rows.length > QUOTED) shown.push(`      … ${rows.length - QUOTED} more lines`);
  return shown.join("\n");
}
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; } };

// GitHub over HTTPS with gh's token, so an SSH origin never asks the SSH agent to sign: only here, as another machine
// may have no gh.
const overHttps = (on) => on ? [] : ["-c", "url.https://github.com/.insteadOf=git@github.com:", "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

// owner/repo from an origin URL in https, ssh or scp form.
function repoOf(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// The file on GitHub: on the branch checked out when origin has the file there, else on origin's default branch.
async function githubFile({ root, on, path, base }) {
  const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
  const remote = await git(["remote", "get-url", "origin"]);
  const repo = remote.code === 0 ? repoOf(remote.stdout) : null;
  if (!repo) return { why: "No GitHub origin" };
  const branch = (await git(["branch", "--show-current"])).stdout.trim();
  const head = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const refs = [branch && `origin/${branch}`, base && `origin/${base}`, head.code === 0 ? head.stdout.trim() : null, "origin/main", "origin/master"];
  for (const ref of [...new Set(refs.filter((r) => r?.startsWith("origin/")))]) {
    if ((await git(["cat-file", "-e", `${ref}:${path}`])).code !== 0) continue;
    const name = ref.slice("origin/".length), enc = (x) => x.split("/").map(encodeURIComponent).join("/");
    return { url: `https://github.com/${repo}/blob/${enc(name)}/${enc(path)}`, branch: name };
  }
  return { why: "Not on GitHub yet" };
}

// A file's right-click menu: Copy path (absolute), Open on GitHub.
class FileMenu {
  constructor(menu, cx) {
    this.menu = menu; this.at = 0; this.github = null;
    this.handle = cx.focus_handle(); this.handle.focus();
    cx.spawn(async (cx) => {
      try { this.github = await githubFile(menu); } catch { this.github = { why: "Couldn't ask git" }; }
      cx.notify();
    });
  }

  items() {
    const g = this.github;
    return [
      { key: "copy", label: "Copy path", icon: "mods/metro-chrome/icons/copy.svg", note: "1", ready: true },
      { key: "github", label: "Open on GitHub", icon: "mods/metro-chrome/icons/github.svg", note: g ? g.branch ?? g.why : "…", ready: Boolean(g?.url) },
    ];
  }

  choose(item, cx) {
    if (!item.ready) return;
    if (item.key === "copy") cx.write_to_clipboard(`${this.menu.root}/${this.menu.path}`);
    else exec("open", [this.github.url]).catch(() => {});
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    const list = this.items(), n = list.length;
    if (e.key === "escape") return closeOverlay(props().overlay);
    if (e.key === "enter") return this.choose(list[this.at], cx);
    if (e.key === "down") this.at = (this.at + 1) % n;
    else if (e.key === "up") this.at = (this.at + n - 1) % n;
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) return this.choose(list[Number(e.key) - 1], cx);
    cx.notify();
  }

  render(t) {
    return v_flex().id("file-menu").size_full().p(6).gap(2).text_size(13).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .children(this.items().map((item, i) => h_flex().id(`menu-${item.key}`).h(32).px(8).gap(10).items_center().rounded(6).flex_none()
        .when(this.at === i, (el) => el.bg(t.selected))
        .on_hover((over, cx) => { if (over && this.at !== i) { this.at = i; cx.notify(); } })
        .on_click((_e, cx) => this.choose(item, cx))
        .when(item.key === "github" && Boolean(this.github?.url), (el) => el.tooltip(`The file on ${this.github.branch}`))
        .child(h_flex().size(18).flex_none().items_center().justify_center().child(svg(item.icon).size(14).text_color(item.ready ? t.foreground : t.dim)))
        .child(div().flex_1().min_w(0).truncate().text_color(item.ready ? t.foreground : t.dim).child(item.label))
        .child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(item.key === "github" ? item.note : String(i + 1)))));
  }
}

export default class Review extends View {
  init(_props, cx) {
    // Opened with `props().menu` this copy is a file's right-click menu instead.
    if (props()?.menu) { this.fileMenu = new FileMenu(props().menu, cx); return; }
    this.mode = props()?.mode ?? load("mode", "uncommitted");
    localStorage.removeItem("comments");
    this.viewed = load("viewed", {}); // root, mode and path -> the file's +/- counts when marked viewed
    this.listWidth = load("listWidth", 300);
    this.drag = null; // { x, width } while the file list's edge is dragged
    this.files = []; this.rows = []; this.open = null;
    this.editing = null; // { id?, path, from, to, lines, quote } while a comment is written or edited
    this.input = TextareaState.new({ placeholder: "Leave a comment" });
    this.input.set_soft_wrap(true);
    this.input.set_auto_grow(1, 10);
    // Enter adds the comment; Shift-Enter starts a new line.
    this.input.on("submit", (e, cx) => { if (!e.shift) this.addComment(cx); });
    this.handle = cx.focus_handle();
    // The search over the whole diff: what's typed, and every changed file's lines to look in.
    this.query = "";
    this.corpus = null; // path -> the diff's rows, for the diff last read
    this.showResults = true; // while searching: every match in one list, else the open file
    this.current = 0; // the match next and previous move from
    this.resultsScroll = VirtualListScrollHandle.new();
    this.search = InputState.new({ placeholder: "Search the changes" });
    this.search.on("change", (_e, cx) => this.setQuery(this.search.value(), cx));
    this.search.on("focus", (_e, cx) => { this.searchFocused = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.searchFocused = false; cx.notify(); });
    this.known = {};
    this.defaults = {}; // checkout root -> origin's default branch
    cx.spawn(async (cx) => {
      try { for (const a of await knownAgents({ on: where().on })) this.known[a.key] = a; } catch {}
      cx.notify();
    });
    // The pane header's switch and Refresh run `metro-review.uncommitted`, `.last`, `.branch` and `.refresh`.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.refresh(cx);
        else if (MODES.some((m) => m.id === c)) this.setMode(c, cx, true);
      }
    });
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }

  // Viewed holds until the file changes again: its mark records the +/- counts it was viewed at.
  viewKey(f) { return `${this.root}\u0000${this.mode}\u0000${f.path}`; }
  isViewed(f) { return this.viewed[this.viewKey(f)] === `${f.add}/${f.del}`; }

  toggleViewed(f, cx) {
    const k = this.viewKey(f);
    if (this.isViewed(f)) delete this.viewed[k];
    else {
      this.viewed[k] = `${f.add}/${f.del}`;
      // Done with the open file: on to the next one not viewed yet.
      if (this.open === f.path) {
        const i = this.files.findIndex((x) => x.path === f.path);
        const next = [...this.files.slice(i + 1), ...this.files.slice(0, i)].find((x) => !this.isViewed(x));
        if (next) this.pick(next.path, cx);
      }
    }
    localStorage.setItem("viewed", JSON.stringify(this.viewed));
    cx.notify();
  }

  checkbox(id, on, t, toggle) {
    return div().id(id).size(16).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .border(1).border_color(on ? t.accent : t.input).when(on, (e) => e.bg(t.accent))
      .role("check_box").accessibility_label(on ? "Viewed" : "Not viewed")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); toggle(cx); })
      .when(on, (e) => e.child(svg("mods/metro-chrome/icons/check.svg").size(11).text_color(t.accent_foreground)));
  }

  // The tab this copy is in: remembered, else the review pane focused when it starts, else the only review pane.
  claimTab() {
    const reviews = panes().filter((p) => p.mod === "metro-review");
    const saved = localStorage.getItem("tab");
    if (saved && reviews.some((p) => p.tab === saved)) return saved;
    const here = reviews.find((p) => p.pane === focused()?.pane) ?? (reviews.length === 1 ? reviews[0] : null);
    if (here) localStorage.setItem("tab", here.tab);
    return here?.tab ?? null;
  }

  // The pane header (metro-pane) draws this review's toolbar from `metro-review.<tab>`.
  publish(tab, summary) {
    const json = JSON.stringify(summary);
    if (json !== this.published) { this.published = json; setShared(`metro-review.${tab}`, summary); }
  }

  // Uncommitted chosen by hand stays, even with nothing in it, until it has changes again.
  setMode(mode, cx, byHand = false) {
    if (byHand) this.keepUncommitted = mode === "uncommitted";
    if (mode === this.mode) return;
    this.mode = mode; localStorage.setItem("mode", JSON.stringify(mode));
    this.files = []; this.open = null; this.rows = []; this.editing = null; this.corpus = null;
    this.refresh(cx);
    cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  // The default branch origin names now, asked once per checkout: the local origin/HEAD keeps what it was at clone.
  async originDefault(root, on) {
    if (this.defaults[root]) return this.defaults[root];
    const asked = await exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=5", "git", ...overHttps(on), "ls-remote", "--symref", "origin", "HEAD"], { cwd: root, on });
    const name = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(asked.stdout)?.[1] ?? null;
    if (name) this.defaults[root] = name;
    return name;
  }

  // The branch's base: where it left origin's default branch, else the local origin/HEAD, main or master.
  async base(git, root, on) {
    const name = await this.originDefault(root, on);
    const head = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    const candidates = [name && `origin/${name}`, head.code === 0 ? head.stdout.trim() : null, "origin/main", "main", "origin/master", "master"].filter(Boolean);
    for (const ref of candidates) {
      const mb = await git(["merge-base", "HEAD", ref]);
      if (mb.code === 0) return { sha: mb.stdout.trim(), name: ref };
    }
    return null;
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = where();
    if (!cwd) { this.error = "This tab has no folder. Open the review from a terminal in a git repository."; cx.notify(); return; }
    this.loading = true;
    const mode = this.mode;
    let empty = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) { this.root = null; this.files = []; this.error = `${cwd} isn't in a git repository.`; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        let ref = "HEAD";
        if (mode === "branch") {
          const b = await this.base(git, root, on);
          if (!b) { this.files = []; this.error = "Couldn't find main or master to compare this branch with."; return; }
          ref = b.sha; this.baseName = b.name;
        } else if (mode === "last") {
          // The last commit, with whatever is uncommitted on top of it.
          const parent = await git(["rev-parse", "--verify", "-q", "HEAD~1"]);
          if (parent.code !== 0) { this.files = []; this.error = "This repository has only one commit, so there's nothing before it to compare with."; return; }
          ref = parent.stdout.trim();
        }
        const head = await git(["log", "-1", "--format=%h %s"]);
        this.lastCommit = head.code === 0 ? head.stdout.trim() : null;
        const names = await git(["diff", ref, "--name-status", "-z", "--no-renames"]);
        const stats = await git(["diff", ref, "--numstat", "-z", "--no-renames"]);
        const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
        for (const r of [names, stats, untracked]) if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        const stat = {};
        for (const entry of stats.stdout.split("\0")) {
          const [a, d, ...parts] = entry.split("\t");
          if (parts.length) stat[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
        }
        const files = [];
        const fields = names.stdout.split("\0");
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const path = fields[i + 1];
          if (path) files.push({ path, status: fields[i][0], ...(stat[path] ?? { add: 0, del: 0 }) });
        }
        // Every line of an untracked file is added; grep -I counts a binary one as none.
        const fresh = untracked.stdout.split("\0").filter(Boolean), lines = {};
        if (fresh.length) {
          const r = await exec("sh", ["-c", "git ls-files -z -o --exclude-standard | xargs -0 grep -cHI ''"], { cwd: root, on });
          for (const l of r.stdout.split("\n")) { const i = l.lastIndexOf(":"); if (i > 0) lines[l.slice(0, i)] = parseInt(l.slice(i + 1), 10) || 0; }
        }
        for (const path of fresh) files.push({ path, status: "A", fresh: true, add: lines[path] ?? 0, del: 0 });
        files.sort((a, b) => a.path.localeCompare(b.path));
        if (mode !== this.mode) return;
        if (mode === "uncommitted") { empty = !files.length; if (files.length) this.keepUncommitted = false; }
        this.root = root; this.on = on; this.ref = ref; this.files = files; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) this.open = null;
        if (!this.open && files.length) this.open = files[0].path;
        if (this.open) await this.loadDiff(this.open);
        else this.rows = [];
        if (this.needle()) this.searchChanges(cx);
      } catch (e) {
        this.error = `Couldn't read the changes: ${String(e.message ?? e).split("\n")[0]}`;
      } finally {
        this.loading = false;
        // Nothing uncommitted: the branch's changes are what there is to review.
        if (empty && !this.keepUncommitted && this.mode === "uncommitted") this.setMode("branch", cx);
        cx.notify();
      }
    });
  }

  async loadDiff(path) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Can't show this file (binary, too large or unreadable)."];
      else if (text.includes("\0")) lines = ["Binary file, no text diff."];
      else {
        const body = text.replace(/\n$/, "").split("\n");
        file.add = body.length;
        lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", this.ref, "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed." : "No text diff."] : all.slice(first);
    }
    if (this.open !== path) return;
    this.truncated = lines.length > MAX_LINES;
    this.rows = diffRows(cut(lines));
  }

  pick(path, cx) {
    if (this.open === path) return;
    this.open = path; this.rows = []; this.editing = null;
    cx.spawn(async (cx) => {
      try { await this.loadDiff(path); } catch (e) { this.rows = diffRows([`Couldn't show this diff: ${e}`]); }
      cx.notify();
    });
    cx.notify();
  }

  // What the search looks for, lowercased; "" when nothing but spaces is typed.
  needle() { return this.query.trim() ? this.query.toLowerCase() : ""; }

  setQuery(text, cx) {
    if (text === this.query) return;
    this.query = text;
    this.showResults = true; this.current = 0;
    if (this.needle()) { if (this.corpus) this.followMatches(cx); else this.searchChanges(cx); }
    cx.notify();
  }

  clearSearch(cx) {
    this.search.set_value("");
    this.setQuery("", cx);
  }

  // Reads the whole diff, and untracked files whole, for the search; a refresh while it reads reads again after.
  searchChanges(cx) {
    if (!this.root) return;
    if (this.searching) { this.searchAgain = true; return; }
    this.searching = true; this.searchAgain = false;
    const { root, on, ref, mode } = this, files = this.files;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...READ, "-c", "core.quotePath=false", "diff", ref, "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        const corpus = new Map();
        for (const [path, lines] of diffFiles(r.stdout)) corpus.set(path, diffRows(cut(lines)));
        for (const f of files.filter((f) => f.fresh)) {
          const text = await readTextFile(`${root}/${f.path}`, { on }).catch(() => null);
          if (text === null || text.includes("\0")) continue;
          const body = text.replace(/\n$/, "").split("\n");
          corpus.set(f.path, diffRows(cut([`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)])));
        }
        if (root !== this.root || mode !== this.mode) return;
        this.corpus = corpus; this.searchError = null;
        this.followMatches(cx);
      } catch (e) {
        this.searchError = `Couldn't search the changes: ${String(e.message ?? e).split("\n")[0]}. Press Refresh to try again.`;
      } finally {
        this.searching = false;
        if (this.searchAgain && this.needle()) this.searchChanges(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  // How many times each file's diff has the search in it, for files that have it.
  matchCounts() {
    const needle = this.needle();
    if (!needle || !this.corpus) return null;
    if (this.counted?.corpus === this.corpus && this.counted.needle === needle) return this.counted.counts;
    const counts = new Map();
    for (const [path, rows] of this.corpus) {
      let n = 0;
      for (const r of rows) if (r.side) n += findIn(r.text, needle).length;
      if (n) counts.set(path, n);
    }
    this.counted = { corpus: this.corpus, needle, counts };
    return counts;
  }

  // While searching, the open file is one with a match: the first in the list when the open one has none.
  followMatches(cx) {
    const counts = this.matchCounts();
    if (!counts || counts.has(this.open)) return;
    const first = this.files.find((f) => counts.has(f.path));
    if (first) this.pick(first.path, cx);
  }

  // Every match in one list, as Zed's project search shows them: each file's name, then the lines around each of its
  // matches, a gap row where lines are skipped. `matches` is every match in order: its item and which one in its line.
  results() {
    const needle = this.needle();
    if (!needle || !this.corpus) return null;
    const r = this.memo;
    if (r?.corpus === this.corpus && r.needle === needle && r.files === this.files) return r;
    const items = [], matches = [];
    for (const f of this.files) {
      const rows = this.corpus.get(f.path);
      if (!rows) continue;
      const hits = new Map();
      rows.forEach((row, i) => { const n = row.side ? findIn(row.text, needle).length : 0; if (n) hits.set(i, n); });
      if (!hits.size) continue;
      items.push({ type: "space", key: `s\u0000${f.path}`, path: f.path });
      items.push({ type: "file", key: `f\u0000${f.path}`, path: f.path, count: [...hits.values()].reduce((a, b) => a + b, 0) });
      let last = -1;
      for (const h of hits.keys()) {
        if (h <= last) continue;
        let from = h, to = h;
        for (let k = 0; k < CONTEXT && from > 0 && rows[from - 1].side; k++) from--;
        for (let k = 0; k < CONTEXT && to + 1 < rows.length && rows[to + 1].side; k++) to++;
        from = Math.max(from, last + 1);
        if (last >= 0 && from > last + 1) items.push({ type: "gap", key: `g\u0000${f.path}\u0000${from}`, path: f.path });
        for (let i = from; i <= to; i++) {
          for (let k = 0; k < (hits.get(i) ?? 0); k++) matches.push({ at: items.length, occ: k });
          items.push({ type: "row", key: `r\u0000${f.path}\u0000${i}`, path: f.path, i, row: rows[i] });
        }
        last = to;
      }
      items.push({ type: "end", key: `e\u0000${f.path}`, path: f.path });
    }
    if (items.length) items.push({ type: "space", key: "s\u0000end" });
    this.memo = { corpus: this.corpus, needle, files: this.files, items, matches };
    return this.memo;
  }

  // Next and previous go through every match, wrapping; the list shows the results and scrolls the match to its middle.
  step(by, cx) {
    const r = this.results();
    if (!r?.matches.length) return;
    const n = r.matches.length;
    this.current = this.showResults ? (Math.min(this.current, n - 1) + by + n) % n : Math.min(this.current, n - 1);
    this.showResults = true;
    this.resultsScroll.scroll_to_item(r.matches[this.current].at, "center");
    cx.notify();
  }

  // A file opened while searching starts at its first match.
  jumpToFirst(path) {
    const rows = this.needle() ? this.corpus?.get(path) : null;
    const i = rows ? rows.findIndex((r) => r.side && r.text.toLowerCase().includes(this.needle())) : -1;
    this.jump = i >= 0 ? { path, i, text: rows[i].text } : null;
    this.jumps = (this.jumps ?? 0) + 1;
  }

  // A click on a result opens its file, still searched: only the hunks with a match show.
  openResult(key, cx) {
    const r = this.results(), at = r?.items.findIndex((x) => x.key === key) ?? -1;
    if (at < 0) return;
    const k = r.matches.findIndex((m) => m.at >= at);
    if (k >= 0) this.current = k;
    const it = r.items[at], hit = it.type === "row" ? it : r.items[r.matches[k]?.at];
    this.jump = hit?.row ? { path: it.path, i: hit.i, text: hit.row.text } : null;
    this.jumps = (this.jumps ?? 0) + 1;
    this.showResults = false;
    if (this.open === r.items[at].path) cx.notify();
    else this.pick(r.items[at].path, cx);
  }

  // Where an anchor is in the open diff: its exact line, else the one line on its side with its text, else -1.
  at(a) {
    if (this.indexed !== this.rows) {
      this.indexed = this.rows; this.index = new Map(); this.byText = new Map();
      this.rows.forEach((r, i) => {
        if (!r.side) return;
        const k = `${r.side}\u0000${r.text}`;
        this.index.set(anchorKey(r), i); this.byText.set(k, this.byText.has(k) ? -1 : i);
      });
    }
    if (!a) return -1;
    return this.index.get(anchorKey(a)) ?? this.byText.get(`${a.side}\u0000${a.text}`) ?? -1;
  }

  // The rows a comment or the editor covers in the open diff, or null when its lines aren't there.
  span(e) {
    if (!e || e.path !== this.open) return null;
    const from = this.at(e.from), to = this.at(e.to);
    return from < 0 || to < 0 ? null : { from: Math.min(from, to), to: Math.max(from, to) };
  }

  // A click comments on its line, on a hunk header the whole hunk; shift-click widens what the editor covers.
  startComment(i, shift, cx) {
    const rows = this.rows, row = rows[i];
    if (!row || !this.open) return;
    let from = i, to = i;
    if (row.kind === "@") {
      let end = i + 1; while (end < rows.length && rows[end].kind !== "@") end++;
      const lines = rows.slice(i + 1, end).map((r, k) => (r.side ? i + 1 + k : -1)).filter((k) => k >= 0);
      if (!lines.length) return;
      from = lines[0]; to = lines[lines.length - 1];
    } else if (!row.side) return;
    const e = this.editing, at = this.span(e);
    if (shift && at) { from = Math.min(from, at.from); to = Math.max(to, at.to); }
    // A new draft keeps what was typed when it moves; leaving an edit drops the edited text.
    const keep = Boolean(e) && (shift ? Boolean(at) : !e.id);
    const covered = rows.slice(from, to + 1).filter((r) => r.side || r.kind === "@");
    this.editing = { id: keep ? e.id : undefined, path: this.open, from: anchor(rows[from]), to: anchor(rows[to]), lines: linesLabel(covered), quote: quote(covered) };
    if (!keep) this.input.set_value("");
    this.input.focus();
    cx.notify();
  }

  editComment(c, cx) {
    this.editing = { id: c.id, path: c.path, from: c.from, to: c.to, lines: c.lines, quote: c.quote };
    this.input.set_value(c.body);
    this.input.focus();
    cx.notify();
  }

  closeEditor(cx) {
    this.editing = null; this.input.set_value(""); this.handle.focus();
    cx.notify();
  }

  // Enter or Comment adds the comment, or saves the edited one; an edit left empty keeps what it said.
  addComment(cx) {
    const body = this.input.value().trim(), e = this.editing;
    if (!e) return;
    if (body) {
      const c = { id: e.id ?? `${Date.now()}`, path: e.path, from: e.from, to: e.to, lines: e.lines, quote: e.quote, body };
      const at = this.span(e);
      if (at) {
        const covered = this.rows.slice(at.from, at.to + 1).filter((r) => r.side || r.kind === "@");
        Object.assign(c, { from: anchor(this.rows[at.from]), to: anchor(this.rows[at.to]), lines: linesLabel(covered), quote: quote(covered) });
      }
      const list = this.mine(), i = list.findIndex((x) => x.id === c.id);
      this.setMine(i < 0 ? [...list, c] : list.map((x) => (x.id === c.id ? c : x)));
    }
    this.closeEditor(cx);
  }

  removeComment(id, cx) {
    this.setMine(this.mine().filter((x) => x.id !== id));
    if (this.editing?.id === id) this.closeEditor(cx);
    cx.notify();
  }

  repoKey() {
    return this.root ? `${this.on ?? ""}:${this.root}` : null;
  }

  mine() {
    const k = this.repoKey();
    return (k && (shared(DRAFTS) ?? {})[k]) || [];
  }

  setMine(list) {
    const k = this.repoKey();
    if (!k) return;
    const all = { ...(shared(DRAFTS) ?? {}) };
    if (list.length) all[k] = list; else delete all[k];
    setShared(DRAFTS, all);
  }

  // The space this review's tab is in.
  space() {
    return spaces().find((s) => s.tabs.some((c) => c.id === this.tab)) ?? spaces().find((s) => s.active);
  }

  // Where comments can go: the agents running in this review's space, then a new Claude Code or Codex there.
  targets() {
    const id = this.space()?.id, name = namer();
    const running = agents().filter((a) => a.space === id)
      .map((a) => ({ key: a.address, agent: a, label: name(a), program: a.program }));
    const fresh = STARTERS.filter((s) => this.known[s.key]?.installed !== false).map((s) => ({
      key: `new:${s.key}`, starter: s, label: `New ${s.name}`,
      program: { icon: this.known[s.key]?.icon ?? s.icon, tint: this.known[s.key]?.tint ?? s.tint },
    }));
    return [...running, ...fresh];
  }

  message(list) {
    const what = this.mode === "branch" ? `everything on this branch since it left ${this.baseName ?? "main"}`
      : this.mode === "last" ? `the last commit (${this.lastCommit ?? "HEAD"}) and the uncommitted changes on top of it` : "the uncommitted changes";
    const sorted = [...list].sort((a, b) => a.path.localeCompare(b.path) || a.to.number - b.to.number);
    const parts = sorted.map((c, i) => `### ${i + 1}. ${c.path}, ${c.lines}\n\`\`\`\n${c.quote}\n\`\`\`\n${c.body}`);
    const how = "Each quotes its lines as number, sign (+ added, - removed) and code; removed lines carry the old file's numbers.";
    return `Review comments on ${what} in ${this.root}. Where a comment asks a question, answer it and change nothing; change code only where a comment asks for a change. ${how}\n\n${parts.join("\n\n")}`;
  }

  // Clicking an agent sends at once; clicking New starts that agent with the comments.
  send(to, cx) {
    const list = this.mine(), space = this.space();
    if (!list.length || this.sending) return;
    this.sending = to.key; this.note = null;
    const count = `${list.length} comment${list.length === 1 ? "" : "s"}`;
    cx.spawn(async (cx) => {
      try {
        if (to.agent) {
          const r = await hc(["send", to.agent.address, this.message(list)]);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc send exited with ${r.code}`);
        } else {
          const argv = this.known[to.starter.key]?.run ?? to.starter.run;
          run("tab.new", { ...(space ? { space: space.id } : {}), folder: this.root, argv, task: this.message(list) });
        }
        const sent = new Set(list.map((c) => c.id));
        this.setMine(this.mine().filter((c) => !sent.has(c.id)));
        if (to.agent) notify({ title: `Sent ${count}`, body: `To ${to.label}. Click to watch it work.`, level: "success", action: { name: "agent.focus", args: { terminal: to.agent.address } } });
        else notify({ title: `Started ${to.starter.name} with ${count}`, body: "In a new tab of this space.", level: "success" });
      } catch (e) {
        const what = to.agent ? `send the comments to ${to.label}` : `start ${to.starter.name}`;
        const next = to.agent ? "check the agent is still running and try again" : `check ${to.starter.name} starts from a terminal and try again`;
        this.note = `Couldn't ${what}: ${String(e.message ?? e).split("\n")[0]}. Your comments are kept; ${next}.`;
      } finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  }

  // Diff rows, each comment under its last line and the editor under the lines it covers; the comment being edited gives way to the editor.
  items() {
    const e = this.editing?.path === this.open ? this.editing : null;
    const under = new Map(), lost = [];
    const place = (i, item) => (i < 0 ? lost.push({ ...item, lost: true }) : under.set(i, [...(under.get(i) ?? []), item]));
    for (const c of this.mine().filter((c) => c.path === this.open)) if (c.id !== e?.id) place(this.at(c.to), { type: "comment", c });
    if (e) place(this.at(e.to), { type: "editor" });
    const editorAt = e ? this.at(e.to) : -1, shown = this.shownRows(editorAt);
    // Opened from the search, the file starts two lines above its match; what's above folds into one row that opens it.
    let start = 0;
    const j = this.jump;
    if (shown && j?.path === this.open) {
      const at = this.rows[j.i]?.side && this.rows[j.i].text === j.text ? j.i : this.rows.findIndex((r) => r.side && r.text === j.text);
      if (at >= 0) { start = at; for (let k = 0; k < CONTEXT && start > 0 && this.rows[start - 1].side; k++) start--; }
      if (editorAt >= 0 && editorAt < start) start = 0;
    }
    const out = [];
    let above = 0;
    this.rows.forEach((row, i) => {
      if (shown && !shown.has(i)) return;
      if (i < start) { if (row.side) above++; return; }
      out.push({ type: "row", row, i }); out.push(...(under.get(i) ?? []));
    });
    // Comments whose lines are gone from the diff now (the code changed) stay visible at the top.
    return [...lost, ...(above ? [{ type: "above", n: above }] : []), ...out];
  }

  // While searching, the rows of the hunks with a match, and of the hunk the comment being written is in; null shows every row.
  shownRows(editorAt) {
    const needle = this.needle();
    if (!needle) return null;
    const rows = this.rows, shown = new Set();
    for (let start = 0; start < rows.length;) {
      let end = start + 1; while (end < rows.length && rows[end].kind !== "@") end++;
      let keep = editorAt >= start && editorAt < end;
      for (let i = start; i < end && !keep; i++) keep = Boolean(rows[i].side) && rows[i].text.toLowerCase().includes(needle);
      if (keep) for (let i = start; i < end; i++) shown.add(i);
      start = end;
    }
    return shown;
  }

  // The lines above where the search opened the file, folded; a click shows them.
  aboveRow(n, t) {
    return h_flex().id("lines-above").w_full().h(28).pl(NUM * 2 + 12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .cursor_pointer().text_color(t.muted).font_family(settings().ui_font ?? "Geist").text_size(12)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.jump = null; cx.notify(); })
      .child(svg("mods/metro-chrome/icons/chevron-up.svg").size(13))
      .child(`Show ${n} line${n === 1 ? "" : "s"} above`);
  }

  // Laid out as GitHub's unified diff: old and new numbers in a tinted gutter, the sign, then the code.
  // A long line wraps; its numbers and sign stay on the first line and the gutter runs its full height.
  diffRow(row, i, t, sel) {
    const c = COLORS[settings().dark ? "dark" : "light"][row.kind];
    const on = Boolean(sel) && i >= sel.from && i <= sel.to;
    const num = (n) => div().w(NUM).h(ROW).flex_none().px(10).flex().items_center().justify_end()
      .text_color(c ? t.foreground : t.dim).child(n === null ? "" : String(n));
    if (row.kind === "@") return h_flex().id(`hunk-${i}`).w_full().h(ROW).items_stretch().bg(c[0]).text_color(t.muted)
      .border_l(2).border_color(NONE).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .tooltip("Comment on this hunk")
      .on_click((ev, cx) => this.startComment(i, ev.modifiers?.shift, cx))
      .child(div().w(NUM * 2).flex_none().bg(c[1]))
      .child(div().flex_1().min_w(0).px(10).flex().items_center().truncate().child(row.text));
    if (!row.side) return div().w_full().h(ROW).pl(NUM * 2 + 12).flex().items_center().text_color(t.dim).child(row.text);
    return h_flex().id(`line-${row.side}-${row.number}`).w_full().min_h(ROW).items_stretch().cursor_pointer()
      .border_l(2).border_color(on ? t.accent : NONE)
      .when(Boolean(c), (e) => e.bg(c[0])).when(on && !c, (e) => e.bg(t.accent + "14"))
      .hover((s) => s.bg(t.accent + "22"))
      .on_click((ev, cx) => this.startComment(i, ev.modifiers?.shift, cx))
      .child(h_flex().flex_none().items_start().when(Boolean(c), (e) => e.bg(c[1])).child(num(row.old)).child(num(row.new)))
      .child(div().w(24).h(ROW).flex_none().flex().items_center().justify_center().child(row.kind === " " ? "" : row.kind))
      .child(this.code(row, c?.[2]));
  }

  // The code, with the changed middle of a paired line and the search's matches highlighted; split at spaces so it still wraps.
  code(row, mark, line = false, current = -1) {
    const text = row.text, base = div().flex_1().min_w(0).pr(12).line_height(`${ROW}px`);
    const changed = row.mark && mark ? row.mark : null, hits = findIn(text, this.needle());
    if (!changed && !hits.length) return line ? base.truncate().child(text) : base.child(text);
    const cuts = [...new Set([0, text.length, ...(changed ?? []), ...hits.flat()])].sort((a, b) => a - b);
    const pieces = [], look = settings().dark ? "dark" : "light";
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = cuts[k], b = cuts[k + 1], hit = hits.findIndex(([x, y]) => a >= x && b <= y);
      const bg = hit >= 0 ? (hit === current ? CURRENT : FOUND)[look] : changed && a >= changed[0] && b <= changed[1] ? mark : null;
      for (const word of text.slice(a, b).split(/(\s+)/).filter(Boolean)) pieces.push([word, bg]);
    }
    // One line: a result row is 20px high and cut at the right.
    return (line ? base.flex().overflow_hidden() : base.flex().flex_wrap())
      .children(pieces.map(([word, bg]) => div().flex_none().when(Boolean(bg), (e) => e.bg(bg)).child(word)));
  }

  // A row of the results: a file's name and match count, a gap where lines are skipped, or a diff line on one line.
  // Drawn inside a virtual list, so it has no handlers: the list's on_item_click takes the clicks.
  resultRow(it, t, current) {
    // Each file is a white card on the sidebar's grey, as the sidebar's shown agent is: a 1px border, rounded corners, its
    // name in bold on top, over a line. A list row is drawn alone, so each one draws its slice of the card's sides.
    if (it.type === "space") return div().w_full().h(RESULT_GAP).bg(t.chrome);
    const slice = (el, top = false, end = false) => div().w_full().h(it.type === "file" ? RESULT_HEAD : end ? RESULT_END : ROW).px(RESULT_X).bg(t.chrome)
      .child(div().size_full().overflow_hidden().bg(t.background).border_color(t.border).border_l(1).border_r(1)
        .when(top, (e) => e.border_t(1).rounded_t(6)).when(end, (e) => e.border_b(1).rounded_b(6))
        .when(Boolean(el), (e) => e.child(el)));
    if (it.type === "end") return slice(null, false, true);
    if (it.type === "file") {
      const parts = it.path.split("/"), name = parts.pop();
      return slice(h_flex().size_full().px(14).gap(8).items_center().border_b(1).border_color(t.border).bg(t.background)
        .cursor_pointer().font_family(settings().ui_font ?? "Geist").text_size(13)
        .child(svg("mods/metro-chrome/icons/file.svg").size(14).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().text_color(t.muted).child(parts.length ? parts.join("/") + "/" : ""))
        .child(div().flex_none().font_family(".SystemUIFont").font_weight(700).text_color(t.foreground).child(name))
        .child(div().flex_1())
        .child(div().flex_none().h(20).px(7).flex().items_center().rounded(10).border(1).border_color(t.border).bg(t.background)
          .text_size(11).text_color(t.muted).child(`${it.count} match${it.count === 1 ? "" : "es"}`)), true);
    }
    if (it.type === "gap") return slice(h_flex().w_full().h(ROW).pl(NUM * 2 + 12).items_center().text_color(t.dim).child("⋯"));
    const row = it.row, c = COLORS[settings().dark ? "dark" : "light"][row.kind];
    const num = (n) => div().w(NUM).h(ROW).flex_none().px(10).flex().items_center().justify_end()
      .text_color(c ? t.foreground : t.dim).child(n === null ? "" : String(n));
    return slice(h_flex().w_full().h(ROW).items_stretch().cursor_pointer().border_l(2).border_color(current >= 0 ? t.accent : NONE)
      .when(Boolean(c), (e) => e.bg(c[0]))
      .child(h_flex().flex_none().when(Boolean(c), (e) => e.bg(c[1])).child(num(row.old)).child(num(row.new)))
      .child(div().w(24).h(ROW).flex_none().flex().items_center().justify_center().child(row.kind === " " ? "" : row.kind))
      .child(this.code(row, c?.[2], true, current)));
  }

  // What a comment's card says above its text: the lines of a range, or that its lines left the diff.
  caption(e, lost) {
    const at = this.span(e), lines = at ? linesLabel(this.rows.slice(at.from, at.to + 1)) : e.lines;
    const cap = `${lines[0].toUpperCase()}${lines.slice(1)}`;
    return { lines: cap, caption: lost ? `${cap} ${/^(removed )?line /.test(lines) ? "isn't" : "aren't"} in the diff any more` : at && at.from !== at.to ? cap : null };
  }

  // The card a comment is shown in and written in, the same size both ways, so its text doesn't move when posted.
  card(t, id, caption, body) {
    return v_flex().id(id).w(CARD).min_w(0).px(10).py(6).rounded(6).border(1).text_color(t.foreground)
      .font_family(settings().ui_font ?? "Geist").text_size(12).line_height("18px")
      .when(Boolean(caption), (el) => el.child(div().text_size(11).text_color(t.dim).child(caption)))
      .child(body);
  }

  // A comment under its lines: click it to edit; the × beside it, outside the card, deletes it. A range or a lost one names its lines.
  commentRow({ c, lost }, t) {
    const { caption } = this.caption(c, lost);
    return h_flex().id(`comment-${c.id}`).w_full().pl(CODE_X).pr(16).py(4).gap(4).items_start()
      .child(this.card(t, `comment-card-${c.id}`, caption, div().pr(TEXTAREA_GUTTER).child(c.body))
        .bg(t.surface).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip("Click to edit").on_click((_e, cx) => this.editComment(c, cx)))
      .child(div().id(`remove-${c.id}`).size(24).mt(4).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label("Delete comment").tooltip("Delete comment")
        .on_click((_e, cx) => { cx.stop_propagation(); this.removeComment(c.id, cx); })
        .child(svg("mods/metro-chrome/icons/close.svg").size(12)));
  }

  // The comment being written, in its card; under it what it covers, then Cancel (Esc) and Comment or Save (Enter).
  editorRow(t, lost) {
    const e = this.editing, { lines, caption } = this.caption(e, lost);
    const note = `${e.id ? "Editing · " : ""}${lost ? "Not in the diff any more" : `${lines} · shift-click another line to widen`} · shift-↵ for a new line`;
    return v_flex().id("comment-editor").w_full().pl(CODE_X).pr(16).py(4).gap(6)
      .child(this.card(t, "comment-editor-card", caption, Textarea.new(this.input).w_full())
        .bg(t.background).border_color(t.accent)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => { if (e.key === "enter" && !e.modifiers?.shift) { cx.stop_propagation(); this.addComment(cx); } }))
      .child(h_flex().w(CARD).gap(8).items_center().font_family(settings().ui_font ?? "Geist")
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(note))
        .child(this.editorButton(t, "comment-cancel", "Cancel", "esc", false, (cx) => this.closeEditor(cx)))
        .child(this.editorButton(t, "comment-add", e.id ? "Save" : "Comment", "↵", true, (cx) => this.addComment(cx))));
  }

  // Each button names its key in a small label after its words.
  editorButton(t, id, label, key, primary, action) {
    return h_flex().id(id).h(28).pl(12).pr(6).gap(8).flex_none().items_center().rounded(6).border(1).text_size(12)
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.background).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => (primary ? s.opacity(0.85) : s.bg(t.hover)))
      .role("button").accessibility_label(`${label} (${key === "↵" ? "Enter" : "Esc"})`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(label)
      .child(div().h(18).px(5).flex().items_center().rounded(4).text_size(11)
        .bg(primary ? "#ffffff2e" : t.surface).border(1).border_color(primary ? "#ffffff40" : t.border)
        .text_color(primary ? t.solid_foreground : t.muted).child(key));
  }

  // A file's menu opens at the pointer; the review's default branch, when known, is where GitHub's copy is looked for second.
  openMenu(f) {
    if (!this.root) return;
    openOverlay({ mod: "metro-review", kind: "popup", width: 260, height: 80,
      props: { menu: { root: this.root, on: this.on ?? null, path: f.path, base: this.defaults[this.root] ?? null } } });
  }

  render(cx) {
    const t = theme();
    if (this.fileMenu) return this.fileMenu.render(t);
    const items = this.items(), sel = this.span(this.editing);
    const mine = this.mine(), list = this.targets();
    const counts = new Map();
    for (const c of mine) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const viewedCount = this.files.filter((f) => this.isViewed(f)).length;
    // While a search finds nothing in the open file, no file is open.
    const searched = this.matchCounts();
    const openFile = this.files.find((f) => f.path === this.open && (!searched || searched.has(f.path)));
    const tab = this.tab ??= this.claimTab();
    if (tab) this.publish(tab, { mode: this.mode, base: this.baseName ?? null, last: this.lastCommit ?? null, listWidth: this.listWidth,
      files: this.files.length, add, del, loading: Boolean(this.loading) });

    // The switch sits in the pane header, over the file list; without a known tab the review draws it there itself.
    const modeSwitch = tab ? null : h_flex().h(40).flex_none().px(8).items_center().child(h_flex().w_full().h(26).p(2).gap(2).rounded(6)
      .border(1).border_color(t.input).bg(t.raised).children(MODES.map((m) => {
        const on = this.mode === m.id;
        return div().id(`mode-${m.id}`).flex_auto().min_w(0).h(20).px(8).flex().items_center().justify_center().rounded(4).text_size(12).cursor_pointer()
          .border(1).border_color(on ? t.input : "#00000000")
          .when(on, (e) => e.bg(t.background).text_color(t.foreground).shadow_sm())
          .when(!on, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
          .when(m.id === "branch" && Boolean(this.baseName), (e) => e.tooltip(`Compared with ${this.baseName}`))
          .when(m.id === "last" && Boolean(this.lastCommit), (e) => e.tooltip(`${this.lastCommit}, and anything uncommitted`))
          .on_click((_e, cx) => this.setMode(m.id, cx, true))
          .child(div().min_w(0).truncate().child(m.label));
      })));

    // The search over the whole diff; while it reads, its icon spins, and Esc or the × clears it.
    const needle = this.needle(), found = this.matchCounts();
    const results = this.results(), any = Boolean(results?.matches.length);
    const arrow = (id, label, dir, by) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(any ? t.muted : t.dim + "66").role("button").accessibility_label(label)
      .when(any, (el) => el.cursor_pointer().tooltip(label).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.step(by, cx); }))
      .child(svg(`mods/metro-chrome/icons/chevron-${dir}.svg`).size(13));
    const searchBox = h_flex().h(40).flex_none().px(8).items_center().child(
      h_flex().id("review-search").w_full().h(28).pl(8).pr(2).gap(6).items_center().rounded(6).border(1)
        .border_color(this.searchFocused ? t.accent : t.input).bg(t.background)
        .on_key_down((e, cx) => {
          if (e.key === "escape" && this.query) { cx.stop_propagation(); this.clearSearch(cx); }
          else if (e.key === "enter" && needle) { cx.stop_propagation(); this.step(e.modifiers?.shift ? -1 : 1, cx); }
        })
        .child(svg(this.searching && needle ? "mods/metro-chrome/icons/spinner.svg" : "mods/metro-chrome/icons/search.svg").size(13).flex_none().text_color(t.dim)
          .when(Boolean(this.searching && needle), (el) => el.spin(900)))
        .child(Input.new(this.search).flex_1().min_w(0).h_full().items_center().text_size(12).text_color(t.foreground))
        .when(Boolean(needle && results), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim)
          .child(results.matches.length ? `${Math.min(this.current, results.matches.length - 1) + 1}/${results.matches.length}` : "0/0")))
        .child(arrow("search-prev", "Previous match (shift-↵)", "up", -1))
        .child(arrow("search-next", "Next match (↵)", "down", 1))
        .child(div().id("search-clear").size(22).flex_none().flex().items_center().justify_center().rounded(4)
          .when(Boolean(this.query), (el) => el.cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .role("button").accessibility_label("Clear search").tooltip("Clear search")
            .on_click((_e, cx) => { cx.stop_propagation(); this.clearSearch(cx); })
            .child(svg("mods/metro-chrome/icons/close.svg").size(11)))));
    const listed = found ? this.files.filter((f) => found.has(f.path)) : needle ? [] : this.files;
    const emptyNote = needle
      ? this.searchError ?? (found ? `Nothing in the changes matches “${this.query.trim()}”.` : "Searching the changes…")
      : this.error ?? (this.loading ? "Loading changes…" : this.mode === "branch" ? "Nothing on this branch yet." : this.mode === "last" ? "The last commit changed nothing." : "No uncommitted changes.");

    // A list that scrolls beside an always-visible 10px bar on its right edge, as the sidebar's lists do.
    const scrolled = (id, content) => div().relative().flex_1().min_w(0).min_h(0)
      .child(v_flex().id(id).size_full().overflow_y_scroll().child(content))
      .child(div().absolute().top(0).bottom(0).right(0).w(10).child(Scrollbar.vertical(id).size_full().mode("always")));
    const fileList = scrolled("review-files", v_flex().w_full().flex_none().pl(6).pr(15).py(6).gap(1)
      .children(listed.map((f) => {
        const parts = f.path.split("/"), name = parts.pop(), n = counts.get(f.path), seen = this.isViewed(f), hits = found?.get(f.path);
        return h_flex().id(`file-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(this.open === f.path, (e) => e.bg(t.selected)).when(this.open !== f.path, (e) => e.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.showResults = false; this.jumpToFirst(f.path); this.pick(f.path, cx); cx.notify(); })
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(f); })
          .child(div().w(12).flex_none().text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? parts.join("/") + "/" : ""))
            .child(div().flex_none().max_w(Math.max(120, this.listWidth - 110)).truncate().text_color(seen ? t.dim : t.foreground).child(name)))
          .when(Boolean(hits), (e) => e.child(div().id(`hits-${f.path}`).flex_none().text_size(11).text_color(t.muted)
            .tooltip(`${hits} match${hits === 1 ? "" : "es"}`).child(String(hits))))
          .when(Boolean(n), (e) => e.child(div().h(18).min_w(18).px(5).flex().items_center().justify_center().rounded(9).bg(t.accent).text_size(10).text_color(t.accent_foreground).child(String(n))))
          .child(this.checkbox(`viewed-${f.path}`, seen, t, (cx) => this.toggleViewed(f, cx)));
      }))
      .when(!listed.length, (e) => e.child(div().p(8).text_color((needle ? this.searchError : this.error) ? t.ansi1 : t.dim).child(emptyNote))));

    // The open file's path and its Viewed toggle, above its diff.
    const fileHead = openFile ? h_flex().h(36).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().id("open-path").min_w(0).truncate().text_color(t.muted).child(openFile.path)
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(openFile); }))
      .child(div().text_size(12).text_color(t.ansi2).child(`+${openFile.add}`))
      .child(div().text_size(12).text_color(t.ansi1).child(`−${openFile.del}`))
      .child(div().flex_1())
      // While searching, the way back to every match.
      .when(Boolean(results), (e) => e.child(h_flex().id("back-to-results").h(24).px(8).gap(6).items_center().rounded(6).cursor_pointer()
        .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.showResults = true; this.step(0, cx); })
        .child(svg("mods/metro-chrome/icons/search.svg").size(12)).child("All matches")))
      .child(h_flex().id("viewed-toggle").gap(6).items_center().cursor_pointer().text_size(12).text_color(t.muted)
        .on_click((_e, cx) => this.toggleViewed(openFile, cx))
        .child(this.checkbox("viewed-open", this.isViewed(openFile), t, (cx) => this.toggleViewed(openFile, cx)))
        .child("Viewed")) : null;
    // A plain column: comments wrap to their own height under their line.
    // A new id for each file and each search jump: the column starts at its top, not where the last one was scrolled.
    const diffList = scrolled(`review-diff-${this.open}-${this.jumps ?? 0}`, v_flex().w_full().flex_none().pr(10).pb(24)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .children((openFile ? items : []).map((it) => (it.type === "row" ? this.diffRow(it.row, it.i, t, sel) : it.type === "above" ? this.aboveRow(it.n, t) : it.type === "editor" ? this.editorRow(t, it.lost) : this.commentRow(it, t))))
      .when(Boolean(this.truncated), (e) => e.child(div().px(16).py(8).text_size(11).text_color(t.dim)
        .child(`Showing the first ${MAX_LINES.toLocaleString()} lines of this file.`))));
    // While searching, every match in one list, until a result or a file is opened.
    const hit = results?.matches[Math.min(this.current, results.matches.length - 1)];
    // The whole panel is the cards' grey, below the last card too.
    const resultList = results && this.showResults ? h_flex().relative().flex_1().min_w(0).min_h(0).bg(t.chrome)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .child(div().flex_1().min_w(0).h_full().child(v_virtual_list("review-results", results.items.length,
        results.items.map((it) => (it.type === "file" ? RESULT_HEAD : it.type === "space" ? RESULT_GAP : it.type === "end" ? RESULT_END : ROW)), (i) => results.items[i].key,
        (range) => results.items.slice(range.start, range.end).map((it, k) => this.resultRow(it, t, hit?.at === range.start + k ? hit.occ : -1)))
        .size_full().track_scroll(this.resultsScroll).on_item_click((key, cx) => this.openResult(key, cx))))
      .child(div().w(10).h_full().flex_none().relative().child(Scrollbar.vertical("review-results").viewport_from_layout().absolute().inset_0().mode("always")))
      .when(!results.items.length, (e) => e.child(div().absolute().top(12).left(16).text_color(t.dim).font_family(settings().ui_font ?? "Geist").text_size(13)
        .child(`Nothing in the changes matches “${this.query.trim()}”.`))) : null;
    const diff = v_flex().flex_1().min_w(0).min_h(0).when(Boolean(resultList), (e) => e.child(resultList))
      .when(!resultList, (e) => e.when(Boolean(fileHead), (e) => e.child(fileHead)).child(diffList));
    // Dragging this edge sets the file list's width.
    const edge = div().id("files-edge").w(5).ml(-3).flex_none().cursor_col_resize().hover((s) => s.bg(t.accent + "55"))
      .when(Boolean(this.drag), (e) => e.bg(t.accent + "55"))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.drag = { x: e.position.x, width: this.listWidth }; cx.notify(); });

    // Under the diff: the whole change on the left; on the right the hint, or the agents to send to, beside Send.
    const footer = v_flex().flex_none().border_t(1).border_color(t.border)
      .when(Boolean(this.note), (e) => e.child(div().px(14).pt(8).text_size(12).text_color(t.ansi1).child(this.note)))
      .child(h_flex().h(48).px(14).gap(10).items_center().text_size(12)
        // The pane header shows the files and lines; without a known tab, the footer does.
        .when(!tab, (e) => e.child(div().flex_none().text_color(t.dim).child(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`)))
        .when(this.files.length > 0, (e) => e.child(div().flex_none().text_color(viewedCount === this.files.length ? t.ansi2 : t.dim).child(`${viewedCount} of ${this.files.length} viewed`)))
        .when(!tab, (e) => e.child(div().flex_none().text_color(t.ansi2).child(`+${add}`)).child(div().flex_none().text_color(t.ansi1).child(`−${del}`)))
        .when(this.loading, (e) => e.child(svg("mods/metro-chrome/icons/spinner.svg").size(12).flex_none().text_color(t.dim).spin(900)))
        .child(div().flex_1().min_w(0))
        .when(!mine.length, (e) => e.child(div().flex_none().text_color(t.dim).child("Click a line or a hunk to comment on it")))
        .when(mine.length > 0, (e) => e.child(div().flex_none().text_color(t.foreground).child(`${mine.length} comment${mine.length === 1 ? "" : "s"}, send to`)))
        // Running agents' names give way first; a new agent is its logo and "New", its full name on hover.
        .when(mine.length > 0, (e) => {
          const chip = (x) => {
            const p = x.program, busy = this.sending === x.key;
            const label = x.starter ? `Start a new ${x.starter.name} with these comments` : `Send to ${x.label}`;
            return h_flex().id(`to-${x.key}`).h(28).px(8).gap(6).items_center().rounded(6)
              .when(!x.starter, (el) => el.min_w(0).flex_shrink(1)).when(Boolean(x.starter), (el) => el.flex_none())
              .border(1).border_color(busy ? t.accent : t.border).when(busy, (el) => el.bg(t.accent + "18"))
              .when(!this.sending, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.send(x, cx)))
              .when(Boolean(this.sending) && !busy, (el) => el.text_color(t.dim))
              .tooltip(label).role("button").accessibility_label(label)
              .child(busy ? svg("mods/metro-chrome/icons/spinner.svg").size(13).flex_none().text_color(t.dim).spin(900)
                : p?.icon ? (p.tint ? svg(p.icon).size(13).flex_none().text_color(t.foreground) : image(p.icon).size(13).flex_none()) : div())
              .child(div().min_w(0).max_w(160).truncate().child(x.starter ? "New" : x.label));
          };
          const running = list.filter((x) => !x.starter), fresh = list.filter((x) => x.starter);
          return e
            .when(running.length > 0, (el) => el.child(h_flex().min_w(0).flex_shrink(1).gap(4).items_center().children(running.map(chip))))
            .when(running.length > 0 && fresh.length > 0, (el) => el.child(div().w(1).h(18).flex_none().bg(t.border)))
            .child(h_flex().flex_none().gap(4).items_center().children(fresh.map(chip)));
        }));

    return v_flex().id("review").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.editing) { cx.stop_propagation(); this.closeEditor(cx); }
        else if (e.keystroke === "cmd-f") { cx.stop_propagation(); this.search.focus(); }
        else if (e.keystroke === "cmd-g" || e.keystroke === "cmd-shift-g") { cx.stop_propagation(); this.step(e.modifiers.shift ? -1 : 1, cx); }
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        this.listWidth = Math.round(Math.min(700, Math.max(180, this.drag.width + e.position.x - this.drag.x)));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (!this.drag) return;
        this.drag = null; localStorage.setItem("listWidth", JSON.stringify(this.listWidth)); cx.notify();
      })
      // The file list runs the full height on the left; the diff and its footer share the right.
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .child(v_flex().w(this.listWidth).flex_none().min_h(0).border_r(1).border_color(t.border)
          .when(Boolean(modeSwitch), (e) => e.child(modeSwitch)).child(searchBox).child(fileList))
        .child(edge)
        .child(v_flex().flex_1().min_w(0).min_h(0).child(diff).child(footer)));
  }
}
