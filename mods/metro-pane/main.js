// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "metro-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Alone in its tab, a terminal's header says only what the tab doesn't: its folder and branch.
// Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, props, run, hc, theme, home, spaces, shared } from "herdr";
import { namer } from "./name.js";

// Mod panes have no program; these ones get an icon of their own.
const MOD_PROGRAMS = { "metro-review": { name: "Review", icon: "mods/metro-chrome/icons/git-compare.svg", tint: true } };

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// An agent's state as a badge on its icon, as in the tabs: a 12px notch in the pane's color at the icon's
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
  return div().absolute().left(6).top(6).size(12).children(parts);
};
const LABEL = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle", check: "Check again" };

// "Check again": an agent the person marked to come back to, a label on its terminal until the agent works again (metro-tabs clears it).
const CHECK = "metro.check";
const setCheck = (address, on) => hc(["label", address, `${CHECK}=${on ? "1" : ""}`]);

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, label, action) {
    return div()
      .id(id)
      .size(26).flex_none().flex().items_center().justify_center()
      .rounded(6)
      .text_color(t.muted)
      .role("button").accessibility_label(label)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action();
      })
      .child(svg(icon).size(14));
  }

  // A review pane's header carries its Uncommitted / Last commit / Branch switch over the file list, and Refresh; the review
  // publishes its state in `metro-review.<tab>` and takes the clicks as `metro-review.<command>`.
  review(t, p) {
    const r = shared(`metro-review.${p.tab}`);
    if (!r) return null;
    // The labels never change; the last commit and the branch's base are in their tooltips.
    const width = Math.max(160, (r.listWidth ?? 300) - 14);
    const modes = [["uncommitted", "Uncommitted"], ["last", "Last commit"], ["branch", "Branch"]];
    const stop = (_e, cx) => cx.stop_propagation();
    return [
      // GitHub's segmented control: a bordered track, the chosen side raised on the background.
      h_flex().w(width).h(24).flex_none().p(2).gap(2).rounded(6)
        .border(1).border_color(t.input).bg(t.raised).children(modes.map(([id, label]) => {
          const on = r.mode === id;
          return div().id(`ph-mode-${id}-${p.pane}`).flex_auto().min_w(0).h(18).px(8).flex().items_center().justify_center().rounded(4).text_size(12).cursor_pointer()
            .border(1).border_color(on ? t.input : "#00000000")
            .when(on, (e) => e.bg(t.background).text_color(t.foreground).shadow_sm())
            .when(!on, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .role("radio_button").accessibility_label(label)
            .when(id === "branch" && Boolean(r.base), (e) => e.tooltip(`Compared with ${r.base}`))
            .when(id === "last" && Boolean(r.last), (e) => e.tooltip(`${r.last}, and anything uncommitted`))
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); run(`metro-review.${id}`); })
            .child(div().min_w(0).truncate().child(label));
        })),
      div().flex_1(),
      div().id(`ph-refresh-${p.pane}`).h(22).px(8).flex().flex_none().items_center().rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); run("metro-review.refresh"); })
        .child("Refresh"),
    ];
  }

  // The folder and branch a lone pane runs in, each after its icon, the folder giving way first.
  where(t, p) {
    const part = (icon, text, shrink) => h_flex().min_w(0).flex_shrink(shrink).gap(6).items_center()
      .child(svg(icon).size(13).flex_none().text_color(t.dim))
      .child(div().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(text));
    return [
      p.cwd && part("mods/metro-chrome/icons/folder.svg", folder(p.cwd), 1000),
      p.branch && part("mods/metro-chrome/icons/git-branch.svg", p.branch, 1),
      div().flex_1(),
    ].filter(Boolean);
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    // A mod pane (a review, a viewer) is called by its tab's name; a terminal by what it runs.
    const name = p.terminal ? namer()(p) : spaces().flatMap((x) => x.tabs).find((c) => c.id === p.tab)?.name || p.title;
    const pic = icon(p.program ?? MOD_PROGRAMS[p.mod], 14, t.muted);
    const st = p.status;
    const pane = p.pane;
    const toolbar = p.mod === "metro-review" ? this.review(t, p) : null;
    const canMark = p.terminal && st != null && st !== "working" && st !== "blocked";
    const marked = canMark && Boolean(terminals().find((k) => k.address === p.terminal)?.labels?.[CHECK]);
    const kind = marked ? "check" : st === "working" || st === "blocked" || st === "idle" ? st : st === "done" ? "done" : null;
    const where = !toolbar && panes().filter((x) => x.tab === p.tab).length === 1 ? this.where(t, p) : null;
    // The rounded frame paints the background; rectangular child fills would cover its corners.
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      // A line, as the sidebar's dividers, sets the header off from the terminal below it.
      .border_b(1).border_color(t.border)
      // 10px plus the pane's 2px frame: the first icon sits under the tab's logo, 12px in.
      .pl(10).pr(8)
      .gap(8)
      .items_center()
      .text_size(13)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(where), (el) => el.children(where))
      .when(Boolean(toolbar), (el) => el.children(toolbar))
      // The icon carries the agent's state as a badge, as in the tabs and the agents list.
      .when(!toolbar && !where && Boolean(pic || kind), (el) => el.child(h_flex().relative().size(14).flex_none()
        .when(Boolean(pic), el => el.child(pic))
        .when(Boolean(kind), el => el.child(badge(t, kind, t.background).accessibility_label(LABEL[kind])))))
      .when(!toolbar && !where, (el) => el.child(div().flex_none().truncate().max_w(260).text_size(13).font_medium().text_color(p.focused ? t.foreground : t.muted).child(name))
        .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd))))
      .when(this.hovered, el => el.child(h_flex().flex_none().gap(4).items_center()
        .when(canMark, el => el.child(this.button(t, `ph-c-${pane}`, `mods/metro-chrome/icons/${marked ? "bookmark-filled" : "bookmark"}.svg`, marked ? "Clear Check again" : "Check again later", () => setCheck(p.terminal, !marked))))
        .child(this.button(t, `ph-r-${pane}`, "mods/metro-pane/split-right.svg", "Split right", () => run("pane.split", { direction: "right", pane })))
        .child(this.button(t, `ph-d-${pane}`, "mods/metro-pane/split-down.svg", "Split down", () => run("pane.split", { direction: "down", pane })))
        .child(this.button(t, `ph-z-${pane}`, `mods/metro-pane/${p.zoomed ? "unzoom" : "zoom"}.svg`, p.zoomed ? "Unzoom pane" : "Zoom pane", () => run("pane.zoom", { pane })))
        .child(this.button(t, `ph-x-${pane}`, "mods/metro-pane/close.svg", "Close pane", () => run("pane.close", { pane })))));
  }
}
