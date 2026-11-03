// The tab bar's + menu: a terminal, Claude Code, Codex or a diff review, in a new tab of this space.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, knownAgents, run, closeOverlay, props, focused, spaces, panes } from "herdr";

// What the menu offers; an agent starts with its programs.json `run` once known.
const CHOICES = [
  { key: "shell", name: "Terminal", icon: "icons/shell.svg", tint: true, run: null },
  { key: "claude", name: "Claude Code", icon: "mods/metro-chrome/icons/claude.svg", tint: false, run: ["claude"] },
  { key: "codex", name: "Codex", icon: "mods/metro-chrome/icons/openai.svg", tint: true, run: ["codex"] },
  { key: "review", name: "Review changes", icon: "mods/metro-chrome/icons/git-compare.svg", tint: true, run: null, mod: "metro-review" },
];

export default class NewTab extends View {
  init(_props, cx) {
    this.at = 0;
    this.known = {};
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try { for (const a of await knownAgents()) this.known[a.key] = a; } catch {}
      cx.notify();
    });
  }

  start(c) {
    closeOverlay(props().overlay);
    const space = props().space;
    // A review looks at the folder of the terminal you were in, else of that space's first terminal.
    if (c.mod) {
      const f = focused(), id = space ?? f?.space, s = spaces().find((x) => x.id === id);
      const tabs = new Set((s?.tabs ?? []).map((t) => t.id));
      const folder = (f?.space === id && f?.cwd) || panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s?.folder || null;
      return run("tab.new", { ...(space ? { space } : {}), name: "Review", mod: c.mod, props: { folder, space: id ?? null, machine: s?.machine ?? null } });
    }
    const argv = c.run && (this.known[c.key]?.run ?? c.run);
    run("tab.new", { ...(space ? { space } : {}), ...(argv ? { argv } : {}) });
  }

  key(e) {
    const n = CHOICES.length;
    if (e.key === "escape") return closeOverlay(props().overlay);
    if (e.key === "enter") return this.start(CHOICES[this.at]);
    if (e.key === "down") this.at = (this.at + 1) % n;
    else if (e.key === "up") this.at = (this.at + n - 1) % n;
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) return this.start(CHOICES[Number(e.key) - 1]);
  }

  render() {
    const t = theme();
    return v_flex().id("new-tab").size_full().p(6).gap(2).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => { this.key(e); cx.notify(); })
      .children(CHOICES.map((c, i) => {
        const missing = c.run && this.known[c.key] && !this.known[c.key].installed;
        const icon = this.known[c.key]?.icon ?? c.icon, tint = this.known[c.key]?.tint ?? c.tint;
        return h_flex().id(`new-${c.key}`).h(32).px(8).gap(10).items_center().rounded(6).flex_none()
          .when(this.at === i, (el) => el.bg(t.selected))
          .on_hover((over, cx) => { if (over && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click(() => this.start(c))
          .child(h_flex().size(18).flex_none().items_center().justify_center()
            .child(tint ? svg(icon).size(14).text_color(t.foreground) : image(icon).size(14)))
          .child(div().flex_1().min_w(0).truncate().text_color(missing ? t.dim : t.foreground).child(c.name))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(missing ? "not installed" : String(i + 1)));
      }));
  }
}
