---
name: remote-dev
description: Work on remote machines over SSH from this server - run commands, long jobs in remote tmux, rsync files, port tunnels - with the owner's host list and per-host rules. Use for any remote task, directly or when briefing Codex/Claude.
---

# Remote development over SSH

Adapted from polyakov-claude-skills `ssh-remote-connection` (MIT: a script interface instead
of hand-written ssh) with ideas from pi-ssh-remote (reused connections, bounded output,
per-host memory, tunnels). Hosts come from `~/.ssh/config`; always use the alias.

Scripts are in `agent/skills/remote-dev/scripts/` (call with `bash <path>`). All of them are
non-interactive (BatchMode), fail fast, and reuse one SSH connection per host for 10 minutes.

## 1. Before anything: hosts and their rules

Read `references/hosts.md`: the host list, what each host is, what you may and may not do
there, and notes learned earlier. Check reachability first:

```bash
bash .../scripts/r.sh HOST 'hostname; uptime'
```

To power a host
off or reboot it, ask the owner first; for GNOME desktop hosts use the session-bus method in
`references/hosts.md` (`org.gnome.SessionManager.Shutdown`, no sudo needed).

## 2. Short commands

```bash
bash .../scripts/r.sh HOST 'command'
bash .../scripts/r.sh HOST -C /srv/app 'git status --short; ls'
R_MAX=20000 bash .../scripts/r.sh HOST 'journalctl -u app --since today'
```

Output is capped (default 8000 chars, head and tail kept). Narrow the command (grep, tail,
`--since`) rather than raising the cap. The command runs in a login shell, so the host's
PATH and profile apply.

## 3. Long jobs (builds, training, migrations, large downloads)

Never hold an SSH session open for minutes. Start the job in remote tmux with a log:

```bash
bash .../scripts/rjob.sh HOST start build 'make -j4' /srv/app
bash .../scripts/rjob.sh HOST status build     # running | finished rc=N
bash .../scripts/rjob.sh HOST log build 60
bash .../scripts/rjob.sh HOST stop build
```

For waiting, create a one-shot or cron pangpang task that runs `rjob.sh status` and notifies
when finished, instead of polling in your own turn.

## 4. Files

```bash
bash .../scripts/rsync.sh push HOST ./dist/ /srv/app/dist/
bash .../scripts/rsync.sh pull HOST /var/log/app/ ./logs/
RSYNC_DRY=1 bash .../scripts/rsync.sh push HOST ./site/ /var/www/site/ --delete   # check first
```

Always dry-run any sync with `--delete`. Never copy secrets onto shared or public hosts.

## 5. Tunnels (test a remote service locally)

```bash
bash .../scripts/tunnel.sh open HOST 8080          # 127.0.0.1:8080 here -> HOST:8080
curl -s 127.0.0.1:8080/health
bash .../scripts/tunnel.sh close HOST 8080
```

## 6. Code on remote hosts

- Source of truth is git. Change code in a checkout, commit, push, then pull on the host; do not hand-edit deployed files unless the task is
  explicitly a hotfix, and then report the exact diff.
- Do not `git pull`, reset, or switch branches in a checkout on a host that someone else
  works in unless the owner asked; report instead.
- Record every change you make on a remote host (files, packages, services, crontabs) and
  report it.

## 7. Heavy remote work

Multi-step remote work (setting up a service, debugging on the host, builds with trial and
error) goes to Codex or Claude Code via the `delegation` skill. Before delegating: check the
host is reachable (wake it if needed), then put in the brief the host alias, the rules for
that host from `references/hosts.md`, and that these scripts exist at their absolute path so
the agent can use them.

## 8. Learn

When you learn something durable about a host (tool paths, service names, quirks, what
broke), add one line under that host in `references/hosts.md` with `skill_manage`
`write_file`, after reading the file. Keep it short; it is the per-host memory.
