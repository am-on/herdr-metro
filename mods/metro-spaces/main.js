// The sidebar's Projects list: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu. Projects and worktrees are in the order they were last shown. What it lists, and
// each space's git, come from metro-projects (shared `projects.tree`, `projects.git`, `projects.of`), which runs
// whether or not this list shows.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";

// Metro's dialogs open frameless at one size and draw their own card, as in metro-menu and metro-tabs.
const dialog = (mod, p) => openOverlay({ mod, kind: "dialog", frame: "none", width: 640, height: 0.9, props: p });
import { spaces, agents, terminals, machines, layout, run, openOverlay, hc, theme, shared, setShared, window } from "herdr";

const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// Headings are bold in the system font, which has weights (the UI font, Geist, has one).
const BOLD = ".SystemUIFont";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The agent view keeps the space of the agent it shows, so space.select alone changes nothing there:
// show this space's agent (its active tab's first), or the tabs when it has none. The pull requests view and the
// overview give way to the tabs.
function select(s) {
  if (["prs", "overview"].includes(find(layout(), "view")?.active)) run("layout.select", { stack: "view", child: "main" });
  if (find(layout(), "view")?.active === "agent") {
    const tab = s.tabs.find((c) => c.active)?.id, mine = agents().filter((a) => a.space === s.id);
    const a = mine.find((a) => a.tab === tab) ?? mine[0];
    if (a) return run("agent.focus", { terminal: a.address });
    run("layout.select", { stack: "view", child: "main" });
  }
  run("space.select", { id: s.id });
}

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

// At the right of a branch, what isn't on origin: commits to push and to pull in the text's grey (amended or rebased
// since the push: only to push, by force), then the uncommitted lines in green and red. The same in metro-agents.
function gitMarks(t, g, id) {
  const n = (k, one) => `${k} ${k === 1 ? "commit" : "commits"} ${one}`;
  const arrows = [
    g.ahead > 0 && div().id(`ahead-${id}`).child(`↑${g.ahead}`)
      .tooltip(g.rewritten ? "Amended or rebased since the last push: force-push to update origin" : n(g.ahead, "not pushed")),
    g.behind > 0 && !g.rewritten && div().id(`behind-${id}`).child(`↓${g.behind}`).tooltip(n(g.behind, "to pull")),
  ].filter(Boolean);
  const lines = [
    g.add > 0 && div().text_color(t.ansi2).child(`+${g.add}`),
    g.del > 0 && div().text_color(t.ansi1).child(`−${g.del}`),
  ].filter(Boolean);
  return [
    arrows.length && h_flex().flex_none().gap(4).text_color(t.muted).children(arrows),
    lines.length && h_flex().flex_none().gap(4).children(lines),
  ].filter(Boolean);
}

export default class Spaces extends View {
  init(_props, cx) {
    this.pressed = null;
    this.inList = false; // the pointer is on the list: the order holds still until it leaves
    this.held = null; // project key or space id -> its place, as last shown
    this.renaming = null; // the project key whose title is being edited
    this.nameInput = InputState.new({ placeholder: "Project name" });
    this.nameInput.on("submit", (_e, cx) => this.finishRename(true, cx));
    this.nameInput.on("blur", (_e, cx) => this.finishRename(true, cx));
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.foldedRepos = new Set(JSON.parse(localStorage.getItem("repos.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // The pointer can leave the window straight from the list without a hover's end: the hold ends with the window's focus.
    cx.timer.every(500, (cx) => { if (this.inList && !window().active) { this.inList = false; cx.notify(); } });
  }

  // The rows as metro-projects lists them: a project, then its spaces and checkouts unless folded. While the pointer
  // is on the list, projects and spaces keep the places they had, so a click doesn't move a row from under it.
  rows() {
    const sp = spaces(), byId = new Map(sp.map((s, i) => [s.id, { s, i }])), marks = shared("projects.git") ?? {};
    const held = this.inList ? this.held : null;
    const keep = (list, key) => held
      ? list.map((x, n) => ({ x, n })).sort((a, b) => (held.get(key(a.x)) ?? Infinity) - (held.get(key(b.x)) ?? Infinity) || a.n - b.n).map(({ x }) => x)
      : list;
    // Scratch shows only with a scratch space open.
    const projects = keep((shared("projects.tree") ?? []).filter((p) => !p.scratch || p.rows.length), (p) => p.key);
    const out = [];
    for (const p of projects) {
      const lead = byId.get(p.space)?.s ?? { id: null, machine: p.machine };
      const g = { repo: p.key, name: p.name, initial: p.initial, folder: p.folder, scratch: p.scratch };
      const closed = p.closed ? { path: p.closed.path, machine: p.machine } : null;
      out.push({ kind: "project", w: lead, g, closed, color: p.color, count: p.rows.length });
      if (closed || this.foldedRepos.has(p.key)) continue;
      const open = [], checkouts = [];
      for (const row of p.rows) {
        if (!row.space) { checkouts.push({ kind: "checkout", w: lead, c: { path: row.path, branch: row.branch, main: row.main }, primary: row.main }); continue; }
        const at = byId.get(row.space);
        if (at) open.push({ kind: "space", w: at.s, i: at.i, nested: true, primary: row.primary,
          g: row.repo ? { ahead: 0, behind: 0, add: 0, del: 0, ...marks[row.space], branch: row.branch, linked: row.linked, top: row.top } : null });
      }
      out.push(...keep(open, (r) => r.w.id), ...checkouts);
    }
    if (!this.inList) this.held = new Map([
      ...projects.map((p, i) => [p.key, i]),
      ...out.filter((r) => r.kind === "space").map((r, i) => [r.w.id, i]),
    ]);
    return out;
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "metro-menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
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

  // × forgets a project; an open one closes its spaces too, once metro-dialog has asked.
  dismiss({ g, closed }) {
    const live = new Set(spaces().map((s) => s.id));
    const ids = g.scratch ? (shared("projects.scratch") ?? []).filter((id) => live.has(id))
      : Object.entries(shared("projects.of") ?? {}).filter(([id, o]) => o.key === g.repo && live.has(id)).map(([id]) => id);
    if (closed || !ids.length) { if (!g.scratch) setShared("projects.kept", (shared("projects.kept") ?? []).filter((k) => k.key !== g.repo)); return; }
    dialog("metro-dialog", { ask: "close", spaces: ids, title: `Close ${this.title(g)}?`, ...(g.scratch ? {} : { forget: g.repo }) });
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
    const rows = this.rows();
    const draw = (r, first) => r.kind === "project" ? this.projectRow(r, t, first) : r.kind === "checkout" ? this.checkoutRow(r, t) : this.row(r, t);
    // A project's own rows (its checkouts and spaces) go in its branch, under its row.
    const tree = (list) => {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        out.push(draw(r, out.length === 0));
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
        || spaces().some(s => (s.machine ?? null) === m && !(s.id in (shared("projects.of") ?? {})));
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
  fill(t, color) {
    return color.startsWith("#") ? color : (MARK[color] ?? t[color]);
  }

  // A project's rows hang from a rail in its color, starting under its avatar, the rows indented past it.
  branch({ g, color }, kids, t) {
    return v_flex().id(`tree-${g.repo}`).relative().flex_none().pl(26)
      .child(div().absolute().left(16).top(-6).bottom(4).w(2).rounded(1).bg(this.fill(t, color) + "73"))
      .children(kids);
  }

  projectRow(r, t, first) {
    const { w, g, count, closed, color } = r;
    const id = `repo-${g.repo}`, lit = this.hovered === id, folded = !closed && this.foldedRepos.has(g.repo);
    const fill = this.fill(t, color);
    const stop = (_e, cx) => cx.stop_propagation();
    const control = (key, icon, label, action) => div().id(`${id}-${key}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label).tooltip(label)
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); })
      .child(svg(icon).size(13));
    const name = this.title(g), editing = this.renaming === g.repo;
    return h_flex().id(id).relative().h(36).when(!first, el => el.mt(10)).flex_none().px(8).gap(10).items_center().rounded(8).font_weight(700)
      .role("button").accessibility_label(closed ? `Open ${name}` : folded ? `Expand ${name}` : `Collapse ${name}`)
      .on_hover((over, cx) => { if (over) this.hovered = id; else if (this.hovered === id) this.hovered = null; cx.notify(); })
      // A click opens a closed project or folds an open one; a double-click renames it.
      .on_click((e, cx) => {
        if (e.click_count === 2) { if (!closed) this.toggleRepo(g.repo, cx); this.startRename(g); cx.notify(); return; }
        if (closed) this.reopen(r); else this.toggleRepo(g.repo, cx);
      })
      .when(Boolean(closed), el => el.hover(s => s.bg(t.background)))
      .when(!closed, el => el.on_mouse_down("right", () => this.menu(w)))
      // The avatar picks an open project's color.
      .child(h_flex().id(`${id}-color`).size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(11).font_bold()
        .text_color(fill?.startsWith("#") ? ink(fill) : "#ffffff")
        .when(!closed, el => el.cursor_pointer().role("button").accessibility_label(`Change ${name}'s color`).tooltip("Change color")
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "metro-space-color", kind: "popup", width: 304, height: 84, props: { space: w.id } }); }))
        .child([...(g.initial ?? g.name)][0]?.toUpperCase() ?? "?"))
      .when(!editing, el => el.child(div().id(`${id}-title`).tooltip("Double-click to rename").flex_1().min_w(0).truncate().text_size(13).font_weight(700).text_color(t.foreground).child(name)))
      .when(editing, el => el.child(div().id(`${id}-name`).flex_1().min_w(0).h(26).px(6).flex().items_center().rounded(5)
        .bg(t.background).border(1).border_color(t.accent).text_size(13)
        .on_mouse_down("left", stop).on_click((_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.finishRename(false, cx); } })
        .child(Input.new(this.nameInput).w_full().h_full())))
      .when(folded, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(count))))
      // The chevron, then on hover: + adds a worktree (a space, for a folder);
      // × forgets it and closes what's open. Packed close so the name keeps its room.
      .child(h_flex().flex_none().gap(1).items_center()
      .when(!closed && (lit || folded), el => el.child(h_flex().size(22).flex_none().items_center().justify_center()
        .child(svg(`mods/metro-chrome/icons/chevron-${folded ? "right" : "down"}.svg`).size(14).text_color(lit ? t.foreground : t.dim))))
      .when(lit && !closed && !editing, el => el.child(control("new", "mods/metro-chrome/icons/plus.svg", g.folder ? "New space in this folder" : "New worktree (a new branch checkout)", () => {
        if (g.scratch) run("metro-tabs.scratch");
        else if (g.folder) run("space.new", { folder: g.folder, ...(w.machine ? { machine: w.machine } : {}) });
        else dialog("metro-worktree", { space: w.id, action: "new" });
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
        .child(div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(name)))
      .when(Boolean(branch), el => el.child(h_flex().w_full().min_w(0).pl(20).gap(6).items_center().text_size(12).text_color(t.dim).child(branch)));
  }

  // A checkout no space shows: no dot; a click opens a space there, the hover × removes a worktree (asks first).
  checkoutRow({ w, c, primary }, t) {
    const on = w.machine ?? null;
    const branch = div().flex_1().min_w(0).truncate().child(c.branch ?? "detached");
    const id = `checkout-${c.path}`;
    return this.lift(this.card(id, t, {
      dot: null, name: primary ? "Main" : base(c.path), branch, dim: true, nested: true,
    }), id, t).role("button").accessibility_label(`Open ${base(c.path)}`)
      .on_click(() => run("space.new", { folder: c.path, ...(on ? { machine: on } : {}) }))
      .when(this.hovered === id && !c.main, el => el.child(this.cornerClose(`${id}-remove`, "Remove worktree (asks first)", t,
        () => this.askRemove({ folder: c.path, machine: on }))));
  }

  // The dialog that removes a worktree: it draws its own card, as tall as what it says, in this frameless area.
  askRemove({ folder, machine, space }) {
    dialog("metro-worktree", { folder, machine, space, action: "remove" });
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
      : w.status === "done" || agents().some((a) => a.space === w.id && (shared("agents.finished") ?? []).includes(a.address)) ? div().size(7).rounded_full().bg(t.done)
      : w.status ? div().size(7).rounded_full().border(1.5).border_color(t.dim)
      : null;
    const branch = g ? h_flex().flex_1().min_w(0).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().child(g.branch ?? "detached"))
      .children(gitMarks(t, g, w.id)) : null;
    // Under its folder's or repo's title, a space is its name.
    return this.lift(this.card(`space-${w.id}`, t, { dot, name: primary ? "Main" : w.name, branch, nested }), `space-${w.id}`, t)
      .role("button").accessibility_label(w.name)
      // The shown space is a white card, as the active tab and its terminal; hovered, it takes the outline too.
      .when(on && this.hovered !== `space-${w.id}`, (el) => el.bg(t.background).border_color(t.border))
      // A press and release on the same row shows it.
      .on_mouse_down("left", () => { this.pressed = i; })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        if (from === i) select(w);
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      // × removes a worktree, its space included, in one dialog; any other space closes once metro-dialog has asked.
      .when(this.hovered === `space-${w.id}`, el => el.child(g?.linked
        ? this.cornerClose(`space-${w.id}-remove`, "Remove worktree (asks first)", t, () => this.askRemove({ folder: g.top, machine: w.machine ?? null, space: w.id }))
        : this.cornerClose(`space-${w.id}-close`, "Close space", t, () => dialog("metro-dialog", { ask: "close", spaces: [w.id] }))));
  }

  // Shows every project at once in the work area (metro-overview), or the tabs again; lit while it shows.
  overviewButton(t) {
    const on = find(layout(), "view")?.active === "overview";
    const label = on ? "Show tabs" : "Overview of every project";
    return div().id("space-overview").size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(on ? t.foreground : t.dim).when(on, el => el.bg(t.background))
      .hover(s => s.bg(on ? t.background : t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label).tooltip(label)
      .on_click(() => run("layout.select", { stack: "view", child: on ? "main" : "overview" }))
      .child(svg("mods/metro-chrome/icons/layout-grid.svg").size(14));
  }

  render() {
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      // Bold, as the agents list titles its sections, a size up as the heading of the half; the first project sits right under it.
      .child(h_flex().id("spaces-heading").mt(6).h(32).flex_none().pl(16).pr(10).items_center().justify_between().text_size(13).text_color(t.dim)
        .child(div().text_size(13).font_family(BOLD).font_weight(700).text_color(t.muted).child("Projects"))
        .child(h_flex().gap(2).items_center()
        .child(this.overviewButton(t))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).role("button").accessibility_label("New space").hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/metro-chrome/icons/plus.svg").size(14)))))
      // The list scrolls beside an always-visible 10px bar on its right edge, 5px clear of it.
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("space-list").size_full().overflow_y_scroll()
          .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
          // Clicking a row doesn't move it from under the pointer: the order catches up once the pointer leaves.
          .on_hover((over, cx) => { this.inList = over; if (!over) cx.notify(); })
          .child(v_flex().id("space-content").w_full().flex_none().pl(8).pr(15).pb(8)
            .children(this.grouped(t))))
        .child(div().absolute().top(0).bottom(0).right(0).w(10).child(Scrollbar.vertical("space-list").size_full().mode("always"))));
  }
}
