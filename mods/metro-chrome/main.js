// The brand bar above the sidebar: room for the macOS window buttons, a place to drag the window, then Back and
// Forward, Pull requests (with a dot while a review request is new), Settings (with a dot when an update is ready)
// and the sidebar toggle at its right edge.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, updates, layout, shared, setShared, exec, focused, spaces } from "herdr";

// How many open pull requests ask for your review and haven't been shown since they asked, from GitHub through `gh`,
// leaving out the ones hidden in the pull requests view; null when it can't be asked. The view starts only once
// opened, so this repeats what it calls new (`isNew` and `askedAt` in metro-prs).
async function fresh() {
  const query = `query { viewer { login } search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 50) { nodes { ... on PullRequest {
    url createdAt timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent {
      createdAt requestedReviewer { ... on User { login } ... on Team { slug } } } } } } } } }`;
  const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`]);
  const off = new Set(shared("metro-prs.hidden") ?? []), read = shared("metro-prs.seen") ?? {};
  try {
    if (r.code !== 0) return null;
    const { viewer, search } = JSON.parse(r.stdout).data;
    const askedAt = (pr) => pr.timelineItems.nodes.filter((e) => e.requestedReviewer?.slug || e.requestedReviewer?.login === viewer.login).at(-1)?.createdAt ?? pr.createdAt;
    return search.nodes.filter((pr) => pr.url && !off.has(pr.url) && read[pr.url] !== askedAt(pr)).length;
  } catch { return null; }
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Back and Forward walk the places you've been, as a browser does: each tab you showed, with the pane focused in it,
// and the pull requests view. The last fifty are kept.
const KEPT = 50;
const same = (a, b) => Boolean(a && b) && (a.view ? a.view === b.view : a.tab === b.tab);
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; } };

export default class Brand extends View {
  // How many review requests are new, in shared `metro-prs.new`; the view keeps it up to date while it runs.
  init(_props, cx) {
    const count = (cx) => cx.spawn(async () => {
      const n = await fresh().catch(() => null);
      if (n != null && shared("metro-prs.new") !== n) setShared("metro-prs.new", n);
    });
    count(cx);
    cx.timer.every(180000, count);
    this.trail = load("trail", []);
    this.at = Math.min(load("at", this.trail.length - 1), this.trail.length - 1);
  }

  // Where you are now: the pull requests view, else the shown tab and its focused pane.
  here() {
    if (find(layout(), "view")?.active === "prs") return { view: "prs" };
    const f = focused();
    return f?.tab ? { tab: f.tab, pane: f.pane ?? null } : null;
  }

  // Each render notes where you are: a new place drops what was ahead of you; the same tab keeps its pane up to date.
  // A step back or forward lands in several moves (the tab, then its pane), so nothing is noted until it has landed.
  note() {
    const now = this.here();
    if (!now) return;
    if (this.going) {
      if (!same(now, this.going.to) && Date.now() - this.going.at < 1500) return;
      this.going = null;
    }
    if (same(now, this.trail[this.at])) { this.trail[this.at] = now; }
    else {
      this.trail = [...this.trail.slice(0, this.at + 1), now].slice(-KEPT);
      this.at = this.trail.length - 1;
    }
    this.save();
  }

  save() {
    try { localStorage.setItem("trail", JSON.stringify(this.trail)); localStorage.setItem("at", JSON.stringify(this.at)); } catch {}
  }

  // The nearest place in that direction that's still open: a closed tab is passed over.
  next(by) {
    const open = new Set(spaces().flatMap((s) => s.tabs.map((c) => c.id)));
    for (let i = this.at + by; i >= 0 && i < this.trail.length; i += by) if (this.trail[i].view || open.has(this.trail[i].tab)) return i;
    return -1;
  }

  go(by) {
    const i = this.next(by);
    if (i < 0) return;
    const to = this.trail[i];
    this.at = i; this.going = { to, at: Date.now() };
    this.save();
    const prsShown = find(layout(), "view")?.active === "prs";
    if (to.view) { run("layout.select", { stack: "view", child: "prs" }); return; }
    if (prsShown) run("layout.select", { stack: "view", child: "main" });
    run("tab.select", { id: to.tab });
    if (to.pane) run("pane.focus", { pane: to.pane });
  }

  render() {
    const t = theme();
    this.note();
    const prsShown = find(layout(), "view")?.active === "prs";
    const fresh = shared("metro-prs.new") ?? 0;
    // 30px buttons with 17px icons in the text's grey (`muted`), black on hover.
    const button = (id, label, icon, action) => div().id(id).relative().size(30).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label).tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(svg(icon).size(17));
    const prsLabel = prsShown ? "Show tabs" : fresh ? "Pull requests, new review requests" : "Pull requests";
    // Dimmed, and doing nothing, with nowhere to go that way.
    const step = (id, label, icon, by) => {
      const can = this.next(by) >= 0;
      return div().id(id).size(30).flex_none().flex().items_center().justify_center().rounded(7)
        .text_color(can ? t.muted : t.muted + "55").role("button").accessibility_label(label)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .when(can, (el) => el.tooltip(label).hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.go(by)))
        .child(svg(icon).size(17));
    };
    return h_flex().id("brand").size_full().bg(t.chrome).pr(8).gap(4).items_center().justify_end()
      .child(step("back", "Back", "mods/metro-chrome/icons/arrow-left.svg", -1))
      .child(step("forward", "Forward", "mods/metro-chrome/icons/arrow-right.svg", 1))
      .child(div().w(1).h(16).mx(2).flex_none().bg(t.border))
      .child(button("prs", prsLabel, "mods/metro-chrome/icons/git-pull-request.svg",
        () => run("layout.select", { stack: "view", child: prsShown ? "main" : "prs" }))
        .when(prsShown, el => el.bg(t.background).text_color(t.foreground))
        .when(fresh > 0, el => el.child(div().absolute().top(4).right(4).size(7).rounded_full().bg(t.accent))))
      .child(button("settings", "Settings", "mods/metro-chrome/settings.svg", () => run("app.settings"))
        .when(Boolean(updates().app.ready), el => el.child(div().absolute().top(4).right(4).size(7).rounded_full().bg(t.accent))))
      .child(button("sidebar-toggle", "Hide sidebar", "mods/metro-chrome/icons/sidebar.svg", () => run("layout.toggle", { id: "sidebar" })));
  }
}
