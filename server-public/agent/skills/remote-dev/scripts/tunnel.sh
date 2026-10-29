#!/usr/bin/env bash
# Forward a remote port to this machine (for testing a remote service locally).
#   tunnel.sh open HOST REMOTE_PORT [LOCAL_PORT]   default LOCAL_PORT = REMOTE_PORT
#   tunnel.sh close HOST REMOTE_PORT [LOCAL_PORT]
set -uo pipefail
. "$(dirname "$0")/_ssh.sh"
action=${1:?open|close}; host=${2:?host}; rport=${3:?remote port}; lport=${4:-$rport}
case $action in
  open) ssh "${SSH_OPTS[@]}" -O forward -L "127.0.0.1:$lport:127.0.0.1:$rport" "$host" 2>/dev/null \
          || { ssh "${SSH_OPTS[@]}" -fN "$host" && ssh "${SSH_OPTS[@]}" -O forward -L "127.0.0.1:$lport:127.0.0.1:$rport" "$host"; }
        echo "127.0.0.1:$lport -> $host:$rport" ;;
  close) ssh "${SSH_OPTS[@]}" -O cancel -L "127.0.0.1:$lport:127.0.0.1:$rport" "$host" && echo closed ;;
  *) echo "open or close" >&2; exit 2 ;;
esac
