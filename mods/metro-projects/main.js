// Projects, with nothing on screen: which project each space is under, every repo's checkouts, each space's git
// marks, colors, kept projects and when each was last shown, for metro-spaces, metro-overview and metro-agents in
// shared state. It sits in a block of no size in the status bar, so it runs whether or not the sidebar's list shows.

import { View, div } from "gpui-kit";
import { spaces, panes, machines, exec, home, shared, setShared, watchFolder, window } from "herdr";
import { untrackedLines } from "./untracked.js";

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const tilde = (path) => (path && (path === home() || path.startsWith(home() + "/")) ? "~" + path.slice(home().length) : path);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// Scratch: one-off terminals (shared `projects.scratch`, space ids, started by `metro-tabs.scratch`), grouped together
// wherever they cd, never kept.
const SCRATCH = JSON.stringify(["scratch"]);

// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

export default class Projects extends View {
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
    this.treeAt = {}; // kept repo with no space open -> when its checkouts were last read
    this.staleTrees = new Set(); // kept repos whose git folder changed since
    this.readingTrees = new Set();
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.lastActive = null;
    this.projectNoted = false;
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
    this.keptTrees(now, sp, cx);
    this.noteUse(sp);
    // A space waiting for its git joins its project as soon as it's known or has waited long enough.
    if (now - (this.workedAt ?? 0) > 1000 || sp.some((s) => !this.shown.has(s.id))) { this.workedAt = now; this.work(); }
  }

  // When each space was last shown, in shared `spaces.used` (ms), for the order by last use; noted at once, on the
  // timer, so a hidden sidebar still notes it. A project's own time (`projects.used`, for once it's closed) waits for
  // its git, which tells which project the space is in.
  noteUse(sp) {
    const s = sp.find((x) => x.active), now = Date.now();
    if (!s) return;
    if (s.id !== this.lastActive) {
      this.lastActive = s.id;
      this.projectNoted = false;
      const ids = new Set(sp.map((x) => x.id));
      const spacesUsed = Object.fromEntries(Object.entries(shared("spaces.used") ?? {}).filter(([id]) => ids.has(id)));
      setShared("spaces.used", { ...spacesUsed, [s.id]: now });
    }
    if (this.projectNoted) return;
    const ps = panes(), at = where(s, ps), g = this.git[at];
    if (g === undefined || this.unsure.has(at)) return;
    this.projectNoted = true;
    const key = g ? g.repo : JSON.stringify(["folder", s.machine ?? null, place(s, ps)]);
    setShared("projects.used", Object.fromEntries(Object.entries({ ...(shared("projects.used") ?? {}), [key]: (shared("spaces.used") ?? {})[s.id] ?? now })
      .sort((a, b) => b[1] - a[1]).slice(0, 100)));
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
        if (asks && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // A kept repo with no space open still lists its checkouts: read when its git folder changes, else on the fallback.
  keptTrees(now, sp, cx) {
    const ps = panes(), open = new Set(sp.map((s) => this.git[where(s, ps)]?.repo).filter(Boolean));
    for (const k of this.kept) {
      if (k.folder || !k.path || open.has(k.key) || this.readingTrees.has(k.key)) continue;
      const due = !(k.key in this.treeAt) || this.staleTrees.has(k.key) || (window().active && now - this.treeAt[k.key] > FALLBACK);
      if (!due) continue;
      this.readingTrees.add(k.key);
      this.staleTrees.delete(k.key);
      this.treeAt[k.key] = now;
      cx.spawn(async (cx) => {
        try {
          await this.readTrees(k.key, k.path, k.machine ?? null);
          if (!k.machine) this.watch(JSON.parse(k.key)[1], cx);
        } catch {}
        this.readingTrees.delete(k.key);
        this.work();
      });
    }
  }

  // A repo's checkouts (`git worktree list`), the main one first; ones git has lost the folder of are left out.
  async readTrees(repo, cwd, on) {
    const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd, on });
    if (list.code !== 0) return;
    this.trees[repo] = list.stdout.trim().split(/\n\n+/).map((block) => block.split("\n"))
      .filter((lines) => !lines.some((l) => l === "bare" || l.startsWith("prunable")))
      .map((lines, n) => ({ path: lines[0].slice(9), branch: lines.find((l) => l.startsWith("branch "))?.slice(18) ?? null, main: n === 0 }));
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
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
      for (const k of this.kept) if (!k.folder && !k.machine) used.add(JSON.parse(k.key)[1]);
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.publish();
      this.refreshing = false;
      this.work();
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
      await this.readTrees(info.repo, cwd, on);
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      Object.assign(info, await this.changes(r.stdout, cwd, on, info.top));
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

  // Each space's marks for metro-agents, in shared `projects.git`, only when they changed. Not without spaces
  // (`herdr-app check`), or a check would wipe them.
  publish() {
    const sp = spaces(), ps = panes(), out = {};
    if (!sp.length) return;
    for (const w of sp) {
      const g = this.git[where(w, ps)];
      if (g && (g.ahead || g.behind || g.add || g.del)) out[w.id] = { branch: g.branch, ahead: g.ahead, behind: g.behind, rewritten: g.rewritten, add: g.add, del: g.del };
    }
    if (JSON.stringify(out) !== JSON.stringify(shared("projects.git") ?? {})) setShared("projects.git", out);
  }

  // Uncommitted lines, as a review of Uncommitted counts them: tracked files against HEAD, every line of an untracked one.
  async changes(status, cwd, on, top) {
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
    if (lines.some((l) => l.startsWith("? "))) add += (await untrackedLines(top || cwd, on)).total;
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
          if (!this.watching.has(repo)) break;
          this.staleTrees.add(mine);
          this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // A header per project, then its checkouts by last use (the main one named Main), the ones no space shows last.
  // Spaces outside a repo hang under their folder. A space joins once its git is known, or after 1.5s.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const out = [];
    const placed = new Set();
    // The most recently shown first.
    const spaceUsed = shared("spaces.used") ?? {};
    const byUse = (a, b) => (spaceUsed[b.w.id] ?? 0) - (spaceUsed[a.w.id] ?? 0);
    const tree = {}; // project key -> all its rows
    // Which project each space sits under, for the agents list to group by: its key, title, avatar letter and lead space (its color).
    const of = {};
    const scratchIds = new Set(shared("projects.scratch") ?? []);
    const scratch = list.filter((r) => scratchIds.has(r.w.id)).sort(byUse);
    if (scratch.length) {
      const g = { repo: SCRATCH, name: "Scratch", initial: "~", scratch: true };
      for (const k of scratch) of[k.w.id] = { key: SCRATCH, name: "Scratch", initial: "~", lead: scratch[0].w.id };
      out.push({ kind: "project", w: scratch[0].w, g, count: scratch.length, sure: false });
      const kids = scratch.map((k) => ({ kind: "space", ...k, nested: true }));
      tree[SCRATCH] = kids;
      out.push(...kids);
    }
    // Spaces closed since are dropped from Scratch's list.
    const live = new Set(sp.map((x) => x.id));
    if (sp.length && [...scratchIds].some((id) => !live.has(id))) setShared("projects.scratch", [...scratchIds].filter((id) => live.has(id)));
    for (const r of list) {
      if (scratchIds.has(r.w.id)) continue;
      // Spaces outside a repo are a project too: their folder is its title, they hang under it.
      if (!r.g) {
        const path = place(r.w, ps), machine = r.w.machine ?? null, key = JSON.stringify(["folder", machine, path]);
        if (placed.has(key)) continue;
        placed.add(key);
        const here = list.filter((k) => !k.g && (k.w.machine ?? null) === machine && place(k.w, ps) === path).sort(byUse);
        const g = { repo: key, name: tilde(path), initial: base(path) || "~", folder: path };
        for (const k of here) of[k.w.id] = { key, name: this.title(g), initial: g.initial, lead: r.w.id };
        const sure = here.every((k) => where(k.w, ps) in this.git && !this.unsure.has(where(k.w, ps)));
        out.push({ kind: "project", w: r.w, g, count: here.length, sure });
        const kids = here.map((k) => ({ kind: "space", ...k, nested: true }));
        tree[key] = kids;
        out.push(...kids);
        continue;
      }
      if (placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      // Open checkouts by last use (the main one first among never shown), then the ones no space shows.
      const open = list.filter((k) => k.g?.repo === r.g.repo).sort((a, b) => byUse(a, b) || a.g.linked - b.g.linked);
      const closed = (this.trees[r.g.repo] ?? []).filter((c) => !open.some((k) => k.g.top === c.path));
      const main = closed.find((c) => c.main);
      for (const k of open) of[k.w.id] = { key: r.g.repo, name: this.title(r.g), initial: r.g.initial ?? null, lead: r.w.id };
      out.push({ kind: "project", w: r.w, g: r.g, count: open.length + closed.length, sure: true });
      const kids = [
        ...open.map((k) => ({ kind: "space", ...k, nested: true, primary: !k.g.linked })),
        ...(main ? [{ kind: "checkout", w: r.w, c: main, primary: true }] : []),
        ...closed.filter((c) => !c.main).map((c) => ({ kind: "checkout", w: r.w, c })),
      ];
      tree[r.g.repo] = kids;
      out.push(...kids);
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
    // Every repo opened is kept, so it stays listed once nothing of it is open, until its × forgets it; a plain folder
    // only when added (the overview's Add project keeps it), so a cd somewhere doesn't make a project. Never a
    // temporary folder. Kept as it first shows: a project forgotten while its spaces close isn't kept again.
    const opened = out.filter((r) => r.kind === "project" && r.sure && !r.g.folder);
    const fresh = opened.filter((r) => !this.wasOpen?.has(r.g.repo) && !kept.some((k) => k.key === r.g.repo)
      && !/^\/(private\/)?(tmp|var\/folders)\//.test(r.g.folder ?? r.g.top ?? ""));
    this.wasOpen = new Set(opened.map((r) => r.g.repo));
    if (fresh.length && sp.length) {
      kept.push(...fresh.map((r) => this.keeping(r)));
      setShared("projects.kept", kept);
    }
    // Kept projects with nothing open stay after the open ones, in the same colors, a repo with its checkouts.
    for (const k of kept) {
      if (placed.has(k.key)) continue;
      const w = { id: null, machine: k.machine }, checkouts = k.folder ? [] : this.trees[k.key] ?? [];
      out.push({ kind: "project", w, g: { repo: k.key, name: k.name, initial: k.initial, folder: k.folder ? k.path : null }, closed: k, count: 0 });
      const kids = checkouts.map((c) => ({ kind: "checkout", w, c, primary: c.main }));
      tree[k.key] = kids;
      out.push(...kids);
    }
    // Open projects, then closed ones, each the most recently shown first. Ones never shown since follow in the order
    // they were once dragged into (`projects.order`), then as they come.
    const groups = [];
    for (const r of out) r.kind === "project" || !groups.length ? groups.push([r]) : groups.at(-1).push(r);
    const used = shared("projects.used") ?? {}, order = shared("projects.order") ?? [];
    const rank = (key, n) => { const at = order.indexOf(key); return at >= 0 ? at : order.length + n; };
    const last = (grp) => Math.max(used[grp[0].g?.repo] ?? 0, ...grp.filter((r) => r.kind === "space").map((r) => spaceUsed[r.w.id] ?? 0),
      ...Object.entries(of).filter(([, o]) => o.key === grp[0].g?.repo).map(([id]) => spaceUsed[id] ?? 0));
    const sorted = groups.map((grp, n) => ({ grp, key: grp[0].g?.repo, closed: Boolean(grp[0].closed), n, at: last(grp) }))
      .sort((a, b) => a.closed - b.closed
        || b.at - a.at || rank(a.key, a.n) - rank(b.key, b.n))
      .map((x) => x.grp);
    this.publishTree(sorted.map((grp) => grp[0]), tree);
  }

  // The projects in order, every checkout included, for the sidebar's list (metro-spaces) and the overview
  // (metro-overview) in shared `projects.tree`, only when it changed. Not without spaces (`herdr-app check`), or a check would wipe it.
  publishTree(heads, tree) {
    if (!spaces().length) return;
    const colors = shared("space.colors") ?? {};
    const out = heads.map((r) => ({
      key: r.g.repo, name: this.title(r.g), initial: [...(r.g.initial ?? r.g.name)][0]?.toUpperCase() ?? "?",
      color: r.closed?.color ?? colors[r.w.id] ?? "ansi6", space: r.w.id, machine: r.w.machine ?? null,
      closed: r.closed ? { path: r.closed.path } : null, folder: r.g.folder ?? null, scratch: Boolean(r.g.scratch),
      // Its folder: a plain folder's, else the repo's main checkout.
      path: r.g.folder ?? r.closed?.path ?? this.trees[r.g.repo]?.find((c) => c.main)?.path ?? r.g.top ?? null,
      rows: (tree[r.g.repo] ?? []).map((k) => k.kind === "space"
        ? { space: k.w.id, name: k.primary ? "Main" : k.w.name, primary: Boolean(k.primary), repo: Boolean(k.g), branch: k.g?.branch ?? null, linked: Boolean(k.g?.linked), top: k.g?.top ?? null }
        : { path: k.c.path, name: k.primary ? "Main" : base(k.c.path), branch: k.c.branch, main: k.c.main }),
    }));
    // Scratch is always there, for its New terminal button.
    if (!out.some((p) => p.scratch)) out.push({ key: SCRATCH, name: "Scratch", initial: "~", color: "dim", space: null, machine: null, closed: null, folder: null, scratch: true, rows: [] });
    if (JSON.stringify(out) !== JSON.stringify(shared("projects.tree") ?? [])) setShared("projects.tree", out);
  }

  // A project's title: what the person named it, else its repo's name or its folder.
  title(g) {
    return (shared("projects.names") ?? {})[g.repo] ?? g.name;
  }

  // Projects the person keeps in the sidebar with nothing open: { key, name, initial, folder, path, machine, color, space }.
  get kept() {
    return shared("projects.kept") ?? [];
  }

  // What a kept project remembers: its folder (a repo's main checkout), machine and color.
  keeping({ w, g }) {
    const path = g.folder ?? this.trees[g.repo]?.find((c) => c.main)?.path ?? g.top;
    const color = (shared("space.colors") ?? {})[w.id] ?? "ansi6";
    return { key: g.repo, name: g.name, initial: g.initial ?? null, folder: Boolean(g.folder), path, machine: w.machine ?? null, color, space: w.id };
  }

  // Each space gets a color, the one least used so far; colors of spaces gone are dropped.
  paint() {
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const id of shared("projects.scratch") ?? []) if (ids.has(id) && kept[id] !== "dim") { kept[id] = "dim"; changed = true; }
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
  }

  work() {
    this.paint();
    this.ordered();
  }

  render() {
    this.work();
    return div();
  }
}
