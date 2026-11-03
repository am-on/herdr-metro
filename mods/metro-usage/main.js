// The bottom bar: Claude's and Codex's usage limits, where they'll be at reset, and what's left per day.
// Opened with `props().detail` ("claude" or "codex") it's the popup with the full numbers instead.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, readTextFile, home, appHome, theme, openOverlay, closeOverlay, props } from "herdr";
import * as fs from "fs/promises";

const DAY = 86400000, HOUR = 3600000;
// Claude Code's status line script saves its rate_limits here; Codex logs them in its sessions.
const CLAUDE_FILE = () => `${home()}/.cache/claude-rate-limits.json`;
const CODEX_LATEST = `ls -t $(find "$HOME/.codex/sessions" -name '*.jsonl' -mtime -8 2>/dev/null) 2>/dev/null | head -20 | while read -r f; do l=$(grep '"rate_limits"' "$f" | tail -1); if [ -n "$l" ]; then printf '%s' "$l"; exit 0; fi; done`;
// A usage history: one snapshot per provider, window and day, holding that day's latest numbers.
const HISTORY = () => `${appHome()}/data/usage-history.json`;
const HISTORY_DAYS = 120;
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const STALE = 3 * HOUR;
const LABELS = { five_hour: "5h", seven_day: "week" };
const PROVIDERS = { claude: { name: "Claude" }, codex: { name: "Codex" } };

// Days from `from` to `to` that fall on Monday to Friday, counting part days.
function workdays(from, to) {
  let total = 0;
  for (let t = from; t < to;) {
    const d = new Date(t);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const end = Math.min(next, to);
    if (d.getDay() !== 0 && d.getDay() !== 6) total += end - t;
    t = end;
  }
  return total / DAY;
}

const span = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
};
const pct = (n) => (n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n))) + "%";
const epochMs = (v) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));
// "14:05" today, "Sat 22:59" on another day; formatted by hand, the runtime ignores locale options.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (ms) => {
  const d = new Date(ms), same = d.toDateString() === new Date().toDateString();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return same ? time : `${WEEKDAYS[d.getDay()]} ${time}`;
};

// { label, used, resetsAt, windowMs }; a window that has already reset counts as unused.
function windowOf(label, used, resetsAt, windowMs) {
  if (!Number.isFinite(used) || !Number.isFinite(resetsAt)) return null;
  const now = Date.now();
  if (resetsAt <= now) return { label, used: 0, resetsAt: resetsAt + windowMs * Math.ceil((now - resetsAt) / windowMs || 1), windowMs };
  return { label, used: Math.min(100, Math.max(0, used)), resetsAt, windowMs };
}

function claudeWindows(limits) {
  return Object.entries(limits ?? {}).map(([key, w]) => {
    const minutes = key === "five_hour" ? 300 : 10080;
    return windowOf(LABELS[key] ?? key.replace(/^seven_day_/, "").replace(/_/g, " "), w?.used_percentage ?? w?.utilization, epochMs(w?.resets_at), minutes * 60000);
  }).filter(Boolean);
}

function codexWindows(limits) {
  return ["primary", "secondary"].map((k) => limits?.[k]).filter(Boolean).map((w) => {
    const minutes = w.window_minutes ?? 10080;
    return windowOf(minutes >= 10080 ? "week" : minutes === 300 ? "5h" : `${Math.round(minutes / 60)}h`, w.used_percent, epochMs(w.resets_at), minutes * 60000);
  }).filter(Boolean);
}

// Where a window is heading: its burn so far, carried to the reset. The first seventh of a window is too early to say.
function pace(w) {
  const now = Date.now(), start = w.resetsAt - w.windowMs, elapsed = now - start, until = w.resetsAt - now;
  const burnPerMs = elapsed > 0 ? w.used / elapsed : 0;
  const projected = w.used + burnPerMs * until;
  const left = 100 - w.used, days = until / DAY, work = workdays(now, w.resetsAt);
  return {
    early: elapsed < w.windowMs / 7,
    burnPerDay: burnPerMs * DAY,
    projected,
    runsOutAt: projected > 100 && burnPerMs > 0 ? now + left / burnPerMs : null,
    perDay: left / Math.max(days, 1),
    perWorkday: work > 0 ? left / Math.max(work, 1) : null,
    expected: Math.min(100, (elapsed / w.windowMs) * 100),
    until,
  };
}

// A weekly limit split evenly over the window's workdays: by tonight it may be at the share of each workday so far.
// A workday is the window's when its noon falls inside, so a reset early on Monday doesn't add a sixth day.
function budget(w) {
  const start = w.resetsAt - w.windowMs, s = new Date(start), today = new Date();
  const tonight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
  const days = [];
  for (let i = 0; ; i++) {
    const noon = new Date(s.getFullYear(), s.getMonth(), s.getDate() + i, 12);
    if (noon.getTime() >= w.resetsAt) break;
    if (noon.getTime() >= start && noon.getDay() % 6 !== 0) days.push(noon.getTime());
  }
  if (!days.length) return null;
  const share = 100 / days.length, allowed = share * days.filter((n) => n < tonight).length;
  return { share, allowed, left: allowed - w.used, workday: days.some((n) => n < tonight && n >= tonight - DAY) };
}

const budgetText = (b) => b.left >= 0 ? `${pct(b.left)} left` : `${pct(-b.left)} over`;
// Over budget is red; under 3% left today is the theme's amber warning.
const budgetColor = (b, t) => (b.left < 0 ? t.blocked : b.left < 3 ? t.working : t.ansi2);

const paceColor = (p, t) => (p.early ? t.dim : p.projected > 100 ? t.blocked : p.projected > 85 ? t.working : t.ansi2);

export default class Usage extends View {
  init(_props, cx) {
    this.data = { claude: null, codex: null };
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(CLAUDE_FILE());
        const saved = text ? JSON.parse(text) : null;
        // Older saves hold the limits alone, without when they were written.
        const limits = saved?.limits ?? saved;
        this.data.claude = limits ? { windows: claudeWindows(limits), at: saved?.at ? saved.at * 1000 : null } : { missing: true };
      } catch { this.data.claude = { missing: true }; }
      try {
        const r = await exec("sh", ["-c", CODEX_LATEST]);
        const line = r.stdout.trim();
        if (!line) this.data.codex = { missing: true };
        else {
          const event = JSON.parse(line);
          const limits = event.payload?.rate_limits ?? event.payload?.info?.rate_limits ?? event.rate_limits;
          this.data.codex = { windows: codexWindows(limits), at: Date.parse(event.timestamp) || null };
        }
      } catch { this.data.codex = { missing: true }; }
      if (!props()?.detail) await this.snapshot();
      cx.notify();
    });
  }

  // Keeps each day's latest usage per window, the history a sparkline and a weekday-weighted burn will need.
  async snapshot() {
    try {
      const now = Date.now();
      let history = [];
      try { history = JSON.parse(await fs.readFile(HISTORY(), "utf-8")).filter((s) => s.day); } catch {}
      let changed = false;
      for (const [provider, d] of Object.entries(this.data)) {
        for (const w of d?.windows ?? []) {
          const at = d.at ?? now, day = dayOf(at);
          const snap = { day, at, provider, window: w.label, used: w.used, resetsAt: w.resetsAt };
          const i = history.findIndex((s) => s.provider === provider && s.window === w.label && s.day === day);
          if (i < 0) history.push(snap);
          else if (history[i].at < at) history[i] = snap;
          else continue;
          changed = true;
        }
      }
      if (!changed) return;
      history = history.filter((s) => now - s.at < HISTORY_DAYS * DAY);
      await fs.mkdir(`${appHome()}/data`, { recursive: true }).catch(() => {});
      await fs.writeFile(HISTORY(), JSON.stringify(history));
    } catch {}
  }

  // The fill is what's used; the tick is today's budget for a weekly limit, else where an even pace would be by now.
  bar(w, p, t, width) {
    const b = budget(w), mark = b ? b.allowed : p.expected;
    const over = b ? b.left < 0 : !p.early && p.projected > 100;
    const fill = w.used >= 90 ? t.blocked : over ? t.working : t.ansi2;
    return div().relative().w(width).h(6).flex_none().rounded(3).bg(t.border)
      .child(div().absolute().left(0).top(0).h(6).w(Math.max(w.used > 0 ? 3 : 0, width * w.used / 100)).rounded(3).bg(fill))
      .child(div().absolute().top(-2).h(10).w(1.5).left(width * mark / 100 - 0.75).bg(t.muted));
  }

  // The bar shows usage and what's left of today's budget, the week's usage in its tooltip (a shorter window: its usage
  // and where it's heading); the reset only when it falls mid-week, not around the weekend's turn to Monday. The popup has the rest.
  windowView(id, w, t) {
    const p = pace(w), weekly = w.windowMs >= 7 * DAY, b = weekly ? budget(w) : null;
    const unusual = !weekly || ![0, 1].includes(new Date(w.resetsAt).getDay());
    return h_flex().id(id).gap(8).items_center().flex_none()
      .when(Boolean(b), (el) => el.tooltip(`${pct(w.used)} of the week used · resets ${when(w.resetsAt)}`))
      .when(!weekly, (el) => el.child(div().text_color(t.dim).child(w.label)))
      .child(this.bar(w, p, t, 56))
      .when(!b, (el) => el.child(div().text_color(t.foreground).child(pct(w.used))))
      .child(b ? div().text_color(budgetColor(b, t)).child(budgetText(b))
        // Where it's heading at reset; dim during the window's first day, when it's only a rough guess.
        : div().text_color(paceColor(p, t)).child(`→ ~${pct(Math.round(p.projected))}`))
      .when(unusual, (el) => el.child(div().text_color(t.dim).child(`resets ${when(w.resetsAt)}`)));
  }

  logo(id, t, size = 14) {
    return id === "claude" ? image("mods/metro-chrome/icons/claude.svg").size(size).flex_none() : svg("mods/metro-chrome/icons/openai.svg").size(size).flex_none().text_color(t.foreground);
  }

  provider(id, empty, t) {
    const d = this.data[id];
    const el = h_flex().id(id).gap(10).items_center().flex_none().px(6).h(24).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .role("button").accessibility_label(`${PROVIDERS[id].name} usage details`)
      .on_click((_e, cx) => {
        if (this.popup) closeOverlay(this.popup);
        this.popup = openOverlay({ mod: "metro-usage", kind: "popup", width: 340, height: 300, props: { detail: id } });
        cx.notify();
      })
      .child(this.logo(id, t));
    if (!d) return el.child(div().text_color(t.dim).child("…"));
    if (d.missing || !d.windows?.length) return el.child(div().text_color(t.dim).child(empty));
    return el.children(d.windows.map((w, i) => this.windowView(`${id}-${i}`, w, t)));
  }

  // The popup: every number behind the bar, for one provider.
  detail(id, t) {
    const d = this.data[id], name = PROVIDERS[id].name;
    const row = (label, value, color) => h_flex().h(22).items_center().child(div().flex_1().text_color(t.muted).child(label)).child(div().text_color(color ?? t.foreground).child(value));
    const head = h_flex().gap(8).items_center().child(this.logo(id, t, 16)).child(div().flex_1().font_semibold().text_size(14).child(name))
      .child(div().id("detail-refresh").h(24).px(8).flex().items_center().rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx)).child("Refresh"));
    const body = !d ? [div().text_color(t.dim).child("Loading…")]
      : d.missing || !d.windows?.length ? [div().text_color(t.dim).child(id === "claude"
        ? "No usage yet. It appears after your next Claude Code reply, saved by the status line script."
        : "No Codex session in the last week. Usage appears after your next Codex turn.")]
      : d.windows.flatMap((w, i) => {
        const p = pace(w), b = w.windowMs >= 7 * DAY ? budget(w) : null;
        return [
          v_flex().id(`w-${i}`).gap(6).pt(i ? 10 : 0)
            .child(h_flex().items_center().child(div().flex_1().font_medium().child(w.label === "week" ? "Weekly limit" : `${w.label} limit`)).child(div().child(`${pct(w.used)} used`)))
            .child(this.bar(w, p, t, 300))
            .child(v_flex()
              .child(row("Burn so far", p.early ? "too early to tell" : `${pct(p.burnPerDay)}/day`))
              .child(row("Projected at reset", p.early ? "—" : p.runsOutAt ? `runs out ${when(p.runsOutAt)}` : `~${pct(Math.round(p.projected))}`, paceColor(p, t)))
              .when(Boolean(b), (el) => el
                .child(row("Budget by tonight", `${pct(b.allowed)} (${pct(b.share)}/workday)`))
                .child(row(b.left >= 0 ? "Left today" : "Over today", pct(Math.abs(b.left)), budgetColor(b, t))))
              .when(!b, (el) => el
                .child(row("Even pace by now", pct(p.expected)))
                .child(row("Left per day", `${pct(p.perDay)}/day`)))
              .when(p.perWorkday !== null, (el) => el.child(row("Left per workday", `${pct(p.perWorkday)}/workday`)))
              .child(row("Resets", `${when(w.resetsAt)} · in ${span(p.until)}`))),
        ];
      });
    const age = d?.at ? Date.now() - d.at : null;
    return v_flex().id("usage-detail").size_full().p(14).gap(10).bg(t.popover ?? t.background).text_size(12).text_color(t.foreground)
      .child(head)
      .children(body)
      .child(div().flex_1())
      .when(age !== null, (el) => el.child(div().text_size(11).text_color(age > STALE ? t.working : t.dim)
        .child(`Data from ${when(d.at)} (${span(age)} ago)${age > STALE ? ". It updates when you next use " + name + "." : ""}`)));
  }

  render() {
    const t = theme();
    const detail = props()?.detail;
    if (detail) return this.detail(detail, t);
    return h_flex().id("usage").size_full().px(10).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(12)
      .child(this.provider("claude", "Claude usage shows after your next Claude Code reply", t))
      .child(this.provider("codex", "No Codex sessions this week", t))
      .child(div().flex_1());
  }
}
