// Every project at once, in the work area: the worktrees last shown, then a card per project where the person placed
// it, in it a box per worktree (open or not), and in each open one the tabs it has, with their agents' state. The
// projects, their checkouts, names and colors are the sidebar's (metro-spaces publishes them in shared
// `projects.tree`); tabs and states are live from Herdr.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { spaces, panes, agents, terminals, run, openOverlay, pickFolder, theme, shared, setShared, layout, settings, exec, home, appHome, readTextFile, knownAgents } from "herdr";
import { namer } from "./name.js";

// Headings are bold in the system font, which has weights (the UI font, Geist, has one).
const BOLD = ".SystemUIFont";
// The narrowest a project card gets before the cards go one column fewer.
const CARD_MIN = 340;
const GAP = 16;

const MOD_PROGRAMS = { "metro-review": { name: "Review", icon: "mods/metro-chrome/icons/git-compare.svg", tint: true } };

// What a stored color name looks like on an avatar, the same in every mod that draws space avatars.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const ink = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#1f2328" : "#ffffff";
};
const fill = (t, color) => color.startsWith("#") ? color : (MARK[color] ?? t[color] ?? MARK.ansi6);

const CHECK = "metro.check";
const shownStatus = (a) => a.status === "idle" && (shared("agents.finished") ?? []).includes(a.address) ? "done" : a.status;

// A tab's state as a badge on its agent's logo: a 12px notch in the row's background at the logo's bottom-right
// corner, and in it the same marks as elsewhere. Working breathes; the halo never leaves the notch.
const badge = (t, kind, bg) => {
  const dot = (size) => div().absolute().left(6 - size / 2).top(6 - size / 2).size(size).rounded_full();
  const parts = [div().absolute().left(0).top(0).size(12).rounded_full().bg(bg)];
  if (kind === "working") parts.push(div().absolute().rounded_full().bg(t.ansi2 + "40")
    .loop("width", { from: 6, to: 12, period: 1800 }).loop("height", { from: 6, to: 12, period: 1800 })
    .loop("left", { from: 3, to: 0, period: 1800 }).loop("top", { from: 3, to: 0, period: 1800 }), dot(6).bg(t.ansi2));
  else if (kind === "blocked") parts.push(dot(10).bg(t.blocked));
  else if (kind === "done") parts.push(dot(8).bg(t.done));
  else if (kind === "idle") parts.push(dot(8).border(1.5).border_color(t.idle ?? t.dim));
  else if (kind === "check") parts.push(svg("mods/metro-chrome/icons/bookmark-filled.svg").absolute().left(1).top(1).size(10).text_color(t.accent));
  return div().absolute().left(6).top(6).size(12).children(parts);
};

// Commits to push and pull, then uncommitted lines, as the sidebar shows them (from shared `projects.git`).
function gitMarks(t, g, id) {
  if (!g) return [];
  const n = (k, one) => `${k} ${k === 1 ? "commit" : "commits"} ${one}`;
  return [
    g.ahead > 0 && div().id(`ahead-${id}`).text_color(t.muted).child(`↑${g.ahead}`)
      .tooltip(g.rewritten ? "Amended or rebased since the last push: force-push to update origin" : n(g.ahead, "not pushed")),
    g.behind > 0 && !g.rewritten && div().id(`behind-${id}`).text_color(t.muted).child(`↓${g.behind}`).tooltip(n(g.behind, "to pull")),
    g.add > 0 && div().text_color(t.ansi2).child(`+${g.add}`),
    g.del > 0 && div().text_color(t.ansi1).child(`−${g.del}`),
  ].filter(Boolean);
}

// The tabs go away and the space's tab shows.
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const onScreen = () => find(layout(), "view")?.active === "overview";

const show = (space, tab) => {
  run("layout.select", { stack: "view", child: "main" });
  if (tab) run("tab.select", { id: tab });
  else run("space.select", { id: space });
};

// How many worktrees the Recent row remembers; it shows one per column of cards.
const RECENT = 12;
// Pull requests are looked up while the overview shows, at most this often.
const MERGED_EVERY = 180000;
// GitHub's merged purple.
const merged = () => (settings().dark ? "#a371f7" : "#8250df");

export default class Overview extends View {
  init(_props, cx) {
    this.width = 0;
    this.hovered = null;
    this.hoveredBox = null;
    // The Recent row as it was when the overview opened, kept while it shows; a hidden copy doesn't render, so the
    // timer lets go of it (and of a drag) once the overview is gone.
    this.recent = null;
    // A card being dragged: { key, moved }; where it would land: { col, index }; the pointer, for the card's ghost.
    this.drag = null;
    this.dropAt = null;
    this.pointer = null;
    cx.timer.every(500, (cx) => {
      if (onScreen()) return;
      this.recent = null;
      if (this.drag) { this.drag = null; this.dropAt = null; cx.notify(); }
    });
    // One-click actions per project folder, from the untracked metro-actions.json here; read again while on screen,
    // so an edit to it shows.
    this.actions = {};
    this.actionsError = null;
    this.loadActions(cx);
    cx.timer.every(3000, (cx) => { if (onScreen()) { this.loadActions(cx); this.loadMerged(cx); } });
    this.merged = {}; // project path -> branch -> { number, url } of its latest pull request, when that one merged
    this.mergedAt = 0;
    this.renaming = null; // the project key whose name is being edited
    this.nameInput = InputState.new({ placeholder: "Project name" });
    this.nameInput.on("submit", (_e, cx) => this.finishRename(true, cx));
    this.nameInput.on("blur", (_e, cx) => this.finishRename(true, cx));
  }

  // Which worktrees' branches are done: their latest pull request merged. One GitHub query asks only about the
  // branches checked out here, a fork's `pr/<n>` being pull request n. Only projects on this computer, where `gh` is.
  loadMerged(cx) {
    if (this.mergedLoading || Date.now() - this.mergedAt < MERGED_EVERY) return;
    this.mergedLoading = true;
    cx.spawn(async (cx) => {
      const tree = (shared("projects.tree") ?? []).filter((p) => !p.machine && !p.scratch && !p.folder && p.path && p.rows.some((r) => r.name !== "Main" && r.branch));
      this.origins ??= {};
      const asks = [];
      for (const p of tree) {
        if (!(p.path in this.origins)) {
          const r = await exec("git", ["remote", "get-url", "origin"], { cwd: p.path }).catch(() => null);
          const m = r?.code === 0 && /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(r.stdout.trim());
          this.origins[p.path] = m ? [m[1], m[2]] : null;
        }
        const repo = this.origins[p.path];
        if (repo) asks.push({ path: p.path, repo, branches: [...new Set(p.rows.filter((r) => r.name !== "Main" && r.branch).map((r) => r.branch))] });
      }
      const next = {};
      if (asks.length) {
        const fields = "number url state";
        const query = `query { ${asks.map((a, i) => `p${i}: repository(owner: ${JSON.stringify(a.repo[0])}, name: ${JSON.stringify(a.repo[1])}) { ${a.branches.map((b, j) => {
          const fork = /^pr\/(\d+)$/.exec(b);
          return fork ? `b${j}: pullRequest(number: ${fork[1]}) { ${fields} }`
            : `b${j}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${fields} } }`;
        }).join(" ")} }`).join("\n")} }`;
        const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`]).catch(() => null);
        let data = null;
        try { data = r?.code === 0 ? JSON.parse(r.stdout).data : null; } catch {}
        if (!data) { this.mergedLoading = false; this.mergedAt = Date.now(); return; }
        asks.forEach((a, i) => {
          next[a.path] = {};
          a.branches.forEach((b, j) => {
            const got = data[`p${i}`]?.[`b${j}`], pr = got?.nodes ? got.nodes[0] : got;
            if (pr?.state === "MERGED") next[a.path][b] = { number: pr.number, url: pr.url };
          });
        });
      }
      this.merged = next;
      this.mergedAt = Date.now();
      this.mergedLoading = false;
      cx.notify();
    });
  }

  // metro-actions.json: { "<folder, ~ for home>": [{ name, run: [argv] } | { name, agent: "claude", task }] }.
  loadActions(cx) {
    cx.spawn(async (cx) => {
      let text = null;
      try { text = await readTextFile(`${appHome()}/metro-actions.json`); } catch {}
      if (text === this.actionsText) return;
      this.actionsText = text;
      try {
        const raw = text ? JSON.parse(text) : {};
        this.actions = Object.fromEntries(Object.entries(raw).map(([k, v]) =>
          [k.replace(/^~(?=\/|$)/, home()).replace(/\/+$/, ""), Array.isArray(v) ? v.filter((a) => a?.name && (a.run || a.agent)) : []]));
        this.actionsError = null;
      } catch (e) {
        this.actionsError = String(e.message ?? e);
      }
      cx.notify();
    });
  }

  // An action runs in a new tab named after it, in the project's open space (its Main first), else in a new space
  // in its folder; the tabs then show it.
  runAction(p, a) {
    const live = new Set(spaces().map((s) => s.id));
    const open = p.rows.find((r) => r.space && live.has(r.space) && r.name === "Main") ?? p.rows.find((r) => r.space && live.has(r.space));
    const start = (argv) => {
      const extra = a.task ? { task: a.task } : {};
      run("layout.select", { stack: "view", child: "main" });
      if (open) {
        run("space.select", { id: open.space });
        run("tab.new", { name: a.name, space: open.space, folder: p.path, argv, ...extra });
      } else run("space.new", { folder: p.path, tab: a.name, argv, ...extra, ...(p.machine ? { machine: p.machine } : {}) });
    };
    if (a.run) return start(a.run);
    // An agent starts as the + menu starts it (programs.json's `run`).
    knownAgents({ on: p.machine }).then((list) => start(list.find((k) => k.key === a.agent)?.run ?? [a.agent]), () => start([a.agent]));
  }

  // A project's actions as small buttons: the agent's logo or a terminal, then the name.
  actionButtons(p, t) {
    return (this.actions[p.path] ?? []).map((a, i) => {
      const icon = a.agent === "claude" ? "mods/metro-chrome/icons/claude.svg" : a.agent === "codex" ? "mods/metro-chrome/icons/openai.svg"
        : "mods/metro-chrome/icons/terminal.svg";
      return h_flex().id(`act-${p.key}-${i}`).h(26).flex_none().px(8).gap(6).items_center().rounded(7)
        .border(1).border_color(t.border).text_size(12.5).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label(a.name)
        .tooltip(a.run ? a.run.join(" ") : `${a.agent}: ${a.task ?? ""}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.runAction(p, a); })
        .child(svg(icon).size(12).flex_none())
        .child(a.name);
    });
  }

  startRename(p, cx) {
    this.renaming = p.key;
    this.nameInput.set_value(p.name);
    this.nameInput.focus();
    cx.notify();
  }

  // Enter or leaving the field keeps the name, Escape drops it; an empty name goes back to the default. The names are
  // the sidebar's, shared `projects.names`.
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

  hover(id) {
    return (over, cx) => { if (over) this.hovered = id; else if (this.hovered === id) this.hovered = null; cx.notify(); };
  }

  hoverBox(id) {
    return (over, cx) => { if (over) this.hoveredBox = id; else if (this.hoveredBox === id) this.hoveredBox = null; cx.notify(); };
  }

  // What a tab shows as: its lead pane's program, its name, its agents' state for the badge.
  tabInfo(c, ctx) {
    const { ps, live, checked, title } = ctx;
    const mine = ps.filter((p) => p.tab === c.id);
    const lead = mine.find((p) => p.status != null) ?? mine.find((p) => p.focused) ?? mine[0];
    const program = lead?.program ?? MOD_PROGRAMS[lead?.mod] ?? null;
    const name = c.named ? c.name : lead ? title(lead) : "Terminal";
    const resting = live.filter((a) => a.tab === c.id && a.status !== "working" && a.status !== "blocked");
    const flagged = resting.some((a) => checked.has(a.address));
    const done = live.some((a) => a.tab === c.id && shownStatus(a) === "done");
    const hasAgent = mine.some((p) => p.status != null);
    const kind = c.status === "working" || c.status === "blocked" ? c.status : flagged ? "check" : done ? "done" : hasAgent ? "idle" : null;
    return { program, name, kind };
  }

  // A tab's 14px logo with its state as a badge in a notch of `bg`.
  logo(program, kind, t, bg) {
    return h_flex().relative().size(14).flex_none()
      .when(Boolean(program?.icon), (el) => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
      .when(!program?.icon, (el) => el.child(svg("mods/metro-chrome/icons/terminal.svg").size(14).text_color(t.muted)))
      .when(Boolean(kind), (el) => el.child(badge(t, kind, bg)));
  }

  // One tab: its lead program's logo with the state as a badge, its name, how many panes it splits into.
  tabRow(c, space, ctx, t) {
    const { program, name, kind } = this.tabInfo(c, ctx);
    const id = `tab-${c.id}`, lit = this.hovered === id, shown = space.active && c.active;
    // Every row keeps a 1px border, clear until hovered or shown, so none moves.
    return h_flex().id(id).h(32).flex_none().px(10).gap(10).items_center().rounded(7).border(1).border_color("#00000000")
      .text_size(13).text_color(shown || lit ? t.foreground : t.muted)
      .when(shown, (el) => el.bg(t.background).border_color(t.border))
      .when(lit, (el) => el.bg(t.background).border_color(t.dim))
      .role("button").accessibility_label(`Show ${name}`)
      .on_hover(this.hover(id))
      .on_click(() => show(space.id, c.id))
      .child(this.logo(program, kind, t, shown || lit ? t.background : t.chrome))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .when(c.panes > 1, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(`${c.panes} panes`)))
      // × closes the tab without showing it; Herdr asks first when it's its space's last. Its place is kept while hidden.
      .child(div().id(`${id}-close`).size(20).flex_none().flex().items_center().justify_center().rounded(4)
        .when(lit, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .role("button").accessibility_label(`Close ${name}`).tooltip("Close tab")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
          .child(svg("mods/metro-chrome/icons/close.svg").size(12))));
  }

  // A worktree's box: its name and branch, the git marks at the right, then its tabs. One no space shows is a single
  // quiet line; a click opens a space there.
  worktree(row, project, ctx, t) {
    const space = row.space ? ctx.byId.get(row.space) : null;
    // The pointer anywhere on the box, its tabs included, shows its buttons.
    const id = `wt-${row.space ?? row.path}`, lit = this.hoveredBox === id;
    const on = project.machine ? { machine: project.machine } : {};
    const mono = settings().font ?? "JetBrains Mono";
    // × closes its space and keeps the worktree; the trash asks to remove the worktree, its space too. The main
    // checkout can't be removed. Both keep their place while hidden.
    const button = (key, icon, label, action) => div().id(`${id}-${key}`).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .when(lit && Boolean(action), (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label(label).tooltip(label)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); action(); })
        .child(svg(icon).size(13)));
    const folder = project.scratch ? null : space ? (row.linked ? row.top : null) : (row.main ? null : row.path);
    const controls = h_flex().flex_none().gap(1)
      .child(button("close", "mods/metro-chrome/icons/close.svg", "Close (keeps the worktree)", space && (() => run("space.close", { id: space.id }))))
      .child(button("remove", "mods/metro-chrome/icons/trash.svg", "Remove worktree…", folder && (() => openOverlay({
        mod: "metro-worktree", kind: "dialog", frame: "none", width: 520, height: 0.9,
        props: { folder, ...on, ...(space ? { space: space.id } : {}), action: "remove" } }))));
    // A worktree whose pull request merged says so, and offers to remove it.
    const done = folder && row.name !== "Main" && row.branch && this.merged[project.path]?.[row.branch];
    const mergedPill = done && h_flex().id(`${id}-merged`).h(20).px(7).gap(4).flex_none().items_center().rounded_full().text_size(11.5)
      .bg(merged() + "1f").text_color(merged()).hover((s) => s.bg(merged() + "33"))
      .role("button").accessibility_label(`#${done.number} merged, remove this worktree`).tooltip(`#${done.number} merged: remove this worktree`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "metro-worktree", kind: "dialog", frame: "none", width: 520, height: 0.9, props: { folder, ...on, ...(space ? { space: space.id } : {}), action: "remove" } });
      })
      .child(svg("mods/metro-chrome/icons/git-merge.svg").size(12)).child("Merged · Remove");
    if (!space) {
      const branch = row.branch === undefined ? null : row.branch ?? "detached";
      return h_flex().id(id).h(38).flex_none().pl(10).pr(6).gap(8).items_center().rounded(9).border(1).border_color(lit ? t.dim : t.border)
        .role("button").accessibility_label(`Open ${row.name}`).tooltip("Not open: click to open a space here")
        .on_hover(this.hoverBox(id))
        .on_click(() => {
          run("layout.select", { stack: "view", child: "main" });
          run("space.new", { folder: row.path, ...on });
        })
        .child(div().flex_none().max_w(200).truncate().text_size(13.5).font_family(BOLD).font_weight(600).text_color(t.foreground).child(row.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_family(mono).text_color(t.dim).child(branch ?? ""))
        .when(Boolean(mergedPill), (el) => el.child(mergedPill))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(lit ? "Open" : "Not open"))
        .child(controls);
    }
    // The worktree reads as a heading over its tabs: its name bold, its branch in the terminal's font.
    return v_flex().id(id).flex_none().rounded(9).bg(t.chrome).border(1).border_color(space.active ? t.dim : "#00000000")
      .on_hover(this.hoverBox(id))
      .child(v_flex().id(`${id}-head`).rounded(8).hover((s) => s.bg(t.hover)).on_click(() => show(space.id, null))
        .role("button").accessibility_label(`Show ${space.name}`)
        .gap(3).pl(10).pr(6).pt(9).pb(8)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_family(BOLD).font_weight(600).text_color(t.foreground).child(row.name))
          .when(Boolean(mergedPill), (el) => el.child(mergedPill))
          .child(h_flex().flex_none().gap(4).text_size(12).children(gitMarks(t, (shared("projects.git") ?? {})[space.id], space.id)))
          .child(controls))
        .when(Boolean(row.branch), (el) => el.child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
          .child(svg("mods/metro-chrome/icons/git-branch.svg").size(12).flex_none())
          .child(div().min_w(0).truncate().font_family(mono).child(row.branch)))))
      .when(space.tabs.length > 0, (el) => el.child(div().mx(10).h(1).bg(t.border)))
      .child(v_flex().px(4).py(4).gap(2).children(space.tabs.map((c) => this.tabRow(c, space, ctx, t))));
  }

  // A project's heading: its avatar and bold name, then on hover its buttons. Pressing it picks the card up to move.
  heading(p, t, controls) {
    const color = fill(t, p.color), id = `project-${p.key}`;
    return h_flex().id(`${id}-grip`).w_full().gap(10).items_center().cursor_grab()
      .on_mouse_down("left", () => { this.drag = { key: p.key, moved: false }; this.dropAt = null; this.dragged = false; })
      // The avatar picks the project's color (Scratch's stays grey).
      .child(h_flex().id(`${id}-color`).size(22).flex_none().rounded(6).bg(color).items_center().justify_center()
        .text_size(12).font_family(BOLD).font_weight(700).text_color(ink(color)).child(p.initial)
        .when(!p.scratch, (el) => el.cursor_pointer().role("button").accessibility_label(`Change ${p.name}'s color`).tooltip("Change color")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            openOverlay({ mod: "metro-space-color", kind: "popup", width: 304, height: 84, props: p.closed ? { key: p.key } : { space: p.space } });
          })))
      // Double-click the name to rename it; the field takes the name's place and height, so nothing moves.
      .when(this.renaming !== p.key, (el) => el.child(div().id(`${id}-title`).flex_1().min_w(0).h(28).flex().items_center()
        .tooltip("Double-click to rename, drag to move")
        .on_click((e, cx) => { if (e.click_count === 2) this.startRename(p, cx); })
        .child(div().min_w(0).truncate().text_size(15).font_family(BOLD).font_weight(700).text_color(t.foreground).child(p.name))))
      .when(this.renaming === p.key, (el) => el.child(div().id(`${id}-name`).flex_1().w_full().min_w(0).h(28).px(6).flex().items_center().rounded(6)
        .bg(t.background).border(1).border_color(t.accent).text_size(15)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.finishRename(false, cx); } })
        .child(Input.new(this.nameInput).w_full().h_full())))
      .child(h_flex().flex_none().gap(4).items_center().children(controls));
  }

  // A project's card. Open: its worktrees (Main first, then by name, open or not) and a button for a new one. Closed:
  // its heading alone; a click opens it again. On hover the heading also adds a worktree (closed), renames, closes.
  card(p, ctx, t) {
    const id = `project-${p.key}`, lit = this.hovered === id;
    const on = p.machine ? { machine: p.machine } : {};
    const label = p.scratch ? "New terminal" : p.folder ? "New space in this folder" : "New worktree";
    const create = () => p.scratch ? run("metro-tabs.scratch") : p.folder
      ? run("space.new", { folder: p.folder, ...on })
      : openOverlay({ mod: "metro-worktree", kind: "dialog", width: 600, height: 520,
        props: p.closed ? { folder: p.closed.path, ...on, action: "new" } : { space: p.space, action: "new" } });
    // The controls hold their place while hidden, so showing them moves nothing.
    const control = (key, icon, name, action) => div().id(`${id}-${key}`).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .when(lit, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label(name).tooltip(name)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
        .child(svg(icon).size(14)));
    const controls = p.scratch ? [] : [
      p.closed && control("new", "mods/metro-chrome/icons/plus.svg", label, create),
      control("rename", "mods/metro-chrome/icons/pencil.svg", "Rename", (cx) => this.startRename(p, cx)),
      control("close", "mods/metro-chrome/icons/close.svg", p.closed ? "Remove from the list" : "Close this project's spaces (asks first)", () => this.dismiss(p)),
    ].filter(Boolean);
    // Its actions on a line of their own under the name, lined up with it.
    const buttons = this.actionButtons(p, t);
    const acts = h_flex().pl(32).gap(6).flex_wrap().children(buttons);
    const base = v_flex().id(id).w_full().flex_none().rounded(12).bg(t.background).border(1).border_color(lit && p.closed ? t.dim : t.border)
      .on_hover(this.hover(id))
      .when(this.drag?.moved && this.drag.key === p.key, (el) => el.opacity(0.35));
    if (p.closed) {
      return base.px(12).py(9).gap(8).role("button").accessibility_label(`Open ${p.name}`)
        .on_click(() => {
          if (this.dragged) return;
          run("layout.select", { stack: "view", child: "main" });
          run("space.new", { folder: p.closed.path, ...on });
        })
        .child(this.heading(p, t, [div().flex_none().text_size(12).text_color(t.dim).child(lit ? "Open" : "Not open"), ...controls]))
        .when(buttons.length > 0, (el) => el.child(acts));
    }
    const rows = [...p.rows].sort((a, b) => (b.name === "Main") - (a.name === "Main") || a.name.localeCompare(b.name));
    return base.p(12).gap(10)
      .child(this.heading(p, t, controls))
      .when(buttons.length > 0, (el) => el.child(acts))
      .children(rows.map((r) => this.worktree(r, p, ctx, t)))
      .child(div().id(`${id}-new`).h(36).flex_none().flex().items_center().justify_center().gap(8).rounded(9)
        .border(1).border_dashed().border_color(t.border).text_size(13).text_color(t.muted)
        .hover((s) => s.bg(t.chrome).text_color(t.foreground))
        .role("button").accessibility_label(label)
        .on_click(create)
        .child(svg("mods/metro-chrome/icons/plus.svg").size(14).flex_none())
        .child(label));
  }

  // Pick a folder and a space opens there. A repo is kept once open; a plain folder is kept here, as only folders
  // added this way are.
  async addProject() {
    const folder = (await pickFolder({ prompt: "Add project" }))?.replace(/\/+$/, "");
    if (!folder) return;
    const repo = await exec("git", ["rev-parse", "--git-dir"], { cwd: folder }).catch(() => null);
    if (repo?.code !== 0) {
      const key = JSON.stringify(["folder", null, folder]), kept = shared("projects.kept") ?? [];
      const name = folder === home() ? "~" : folder.startsWith(home() + "/") ? "~" + folder.slice(home().length) : folder;
      const used = [...kept.map((k) => k.color), ...Object.values(shared("space.colors") ?? {})];
      const color = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"].reduce((a, b) => (used.filter((c) => c === b).length < used.filter((c) => c === a).length ? b : a));
      if (!kept.some((k) => k.key === key)) setShared("projects.kept", [...kept,
        { key, name, initial: folder.split("/").pop() || "~", folder: true, path: folder, machine: null, color, space: null }]);
    }
    run("layout.select", { stack: "view", child: "main" });
    run("space.new", { folder });
  }

  // × forgets a project, as the sidebar's does: it's no longer kept, and an open one's spaces close, Herdr asking first.
  dismiss(p) {
    setShared("projects.kept", (shared("projects.kept") ?? []).filter((k) => k.key !== p.key));
    if (p.closed) return;
    for (const r of p.rows) if (r.space && spaces().some((s) => s.id === r.space)) run("space.close", { id: r.space });
  }

  // The last worktrees shown, newest first, each with its project's avatar and name; held still while the overview
  // shows. A click goes there.
  // One chip per column of cards, as wide as a card, so the chips line up with the cards below.
  recentRow(tree, ctx, t, slots, chipW) {
    const used = shared("spaces.used") ?? {};
    if (!this.recent) this.recent = Object.entries(used).sort((a, b) => b[1] - a[1]).map(([id]) => id).filter((id) => ctx.byId.has(id)).slice(0, RECENT);
    const where = new Map(tree.flatMap((p) => p.rows.filter((r) => r.space).map((r) => [r.space, { p, r }])));
    const chips = this.recent.filter((id) => ctx.byId.has(id) && where.has(id)).slice(0, slots).map((id) => {
      const s = ctx.byId.get(id), { p, r } = where.get(id), color = fill(t, p.color), cid = `recent-${id}`;
      return h_flex().id(cid).w(chipW).flex_none().h(52).px(12).gap(10).items_center().rounded(10)
        .bg(t.background).border(1).border_color(this.hovered === cid ? t.dim : s.active ? t.dim + "aa" : t.border)
        .on_hover(this.hover(cid))
        .role("button").accessibility_label(`Show ${r.name} in ${p.name}`)
        .on_click(() => show(s.id, null))
        .child(h_flex().size(22).flex_none().rounded(6).bg(color).items_center().justify_center()
          .text_size(12).font_family(BOLD).font_weight(700).text_color(ink(color)).child(p.initial))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(13.5).font_family(BOLD).font_weight(600).text_color(t.foreground).child(r.name))
          .child(div().truncate().text_size(12).text_color(t.dim).child(r.name === "Main" || !r.branch ? p.name : `${p.name} · ${r.branch}`)))
        // Each tab as its logo with its state; hover names it, a click shows it. Five at most, then how many more.
        .child(h_flex().flex_none().gap(2).items_center()
          .children(s.tabs.slice(0, 5).map((c) => {
            const { program, name, kind } = this.tabInfo(c, ctx), lid = `${cid}-${c.id}`;
            return div().id(lid).size(24).flex().items_center().justify_center().rounded(6)
              .hover((st) => st.bg(t.hover))
              .tooltip(name).role("button").accessibility_label(`Show ${name}`)
              .on_click((_e, cx) => { cx.stop_propagation(); show(s.id, c.id); })
              .child(this.logo(program, kind, t, t.background));
          }))
          .when(s.tabs.length > 5, (el) => el.child(div().pl(2).text_size(12).text_color(t.dim).child(`+${s.tabs.length - 5}`))));
    });
    return chips.length ? h_flex().w_full().gap(GAP).children(chips) : null;
  }

  // The cards' places: shared `metro-overview.places`, a list of keys per column. Columns past what fits now join
  // the last one; a project not placed yet goes to the column with the fewest cards.
  // The first place a project gets is kept at once (once the view knows its width), so a project added later doesn't
  // move the others.
  arrange(tree, cols) {
    const keys = new Set(tree.map((p) => p.key)), placed = new Set();
    const saved = (shared("metro-overview.places") ?? []).map((c) => [...c]);
    const out = Array.from({ length: cols }, () => []);
    saved.forEach((col, c) => {
      for (const k of col) if (keys.has(k) && !placed.has(k)) { out[Math.min(c, cols - 1)].push(k); placed.add(k); }
    });
    const fresh = tree.filter((p) => !placed.has(p.key)).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    for (const p of fresh) {
      const col = out.indexOf(out.reduce((a, b) => (b.length < a.length ? b : a)));
      out[col].push(p.key);
      while (saved.length <= col) saved.push([]);
      saved[col].push(p.key);
    }
    if (fresh.length && onScreen() && this.width > 0) setShared("metro-overview.places", saved);
    return out;
  }

  // Puts the dragged card where it was dropped, and keeps every card's place.
  drop(cols) {
    const { key } = this.drag, { col, index } = this.dropAt;
    const out = this.arranged.map((c) => [...c]);
    const from = out.findIndex((c) => c.includes(key)), at = out[from].indexOf(key);
    out[from].splice(at, 1);
    out[col].splice(from === col && at < index ? index - 1 : index, 0, key);
    setShared("metro-overview.places", out.slice(0, cols));
  }

  render() {
    const t = theme();
    const sp = spaces(), byId = new Map(sp.map((s) => [s.id, s]));
    const tree = shared("projects.tree") ?? [];
    const ctx = {
      byId, ps: panes(), live: agents(), title: namer(),
      checked: new Set(terminals().filter((k) => k.labels?.[CHECK]).map((k) => k.address)),
    };
    const byKey = new Map(tree.map((p) => [p.key, p]));
    const cols = Math.max(1, Math.floor((this.width - 2 * 20 + GAP) / (CARD_MIN + GAP)));
    this.arranged = this.arrange(tree, cols);
    const dragging = Boolean(this.drag?.moved);
    // While a card is dragged: each card's top or bottom half, or a column's empty foot, says where it would land;
    // a dashed slot shows it.
    const aim = (col, index) => (e, cx) => {
      if (!dragging) return;
      const half = e.local_position && e.bounds ? (e.local_position.y > e.bounds.height / 2 ? 1 : 0) : 0;
      const next = { col, index: index + half };
      if (this.dropAt?.col !== next.col || this.dropAt?.index !== next.index) { this.dropAt = next; cx.notify(); }
    };
    const slot = (col) => div().id(`slot-${col}`).h(64).flex_none().rounded(12).border(2).border_dashed().border_color(t.accent).bg(t.accent + "14");
    const column = (keys, col) => {
      const items = keys.map((k, i) => div().id(`place-${k}`).w_full().on_mouse_move(aim(col, i)).child(this.card(byKey.get(k), ctx, t)));
      if (dragging && this.dropAt?.col === col) items.splice(this.dropAt.index, 0, slot(col));
      return v_flex().id(`col-${col}`).flex_1().min_w(0).gap(GAP)
        .children(items)
        // The empty space under a column's last card takes a drop at its end.
        .child(div().id(`foot-${col}`).flex_1().min_h(120).on_mouse_move((_e, cx) => {
          if (!dragging) return;
          if (this.dropAt?.col !== col || this.dropAt?.index !== keys.length) { this.dropAt = { col, index: keys.length }; cx.notify(); }
        }));
    };
    const heading = (text) => div().text_size(13).font_family(BOLD).font_weight(700).text_color(t.muted).child(text);
    // A column's width, from the cards' row as last laid out.
    const colW = ((this.area ?? this.width - 45) - (cols - 1) * GAP) / cols;
    const recent = this.recentRow(tree, ctx, t, cols, Math.max(0, colW));
    const ghost = dragging && this.pointer && byKey.get(this.drag.key);
    return div().id("overview").relative().size_full().min_h(0).bg(t.chrome)
      .when(dragging, (el) => el.cursor_grabbing())
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        this.drag.moved = true;
        this.pointer = e.local_position;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (!this.drag) return;
        if (this.drag.moved && this.dropAt) this.drop(cols);
        this.dragged = this.drag.moved;
        this.drag = null; this.dropAt = null;
        cx.notify();
      })
      .child(v_flex().id("overview-scroll").size_full().overflow_y_scroll()
        .child(v_flex().w_full().min_h_full().flex_none().p(20).pr(25).gap(12)
          .when(Boolean(recent), (el) => el.child(heading("Recent")).child(recent).child(div().h(8)))
          // The heading, then right after it a + to add a project.
          .child(h_flex().items_center().gap(6)
            .child(heading("Projects"))
            .child(div().id("project-add").size(22).flex().items_center().justify_center().rounded(6).text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .role("button").accessibility_label("Add project").tooltip("Add project…")
              .on_click((_e, cx) => cx.spawn(async () => this.addProject()))
              .child(svg("mods/metro-chrome/icons/plus.svg").size(14))))
          .when(Boolean(this.actionsError), (el) => el.child(div().text_size(12).text_color(t.blocked)
            .child(`Couldn't read metro-actions.json (${this.actionsError}). Fix the file and the actions come back.`)))
          .child(h_flex().id("columns").w_full().flex_1().items_stretch().gap(GAP)
            .on_size_change((size, cx) => { if (size.width !== this.area) { this.area = size.width; cx.notify(); } })
            .children(this.arranged.map((keys, col) => column(keys, col))))))
      .child(div().absolute().top(0).bottom(0).right(0).w(10).child(Scrollbar.vertical("overview-scroll").size_full().mode("always")))
      // The dragged card's name follows the pointer.
      .when(Boolean(ghost), (el) => el.child(h_flex().absolute().left(this.pointer.x + 14).top(this.pointer.y + 10).h(34).px(10).gap(8).items_center()
        .rounded(8).bg(t.background).border(1).border_color(t.dim).shadow_md()
        .child(h_flex().size(18).rounded(5).bg(fill(t, ghost.color)).items_center().justify_center().text_size(11).font_family(BOLD).font_weight(700)
          .text_color(ink(fill(t, ghost.color))).child(ghost.initial))
        .child(div().text_size(13).font_family(BOLD).font_weight(700).text_color(t.foreground).child(ghost.name))));
  }
}
