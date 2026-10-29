---
name: calendar
description: Manage events and reminders through the configured CalDAV service, including agenda, free time, recurring events and subscriptions.
---

# Calendar and reminders

Use `$PP_HOME/agent/skills/calendar/scripts/cal`. The wrapper runs `cal.py` with `uv` and the required Python packages. Supply `CALDAV_URL`, `CALDAV_USER`, `CALDAV_PASSWORD` and optionally `TZ_NAME` through the private environment; do not put credentials or real calendar data in the repository.

Read before changing anything: `calendars`, `agenda`, `events --cal all`, `todos --cal all`, `search --q TEXT`, and `free --from DATE --to DATE`. An empty agenda alone does not prove every collection and subscription is empty.

For authorized changes use `add`, `update`, `delete`, `todo-add`, `todo-update`, `todo-done`, `todo-undo` and `todo-delete`. Select a collection explicitly with `--cal` when needed; `--uid` identifies an existing item. For repeating events use `--rrule`; use `--occurrence` to skip one occurrence without deleting the entire series. Confirm the requested calendar, time zone, alarms and recurrence, and report the result. Ask before destructive operations affecting other people's entries or an entire collection.

Manage collections with `calendars`, `setup`, `mkcal`, `rename` and `delcal`; deleting a collection requires explicit confirmation and `--yes`. Use `import --file FILE --cal NAME` and `export --cal NAME --out FILE` for iCalendar data. Subscriptions use `sub-add`, `sub-list`, `sub-events` and `sub-remove`; subscription events are read-only. Consult the script's usage for all flags and ensure test accounts and fixtures are isolated from production.

The scripts directory also provides class reminders, reminder nudges and digests. `class-reminder.py` uses the example file `data/calendar/timetable.ics`; a production installation with a different existing path requires an explicit adaptation before deployment. Configure tasks separately in private `data/tasks/`, using the scheduled-tasks skill. Never schedule a test notification against a production destination.
