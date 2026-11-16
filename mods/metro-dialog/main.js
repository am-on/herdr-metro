// Metro's own asks, in the card every metro dialog uses (as metro-worktree's Remove worktree): an icon in a circle and a
// 17px heading, 14px text, then Cancel `esc` and the action `↵`, each naming its key. Opened frameless and tall
// (`frame: "none"`, height 0.9), as a dialog keeps the size it opened at; the card is as tall as what it says and a
// press beside it cancels.
//   { ask: "close", spaces: [id], title?, forget? }  closes those spaces, naming what still runs in them; `forget`, a
//     project key, is no longer kept (shared `projects.kept`) once they close
//   { ask: "rename", tab: id } or { ask: "rename", space: id }  renames it; empty gives it Herdr's name again

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, run, props, closeOverlay, theme, shared, setShared } from "herdr";

export default class Dialog extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    const p = props() ?? {};
    if (p.ask === "rename") {
      const it = this.target();
      // A name someone gave it, to edit; none for one Herdr names (a tab's number, a space's folder).
      const value = it?.named ? it.name : "";
      this.input = InputState.new({ value, placeholder: p.tab ? "Tab name" : "Space name" });
      if (value) this.input.set_selected_range({ start: 0, end: value.length });
      this.input.on("submit", () => this.go());
      this.inputFocused = true;
      this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
      this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
      this.input.focus();
      // The dialog takes the keyboard a moment after it opens.
      cx.timer.after(150, () => this.input.focus());
    } else this.handle.focus();
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  // The tab or space a rename is for.
  target() {
    const p = props() ?? {};
    if (p.space) return spaces().find((s) => s.id === p.space);
    for (const s of spaces()) for (const c of s.tabs ?? []) if (c.id === p.tab) return c;
    return null;
  }

  go() {
    const p = props() ?? {};
    this.close();
    if (p.ask === "close") {
      if (p.forget) setShared("projects.kept", (shared("projects.kept") ?? []).filter((k) => k.key !== p.forget));
      for (const id of p.spaces ?? []) run("space.close", { id, confirmed: true });
    }
    else if (p.ask === "rename") run(p.tab ? "tab.rename" : "space.rename", { id: p.tab ?? p.space, name: this.input.value().trim() });
  }

  key(e, cx) {
    if (e.key === "escape") this.close();
    else if (e.key === "enter" && props()?.ask === "close") this.go();
    else return;
    cx.stop_propagation();
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const [icon, tint, title, body, label, fill, ink] = p.ask === "rename" ? this.rename(t, p) : this.closing(t, p);
    return h_flex().id("dialog").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().items_center().justify_center()
      .on_mouse_down("left", () => this.close())
      .child(v_flex().id("dialog-card").w(480).px(24).pt(22).pb(20).gap(14).rounded(10)
        .bg(t.popover).border(1).border_color(t.border).shadow_lg().text_size(14)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().flex_none().gap(12).items_center()
          .child(div().size(34).flex_none().rounded_full().bg(tint + "1f").flex().items_center().justify_center()
            .child(svg(`mods/metro-chrome/icons/${icon}.svg`).size(17).text_color(tint)))
          .child(div().flex_1().min_w(0).truncate().text_size(17).text_color(t.foreground).child(title)))
        .children(body)
        .child(h_flex().mt(6).flex_none().gap(8).items_center().justify_end()
          .child(this.keyButton(t, "cancel", "Cancel", "esc", () => this.close()))
          .child(this.keyButton(t, "confirm", label, "↵", () => this.go(), fill, ink))));
  }

  // Closing spaces: what goes and what stays, then each thing still running in a red box, or that nothing is.
  closing(t, p) {
    const ids = new Set(p.spaces ?? []), sp = spaces().filter((s) => ids.has(s.id));
    const tabs = new Set(sp.flatMap((s) => (s.tabs ?? []).map((c) => c.id)));
    const mine = agents().filter((a) => ids.has(a.space));
    const working = mine.filter((a) => a.status === "working").length, open = mine.length - working;
    // A program Herdr recognizes in front of a shell (a dev server, an editor); others show as the shell.
    const programs = [...new Set(panes().filter((x) => tabs.has(x.tab) && x.terminal && !x.status && x.program && !x.program.shell && !x.program.agent)
      .map((x) => x.program.name))];
    const one = sp.length === 1;
    const risk = (id, text) => h_flex().id(id).w_full().px(12).py(9).gap(10).items_start().rounded(8)
      .bg(t.blocked + "14").border(1).border_color(t.blocked + "40").text_color(t.blocked)
      .child(svg("mods/metro-chrome/icons/triangle-alert.svg").size(15).flex_none().mt(1))
      .child(div().flex_1().min_w(0).child(text));
    const risks = [
      working && risk("risk-working", working === 1 ? "An agent is working: it will be stopped." : `${working} agents are working: they will be stopped.`),
      open && risk("risk-agents", `${one ? "It has" : "They have"} ${open === 1 ? "an open agent: it" : `${open} open agents: they`} will be closed.`),
      programs.length && risk("risk-programs", `${programs.join(", ")} ${programs.length === 1 ? "is" : "are"} running: ${programs.length === 1 ? "it" : "they"} will be stopped.`),
    ].filter(Boolean);
    const body = [
      div().text_color(t.muted).child(one ? "Its tabs and terminals close. Its folder stays." : "Their tabs and terminals close. Their folders stay."),
      ...(risks.length ? risks : [h_flex().id("quiet").w_full().px(12).py(9).gap(10).items_start().rounded(8)
        .bg(t.surface).border(1).border_color(t.border).text_color(t.muted)
        .child(svg("mods/metro-chrome/icons/check.svg").size(15).flex_none().mt(1).text_color(t.ansi2))
        .child(div().flex_1().min_w(0).child(one ? "It has no open agents." : "They have no open agents."))]),
    ];
    const title = p.title ?? (one ? `Close ${sp[0].name}?` : `Close ${sp.length} spaces?`);
    return ["x", t.blocked, title, body, one ? "Close space" : `Close ${sp.length} spaces`, t.blocked, "#ffffff"];
  }

  // Renaming a tab or a space: the name, then what an empty one does.
  rename(t, p) {
    const it = this.target();
    const field = div().id("name").w_full().h(36).px(10).flex().items_center().rounded(7).border(1)
      .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground)
      .child(Input.new(this.input).w_full().h_full());
    const hint = div().text_color(t.muted).child(p.tab ? "Left empty, the tab is numbered again." : "Left empty, the space is named after its folder again.");
    const title = !it ? `Rename ${p.tab ? "tab" : "space"}` : p.tab && !it.named ? `Rename tab ${it.name}` : `Rename ${it.name}`;
    return ["pencil", t.foreground, title, [field, hint], "Rename", t.solid, t.solid_foreground];
  }

  // A button names its key in a small label after its words, as in metro-worktree.
  keyButton(t, id, label, key, action, fill = null, ink = null) {
    return h_flex().id(id).h(34).pl(16).pr(8).gap(10).flex_none().items_center().rounded(7).border(1).text_size(14)
      .border_color(fill ?? t.input).bg(fill ?? t.background).text_color(ink ?? t.foreground)
      .hover((st) => (fill ? st.opacity(0.85) : st.bg(t.hover)))
      .role("button").accessibility_label(`${label} (${key === "↵" ? "Enter" : "Esc"})`)
      .on_click((_e, cx) => action(cx))
      .child(label)
      .child(div().h(20).px(6).flex().items_center().rounded(4).text_size(11.5)
        .bg(fill ? "#ffffff2e" : t.surface).border(1).border_color(fill ? "#ffffff40" : t.border).text_color(ink ?? t.muted).child(key));
  }
}
