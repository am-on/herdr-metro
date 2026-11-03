// Agents in priority sections, each grouped by space; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Scrollbar } from "gpui-base";
import { agents, terminals, panes, focused, run, hc, theme, shared, setShared, setAgentOrder, layout } from "herdr";
import { namer } from "./name.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// Section headings are bold capitals in the system font, which has weights (the UI font, Geist, has one).
const BOLD = ".SystemUIFont";
// A section heading's mark: the agents' state marks, standing still and full size.
const headingMark = (t, kind) => {
  const box = (el) => div().size(14).flex_none().flex().items_center().justify_center().child(el);
  if (kind === "working") return box(div().size(8).rounded_full().bg(t.ansi2));
  if (kind === "blocked") return box(div().size(8).rounded_full().bg(t.blocked));
  if (kind === "done") return box(div().size(8).rounded_full().bg(t.done));
  if (kind === "idle") return box(div().size(8).rounded_full().border(1.5).border_color(t.dim));
  if (kind === "check") return box(svg("mods/metro-chrome/icons/bookmark-filled.svg").size(11).text_color(t.accent));
  return null;
};
const RANK = { blocked: 4, done: 3, check: 2.5, working: 2, idle: 1 };
// "Check again": an agent the person marked to come back to, a label on its terminal until the agent works again (metro-tabs clears it).
const CHECK = "metro.check";
const setCheck = (address, on) => hc(["label", address, `${CHECK}=${on ? "1" : ""}`]);
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SECTION = { 4: "Needs you", 3: "Done", 2.5: "Check again", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2.5: "check", 2: "working", 1: "idle" };

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
// The avatar's letter: white, or near-black on a light color such as yellow.
const ink = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#1f2328" : "#ffffff";
};

// An agent's state as a badge on its logo, as in the tabs: a 12px notch in the row's color at the logo's
// bottom-right corner, and in it the same marks as elsewhere, smaller. Working breathes inside the notch.
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
  else return null;
  return div().absolute().left(8).top(8).size(12).children(parts);
};

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// At the right of a branch, what isn't on origin, as metro-spaces draws it (it runs git and shares each space's
// in `projects.git`): commits to push and to pull in the text's grey, then the uncommitted lines in green and red.
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

export default class Agents extends View {
  init(_props) {
    this.folded = JSON.parse(localStorage.getItem("folded") ?? "{}");
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    // Older installs kept pins in this list's storage; move them over once.
    if (shared("agents.pins") == null && localStorage.getItem("pins")) setShared("agents.pins", JSON.parse(localStorage.getItem("pins")));
  }

  // Pins live in shared `agents.pins`.
  get pins() {
    return shared("agents.pins") ?? [];
  }

  isFolded(id, initial = true) {
    return this.folded[id] ?? initial;
  }

  toggleFold(id, cx, initial = true) {
    this.folded[id] = !this.isFolded(id, initial);
    localStorage.setItem("folded", JSON.stringify(this.folded));
    cx.notify();
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    setShared("agents.pins", pins);
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    if (this.checked?.has(a.address) && a.status !== "working" && a.status !== "blocked") return RANK.check;
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, depth: lead.length + 1, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    const name = k.name || k.template || k.program?.name || k.address;
    return h_flex()
      .id(`sub-${k.address}`)
      .relative()
      .pl(10)
      .pr(10)
      .rounded(10)
      .h(32)
      .flex_none()
      .items_center()
      .gap(10)
      .text_size(12.5)
      .role("button").accessibility_label(name)
      // The shown agent is a white card, as the active tab and its terminal; a hovered one adds an obvious outline (tracked
      // in on_hover: a hover style can't change a border). Every row keeps a 1px border so none moves.
      .border(1).border_color("#00000000")
      .when(on, (el) => el.bg(t.background).border_color(t.border))
      .when(this.hovered === k.address, el => el.bg(t.background).border_color(t.dim))
      .on_hover((over, cx) => {
        if (over) this.hovered = k.address;
        else if (this.hovered === k.address) this.hovered = null;
        cx.notify();
      })
      .on_click(() => this.peek(k.address))
      // Upstream's 9px turn, hung from each ancestor's icon center (19px in, then every 20px), ending short of this icon.
      .children(s.lines.flatMap((l, j) => [
        l === "│" || l === "├" ? div().absolute().left(18.25 + 20 * j).top(0).bottom(0).w(1.5).bg(t.input) : null,
        l === "├" || l === "└" ? div().absolute().left(18.25 + 20 * j).top(-4).h(19).w(9.75).border_l(1.5).border_b(1.5).rounded_bl(6).border_color(t.input) : null,
      ].filter(Boolean)))
      .child(h_flex().flex_1().min_w(0).pl(s.depth * 20).gap(10).items_center()
        .child(h_flex().relative().size(18).flex_none().items_center().justify_center()
          .when(Boolean(pic), el => el.child(pic))
          .children([this.status(t, { status: st }, on || this.hovered === k.address ? t.background : t.chrome)?.id(`sub-status-${k.address}`)].filter(Boolean)))
        .child(h_flex().flex_1().min_w(0).overflow_hidden()
          .child(div().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(name))));
  }

  // The badge on an agent's 18px logo slot, labelled with its section for screen readers.
  status(t, a, bg, note = "") {
    return badge(t, a.status, bg)?.role("status").accessibility_label((SECTION[RANK[a.status]] ?? "Unknown") + note);
  }


  render(cx) {
    const t = theme();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    this.checked = new Set(terminals().filter((k) => k.labels?.[CHECK]).map((k) => k.address));
    const all = terminals();
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    const sectionOf = (a) => rankOf(a) || RANK.idle;
    list = [...list].sort((x, y) => sectionOf(y) - sectionOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    // Within a section an agent joins the others of its project (as Projects groups spaces: a repo's worktrees
    // together), projects in the order of their most recent agent.
    const projects = shared("projects.of") ?? {};
    const projectOf = (a) => projects[a.space] ?? { key: a.space, name: a.space_name, lead: a.space };
    const firstOf = new Map();
    list.forEach((a, i) => { const k = `${sectionOf(a)}|${projectOf(a).key}`; if (!firstOf.has(k)) firstOf.set(k, i); });
    list.sort((x, y) => sectionOf(y) - sectionOf(x) || firstOf.get(`${sectionOf(x)}|${projectOf(x).key}`) - firstOf.get(`${sectionOf(y)}|${projectOf(y).key}`));
    this.prunePins(all);
    const pinned = this.pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !this.pins.includes(a.address));
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.isFolded(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown))];
    };

    // Only folded rows show it: open, the indented children below say so, and the icon folds them.
    // Just a dim count; the row's status carries any hidden child's urgency.
    const fold = (a, subs) => {
      return div()
        .id(`fold-${a.address}`)
        .h(20).min_w(20).flex_none()
        .px(4)
        .flex()
        .items_center()
        .justify_center()
        .rounded(4)
        .text_size(11)
        .role("button").accessibility_label("Expand sub-agents")
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.toggleFold(a.address, cx);
        })
        .child(String(subs.length));
    };

    // A row's detail is what the agent is on, as tabs and pane headers name it.
    const label = namer();
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const branchOf = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.branch]));
    const gitOf = shared("projects.git") ?? {};
    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 14, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      const idle = a.status === "idle" && !a.focused;
      const isPinned = this.pins.includes(a.address);
      // Shown on hover in the status slot: the far edge, nothing moves, no empty gap.
      const pin = Button.new(`pin-${a.address}`)
        .size(20).flex_none().flex().items_center().justify_center()
        .rounded(4).text_color(t.dim)
        .accessibility_label(isPinned ? "Unpin" : "Pin")
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          // Reordering can move the row without a pointer-leave event.
          this.hovered = null;
          this.setPins(isPinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
          cx.notify();
        })
        .child(svg(`mods/metro-chrome/icons/${isPinned ? "pin-off" : "pin"}.svg`).size(14).flex_none());
      // × ends the agent as the pane header's does: its pane closes, or its terminal ends when it has none.
      const close = Button.new(`close-${a.address}`)
        .size(20).flex_none().flex().items_center().justify_center()
        .rounded(4).text_color(t.dim)
        .accessibility_label("Close agent").tooltip("Close agent")
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.hovered = null;
          const pane = panes().find((p) => p.terminal === a.address);
          if (pane) run("pane.close", { pane: pane.pane });
          else run("terminal.kill", { terminal: a.address });
          cx.notify();
        })
        .child(svg("mods/metro-chrome/icons/close.svg").size(13).flex_none());
      // A row leads with what the agent is on, under its space's name; an automatic tab number says nothing.
      const name = more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      // Hovering a parent turns its icon into the fold toggle, in the same fixed slot.
      const toggle = subs.length > 0 && this.hovered === a.address
        ? svg(`mods/metro-chrome/icons/chevron-${this.isFolded(a.address) ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.foreground)
        : pic;
      // Folded, the status shows a hidden child when it's more urgent than the agent itself.
      const folded = subs.length > 0 && this.isFolded(a.address);
      const kid = folded ? subs.map((s) => kidStatus(s.t, this.listed)).reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m)) : null;
      const fromKid = (RANK[kid] ?? 0) > (RANK[a.status] ?? 0);
      const canMark = a.status !== "working" && a.status !== "blocked";
      const marked = canMark && this.checked.has(a.address);
      // Two lines, as Spaces draws a worktree: the mark, icon and name, then the branch it's on.
      const branch = branchOf.get(a.address);
      // Its space's marks, when it's on that checkout's branch.
      const git = branch && gitOf[a.space]?.branch === branch ? gitOf[a.space] : null;
      return v_flex()
        .id(`ag-${a.address}`)
        .relative()
        .w_full().min_w(0)
        .px(10)
        .py(6)
        .gap(2)
        .flex_none()
        .rounded(10)
        // The same type as the Spaces rows above: 12.5 names, 12 dim details.
        .text_size(12.5)
        // The focused agent is a white card, as the active tab and its terminal; a hovered one adds an obvious outline (tracked
        // in on_hover: a hover style can't change a border). Every row keeps a 1px border so none moves.
        .border(1).border_color("#00000000")
        .when(a.focused, (el) => el.bg(t.background).border_color(t.border))
        .role("button").accessibility_label(label(a) || a.program?.name || a.address)
        .when(this.hovered === a.address, el => el.bg(t.background).border_color(t.dim))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        // agent.focus, not pane.focus: in tabs it focuses the pane, and it picks what the agent view shows.
        // The pull requests view gives way to the tabs.
        .on_click(() => {
          if (find(layout(), "view")?.active === "prs") run("layout.select", { stack: "view", child: "main" });
          run("agent.focus", { terminal: a.address });
        })
        .child(h_flex().w_full().min_w(0).gap(10).items_center()
        // The logo carries the state as a badge. An agent at rest's badge is a toggle: keep it as Check again, or clear that.
        .child(h_flex().id(`agent-fold-${a.address}`).relative().size(18).flex_none().items_center().justify_center()
          .when(subs.length > 0, el => el.accessibility_label(this.isFolded(a.address) ? "Expand sub-agents" : "Collapse sub-agents").on_click((_e, cx) => {
            cx.stop_propagation();
            this.toggleFold(a.address, cx);
          })).when(Boolean(toggle), el => el.child(toggle))
          .children([this.status(t, fromKid ? { status: kid } : { status: marked ? "check" : a.status },
            a.focused || this.hovered === a.address ? t.background : t.chrome, fromKid ? " (sub-agent)" : "")
            ?.id(`status-${a.address}`)
            .when(canMark, (el) => el.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); setCheck(a.address, !marked); }))].filter(Boolean)))
        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(name)))
        .when(Boolean(machine), el => el.child(div().text_size(11).text_color(t.dim).child(machine)))
        .child(h_flex().id(`controls-${a.address}`).flex_none().items_center().gap(4)
          .when(folded, el => el.child(fold(a, subs)))
          .when(this.hovered === a.address, el => el.child(pin).child(close))))
        .when(Boolean(branch), el => el.child(h_flex().w_full().min_w(0).pl(28).gap(8).items_center().text_size(12).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(branch))
          .when(Boolean(git), el => el.children(gitMarks(t, git, a.address)))));
    };

    // Priority sections in list order, pinned agents first in their own.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = sectionOf(a);
      const id = `sec-${r}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: SECTION[r], status: SECTION_STATUS[r], members: [a] });
    }

    // A section's header, its still state mark and bold small capitals in its status color; it folds the section. Later ones keep 8px above.
    const header = (g, i) => {
      const initial = false;
      const open = !this.isFolded(g.id, initial);
      return h_flex()
        .id(g.id)
        .px(8)
        .when(i > 0, (el) => el.pt(8))
        .h(i > 0 ? 32 : 24)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .on_click((_e, cx) => this.toggleFold(g.id, cx, initial))
        // Working is green, as its spinner; Idle's theme color is a faint grey meant for marks, so its header is muted.
        .child(headingMark(t, g.status))
        .child(div().min_w(0).truncate().font_family(BOLD).font_weight(700).text_color({ check: t.accent, working: t.ansi2, idle: t.muted }[g.status] ?? t[g.status] ?? t.dim).child(g.label.toUpperCase()))
        // A count only where the rows don't show it at a glance: past five, or folded. Ringed, as Spaces' hidden worktrees.
        .when(g.members.length > 5 || !open, (el) => el.child(div().size(22).flex_none().rounded_full().border(1).border_color(t.border)
          .flex().items_center().justify_center().text_size(11).text_color(t.muted).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el.child(svg("mods/metro-chrome/icons/chevron-right.svg").size(12).flex_none().text_color(t.dim)));
    };
    // Idle shows its first five; a row under them shows the rest.
    const IDLE_SHOWN = 5;
    const more = (g, n) => h_flex().id(`${g.id}-more`).h(28).flex_none().px(10).gap(10).items_center().rounded(8)
      .border(1).border_color("#00000000").text_size(12).text_color(t.dim)
      .on_hover((over, cx) => { if (over) this.hovered = `${g.id}-more`; else if (this.hovered === `${g.id}-more`) this.hovered = null; cx.notify(); })
      .when(this.hovered === `${g.id}-more`, (el) => el.bg(t.background).border_color(t.dim).text_color(t.foreground))
      .role("button").accessibility_label(this.allIdle ? "Show fewer" : `Show ${n} more`)
      .on_click((_e, cx) => { this.allIdle = !this.allIdle; cx.notify(); })
      .child(div().w(14).flex_none())
      .child(this.allIdle ? "Show fewer" : `${n} more`);
    // A project's avatar, in its color from Projects, and title above each run of its agents. The run hangs from
    // a rail in that color, starting under the avatar, the rows indented past it, as Projects draws a project.
    const colors = shared("space.colors") ?? {};
    const fillOf = (a) => { const c = colors[projectOf(a).lead] ?? "ansi6"; return c.startsWith("#") ? c : MARK[c] ?? t[c]; };
    const spaceTitle = (g, a, first) => {
      const fill = fillOf(a), name = projectOf(a).name || "", letter = [...(projectOf(a).initial ?? name)][0]?.toUpperCase() ?? "?";
      return h_flex().id(`${g.id}-${projectOf(a).key}-${a.address}`).h(first ? 24 : 32).pt(first ? 0 : 8).pl(8).pr(10).gap(10).flex_none().items_center()
        // The same avatar as Projects: 18px, 5px corners, an 11px letter, 8px in.
        .child(div().size(18).flex_none().rounded(5).bg(fill).flex().items_center().justify_center().text_size(11)
          .text_color(fill?.startsWith("#") ? ink(fill) : "#ffffff").child(letter))
        .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(name));
    };
    const rail = (g, run) => v_flex().id(`${g.id}-rail-${run[0].address}`).relative().flex_none().pl(26)
      .child(div().absolute().left(16).top(-2).bottom(4).w(2).rounded(1).bg(fillOf(run[0]) + "73"))
      .children(run.flatMap(withKids));
    const bySpace = (g, as) => {
      const runs = [];
      for (const a of as) { if (runs.at(-1) && projectOf(runs.at(-1)[0]).key === projectOf(a).key) runs.at(-1).push(a); else runs.push([a]); }
      return runs.flatMap((run, i) => [spaceTitle(g, run[0], i === 0), rail(g, run)]);
    };
    const members = (g) => {
      if (g.id !== "sec-1" || g.members.length <= IDLE_SHOWN) return bySpace(g, g.members);
      const shown = this.allIdle ? g.members : g.members.slice(0, IDLE_SHOWN);
      return [...bySpace(g, shown), more(g, g.members.length - IDLE_SHOWN)];
    };
    const rows = groups.flatMap((g, i) => [header(g, i), ...(this.isFolded(g.id, false) ? [] : members(g))]);

    return v_flex()
      .id("metro-agents-root")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      // No heading: the sections say what the list is. The line between this list and Projects is the layout's divider.
      .pt(10)
      .when(list.length === 0, (el) =>
        el.child(div().px(16).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      // The list scrolls under an always-visible 10px bar on its right edge.
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("ag-list").size_full().px(8).overflow_y_scroll().children(rows))
        .child(div().absolute().top(0).bottom(0).right(0).w(10).child(Scrollbar.vertical("ag-list").size_full().mode("always"))));
  }
}
