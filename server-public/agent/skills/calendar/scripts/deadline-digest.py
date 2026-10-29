#!/usr/bin/env python3
"""Morning digest of open reminders in the owner's reminder lists.

Run by data/tasks/deadline-digest.json every morning (no model call, no
tokens).  Prints every open reminder that is overdue or due within
WINDOW_DAYS days; prints nothing when the window is clear, so the task stays
silent.

Env overrides (tests):
  DEADLINE_WINDOW_DAYS   days ahead to include (default 8)
  DEADLINE_NOW           ISO time to pretend "now" is
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
CAL = PP_HOME / "agent/skills/calendar/scripts/cal"
WINDOW = int(os.environ.get("DEADLINE_WINDOW_DAYS", "8"))


def open_todos() -> list[dict]:
	proc = subprocess.run(
		[str(CAL), "todos", "--cal", "all"],
		capture_output=True,
		text=True,
		timeout=90,
	)
	if proc.returncode != 0:
		raise RuntimeError(proc.stderr.strip() or f"cal exited {proc.returncode}")
	return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


def parse_due(value: str) -> tuple[dt.date, dt.time | None]:
	""""2026-11-06" -> (date, None); "2026-11-03T00:35+08:00" -> (date, time)."""
	if len(value) == 10:
		return dt.date.fromisoformat(value), None
	moment = dt.datetime.fromisoformat(value).astimezone(TZ)
	return moment.date(), moment.time().replace(second=0, microsecond=0)


def label(days: int) -> str:
	if days < 0:
		return f"逾期 {-days} 天"
	if days == 0:
		return "今天"
	return f"{days} 天后"


def main() -> int:
	now_env = os.environ.get("DEADLINE_NOW")
	now = dt.datetime.fromisoformat(now_env) if now_env else dt.datetime.now(TZ)
	if now.tzinfo is None:
		now = now.replace(tzinfo=TZ)
	today = now.date()

	rows = []
	for todo in open_todos():
		due_text = todo.get("due")
		if not due_text:
			continue
		due_day, due_time = parse_due(due_text)
		days = (due_day - today).days
		if days > WINDOW:
			continue
		when = f"{due_day:%m-%d}" + (f" {due_time:%H:%M}" if due_time else "")
		rows.append((due_day, due_time or dt.time(23, 59), when, days, todo.get("title", "?")))

	rows.sort()
	if not rows:
		return 0

	overdue = [r for r in rows if r[3] < 0]
	upcoming = [r for r in rows if r[3] >= 0]
	lines = [f"🗓️ 待办：{len(upcoming)} 项临近" + (f"，{len(overdue)} 项逾期" if overdue else "")]
	if overdue:
		shown = overdue[-5:]  # oldest last: the 5 most recent
		head = "🔴 逾期"
		if len(overdue) > len(shown):
			head += f"（最早 {len(overdue) - len(shown)} 项略）"
		lines.append(head)
		for _, _, when, days, title in shown:
			lines.append(f"• {when} · {title} — {label(days)}")
	if upcoming:
		lines.append("⏰ 临近")
		for _, _, when, days, title in upcoming:
			lines.append(f"• {when} · {title} — {label(days)}")
	print("\n".join(lines))
	return 0


if __name__ == "__main__":
	sys.exit(main())
