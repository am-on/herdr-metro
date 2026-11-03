# metro

A quiet, light layout for running many coding agents at once. The sidebar sorts every agent by what it needs from you and draws each project's checkouts on a colored line with a stop per worktree, like a metro map. The tab bar knows the branch's GitHub state, a full-tab review sends diff comments to an agent, and the status bar paces the week's Claude and Codex usage.

![metro](preview.png)

This file is the brief: enough to build metro from an empty folder. The files next to it are one build of it. If they don't work on your Herdr, or you want it different, build it again from here.

## What you see

No system title bar. A 268px sidebar on the left runs the window's full height; the work column fills the rest. Everything is drawn in the person's own theme colors (the screenshots use `paper`); text in the UI font at 11–13px.

**The sidebar** (`chrome` background), top to bottom:

1. **Brand bar**, 36px: room for the macOS window buttons, then Settings (a dot when an update is ready) and a sidebar toggle on the right. Dragging it moves the window.
2. **Agents**, the top half. No heading. Sections titled in 11px capitals, each in its status color: Needs you (red), Done (blue), Check again (blue), Working (green), Idle (muted). Under each title, agents are grouped under their project: the project's 18px colored avatar (its initial) and name, then the agents on a 2px rail in the project's color. An agent row is two lines: the agent's logo with its state as a badge, the task (the tab's name), then the branch, dim, with the same marks at its right as its checkout's row under Projects when the agent is on that checkout's branch. The agent on screen is a white card (`background`, 1px `border`).
3. **Projects**, the bottom half, under a "PROJECTS" heading in 11px capitals with a + on the right. Each git repo is a project: its avatar and name, then its checkouts on the rail. A checkout row is two lines: a status mark and its name ("Main" for the main checkout, else the worktree's folder name), then its branch and, at the right, what isn't on origin: ↑ for commits on no remote (a branch never pushed counts too; not a fork's PR, `pr/<n>`, nor a branch whose upstream was deleted after merging; "3 commits not pushed" in its tooltip) and ↓ for commits to pull from its upstream, both in the text's grey (`muted`); when it's both because the branch was amended or rebased since its push (its upstream's tip is in the branch's reflog), only the ↑, its tooltip saying to force-push; then its uncommitted lines (`+41` green, `−13` red; untracked files count every line, as in a review of Uncommitted; nothing when clean). Checkouts with nothing open are listed too, without a mark, under the open ones. Spaces outside any repo are grouped under their folder as a project. Projects with nothing open, kept by a pin, sit dimmed below the open ones.

Both lists have an always-visible 10px scrollbar. Rows keep a transparent 1px border so nothing moves on hover; a hovered row becomes a white card with a mid-grey (`dim`) outline.

**The work column**, top to bottom:

1. **Tab bar**, 36px. Flat tabs 180px wide: the agent's logo with its state badge, the tab's name, a dark underline under the active one, × on hover. A + after the last tab opens a menu: Terminal, Claude Code, Codex, Review changes. On the right, for the focused checkout: how many commits it is behind `origin`'s default branch (amber), its pull request number colored by state (open green, draft grey, merged purple, closed red) with ✓ approved, ✕ changes requested or a speech bubble for comments, the issue named in the branch (`fix/312-…`) or else the repo's Issues link, then a refresh button.
2. **The tab's panes**, edge to edge with square corners and 8px between panes. Every pane, even a lone one, has a 28px header: its icon (with the state badge), and for a terminal alone in its tab only what the tab doesn't say: its folder (`~/src/express`) and branch. Split, zoom and close buttons appear on hover. A stack lets the same area show one agent full size instead (the agent view).
3. **Status bar**, 36px, under the work column only: Claude and Codex usage on the left, clocks on the right (440px).

## How it behaves

Agent states, the same everywhere a logo appears (tabs, agents list, pane headers): a 12px notch cut into the row's background at the logo's bottom-right corner holds

| State | Badge |
| --- | --- |
| working | a green dot (`ansi2`) whose halo breathes 6↔12px every 1.8s |
| blocked (needs you) | a red dot |
| done (finished while you weren't looking) | a blue dot |
| idle | a grey ring |
| Check again | a blue bookmark |

Project and checkout rows have no logo, so they use full-size marks in a 14px column 6px before the name: a 6px dot with a 6↔14px halo for working, a red "!" tile for blocked, a blue dot for done, a grey ring for idle, the bookmark for Check again. No agents, no mark.

- **Check again**: click a done or idle agent's badge (or the bookmark shown on hover) to mark it; it moves to the Check again section with a bookmark until it works again or you click the bookmark. It is the terminal label `metro.check=1`, so it survives restarts.
- **Agents list**: click a row to show that agent. Hover shows a pin (pinned agents get their own section first) and an × that closes the agent's pane. Idle shows its first five; a section's count, ringed, appears only past five or when folded. Agent order follows the list (`setAgentOrder`), so next/previous agent keys walk it top to bottom.
- **Projects**: click a checkout to open or show its space. Hover a project for: fold, pin (keep it listed when nothing is open), + (new worktree, or a new space for a folder project), × (close its spaces; Herdr asks). Hover a space for its own ×. Double-click a project's name to rename it; drag projects to reorder them; click the avatar for a nine-color picker.
- **New worktree** is a picker: the repo's open pull requests (`gh pr list`), then its local and remote branches, newest first, filtered as you type (title, branch, author, `#330`, a PR URL), then "Create <name>". A branch already checked out jumps to its space; a fork's PR becomes `pr/<n>`.
- **Tab bar**: the behind count, PR and issue each open on GitHub; GitHub state refreshes every three minutes and with the refresh button (which spins, and turns red with a tooltip when `origin` can't be fetched). cmd-shift-a switches to the agent view; a stacked icon in the tab bar leads back.
- **Review** (+ → Review changes) is a full tab laid out as GitHub's unified diff: file list on the left, old and new line numbers, changed words highlighted, long lines wrapped. Its pane header is its toolbar: Uncommitted, Last commit or Branch (against the merge-base with `origin`'s default branch), and Refresh. Click a line, shift-click a range or click a hunk's `@@` header to comment; comments are drafts shared by every review of that repo until sent, and each follows its line as the file changes. With comments, the footer lists the agents in that space, then New Claude Code and New Codex: clicking one sends them all at once, pasted into the agent or as a new agent's first message.
- **Usage** shows each provider's weekly limit against today's share of it, the week split evenly over its workdays (20% by Monday night, 40% by Tuesday …): "x% left" (amber under 3%) or "x% over" (red). Click for details.
- **Clocks** show each configured place's time with a green dot during working hours (a grey ring otherwise) and, on a meeting's day, a countdown to it (amber in its last 15 minutes).

## Built from

- **The layout** (`layouts/metro.json`): a root `row` with `"titlebar": "none"`, `"traffic_lights": [16, 11]`, `terminal_padding: [8, 0]`, a 1px `border` divider and no theme of its own. Children:
  - `sidebar`, a `column` (268px, min 180, max 480, `chrome`, not resizable): `brand` (block, 36px, `metro-chrome`, `window_drag`), then `lists`, a `column` with a 1px divider: `agents` (`metro-agents`) and `spaces` (`metro-spaces`), equal weights, min 90 each.
  - `work`, a `column`: `tabs` (block, 36px, `metro-tabs`, `window_drag`); `work-body`, a `row` holding `view`, a `stack` of `main` (`{ tab: "active", pane: { header: { content: { mod: "metro-pane" }, reveal: "always", height: 28 }, radius: 0, gap: 8, lone: true, border and focus 2px in background } }`) and `agent` (`{ agent: "focused" }`); then `status`, a 36px `row` of `metro-usage` and a 440px `metro-clocks`.
- **Mods** (`mods/metro-*`): `metro-chrome` (brand bar; also holds every icon the others use, in `icons/`), `metro-agents`, `metro-spaces`, `metro-space-color` (the color popup), `metro-worktree` (the picker, a dialog), `metro-tabs`, `metro-new-tab` (the + menu, a popup), `metro-pane` (pane header), `metro-review` (a mod pane opened with `tab.new { mod, props: { folder, space, machine } }`), `metro-usage`, `metro-clocks`. `name.js` (what a terminal is working on: a named tab, else a telling title, else the program) is copied into each mod that names agents.
- **Shared state**: `space.colors` (project colors by space id, a theme name or `#hex`), `projects.kept`, `projects.names`, `projects.order`, `projects.of` (which project each space is under, published by `metro-spaces` for `metro-agents`), `projects.git` (each space's branch, commits to push and pull, whether it was amended, and uncommitted lines, published by `metro-spaces` for `metro-agents` when they change), `agents.pins`, `metro-review.drafts` (by `<machine>:<repo root>`), `metro-review.<tab>` (a review's state for its header).
- **Data and commands**: `agents()`, `spaces()`, `panes()`, `terminals()` (labels), `focused()`; `agent.focus`, `space.select`, `space.new`, `space.close`, `tab.new`, `tab.close`, `pane.close`, `layout.select` (the agent view), `setAgentOrder`. A review's toolbar clicks reach it as `run("metro-review.<command>")`, read with `nextCommand()`.
- **Programs it runs**: `git` (worktrees, branches, diffs, behind counts, `fetch --prune`), `gh` (`pr view`, `pr list`, `issue view`), `hc label` (Check again), `hc send` (sending review comments).
- **Files it reads**: `~/.cache/claude-rate-limits.json` (written by a Claude Code status line command from the `rate_limits` it's given), the newest `rate_limits` line in `~/.codex/sessions/**/*.jsonl`, and `metro-clocks.json` in Herdr's folder (`{ hours, places: [{ name, winter, summer? }], meetings: [{ name, place, day, hour, minute, minutes }] }`; without it the clocks show nothing).

## Watch out

- Keep the pane header always shown (`reveal: "always"`): the review pane's header is its toolbar, and a hover header covers the terminal's first line.
- `theme().selected` and `theme().hover` are see-through; painting them on a row that already has them darkens it. Use solid `background` for the shown and hovered rows.
- A `.hover()` style can't change a border color: track the pointer with `.on_hover` and style the row from that state.
- `render` must not call `cx.notify()`; react to another mod through `run("<mod>.<command>")` and `nextCommand()`, not by watching shared state in `render`.
- A mod pane isn't told its pane or tab id. The review remembers its tab per copy in `localStorage`, claimed from the focused pane when it starts.
- A mod opened in a tab just created in another space still sees the old space as active for a moment: pass the space and folder in its props.
- `v_virtual_list` drew nothing inside a row here; the worktree picker and the review use plain scrolling columns that draw only the rows in view.
- The UI font has one weight, `toLocaleTimeString` ignores its options (format times by hand), and accessibility roles use gpui's snake_case names (`check_box`).
- Project colors need about 2.5:1 contrast against `chrome` to read on the rail; a pale yellow doesn't, whatever its outline.
- Herdr checks for installed agents with a non-login shell; give Homebrew programs a full path in `programs.json`.
- Icon paths are `mods/metro-chrome/icons/…`; renaming that mod means renaming them everywhere.

## Done when

- Every agent appears once in the agents list, in the section of its state, under its project, with the right badge; marking one Check again moves it to that section and the bookmark shows in its tab and pane header too.
- Every checkout of a repo appears under its project, open ones with their mark, closed ones dimmed, and clicking a closed one opens a space there.
- On a branch with an open pull request, the tab bar shows its number in green with the reviews' marks; on the default branch the behind count and PR are hidden.
- + → Review changes on a dirty checkout shows the diff; a comment on a line, sent to New Claude Code, opens a tab whose first message quotes that line.
- With `metro-clocks.json` naming two places, both show their time and the right dot.
- `herdr-app check` passes for every `mods/metro-*`, and `herdr-app status` shows no errors with the layout on screen.
