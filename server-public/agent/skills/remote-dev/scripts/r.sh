#!/usr/bin/env bash
# Run a command on a host, output bounded for the model.
#   r.sh HOST 'command'            runs in the login dir
#   r.sh HOST -C /path 'command'   runs in /path
#   R_MAX=20000 r.sh ...           raise the output cap (chars, default 8000)
set -uo pipefail
. "$(dirname "$0")/_ssh.sh"
host=${1:?usage: r.sh HOST [-C DIR] 'command'}; shift
dir=""
if [ "${1:-}" = -C ]; then dir=$2; shift 2; fi
cmd=${1:?command required}
[ -n "$dir" ] && cmd="cd $(printf %q "$dir") && $cmd"
out=$(ssh "${SSH_OPTS[@]}" "$host" "bash -lc $(printf %q "$cmd")" 2>&1); rc=$?
max=${R_MAX:-8000}
if [ ${#out} -gt "$max" ]; then
  half=$((max / 2))
  printf '%s\n... [%d chars elided; rerun narrower or raise R_MAX] ...\n%s\n' "${out:0:half}" $(( ${#out} - max )) "${out: -half}"
else
  printf '%s\n' "$out"
fi
exit $rc
