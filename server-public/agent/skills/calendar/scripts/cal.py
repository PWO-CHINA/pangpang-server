#!/usr/bin/env python3
"""Calendars and reminders over CalDAV (the Radicale server on this machine).

Run through the wrapper, which pins the Python packages:
  scripts/cal COMMAND ...
Env (.env): CALDAV_URL, CALDAV_USER, CALDAV_PASSWORD, TZ_NAME (owner's time zone)

Times are ISO 8601 (2026-10-02, 2026-10-02T14:00, 2026-10-02T14:00+08:00) or
today / tomorrow / yesterday; without an offset they are local time in TZ_NAME.
--cal takes a calendar's name or path; "all" means every calendar of that kind.

Overview
  agenda   [--from T] [--to T]                  events + due reminders + subscriptions, sorted
  search   --q TEXT [--from T] [--to T]         title/description/location match, every calendar
  free     [--from T] [--to T] [--min N] [--day-start HH:MM] [--day-end HH:MM] [--cal C]
Events
  events   [--cal C|all] [--from T] [--to T]    default 🐶, today .. +7 days, recurrences expanded
  add      --title S --start T [--end T | --duration MIN] [--allday] [--cal C] [--desc S]
           [--location S] [--rrule RULE] [--alarm MIN ...] [--tags a,b]
  update   --uid U [--cal C] [--title S] [--start T] [--end T] [--allday] [--desc S]
           [--location S] [--rrule RULE|""] [--alarm MIN ... | --no-alarm] [--tags a,b]
           [--move-to C]
  delete   --uid U [--cal C] [--occurrence T]   --occurrence skips one date of a series
Reminders
  todos    [--cal C|all] [--all]                open reminders (--all: include done)
  todo-add --title S [--due T] [--cal C] [--desc S] [--priority high|medium|low|1-9]
           [--rrule RULE] [--alarm MIN ...] [--tags a,b]
  todo-update --uid U [--cal C] [--title S] [--due T|""] [--desc S] [--priority P]
           [--rrule RULE|""] [--alarm MIN ... | --no-alarm] [--tags a,b] [--move-to C]
  todo-done | todo-undo | todo-delete  --uid U [--cal C]
Calendars
  calendars
  setup                                         create the default collections if missing
  mkcal    --name S --kind event|todo
  rename   --cal C --name S
  delcal   --cal C --yes                        deletes the collection and everything in it
  export   --cal C [--out FILE]                 iCalendar (.ics); stdout by default
  import   --file FILE|URL --cal C              events/reminders; same UID replaces
Subscriptions (read-only external .ics feeds, e.g. a school timetable)
  sub-add  --name S --url URL | sub-remove --name S | sub-list
  sub-events [--name S] [--from T] [--to T]

RULE is an iCalendar RRULE such as FREQ=WEEKLY;BYDAY=MO,WE or FREQ=DAILY;COUNT=5.
--alarm N alerts N minutes before (repeat the flag for several alerts).
--uid without --cal searches every calendar.  Output: one JSON object per line.
"""
import argparse, datetime as dt, json, os, pathlib, re, signal, sys, urllib.request, uuid, warnings
from zoneinfo import ZoneInfo

signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # quiet when piped into head
warnings.filterwarnings("ignore")

# pangpang's own collections; the owner's are "calendar" (日历) and "reminders" (提醒).
EVENT_CAL = "pangpang"
TODO_CAL = "pangpang-todo"
# Collections `setup` creates: (path segment, display name, component).
COLLECTIONS = [
    ("pangpang", "🐶", "VEVENT"),
    ("pangpang-todo", "🐶 提醒", "VTODO"),
    ("calendar", "日历", "VEVENT"),
    ("reminders", "提醒", "VTODO"),
]
SUBS = pathlib.Path(os.environ.get("PP_HOME", ".")) / "data" / "calendar" / "subscriptions.json"
PRIORITY = {"high": 1, "medium": 5, "low": 9}


def local_zone():
    name = os.environ.get("TZ_NAME") or os.path.realpath("/etc/localtime").split("zoneinfo/")[-1]
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo("UTC")


TZ = local_zone()
UTC = dt.timezone.utc


def out(obj):
    print(json.dumps({k: v for k, v in obj.items() if v not in (None, [], "")}, ensure_ascii=False, default=str))


def fail(msg):
    out({"error": msg})
    sys.exit(1)


# ---------------------------------------------------------------- time


def today():
    return dt.datetime.now(TZ).date()


def parse_t(s, allday=False):
    """Input time -> aware UTC datetime, or a date when allday."""
    if s is None:
        return None
    words = {"today": 0, "tomorrow": 1, "yesterday": -1}
    if s.lower() in words:
        d = today() + dt.timedelta(days=words[s.lower()])
        return d if allday else dt.datetime.combine(d, dt.time(), TZ).astimezone(UTC)
    try:
        t = dt.datetime.fromisoformat(s)
    except ValueError:
        fail(f"bad time {s!r}; use ISO 8601 such as 2026-10-02T14:00")
    if allday:
        return t.date()
    return (t if t.tzinfo else t.replace(tzinfo=TZ)).astimezone(UTC)


def is_date_only(s):
    return s is not None and (s.lower() in ("today", "tomorrow", "yesterday") or re.fullmatch(r"\d{4}-\d{2}-\d{2}", s))


def span(a, days=7):
    start = parse_t(a.from_) or parse_t("today")
    end = parse_t(a.to) if a.to else start + dt.timedelta(days=days)
    if is_date_only(a.to):
        end += dt.timedelta(days=1)  # --to 2026-10-08 includes that day
    return start, end


def local(v):
    """iCalendar value -> output string in local time."""
    if v is None:
        return None
    t = getattr(v, "dt", v)
    if isinstance(t, dt.datetime):
        t = t.astimezone(TZ) if t.tzinfo else t.replace(tzinfo=TZ)
        return t.isoformat(timespec="minutes")
    return t.isoformat()


def as_utc(t):
    """Comparable UTC datetime for a date or datetime."""
    if isinstance(t, dt.datetime):
        return (t if t.tzinfo else t.replace(tzinfo=TZ)).astimezone(UTC)
    return dt.datetime.combine(t, dt.time(), TZ).astimezone(UTC)


# ---------------------------------------------------------------- client


def client():
    import caldav

    url, user, pw = (os.environ.get(k) for k in ("CALDAV_URL", "CALDAV_USER", "CALDAV_PASSWORD"))
    if not (url and user and pw):
        fail("CALDAV_URL, CALDAV_USER and CALDAV_PASSWORD must be set in .env")
    return caldav.DAVClient(url=url, username=user, password=pw)


_cals = None


def calendars(c):
    global _cals
    if _cals is None:
        _cals = c.principal().calendars()
    return _cals


def seg(cal):
    return str(cal.url).rstrip("/").rsplit("/", 1)[-1]


def kinds(cal):
    try:
        return cal.get_supported_components() or ["VEVENT", "VTODO"]
    except Exception:
        return ["VEVENT", "VTODO"]


def pick(c, name, default):
    key = (name or default).strip("/").rsplit("/", 1)[-1] if (name or default).startswith("/") else (name or default)
    cals = calendars(c)
    hits = [x for x in cals if seg(x) == key] or [x for x in cals if x.name == key]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        fail(f"{key!r} is ambiguous; use a path: {[seg(x) for x in hits]}")
    fail(f"no calendar {key!r}; have: {[(x.name, seg(x)) for x in cals]}")


def selected(c, name, default, kind):
    if name == "all":
        return [x for x in calendars(c) if kind in kinds(x)]
    return [pick(c, name, default)]


def find(c, uid, name=None, kind="VEVENT"):
    """(calendar, object) for a UID, in --cal or in every calendar of that kind."""
    pool = [pick(c, name, name)] if name else [x for x in calendars(c) if kind in kinds(x)]
    for cal in pool:
        try:
            return cal, cal.object_by_uid(uid)
        except Exception:
            continue
    fail(f"no {'reminder' if kind == 'VTODO' else 'event'} with uid {uid}")


def master(obj, kind):
    """The series master (no RECURRENCE-ID) of a stored object."""
    comps = [x for x in obj.icalendar_instance.walk() if x.name == kind]
    return next((x for x in comps if "RECURRENCE-ID" not in x), comps[0])


# ---------------------------------------------------------------- components


def tags_of(v):
    cats = v.get("categories")
    if cats is None:
        return []
    items = cats if isinstance(cats, list) else [cats]
    return [str(t) for item in items for t in getattr(item, "cats", [item])]


def alarms_of(v):
    res = []
    for a in v.subcomponents:
        if a.name != "VALARM":
            continue
        trig = a.get("trigger")
        t = getattr(trig, "dt", None)
        if isinstance(t, dt.timedelta):
            res.append(int(-t.total_seconds() // 60))
        elif t is not None:
            res.append(local(t))
    return res


def ev_json(cal, v):
    start = v.get("dtstart")
    end = v.get("dtend")
    allday = start is not None and not isinstance(start.dt, dt.datetime)
    if allday and end is not None:  # iCalendar's DTEND is exclusive; report the last day
        end = end.dt - dt.timedelta(days=1)
    return {
        "cal": cal.name,
        "uid": str(v.get("uid")),
        "title": str(v.get("summary", "")),
        "start": local(start),
        "end": local(end),
        "allday": allday or None,
        "location": str(v.get("location", "")) or None,
        "desc": str(v.get("description", "")) or None,
        "rrule": v.get("rrule").to_ical().decode() if v.get("rrule") else None,
        "occurrence": local(v.get("recurrence-id")),
        "alarms": alarms_of(v),
        "tags": tags_of(v),
    }


def todo_json(cal, v):
    pr = v.get("priority")
    return {
        "cal": cal.name,
        "uid": str(v.get("uid")),
        "title": str(v.get("summary", "")),
        "due": local(v.get("due")),
        "status": str(v.get("status", "NEEDS-ACTION")),
        "priority": int(pr) if pr not in (None, 0, "0") else None,
        "desc": str(v.get("description", "")) or None,
        "rrule": v.get("rrule").to_ical().decode() if v.get("rrule") else None,
        "alarms": alarms_of(v),
        "tags": tags_of(v),
    }


def set_rrule(v, rule):
    from icalendar import vRecur

    if rule is None:
        return
    v.pop("rrule", None)
    if rule.strip():
        try:
            v.add("rrule", vRecur.from_ical(rule.removeprefix("RRULE:")))
        except Exception:
            fail(f"bad --rrule {rule!r}; example FREQ=WEEKLY;BYDAY=MO,WE")


def set_alarms(v, minutes, clear, title, due=None):
    from icalendar import Alarm

    if not minutes and not clear:
        return
    v.subcomponents = [s for s in v.subcomponents if s.name != "VALARM"]
    for m in minutes or []:
        a = Alarm()
        a.add("action", "DISPLAY")
        a.add("description", title or "Reminder")
        if due is not None:  # reminders: absolute time before the due date
            a.add("trigger", as_utc(due) - dt.timedelta(minutes=m), parameters={"VALUE": "DATE-TIME"})
        else:
            a.add("trigger", dt.timedelta(minutes=-m))
        v.add_component(a)


def set_text(v, field, value):
    if value is None:
        return
    v.pop(field, None)
    if value != "":
        v.add(field, value)


def set_tags(v, tags):
    if tags is None:
        return
    v.pop("categories", None)
    items = [t.strip() for t in tags.split(",") if t.strip()]
    if items:
        v.add("categories", items)


def set_priority(v, p):
    if p is None:
        return
    n = PRIORITY.get(p.lower()) if not p.isdigit() else int(p)
    if n is None or not 0 <= n <= 9:
        fail("--priority is high, medium, low or 0-9")
    v.pop("priority", None)
    if n:
        v.add("priority", n)


def new_cal(comp):
    from icalendar import Calendar

    cal = Calendar()
    cal.add("prodid", "-//pangpang//cal.py//EN")
    cal.add("version", "2.0")
    cal.add_component(comp)
    return cal.to_ical().decode()


# ---------------------------------------------------------------- reading


def expanded_events(cal, start, end):
    """(calendar, VEVENT occurrence) pairs within [start, end)."""
    res = []
    for obj in cal.search(event=True, start=start, end=end, expand=True):
        for v in obj.icalendar_instance.walk("VEVENT"):
            res.append((cal, v))
    return res


def event_bounds(v):
    s = v.get("dtstart").dt
    e = v.get("dtend").dt if v.get("dtend") else None
    if e is None:
        dur = v.get("duration")
        e = s + (dur.dt if dur else (dt.timedelta(days=1) if not isinstance(s, dt.datetime) else dt.timedelta(0)))
    return as_utc(s), as_utc(e)


def sub_load():
    try:
        return json.loads(SUBS.read_text())
    except Exception:
        return {}


def ics_fetch(src):
    if re.match(r"^(https?|webcal)://", src):
        req = urllib.request.Request(re.sub(r"^webcal://", "https://", src), headers={"User-Agent": "pangpang-cal"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    return pathlib.Path(src).read_bytes()


def sub_events(name, url, start, end):
    import icalendar, recurring_ical_events

    cal = icalendar.Calendar.from_ical(ics_fetch(url))
    for v in recurring_ical_events.of(cal).between(start, end):
        if v.name == "VEVENT":
            yield {**ev_json(type("S", (), {"name": f"订阅:{name}"})(), v), "readonly": True}


# ---------------------------------------------------------------- commands


def cmd_setup(c, a):
    home = c.principal()
    have = {seg(x) for x in home.calendars()}
    for s, name, kind in COLLECTIONS:
        if s in have:
            out({"exists": name, "path": s})
        else:
            home.make_calendar(name=name, cal_id=s, supported_calendar_component_set=[kind])
            out({"created": name, "path": s, "component": kind})


def cmd_calendars(c, a):
    for cal in calendars(c):
        out({"name": cal.name, "path": seg(cal), "components": kinds(cal)})


def cmd_mkcal(c, a):
    if not a.name or a.kind not in ("event", "todo"):
        fail("mkcal needs --name and --kind event|todo")
    s = re.sub(r"[^a-z0-9-]+", "-", a.name.lower()).strip("-") or uuid.uuid4().hex[:12]
    if any(seg(x) == s for x in calendars(c)):
        s = f"{s}-{uuid.uuid4().hex[:6]}"
    c.principal().make_calendar(name=a.name, cal_id=s, supported_calendar_component_set=["VEVENT" if a.kind == "event" else "VTODO"])
    out({"created": a.name, "path": s})


def cmd_rename(c, a):
    from caldav.elements import dav

    cal = pick(c, a.cal, a.cal)
    cal.set_properties([dav.DisplayName(a.name)])
    out({"renamed": seg(cal), "name": a.name})


def cmd_delcal(c, a):
    if not a.yes:
        fail("delcal deletes every item in the calendar; pass --yes after the owner confirmed")
    cal = pick(c, a.cal, a.cal)
    name = cal.name
    cal.delete()
    out({"deleted_calendar": name, "path": seg(cal)})


def cmd_events(c, a):
    start, end = span(a)
    rows = []
    for cal in selected(c, a.cal, EVENT_CAL, "VEVENT"):
        rows += expanded_events(cal, start, end)
    for cal, v in sorted(rows, key=lambda r: event_bounds(r[1])[0]):
        out(ev_json(cal, v))


def cmd_agenda(c, a):
    start, end = span(a, days=1)
    rows = []
    for cal in [x for x in calendars(c) if "VEVENT" in kinds(x)]:
        rows += [(event_bounds(v)[0], ev_json(cal, v)) for cal, v in expanded_events(cal, start, end)]
    for cal in [x for x in calendars(c) if "VTODO" in kinds(x)]:
        for obj in cal.todos(include_completed=False):
            v = master(obj, "VTODO")
            due = v.get("due")
            if due is not None and start <= as_utc(due.dt) < end or due is not None and as_utc(due.dt) < start:
                rows.append((as_utc(due.dt), {**todo_json(cal, v), "overdue": as_utc(due.dt) < start or None}))
    for name, url in sub_load().items():
        try:
            rows += [(parse_t(e["start"]) if "T" in e["start"] else as_utc(dt.date.fromisoformat(e["start"])), e) for e in sub_events(name, url, start, end)]
        except Exception as err:
            rows.append((start, {"cal": f"订阅:{name}", "error": str(err)}))
    for _, row in sorted(rows, key=lambda r: r[0]):
        out(row)


def cmd_search(c, a):
    if not a.q:
        fail("search needs --q")
    q = a.q.lower()
    start = parse_t(a.from_) or parse_t("today") - dt.timedelta(days=30)
    end = parse_t(a.to) or start + dt.timedelta(days=400)
    hit = lambda v: any(q in str(v.get(f, "")).lower() for f in ("summary", "description", "location"))
    for cal in calendars(c):
        ks = kinds(cal)
        if "VEVENT" in ks:
            seen = set()
            for cal_, v in expanded_events(cal, start, end):
                if hit(v) and str(v.get("uid")) not in seen:  # a series once, at its next occurrence
                    seen.add(str(v.get("uid")))
                    out(ev_json(cal_, v))
        if "VTODO" in ks:
            for obj in cal.todos(include_completed=True):
                v = master(obj, "VTODO")
                if hit(v):
                    out(todo_json(cal, v))


def cmd_free(c, a):
    start, end = span(a, days=1)
    minimum = dt.timedelta(minutes=int(a.min or 30))
    ds = dt.time.fromisoformat(a.day_start or "09:00")
    de = dt.time.fromisoformat(a.day_end or "21:00")
    busy = []
    cals = selected(c, a.cal, None, "VEVENT") if a.cal else [x for x in calendars(c) if "VEVENT" in kinds(x)]
    for cal in cals:
        for _, v in expanded_events(cal, start, end):
            if str(v.get("transp", "")).upper() == "TRANSPARENT" or not isinstance(v.get("dtstart").dt, dt.datetime):
                continue  # free-time and all-day events do not block
            busy.append(event_bounds(v))
    busy.sort()
    day = start.astimezone(TZ).date()
    while dt.datetime.combine(day, dt.time(), TZ).astimezone(UTC) < end:
        lo = max(dt.datetime.combine(day, ds, TZ).astimezone(UTC), start)
        hi = min(dt.datetime.combine(day, de, TZ).astimezone(UTC), end)
        cur = lo
        for bs, be in busy:
            if be <= cur or bs >= hi:
                continue
            if bs - cur >= minimum:
                out({"free_from": local(cur), "free_to": local(bs), "minutes": int((bs - cur).total_seconds() // 60)})
            cur = max(cur, be)
        if hi - cur >= minimum:
            out({"free_from": local(cur), "free_to": local(hi), "minutes": int((hi - cur).total_seconds() // 60)})
        day += dt.timedelta(days=1)


def cmd_add(c, a):
    from icalendar import Event

    if not (a.title and a.start):
        fail("add needs --title and --start")
    allday = a.allday or (is_date_only(a.start) and (is_date_only(a.end) if a.end else not a.duration))
    start = parse_t(a.start, allday)
    if a.end:
        end = parse_t(a.end, allday)
        if allday and is_date_only(a.end):
            end += dt.timedelta(days=1)  # --end is the last day, inclusive
    else:
        end = start + (dt.timedelta(days=1) if allday else dt.timedelta(minutes=int(a.duration or 60)))
    v = Event()
    v.add("uid", str(uuid.uuid4()))
    v.add("dtstamp", dt.datetime.now(UTC))
    v.add("summary", a.title)
    v.add("dtstart", start)
    v.add("dtend", end)
    set_text(v, "description", a.desc)
    set_text(v, "location", a.location)
    set_rrule(v, a.rrule)
    set_tags(v, a.tags)
    set_alarms(v, a.alarm, False, a.title)
    cal = pick(c, a.cal, EVENT_CAL)
    cal.add_event(new_cal(v))
    out({"added": True, **ev_json(cal, v)})


def cmd_update(c, a):
    cal, obj = find(c, a.uid, a.cal, "VEVENT")
    v = master(obj, "VEVENT")
    allday = a.allday or not isinstance(v.get("dtstart").dt, dt.datetime)
    if a.start:
        old_s, old_e = v.get("dtstart").dt, v.get("dtend").dt if v.get("dtend") else None
        new_s = parse_t(a.start, allday)
        v.pop("dtstart")
        v.add("dtstart", new_s)
        if not a.end and old_e is not None:  # keep the duration when only the start moves
            v.pop("dtend")
            v.add("dtend", new_s + (as_utc(old_e) - as_utc(old_s) if not allday else (old_e - old_s)))
    if a.end:
        e = parse_t(a.end, allday)
        if allday and is_date_only(a.end):
            e += dt.timedelta(days=1)
        v.pop("dtend", None)
        v.add("dtend", e)
    set_text(v, "summary", a.title)
    set_text(v, "description", a.desc)
    set_text(v, "location", a.location)
    set_rrule(v, a.rrule)
    set_tags(v, a.tags)
    set_alarms(v, a.alarm, a.no_alarm, str(v.get("summary", "")))
    v.pop("dtstamp", None)
    v.add("dtstamp", dt.datetime.now(UTC))
    if a.move_to:
        dest = pick(c, a.move_to, a.move_to)
        dest.add_event(obj.icalendar_instance.to_ical().decode())
        obj.delete()
        cal = dest
    else:
        obj.save()
    out({"updated": True, **ev_json(cal, v)})


def cmd_delete(c, a):
    cal, obj = find(c, a.uid, a.cal, "VEVENT")
    if a.occurrence:
        v = master(obj, "VEVENT")
        if not v.get("rrule"):
            fail("--occurrence is only for recurring events")
        allday = not isinstance(v.get("dtstart").dt, dt.datetime)
        when = parse_t(a.occurrence, allday)
        if not allday and is_date_only(a.occurrence):  # a date: that day's occurrence time
            s = v.get("dtstart").dt
            when = dt.datetime.combine(dt.date.fromisoformat(a.occurrence), as_utc(s).astimezone(TZ).timetz()).astimezone(UTC)
        v.add("exdate", when)
        obj.save()
        out({"skipped_occurrence": local(when), "uid": a.uid, "cal": cal.name})
    else:
        obj.delete()
        out({"deleted": a.uid, "cal": cal.name})


def cmd_todos(c, a):
    for cal in selected(c, a.cal, TODO_CAL, "VTODO"):
        rows = [master(o, "VTODO") for o in cal.todos(include_completed=a.all)]
        rows.sort(key=lambda v: (v.get("due") is None, as_utc(v["due"].dt) if v.get("due") else 0, int(v.get("priority", 0) or 10)))
        for v in rows:
            out(todo_json(cal, v))


def cmd_todo_add(c, a):
    from icalendar import Todo

    if not a.title:
        fail("todo-add needs --title")
    v = Todo()
    v.add("uid", str(uuid.uuid4()))
    v.add("dtstamp", dt.datetime.now(UTC))
    v.add("summary", a.title)
    v.add("status", "NEEDS-ACTION")
    due = parse_t(a.due, is_date_only(a.due)) if a.due else None
    if due is not None:
        v.add("due", due)
    set_text(v, "description", a.desc)
    set_priority(v, a.priority)
    set_rrule(v, a.rrule)
    set_tags(v, a.tags)
    if a.alarm and due is None:
        fail("--alarm on a reminder needs --due")
    set_alarms(v, a.alarm, False, a.title, due)
    cal = pick(c, a.cal, TODO_CAL)
    cal.add_todo(new_cal(v))
    out({"added": True, **todo_json(cal, v)})


def cmd_todo_update(c, a):
    cal, obj = find(c, a.uid, a.cal, "VTODO")
    v = master(obj, "VTODO")
    if a.due is not None:
        old = v.get("due").dt if v.get("due") else None
        v.pop("due", None)
        if a.due:
            v.add("due", parse_t(a.due, is_date_only(a.due)))
            if old is not None and not a.alarm and not a.no_alarm:  # alarms keep their lead time
                shift = as_utc(v.get("due").dt) - as_utc(old)
                for al in (x for x in v.subcomponents if x.name == "VALARM"):
                    t = al.get("trigger").dt
                    if isinstance(t, dt.datetime):
                        al.pop("trigger")
                        al.add("trigger", as_utc(t) + shift, parameters={"VALUE": "DATE-TIME"})
    set_text(v, "summary", a.title)
    set_text(v, "description", a.desc)
    set_priority(v, a.priority)
    set_rrule(v, a.rrule)
    set_tags(v, a.tags)
    due = v.get("due").dt if v.get("due") else None
    if a.alarm and due is None:
        fail("--alarm on a reminder needs a due date")
    set_alarms(v, a.alarm, a.no_alarm, str(v.get("summary", "")), due)
    v.pop("dtstamp", None)
    v.add("dtstamp", dt.datetime.now(UTC))
    if a.move_to:
        dest = pick(c, a.move_to, a.move_to)
        dest.add_todo(obj.icalendar_instance.to_ical().decode())
        obj.delete()
        cal = dest
    else:
        obj.save()
    out({"updated": True, **todo_json(cal, v)})


def next_due(v):
    """Next DUE of a repeating reminder after now, or None when it does not repeat."""
    due = v.get("due")
    if due is None or not v.get("rrule"):
        return None
    from dateutil.rrule import rrulestr

    d = due.dt
    date_only = not isinstance(d, dt.datetime)
    base = dt.datetime.combine(d, dt.time()).replace(tzinfo=UTC) if date_only else d
    rule = rrulestr("RRULE:" + v.get("rrule").to_ical().decode(), dtstart=base)
    nxt = rule.after(dt.datetime.now(base.tzinfo), inc=False)
    return nxt.date() if date_only and nxt else nxt


def cmd_todo_status(c, a, done):
    cal, obj = find(c, a.uid, a.cal, "VTODO")
    v = master(obj, "VTODO")
    nxt = next_due(v) if done else None
    if nxt is not None:
        # A repeating reminder advances to its next due date instead of completing
        # the whole series; its alarms keep their lead time.
        shift = as_utc(nxt) - as_utc(v.get("due").dt)
        v.pop("due", None)
        v.add("due", nxt)
        for al in (x for x in v.subcomponents if x.name == "VALARM"):
            t = al.get("trigger").dt
            if isinstance(t, dt.datetime):
                al.pop("trigger")
                al.add("trigger", as_utc(t) + shift, parameters={"VALUE": "DATE-TIME"})
        for f in ("completed", "percent-complete", "status"):
            v.pop(f, None)
        v.add("status", "NEEDS-ACTION")
        v.pop("dtstamp", None)
        v.add("dtstamp", dt.datetime.now(UTC))
        obj.save()
        out({"completed": a.uid, "cal": cal.name, "next": local(v.get("due"))})
    elif done:
        obj.complete()
        out({"completed": a.uid, "cal": cal.name})
    else:
        v = master(obj, "VTODO")
        for f in ("completed", "percent-complete"):
            v.pop(f, None)
        v.pop("status", None)
        v.add("status", "NEEDS-ACTION")
        obj.save()
        out({"reopened": a.uid, "cal": cal.name})


def cmd_todo_delete(c, a):
    cal, obj = find(c, a.uid, a.cal, "VTODO")
    obj.delete()
    out({"deleted": a.uid, "cal": cal.name})


def cmd_export(c, a):
    cal = pick(c, a.cal, a.cal)
    data = c.request(str(cal.url), "GET").raw
    data = data.decode() if isinstance(data, bytes) else data
    if a.out:
        pathlib.Path(a.out).write_text(data)
        out({"exported": cal.name, "file": a.out, "items": data.count("BEGIN:VEVENT") + data.count("BEGIN:VTODO")})
    else:
        sys.stdout.write(data)


def cmd_import(c, a):
    import icalendar

    if not (a.file and a.cal):
        fail("import needs --file and --cal")
    src = icalendar.Calendar.from_ical(ics_fetch(a.file))
    tzs = [x for x in src.walk("VTIMEZONE")]
    groups = {}
    for comp in src.subcomponents:
        if comp.name in ("VEVENT", "VTODO"):
            groups.setdefault((comp.name, str(comp.get("uid") or uuid.uuid4())), []).append(comp)
    cal = pick(c, a.cal, a.cal)
    n = 0
    for (kind, _), comps in groups.items():
        if kind not in kinds(cal):
            continue
        ical = icalendar.Calendar()
        ical.add("prodid", "-//pangpang//cal.py//EN")
        ical.add("version", "2.0")
        for z in tzs:
            ical.add_component(z)
        for comp in comps:
            ical.add_component(comp)
        (cal.add_event if kind == "VEVENT" else cal.add_todo)(ical.to_ical().decode())
        n += 1
    out({"imported": n, "cal": cal.name, "skipped_kinds": len(groups) - n})


def cmd_sub(c, a):
    subs = sub_load()
    if a.cmd == "sub-add":
        if not (a.name and a.url):
            fail("sub-add needs --name and --url")
        ics_fetch(a.url)  # fail now, not at the next agenda
        subs[a.name] = a.url
    elif a.cmd == "sub-remove":
        if subs.pop(a.name, None) is None:
            fail(f"no subscription {a.name!r}")
    elif a.cmd == "sub-list":
        for name, url in subs.items():
            out({"name": name, "url": url})
        return
    elif a.cmd == "sub-events":
        start, end = span(a)
        for name, url in subs.items():
            if a.name and name != a.name:
                continue
            for e in sorted(sub_events(name, url, start, end), key=lambda e: e["start"]):
                out(e)
        return
    SUBS.parent.mkdir(parents=True, exist_ok=True)
    SUBS.write_text(json.dumps(subs, ensure_ascii=False, indent=2) + "\n")
    out({"added" if a.cmd == "sub-add" else "removed": a.name})


def main():
    p = argparse.ArgumentParser(usage=__doc__)
    p.add_argument("cmd")
    for f in ("--cal", "--to", "--title", "--start", "--end", "--desc", "--location", "--uid", "--due",
              "--q", "--min", "--day-start", "--day-end", "--duration", "--rrule", "--tags", "--priority",
              "--move-to", "--occurrence", "--name", "--kind", "--file", "--url", "--out"):
        p.add_argument(f)
    p.add_argument("--from", dest="from_")
    p.add_argument("--alarm", type=int, action="append")
    for f in ("--allday", "--all", "--no-alarm", "--yes"):
        p.add_argument(f, action="store_true")
    a = p.parse_args()
    if a.cmd.startswith("sub-"):
        return cmd_sub(None, a)  # subscriptions need no CalDAV login
    table = {
        "setup": cmd_setup, "calendars": cmd_calendars, "mkcal": cmd_mkcal, "rename": cmd_rename,
        "delcal": cmd_delcal, "events": cmd_events, "agenda": cmd_agenda, "search": cmd_search,
        "free": cmd_free, "add": cmd_add, "update": cmd_update, "delete": cmd_delete,
        "todos": cmd_todos, "todo-add": cmd_todo_add, "todo-update": cmd_todo_update,
        "todo-done": lambda c, a: cmd_todo_status(c, a, True),
        "todo-undo": lambda c, a: cmd_todo_status(c, a, False),
        "todo-delete": cmd_todo_delete, "export": cmd_export, "import": cmd_import,
    }
    if a.cmd not in table:
        sys.exit(__doc__)
    table[a.cmd](client(), a)


if __name__ == "__main__":
    main()
