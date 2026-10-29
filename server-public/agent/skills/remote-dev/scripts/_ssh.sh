# Shared SSH options: non-interactive, fast failure, one reused connection
# per host (ControlMaster), sockets under pangpang's var/run.
CTL_DIR=${PP_VAR:?run inside the pangpang env}/run/ssh
mkdir -p "$CTL_DIR"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15
  -o ControlMaster=auto -o "ControlPath=$CTL_DIR/%r@%h:%p" -o ControlPersist=10m)
