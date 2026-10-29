---
name: musings
description: Record the owner's 碎碎念 - casual remarks, thoughts and loose "我之后想做X" intentions - in the append-only notebook data/musings/<YYYY-MM>.md. Use when the owner says 记一下 / 记到碎碎念本本里 / 不用放日程, or muses in chat and expects it kept.
---

# 碎碎念本 (musing notebook)

`$PP_HOME/data/musings/<YYYY-MM>.md` - one file per owner-local month, plain markdown,
kept private and excluded from the public repository.

## Write

- Append only: never rewrite or reorder earlier entries - add the new bullet at the END of the
  day's list in arrival order, never inserted mid-list to keep the `HH:MM` ascending.
- Add a `## YYYY-MM-DD` heading if the day is not in the file yet; entries are
  `- HH:MM <text>` in owner-local time (`TZ_NAME`, +08:00), one bullet per remark.
- Create the file on first use: a one-line header saying it is append-only, owner-local,
  not a schedule, then the day heading.
- Keep the owner's own words and the specifics they gave; do not rewrite a remark into a
  task and do not merge several remarks into one. Bold only the fragment worth finding again.
- Same session, several remarks: append in arrival order as they come.

## Dropped ideas

The owner abandons a musing ("以后都不做了", "这个不搞了", "不做了"): append one line saying so
(`- HH:MM 「<idea>」这个想法放弃——以后都不做了（不再提醒、不再提方案）`) and leave the original
entry untouched. The notebook is exactly what you read back when the owner asks for ideas or when
you recall earlier intentions, so that negative line is the only thing that stops an abandoned plan
from being proposed again months later. Do not delete or edit the original bullet - append-only is
what makes the pair readable as history.

## Where it goes

- Default: a remark with no request attached is a musing -> notebook.
- The owner asks to be reminded, or names a date/time -> calendar/reminder (see the
  `calendar` skill). An intention in the notebook is not a commitment; never quietly
  promote a musing into a reminder.
- Already put it in the calendar and the owner answers "记到碎碎念本本里就行" / "不用放到日程中":
  delete that calendar item and move the text into the notebook, then say both happened.
- Durable preferences or environment facts the owner states still go to the memory tool,
  not into the notebook.

## Read back

- Grep the whole notebook, not just the current month: `grep -n "<关键词>|课|想" data/musings/*.md`
  (use several keyword variants - the owner's later wording differs from the entry's).
- Also grep the raw chat logs, because a remark can live only in chat and never have been
  written down:

  ```bash
  grep -h "关键词" data/chats/*/log.jsonl \
    | jq -r 'select(.role=="user") | (.date+"  "+((.text//"")|gsub("\n";" | ")))'
  ```

  Flag those separately as "聊天里说过但本子里没记", do not present them as notebook entries.
- Say which file/date each hit comes from, and quote the owner's original wording.
- Before concluding "只有这两条", confirm nothing was deleted: `git log --oneline -- data/musings`
  (the file is append-only, so history should show only additions).
- Separate genuine musings from items already promoted to tasks/reminders: a report, a
  reminder or a deadline is not a 碎碎念, mention it as "相关但不算碎碎念，已在跟" instead.
