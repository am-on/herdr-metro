// Pull requests, the work area's third view. On the left, the open pull requests waiting on your review, then your
// own, across GitHub, each with its reviewers' avatars badged with their verdict; on the right, the selected one: who
// reviewed, its checks and branch, and its conversation, with Open on GitHub, Check out and review, and Hide.
// Hidden ones (shared `metro-prs.hidden`, by URL, until they close) fold under their section.
// A review request is new until its pull request has been shown here (shared `metro-prs.seen`): a blue dot on its row,
// and one on the brand bar's button while any are new.
// Reviewing a repo that isn't here yet offers a clone found nearby, cloning it, or opening its folder; each joins the sidebar's projects.
// Its Issues tab lists the issues of your organizations' boards that work can start from, yours or no one's; Start work
// opens a worktree on a branch named after the selected one.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, TextView, InputState, Input } from "gpui-base";
import { run, spaces, panes, shared, setShared, nextCommand, settings, home, pickFolder, layout, notify, knownAgents, agents, hc } from "herdr";
import { pulls, conversation, checkouts, checkout, clone, exists, nearby, renamed, sameRepo, open, approval, approvalRules, cachedAvatars, fetchAvatars, avatarFile, avatarKey, updates,
  COLUMNS, boards, issues, issueConversation, branchName, issueBranches, start, assign, moveToInProgress } from "./github.js";

// Looked up again this often, and on Refresh.
const EVERY = 180000;
// The list's width: 400px until its edge is dragged (260 to 720), then what it was left at.
const LIST = 400, LIST_MIN = 260, LIST_MAX = 720;
const savedWidth = () => { try { return Number(JSON.parse(localStorage.getItem("listWidth") ?? "null")) || LIST; } catch { return LIST; } };
// Which tab the list shows, pull requests or issues, as it was left; shared, so metro-tabs' keys can pick one.
const savedMode = () => (shared("metro-prs.mode") === "issues" ? "issues" : "prs");
// The issues are asked when the Issues tab shows and they're older than this, and on Refresh; the boards at most hourly.
const ISSUES_EVERY = 300000, BOARDS_EVERY = 3600000;
const NONE = "#00000000";
const ICON = (name) => `mods/metro-chrome/icons/${name}.svg`;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}
const spaceAt = (path) => spaces().find((s) => !s.machine && (place(s) === path || place(s)?.startsWith(path + "/")));
const after = (cx, ms) => new Promise((done) => cx.timer.after(ms, () => done()));
const hidden = () => new Set(shared("metro-prs.hidden") ?? []);
// Which review request of each pull request was shown here: URL -> its `askedAt`.
const seen = () => shared("metro-prs.seen") ?? {};
// What was shown of each pull request of yours: URL -> its `updates` then; written first by metro-chrome, so until
// then nothing of yours is new.
const mineSeen = () => shared("metro-prs.mine-seen");
const hasNews = (pr) => !pr.askedAt && Boolean(mineSeen()) && updates(pr).some((u) => !(mineSeen()[pr.url] ?? []).includes(u));
// A review request you haven't seen, or an approval, a request for changes or failing checks on yours.
const isNew = (pr) => (Boolean(pr.askedAt) && seen()[pr.url] !== pr.askedAt) || hasNews(pr);
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The Claude Code agent of a space to hand work to: one that isn't working first, then the latest active.
const claudeIn = (space) => agents().filter((a) => a.space === space && /claude/i.test(a.app ?? ""))
  .sort((a, b) => (a.status === "working") - (b.status === "working") || b.seq - a.seq)[0] ?? null;
const tilde = (path) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);
// The colors metro-spaces deals out to projects.
const COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

const ago = (iso) => {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};
const clock = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const or = (list) => list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
// The UI font has one weight, so bold text takes the system font.
const bold = (el) => el.font_family(".SystemUIFont").font_weight(600);
// Markdown from GitHub as GitHub shows it in issues and comments: in the system font, so **bold** is bold, and a
// single line break kept, outside code blocks.
const markdown = (id, text) => div().font_family(".SystemUIFont").child(TextView.markdown(id,
  text.split(/(^```[\s\S]*?^```)/m).map((part, i) => (i % 2 ? part : part.replace(/([^\n])\n(?=[^\n])/g, "$1  \n"))).join("")).selectable(true));

// A reviewer's verdict: its badge's color and icon, and its words.
const VERDICT = {
  APPROVED: { color: (t) => t.ansi2, icon: "check", words: "approved" },
  CHANGES_REQUESTED: { color: (t) => t.blocked, icon: "x", words: "requested changes" },
  COMMENTED: { color: (t) => t.dim, icon: "message-square", words: "commented" },
  WAIT: { color: (t) => t.working, icon: "clock", words: "review requested" },
};
// GitHub's own colors, light and dark (Primer), so the view reads as GitHub does; the rest of metro keeps the theme's.
const LIGHT = {
  background: "#ffffff", foreground: "#1f2328", muted: "#59636e", dim: "#818b98", border: "#d1d9e0", chrome: "#f6f8fa", hover: "#eff2f5",
  selected: "#ddf4ff", accent: "#0969da", ansi2: "#1a7f37", solid: "#1f883d", blocked: "#d1242f", working: "#9a6700",
  greenBg: "#dafbe1", redBg: "#ffebe9", counter: "#e1e5e9", rule: "#e4e8ec", underline: "#fd8c73",
};
const DARK = {
  background: "#0d1117", foreground: "#f0f6fc", muted: "#9198a1", dim: "#656c76", border: "#3d444d", chrome: "#151b23", hover: "#262c36",
  selected: "#121d2f", accent: "#4493f8", ansi2: "#3fb950", solid: "#238636", blocked: "#f85149", working: "#d29922",
  greenBg: "#12261e", redBg: "#25171c", counter: "#2f3742", rule: "#262c36", underline: "#f78166",
};
const palette = () => (settings().dark ? DARK : LIGHT);
const FAILED = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];

export default class Prs extends View {
  init(_props, cx) {
    this.data = null; // { me, mine, asked } once loaded
    this.repos = {}; // "owner/repo" -> its main checkout here
    this.rules = [];
    this.loading = false;
    this.error = "";
    this.sel = null; // the selected pull request's URL
    this.details = new Map(); // url -> { at: its updatedAt, loading, error, events, checks }
    this.avatars = new Set(); // avatar files downloaded, by avatarKey
    this.busy = {}; // url -> true while its checkout opens
    this.errors = {}; // url -> why its checkout didn't open
    this.warnings = {}; // url -> why its checkout doesn't match it
    this.setup = {}; // "owner/repo" not here yet -> { busy: "pick" | "clone" | null, error, found, path }, while its card shows
    this.showHidden = {}; // section id -> its hidden ones are unfolded
    this.copied = null; // the URL of the pull request whose branch name was just copied
    this.handle = cx.focus_handle();
    this.listWidth = savedWidth();
    this.drag = null; // { x, width } while the list's edge is dragged
    this.mode = savedMode();
    this.issueList = null; // the board issues, once loaded
    this.boardList = null; // { me, boards, at }: the boards asked
    this.issuesLoading = false;
    this.issueError = "";
    this.selIssue = null; // the selected issue's URL
    this.names = {}; // issue URL -> the branch name typed for it
    this.found = {}; // issue URL -> { branches, base }: what its checkout has for it
    this.typing = false;
    this.boardBusy = {}; // issue URL -> "assign" or "move" while it changes on GitHub
    this.claudeBusy = {}; // pull request URL -> "fix" or "address" while it's handed to Claude
    this.claudeErrors = {}; // pull request URL -> why it couldn't be
    // How Claude Code starts here: programs.json's, else plain `claude`.
    this.claudeRun = ["claude"];
    cx.spawn(async () => { try { this.claudeRun = (await knownAgents()).find((a) => a.key === "claude")?.run ?? this.claudeRun; } catch {} });
    this.branchInput = InputState.new({ value: "", placeholder: "branch name" });
    // What's typed is kept per issue; typing its suggestion back forgets it, so a branch found later can take its place.
    this.branchInput.on("change", (_e, cx) => {
      const i = this.issue();
      if (!i) return;
      const v = this.branchInput.value();
      if (v === this.suggested(i)) delete this.names[i.url]; else this.names[i.url] = v;
      delete this.errors[i.url];
      cx.notify();
    });
    this.branchInput.on("submit", (_e, cx) => { const i = this.issue(); if (i) this.checkOut(i, cx); });
    this.branchInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.branchInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.issuesAt = 0; // when the issues last loaded
    this.shown = false; // whether the view was on screen at the last render
    this.refreshPrs(cx);
    if (this.mode === "issues") this.refreshIssues(cx);
    // The pull requests keep the brand bar's dot up to date, so they're asked on a timer; the issues only when looked at.
    cx.timer.every(EVERY, (cx) => this.refreshPrs(cx));
    // `metro-prs.refresh` from elsewhere looks again now; `metro-prs.pulls` and `metro-prs.issues` pick the list's tab.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.refresh(cx);
        else if (c === "pulls" || c === "issues") this.setMode(c === "issues" ? "issues" : "prs", cx);
      }
    });
  }

  all() {
    return this.data ? [...this.data.asked, ...this.data.mine] : [];
  }

  // The folders repos are checked out in here: every space's, and the projects kept in the sidebar.
  folders() {
    const folders = new Set(spaces().filter((s) => !s.machine).map(place).filter(Boolean));
    for (const k of shared("projects.kept") ?? []) if (!k.machine && !k.folder && k.path) folders.add(k.path);
    return [...folders];
  }

  // Hands work on one of your pull requests to Claude Code in its worktree: the space's agent gets `task` pasted, else
  // Claude starts there on it, in a new tab, or in a new space for the worktree, made when there's none.
  askClaude(pr, what, task, cx) {
    if (this.claudeBusy[pr.url]) return;
    this.claudeBusy[pr.url] = what;
    delete this.claudeErrors[pr.url];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const repo = pr.repo.toLowerCase();
        if (!this.repos[repo]) this.repos = await checkouts(this.folders());
        const main = this.repos[repo] ??= await renamed(pr.repo, this.repos);
        if (!main) throw new Error(`${pr.repo} isn't in your projects yet. Click Review locally to bring it here, then try again.`);
        const { path } = await start(main, pr.headRefName);
        const s = spaceAt(path), agent = s && claudeIn(s.id);
        if (agent) {
          const r = await hc(["send", agent.address, task]);
          if (r.code !== 0) throw new Error(`Couldn't send it to Claude in ${s.name}: ${(r.stderr || r.stdout).trim() || `hc send exited with ${r.code}`}. Check the agent is still running, then try again.`);
          notify({ title: `Sent #${pr.number} to Claude`, body: `In ${s.name}. Click to watch it work.`, level: "success", action: { name: "agent.focus", args: { terminal: agent.address } } });
        } else {
          const claude = { argv: this.claudeRun, task };
          if (s) run("tab.new", { space: s.id, folder: path, ...claude });
          else run("space.new", { folder: path, ...claude });
          notify({ title: `Started Claude Code on #${pr.number}`, body: s ? `In a new tab of ${s.name}.` : "In a new space for its worktree.", level: "success" });
        }
      } catch (e) {
        this.claudeErrors[pr.url] = `${e.message ?? e}`;
      }
      delete this.claudeBusy[pr.url];
      cx.notify();
    });
  }

  // What Claude is told about failing checks: which, and how to read why.
  fixTask(pr, d) {
    const failing = (d.checks ?? []).filter((c) => FAILED.includes(c.state));
    const runs = [...new Set(failing.map((c) => /\/actions\/runs\/(\d+)/.exec(c.url ?? "")?.[1]).filter(Boolean))];
    const read = [`\`gh pr checks ${pr.number} --repo ${pr.repo}\``, ...runs.map((r) => `\`gh run view ${r} --log-failed --repo ${pr.repo}\``)];
    return `Checks failed on pull request #${pr.number}, ${pr.url}: ${failing.map((c) => c.name).join(", ") || "see the checks"}. Read why with ${or(read)}, fix the cause on this branch, and tell me what you changed.`;
  }

  // What Claude is told about requested changes: each such review with its comments on files, and how to read the rest.
  addressTask(pr, d) {
    const asking = new Set(pr.reviewers.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.login));
    const reviews = (d.events ?? []).filter((e) => e.kind === "review" && e.state === "CHANGES_REQUESTED" && asking.has(e.login))
      .filter((e, i, all) => all.findIndex((x) => x.login === e.login) === i);
    const parts = reviews.map((e) => [`### ${e.login}`, e.body || "(no summary)",
      ...e.inline.map((c) => `${c.path}${c.line ? `:${c.line}` : ""}\n${c.body}`),
      ...(e.more ? [`and ${e.more} more comments on files`] : [])].join("\n\n"));
    return `${or([...asking])} requested changes on pull request #${pr.number}, ${pr.url}. Where a comment asks a question, answer it and change nothing; change code only where a comment asks for a change. For everything said, read \`gh pr view ${pr.number} --repo ${pr.repo} --comments\` and \`gh api repos/${pr.repo}/pulls/${pr.number}/comments\`, then tell me what you changed.${parts.length ? `\n\n${parts.join("\n\n")}` : ""}`;
  }

  // A plain pill button with Claude's logo that hands something to Claude; it says Sending… while it does, at its width.
  claudeButton(t, pr, what, label, task, tip) {
    const busy = this.claudeBusy[pr.url] === what;
    return this.button(t, `claude-${what}`, busy ? "Sending…" : label, image(ICON("claude")).size(15), (cx) => this.askClaude(pr, what, task(), cx), tip)
      .min_w(190).justify_center();
  }

  isMine(pr) {
    return Boolean(this.data?.mine.some((p) => p.url === pr.url));
  }

  // Claude Code's first message when it's started on an issue.
  task(issue) {
    return `Work on ${issue.url}: "${issue.title}". Read it and its comments with \`gh issue view ${issue.number} --repo ${issue.repo} --comments\`, then tell me your plan before changing code.`;
  }

  // Assign me and Move to In Progress: each changes the issue on GitHub, then the list at once. What failed stays in
  // amber under their rows.
  boardAction(issue, what, cx) {
    if (this.boardBusy[issue.url]) return;
    this.boardBusy[issue.url] = what;
    delete this.warnings[issue.url];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (what === "assign") {
          await assign(issue);
          issue.assignees = [this.boardList?.me, ...issue.assignees].filter(Boolean);
        } else {
          await moveToInProgress(issue);
          issue.column = "In Progress";
          this.issueList.sort((a, b) => COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        }
      } catch (e) {
        this.warnings[issue.url] = `${e.message ?? e}`;
      }
      delete this.boardBusy[issue.url];
      cx.notify();
    });
  }

  issue() {
    return this.issueList?.find((i) => i.url === this.selIssue) ?? null;
  }

  // The open pull request of an issue: one GitHub links to it ("Fixes #331"), else one of the list's whose branch
  // carries its number (fix/331-…).
  prFor(issue) {
    const named = new RegExp(`(^|/)${issue.number}(-|$)`);
    return issue.linked[0] ?? this.all().find((pr) => pr.repo.toLowerCase() === issue.repo.toLowerCase() && named.test(pr.headRefName)) ?? null;
  }

  // Shows the pull request in the Pull requests tab, or on GitHub when the tab doesn't list it.
  showPr(pr, cx) {
    const listed = this.all().find((p) => p.url === pr.url);
    if (!listed) return open(pr.url);
    this.setMode("prs", cx);
    this.select(listed, cx);
  }

  // The branch name offered for an issue: its branch already here or on origin, else one made from its title.
  suggested(issue) {
    return this.found[issue.url]?.branches[0] ?? branchName(issue);
  }

  branchOf(issue) {
    return (this.names[issue.url] ?? this.suggested(issue)).trim();
  }

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (shared("metro-prs.mode") !== mode) setShared("metro-prs.mode", mode);
    this.select(mode === "issues" ? this.issue() ?? this.issueList?.[0] : this.all().find((pr) => pr.url === this.sel) ?? this.visible()[0], cx);
    if (mode === "issues") this.issuesIfStale(cx);
    cx.notify();
  }

  refreshIssues(cx) {
    if (this.issuesLoading) return;
    this.issuesLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.boardList || Date.now() - this.boardList.at > BOARDS_EVERY) this.boardList = { ...(await boards()), at: Date.now() };
        const [list, { skip }] = await Promise.all([issues(this.boardList), approvalRules()]);
        this.issueList = list.filter((i) => !skip.has(i.repo.toLowerCase()));
        this.issueError = "";
        this.issuesAt = Date.now();
        const sel = this.issue() ?? this.issueList[0];
        this.selIssue = sel?.url ?? null;
        if (sel && this.mode === "issues") this.select(sel, cx);
        for (const i of this.issueList) this.loadBranches(i, cx);
        this.loadAvatars(this.issueList.flatMap((i) => [i.author, ...i.assignees]), cx);
      } catch (e) {
        this.issueError = "Couldn't load the issues from your boards. Check your connection and that `gh auth status` lists the read:project scope, then refresh.";
      }
      this.issuesLoading = false;
      cx.notify();
    });
  }

  // The issue's branches in its checkout, looked up when it's selected and after Start work; the branch box shows the
  // first one unless something else was typed.
  loadBranches(issue, cx) {
    const main = this.repos[issue.repo.toLowerCase()];
    if (!main) return;
    cx.spawn(async (cx) => {
      const got = await issueBranches(main, issue.number).catch(() => null);
      if (!got) return;
      this.found[issue.url] = got;
      if (this.selIssue === issue.url && this.names[issue.url] == null && this.branchInput.value() !== this.suggested(issue)) this.branchInput.set_value(this.suggested(issue));
      cx.notify();
    });
  }

  issuesIfStale(cx) {
    if (Date.now() - this.issuesAt > ISSUES_EVERY) this.refreshIssues(cx);
  }

  // Refresh: both lists, now.
  refresh(cx) {
    this.refreshIssues(cx);
    this.refreshPrs(cx);
  }

  refreshPrs(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [data, repos, rules, have] = await Promise.all([pulls(), checkouts(this.folders()), approvalRules(), cachedAvatars()]);
        this.data = data; this.repos = repos; this.rules = rules.rules; this.ruleError = rules.error; this.avatars = have;
        this.error = ""; this.at = Date.now();
        // A hidden one that closed is forgotten.
        const open = new Set(this.all().map((pr) => pr.url)), was = shared("metro-prs.hidden") ?? [];
        if (was.some((u) => !open.has(u))) setShared("metro-prs.hidden", was.filter((u) => open.has(u)));
        // So is what was seen of one no longer asking for your review.
        const asking = new Set(this.data.asked.map((pr) => pr.url)), read = Object.entries(seen());
        if (read.some(([u]) => !asking.has(u))) setShared("metro-prs.seen", Object.fromEntries(read.filter(([u]) => asking.has(u))));
        this.publishNew();
        // What the brand bar would ask GitHub for, so it doesn't while this runs.
        const off = hidden();
        setShared("metro-prs.polled", { at: Date.now(), asked: this.data.asked.filter((pr) => !off.has(pr.url) && isNew(pr)).length,
          mine: this.data.mine.map((pr) => ({ url: pr.url, number: pr.number, title: pr.title, updates: updates(pr) })) });
        const sel = this.all().find((pr) => pr.url === this.sel) ?? this.visible()[0];
        this.sel = sel?.url ?? null;
        if (sel) this.loadDetail(sel, cx);
        // The issues may have come first, before the checkouts their branches are looked up in.
        for (const i of this.issueList ?? []) this.loadBranches(i, cx);
        this.loadAvatars(this.all().flatMap((pr) => [pr.author, ...pr.reviewers.map((r) => r.login), ...pr.requested]), cx);
      } catch (e) {
        this.error = `Couldn't load pull requests: ${e.message ?? e}. Check \`gh auth status\` in a terminal, then refresh.`;
      }
      this.loading = false;
      cx.notify();
    });
  }

  loadAvatars(logins, cx) {
    cx.spawn(async (cx) => {
      const got = await fetchAvatars(logins, this.avatars).catch(() => []);
      for (const l of got) this.avatars.add(avatarKey(l));
      if (got.length) cx.notify();
    });
  }

  // The conversation and checks of a pull request, or an issue's comments, read when it's selected and again once it has changed.
  loadDetail(pr, cx) {
    const d = this.details.get(pr.url);
    if (d && (d.loading || (d.at === pr.updatedAt && !d.error))) return;
    this.details.set(pr.url, { ...d, at: pr.updatedAt, loading: true, error: "" });
    cx.spawn(async (cx) => {
      try {
        const got = await (pr.kind === "issue" ? issueConversation(pr) : conversation(pr));
        this.details.set(pr.url, { at: pr.updatedAt, loading: false, error: "", ...got });
        this.loadAvatars(got.events.map((e) => e.login), cx);
      } catch (e) {
        this.details.set(pr.url, { ...this.details.get(pr.url), loading: false, error: `Couldn't load the conversation: ${e.message ?? e}. Refresh to try again.` });
      }
      cx.notify();
    });
  }

  select(pr, cx) {
    if (!pr) return;
    if (pr.kind === "issue") {
      if (this.selIssue !== pr.url || this.branchInput.value() !== this.branchOf(pr)) this.branchInput.set_value(this.names[pr.url] ?? this.suggested(pr));
      this.selIssue = pr.url;
      this.loadBranches(pr, cx);
    } else this.sel = pr.url;
    this.loadDetail(pr, cx);
    cx.notify();
  }

  // The list in its order, without the hidden ones unless their fold is open: what the arrow keys walk.
  visible() {
    if (!this.data) return [];
    const off = hidden();
    return [["asked", this.data.asked], ["mine", this.data.mine]]
      .flatMap(([id, list]) => [...list.filter((pr) => !off.has(pr.url)), ...(this.showHidden[id] ? list.filter((pr) => off.has(pr.url)) : [])]);
  }

  // How many review requests are new, hidden ones left out, for the brand bar's dot.
  publishNew() {
    if (!this.data) return;
    const off = hidden(), n = this.data.asked.filter((pr) => !off.has(pr.url) && isNew(pr)).length;
    if (shared("metro-prs.new") !== n) setShared("metro-prs.new", n);
  }

  // The selected pull request counts as seen once this view is on screen.
  markSeen() {
    const pr = this.all().find((p) => p.url === this.sel);
    if (!pr || !isNew(pr) || this.mode !== "prs" || find(layout(), "view")?.active !== "prs") return;
    if (hasNews(pr)) return setShared("metro-prs.mine-seen", { ...mineSeen(), [pr.url]: updates(pr) });
    setShared("metro-prs.seen", { ...seen(), [pr.url]: pr.askedAt });
    this.publishNew();
  }

  hide(pr, on) {
    const off = hidden();
    if (on) off.add(pr.url); else off.delete(pr.url);
    setShared("metro-prs.hidden", [...off]);
    this.publishNew();
  }

  // Shows the pull request's checkout: its space, made (with a worktree) when there's none, and a Review tab there on
  // the branch (or the space's Review tab). An issue's is the space of the branch in its branch box, with Claude Code
  // started there on it when `agent`. A repo that isn't
  // here yet shows its card instead.
  checkOut(pr, cx, agent = false) {
    const repo = pr.repo.toLowerCase(), issue = pr.kind === "issue";
    if (this.busy[pr.url] || this.setup[repo]?.busy) return;
    if (issue && !this.branchOf(pr)) {
      this.errors[pr.url] = "Type a branch name.";
      return cx.notify();
    }
    this.busy[pr.url] = agent ? "agent" : "work";
    delete this.errors[pr.url];
    delete this.warnings[pr.url];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // A space opened since the last look counts.
        if (!this.repos[repo]) this.repos = await checkouts(this.folders());
        const main = this.repos[repo] ??= await renamed(pr.repo, this.repos);
        if (!main) {
          delete this.repos[repo];
          const found = await nearby(pr.repo, this.repos);
          this.setup[repo] = { busy: null, error: "", ...this.setup[repo], found, agent };
          delete this.busy[pr.url];
          return cx.notify();
        }
        delete this.setup[repo];
        const { path, warning } = issue ? await start(main, this.branchOf(pr)) : await checkout(main, pr);
        const claude = issue && agent ? { argv: this.claudeRun, task: this.task(pr) } : {};
        let s = spaceAt(path), made = !s;
        if (!s) {
          // A new space's first tab is Claude Code itself.
          run("space.new", { folder: path, ...claude });
          for (let i = 0; i < 50 && !(s = spaceAt(path)); i++) await after(cx, 100);
        }
        if (!s) throw new Error(`It's checked out in ${path}, but no space opened there. Open that folder as a space.`);
        run("layout.select", { stack: "view", child: "main" });
        run("space.select", { id: s.id });
        if (issue) {
          if (agent && !made) run("tab.new", { space: s.id, folder: path, ...claude });
          this.loadBranches(pr, cx);
        } else {
          const tabs = new Set(s.tabs.map((c) => c.id));
          const shown = panes().find((p) => p.mod === "metro-review" && tabs.has(p.tab));
          if (shown) run("tab.select", { id: shown.tab });
          else run("tab.new", { space: s.id, name: "Review", mod: "metro-review", props: { folder: path, space: s.id, machine: null, mode: "branch" } });
        }
        // The toast shows a line and goes, so the whole warning stays under Review locally, a click away.
        if (warning) {
          this.warnings[pr.url] = warning;
          notify({ title: `Couldn't update the checkout of #${pr.number}`, body: warning.why, level: "warning", action: { name: "layout.select", args: { stack: "view", child: "prs" } } });
        }
      } catch (e) {
        this.errors[pr.url] = `${e.message ?? e}`;
      }
      delete this.busy[pr.url];
      cx.notify();
    });
  }

  // The repo's main checkout in this folder. Anything else there is an error ending in `next`, what to do about it.
  async cloneAt(folder, pr, next) {
    const [origin, main] = Object.entries(await checkouts([folder]))[0] ?? [];
    if (origin && await sameRepo(origin, pr.repo)) return main;
    throw new Error(`${tilde(folder)} ${origin ? `is a clone of ${origin}, not ${pr.repo}` : `isn't a clone of ${pr.repo}`}. ${next}`);
  }

  // Lists the repo in the sidebar's projects, kept there once its spaces close. One already listed stays as it is.
  addProject(main) {
    if (Object.values(this.repos).includes(main)) return;
    const name = main.split("/").pop(), key = JSON.stringify([null, `${main}/.git`]);
    const kept = (shared("projects.kept") ?? []).filter((k) => k.key !== key);
    const used = [...Object.values(shared("space.colors") ?? {}), ...kept.map((k) => k.color)];
    const uses = (c) => used.filter((v) => v === c).length;
    const color = COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    setShared("projects.kept", [...kept, { key, name, initial: null, folder: false, path: main, machine: null, color, space: null }]);
  }

  // One way of bringing a repo here: `find` resolves with its main checkout, or nothing to stay on the card. The
  // repo then joins the projects and the review goes on.
  bring(pr, cx, busy, find) {
    const repo = pr.repo.toLowerCase(), s = this.setup[repo];
    if (!s || s.busy) return;
    s.busy = busy;
    s.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const main = await find(s, cx);
        s.busy = null;
        if (main) {
          this.addProject(main);
          this.repos[repo] = main;
          return this.checkOut(pr, cx, s.agent);
        }
      } catch (e) {
        s.busy = null;
        s.error = `${e.message ?? e}`;
      }
      cx.notify();
    });
  }

  openFolder(pr, cx) {
    this.bring(pr, cx, "pick", async () => {
      const folder = await pickFolder({ prompt: "Use this folder" });
      return folder && this.cloneAt(folder, pr, "Open the folder of your clone, or clone it.");
    });
  }

  // Clones into the chosen folder; choosing the clone itself uses it.
  cloneRepo(pr, cx) {
    this.bring(pr, cx, "pick", async (s, cx) => {
      const folder = await pickFolder({ prompt: "Clone here" });
      if (!folder) return null;
      const here = await this.cloneAt(folder, pr, "").catch(() => null);
      if (here) return here;
      const path = `${folder}/${pr.repo.split("/")[1]}`;
      if (!(await exists(path))) {
        s.busy = "clone";
        s.path = path;
        cx.notify();
        try { await clone(pr.repo, path); }
        catch (e) { throw new Error(`Couldn't clone ${pr.repo}: ${e.message ?? e}. Check that \`gh auth status\` works in a terminal, then try again.`); }
      }
      return this.cloneAt(path, pr, "Clone it to another folder, or open the folder of your clone.");
    });
  }

  key(e, cx) {
    // Keys typed in the branch box are its own.
    if (this.typing) return;
    const issues = this.mode === "issues";
    const list = issues ? this.issueList ?? [] : this.visible(), i = list.findIndex((pr) => pr.url === (issues ? this.selIssue : this.sel));
    if (e.key === "down" || e.key === "up") this.select(list[Math.max(0, Math.min(list.length - 1, i + (e.key === "down" ? 1 : -1)))], cx);
    else if (e.key === "enter" && list[i]) open(list[i].url);
  }

  // A person's avatar (their initial until it's downloaded), with their verdict as a badge in a notch of `notch`, the
  // color behind it, at its bottom-right corner, as metro badges an agent's logo.
  avatar(t, login, size, verdict, notch) {
    const has = this.avatars.has(avatarKey(login));
    const face = has ? image(avatarFile(login)).size(size).rounded_full()
      : div().size(size).rounded_full().bg(t.border).flex().items_center().justify_center().text_size(Math.round(size * 0.45)).text_color(t.muted).child([...login][0]?.toUpperCase() ?? "?");
    const v = VERDICT[verdict];
    return div().id(`av-${login}-${size}`).relative().size(size).flex_none().tooltip(v ? `${login} ${v.words}` : login).child(face)
      .when(Boolean(v), (el) => el.child(div().absolute().right(-3).bottom(-3).size(13).rounded_full().bg(notch).flex().items_center().justify_center()
        .child(verdict === "WAIT"
          ? div().size(9).rounded_full().border(1.5).border_color(v.color(t)).bg(notch)
          : div().size(9).rounded_full().bg(v.color(t)).flex().items_center().justify_center().child(svg(ICON(v.icon)).size(6).text_color("#ffffff")))));
  }

  pill(t, kind, text, icon) {
    const look = { full: [t.solid, "#ffffff", t.solid], part: [NONE, t.ansi2, t.ansi2 + "99"], plain: [NONE, t.muted, t.border] }[kind];
    return h_flex().h(20).px(7).gap(4).flex_none().items_center().rounded_full().border(1).border_color(look[2]).bg(look[0])
      .text_size(11.5).text_color(look[1])
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(11)))
      .child(text);
  }

  approvalPill(t, pr) {
    const a = approval(pr, this.rules);
    if (!a || a.level === "none") return null;
    return a.level === "full" ? this.pill(t, "full", "Approved", "check") : this.pill(t, "part", `${a.n} of ${a.of}`, "check");
  }

  ci(t, state, size = 13) {
    const [icon, color, words] = state === "SUCCESS" ? ["check", t.ansi2, "Checks passed"]
      : FAILED.includes(state) ? ["x", t.blocked, "Checks failed"]
      : state === "SKIPPED" || state === "NEUTRAL" ? ["circle-dot", t.dim, "Skipped"]
      : state ? ["circle-dot", t.working, "Checks running"] : [];
    return icon ? div().id(`ci-${words}`).flex_none().tooltip(words).accessibility_label(words).child(svg(ICON(icon)).size(size).text_color(color)) : null;
  }

  prIcon(t, pr, size = 16) {
    return svg(ICON(pr.isDraft ? "git-pull-request-draft" : "git-pull-request")).size(size).flex_none().text_color(pr.isDraft ? t.dim : t.ansi2);
  }

  item(t, pr, mine, isHidden) {
    const key = pr.url, chosen = this.sel === key, lit = this.hovered === key;
    const bg = chosen ? t.selected : lit ? t.chrome : t.background;
    const faces = [...pr.reviewers.map((r) => [r.login, r.state]), ...(mine ? pr.requested.map((l) => [l, "WAIT"]) : [])];
    // Rows are split by hairlines, as GitHub splits its lists; the selected one has a blue bar on its left.
    const fresh = isNew(pr);
    return h_flex().id(`pr-${key}`).w_full().min_w(0).relative().pl(16).pr(16).py(11).gap(10).flex_none().items_start()
      .bg(bg).border_b(1).border_color(t.rule).when(isHidden, (el) => el.opacity(0.55))
      .when(chosen, (el) => el.child(div().absolute().left(0).top(0).bottom(0).w(3).bg(t.accent)))
      .when(fresh, (el) => el.child(div().absolute().left(5).top(17).size(6).rounded_full().bg(t.accent)))
      .role("button").accessibility_label(`${fresh ? "New: " : ""}#${pr.number} ${pr.title}`)
      .on_hover((on, cx) => { if (on) this.hovered = key; else if (this.hovered === key) this.hovered = null; cx.notify(); })
      .on_click((e, cx) => { this.handle.focus(); if (e.click_count === 2) open(pr.url); this.select(pr, cx); })
      .child(div().pt(1).flex_none().child(this.prIcon(t, pr)))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(div().min_w(0).truncate().text_size(13.5).text_color(t.foreground).child(pr.title))
        .child(h_flex().min_w(0).h(20).gap(8).items_center().text_size(12).text_color(t.muted)
          .child(div().flex_none().child(`${pr.repo.split("/")[1]} #${pr.number}`))
          .when(pr.isDraft, (el) => el.child(this.pill(t, "plain", "Draft")))
          .children([this.approvalPill(t, pr)].filter(Boolean))
          .child(h_flex().flex_none().gap(5).items_center().children(faces.slice(0, 5).map(([l, v]) => this.avatar(t, l, 20, v, bg))))
          // Only checks that need a look: beside the avatars, a green check would read as an approval.
          .children(pr.ci === "SUCCESS" ? [] : [this.ci(t, pr.ci)].filter(Boolean))
          .child(div().flex_1())
          .child(div().flex_none().text_color(t.dim).child(ago(pr.updatedAt)))));
  }

  section(t, id, label, all, mine) {
    const off = hidden(), list = all.filter((pr) => !off.has(pr.url)), away = all.filter((pr) => off.has(pr.url));
    const unfolded = this.showHidden[id] && away.length > 0;
    return [
      // A heading bar as GitHub heads a list: 16px sentence case on grey between lines.
      h_flex().id(id).h(44).px(16).gap(8).flex_none().items_center().text_size(16).text_color(t.foreground)
        .bg(t.chrome).border_b(1).border_color(t.border).when(id !== "asked", (el) => el.border_t(1))
        .child(div().child(label))
        .child(h_flex().h(20).min_w(20).px(6).rounded_full().items_center().justify_center().text_size(12)
          .bg(t.counter).text_color(t.foreground).child(String(list.length))),
      ...list.map((pr) => this.item(t, pr, mine, false)),
      ...(list.length ? [] : [div().px(16).py(12).text_size(12.5).text_color(t.dim).child(!mine ? "Nothing to review." : away.length ? "Nothing to show." : "You have no open pull requests.")]),
      // The hidden ones fold into a row under the section: "2 hidden", click to see them dimmed.
      ...(away.length ? [h_flex().id(`${id}-hidden`).h(36).px(16).gap(6).flex_none().items_center().text_size(12).text_color(t.dim)
        .hover((s) => s.text_color(t.foreground))
        .role("button").accessibility_label(unfolded ? `Fold the ${away.length} hidden` : `Show the ${away.length} hidden`)
        .on_click((_e, cx) => { this.showHidden[id] = !this.showHidden[id]; cx.notify(); })
        .child(svg(ICON(unfolded ? "chevron-down" : "chevron-right")).size(12).flex_none())
        .child(div().child(`${away.length} hidden`))] : []),
      ...(unfolded ? away.map((pr) => this.item(t, pr, mine, true)) : []),
    ];
  }

  // A GitHub label: its own color, the text dark or light to read on it.
  label(t, l) {
    const c = `#${l.color}`, [r, g, b] = [0, 2, 4].map((i) => parseInt(l.color.slice(i, i + 2), 16));
    const light = 0.299 * r + 0.587 * g + 0.114 * b > 150;
    return h_flex().h(20).px(7).flex_none().items_center().rounded_full().border(1).text_size(11.5)
      .border_color(settings().dark ? c + "66" : c).bg(settings().dark ? c + "2e" : c).text_color(settings().dark ? c : light ? "#1f2328" : "#ffffff")
      .child(l.name);
  }

  issueItem(t, it) {
    const key = it.url, chosen = this.selIssue === key, lit = this.hovered === key;
    const bg = chosen ? t.selected : lit ? t.chrome : t.background;
    return h_flex().id(`is-${key}`).w_full().min_w(0).relative().pl(16).pr(16).py(11).gap(10).flex_none().items_start()
      .bg(bg).border_b(1).border_color(t.rule)
      .when(chosen, (el) => el.child(div().absolute().left(0).top(0).bottom(0).w(3).bg(t.accent)))
      .role("button").accessibility_label(`#${it.number} ${it.title}`)
      .on_hover((on, cx) => { if (on) this.hovered = key; else if (this.hovered === key) this.hovered = null; cx.notify(); })
      .on_click((e, cx) => { this.handle.focus(); if (e.click_count === 2) open(it.url); this.select(it, cx); })
      .child(div().pt(1).flex_none().child(svg(ICON("circle-dot")).size(16).text_color(t.ansi2)))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(div().min_w(0).truncate().text_size(13.5).text_color(t.foreground).child(it.title))
        .child(h_flex().min_w(0).h(20).gap(8).items_center().text_size(12).text_color(t.muted)
          .child(div().flex_none().child(`${it.repo.split("/")[1]} #${it.number}`))
          .child(h_flex().min_w(0).gap(4).overflow_hidden().children(it.labels.slice(0, 2).map((l) => this.label(t, l))))
          .child(div().flex_1())
          .children([this.startedMark(t, it)].filter(Boolean))
          .child(it.assignees.length ? this.avatar(t, it.assignees[0], 20, null, bg) : div().flex_none().text_color(t.dim).child("Unassigned"))
          .child(div().flex_none().text_color(t.dim).child(ago(it.updatedAt)))));
  }

  // How far an issue's work got, at its row's right: its open pull request, else the branch it's started on.
  startedMark(t, it) {
    const pr = this.prFor(it), branch = this.found[it.url]?.branches[0];
    if (pr) return h_flex().id(`pr-of-${it.url}`).flex_none().gap(3).items_center().text_color(pr.isDraft ? t.dim : t.ansi2).tooltip(`Pull request #${pr.number}: ${pr.title}`)
      .child(svg(ICON(pr.isDraft ? "git-pull-request-draft" : "git-pull-request")).size(13)).child(`#${pr.number}`);
    if (branch) return div().id(`branch-of-${it.url}`).flex_none().text_color(t.muted).tooltip(`Started on ${branch}`).child(svg(ICON("git-branch")).size(13));
    return null;
  }

  // The issues by column, nearest to done first; a column with none is left out.
  issueRows(t) {
    const list = this.issueList;
    if (!list) return this.issuesLoading ? [this.loadingRow(t, "Loading issues…")] : [];
    if (!list.length) return [div().px(16).py(12).text_size(12.5).text_color(t.dim).child("No issues to start on your boards.")];
    return COLUMNS.filter((c) => list.some((i) => i.column === c)).flatMap((c, n) => {
      const items = list.filter((i) => i.column === c);
      return [
        h_flex().id(`col-${c}`).h(44).px(16).gap(8).flex_none().items_center().text_size(16).text_color(t.foreground)
          .bg(t.chrome).border_b(1).border_color(t.border).when(n > 0, (el) => el.border_t(1))
          .child(div().child(c))
          .child(h_flex().h(20).min_w(20).px(6).rounded_full().items_center().justify_center().text_size(12).bg(t.counter).text_color(t.foreground).child(String(items.length))),
        ...items.map((i) => this.issueItem(t, i)),
      ];
    });
  }

  loadingRow(t, text) {
    return h_flex().id("list-loading").px(16).py(12).gap(8).items_center().text_size(12.5).text_color(t.dim)
      .child(svg(ICON("spinner")).size(13).spin(900)).child(text);
  }

  // The list's tabs, GitHub's underline tabs: Pull requests and Issues, each with its count.
  tab(t, id, label, icon, count) {
    const on = this.mode === id;
    return h_flex().id(`tab-${id}`).h_full().relative().px(8).gap(6).flex_none().items_center().text_size(14)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
      .role("button").accessibility_label(label)
      .on_click((_e, cx) => { this.handle.focus(); this.setMode(id, cx); })
      .child(svg(ICON(icon)).size(15).text_color(on ? t.foreground : t.muted))
      .child(div().child(label))
      .when(count != null, (el) => el.child(h_flex().h(20).min_w(20).px(6).rounded_full().items_center().justify_center().text_size(12).bg(t.counter).text_color(t.foreground).child(String(count))))
      .when(on, (el) => el.child(div().absolute().left(2).right(2).bottom(0).h(2).rounded(1).bg(t.underline)));
  }

  list(t) {
    const d = this.data, issues = this.mode === "issues";
    const busy = this.loading || this.issuesLoading;
    const off = hidden();
    const head = h_flex().h(46).pl(8).pr(8).gap(2).flex_none().items_center().border_b(1).border_color(t.border)
      .child(this.tab(t, "prs", "Pull requests", "git-pull-request", d ? this.all().filter((pr) => !off.has(pr.url)).length : null))
      .child(this.tab(t, "issues", "Issues", "circle-dot", this.issueList?.length))
      .child(div().flex_1())
      .child(div().id("refresh").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label("Refresh").tooltip(this.at ? `Refresh · updated ${clock(this.at)}` : "Refresh")
        .on_click((_e, cx) => this.refresh(cx))
        .child(svg(ICON("refresh-cw")).size(13).when(busy, (el) => el.spin(900))));
    const problems = (issues ? [this.issueError, this.ruleError] : [this.error, this.ruleError]).filter(Boolean)
      .map((text, i) => div().id(`problem-${i}`).px(16).py(4).text_size(12).text_color(t.blocked).child(text));
    const rows = issues ? this.issueRows(t)
      : d ? [...this.section(t, "asked", "Waiting on your review", d.asked, false), ...this.section(t, "mine", "Your pull requests", d.mine, true)]
      : this.loading ? [this.loadingRow(t, "Loading pull requests…")] : [];
    return v_flex().w(this.listWidth).h_full().flex_none().min_h(0).border_r(1).border_color(t.border)
      .child(head).children(problems)
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id(`list-${this.mode}`).size_full().pb(16).overflow_y_scroll().children(rows))
        .when(rows.length > 0, (el) => el.child(div().absolute().top(0).bottom(0).right(0).w(10).child(Scrollbar.vertical(`list-${this.mode}`).size_full().mode("always")))));
  }

  // A pill-shaped button: plain (bordered) or dark (the main action).
  button(t, id, label, icon, action, tip = label, dark = false) {
    return h_flex().id(id).h(34).px(16).gap(8).flex_none().items_center().rounded_full().border(1).text_size(13.5)
      .border_color(dark ? t.foreground : t.border).bg(dark ? t.foreground : t.background).text_color(dark ? t.background : t.foreground)
      .hover((s) => (dark ? s.opacity(0.85) : s.bg(t.chrome)))
      .role("button").accessibility_label(tip).tooltip(tip)
      .on_click((_e, cx) => action(cx))
      .when(Boolean(icon), (el) => el.child(typeof icon === "string" ? svg(ICON(icon)).size(15) : icon)).child(label);
  }

  // A small bordered pill button, `width` wide so its busy words don't resize it.
  smallButton(t, id, label, width, action, tip) {
    return h_flex().id(id).h(28).px(12).ml(4).flex_none().min_w(width).items_center().justify_center().rounded_full().border(1).text_size(13)
      .border_color(t.border).bg(t.background).text_color(t.foreground).hover((s) => s.bg(t.chrome))
      .role("button").accessibility_label(tip).tooltip(tip).on_click((_e, cx) => action(cx)).child(label);
  }

  // Under Review locally when the repo isn't here yet: use the clone found nearby, clone it, or say where it is.
  setupCard(t, pr, s) {
    const found = s.found && tilde(s.found);
    return v_flex().id("setup").mt(12).p(16).gap(12).rounded(6).border(1).border_color(t.border).bg(t.chrome)
      .child(v_flex().gap(4)
        .child(div().text_size(14).text_color(t.foreground).child(`${pr.repo.split("/")[1]} isn't in your projects yet`))
        .child(div().text_size(13).text_color(t.muted).child(`${found ? `It looks like it's already in ${found}.` : "Clone it, or open its folder if you already have it."} It joins your projects and ${pr.kind === "issue" ? "its worktree" : "the review"} opens.`)))
      .child(s.busy === "clone"
        ? h_flex().h(34).gap(8).items_center().text_size(13.5).text_color(t.muted).child(svg(ICON("spinner")).size(14).spin(900)).child(`Cloning ${pr.repo} to ${tilde(s.path)}…`)
        : h_flex().gap(10).items_center().flex_wrap()
          .when(Boolean(found), (el) => el.child(this.button(t, "setup-found", `Use ${found}`, "folder", (cx) => this.bring(pr, cx, "pick", async () => s.found), `Add ${s.found} to your projects and ${pr.kind === "issue" ? "work" : "review"} there`, true)))
          .child(this.button(t, "setup-clone", "Clone…", "github", (cx) => this.cloneRepo(pr, cx), `Choose where to clone ${pr.repo}`))
          .child(this.button(t, "setup-folder", "Open existing folder…", "folder", (cx) => this.openFolder(pr, cx), `Choose the folder of your ${pr.repo} clone`)))
      .when(Boolean(s.error), (el) => el.child(div().text_size(13).text_color(t.blocked).child(s.error)));
  }

  // A card's heading, with an optional summary pill at its right.
  cardHead(t, title, pill) {
    return h_flex().w_full().gap(8).items_center()
      .child(div().flex_1().text_size(15).text_color(t.foreground).child(title))
      .children(pill ? [pill] : []);
  }

  summaryPill(t, text, color) {
    return h_flex().h(24).px(10).flex_none().items_center().rounded_full().bg(color ? color + "1f" : t.counter).text_size(12.5)
      .text_color(color ?? t.foreground).child(text);
  }

  // One line of the Review status card: an avatar with its verdict (or a clock while still waiting), who, and what's
  // missing or said.
  statusRow(t, id, who, words, wordsColor, face) {
    return h_flex().id(id).min_h(28).gap(10).items_center().text_size(13.5)
      .child(face ?? div().size(22).flex_none().flex().items_center().justify_center().text_color(t.muted).child(svg(ICON("clock")).size(16)))
      .child(div().text_color(t.foreground).child(who))
      .child(div().text_color(wordsColor ?? t.dim).child(words));
  }

  // Who has to approve and who did, in one section of the header card: the rule's groups first (who approved for each, or who is still
  // required), then everyone else who reviewed, commented or was asked.
  reviewStatus(t, pr, d) {
    const a = approval(pr, this.rules);
    const ruled = new Set(a ? a.need.flat() : []);
    const verdictColor = (s) => (s === "APPROVED" ? t.ansi2 : s === "CHANGES_REQUESTED" ? t.blocked : t.dim);
    const rows = [];
    if (a) a.need.forEach((g, i) => {
      if (a.met[i].length) for (const l of a.met[i]) rows.push(this.statusRow(t, `need-${i}-${l}`, l, "Approved", t.ansi2, this.avatar(t, l, 22, "APPROVED", t.background)));
      else {
        const asked = g.find((l) => pr.reviewers.some((r) => r.login === l && r.state === "CHANGES_REQUESTED"));
        rows.push(asked
          ? this.statusRow(t, `need-${i}`, asked, "Requested changes", t.blocked, this.avatar(t, asked, 22, "CHANGES_REQUESTED", t.background))
          : this.statusRow(t, `need-${i}`, or(g), g.length === 1 ? "Required" : "One approval required"));
      }
    });
    for (const r of pr.reviewers) if (!ruled.has(r.login) || (a && r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED"))
      rows.push(this.statusRow(t, `rv-${r.login}`, r.login, { APPROVED: "Approved", CHANGES_REQUESTED: "Requested changes", COMMENTED: "Commented" }[r.state] ?? r.state.toLowerCase(),
        verdictColor(r.state), this.avatar(t, r.login, 22, r.state, t.background)));
    for (const l of pr.requested) if (!ruled.has(l) || !a)
      rows.push(this.statusRow(t, `rq-${l}`, l === this.data.me ? "you" : l, "Review requested", t.working, this.avatar(t, l, 22, "WAIT", t.background)));
    const approved = pr.reviewers.filter((r) => r.state === "APPROVED").length;
    const pill = a ? this.summaryPill(t, `${a.n} of ${a.of}`, a.level === "full" ? t.ansi2 : null)
      : approved ? this.summaryPill(t, `${approved} ${approved === 1 ? "approval" : "approvals"}`, t.ansi2) : null;
    // On your own pull request, requested changes can go to Claude in its worktree.
    const asked = this.isMine(pr) && pr.reviewers.some((r) => r.state === "CHANGES_REQUESTED");
    return v_flex().id("review-status").w_full().min_w(0).gap(10)
      .child(this.cardHead(t, "Review status", pill))
      .children(rows.length ? rows : [div().text_size(13.5).text_color(t.dim).child("No reviews yet.")])
      .when(asked, (el) => el.child(h_flex().pt(2).child(this.claudeButton(t, pr, "address", "Address with Claude", () => this.addressTask(pr, d),
        "Send the requested changes to Claude Code in this branch's worktree"))));
  }

  // The checks, when the pull request has any (the list knows its overall state, so the section and its label are
  // there at once): the ones failing or still running by name, the passed and skipped ones counted. Until they load, one
  // row holds their place, the height an "All 6 passed" row takes.
  checksCard(t, pr, d) {
    if (!pr.ci) return null;
    const head = (pill) => this.cardHead(t, "Checks", pill);
    const overall = FAILED.includes(pr.ci) ? this.summaryPill(t, "Failed", t.blocked) : pr.ci === "SUCCESS" ? this.summaryPill(t, "Passed", t.ansi2)
      : this.summaryPill(t, "Running", t.working);
    if (!d.checks) return v_flex().id("checks").w_full().min_w(0).gap(10).child(head(overall))
      .child(h_flex().id("checks-loading").min_h(24).gap(10).items_center().text_size(13.5).text_color(d.error ? t.blocked : t.dim)
        .when(!d.error, (el) => el.child(svg(ICON("spinner")).size(15).spin(900)))
        .child(d.error ? "Couldn't load the checks. Refresh to try again." : "Loading the checks…"));
    const checks = d.checks;
    const quiet = ["SKIPPED", "NEUTRAL"];
    const passed = checks.filter((c) => c.state === "SUCCESS").length, skipped = checks.filter((c) => quiet.includes(c.state)).length;
    const failed = checks.filter((c) => FAILED.includes(c.state)).length;
    const other = checks.filter((c) => c.state !== "SUCCESS" && !quiet.includes(c.state));
    const counted = [passed && (other.length ? `and ${passed} passed` : passed === 1 ? "1 passed" : `All ${passed} passed`), skipped && `${skipped} skipped`].filter(Boolean).join(", ");
    const pill = failed ? this.summaryPill(t, `${failed} failed`, t.blocked) : other.length ? this.summaryPill(t, `${other.length} running`, t.working)
      : this.summaryPill(t, "Passed", t.ansi2);
    return v_flex().id("checks").w_full().min_w(0).gap(10)
      .child(head(pill))
      .children(other.map((c, i) => h_flex().id(`check-${i}`).min_h(24).gap(10).items_center().text_size(13.5)
        .children([this.ci(t, c.state, 15)].filter(Boolean))
        .child(div().text_color(t.foreground).child(c.name))
        .child(div().text_color(t.dim).child(String(c.state).toLowerCase().replace(/_/g, " ")))))
      .when(Boolean(counted), (el) => el.child(h_flex().id("check-passed").min_h(24).gap(10).items_center().text_size(13.5)
        .children([this.ci(t, passed ? "SUCCESS" : "SKIPPED", 15)].filter(Boolean))
        .child(div().text_color(t.foreground).child(counted))))
      // On your own pull request, failing checks can go to Claude in its worktree.
      .when(failed > 0 && this.isMine(pr), (el) => el.child(h_flex().pt(2).child(this.claudeButton(t, pr, "fix", "Fix with Claude", () => this.fixTask(pr, d),
        "Ask Claude Code in this branch's worktree to find out why the checks fail and fix it"))));
  }

  event(t, e, i) {
    const tone = e.state === "APPROVED" ? t.ansi2 : e.state === "CHANGES_REQUESTED" ? t.blocked : null;
    const words = e.kind === "review" ? (e.state === "COMMENTED" ? "reviewed" : VERDICT[e.state]?.words ?? "reviewed") : "commented";
    const mono = settings().font ?? "JetBrains Mono";
    const md = (id, text) => div().max_h(260).overflow_hidden().text_size(13).text_color(t.foreground).child(markdown(id, text));
    const box = v_flex().flex_1().min_w(0).rounded(6).border(1).border_color(tone ? tone + "66" : t.border).overflow_hidden()
      .child(h_flex().h(34).px(12).gap(6).items_center().text_size(12.5).bg(e.state === "APPROVED" ? t.greenBg : e.state === "CHANGES_REQUESTED" ? t.redBg : t.chrome)
        .when(Boolean(e.body || e.inline.length), (el) => el.border_b(1).border_color(tone ? tone + "40" : t.border))
        .child(div().text_color(t.foreground).child(e.login))
        .child(div().text_color(tone ?? t.muted).child(words))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(`${ago(e.at)} ago`)))
      .when(Boolean(e.body), (el) => el.child(div().px(12).py(10).child(md(`md-${i}`, e.body))))
      .children(e.inline.map((c, j) => v_flex().id(`inline-${i}-${j}`).px(12).py(8).gap(4).border_t(1).border_color(t.border)
        .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted).font_family(mono)
          .child(svg(ICON("file")).size(12).flex_none()).child(div().min_w(0).truncate().child(`${c.path}${c.line ? `:${c.line}` : ""}`)))
        .child(md(`md-${i}-${j}`, c.body))))
      .when(e.more > 0, (el) => el.child(div().px(12).py(6).border_t(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(`and ${e.more} more on files`)));
    return h_flex().id(`ev-${i}`).w_full().min_w(0).gap(12).items_start()
      .child(this.avatar(t, e.login, 28, e.kind === "review" ? e.state : null, t.background))
      .child(box);
  }

  // Copies the pull request's branch name; its button shows a check for a moment.
  copyBranch(pr, cx) {
    cx.write_to_clipboard(pr.headRefName);
    this.copied = pr.url;
    cx.notify();
    this.copyTick?.cancel();
    this.copyTick = cx.timer.after(1500, (cx) => { this.copied = null; cx.notify(); });
  }

  detail(t) {
    const pr = this.all().find((p) => p.url === this.sel);
    if (!pr) return v_flex().flex_1().min_w(0).p(28).text_size(13).text_color(t.dim)
      .child(this.data && !this.all().length ? "No open pull requests to show." : this.data ? "Select a pull request." : "");
    const d = this.details.get(pr.url) ?? {};
    const isHidden = hidden().has(pr.url);
    const busy = this.busy[pr.url], error = this.errors[pr.url], warning = this.warnings[pr.url], setup = this.setup[pr.repo.toLowerCase()];

    // The header, as GitHub's: the repo and age with Hide at the right; the title and number; the state and who wants to merge what;
    // a line; approvals, files and lines in one row; a line; the review status and the checks; then Review locally.
    // GitHub's state label: white on green while open, white on grey as a draft.
    const state = bold(h_flex()).h(32).px(12).gap(4).mr(4).flex_none().items_center().rounded_full().text_size(14)
      .bg(pr.isDraft ? t.muted : t.solid).text_color("#ffffff")
      .child(svg(ICON(pr.isDraft ? "git-pull-request-draft" : "git-pull-request-arrow")).size(16)).child(pr.isDraft ? "Draft" : "Open");
    const branch = (name) => div().h(22).px(6).flex_none().flex().items_center().rounded(6).bg(t.selected).text_color(t.accent)
      .font_family(settings().font ?? "JetBrains Mono").text_size(12).child(name);
    const commits = pr.allCommits.totalCount;
    const copied = this.copied === pr.url;
    const copy = h_flex().id("copy-branch").size(28).ml(2).flex_none().items_center().justify_center().rounded(6).text_color(copied ? t.ansi2 : t.muted)
      .hover((s) => s.bg(t.hover)).role("button").accessibility_label("Copy the branch name").tooltip(copied ? "Copied" : "Copy the branch name")
      .on_click((_e, cx) => this.copyBranch(pr, cx))
      .child(svg(ICON(copied ? "check" : "copy")).size(16));
    const a = approval(pr, this.rules);
    const approvedCount = pr.reviewers.filter((r) => r.state === "APPROVED").length;
    const changes = pr.reviewers.some((r) => r.state === "CHANGES_REQUESTED");
    const [approvalText, approvalColor] = changes ? ["Changes requested", t.blocked]
      : a ? [`${a.n}/${a.of} approvals`, a.level === "full" ? t.ansi2 : t.foreground]
      : [approvedCount ? `${approvedCount} ${approvedCount === 1 ? "approval" : "approvals"}` : "No approvals", approvedCount ? t.ansi2 : t.foreground];
    const header = v_flex().id("header").w_full().min_w(0)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(t.muted).child(`${pr.repo} · ${ago(pr.createdAt)} ago`))
        .child(this.button(t, "hide", isHidden ? "Show again" : "Hide", isHidden ? "chevron-down" : "eye-off", (cx) => { this.hide(pr, !isHidden); cx.notify(); }, isHidden ? "Show it in the list again" : "Hide it from the list until it closes")))
      .child(this.titleRow(t, pr))
      .child(h_flex().mt(8).gap_x(4).gap_y(6).items_center().flex_wrap().text_size(14).text_color(t.muted)
        .child(state)
        .child(bold(div()).child(pr.author))
        .child(div().child(`wants to merge ${commits} ${commits === 1 ? "commit" : "commits"} into`))
        .child(branch(pr.baseRefName))
        .child(div().child("from"))
        .child(branch(`${pr.headRefName}${pr.isCrossRepository ? " (fork)" : ""}`))
        .child(copy))
      .child(div().mt(18).h(1).w_full().bg(t.rule))
      .child(h_flex().mt(16).gap(18).items_center().text_size(14)
        .child(h_flex().gap(6).items_center().text_color(approvalColor).child(svg(ICON(changes ? "x" : "circle-check")).size(16)).child(approvalText))
        .child(h_flex().gap(6).items_center().text_color(t.foreground).child(svg(ICON("files")).size(15).text_color(t.muted))
          .child(`${pr.changedFiles} ${pr.changedFiles === 1 ? "file" : "files"}`))
        .child(div().text_color(t.ansi2).child(`+${thousands(pr.additions)}`))
        .child(div().text_color(t.blocked).child(`−${thousands(pr.deletions)}`)))
      .child(div().mt(18).h(1).w_full().bg(t.rule))
      .child(div().mt(16).child(this.reviewStatus(t, pr, d)))
      .children(pr.ci ? [div().mt(18).child(this.checksCard(t, pr, d))] : [])
      .child(h_flex().mt(20).gap(10).items_center()
        // A fixed width, so "Checking out…" doesn't change its size.
        .child(this.button(t, "check-out", setup?.busy === "clone" ? "Cloning…" : busy ? "Checking out…" : "Review locally", "git-pull-request", (cx) => this.checkOut(pr, cx), "Check it out in a worktree and open a Review tab", true).min_w(176).justify_center()))
      .when(Boolean(setup), (el) => el.child(this.setupCard(t, pr, setup)))
      .when(Boolean(error), (el) => el.child(div().mt(10).text_size(13).text_color(t.blocked).child(error)))
      .when(Boolean(warning), (el) => el.child(div().mt(10).text_size(13).text_color(t.working).child(`Couldn't update your checkout. ${warning.why} ${warning.next}`)))
      .when(Boolean(this.claudeErrors[pr.url]), (el) => el.child(div().mt(10).text_size(13).text_color(t.blocked).child(this.claudeErrors[pr.url])));

    return this.page(t, pr, v_flex().w_full().max_w(900).px(24).pt(20).pb(40).gap(14)
      .child(header)
      .children(this.conversation(t, pr, d, "No comments or reviews yet.")));
  }

  // The title opens the pull request or issue on GitHub, its external-link icon at its end saying so. Its words are laid
  // out one by one, so a long title wraps with the number and the icon following its last word.
  titleRow(t, item) {
    return h_flex().id("title").mt(8).gap_x(8).items_center().flex_wrap().cursor_pointer().text_size(32).line_height("40px").text_color(t.foreground).hover((s) => s.text_color(t.accent))
      .role("link").accessibility_label(`${item.title}, open on GitHub`).tooltip("Open on GitHub").on_click(() => open(item.url))
      .children(item.title.split(/\s+/).filter(Boolean).map((word) => div().child(word)))
      .child(div().text_color(t.muted).child(`#${item.number}`))
      .child(svg(ICON("external-link")).size(18).flex_none().text_color(t.dim));
  }

  // A line, then the Conversation heading with its count and the comments, newest first: the last 20, the rest a link.
  conversation(t, item, d, none) {
    const events = d.events ?? [];
    const rows = d.error ? [div().text_size(13).text_color(t.blocked).child(d.error)]
      : !d.events ? [h_flex().gap(6).items_center().text_size(13).text_color(t.dim).child(svg(ICON("spinner")).size(12).spin(900)).child("Loading the conversation…")]
      : !events.length ? [div().text_size(13).text_color(t.muted).child(none)]
      : [...events.slice(0, 20).map((e, i) => this.event(t, e, i)),
        ...(events.length > 20 ? [h_flex().id("older").gap(6).items_center().text_size(13).text_color(t.accent).cursor_pointer()
          .on_click(() => open(item.url)).child(svg(ICON("external-link")).size(13)).child(`${events.length - 20} older on GitHub`)] : [])];
    return [
      div().mt(10).h(1).w_full().bg(t.border),
      h_flex().mt(10).gap(8).items_center().text_size(15).text_color(t.foreground)
        .child("Conversation")
        .when(Boolean(d.events), (el) => el.child(h_flex().h(20).min_w(20).px(6).rounded_full().bg(t.counter).items_center().justify_center().text_size(12).child(String(events.length)))),
      v_flex().gap(14).children(rows),
    ];
  }

  // The detail's scrolling page, with the always-visible scrollbar.
  page(t, item, body) {
    return div().relative().flex_1().min_w(0).h_full()
      .child(v_flex().id(`detail-${item.url}`).size_full().overflow_y_scroll().child(body))
      .child(div().absolute().top(0).bottom(0).right(0).w(10).child(Scrollbar.vertical(`detail-${item.url}`).size_full().mode("always")));
  }

  // Under the branch box: the branch it names is already here, the issue's own branch is (click to use it), or a new one
  // starts off origin's default branch. One line, always there, so nothing under it moves.
  branchHint(t, it) {
    const found = this.found[it.url], branch = this.branchOf(it);
    const line = h_flex().id("branch-hint").mt(8).h(20).gap(6).items_center().text_size(13).text_color(t.muted);
    if (found?.branches.includes(branch)) return line.child(svg(ICON("git-branch")).size(14).flex_none()).child("This branch is already here. Start work opens its worktree.");
    if (found?.branches.length) return line.child(svg(ICON("git-branch")).size(14).flex_none())
      .child(div().child("Its branch"))
      .child(div().font_family(settings().font ?? "JetBrains Mono").text_size(12).text_color(t.foreground).child(found.branches[0]))
      .child(div().child("is already here."))
      .child(div().id("use-found").text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground)).role("button").accessibility_label(`Use ${found.branches[0]}`)
        .on_click((_e, cx) => { delete this.names[it.url]; this.branchInput.set_value(found.branches[0]); cx.notify(); }).child("Use it"));
    return line.child(svg(ICON("git-branch")).size(14).flex_none()).child(`A new branch off the latest ${found?.base ? `origin/${found.base}` : "default branch"}.`);
  }

  // The issue, headed as GitHub heads one: the repo and its board with Open board at the right; the title and number; its
  // state, author, column, labels and who it's assigned to; a line; the branch box and Start work; its description; then
  // the conversation.
  issueDetail(t) {
    const it = this.issue();
    if (!it) return v_flex().flex_1().min_w(0).p(28).text_size(13).text_color(t.dim)
      .child(this.issueList && !this.issueList.length ? "No issues to show." : this.issueList ? "Select an issue." : "");
    const d = this.details.get(it.url) ?? {};
    const busy = this.busy[it.url], error = this.errors[it.url], setup = this.setup[it.repo.toLowerCase()];
    const state = bold(h_flex()).h(32).px(12).gap(4).mr(4).flex_none().items_center().rounded_full().text_size(14).bg(t.solid).text_color("#ffffff")
      .child(svg(ICON("circle-dot")).size(16)).child("Open");
    const mine = it.assignees.length > 0, itsPr = this.prFor(it);
    const header = v_flex().id("header").w_full().min_w(0)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(t.muted).child(`${it.repo} · ${it.board}`))
        .child(this.button(t, "board", "Open board", "external-link", () => open(it.boardUrl), `Open the ${it.board} board on GitHub`)))
      .child(this.titleRow(t, it))
      .child(h_flex().mt(8).gap_x(4).gap_y(6).items_center().flex_wrap().text_size(14).text_color(t.muted)
        .child(state)
        .child(bold(div()).child(it.author))
        .child(div().child(`opened this ${ago(it.createdAt)} ago`))
        .children(it.labels.map((l) => div().ml(4).child(this.label(t, l)))))
      .child(div().mt(18).h(1).w_full().bg(t.rule))
      // Who it's assigned to and where its card is, each with the button that changes it when there's something to change.
      .child(h_flex().id("assignee").mt(16).h(28).gap(8).items_center().text_size(14).text_color(t.foreground)
        .child(mine ? this.avatar(t, it.assignees[0], 22, null, t.background) : div().size(22).flex_none().flex().items_center().justify_center().text_color(t.muted).child(svg(ICON("circle-dot")).size(16)))
        .child(div().child(mine ? "Assigned to you" : "No one is assigned"))
        .when(!mine, (el) => el.child(this.smallButton(t, "assign-me", this.boardBusy[it.url] === "assign" ? "Assigning…" : "Assign me", 104, (cx) => this.boardAction(it, "assign", cx), "Assign this issue to you"))))
      .child(h_flex().id("column").mt(8).h(28).gap(8).items_center().text_size(14).text_color(t.foreground)
        .child(div().size(22).flex_none().flex().items_center().justify_center().text_color(t.muted).child(svg(ICON("layout-grid")).size(15)))
        .child(div().child(`${it.column} on ${it.board}`))
        .when(it.column !== "In Progress" && Boolean(it.inProgress), (el) => el.child(this.smallButton(t, "move-in-progress", this.boardBusy[it.url] === "move" ? "Moving…" : "Move to In Progress", 168,
          (cx) => this.boardAction(it, "move", cx), `Move its card on ${it.board} to In Progress`))))
      .when(Boolean(this.warnings[it.url]), (el) => el.child(div().mt(10).text_size(13).text_color(t.working).child(this.warnings[it.url])))
      .children(itsPr ? [h_flex().id("its-pr").mt(8).h(28).gap(8).items_center().text_size(14).text_color(t.foreground)
        .child(div().size(22).flex_none().flex().items_center().justify_center().text_color(itsPr.isDraft ? t.dim : t.ansi2).child(svg(ICON(itsPr.isDraft ? "git-pull-request-draft" : "git-pull-request")).size(15)))
        .child(div().min_w(0).truncate().child(`${itsPr.isDraft ? "Draft pull request" : "Pull request"} #${itsPr.number}`))
        .child(this.smallButton(t, "show-pr", "Show", 70, (cx) => this.showPr(itsPr, cx), `Show #${itsPr.number}: ${itsPr.title}`))] : [])
      .child(div().mt(18).h(1).w_full().bg(t.rule))
      .child(div().mt(16).text_size(15).text_color(t.foreground).child("Branch"))
      .child(h_flex().mt(10).gap(10).items_center()
        .child(Input.new(this.branchInput).flex_1().max_w(460).h(34).px(10).items_center().rounded(6).border(1)
          .border_color(this.typing ? t.accent : t.border).bg(t.background).text_color(t.foreground)
          .font_family(settings().font ?? "JetBrains Mono").text_size(13))
        // Fixed widths, so "Starting…" doesn't change their size.
        .child(this.button(t, "start-work", setup?.busy === "clone" && !setup.agent ? "Cloning…" : busy === "work" ? "Starting…" : "Start work", "git-branch",
          (cx) => this.checkOut(it, cx), "Open a worktree on this branch", true).min_w(150).justify_center())
        .child(this.button(t, "start-claude", setup?.busy === "clone" && setup.agent ? "Cloning…" : busy === "agent" ? "Starting…" : "Start with Claude Code",
          image(ICON("claude")).size(15), (cx) => this.checkOut(it, cx, true), "Start work, then open Claude Code on this issue").min_w(214).justify_center()))
      .child(this.branchHint(t, it))
      .when(Boolean(setup), (el) => el.child(this.setupCard(t, it, setup)))
      .when(Boolean(error), (el) => el.child(div().mt(10).text_size(13).text_color(t.blocked).child(error)))
      .child(div().mt(20).h(1).w_full().bg(t.rule))
      .child(div().mt(16).text_size(13.5).text_color(it.body?.trim() ? t.foreground : t.muted)
        .child(it.body?.trim() ? markdown(`body-${it.url}`, it.body.trim()) : "No description."));
    return this.page(t, it, v_flex().w_full().max_w(900).px(24).pt(20).pb(40).gap(14)
      .child(header)
      .children(this.conversation(t, it, d, "No comments yet.")));
  }

  render(cx) {
    const t = palette();
    this.markSeen();
    // Opening the view on the Issues tab asks for them again once they're stale; render itself can't start a redraw.
    const shown = find(layout(), "view")?.active === "prs";
    if (shown && !this.shown && this.mode === "issues") cx.timer.after(0, (cx) => this.issuesIfStale(cx));
    this.shown = shown;
    // A key picked the other tab.
    const want = savedMode();
    if (want !== this.mode) cx.timer.after(0, (cx) => this.setMode(want, cx));
    // Dragging the list's right edge sets its width.
    const edge = div().id("list-edge").w(5).ml(-3).h_full().flex_none().cursor_col_resize().hover((s) => s.bg(t.accent + "55"))
      .when(Boolean(this.drag), (el) => el.bg(t.accent + "55"))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.drag = { x: e.position.x, width: this.listWidth }; cx.notify(); });
    return h_flex().id("metro-prs-root").size_full().min_h(0).bg(t.background).border_t(1).border_color(t.border)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        this.listWidth = Math.round(Math.min(LIST_MAX, Math.max(LIST_MIN, this.drag.width + e.position.x - this.drag.x)));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (!this.drag) return;
        this.drag = null;
        try { localStorage.setItem("listWidth", JSON.stringify(this.listWidth)); } catch {}
        cx.notify();
      })
      .child(this.list(t))
      .child(edge)
      .child(this.mode === "issues" ? this.issueDetail(t) : this.detail(t));
  }
}
