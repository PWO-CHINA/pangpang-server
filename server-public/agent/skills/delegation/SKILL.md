---
name: delegation
description: Organize heavy work by delegating to Codex or Claude Code over ACP (delegate tool), especially multi-step jobs on remote machines over SSH. Read before the first delegation in a session.
---

# Delegating heavy work to Codex and Claude Code

You are the coordinator. You are cheaper and faster (MiMo); Codex and Claude Code are
expensive, slow, and much stronger at long, multi-step engineering. Plan and check the work
yourself; hand the long execution to them with the `delegate` tool.

## 1. Decide: do it yourself or delegate

Do it yourself when the job is a few commands: a status check, reading a file, one config
edit, a quick lookup. Delegating that costs more than it saves.

Delegate when any of these holds:
- more than about five dependent steps, or several files to change;
- a build, migration, install or debugging loop that needs trial and error;
- setting up or repairing something on a remote machine;
- a code review or investigation that needs to read a lot of code.

## 2. Choose the agent and mode

- `codex`: default choice. Strong at shell-heavy work, builds, scripts, repo changes. Runs
  with full access on this server.
- `claude`: careful multi-step reasoning, refactors, reviews, writing. Only if it is
  configured: if a delegation to claude fails with an authentication error, use codex and
  tell the owner that Claude Code needs a token.
- `mode: "read"` for investigations, audits and reviews: edits are refused. `mode: "full"`
  when the task must change things.
- `background: true` (default) for anything over a minute; you are woken with the report.
  Tell the owner the job id and move on. Use `background: false` only for short jobs whose
  result you need for your current reply.
- At most two jobs run at once. Split independent work (for example two different hosts)
  into two jobs; keep dependent steps in one job.

## 3. Write the brief

The agent sees only your brief, not this chat or your memory. Include:

1. Goal: the end state in one or two sentences.
2. Where: working directory (`cwd`), host aliases, exact paths, services, branches.
3. Context: what you already found, versions, error messages quoted exactly.
4. Constraints: what must not change, hosts that are read-only, downtime limits.
5. Verification: the commands that prove success, and that they must be run.
6. Report: ask for the commands it ran, what changed (files, services), verification output,
   and anything left undone. Ask for plain text, no tables.

Never paste secrets into a brief. Point to where they live (a file path or an env var name).

## 4. Remote work over SSH

The agents run on this server as the pangpang user and reach other machines with that
user's `~/.ssh/config` aliases. The host list, per-host rules and helper scripts are in the `remote-dev` skill:
read it and its `references/hosts.md` before any remote delegation.

Before delegating remote work:
1. Check the host is reachable (`remote-dev` scripts/r.sh).
   If it is unreachable, report that to the owner instead of delegating.
2. Put in the brief: the host alias, that host's rules from hosts.md, and the absolute path
   of the remote-dev scripts (`$PP_HOME/agent/skills/remote-dev/scripts/`)
   so the agent uses them: r.sh for commands, rjob.sh for anything longer than a few
   minutes (remote tmux with a log), rsync.sh for files, tunnel.sh for ports.
3. Also require: every ssh non-interactive (BatchMode), no interactive programs, `-y`
   flags, and a list of every change made on the remote host in the report.

## 5. After the job

When you are woken with `[EVENT:delegate:<id>]`:
1. Read the report. If it claims success, spot-check one or two key claims yourself with a
   cheap command (a service status, a file, a version), especially on remote hosts.
2. Tell the owner the outcome in a few lines: what changed, where, how it was verified,
   what is left. Mention the job id.
3. If it failed, decide: fix the brief and delegate again once, or report the blocker.
   Do not loop.
4. If the job revealed a durable fact (a host quirk, a working procedure), save it: a host
   fact to memory, a procedure to this or another skill.

The full transcript of every job is in `var/logs/delegations/<id>.log`. The owner can also
start jobs directly with `/codex <task>` or `/claude <task>`, see them with `/jobs`, and stop
one with `/cancel <id>`.
