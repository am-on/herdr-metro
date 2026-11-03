#!/bin/sh
# A stand-in agent for screenshots: prints its lines, reports working, then after <delay> seconds <state>,
# through OSC 7501 as Claude Code and Codex do, and waits.
#
#   fake-agent.sh <idle|working|done|blocked> <claude-code|codex> <delay> [line ...]
state=$1 app=$2 delay=$3
shift 3
for line in "$@"; do printf '%s\n' "$line"; done
if [ "$delay" -gt 0 ]; then
  printf '\033]7501;state=working:app=%s\033\\' "$app"
  sleep "$delay"
fi
printf '\033]7501;state=%s:app=%s\033\\' "$state" "$app"
exec sleep 86400
