#!/usr/bin/env python3
"""Follow-ups for things the owner has not answered.

Track unanswered requests and optionally remind the owner later.

The ledger lives in `var/state/followups.json`.  A twice-daily cron task
(`data/tasks/followups.json`, 10:00 and 21:00 Asia/Shanghai) runs `due` and
prints a short digest of the asks that are still unanswered; silence otherwise.

Register an ask (and print it, for a task's `run` with `then: notify`):

  followups.py ask --chat EXAMPLE_CHAT_ID --text "Example follow-up"

Every ask gets at least one nudge.  After that it is dropped silently once the
owner has written anything in its chat since the ask (they probably answered),
when `done` matches it, or after 3 days.  Each ask is nudged at most twice.

  followups.py add|ask --chat C --text T [--asked ISO]
  followups.py list
  followups.py done <id|substring>
  followups.py due [--now ISO]     # honours FOLLOWUPS_NOW too
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import uuid
from pathlib import Path
from zoneinfo import ZoneInfo

PP_HOME = Path(os.environ.get("PP_HOME") or Path(__file__).resolve().parents[4])
TZ = ZoneInfo(os.environ.get("TZ_NAME", "Asia/Shanghai"))
STATE = Path(os.environ.get("FOLLOWUPS_STATE") or PP_HOME / "var/state/followups.json")
CHATS = PP_HOME / "data/chats"

# Ask again after the first hour, then not more often than every 4h, twice max.
FIRST_AFTER = dt.timedelta(hours=1)
MIN_GAP = dt.timedelta(hours=4)
MAX_NUDGES = 2
GIVE_UP = dt.timedelta(days=3)
MAX_TEXT = 160


def now() -> dt.datetime:
	raw = os.environ.get("FOLLOWUPS_NOW")
	return dt.datetime.fromisoformat(raw) if raw else dt.datetime.now(TZ)


def parse_time(value: str) -> dt.datetime:
	t = dt.datetime.fromisoformat(value)
	return t if t.tzinfo else t.replace(tzinfo=TZ)


def load() -> list[dict]:
	try:
		data = json.loads(STATE.read_text(encoding="utf-8"))
	except (OSError, ValueError):
		return []
	if isinstance(data, dict):
		return list(data.get("asks", []))
	return []


def save(asks: list[dict]) -> None:
	STATE.parent.mkdir(parents=True, exist_ok=True)
	tmp = STATE.with_name(STATE.name + ".tmp")
	tmp.write_text(json.dumps({"asks": asks}, ensure_ascii=False, indent=1), encoding="utf-8")
	tmp.replace(STATE)


def owner_replied(chat: str, after: dt.datetime) -> bool:
	"""True when the owner sent any message in `chat` after `after`."""
	path = CHATS / str(chat) / "log.jsonl"
	try:
		lines = path.read_text(encoding="utf-8").splitlines()[-500:]
	except OSError:
		return False
	for line in lines:
		try:
			rec = json.loads(line)
		except ValueError:
			continue
		if rec.get("role") != "user":
			continue
		try:
			if parse_time(str(rec.get("date"))) > after:
				return True
		except ValueError:
			continue
	return False


def brief(text: str) -> str:
	text = " ".join(text.split())
	return text if len(text) <= MAX_TEXT else text[: MAX_TEXT - 1] + "…"


def cmd_add(args: argparse.Namespace, echo: bool) -> int:
	asked = parse_time(args.asked) if args.asked else now()
	text = " ".join(args.text).strip()
	if not text:
		print("no text", file=sys.stderr)
		return 2
	asks = load()
	asks.append(
		{
			"id": uuid.uuid4().hex[:8],
			"asked": asked.isoformat(),
			"chat": args.chat or os.environ.get("PP_NOTIFY_CHAT", ""),
			"text": text,
			"n": 0,
			"last": asked.isoformat(),
		}
	)
	save(asks)
	if echo:
		print(text)
	return 0


def cmd_list(_args: argparse.Namespace) -> int:
	t = now()
	for ask in load():
		age = t - parse_time(ask["asked"])
		hrs = age.total_seconds() / 3600
		print(f"{ask['id']}  {ask['chat']}  +{hrs:.1f}h  n={ask['n']}  {brief(ask['text'])}")
	return 0


def cmd_done(args: argparse.Namespace) -> int:
	asks = load()
	needle = args.id.lower()
	kept = [a for a in asks if needle not in a["id"].lower() and needle not in a["text"].lower()]
	save(kept)
	print(f"removed {len(asks) - len(kept)}")
	return 0


def cmd_due(_args: argparse.Namespace) -> int:
	t = now()
	due, kept = [], []
	for ask in load():
		asked = parse_time(ask["asked"])
		last = parse_time(ask.get("last", ask["asked"]))
		age = t - asked
		n = int(ask.get("n", 0))
		# The first nudge goes out unconditionally: an unrelated owner message just
		# after the ask must not look like an answer.  From the second on, stop if
		# the owner has written in that chat since (they have probably answered).
		if age > GIVE_UP or (n >= 1 and owner_replied(ask.get("chat", ""), asked)):
			continue
		ready = age >= FIRST_AFTER and (n == 0 or t - last >= MIN_GAP)
		if n < MAX_NUDGES and ready:
			ask["n"] = n + 1
			ask["last"] = t.isoformat()
			due.append(ask)
		kept.append(ask)
	save(kept)

	if due:
		out = ["🐶 这几件我还没等到你回话："]
		out += [f"{i}. {brief(a['text'])}" for i, a in enumerate(due, 1)]
		out.append("（回一句就行；不想管了就说「跳过」。）")
		print("\n".join(out))
	return 0


def main() -> int:
	p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	sub = p.add_subparsers(dest="cmd", required=True)
	for name in ("add", "ask"):
		s = sub.add_parser(name)
		s.add_argument("--chat")
		s.add_argument("--text", nargs="+", required=True)
		s.add_argument("--asked", help="ISO time the ask was sent (default: now)")
		sub.choices[name].set_defaults(func=lambda a, echo=(name == "ask"): cmd_add(a, echo))
	sub.add_parser("list").set_defaults(func=cmd_list)
	d = sub.add_parser("done")
	d.add_argument("id")
	d.set_defaults(func=cmd_done)
	u = sub.add_parser("due")
	u.add_argument("--now")
	u.set_defaults(func=cmd_due)

	args = p.parse_args()
	if getattr(args, "now", None):
		os.environ["FOLLOWUPS_NOW"] = args.now
	return args.func(args)


if __name__ == "__main__":
	sys.exit(main())
