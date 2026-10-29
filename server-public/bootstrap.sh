#!/usr/bin/env bash
# Build or refresh pangpang's self-contained toolchain.  Idempotent.
#
#   ./bootstrap.sh          install what is missing, sync packages
#
# Only this directory is written.
set -euo pipefail
umask 022   # caveman refuses group-writable state dirs (see bin/pp)

PP_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
cd "$PP_HOME"

TOOLS=$PP_HOME/.tools
VAR=$PP_HOME/var
export MAMBA_ROOT_PREFIX=$TOOLS/mamba
export TMPDIR=$VAR/tmp
export XDG_CACHE_HOME=$VAR/cache
export npm_config_cache=$VAR/cache/npm
mkdir -p "$TOOLS/bin" "$VAR"/{tmp,cache,state,sessions,logs,run}

step() { printf '\n==> %s\n' "$*"; }

MM=$TOOLS/bin/micromamba
if [ ! -x "$MM" ]; then
  step "Downloading micromamba"
  # Synology's /usr/bin/curl speaks modern TLS; Entware's /opt/bin/curl,
  # which comes first on root's PATH, does not.
  CURL=/usr/bin/curl; [ -x "$CURL" ] || CURL=curl
  "$CURL" -fL --retry 3 -o "$MM.part" \
    https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-linux-64
  chmod +x "$MM.part"
  mv "$MM.part" "$MM"
fi

ENV=$MAMBA_ROOT_PREFIX/envs/pangpang
if [ -d "$ENV/conda-meta" ]; then
  step "Syncing native toolchain"
  "$MM" install -y -n pangpang -f environment.yml
else
  step "Creating native toolchain"
  "$MM" create -y -f environment.yml
fi
export PATH=$ENV/bin:$PATH

step "Installing node packages"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# caveman: build the proxy and recovery binaries from a pinned source rev.
CAVEMAN_REV=2fd153c
CAVEMAN_SRC=$TOOLS/src/caveman
export CAVEMAN_HOME=$VAR/caveman
export GOPATH=$VAR/cache/go GOMODCACHE=$VAR/cache/go/mod GOCACHE=$VAR/cache/go/build
export GOTOOLCHAIN=local GOTELEMETRY=off CGO_ENABLED=0
if [ "$(cat "$CAVEMAN_HOME/bin/.rev" 2>/dev/null)" != "$CAVEMAN_REV" ]; then
  step "Building caveman $CAVEMAN_REV"
  if [ ! -d "$CAVEMAN_SRC/.git" ]; then
    git clone --quiet --filter=blob:none https://github.com/JuliusBrussee/caveman.git "$CAVEMAN_SRC"
  fi
  git -C "$CAVEMAN_SRC" fetch --quiet origin
  git -C "$CAVEMAN_SRC" checkout --quiet "$CAVEMAN_REV"
  mkdir -p "$CAVEMAN_HOME/bin"
  for pair in caveman-proxy:./proxy/cmd/caveman-proxy caveman-mcp:./mcp/cmd/caveman-mcp; do
    (cd "$CAVEMAN_SRC" && go build -trimpath -o "$CAVEMAN_HOME/bin/${pair%%:*}" "${pair#*:}")
  done
  echo "$CAVEMAN_REV" > "$CAVEMAN_HOME/bin/.rev"
fi


step "Allowing .envrc"
direnv allow "$PP_HOME"

step "Setup complete"
echo "Configure .env and agent/*.json, then run pp doctor after starting services."
