// The brand bar above the sidebar: room for the macOS window buttons, a place to drag the window, then Back and
// Forward, then Projects (the overview) and Pull requests (with a dot while a review request is new) at its right edge.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, layout, shared, setShared, exec, focused, spaces, notify } from "herdr";

// From GitHub through `gh`: how many open pull requests ask for your review and haven't been shown since they asked,
// leaving out the ones hidden in the pull requests view, and your own open pull requests with what happened on each:
// { asked, mine: [{ url, number, title, updates }] }, or null when it can't be asked. The view starts only once opened,
// so this repeats what it calls new (`isNew`, `askedAt` and `updates` in metro-prs).
async function fresh() {
  const query = `query { viewer { login }
    search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 50) { nodes { ... on PullRequest {
      url createdAt timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent {
        createdAt requestedReviewer { ... on User { login } ... on Team { slug } } } } } } } }
    mine: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 50) { nodes { ... on PullRequest {
      url number title author { login } latestReviews(first: 20) { nodes { state submittedAt author { login } } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } } } } } }`;
  const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`]);
  const off = new Set(shared("metro-prs.hidden") ?? []), read = shared("metro-prs.seen") ?? {};
  try {
    if (r.code !== 0) return null;
    const { viewer, search, mine } = JSON.parse(r.stdout).data;
    const askedAt = (pr) => pr.timelineItems.nodes.filter((e) => e.requestedReviewer?.slug || e.requestedReviewer?.login === viewer.login).at(-1)?.createdAt ?? pr.createdAt;
    const updates = (pr) => {
      const commit = pr.commits.nodes[0]?.commit, ci = commit?.statusCheckRollup?.state;
      return [
        ...pr.latestReviews.nodes.filter((v) => v.author?.login !== pr.author?.login && (v.state === "APPROVED" || v.state === "CHANGES_REQUESTED"))
          .map((v) => `${v.state}:${v.author?.login ?? "ghost"}:${v.submittedAt}`),
        ...(["FAILURE", "ERROR"].includes(ci) && commit?.oid ? [`FAILED:${commit.oid}`] : []),
      ];
    };
    return {
      asked: search.nodes.filter((pr) => pr.url && !off.has(pr.url) && read[pr.url] !== askedAt(pr)).length,
      mine: mine.nodes.filter((pr) => pr.url).map((pr) => ({ url: pr.url, number: pr.number, title: pr.title, updates: updates(pr) })),
    };
  } catch { return null; }
}

// One toast line per update token: "dz0ny approved", "zupo requested changes", "Checks failed".
const said = (u) => {
  const [state, login] = u.split(":");
  return state === "APPROVED" ? `${login} approved` : state === "CHANGES_REQUESTED" ? `${login} requested changes` : "Checks failed";
};

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
// How long a round the pull requests view shared stands in for asking GitHub: a little over its three minutes.
const POLLED_FOR = 200000;
const same = (a, b) => Boolean(a && b) && (a.view ? a.view === b.view : a.tab === b.tab);
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; } };

export default class Brand extends View {
  // How many review requests are new, in shared `metro-prs.new`; the view keeps it up to date while it runs. News on
  // your own pull requests is new until shown in the view (shared `metro-prs.mine-seen`, started with what's there the
  // first time, so nothing old counts) and toasted once (this copy's `toasted`).
  // While the pull requests view runs, it shares what it fetched (shared `metro-prs.polled`) and this asks GitHub only
  // when that's older than a round.
  init(_props, cx) {
    this.mine = [];
    this.polledAt = 0;
    const count = (cx) => cx.spawn(async (cx) => {
      const polled = shared("metro-prs.polled");
      if (polled && Date.now() - polled.at < POLLED_FOR) return;
      const got = await fresh().catch(() => null);
      if (got) this.take(got, cx);
    });
    count(cx);
    cx.timer.every(180000, count);
    this.trail = load("trail", []);
    this.at = Math.min(load("at", this.trail.length - 1), this.trail.length - 1);
  }

  // A round's news: the review requests count, and toasts for news on your pull requests not seen nor toasted yet.
  take(got, cx) {
    if (shared("metro-prs.new") !== got.asked) setShared("metro-prs.new", got.asked);
    this.mine = got.mine;
    const was = shared("metro-prs.mine-seen");
    if (!was) return setShared("metro-prs.mine-seen", Object.fromEntries(got.mine.map((pr) => [pr.url, pr.updates])));
    const open = new Set(got.mine.map((pr) => pr.url));
    if (Object.keys(was).some((u) => !open.has(u))) setShared("metro-prs.mine-seen", Object.fromEntries(Object.entries(was).filter(([u]) => open.has(u))));
    const toasted = load("toasted", {});
    for (const pr of got.mine) {
      const fresh = pr.updates.filter((u) => !(was[pr.url] ?? []).includes(u) && !(toasted[pr.url] ?? []).includes(u));
      if (fresh.length) notify({ title: `#${pr.number}: ${fresh.map(said).join(", ")}`, body: pr.title, level: fresh.some((u) => !u.startsWith("APPROVED")) ? "warning" : "success",
        action: { name: "layout.select", args: { stack: "view", child: "prs" } } });
    }
    try { localStorage.setItem("toasted", JSON.stringify(Object.fromEntries(got.mine.map((pr) => [pr.url, pr.updates])))); } catch {}
    cx.notify();
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
    const away = ["prs", "overview"].includes(find(layout(), "view")?.active);
    if (to.view) { run("layout.select", { stack: "view", child: "prs" }); return; }
    if (away) run("layout.select", { stack: "view", child: "main" });
    run("tab.select", { id: to.tab });
    if (to.pane) run("pane.focus", { pane: to.pane });
  }

  render(cx) {
    const t = theme();
    this.note();
    const prsShown = find(layout(), "view")?.active === "prs";
    // A round the pull requests view shared is taken as it comes; render itself can't start a redraw.
    const polled = shared("metro-prs.polled");
    if (polled && polled.at !== this.polledAt) {
      this.polledAt = polled.at;
      cx.timer.after(0, (cx) => this.take(polled, cx));
    }
    const fresh = shared("metro-prs.new") ?? 0;
    const seenMine = shared("metro-prs.mine-seen") ?? {};
    const news = seenMine ? this.mine.filter((pr) => pr.updates.some((u) => !(seenMine[pr.url] ?? []).includes(u))).length : 0;
    // 30px buttons with 17px icons in the text's grey (`muted`), black on hover.
    const button = (id, label, icon, action) => div().id(id).relative().size(30).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label).tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(svg(icon).size(17));
    const overviewShown = find(layout(), "view")?.active === "overview";
    const prsLabel = prsShown ? "Show tabs" : fresh || news ? `Pull requests, ${[fresh && "new review requests", news && "news on yours"].filter(Boolean).join(" and ")}` : "Pull requests and issues";
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
      .child(button("overview", overviewShown ? "Show tabs" : "Projects", "mods/metro-chrome/icons/layout-grid.svg",
        () => run("layout.select", { stack: "view", child: overviewShown ? "main" : "overview" }))
        .when(overviewShown, el => el.bg(t.background).text_color(t.foreground)))
      .child(button("prs", prsLabel, "mods/metro-chrome/icons/git-pull-request.svg",
        () => run("layout.select", { stack: "view", child: prsShown ? "main" : "prs" }))
        .when(prsShown, el => el.bg(t.background).text_color(t.foreground))
        .when(fresh + news > 0, el => el.child(div().absolute().top(4).right(4).size(7).rounded_full().bg(t.accent))));
  }
}
