#!/bin/zsh
# A second Herdr window on the metro layout, with demo projects and an agent in every state,
# for screenshots. It has its own app home, herdr-core session and HOME, so it never touches
# your own window, terminals or usage files.
#
#   scripts/demo.sh          start it (DEMO_SIZE=1280x900 sets the window's size)
#   scripts/demo.sh shoot    save preview.png, layouts/metro.png, docs/review.png and docs/new-tab.png
#   scripts/demo.sh stop     quit it, stop its core and delete its folder
#
# DEMO_DIR (default /tmp/metro-demo) has to stay short: Herdr and herdr-core talk over unix
# sockets inside it.
set -euo pipefail

repo=${0:A:h:h}
dir=${DEMO_DIR:-/tmp/metro-demo}
mkdir -p "$dir"
dir=${dir:A}
size=${DEMO_SIZE:-1280x900}
src=$dir/home/src
demo_env=(
  HOME="$dir/home" HERDR_APP_HOME="$dir/app" HC_SESSION=metro-demo
  XDG_CONFIG_HOME="$dir/home/.config" XDG_STATE_HOME="$dir/home/.local/state" XDG_RUNTIME_DIR="$dir/rt"
  # No update downloads or telemetry from a throwaway window.
  HERDR_RELEASES_URL=http://127.0.0.1:9 HERDR_TELEMETRY=0 DO_NOT_TRACK=1
)
in_demo() { env -u HC_TERMINAL_ID "${demo_env[@]}" "$@"; }
core_pid() { "$@" hc server status --json 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p' | tail -1; }
app() { in_demo herdr-app do "$@"; }
json() { python3 -c 'import json, sys; print(json.loads(sys.stdin.read())[sys.argv[1]])' "$1"; }
# Prints the pointer's position; with x and y, moves it there first.
pointer() {
  osascript -l JavaScript -e 'ObjC.import("CoreGraphics")
    function run(a) {
      const p = $.CGEventGetLocation($.CGEventCreate(null))
      if (a.length === 2) $.CGWarpMouseCursorPosition({ x: +a[0], y: +a[1] })
      return Math.round(p.x) + " " + Math.round(p.y)
    }' "$@"
}
# A window behind others stops drawing, and a shot is its last drawn frame: shoot with the demo's in front.
shot() {
  local pid=$(lsof -t "$dir/app/herdr-app.sock" 2>/dev/null | head -1)
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" >/dev/null
  sleep 1.5
  in_demo herdr-app shot "$1" >/dev/null
}

case ${1:-start} in
stop)
  in_demo herdr-app do app.quit >/dev/null 2>&1 || true
  in_demo hc server stop >/dev/null 2>&1 || true
  if command -v trash >/dev/null; then trash "$dir"; else rm -rf "$dir"; fi
  print "Stopped the demo and removed $dir."
  exit 0 ;;
shoot)
  # The pointer waits at the screen's left edge, outside the window, so no row or tab shows as hovered.
  was=$(pointer 5 40)
  # The "finished" toasts start their timeout once drawn; wait them out.
  for _ in {1..30}; do
    in_demo herdr-app status | grep -q '"toast"' || break
    sleep 0.5
  done
  shot "$repo/preview.png"
  sips -Z 900 "$repo/preview.png" --out "$repo/layouts/metro.png" >/dev/null
  space=$(cat "$dir/review-space") tab=$(cat "$dir/review-tab") back=$(cat "$dir/hero-tab")
  app space.select --id "$space" >/dev/null && app tab.select --id "$tab" >/dev/null
  mkdir -p "$repo/docs" && shot "$repo/docs/review.png"
  app space.select --id "$(cat "$dir/hero-space")" >/dev/null && app tab.select --id "$back" >/dev/null
  # The + menu, opened where a click on + puts it; the top of the window is enough.
  app mod.open --name demo-plus >/dev/null
  shot "$dir/new-tab.png"
  app overlay.close >/dev/null
  if command -v magick >/dev/null; then
    magick "$dir/new-tab.png" -crop "$(( ${size%x*} * 2 ))x520+0+0" +repage "$repo/docs/new-tab.png"
  else
    cp "$dir/new-tab.png" "$repo/docs/new-tab.png"
  fi
  pointer ${=was} >/dev/null
  print "Saved preview.png, layouts/metro.png, docs/review.png and docs/new-tab.png."
  exit 0 ;;
esac

# A home of its own: no dotfiles, so a plain prompt; made-up usage for the status bar.
mkdir -p "$dir"/{app/layouts,app/mods,rt,home/.cache,home/.codex/sessions/demo} "$src"
chmod 700 "$dir/rt"
# The system's zshrc may run compinit, which asks about this home's ownership before anything runs.
print "unsetopt GLOBAL_RCS" > "$dir/home/.zshenv"
print "PROMPT='%~ %# '" > "$dir/home/.zshrc"
now=$(date +%s) reset=$(( $(date +%s) + 5 * 86400 ))
print "{\"at\":$now,\"limits\":{\"seven_day\":{\"used_percentage\":24,\"resets_at\":$reset}}}" > "$dir/home/.cache/claude-rate-limits.json"
print "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"rate_limits\":{\"primary\":{\"used_percent\":19,\"window_minutes\":10080,\"resets_at\":$reset}}}}" > "$dir/home/.codex/sessions/demo/rollout.jsonl"

# Demo projects: express with a fix in a worktree, and flask.
clone() { [[ -d $src/${1:t} ]] || git clone -q --depth 1 "https://github.com/$1.git" "$src/${1:t}"; }
clone expressjs/express
clone pallets/flask
wt=$src/express-forwarded-proto
[[ -d $wt ]] || git -C "$src/express" worktree add -q "$wt" -b fix/forwarded-proto
python3 - "$wt" "$dir/app/shared.json" <<'EOF'
import json, pathlib, sys
wt, shared = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
f = wt / "lib/request.js"
old = """  var header = this.get('X-Forwarded-Proto') || proto
  var index = header.indexOf(',')

  return index !== -1
    ? header.substring(0, index).trim()
    : header.trim()"""
new = """  var header = this.get('X-Forwarded-Proto') || proto
  var first = header.split(',')[0].trim().toLowerCase()

  // Anything but http or https is a misconfigured proxy: keep the socket's.
  return first === 'http' || first === 'https'
    ? first
    : proto"""
s = f.read_text()
if old in s: f.write_text(s.replace(old, new))
line = "  return first === 'http' || first === 'https'"
n = f.read_text().splitlines().index(line) + 1
at = {"side": "new", "number": n, "kind": "+", "text": line}
comment = {"id": "1", "path": "lib/request.js", "from": at, "to": at, "lines": f"line {n}",
           "quote": f"{n:5} + {line}",
           "body": "Log a warning the first time a proxy sends something else? Otherwise a misconfigured proxy fails silently."}
shared.write_text(json.dumps({"layout": "metro", "frame.welcomed": "finished",
                              "metro-review.drafts": {f":{wt}": [comment]}}))
EOF

# The layout and its mods, opening on it; Berlin and London on the clocks.
cp "$repo/layouts/metro.json" "$dir/app/layouts/"
for m in "$repo"/mods/metro-*(/); do
  rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' "$m/" "$dir/app/mods/${m:t}/"
done
print '{"layout:metro":{"cmd-shift-a":"metro-tabs.view"}}' > "$dir/app/keys.json"
print '{"programs":{"claude":{"icon":"mods/metro-chrome/icons/claude.svg","tint":false},"codex":{"icon":"mods/metro-chrome/icons/openai.svg","tint":true}}}' > "$dir/app/programs.json"
print '{"places":[{"name":"Berlin","winter":1},{"name":"London","winter":0}],"meetings":[{"name":"Standup","place":"Berlin","day":1,"hour":10,"minute":0,"minutes":15}]}' > "$dir/app/metro-clocks.json"
# Demo only: opens the tab bar's + menu under the + button, where a click puts it.
mkdir -p "$dir/app/mods/demo-plus"
print '{ "place": "none", "overlay": { "kind": "popup", "width": 10, "height": 10 } }' > "$dir/app/mods/demo-plus/mod.json"
cat > "$dir/app/mods/demo-plus/main.js" <<'EOF'
import { View, div } from "gpui-kit";
import { openOverlay, closeOverlay, props, spaces } from "herdr";
export default class DemoPlus extends View {
  init(_p, cx) {
    cx.spawn(async () => {
      closeOverlay(props().overlay);
      const space = spaces().find((s) => s.active)?.id;
      openOverlay({ mod: "metro-new-tab", kind: "popup", width: 220, height: 160, at: { x: 640, y: 36 }, props: { space } });
    });
  }
  render() { return div(); }
}
EOF
print "{\"zoom\":1,\"appearance\":\"light\",\"telemetry\":false,\"sounds\":{\"enabled\":false},\"core\":\"$(command -v herdr-core)\"}" > "$dir/app/settings.json"
print "{\"last_run\":\"$(herdr-app --version | awk '{print $NF}')\",\"presented\":[]}" > "$dir/app/update-notes.json"
print "{\"state\":\"windowed\",\"bounds\":[120.0,80.0,${size%x*}.0,${size#*x}.0]}" > "$dir/app/window.json"

in_demo nohup herdr-app >"$dir/app.log" 2>&1 &
for _ in {1..40}; do in_demo herdr-app status >/dev/null 2>&1 && break; sleep 0.5; done

# Never fill your own core with demo agents.
mine=$(core_pid env -u HC_SESSION)
theirs=$(core_pid in_demo)
if [[ -z $theirs || $theirs == "$mine" ]]; then
  print -u2 "The demo's herdr-core isn't separate from yours; not adding agents."
  exit 1
fi

# The agents list gets the room its five sections need; the projects list fits below.
app layout.resize --id agents --weight 1.85 >/dev/null
app layout.resize --id spaces --weight 1 >/dev/null

fake=$repo/scripts/fake-agent.sh
# space <folder> <tab name> <state> <app> <delay> [line ...]: a space whose first tab runs a fake agent.
space() {
  local folder=$1 name=$2; shift 2
  local r=$(app space.new "$(python3 -c 'import json, sys; print(json.dumps({"folder": sys.argv[1], "argv": sys.argv[2:]}))' "$folder" "$fake" "$@")")
  app tab.rename "{\"id\":\"$(print -r -- $r | json tab)\",\"name\":\"$name\"}" >/dev/null
  print -r -- "$r"
}
# tab <space> <tab name> <state> <app> <delay> [line ...]
tab() {
  local sp=$1 name=$2; shift 2
  app tab.new "$(python3 -c 'import json, sys; print(json.dumps({"space": sys.argv[1], "name": sys.argv[2], "argv": sys.argv[3:]}))' "$sp" "$name" "$fake" "$@")"
}

hero=$(space "$src/express" "Cache compiled view paths" working claude-code 0 \
  "" "● Read lib/view.js" "● Read test/app.render.js" "" \
  "  View#lookup() stats every candidate path on each render, so a" \
  "  template rendered 1,000 times costs 1,000 filesystem lookups." "" \
  "● Edit lib/view.js  (+14 -3)" "● Run npm test -- --grep render" "  ✓ 1,184 passing (3s)" "" \
  "✻ Writing a test for a cache miss after the file changes…")
tab "$(print -r -- $hero | json space)" "Add Node 24 to the CI matrix" idle codex 0 >/dev/null
fix=$(space "$wt" "Trust only http(s) in X-Forwarded-Proto" blocked claude-code 0 \
  "" "● Edit lib/request.js  (+4 -4)" "" "Allow edit to test/req.protocol.js?  1 Yes  2 No")
flask=$(space "$src/flask" "Docs: async view examples" done claude-code 20)
checked=$(tab "$(print -r -- $flask | json space)" "Typed config loader" done codex 20 | json terminal)
review=$(app tab.new "{\"space\":\"$(print -r -- $fix | json space)\",\"name\":\"Review\",\"mod\":\"metro-review\",\"props\":{\"folder\":\"$wt\",\"space\":\"$(print -r -- $fix | json space)\",\"machine\":null,\"mode\":\"uncommitted\"}}")
print -r -- $fix | json space > "$dir/review-space"
print -r -- $review | json tab > "$dir/review-tab"
print -r -- $hero | json space > "$dir/hero-space"
print -r -- $hero | json tab > "$dir/hero-tab"

# The flask agents finish while express is on screen, so they count as done, not seen.
app space.select --id "$(cat "$dir/hero-space")" >/dev/null
app tab.select --id "$(cat "$dir/hero-tab")" >/dev/null
sleep 22
in_demo hc label "$checked" metro.check=1 >/dev/null
print "The demo is up. scripts/demo.sh shoot saves the screenshots; scripts/demo.sh stop ends it."
