// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, agents, terminals, machines, panes, layout, run, openOverlay, exec, hc, home, theme, shared, setShared, watchFolder, window } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const tilde = (path) => (path && (path === home() || path.startsWith(home() + "/")) ? "~" + path.slice(home().length) : path);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The agent view keeps the space of the agent it shows, so space.select alone changes nothing there:
// show this space's agent (its active tab's first), or the tabs when it has none.
function select(s) {
  if (find(layout(), "view")?.active === "agent") {
    const tab = s.tabs.find((c) => c.active)?.id, mine = agents().filter((a) => a.space === s.id);
    const a = mine.find((a) => a.tab === tab) ?? mine[0];
    if (a) return run("agent.focus", { terminal: a.address });
    run("layout.select", { stack: "view", child: "main" });
  }
  run("space.select", { id: s.id });
}
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// Working: a green dot whose soft halo grows and shrinks, natively, in the 14px mark column, as in metro-agents.
const breathing = (color) => div().relative().size(14).flex_none()
  .child(div().absolute().rounded_full().bg(color + "40")
    .loop("width", { from: 6, to: 14, period: 1800 }).loop("height", { from: 6, to: 14, period: 1800 })
    .loop("left", { from: 4, to: 0, period: 1800 }).loop("top", { from: 4, to: 0, period: 1800 }))
  .child(div().absolute().left(4).top(4).size(6).rounded_full().bg(color));

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
// The avatar's letter: white, or near-black on a light color such as yellow.
const ink = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#1f2328" : "#ffffff";
};

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, rewritten, add, del, repo, top, linked }, null: not a repo
    this.trees = {}; // repo -> its checkouts: { path, branch, main }
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.dragging = null; // the project key whose row is pressed, to drop on another project's row
    this.dropOn = null;
    this.renaming = null; // the project key whose title is being edited
    this.nameInput = InputState.new({ placeholder: "Project name" });
    this.nameInput.on("submit", (_e, cx) => this.finishRename(true, cx));
    this.nameInput.on("blur", (_e, cx) => this.finishRename(true, cx));
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.foldedRepos = new Set(JSON.parse(localStorage.getItem("repos.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, add: 0, del: 0, repo: JSON.stringify([on, repo]), top: top.stdout.trim(), linked: repo !== `${top.stdout.trim()}/.git` };
      // Every checkout of the repo, so the ones no space shows are listed under it too.
      const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd, on });
      if (list.code === 0) this.trees[info.repo] = list.stdout.trim().split(/\n\n+/).map((block) => block.split("\n"))
        .filter((lines) => !lines.some((l) => l === "bare" || l.startsWith("prunable")))
        .map((lines, n) => ({ path: lines[0].slice(9), branch: lines.find((l) => l.startsWith("branch "))?.slice(18) ?? null, main: n === 0 }));
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      Object.assign(info, await this.changes(r.stdout, cwd, on));
      info.ahead = await this.unpushed(r.stdout, info, cwd, on);
      info.rewritten = await this.rewritten(info, cwd, on);
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  // Uncommitted lines, as a review of Uncommitted counts them: tracked files against HEAD, every line of an untracked one.
  async changes(status, cwd, on) {
    const lines = status.split("\n");
    let add = 0, del = 0;
    const sum = (out) => {
      for (const l of out.split("\n")) {
        const [a, d] = l.split("\t");
        add += parseInt(a, 10) || 0;
        del += parseInt(d, 10) || 0;
      }
    };
    if (lines.some((l) => /^[12u] /.test(l))) {
      const git = (args) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "diff", "--numstat", "--no-renames", ...args], { cwd, on });
      // Before the first commit there's no HEAD: the staged files, then the work tree's changes to them.
      if (lines.includes("# branch.oid (initial)")) for (const args of [["--cached"], []]) sum((await git(args)).stdout);
      else sum((await git(["HEAD"])).stdout);
    }
    if (lines.some((l) => l.startsWith("? "))) {
      // grep -I counts a binary file as no lines.
      const r = await exec("sh", ["-c", "git ls-files -z -o --exclude-standard | xargs -0 grep -cHI ''"], { cwd, on });
      for (const l of r.stdout.split("\n")) add += parseInt(l.slice(l.lastIndexOf(":") + 1), 10) || 0;
    }
    return { add, del };
  }

  // Commits on no remote, so a branch never pushed counts too. Nothing when its upstream is gone (pushed, then deleted
  // after merging) or for a fork's PR (`pr/<n>`, on GitHub's pull refs only); without remotes, ahead of its upstream.
  async unpushed(status, info, cwd, on) {
    const lines = status.split("\n");
    if (lines.includes("# branch.oid (initial)") || /^pr\/\d+$/.test(info.branch ?? "")) return info.ahead;
    if (lines.some((l) => l.startsWith("# branch.upstream ")) && !lines.some((l) => l.startsWith("# branch.ab "))) return 0;
    const remotes = await exec("git", ["remote"], { cwd, on });
    if (remotes.code !== 0 || !remotes.stdout.trim()) return info.ahead;
    const r = await exec("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd, on });
    return r.code === 0 ? parseInt(r.stdout, 10) || 0 : info.ahead;
  }

  // Ahead and behind because the branch was amended or rebased since its push: its upstream's tip was once its own.
  async rewritten(info, cwd, on) {
    if (!(info.ahead > 0 && info.behind > 0) || !info.branch) return false;
    const up = await exec("git", ["rev-parse", "@{upstream}"], { cwd, on });
    if (up.code !== 0) return false;
    const log = await exec("git", ["reflog", "show", "--format=%H", `refs/heads/${info.branch}`], { cwd, on });
    return log.code === 0 && log.stdout.split("\n").includes(up.stdout.trim());
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // A header per project, then its checkouts (the main one first, as Main), the ones
  // no space shows last. Spaces outside a repo stand alone.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const out = [];
    const placed = new Set();
    // Which project each space sits under, for the agents list to group by: its key, title, avatar letter and lead space (its color).
    const of = {};
    for (const r of list) {
      // Spaces outside a repo are a project too: their folder is its title, they hang under it.
      if (!r.g) {
        const path = place(r.w, ps), machine = r.w.machine ?? null, key = JSON.stringify(["folder", machine, path]);
        if (placed.has(key)) continue;
        placed.add(key);
        const here = list.filter((k) => !k.g && (k.w.machine ?? null) === machine && place(k.w, ps) === path);
        const g = { repo: key, name: tilde(path), initial: base(path) || "~", folder: path };
        for (const k of here) of[k.w.id] = { key, name: this.title(g), initial: g.initial, lead: r.w.id };
        out.push({ kind: "project", w: r.w, g, count: here.length });
        if (!this.foldedRepos.has(key)) for (const k of here) out.push({ kind: "space", ...k, nested: true });
        continue;
      }
      if (placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const open = list.filter((k) => k.g?.repo === r.g.repo).sort((a, b) => a.g.linked - b.g.linked);
      const closed = (this.trees[r.g.repo] ?? []).filter((c) => !open.some((k) => k.g.top === c.path));
      const main = closed.find((c) => c.main);
      for (const k of open) of[k.w.id] = { key: r.g.repo, name: this.title(r.g), initial: r.g.initial ?? null, lead: r.w.id };
      out.push({ kind: "project", w: r.w, g: r.g, count: open.length + closed.length });
      if (this.foldedRepos.has(r.g.repo)) continue;
      if (main) out.push({ kind: "checkout", w: r.w, c: main, primary: true });
      for (const k of open) out.push({ kind: "space", ...k, nested: true, primary: !k.g.linked });
      for (const c of closed) if (!c.main) out.push({ kind: "checkout", w: r.w, c });
    }
    // A kept project keeps its color: a new space of it takes the kept color, a color picked for it is kept.
    const colors = shared("space.colors") ?? {}, painted = {};
    let changed = false;
    const kept = this.kept.map((k) => {
      const p = out.find((r) => r.kind === "project" && r.g.repo === k.key);
      if (!p) return k;
      if (k.space !== p.w.id) { painted[p.w.id] = k.color; changed = true; return { ...k, space: p.w.id }; }
      if (colors[p.w.id] && colors[p.w.id] !== k.color) { changed = true; return { ...k, color: colors[p.w.id] }; }
      return k;
    });
    if (Object.keys(painted).length) setShared("space.colors", { ...colors, ...painted });
    if (changed) setShared("projects.kept", kept);
    if (JSON.stringify(of) !== JSON.stringify(shared("projects.of") ?? {})) setShared("projects.of", of);
    // Kept projects with nothing open stay, dimmed, after the open ones.
    for (const k of kept) if (!placed.has(k.key)) out.push({ kind: "project", w: { id: null, machine: k.machine }, g: { repo: k.key, name: k.name, initial: k.initial, folder: k.folder ? k.path : null }, closed: k, count: 0 });
    // Open projects, then closed ones, each in the order the person dragged them into; ones not placed yet follow, as they come.
    const groups = [];
    for (const r of out) r.kind === "project" || !groups.length ? groups.push([r]) : groups.at(-1).push(r);
    const order = shared("projects.order") ?? [];
    const rank = (grp, n) => { const at = order.indexOf(grp[0].g?.repo); return at >= 0 ? at : order.length + n; };
    const sorted = groups.map((grp, n) => [Boolean(grp[0].closed), rank(grp, n), grp])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , grp]) => grp);
    this.projectKeys = sorted.map((grp) => grp[0].g?.repo).filter(Boolean);
    return sorted.flat();
  }

  // Dropping a project's row on another's puts it there: after it when dragged down, before it when dragged up.
  dropProject(from, onto) {
    const keys = [...this.projectKeys], a = keys.indexOf(from), b = keys.indexOf(onto);
    if (a < 0 || b < 0 || a === b) return;
    keys.splice(a, 1);
    keys.splice(keys.indexOf(onto) + (a < b ? 1 : 0), 0, from);
    setShared("projects.order", keys);
  }

  // A project's title: what the person named it, else its repo's name or its folder.
  title(g) {
    return (shared("projects.names") ?? {})[g.repo] ?? g.name;
  }

  startRename(g) {
    this.renaming = g.repo;
    this.nameInput.set_value(this.title(g));
    this.nameInput.focus();
  }

  // Enter or leaving the field keeps the name, Escape drops it; an empty name goes back to the default.
  finishRename(save, cx) {
    const key = this.renaming;
    if (!key) return;
    this.renaming = null;
    if (save) {
      const names = { ...(shared("projects.names") ?? {}) }, name = this.nameInput.value().trim();
      if (name) names[key] = name; else delete names[key];
      setShared("projects.names", names);
    }
    cx.notify();
  }

  // Projects the person keeps in the sidebar with nothing open: { key, name, initial, folder, path, machine, color, space }.
  get kept() {
    return shared("projects.kept") ?? [];
  }

  keep({ w, g }) {
    const path = g.folder ?? this.trees[g.repo]?.find((c) => c.main)?.path ?? g.top;
    const color = (shared("space.colors") ?? {})[w.id] ?? "ansi6";
    setShared("projects.kept", [...this.kept.filter((k) => k.key !== g.repo),
      { key: g.repo, name: g.name, initial: g.initial ?? null, folder: Boolean(g.folder), path, machine: w.machine ?? null, color, space: w.id }]);
  }

  // × forgets a project; an open one also closes its spaces, and Herdr asks before each.
  dismiss({ g, closed }) {
    setShared("projects.kept", this.kept.filter((k) => k.key !== g.repo));
    if (closed) return;
    const ps = panes();
    for (const s of spaces()) {
      const info = this.git[where(s, ps)];
      const key = info ? info.repo : JSON.stringify(["folder", s.machine ?? null, place(s, ps)]);
      if (key === g.repo) run("space.close", { id: s.id });
    }
  }

  // A closed kept project opens as a new space in its folder (a repo's main checkout).
  reopen({ closed: k }) {
    run("space.new", { folder: k.path, ...(k.machine ? { machine: k.machine } : {}) });
  }

  toggleRepo(repo, cx) {
    this.foldedRepos.has(repo) ? this.foldedRepos.delete(repo) : this.foldedRepos.add(repo);
    localStorage.setItem("repos.folded", JSON.stringify([...this.foldedRepos]));
    cx.notify();
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t) {
    const rows = this.ordered();
    const draw = (r) => r.kind === "project" ? this.projectRow(r, t) : r.kind === "checkout" ? this.checkoutRow(r, t) : this.row(r, t);
    // A project's own rows (its checkouts and spaces) go in its branch, under its row.
    const tree = (list) => {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        out.push(draw(r));
        if (r.kind !== "project") continue;
        const kids = [];
        while (i + 1 < list.length && list[i + 1].kind !== "project" && (list[i + 1].kind !== "space" || list[i + 1].nested)) kids.push(draw(list[++i]));
        if (kids.length) out.push(this.branch(r, kids, t));
      }
      return out;
    };
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(30).flex_none().px(8).text_size(13).text_color(t.dim).child("Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : tree(rows);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m, i) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      // Drawn as the agents list's group headers: the first under the heading, later ones 8px apart.
      const head = h_flex().id(`machine-${m ?? "local"}`).when(i > 0, el => el.pt(8)).h(i > 0 ? 30 : 22).flex_none().px(8).gap(4).items_center()
        .text_size(11).font_medium().text_color(t.dim)
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/metro-chrome/icons/${m ? "server" : "monitor"}.svg`).size(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(m ?? "This computer"))
        .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
        .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).size(20).flex_none().flex().items_center().justify_center().rounded(4)
          .role("button").accessibility_label("New space here").hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child(svg("mods/metro-chrome/icons/plus.svg").size(12))))
        .child(div().size(6).rounded_full().flex_none().bg(connected ? t.ansi2 : t.dim))
        .child(svg(`mods/metro-chrome/icons/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none());
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(30).flex_none().px(8).gap(8).items_center().rounded(8)
        .text_size(13).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/metro-chrome/icons/plus.svg").size(12)).child("New space there");
      return [head, ...(folded ? [] : mine.length ? tree(mine) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // A project: its avatar and bold name, then on the right its fold chevron (on hover, or always while folded)
  // and + for a new worktree; a click folds it.
  fill(w, t, color = (shared("space.colors") ?? {})[w.id] ?? "ansi6") {
    return color.startsWith("#") ? color : (MARK[color] ?? t[color]);
  }

  // A project's rows hang from a rail in its color, starting under its avatar, the rows indented past it.
  branch({ g, w }, kids, t) {
    return v_flex().id(`tree-${g.repo}`).relative().flex_none().pl(26)
      .child(div().absolute().left(16).top(-6).bottom(4).w(2).rounded(1).bg(this.fill(w, t) + "73"))
      .children(kids);
  }

  projectRow(r, t) {
    const { w, g, count, closed } = r;
    const id = `repo-${g.repo}`, lit = this.hovered === id, folded = !closed && this.foldedRepos.has(g.repo);
    const fill = this.fill(w, t, closed?.color), isKept = Boolean(closed) || this.kept.some((k) => k.key === g.repo);
    const stop = (_e, cx) => cx.stop_propagation();
    const control = (key, icon, label, action) => div().id(`${id}-${key}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label).tooltip(label)
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); })
      .child(svg(icon).size(13));
    const name = this.title(g), editing = this.renaming === g.repo;
    const dragged = this.dragging === g.repo && this.dropOn && this.dropOn !== g.repo;
    const target = this.dragging && this.dropOn === g.repo && this.dragging !== g.repo;
    const down = target && this.projectKeys.indexOf(this.dragging) < this.projectKeys.indexOf(g.repo);
    return h_flex().id(id).relative().h(36).mt(10).flex_none().px(8).gap(10).items_center().rounded(8).font_weight(700)
      .role("button").accessibility_label(closed ? `Open ${name}` : folded ? `Expand ${name}` : `Collapse ${name}`)
      .on_hover((over, cx) => { if (over) this.hovered = id; else if (this.hovered === id) this.hovered = null; cx.notify(); })
      // Drag a project's row onto another to move it there; the line shows where it lands.
      .when(dragged, el => el.opacity(0.5))
      .when(target, el => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent).when(down, l => l.bottom(-4)).when(!down, l => l.top(-4))))
      .on_mouse_down("left", () => { this.dragging = g.repo; this.dropOn = null; })
      .on_mouse_move((_e, cx) => { if (this.dragging && this.dropOn !== g.repo) { this.dropOn = g.repo; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.dragging;
        this.dragging = null; this.dropOn = null;
        if (from && from !== g.repo) this.dropProject(from, g.repo);
        cx.notify();
      })
      // A click opens a closed project or folds an open one; a double-click renames it (a drop, pressed elsewhere, isn't a click).
      .on_click((e, cx) => {
        if (e.click_count === 2) { if (!closed) this.toggleRepo(g.repo, cx); this.startRename(g); cx.notify(); return; }
        if (closed) this.reopen(r); else this.toggleRepo(g.repo, cx);
      })
      .when(Boolean(closed), el => el.hover(s => s.bg(t.background)))
      .when(!closed, el => el.on_mouse_down("right", () => this.menu(w)))
      // The avatar picks an open project's color.
      .child(h_flex().id(`${id}-color`).size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(11).font_bold()
        .text_color(fill?.startsWith("#") ? ink(fill) : "#ffffff").when(Boolean(closed), el => el.opacity(0.55))
        .when(!closed, el => el.cursor_pointer().role("button").accessibility_label(`Change ${name}'s color`).tooltip("Change color")
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "metro-space-color", kind: "popup", width: 304, height: 84, props: { space: w.id } }); }))
        .child([...(g.initial ?? g.name)][0]?.toUpperCase() ?? "?"))
      .when(!editing, el => el.child(div().id(`${id}-title`).tooltip("Double-click to rename").flex_1().min_w(0).truncate().text_size(13).font_weight(700).text_color(closed ? t.muted : t.foreground).child(name)))
      .when(editing, el => el.child(div().id(`${id}-name`).flex_1().min_w(0).h(26).px(6).flex().items_center().rounded(5)
        .bg(t.background).border(1).border_color(t.accent).text_size(13)
        .on_mouse_down("left", stop).on_click((_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.finishRename(false, cx); } })
        .child(Input.new(this.nameInput).w_full().h_full())))
      .when(folded, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(count))))
      // The chevron, then on hover: pin keeps it here with nothing open; + adds a worktree (a space, for a folder);
      // × forgets it and closes what's open. Packed close so the name keeps its room.
      .child(h_flex().flex_none().gap(1).items_center()
      .when(!closed && (lit || folded), el => el.child(h_flex().size(22).flex_none().items_center().justify_center()
        .child(svg(`mods/metro-chrome/icons/chevron-${folded ? "right" : "down"}.svg`).size(14).text_color(lit ? t.foreground : t.dim))))
      .when(lit && !closed && !editing, el => el.child(control("keep", `mods/metro-chrome/icons/${isKept ? "pin-off" : "pin"}.svg`, isKept ? "Stop keeping in the sidebar" : "Keep in the sidebar when closed",
        () => isKept ? setShared("projects.kept", this.kept.filter((k) => k.key !== g.repo)) : this.keep(r))))
      .when(lit && !closed && !editing, el => el.child(control("new", "mods/metro-chrome/icons/plus.svg", g.folder ? "New space in this folder" : "New worktree (a new branch checkout)", () => {
        if (g.folder) run("space.new", { folder: g.folder, ...(w.machine ? { machine: w.machine } : {}) });
        else openOverlay({ mod: "metro-worktree", kind: "dialog", width: 600, height: 520, props: { space: w.id, action: "new" } });
      })))
      .when(lit, el => el.child(control("dismiss", "mods/metro-chrome/icons/close.svg", closed ? "Remove from the sidebar" : "Close this project's spaces (asks first)", () => this.dismiss(r)))));
  }


  // A hovered row is a white card with an obvious outline, tracked here: a hover style can't change a border.
  lift(el, id, t) {
    return el.on_hover((over, cx) => { if (over) this.hovered = id; else if (this.hovered === id) this.hovered = null; cx.notify(); })
      .when(this.hovered === id, (el) => el.bg(t.background).border_color(t.dim).text_color(t.foreground));
  }

  // A worktree in two lines: a dot and the name, then the branch.
  card(id, t, { dot, name, branch, dim, nested }) {
    // Every card keeps a 1px border, clear until hovered or shown, so none moves.
    return v_flex().relative().id(id).px(10).py(6).flex_none().justify_center().rounded(10).gap(2).border(1).border_color("#00000000")
      // The mark sits close to the name it belongs to: 6px between them.
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(h_flex().size(14).flex_none().items_center().justify_center().when(Boolean(dot), el => el.child(dot)))
        .child(div().min_w(0).truncate().text_size(12.5).text_color(dim ? t.muted : t.foreground).child(name)))
      .when(Boolean(branch), el => el.child(h_flex().w_full().min_w(0).pl(20).gap(6).items_center().text_size(12).text_color(t.dim).child(branch)));
  }

  // A checkout no space shows: no dot; a click opens a space there, the hover × removes a worktree (asks first).
  checkoutRow({ w, c, primary }, t) {
    const on = w.machine ?? null;
    const branch = c.branch ?? "detached";
    const id = `checkout-${c.path}`;
    return this.lift(this.card(id, t, {
      dot: null, name: primary ? "Main" : base(c.path), branch, dim: true, nested: true,
    }), id, t).role("button").accessibility_label(`Open ${base(c.path)}`)
      .on_click(() => run("space.new", { folder: c.path, ...(on ? { machine: on } : {}) }))
      .when(this.hovered === id && !c.main, el => el.child(this.cornerClose(`${id}-remove`, "Remove worktree (asks first)", t,
        () => openOverlay({ mod: "metro-worktree", kind: "dialog", width: 440, height: 220, props: { folder: c.path, machine: on, action: "remove" } }))));
  }

  // The × in a hovered card's top-right corner; pressing it never starts a drag or selects the card.
  cornerClose(id, label, t, act) {
    return div().id(id).absolute().right(6).top(6).size(20).flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label).tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); act(); })
      .child(svg("mods/metro-chrome/icons/close.svg").size(13));
  }

  row({ w, i, g, primary, nested }, t) {
    const on = w.active;
    // The dot is its agents' most urgent status: none without agents, a ring when all are idle.
    // An agent marked Check again shows its bookmark while nothing more urgent is on.
    const marked = w.status !== "working" && w.status !== "blocked"
      && agents().some((a) => a.space === w.id && terminals().find((k) => k.address === a.address)?.labels?.["metro.check"]);
    const dot = marked ? svg("mods/metro-chrome/icons/bookmark-filled.svg").size(12).text_color(t.accent)
      : w.status === "working" ? breathing(t.ansi2)
      : w.status === "blocked" ? div().size(14).rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
      : w.status === "done" ? div().size(7).rounded_full().bg(t.done)
      : w.status ? div().size(7).rounded_full().border(1.5).border_color(t.dim)
      : null;
    // The branch, then at the right what isn't on origin: commits pushed or pulled in the text's grey, the
    // uncommitted lines in green and red, as metro-review counts them.
    const branch = g ? h_flex().flex_1().min_w(0).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().child(g.branch ?? "detached"))
      .when(Boolean(g.rewritten), (el) => el.child(div().id(`amended-${w.id}`).flex_none().text_color(t.muted)
        .tooltip("Amended or rebased since the last push: force-push to update origin").child("amended")))
      .when(!g.rewritten && (g.ahead > 0 || g.behind > 0), (el) => el.child(h_flex().flex_none().gap(4).text_color(t.muted)
        .when(g.ahead > 0, (el) => el.child(div().id(`ahead-${w.id}`)
          .tooltip(`${g.ahead} ${g.ahead === 1 ? "commit" : "commits"} not pushed`).child(`↑${g.ahead}`)))
        .when(g.behind > 0, (el) => el.child(div().id(`behind-${w.id}`)
          .tooltip(`${g.behind} ${g.behind === 1 ? "commit" : "commits"} to pull`).child(`↓${g.behind}`)))))
      .when(g.add > 0 || g.del > 0, (el) => el.child(h_flex().flex_none().gap(4)
        .when(g.add > 0, (el) => el.child(div().text_color(t.ansi2).child(`+${g.add}`)))
        .when(g.del > 0, (el) => el.child(div().text_color(t.ansi1).child(`−${g.del}`))))) : null;
    // Under its folder's or repo's title, a space is its name.
    return this.lift(this.card(`space-${w.id}`, t, { dot, name: primary ? "Main" : w.name, branch, nested }), `space-${w.id}`, t)
      .role("button").accessibility_label(w.name)
      // The shown space is a white card, as the active tab and its terminal; hovered, it takes the outline too.
      .when(on && this.hovered !== `space-${w.id}`, (el) => el.bg(t.background).border_color(t.border))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) select(w);
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      // × closes the space; Herdr asks first when it would end running agents.
      .when(this.hovered === `space-${w.id}`, el => el.child(this.cornerClose(`space-${w.id}-close`, "Close space", t,
        () => run("space.close", { id: w.id }))));
  }

  render() {
    const t = theme();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      // Small capitals, as the agents list titles its sections.
      .child(h_flex().id("spaces-heading").mt(6).h(32).flex_none().pl(16).pr(10).items_center().justify_between().text_size(13).text_color(t.dim)
        .child(div().text_size(11).text_color(t.muted).child("PROJECTS"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).role("button").accessibility_label("New space").hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/metro-chrome/icons/plus.svg").size(14))))
      // The list scrolls under an always-visible 10px bar on its right edge.
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("space-list").size_full().overflow_y_scroll()
          .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.dragging = null; this.dropOn = null; cx.notify(); })
          .child(v_flex().id("space-content").w_full().flex_none().px(8).pb(8)
            .children(this.grouped(t))))
        .child(div().absolute().top(0).bottom(0).right(0).w(10).child(Scrollbar.vertical("space-list").size_full().mode("always"))));
  }
}
