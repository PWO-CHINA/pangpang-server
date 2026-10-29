---
name: scheduled-tasks
description: Create, inspect and troubleshoot pangpang scheduled actions using task files, cron schedules, one-shot times and follow-up tracking.
---

# Scheduled tasks

The scheduler watches `data/tasks/` for one JSON file per task and rescans periodically. Use `pp tasks` for status and `var/logs/automation.jsonl` for local history. Keep these files private; no automatic Git commit or push of personal data is performed in the public build.

A task has either `schedule` (cron, with optional `timezone`) or `at` (ISO timestamp with an explicit offset), plus a `do` action. `enabled: false` keeps a task inactive. Actions include `notify`, `agent`, and `run` with an optional `then` of `notify`, `agent`, or `silent`; refer to `src/automation/actions.ts` for the exact fields. The `chat` value must be explicitly chosen when routing matters. Do not publish real chat IDs or task messages.

Create and validate JSON in a hidden temporary file within `data/tasks/`, then rename it into place so the watcher does not read a partial file. Check `pp tasks` and test the actual command output using an isolated account and test data. Manually triggering a task or running its command can perform real actions; do not trigger production tasks merely to test. Use `NO_REPLY` where a script intentionally emits no notification.

The included `scripts/followups.py` keeps a private follow-up ledger in `var/state/followups.json`. Its supported commands are `ask`, `add`, `list`, `done` and `due`; see the script usage. Test with a temporary `FOLLOWUPS_STATE` and synthetic chat identifiers. Use the calendar skill when an item belongs in a CalDAV calendar or reminder list.
