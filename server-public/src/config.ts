// Paths and settings for pangpangd.
//
// Private runtime data stays out of version control:
//   agent/memory, agent/skills   what the agent learns
//   data/tasks, data/hooks       scheduled tasks and webhook definitions
//   data/chats                   attachments and working files (logs stay local)
// Rebuildable or disposable state stays in the untracked var/ directory:
// the search index, the Telegram offset, locks, logs and caches.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set; run pangpangd through \`pp up\``);
	return value;
}

export const PP_HOME = required("PP_HOME");
export const PP_VAR = required("PP_VAR");
export const AGENT_DIR = required("PI_CODING_AGENT_DIR");

/** Private data directory; tests point PP_DATA at a scratch copy. */
const workspace = process.env.PP_DATA ?? join(PP_HOME, "data");

export const paths = {
	workspace,
	/** MEMORY.md and USER.md, curated by the memory tool; private. */
	memories: join(AGENT_DIR, "memory"),
	/** The skill library, maintained by the agent; private by default. */
	skills: join(AGENT_DIR, "skills"),
	/** Task model: one JSON file per scheduled task (cron or one-shot). */
	tasks: join(workspace, "tasks"),
	/** Event model: one JSON file per webhook. */
	hooks: join(workspace, "hooks"),
	/** Run history of tasks and hooks. */
	automationLog: join(PP_VAR, "logs", "automation.jsonl"),
	/** One directory per Telegram chat. */
	chats: join(workspace, "chats"),
	/** Full-text index over every chat log; rebuilt from the logs if missing. */
	searchDb: join(PP_VAR, "search.sqlite"),
	/** Recall chunks, lexical index and semantic neighbours; rebuilt from logs and skills if missing. */
	recallDb: join(PP_VAR, "recall.sqlite"),
	/** Last processed Telegram update id. */
	telegramOffset: join(PP_VAR, "run", "telegram-offset"),
	/** Present while the owner has paused autonomous activity. */
	pausedFlag: join(PP_VAR, "run", "paused"),
	/** Created by `pp request-restart`; the daemon restarts once every chat is idle. */
	restartFlag: join(PP_VAR, "run", "restart-requested"),
};

export function chatDir(chatId: string): string {
	return join(paths.chats, chatId);
}

export function ensureDirs(): void {
	for (const dir of [paths.memories, paths.skills, paths.tasks, paths.hooks, paths.chats, join(PP_VAR, "run"), join(PP_VAR, "logs")]) {
		mkdirSync(dir, { recursive: true });
	}
}

function intEnv(name: string, fallback: number): number {
	const n = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const settings = {
	telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
	/** Telegram user ids allowed to talk to the agent. */
	allowedUsers: new Set(
		(process.env.TELEGRAM_ALLOWED_USERS ?? "")
			.split(/[,\s]+/)
			.filter(Boolean)
			.map((id) => id.trim()),
	),
	/** Where automation delivers when an action names no chat: PP_NOTIFY_CHAT, else the owner's DM. */
	notifyChat: process.env.PP_NOTIFY_CHAT ?? "",
	/** Character budgets for the two memory stores (Hermes defaults). */
	memoryCharLimit: intEnv("PP_MEMORY_CHAR_LIMIT", 2200),
	userCharLimit: intEnv("PP_USER_CHAR_LIMIT", 1375),
	/** Background review runs after this much idle time... */
	reviewIdleMs: intEnv("PP_REVIEW_IDLE_SECONDS", 300) * 1000,
	/** ...once at least this many tool calls or user turns have accumulated. */
	reviewMinToolCalls: intEnv("PP_REVIEW_MIN_TOOL_CALLS", 5),
	reviewMinUserTurns: intEnv("PP_REVIEW_MIN_USER_TURNS", 6),
	/** Webhook listener port and fallback token for hooks without their own. */
	hookPort: intEnv("PP_HOOK_PORT", 18790),
	hookToken: process.env.PP_HOOK_TOKEN ?? "",
	/** Characters of automatic recall appended to an owner message; PP_RECALL=off disables it. */
	recallChars: process.env.PP_RECALL === "off" ? 0 : intEnv("PP_RECALL_CHARS", 900),
};

/** The chat that automation delivers to by default: PP_NOTIFY_CHAT, else the first allowed user. */
export function ownerChatId(): string | undefined {
	return settings.notifyChat || settings.allowedUsers.values().next().value;
}
