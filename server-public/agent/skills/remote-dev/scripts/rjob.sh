#!/usr/bin/env bash
# Long-running jobs on a remote host, in tmux, with a log file.
#   rjob.sh HOST start NAME 'command' [DIR]   start (fails if NAME is running)
#   rjob.sh HOST status [NAME]                running jobs, or one job's state
#   rjob.sh HOST log NAME [LINES]             tail of the log (default 40)
#   rjob.sh HOST stop NAME                    stop the job
# Logs: ~/.pangpang-jobs/NAME.log on the remote host; exit code in NAME.rc.
set -uo pipefail
. "$(dirname "$0")/_ssh.sh"
host=${1:?host}; action=${2:?action}; name=${3:-}
rs() { ssh "${SSH_OPTS[@]}" "$host" "bash -lc $(printf %q "$1")"; }
J='~/.pangpang-jobs'
case $action in
  start)
    cmd=${4:?command}; dir=${5:-}
    [ -n "$dir" ] && cmd="cd $(printf %q "$dir") && $cmd"
    inner="($cmd) > $J/$name.log 2>&1; echo \$? > $J/$name.rc"
    rs "command -v tmux >/dev/null || { echo 'tmux missing on $host' >&2; exit 3; }
        mkdir -p $J; tmux has-session -t pp-$name 2>/dev/null && { echo 'job $name is already running' >&2; exit 2; }
        rm -f $J/$name.rc; tmux new-session -d -s pp-$name $(printf %q "$inner") && echo 'started pp-$name; log $J/$name.log'" ;;
  status)
    if [ -n "$name" ]; then
      rs "if tmux has-session -t pp-$name 2>/dev/null; then echo running; elif [ -f $J/$name.rc ]; then echo \"finished rc=\$(cat $J/$name.rc)\"; else echo unknown; fi"
    else
      rs "tmux ls 2>/dev/null | grep '^pp-' || echo 'no running pangpang jobs'"
    fi ;;
  log) rs "tail -n ${4:-40} $J/$name.log" ;;
  stop) rs "tmux kill-session -t pp-$name && echo stopped" ;;
  *) echo "unknown action $action" >&2; exit 2 ;;
esac
