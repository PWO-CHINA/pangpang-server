#!/usr/bin/env bash
# Copy files with rsync over the shared SSH options.
#   rsync.sh push HOST LOCAL_PATH REMOTE_PATH [extra rsync args]
#   rsync.sh pull HOST REMOTE_PATH LOCAL_PATH [extra rsync args]
# Always prints a dry-run summary first when RSYNC_DRY=1.
set -uo pipefail
. "$(dirname "$0")/_ssh.sh"
dir=${1:?push|pull}; host=${2:?host}; a=${3:?src}; b=${4:?dst}; shift 4
e="ssh ${SSH_OPTS[*]}"
flags=(-az --info=stats1 ${RSYNC_DRY:+--dry-run} "$@")
case $dir in
  push) rsync "${flags[@]}" -e "$e" "$a" "$host:$b" ;;
  pull) rsync "${flags[@]}" -e "$e" "$host:$a" "$b" ;;
  *) echo "first argument must be push or pull" >&2; exit 2 ;;
esac
