---
name: telegram-bot
description: Operate pangpang's own Telegram bot - why it does or does not see messages (BotFather privacy mode, allowed users), learning a chat id, where chat routing lives, and how to apply code changes to the running daemon. Use when the owner says the bot ignores messages, wants it in a group, asks what to call it, or wants notifications/replies to land in a specific chat.
---

# Telegram bot

Config in `$PP_HOME/.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `PP_NOTIFY_CHAT`);
plumbing in `src/telegram.ts` (getUpdates/parseMessage), `src/daemon.ts` (message gate),
`src/config.ts` (`settings.notifyChat`). Per-chat state: `data/chats/<chatId>/`.

Check what the bot can actually do before theorising:

```bash
cd $PP_HOME && set -a; . ./.env; set +a
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe" \
  | jq -c '.result|{id,username,can_join_groups,can_read_all_group_messages}'
```

## Bot sees nothing in a group

`can_read_all_group_messages: false` is BotFather **privacy mode**: Telegram delivers only
messages that @mention the bot or reply to one of its messages, and the group member list
shows the bot as "无权读取消息". No code change can fix this and the bot must not be
re-added hoping it helps - the account owner has to run `/setprivacy` -> pick the bot ->
**Disable** in @BotFather. After that any ordinary message in the group arrives.

- A mention must be a real mention entity (picked from the autocomplete or the exact
  `@username`); a display name typed by hand is not a mention and never reaches the bot.
- Only the owner's Telegram account can change bot settings; ask, do not promise it works
  until a real message shows up in the log.
- The bot's display name (e.g. ExampleBot) is the owner's choice in BotFather and is what the group
  shows; the agent's own name stays pangpang.

## Who gets answered

The gate is the **sender's user id** (`TELEGRAM_ALLOWED_USERS`), not the chat. So once
delivery works, an allowed user's message in any group the bot is in is processed and
replied to in that chat; everyone else is ignored with a log line. Re-read `.env` before
reporting the allow list - the owner edits it in the background.

## Learn a chat id

Do not call `getUpdates` yourself: the daemon holds the long poll and would race it. Read
the log instead (`var/logs/pangpangd.log`):

- `message from <name> in group <chatId> "<title>"` - delivered group message
- `ignored message from <id> (<name>) in group <chatId>` - not an allowed sender
- `bot added to chat in group <id>` - membership service message (name only appears here)

Never add a chat-id allowlist before the id is known, or nothing arrives to discover it.

A photo or file the owner sends arrives as a user entry `<attachment>/abs/path</attachment>`
stored under `data/chats/<chatId>/attachments/`, which is how "提醒一下这个图片" is resolved:
`ls -lt data/chats/<chatId>/attachments | head` for the newest file.

## The bot sent the owner something odd

What went out is in `data/chats/<chatId>/log.jsonl` (`{"role":"assistant","text":"..."}`, the
delivered text) and what the daemon did is in `var/logs/pangpangd.log`. Two shapes recur:

- `empty reply; asking for the final answer`: the model ended its turn with thinking only, so the
  daemon re-prompts once instead of sending "(no reply)" (`src/conversation.ts`). That retry's text
  goes out verbatim, so a model that narrates its own answer ("Give the final answer again. ...")
  leaks the narration into the owner's message. Guard against it in `src/prompts.ts` (state that
  every character of a turn's text reaches the owner) and keep the re-ask wording explicit.
- Two assistant entries seconds apart, the first with `text: ""`, are that retry pair: read the
  neighbouring entries, not only the last one, before concluding a reply was never sent.
- Every character of a turn's text is the owner's message: planning chatter and self-notes
  ("Done.", "Now reply.", "Hmm, short.") leak verbatim, so a "why did you send me so much?"
  complaint is usually the model's own scaffolding, not the daemon. Check the assistant entries
  around the timestamp before blaming `src/`, and keep replies to the final answer only.
- The quoted text in the daemon log line is not a reliable copy of the owner's message (a
  following/multi-line one can show up garbled or as a single word) - read their actual words in
  `log.jsonl` before acting on them.
- Diagnostic loop for "what did you just send me": tail `log.jsonl` for the text, grep the daemon
  log for the turn's timestamp, then compare with what the owner reports seeing.

## Applying code changes

`src/` edits need the daemon restarted - `pp request-restart` (takes effect once chats are
idle, last action of the turn), then confirm in the log: `connected as @<bot>; owners ...`.
Gate before committing: `pp check`, then smoke with a fresh scratch dir:

```bash
rm -rf var/tmp/smoke && PP_VAR=$PWD/var/tmp/smoke node test/smoke.ts
```

Related: automation/notification `chat` routing and `run`/`notify` actions live in the
`scheduled-tasks` skill; the daemon never prints the bot token - read it from `.env` without
echoing it.
