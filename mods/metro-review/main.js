// A full-tab diff review: uncommitted changes, the last commit or the whole branch, comments on lines, sent to an agent.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { namer } from "./name.js";
import { spaces, panes, agents, focused, props, shared, setShared, nextCommand, knownAgents, run, exec, hc, readTextFile, watchFolder, theme, settings, notify } from "herdr";

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
const NUM = 52;

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

export default class Review extends View {
  init(_props, cx) {
    this.mode = props()?.mode ?? load("mode", "uncommitted");
    localStorage.removeItem("comments");
    this.viewed = load("viewed", {}); // root, mode and path -> the file's +/- counts when marked viewed
    this.listWidth = load("listWidth", 300);
    this.drag = null; // { x, width } while the file list's edge is dragged
    this.files = []; this.rows = []; this.open = null;
    this.editing = null; // { id?, path, from, to, lines, quote } while a comment is written or edited
    this.input = InputState.new({ placeholder: "Leave a comment" });
    this.input.on("submit", (_e, cx) => this.addComment(cx));
    this.handle = cx.focus_handle();
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
    this.files = []; this.open = null; this.rows = []; this.editing = null;
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
    lines = lines.slice(0, MAX_LINES).map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l));
    this.rows = diffRows(lines);
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
    return `Review comments on ${what} in ${this.root}. Please address each one. ${how}\n\n${parts.join("\n\n")}`;
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
    const out = [];
    this.rows.forEach((row, i) => { out.push({ type: "row", row, i }); out.push(...(under.get(i) ?? [])); });
    // Comments whose lines are gone from the diff now (the code changed) stay visible at the top.
    return [...lost, ...out];
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

  // The code, with the changed middle of a paired line highlighted; split at spaces so it still wraps.
  code(row, mark) {
    const text = row.text, base = div().flex_1().min_w(0).pr(12).line_height(`${ROW}px`);
    if (!row.mark || !mark) return base.child(text);
    const [from, to] = row.mark;
    const pieces = [[text.slice(0, from), false], [text.slice(from, to), true], [text.slice(to), false]]
      .flatMap(([part, changed]) => part.split(/(\s+)/).filter(Boolean).map((word) => [word, changed]));
    return base.flex().flex_wrap().children(pieces.map(([word, changed]) => div().flex_none().when(changed, (e) => e.bg(mark)).child(word)));
  }

  // A comment under its lines: click it to edit, × to delete. A range or a lost one names its lines.
  commentRow({ c, lost }, t) {
    const at = this.span(c), lines = at ? linesLabel(this.rows.slice(at.from, at.to + 1)) : c.lines;
    const cap = `${lines[0].toUpperCase()}${lines.slice(1)}`;
    const caption = lost ? `${cap} ${/^(removed )?line /.test(lines) ? "isn't" : "aren't"} in the diff any more` : at && at.from !== at.to ? cap : null;
    return h_flex().id(`comment-${c.id}`).w_full().pl(64).pr(16).py(4)
      .child(h_flex().id(`comment-card-${c.id}`).max_w(760).min_w(0).px(10).py(6).gap(8).items_start().rounded(6).bg(t.surface).border(1).border_color(t.border)
        .font_family(settings().ui_font ?? "Geist").text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip("Click to edit").on_click((_e, cx) => this.editComment(c, cx))
        .child(div().flex_1().min_w(0).text_color(t.foreground)
          .when(Boolean(caption), (el) => el.child(div().text_size(11).text_color(t.dim).child(caption)))
          .child(c.body))
        .child(div().id(`remove-${c.id}`).flex_none().pt(2).text_color(t.dim).hover((s) => s.text_color(t.foreground)).cursor_pointer()
          .role("button").accessibility_label("Delete comment").tooltip("Delete comment")
          .on_click((_e, cx) => { cx.stop_propagation(); this.removeComment(c.id, cx); })
          .child(svg("mods/metro-chrome/icons/close.svg").size(10))));
  }

  // The comment being written: the lines it covers, the input, then Cancel (Esc) and Comment or Save (Enter).
  editorRow(t, lost) {
    const e = this.editing, at = this.span(e), label = at ? linesLabel(this.rows.slice(at.from, at.to + 1)) : e.lines;
    const lines = `${label[0].toUpperCase()}${label.slice(1)}`;
    const note = lost ? `${lines}: not in the diff any more` : `${lines} · shift-click another line to widen`;
    return v_flex().id("comment-editor").w_full().pl(64).pr(16).py(6).gap(4)
      .font_family(settings().ui_font ?? "Geist")
      .child(div().text_size(11).text_color(t.dim).child(e.id ? `Editing · ${note}` : note))
      .child(div().w(560).h(32).px(10).flex().items_center().rounded(8).bg(t.background).border(1).border_color(t.accent)
        .text_size(12)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).w_full().h_full()))
      .child(h_flex().w(560).pt(2).gap(8).justify_end()
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

  render(cx) {
    const t = theme();
    const items = this.items(), sel = this.span(this.editing);
    const mine = this.mine(), list = this.targets();
    const counts = new Map();
    for (const c of mine) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const viewedCount = this.files.filter((f) => this.isViewed(f)).length;
    const openFile = this.files.find((f) => f.path === this.open);
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

    const fileList = v_flex().id("review-files").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
      .children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop(), n = counts.get(f.path), seen = this.isViewed(f);
        return h_flex().id(`file-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(this.open === f.path, (e) => e.bg(t.selected)).when(this.open !== f.path, (e) => e.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(12).flex_none().text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? parts.join("/") + "/" : ""))
            .child(div().flex_none().max_w(Math.max(120, this.listWidth - 110)).truncate().text_color(seen ? t.dim : t.foreground).child(name)))
          .when(Boolean(n), (e) => e.child(div().h(18).min_w(18).px(5).flex().items_center().justify_center().rounded(9).bg(t.accent).text_size(10).text_color(t.accent_foreground).child(String(n))))
          .child(this.checkbox(`viewed-${f.path}`, seen, t, (cx) => this.toggleViewed(f, cx)));
      }))
      .when(!this.files.length, (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim)
        .child(this.error ?? (this.loading ? "Loading changes…" : this.mode === "branch" ? "Nothing on this branch yet." : this.mode === "last" ? "The last commit changed nothing." : "No uncommitted changes."))));

    // The open file's path and its Viewed toggle, above its diff.
    const fileHead = openFile ? h_flex().h(36).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().min_w(0).truncate().text_color(t.muted).child(openFile.path))
      .child(div().text_size(12).text_color(t.ansi2).child(`+${openFile.add}`))
      .child(div().text_size(12).text_color(t.ansi1).child(`−${openFile.del}`))
      .child(div().flex_1())
      .child(h_flex().id("viewed-toggle").gap(6).items_center().cursor_pointer().text_size(12).text_color(t.muted)
        .on_click((_e, cx) => this.toggleViewed(openFile, cx))
        .child(this.checkbox("viewed-open", this.isViewed(openFile), t, (cx) => this.toggleViewed(openFile, cx)))
        .child("Viewed")) : null;
    // A plain column: comments wrap to their own height under their line.
    const diffList = v_flex().id("review-diff").flex_1().min_w(0).min_h(0).overflow_y_scrollbar().pb(24)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .children(items.map((it) => (it.type === "row" ? this.diffRow(it.row, it.i, t, sel) : it.type === "editor" ? this.editorRow(t, it.lost) : this.commentRow(it, t))))
      .when(Boolean(this.truncated), (e) => e.child(div().px(16).py(8).text_size(11).text_color(t.dim)
        .child(`Showing the first ${MAX_LINES.toLocaleString()} lines of this file.`)));
    const diff = v_flex().flex_1().min_w(0).min_h(0).when(Boolean(fileHead), (e) => e.child(fileHead)).child(diffList);
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
          .when(Boolean(modeSwitch), (e) => e.child(modeSwitch)).child(fileList))
        .child(edge)
        .child(v_flex().flex_1().min_w(0).min_h(0).child(diff).child(footer)));
  }
}
