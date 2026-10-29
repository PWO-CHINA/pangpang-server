// pangpangd: the long-running agent.  Started by `pp up`; logs to stdout.
//
// Telegram messages from allowed users go through the command system
// (src/commands.ts) or to one Conversation per chat.  Scheduled tasks and
// inbound webhooks (src/automation/) run actions that only call the model
// when they need to.  SIGTERM stops polling, aborts running turns
// and disposes sessions before exiting.  `pp request-restart` asks for a
// restart once every chat is idle (exit code 75), so the agent can reload
// its own code without cutting off the reply it is writing.

/** Exit code that tells the supervisor to restart at once, without backoff. */
const RESTART_EXIT = 75;

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureDirs, ownerChatId, paths, settings } from "./config.ts";
import { Conversation } from "./conversation.ts";
import type { ActionRuntime } from "./automation/actions.ts";
import { HookServer } from "./automation/hooks.ts";
import { TaskScheduler } from "./automation/tasks.ts";
import { handleCommand, MENU } from "./commands.ts";
import { cancelAll as cancelDelegations } from "./delegate/jobs.ts";
import { AGENT_GIT_ENV, commitData } from "./git.ts";
import { errorText, log } from "./log.ts";
import { Reviewer } from "./review.ts";
import { closeRecall } from "./recall.ts";
import { closeSearch } from "./search.ts";
import { type IncomingMessage, Telegram } from "./telegram.ts";

async function main(): Promise<void> {
	if (!settings.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is not set (see .env.example)");
	if (settings.allowedUsers.size === 0) throw new Error("TELEGRAM_ALLOWED_USERS is not set (see .env.example)");
	ensureDirs();
	// Commits the agent makes from its bash tool are authored by pangpang.
	Object.assign(process.env, AGENT_GIT_ENV);

	const tg = new Telegram(settings.telegramToken);
	const me = await tg.call<{ username: string }>("getMe");
	await tg.call("setMyCommands", { commands: MENU }).catch((err) => log.warn("telegram", "setMyCommands failed", errorText(err)));
	log.info("daemon", `connected as @${me.username}; owners ${[...settings.allowedUsers].join(", ")}`);

	const reviewer = new Reviewer(tg);
	const conversations = new Map<string, Promise<Conversation>>();
	const open = new Set<Conversation>();
	const conversation = (chatId: string): Promise<Conversation> => {
		let conv = conversations.get(chatId);
		if (!conv) {
			conv = Conversation.open(chatId, tg, reviewer);
			conv.then((c) => open.add(c)).catch(() => conversations.delete(chatId));
			conversations.set(chatId, conv);
		}
		return conv;
	};

	const actions: ActionRuntime = {
		notify: async (chatId, text) => {
			await tg.send(chatId, text);
		},
		wake: async (chatId, text) => {
			const conv = await conversation(chatId);
			await conv.handle({ text, name: "event", date: new Date(), isEvent: true });
		},
		defaultChat: ownerChatId,
	};
	const tasks = new TaskScheduler(actions);
	const hooks = new HookServer(actions);

	async function onMessage(m: IncomingMessage): Promise<void> {
		const where = m.chatType && m.chatType !== "private" ? ` in ${m.chatType} ${m.chatId}${m.chatTitle ? ` "${m.chatTitle}"` : ""}` : "";
		if (m.service) {
			log.info("telegram", `bot ${m.service}${where} by ${m.fromName}`);
			return;
		}
		if (!settings.allowedUsers.has(m.fromId)) {
			log.warn("telegram", `ignored message from ${m.fromId} (${m.fromName})${where}`);
			return;
		}
		if (where) log.info("telegram", `message from ${m.fromName}${where}`);
		const conv = await conversation(m.chatId);
		if (await handleCommand(m.text, { tg, conv, tasks, chatId: m.chatId, fromId: m.fromId })) return;

		let text = m.text;
		let images;
		const file = m.document ?? (m.photoFileId ? { fileId: m.photoFileId, fileName: "photo.jpg" } : undefined);
		if (file) {
			try {
				const saved = await conv.saveAttachment(file.fileId, file.fileName);
				images = saved.image;
				text = `${text}\n\n<attachment>${saved.path}</attachment>`.trim();
			} catch (err) {
				text = `${text}\n\n(attachment download failed: ${errorText(err)})`.trim();
			}
		}
		await conv.handle({ text, name: m.fromName, date: m.date, images });
	}

	const stop = new AbortController();
	let offset = existsSync(paths.telegramOffset) ? Number(readFileSync(paths.telegramOffset, "utf8")) || 0 : 0;
	const polling = tg.poll(
		offset,
		(m) => {
			onMessage(m).catch((err) => {
				log.error("daemon", "message handling failed", err);
				tg.send(m.chatId, `⚠️ ${errorText(err)}`).catch(() => {});
			});
		},
		(next) => {
			offset = next;
			writeFileSync(paths.telegramOffset, String(next));
		},
		stop.signal,
	);
	tasks.start();
	hooks.start();

	let stopping = false;
	const shutdown = async (reason: string, code = 0) => {
		if (stopping) return;
		stopping = true;
		log.info("daemon", `${reason}: shutting down`);
		stop.abort();
		tasks.stop();
		hooks.stop();
		cancelDelegations();
		reviewer.cancelAll();
		for (const pending of conversations.values()) {
			try {
				const conv = await pending;
				await conv.abort();
				conv.dispose();
			} catch {
				// Failed to open; nothing to clean up.
			}
		}
		closeSearch();
		closeRecall();
		await commitData();
		log.info("daemon", "stopped");
		process.exit(code);
	};
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));

	setInterval(() => void commitData(), 60 * 60 * 1000).unref();

	setInterval(() => {
		if (!existsSync(paths.restartFlag) || [...open].some((c) => c.busy)) return;
		try {
			unlinkSync(paths.restartFlag);
		} catch {
			// Already consumed.
		}
		void shutdown("restart requested", RESTART_EXIT);
	}, 5000).unref();

	await polling;
}

main().catch((err) => {
	log.error("daemon", "fatal", err);
	process.exit(1);
});
