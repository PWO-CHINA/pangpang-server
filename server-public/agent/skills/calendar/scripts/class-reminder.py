#!/usr/bin/env python3
"""Pre-class push for the owner's university timetable.

Run by data/tasks/class-reminder.json every 5 minutes (no model call, no tokens).
It prints one reminder per class that starts within LEAD_MIN minutes and was not
announced yet, and prints nothing otherwise, so the task stays silent.

A class is a live 日历 event whose UID appears in the timetable .ics
(data/calendar/timetable.ics) - unrelated events in 日历 are ignored.
The start/end/location come from 日历, so moving a class on the phone moves its
reminder.  A repeating class never repeats here because the export is flat.

Env overrides (used by the tests, and LEAD_MIN from the task file):
  CLASS_REMINDER_LEAD_MIN   minutes before class to push (default 30)
  CLASS_REMINDER_NOW        ISO time to pretend "now" is (tests)
  CLASS_REMINDER_STATE      path of the dedup state file (tests)
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

PP_HOME = Path(os.environ.get("PP_HOME") or Path(__file__).resolve().parents[4])
TZ = ZoneInfo(os.environ.get("TZ_NAME", "Asia/Shanghai"))
TIMETABLE = PP_HOME / "data/calendar/timetable.ics"
CAL = PP_HOME / "agent/skills/calendar/scripts/cal"
STATE = Path(os.environ.get("CLASS_REMINDER_STATE") or PP_HOME / "var/state/class-reminder.json")

LEAD_MIN = int(os.environ.get("CLASS_REMINDER_LEAD_MIN", "30"))
# A failed calendar read is reported at most once per hour, not every 5 minutes.
ERROR_COOLDOWN = dt.timedelta(minutes=60)
OWNER_CALENDAR = "日历"


def class_uids() -> set[str]:
	uids: set[str] = set()
	for line in TIMETABLE.read_text(encoding="utf-8").splitlines():
		line = line.strip()
		if line.startswith("UID:"):
			uids.add(line[4:].strip())
	return uids


def events(from_day: dt.date, to_day: dt.date) -> list[dict]:
	proc = subprocess.run(
		[str(CAL), "events", "--cal", OWNER_CALENDAR, "--from", from_day.isoformat(), "--to", to_day.isoformat()],
		capture_output=True,
		text=True,
		timeout=90,
	)
	if proc.returncode != 0:
		raise RuntimeError(proc.stderr.strip() or f"cal exited {proc.returncode}")
	out = []
	for line in proc.stdout.splitlines():
		line = line.strip()
		if line:
			out.append(json.loads(line))
	return out


def load_state() -> set[str]:
	try:
		data = json.loads(STATE.read_text(encoding="utf-8"))
		return set(data.get("seen", [])) if isinstance(data, dict) else set()
	except (OSError, ValueError):
		return set()


def save_state(seen: set[str]) -> None:
	STATE.parent.mkdir(parents=True, exist_ok=True)
	tmp = STATE.with_name(STATE.name + ".tmp")
	tmp.write_text(json.dumps({"seen": sorted(seen)}, ensure_ascii=False), encoding="utf-8")
	tmp.replace(STATE)


def format_reminder(ev: dict, minutes: int) -> str:
	start = dt.datetime.fromisoformat(ev["start"])
	end = dt.datetime.fromisoformat(ev["end"])
	when = f"{start:%H:%M}–{end:%H:%M}"
	head = "⏰ 即将上课" if minutes <= 1 else f"⏰ {minutes} 分钟后上课"
	lines = [head, f"📚 {ev['title']}（{when}）"]
	loc = (ev.get("location") or "").split("\n")[0].strip()
	if loc:
		lines.append(f"📍 {loc}")
	return "\n".join(lines)


def main() -> int:
	now_env = os.environ.get("CLASS_REMINDER_NOW")
	now = dt.datetime.fromisoformat(now_env) if now_env else dt.datetime.now(TZ)
	if now.tzinfo is None:
		now = now.replace(tzinfo=TZ)

	seen = load_state()
	# Forget anything older than yesterday; keys are "<date>|uid|<start>".
	floor = (now.date() - dt.timedelta(days=1)).isoformat()
	seen = {k for k in seen if k[:10] >= floor}

	tomorrow = now.date() + dt.timedelta(days=1)
	try:
		uids = class_uids()
		upcoming = [
			ev
			for ev in events(now.date(), tomorrow)
			if ev.get("uid") in uids and ev.get("start") and dt.datetime.fromisoformat(ev["start"]) > now
		]
	except Exception as exc:  # noqa: BLE001 - report any failure once, never crash the task
		ekey = f"error|{now:%Y-%m-%dT%H}"
		if ekey not in seen:
			seen.add(ekey)
			save_state(seen)
			print(f"⚠️ 课程提醒：读取日历失败，本次跳过（{exc}）")
			return 0
		save_state(seen)
		return 0

	reminders = []
	for ev in sorted(upcoming, key=lambda e: e["start"]):
		start = dt.datetime.fromisoformat(ev["start"])
		seconds = (start - now).total_seconds()
		key = f"{start.date().isoformat()}|{ev['uid']}|{ev['start']}"
		if 0 < seconds <= LEAD_MIN * 60 and key not in seen:
			seen.add(key)
			reminders.append(format_reminder(ev, round(seconds / 60)))

	save_state(seen)
	if reminders:
		print("\n\n".join(reminders))
	return 0


if __name__ == "__main__":
	sys.exit(main())
