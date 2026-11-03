// The brand bar above the sidebar: room for the macOS window buttons, a place to drag the window, then
// Pull requests (with how many wait on your review), Settings (with a dot when an update is ready) and the sidebar
// toggle at its right edge.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, updates, layout, shared, setShared, exec } from "herdr";

// How many open pull requests ask for your review, from GitHub through `gh`, leaving out the ones hidden in the
// pull requests view (shared `metro-prs.hidden`); null when it can't be asked.
async function waiting() {
  const query = `query { search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 50) { nodes { ... on PullRequest { url } } } }`;
  const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`]);
  const off = new Set(shared("metro-prs.hidden") ?? []);
  try { return r.code === 0 ? JSON.parse(r.stdout).data.search.nodes.filter((n) => n.url && !off.has(n.url)).length : null; } catch { return null; }
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Brand extends View {
  // How many pull requests wait on your review, in shared `metro-prs.waiting`; the view keeps it fresh while it runs.
  init(_props, cx) {
    const count = (cx) => cx.spawn(async () => {
      const n = await waiting().catch(() => null);
      if (n != null && shared("metro-prs.waiting") !== n) setShared("metro-prs.waiting", n);
    });
    count(cx);
    cx.timer.every(180000, count);
  }

  render() {
    const t = theme();
    const prsShown = find(layout(), "view")?.active === "prs";
    const asked = shared("metro-prs.waiting") ?? 0;
    // 30px buttons with 17px icons in the text's grey (`muted`), black on hover.
    const button = (id, label, icon, action) => div().id(id).relative().size(30).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label).tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(svg(icon).size(17));
    const prsLabel = prsShown ? "Show tabs" : asked ? `Pull requests, ${asked} waiting on your review` : "Pull requests";
    return h_flex().id("brand").size_full().bg(t.chrome).pr(8).gap(4).items_center().justify_end()
      .child(button("prs", prsLabel, "mods/metro-chrome/icons/git-pull-request.svg",
        () => run("layout.select", { stack: "view", child: prsShown ? "main" : "prs" }))
        .when(prsShown, el => el.bg(t.background).text_color(t.foreground))
        .when(asked > 0, el => el.child(div().absolute().top(1).right(0).min_w(14).h(14).px(3).rounded_full().bg(t.blocked)
          .flex().items_center().justify_center().text_size(10).text_color("#ffffff").child(String(asked)))))
      .child(button("settings", "Settings", "mods/metro-chrome/settings.svg", () => run("app.settings"))
        .when(Boolean(updates().app.ready), el => el.child(div().absolute().top(4).right(4).size(7).rounded_full().bg(t.accent))))
      .child(button("sidebar-toggle", "Hide sidebar", "mods/metro-chrome/icons/sidebar.svg", () => run("layout.toggle", { id: "sidebar" })));
  }
}
