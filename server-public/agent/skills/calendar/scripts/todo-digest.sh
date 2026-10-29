#!/usr/bin/env bash
# Print the open 🐶 提醒 items as a short digest, or NO_REPLY when there is nothing.
#
#   todo-digest.sh            -> digest of the open, still-relevant reminders
#
# Far-future items (long-term like the domain renewal) and anything marked
# "搁置" are left out.  Use it as a task's `run` with `then: notify`.
set -uo pipefail

json=$("$PP_HOME/agent/skills/calendar/scripts/cal" todos --cal "🐶 提醒" 2>/dev/null || true)
if [ -z "$json" ]; then
  echo NO_REPLY
  exit 0
fi

printf '%s\n' "$json" | jq -rs '
  map(select(.status == "NEEDS-ACTION"
             and (.title | test("搁置") | not)
             and ((.due // "9999-12-31") < "2027")))
  | if length == 0 then "NO_REPLY"
    else "🐶 还开着的事：\n"
         + (to_entries
            | map("\(.key + 1). \(.value.title)"
                 + (if .value.due then "（\(.value.due[0:10])）" else "（无期限）" end))
            | join("\n"))
         + "\n\n办完哪个回我一句，我勾掉。"
    end'
