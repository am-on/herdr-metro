// The status bar's right end: the next recurring meeting, the local time where coworkers are, and whether they're within working hours.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, readTextFile, appHome } from "herdr";

const HOUR = 3600000;
// Places and meetings come from metro-clocks.json in Herdr's folder; without it the clocks show nothing.
//   { "hours": [8, 17],
//     "places": [{ "name": "Berlin", "winter": 1 }, { "name": "New York", "winter": -5, "summer": 0 }],
//     "meetings": [{ "name": "Standup", "place": "Berlin", "day": 1, "hour": 13, "minute": 0, "minutes": 30 }] }
// `hours`: working hours, Monday to Friday, in each place's own time. `winter`: the offset from UTC in winter;
// `summer`: hours added during EU summer time (1 unless given). A meeting's `day` is the weekday, 0 for Sunday.
const CONFIG = () => `${appHome()}/metro-clocks.json`;
// The countdown turns amber this close to the start.
const SOON = 15 * 60000;

// Last Sunday of a month, at 01:00 UTC.
const lastSunday = (year, month) => {
  const d = new Date(Date.UTC(year, month + 1, 0, 1));
  return d.getTime() - d.getUTCDay() * 24 * HOUR;
};
// EU summer time runs from the last Sunday of March to the last Sunday of October, both at 01:00 UTC.
const summer = (ms) => {
  const year = new Date(ms).getUTCFullYear();
  return ms >= lastSunday(year, 2) && ms < lastSunday(year, 9);
};

// The wall clock at `place`, read through the UTC getters.
function clock(place, now, [from, until] = [8, 17]) {
  const d = new Date(now + offset(place, now));
  const h = d.getUTCHours(), day = d.getUTCDay();
  return {
    time: `${h}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    online: day !== 0 && day !== 6 && h >= from && h < until,
  };
}

const offset = (place, ms) => ((place.winter ?? 0) + (summer(ms) ? (place.summer ?? 1) : 0)) * HOUR;

// Today's meeting, if there is one still to come or on now: when it starts and ends, in ms.
function meetingToday(m, now, places) {
  const place = places.find((p) => p.name === m.place);
  if (!place) return null;
  const wall = new Date(now + offset(place, now));
  if (wall.getUTCDay() !== m.day) return null;
  const start = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), m.hour, m.minute) - offset(place, now);
  const end = start + m.minutes * 60000;
  return now < end ? { ...m, start, end } : null;
}

const until = (ms) => {
  const m = Math.ceil(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
};
const hhmm = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };

export default class Clocks extends View {
  init(_props, cx) {
    this.config = { places: [], meetings: [] };
    this.load(cx);
    this.tick(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const c = JSON.parse(await readTextFile(CONFIG()));
        this.config = { hours: c.hours, places: c.places ?? [], meetings: c.meetings ?? [] };
      } catch {
        this.config = { places: [], meetings: [] };
      }
      cx.notify();
    });
  }

  // Redraws on each minute's turn, reading the places again so an edit shows within a minute.
  tick(cx) {
    cx.timer.after(60000 - (Date.now() % 60000) + 50, (cx) => { this.load(cx); this.tick(cx); });
  }

  render() {
    const t = theme(), now = Date.now();
    // "Meeting in 4h 40m" with its start in this computer's time; amber when close, "Meeting now" while on.
    const { hours, places, meetings: planned } = this.config;
    const meetings = planned.map((m) => meetingToday(m, now, places)).filter(Boolean).map((m) => {
      const on = now >= m.start, soon = !on && m.start - now <= SOON;
      const color = on ? t.accent : soon ? t.working : t.foreground;
      return h_flex().id(`meeting-${m.name}`).gap(6).items_center().flex_none()
        .accessibility_label(on ? `${m.name} now` : `${m.name} at ${hhmm(m.start)}, in ${until(m.start - now)}`)
        .child(svg("mods/metro-chrome/icons/clock.svg").size(12).flex_none().text_color(on || soon ? color : t.muted))
        .child(div().text_color(color).child(on ? `${m.name} now` : `${m.name} in ${until(m.start - now)}`))
        .when(!on, (el) => el.child(div().text_color(t.dim).child(hhmm(m.start))));
    });
    // The top line continues the sidebar footer's, across the status bar.
    return h_flex().id("clocks").size_full().px(14).gap(18).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border).text_size(12)
      .children(meetings)
      .children(places.map((place) => {
        const c = clock(place, now, hours);
        // The mark alone says it: filled green while online, a grey ring while offline, like the agents' idle mark.
        const mark = c.online
          ? div().size(8).rounded(4).bg(t.ansi2)
          : div().size(8).rounded(4).border(1.5).border_color(t.dim);
        return h_flex().id(`clock-${place.name}`).gap(6).items_center().flex_none()
          .accessibility_label(`${place.name} ${c.time}, ${c.online ? "online" : "offline"}`)
          .child(mark)
          .child(div().text_color(t.muted).child(place.name))
          .child(div().text_color(t.foreground).child(c.time));
      }));
  }
}
