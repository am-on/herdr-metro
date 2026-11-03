// The brand bar above the sidebar: room for the macOS window buttons, a place to drag the window, then
// Settings (with a dot when an update is ready) and the sidebar toggle at its right edge.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, updates } from "herdr";

export default class Brand extends View {
  render() {
    const t = theme();
    const button = (id, label, icon, action) => div().id(id).relative().size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label).tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(svg(icon).size(14));
    return h_flex().id("brand").size_full().bg(t.chrome).pr(10).gap(2).items_center().justify_end()
      .child(button("settings", "Settings", "mods/metro-chrome/settings.svg", () => run("app.settings"))
        .when(Boolean(updates().app.ready), el => el.child(div().absolute().top(4).right(4).size(6).rounded_full().bg(t.accent))))
      .child(button("sidebar-toggle", "Hide sidebar", "mods/metro-chrome/icons/sidebar.svg", () => run("layout.toggle", { id: "sidebar" })));
  }
}
