// Picks a project's avatar color, opened from its avatar in metro-spaces or metro-overview with props { space }, or
// { key } for a project with nothing open. Colors live in shared "space.colors" by space id, and a project with nothing
// open keeps its own in shared "projects.kept": a theme name other mods know (ansi6, ...) or a #hex.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, shared, setShared, closeOverlay } from "herdr";

// The names are the ones metro-spaces draws with MARK; the rest are stored as hex.
const SWATCHES = [
  ["ansi6", "#22a99a", "Teal"], ["ansi4", "#5b8def", "Blue"], ["ansi5", "#8b7cf6", "Purple"],
  ["ansi1", "#d9649a", "Pink"], ["#e5484d", "#e5484d", "Red"], ["ansi3", "#e3814f", "Orange"],
  ["#f5b800", "#f5b800", "Yellow"], ["ansi2", "#3fae6a", "Green"], ["#8b8d98", "#8b8d98", "Grey"],
];

export default class SpaceColor extends View {
  render() {
    const t = theme(), { space, key, overlay } = props() ?? {};
    const colors = shared("space.colors") ?? {}, kept = shared("projects.kept") ?? [];
    const current = space ? colors[space] : kept.find((k) => k.key === key)?.color;
    const pick = (value) => () => {
      if (space) setShared("space.colors", { ...colors, [space]: value });
      else setShared("projects.kept", kept.map((k) => (k.key === key ? { ...k, color: value } : k)));
      closeOverlay(overlay);
    };
    return v_flex().id("space-color").size_full().p(10).gap(8).bg(t.popover ?? t.background)
      .child(div().text_size(12).text_color(t.muted).child("Project color"))
      .child(h_flex().gap(8).children(SWATCHES.map(([value, fill, name]) => {
        const on = current === value;
        return div().id(`swatch-${name}`).size(24).flex_none().rounded(6).bg(fill).cursor_pointer()
          .flex().items_center().justify_center()
          .border(2).border_color(on ? t.foreground : "#00000000").hover((s) => s.border_color(t.input))
          .role("radio_button").accessibility_label(on ? `${name}, chosen` : name)
          .on_click(pick(value))
          .when(on, (el) => el.child(svg("mods/metro-chrome/icons/check.svg").size(12).text_color("#ffffff")));
      })));
  }
}
