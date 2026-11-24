import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, exec, panes, props, run, spaces, theme } from "herdr";

export default class Cleanup extends View {
  init(_props, cx) {
    this.focus = cx.focus_handle();
    this.focus.focus();
    this.items = (props()?.items ?? []).map((item) => ({ ...item }));
    this.phase = "checking";
    cx.spawn(async (cx) => {
      for (const item of this.items) item.reason = await this.reason(item);
      this.phase = "ready";
      cx.notify();
    });
  }

  async cleanupReason(item) {
    const { folder, branch, main, head } = item;
    const git = async (args) => {
      const r = await exec("git", args, { cwd: main });
      if (r.code !== 0) throw new Error(r.stderr.trim() || "Git check failed");
      return r.stdout;
    };
    const records = (await git(["worktree", "list", "--porcelain", "-z"])).split("\0\0");
    const record = records.slice(1).map((r) => r.split("\0")).find((r) => r[0] === "worktree " + folder);
    if (!record) return "Checkout unavailable";
    if (record.some((line) => /^locked(?: |$)/.test(line))) return "Locked";
    if (!head || !record.includes("HEAD " + head) || !record.includes("branch refs/heads/" + branch)) return "Branch or commit differs from merged PR";
    const status = await git(["-C", folder, "status", "--porcelain=v1", "--no-renames", "-z", "--ignored", "--untracked-files=normal", "--ignore-submodules=none"]);
    const entries = status.split("\0").filter(Boolean);
    item.changes = entries.filter((entry) => !entry.startsWith("!! ")).map((entry) => entry.slice(3));
    item.ignored = entries.filter((entry) => entry.startsWith("!! ")).map((entry) => entry.slice(3));
    if (item.changes.length && (await git(["-C", folder, "submodule", "status"])).trim()) return "Contains submodules requiring separate removal";
    return "";
  }

  async reason(item) {
    try {
      const reason = await this.cleanupReason(item);
      if (reason) return reason;
      const inside = (cwd) => cwd === item.folder || cwd?.startsWith(item.folder + "/");
      const ps = panes();
      for (const space of spaces().filter((s) => !s.machine)) {
        const tabs = new Set(space.tabs.map((t) => t.id));
        const here = ps.filter((p) => tabs.has(p.tab) && p.cwd);
        const listed = item.spaces.includes(space.id);
        if (!listed && here.some((p) => inside(p.cwd))) return "Another space is using this checkout";
        if (listed && here.some((p) => !inside(p.cwd))) return "Space also has terminals outside this checkout";
        if (listed && !here.length && !inside(space.folder)) return "Space location changed";
      }
      return "";
    } catch (e) { return String(e.message ?? e); }
  }

  close() {
    if (this.phase !== "removing") closeOverlay(props().overlay);
  }

  confirm(cx) {
    const batch = this.items.filter((i) => !i.reason);
    if (this.phase !== "ready" || !batch.length) return;
    this.phase = "removing";
    cx.notify();
    cx.spawn(async (cx) => {
      for (const item of batch) {
        try {
          const reviewed = new Set([...item.changes, ...item.ignored]);
          item.reason = await this.reason(item);
          if (!item.reason && [...item.changes, ...item.ignored].some((path) => !reviewed.has(path))) {
            item.reason = "New local changes appeared after review";
          }
          if (item.reason) continue;
          const result = await exec("git", ["worktree", "remove", ...(item.changes.length ? ["--force"] : []), "--", item.folder], { cwd: item.main });
          if (result.code !== 0) { item.reason = result.stderr.trim() || "Git could not remove this checkout"; continue; }
          item.removed = true;
          for (const id of item.spaces) {
            if (spaces().some((s) => s.id === id)) run("space.close", { id, confirmed: true });
          }
        } catch (e) { item.reason = String(e.message ?? e); }
      }
      this.phase = "done";
      run("layout.select", { stack: "view", child: "overview" });
      if (this.items.every((i) => i.removed && !i.reason)) this.close();
      else cx.notify();
    });
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

  key(e, cx) {
    if (e.key === "escape") this.close();
    else if (e.key === "enter") {
      if (this.phase === "done") this.close();
      else this.confirm(cx);
    } else return;
    cx.stop_propagation();
  }

  description(item) {
    if (item.removed) return item.reason ? "Removed · " + item.reason : "Removed";
    if (item.reason) return "Will be kept · " + item.reason;
    if (this.phase === "checking") return item.folder;
    const lines = ["Will be removed"];
    if (item.changes.length) lines.push("Uncommitted changes will be discarded: " + item.changes.join(", "));
    if (item.ignored.length) lines.push("Ignored files will be deleted: " + item.ignored.join(", "));
    return lines.join("\n");
  }

  render() {
    const t = theme();
    const ready = this.phase === "ready";
    const count = this.items.filter((i) => !i.reason).length;
    return h_flex().id("cleanup").size_full().items_center().justify_center().track_focus(this.focus)
      .on_key_down((e, cx) => this.key(e, cx)).on_mouse_down("left", () => this.close())
      .child(v_flex().id("cleanup-card").w(480).max_h(500).px(24).pt(22).pb(20).gap(14).rounded(10)
        .bg(t.popover).border(1).border_color(t.border).shadow_lg().text_size(14)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().flex_none().gap(12).items_center()
          .child(div().size(34).flex_none().rounded_full().bg(t.blocked + "1f").flex().items_center().justify_center()
            .child(svg("mods/metro-chrome/icons/trash.svg").size(17).text_color(t.blocked)))
          .child(div().text_size(17).text_color(t.foreground).child("Remove merged worktrees?")))
        .child(div().text_size(13).text_color(t.muted).child(this.phase === "checking" ? "Checking worktrees…" :
          this.phase === "removing" ? "Removing worktrees…" : this.phase === "done" ? "Cleanup complete" :
          "Removal closes the selected worktrees’ open spaces and terminals. Local branches are kept."))
        .child(v_flex().id("cleanup-items").min_h(0).overflow_y_scroll().gap(6)
          .children(this.items.map((i) => v_flex().gap(2).child(div().text_size(14).child(i.label))
            .child(div().text_size(12).text_color(t.muted).child(this.description(i))))))
        .child(h_flex().mt(6).flex_none().items_center().justify_end().gap(8)
          .when(this.phase !== "removing", (el) => el.child(this.phase === "done"
            ? this.keyButton(t, "done", "Done", "↵", () => this.close(), t.solid, t.solid_foreground)
            : this.keyButton(t, "cancel", "Cancel", "esc", () => this.close())))
          .when(ready && count > 0, (el) => el.child(this.keyButton(t, "remove-all", "Remove " + count + (count === 1 ? " worktree" : " worktrees"), "↵",
            (cx) => this.confirm(cx), t.blocked, "#ffffff")))));
  }
}
