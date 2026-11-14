import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, agents, terminals, focused, run, hc, openOverlay, theme, window, layout, settings, nextCommand, shared, setShared, home, knownAgents, notify } from "herdr";
import { namer } from "./name.js";
import { lookup, staleness, prColor, issueColor, open, openDraft } from "./github.js";

// The Claude Code agent of a space to hand work to: one that isn't working first, then the latest active.
const claudeIn = (space) => agents().filter((a) => a.space === space && /claude/i.test(a.app ?? ""))
  .sort((a, b) => (a.status === "working") - (b.status === "working") || b.seq - a.seq)[0] ?? null;

// Mod panes have no program; these ones get an icon of their own.
const MOD_PROGRAMS = { "metro-review": { name: "Review", icon: "mods/metro-chrome/icons/git-compare.svg", tint: true } };

// "Needs you", drawn as the agents list and pane headers draw it.
// "Check again": an agent the person marked to come back to, a label on its terminal until the agent works again.
const CHECK = "metro.check";
const checkedSet = () => new Set(terminals().filter(k => k.labels?.[CHECK]).map(k => k.address));
const setCheck = (address, on) => hc(["label", address, `${CHECK}=${on ? "1" : ""}`]);
// An agent's state as shown: one the agents list holds in Done counts as done.
const shownStatus = (a) => a.status === "idle" && (shared("agents.finished") ?? []).includes(a.address) ? "done" : a.status;
const checkMark = (t) => svg("mods/metro-chrome/icons/bookmark-filled.svg").size(12).flex_none().text_color(t.accent);

const blockedMark = (t) => div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
// Working: a green dot whose soft halo grows and shrinks, natively, in the 14px mark column, as in metro-agents.
const breathing = (color) => div().relative().size(14).flex_none()
  .child(div().absolute().rounded_full().bg(color + "40")
    .loop("width", { from: 6, to: 14, period: 1800 }).loop("height", { from: 6, to: 14, period: 1800 })
    .loop("left", { from: 4, to: 0, period: 1800 }).loop("top", { from: 4, to: 0, period: 1800 }))
  .child(div().absolute().left(4).top(4).size(6).rounded_full().bg(color));

// A tab's state as a badge on its agent's logo: a 12px notch in the tab's color at the logo's bottom-right corner,
// and in it the same marks as elsewhere, smaller. Working breathes; the halo never leaves the notch.
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

const mark = (t, s) => s === "working" ? breathing(t.ansi2)
  : s === "blocked" ? blockedMark(t)
  : div().size(7).flex_none().rounded_full().bg(t.done);

// The work area is a stack in the layout: the active tab ("main"), one agent full size ("agent"), or the pull
// requests ("prs", metro-prs) or every project at once ("overview", metro-overview).
const agentView = () => find(layout(), "view")?.active === "agent";
const prsView = () => find(layout(), "view")?.active === "prs";
const overviewView = () => find(layout(), "view")?.active === "overview";
const showTabs = () => run("layout.select", { stack: "view", child: "main" });
const switchView = () => run("layout.select", { stack: "view", child: agentView() ? "main" : "agent" });

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    // GitHub facts per checkout and branch; the shown one is looked up again every three minutes, for a PR opened
    // since and for new commits on origin's default branch.
    this.gh = new Map();
    this.ghBusy = null; // "draft" while a draft pull request opens
    // How Claude Code starts here: programs.json's, else plain `claude`.
    this.claudeRun = ["claude"];
    cx.spawn(async () => { try { this.claudeRun = (await knownAgents()).find((a) => a.key === "claude")?.run ?? this.claudeRun; } catch {} });
    cx.timer.every(180000, (cx) => { if (this.at) this.fetchGh(this.at, cx); });
    // `metro-tabs.view` (cmd-shift-a in keys.json) switches between the tabs and the agent view; `metro-tabs.overview`
    // (cmd-p) opens and closes the overview of every project; `metro-tabs.scratch` (cmd-n) opens a one-off terminal;
    // `metro-tabs.prs` (cmd-r) and `metro-tabs.issues` (cmd-i) open the pull requests view on that tab of its list
    // (shared `metro-prs.mode`), and close it when it already shows that tab.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "view" && find(layout(), "view")) switchView();
        if (c === "overview" && find(layout(), "view")) run("layout.select", { stack: "view", child: overviewView() ? "main" : "overview" });
        if (c === "scratch") this.scratch(cx);
        if ((c === "prs" || c === "issues") && find(layout(), "view")) {
          const mode = shared("metro-prs.mode") === "issues" ? "issues" : "prs";
          if (prsView() && mode === c) run("layout.select", { stack: "view", child: "main" });
          else {
            if (mode !== c) setShared("metro-prs.mode", c);
            run("layout.select", { stack: "view", child: "prs" });
          }
        }
        cx.notify();
      }
    });
  }

  // A one-off terminal in a space of its own, at home, listed under Scratch (shared `projects.scratch`) wherever it
  // goes. `space.new` doesn't say which space it made: the one that wasn't there before is it.
  scratch(cx) {
    const before = new Set(spaces().map((s) => s.id));
    run("layout.select", { stack: "view", child: "main" });
    run("space.new", { folder: home() });
    const look = (cx, tries) => cx.timer.after(100, (cx) => {
      const made = spaces().find((s) => !before.has(s.id));
      if (made) setShared("projects.scratch", [...(shared("projects.scratch") ?? []), made.id]);
      else if (tries > 0) look(cx, tries - 1);
    });
    look(cx, 30);
  }

  // Where the PR and issues links point: the focused pane's checkout, else the tab's first terminal's, else one
  // elsewhere in the space (a Review tab has no terminal), else the space's folder.
  checkout() {
    const f = focused();
    const space = spaces().find(s => s.id === f?.space);
    const inSpace = new Set(space?.tabs.map(c => c.id) ?? []);
    const pane = panes().find(p => p.pane === f?.pane && p.cwd) ?? panes().find(p => p.tab === f?.tab && p.cwd)
      ?? panes().find(p => inSpace.has(p.tab) && p.cwd);
    const cwd = pane?.cwd ?? space?.folder, branch = pane?.branch ?? space?.branch;
    if (!cwd || !branch) return null;
    const machine = space?.machine ?? null;
    return { cwd, branch, machine, space: space?.id ?? null, key: `${machine}|${cwd}|${branch}` };
  }

  fetchGh(at, cx) {
    if (this.gh.get(at.key)?.loading) return;
    this.gh.set(at.key, { ...this.gh.get(at.key), loading: true });
    cx.spawn(async (cx) => {
      const [found, stale] = await Promise.all([
        lookup(at.cwd, at.machine, at.branch).catch(() => ({ repo: null, pr: null, issue: null })),
        staleness(at.cwd, at.machine, at.branch).catch(() => null),
      ]);
      this.gh.set(at.key, { ...found, stale });
      cx.notify();
    });
  }

  // Asks the space's Claude Code to rebase onto origin's default branch with the /re-main skill; with no Claude there,
  // starts one on it in a new tab.
  rebase(at) {
    const agent = at.space && claudeIn(at.space);
    if (!agent) {
      run("tab.new", { ...(at.space ? { space: at.space } : {}), folder: at.cwd, argv: this.claudeRun, task: "/re-main" });
      return notify({ title: "Started Claude Code to rebase", body: `${at.branch}, in a new tab.`, level: "success" });
    }
    hc(["send", agent.address, "/re-main"]).then((r) => notify(r.code === 0
      ? { title: "Asked Claude to rebase", body: `${at.branch}. Click to watch it work.`, level: "success", action: { name: "agent.focus", args: { terminal: agent.address } } }
      : { title: "Couldn't ask Claude to rebase", body: "Check the agent is still running, then try again.", level: "warning" })).catch(() => {});
  }

  // Opens a draft pull request for the shown branch; the tab bar then links it.
  draft(at, cx) {
    if (this.ghBusy) return;
    this.ghBusy = "draft";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const url = await openDraft(at.cwd, at.machine, at.branch);
        notify({ title: "Opened a draft pull request", body: url, level: "success" });
        this.gh.delete(at.key);
      } catch (e) {
        notify({ title: "Couldn't open a draft pull request", body: `${e.message ?? e}`, level: "warning" });
      }
      this.ghBusy = null;
      cx.notify();
    });
  }

  // How far the branch is behind origin's default branch, the branch's pull request (with its review) and the issue
  // it's named after, each numbered and colored by its state; the repo's issues when the branch names none; then Refresh, which spins
  // while it looks and turns red when origin couldn't be fetched.
  githubLinks(t, stop, cx) {
    const at = this.at = this.checkout();
    if (!at) return [];
    if (!this.gh.has(at.key)) this.fetchGh(at, cx);
    const { repo, pr, issue, stale, loading } = this.gh.get(at.key) ?? {};
    const link = (id, url, label) => h_flex().id(id).h(26).px(6).gap(6).flex_none().items_center().rounded(6).text_size(12)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .role("link").accessibility_label(label).on_mouse_down("left", stop).on_click(() => url && open(url));
    // A merged or closed pull request has nothing left to rebase.
    const behind = stale?.behind > 0 && (!pr || pr.state === "OPEN") ? stale : null;
    const commits = (n) => `${n} commit${n === 1 ? "" : "s"}`;
    // An open pull request's review, after its number: approved, changes requested, or comments.
    const review = pr?.state === "OPEN" && pr.review?.mark ? {
      approved: { icon: "mods/metro-chrome/icons/check.svg", color: t.ansi2 },
      changes: { icon: "mods/metro-chrome/icons/x.svg", color: t.blocked },
      commented: { icon: "mods/metro-chrome/icons/message-square.svg", color: t.muted },
    }[pr.review.mark] : null;
    return [
      behind && link("gh-behind", repo ? `https://github.com/${repo}/compare/${at.branch}...${behind.base}` : null,
        `${commits(behind.behind)} behind origin/${behind.base}`)
        .when(!repo, el => el.cursor_default())
        .tooltip(`origin/${behind.base} has ${commits(behind.behind)} this branch doesn't: rebase onto it`)
        .child(svg("mods/metro-chrome/icons/git-compare.svg").size(14).flex_none().text_color(t.working))
        .child(div().text_color(t.muted).child(`${behind.behind} behind ${behind.base}`)),
      behind && h_flex().id("gh-rebase").h(26).px(8).flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
        .text_color(t.muted).border(1).border_color(t.border).hover(s => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label(`Ask Claude to rebase onto origin/${behind.base}`).tooltip(`Ask Claude Code here to rebase onto origin/${behind.base} (/re-main)`)
        .on_mouse_down("left", stop).on_click(() => this.rebase(at))
        .child("Rebase"),
      pr && link("gh-pr", pr.url, `Pull request #${pr.number}: ${pr.title}${review ? `. ${pr.review.who}` : ""}`)
        .tooltip(review ? `#${pr.number} ${pr.title}\n${pr.review.who}` : `#${pr.number} ${pr.title}`)
        .child(svg("mods/metro-chrome/icons/github.svg").size(14).flex_none().text_color(prColor(pr, t)))
        .child(div().text_color(t.muted).child(`#${pr.number}`))
        .when(Boolean(review), el => el.child(svg(review.icon).size(12).flex_none().text_color(review.color))),
      // A branch without a pull request, other than the default one, can open a draft.
      !pr && !loading && repo && stale?.base && at.branch !== stale.base && !/^pr\//.test(at.branch) && h_flex().id("gh-draft").h(26).px(8).gap(6).flex_none().min_w(118)
        .items_center().justify_center().rounded(6).text_size(12).cursor_pointer()
        .text_color(t.muted).border(1).border_color(t.border).hover(s => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label("Open a draft pull request").tooltip(`Open a draft pull request for ${at.branch}, from its first commit`)
        .on_mouse_down("left", stop).on_click((_e, cx) => this.draft(at, cx))
        .child(svg("mods/metro-chrome/icons/git-pull-request-draft.svg").size(13).flex_none())
        .child(this.ghBusy === "draft" ? "Opening…" : "Open draft PR"),
      issue && link("gh-issue", issue.url, `Issue #${issue.number}: ${issue.title}`)
        .child(svg("mods/metro-chrome/icons/circle-dot.svg").size(14).flex_none().text_color(issueColor(issue, t)))
        .child(div().text_color(t.muted).child(`#${issue.number}`)),
      repo && !issue && link("gh-issues", `https://github.com/${repo}/issues`, `Issues of ${repo}`)
        .child(svg("mods/metro-chrome/icons/circle-dot.svg").size(14).flex_none())
        .child(div().child("Issues")),
      h_flex().id("gh-refresh").size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(stale?.failed ? t.blocked : t.dim).hover(s => s.bg(t.hover).text_color(stale?.failed ? t.blocked : t.foreground))
        .role("button").accessibility_label("Refresh pull request, issue and behind main")
        .tooltip(stale?.failed ? `Couldn't fetch origin/${stale.base}. Check your connection or git credentials, then refresh.` : "Refresh pull request, issue and behind main")
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.fetchGh(at, cx); cx.notify(); })
        .child(svg("mods/metro-chrome/icons/refresh-cw.svg").size(13).flex_none().when(Boolean(loading), el => el.spin(900))),
    ].filter(Boolean);
  }

  // With the sidebar hidden, its toggle also says how the agents are doing, with the sidebar's own marks.
  // Idle agents aren't counted: nothing to look at.
  sidebarToggle(t, stop) {
    const list = agents();
    const counts = ["blocked", "working", "done"].map(s => [s, list.filter(a => shownStatus(a) === s).length]).filter(([, n]) => n > 0);
    const words = { blocked: "need you", working: "working", done: "done" };
    const summary = counts.map(([s, n]) => `${n} ${words[s]}`).join(" · ");
    return h_flex().id("sidebar-toggle").h(26).px(6).gap(8).flex_none().items_center().rounded(6)
      .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(summary ? `Show sidebar, ${summary}` : "Show sidebar")
      .on_mouse_down("left", stop).on_click(() => run("layout.toggle", { id: "sidebar" }))
      .child(svg("mods/metro-chrome/icons/sidebar.svg").size(14).flex_none())
      .children(counts.map(([s, n]) => h_flex().id(`agents-${s}`).gap(4).items_center().child(mark(t, s)).child(div().text_color(t.muted).child(String(n)))));
  }

  // In the agent view tabs mean nothing: the bar names the agent shown instead.
  agentBar(t, title, live) {
    const shown = focused()?.agent;
    const a = agents().find(x => x.address === shown);
    if (!a) return div().id("agent-bar").flex_1().px(8).text_size(13).text_color(t.dim).child("No agent");
    const p = a.program;
    const st = shownStatus(a);
    const news = st !== "done" || live.some(x => x.address === a.address);
    return h_flex().id("agent-bar").flex_1().min_w(0).h(28).px(8).gap(8).items_center().text_size(13)
      .when(Boolean(p?.icon), el => el.child(p.tint ? svg(p.icon).size(14).text_color(t.muted) : image(p.icon).size(14)))
      .child(div().flex_none().max_w(320).truncate().text_color(t.foreground).child(title(a)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(a.space_name ?? ""))
      .when(["working", "blocked", "done"].includes(st) && news, el => el.child(mark(t, st)));
  }

  // In the pull requests view the bar names it; the brand bar's button and the one here lead back.
  prsBar(t) {
    return h_flex().id("prs-bar").flex_1().min_w(0).h(28).px(8).gap(8).items_center().text_size(13).text_color(t.foreground)
      .child(svg("mods/metro-chrome/icons/git-pull-request.svg").size(14).flex_none().text_color(t.muted))
      .child(div().truncate().child("Pull requests and issues"));
  }

  // In the overview the bar names it; the sidebar's button and the one here lead back.
  overviewBar(t) {
    return h_flex().id("overview-bar").flex_1().min_w(0).h(28).px(8).gap(8).items_center().text_size(13).text_color(t.foreground)
      .child(svg("mods/metro-chrome/icons/layout-grid.svg").size(14).flex_none().text_color(t.muted))
      .child(div().truncate().child("Projects"));
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const live = agents();
    const ps = panes(), title = namer();
    // The agent view keeps the keyboard on its agent, so a split or new tab would land unseen.
    // A new shell or mod pane in this space brings the tabs back, focused; a new agent's (often an agent
    // spawning one) doesn't take the view, the lists show it. Focus moved by keys follows the same split.
    const f = focused();
    const fresh = this.known ? ps.filter(p => !this.known.has(p.pane)) : [];
    this.known = new Set(ps.map(p => p.pane));
    const isAgent = (p) => p.status != null || Boolean(p.program?.agent);
    const here = new Set(spaces().find(s => s.id === f?.space)?.tabs.map(c => c.id) ?? []);
    const moved = f?.pane && this.lastPane && f.pane !== this.lastPane ? ps.find(p => p.pane === f.pane) : null;
    if (f?.pane) this.lastPane = f.pane;
    if (agentView()) {
      const plain = fresh.find(p => here.has(p.tab) && !isAgent(p)) ?? (moved && !isAgent(moved) ? moved : null);
      if (plain) {
        run("layout.select", { stack: "view", child: "main" });
        run("pane.focus", { pane: plain.pane });
      } else if (moved && f.agent !== moved.terminal) run("agent.focus", { terminal: moved.terminal });
    }
    // The pull requests view and the overview give way to the tabs as soon as a pane is focused or opened in this space.
    if ((prsView() || overviewView()) && (moved || fresh.some(p => here.has(p.tab)))) showTabs();
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    // Check again ends when the agent works again: you answered it.
    const checked = checkedSet();
    this.clearing ??= new Set();
    for (const a of agents()) {
      if (a.status !== "working" || !checked.has(a.address) || this.clearing.has(a.address)) continue;
      this.clearing.add(a.address);
      setCheck(a.address, false).finally(() => this.clearing.delete(a.address));
    }
    // A press on a tab's own control stays there: no selecting, no dragging the tab.
    const own = (el) => el.on_mouse_down("left", stop).on_mouse_up("left", stop);
    const item = (c, i) => {
      // Agents in this tab that are waiting on the person, not working: what Check again marks.
      const resting = agents().filter(a => a.tab === c.id && a.status !== "working" && a.status !== "blocked");
      const flagged = resting.filter(a => checked.has(a.address));
      const flag = (on) => (_e, cx) => { cx.stop_propagation(); for (const a of on ? resting : flagged) setCheck(a.address, on); };
      // A tab nobody named reads as its lead pane: the agent in it, else the focused one.
      const mine = ps.filter(p => p.tab === c.id);
      const lead = mine.find(p => p.status != null) ?? mine.find(p => p.focused) ?? mine[0];
      const program = lead?.program ?? MOD_PROGRAMS[lead?.mod] ?? null;
      const name = c.named ? c.name : lead ? title(lead) : "Terminal";
      const lit = this.hovered === c.id;
      // Any tab with an agent shows its state, an idle one a grey ring.
      const doneLive = live.some(a => a.tab === c.id && shownStatus(a) === "done");
      const idle = mine.some(p => p.status != null) && c.status !== "working" && c.status !== "blocked" && !flagged.length && !doneLive;
      const kind = c.status === "working" || c.status === "blocked" ? c.status : flagged.length ? "check" : doneLive ? "done" : idle ? "idle" : null;
      // Equal-width flat tabs split by hairlines; the active one takes the pane's paper and a dark underline.
      const row = h_flex().flex_1().min_w(0).px(12).gap(8).items_center()
        // The logo carries the state as a badge; click the bookmark to clear it, or a done badge to keep the agent
        // as Check again.
        .child(h_flex().id(`logo-${c.id}`).relative().size(14).flex_none()
          .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).flex_none().text_color(t.muted) : image(program.icon).size(14).flex_none()))
          .when(Boolean(kind), el => el.child(badge(t, kind, c.active || lit ? t.background : t.chrome)))
          .when(kind === "check" || kind === "done", el => own(el).cursor_pointer().role("button")
            .accessibility_label(kind === "check" ? "Check again; click to clear" : "Done; click to keep as Check again")
            .on_click(flag(kind === "done"))))
        .child(div().flex_1().min_w(0).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(lit && !flagged.length && resting.length > 0, el => el.child(own(div().id(`flag-${c.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).role("button").accessibility_label("Check again later")
          .on_click(flag(true)).child(svg("mods/metro-chrome/icons/bookmark.svg").size(12)))))
        .when(c.active || lit, el => el.child(div().id(`close-${c.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/metro-chrome/icons/close.svg").size(12))));
      return v_flex().id(`tab-${c.id}`).w(180).h_full().flex_none().text_size(13)
        .border_r(1).border_color(t.border)
        .bg(c.active || lit ? t.background : t.chrome).text_color(c.active || lit ? t.foreground : t.muted)
        .on_hover((on, cx) => { if (on) this.hovered = c.id; else if (this.hovered === c.id) this.hovered = null; cx.notify(); })
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .child(row)
        .child(div().h(2).flex_none().when(c.active, el => el.bg(t.foreground)).when(!c.active && lit, el => el.bg(t.border)));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // The first tab starts at the sidebar's edge, as the terminal below does. Old saved rails and a dragged-narrow
    // sidebar can be smaller than the window buttons.
    const edge = sidebar?.hidden ? 8 : 0;
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(edge, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : edge;
    return h_flex().size_full().min_w(0).px(8).pl(lightsPadding).gap(4).items_center().bg(t.chrome)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? (agentView() ? "agent.prev" : "tab.prev") : (agentView() ? "agent.next" : "tab.next")); })
      .when(Boolean(sidebar?.hidden), el => el.child(this.sidebarToggle(t, stop)))
      .child(agentView() ? this.agentBar(t, title, live) : prsView() ? this.prsBar(t) : overviewView() ? this.overviewBar(t)
        // The + follows the last tab; the tabs scroll and it stays in view.
        : h_flex().flex_1().min_w(0).h_full().items_center()
          .child(h_flex().id("tab-scroll").min_w(0).h_full().border_l(1).border_color(t.border).overflow_x_scroll().children(shown.map(item)))
          .child(button("tab-add", svg("mods/metro-chrome/icons/plus.svg").size(14), () => openOverlay({ mod: "metro-new-tab", kind: "popup", width: 220, height: 160, props: { space: space?.id } }))
            .ml(6).role("button").accessibility_label("New tab")))
      .children(prsView() || overviewView() ? [] : this.githubLinks(t, stop, cx))
      // The agent view is reached only by its key; while it shows, a button leads back to the tabs.
      .when(agentView() || prsView() || overviewView(), el => el.child(button("view-toggle", svg("mods/metro-chrome/icons/layers.svg").size(14), agentView() ? switchView : showTabs)
        .role("button").accessibility_label("Show tabs")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/metro-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/metro-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/metro-tabs/win-close.svg").size(16) : svg("mods/metro-chrome/icons/close.svg").size(13), () => run("window.close"))));
  }
}
