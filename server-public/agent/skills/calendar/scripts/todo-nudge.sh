#!/usr/bin/env bash
# Print a nudge only while a calendar reminder is still open.
#
#   todo-nudge.sh <uid> <message...>
#
# Silent (prints NO_REPLY, exit 0) when the item is done, missing or
# unreadable, so it is safe to use as a task's `run` with then: notify.
set -uo pipefail

uid="${1:-}"
shift || true

if [ -z "$uid" ] || [ "$#" -eq 0 ]; then
  echo "usage: todo-nudge.sh <uid> <message...>" >&2
  exit 2
fi

json="$("$PP_HOME/agent/skills/calendar/scripts/cal" todos --cal all 2>/dev/null || true)"

if printf '%s\n' "$json" | jq -e --arg u "$uid" \
     'select(.uid == $u and .status == "NEEDS-ACTION")' >/dev/null 2>&1; then
  printf '%s\n' "$*"
else
  echo NO_REPLY
fi
