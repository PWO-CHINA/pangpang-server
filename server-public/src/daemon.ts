// Client conversations retain their own context; autonomous output uses the notification pool.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureDirs, ownerChatId, paths, PP_VAR, settings } from "./config.ts";
import { Conversation } from "./conversation.ts";
import type { ActionRuntime } from "./automation/actions.ts";
import { HookServer } from "./automation/hooks.ts";
import { TaskScheduler } from "./automation/tasks.ts";
import { NotificationPool } from "./channels/notification-pool.ts";
import { WeixinClient } from "./channels/weixin.ts";
import type { ChatTransport, ClientChannel, NotificationSink } from "./channels/types.ts";
import { handleCommand, MENU } from "./commands.ts";
import { cancelAll as cancelDelegations } from "./delegate/jobs.ts";
import { AGENT_GIT_ENV, commitData } from "./git.ts";
import { errorText, log } from "./log.ts";
import { Reviewer } from "./review.ts";
import { closeRecall } from "./recall.ts";
import { closeSearch } from "./search.ts";
import { type IncomingMessage, Telegram } from "./telegram.ts";

const RESTART_EXIT = 75;

async function main(): Promise<void> {
	if (!settings.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is not set (see .env.example)");
	if (settings.allowedUsers.size === 0) throw new Error("TELEGRAM_ALLOWED_USERS is not set (see .env.example)");
	ensureDirs();
	Object.assign(process.env, AGENT_GIT_ENV);
	const tg = new Telegram(settings.telegramToken);
	await tg.call("setMyCommands", { commands: MENU }, AbortSignal.timeout(15_000))
		.catch((err) => log.warn("telegram", "menu unavailable; polling will retry connectivity", errorText(err)));
	const wx = await WeixinClient.load().catch((err) => {
		log.warn("weixin", "not available; Telegram remains active", errorText(err));
		return undefined;
	});
	const pool = new NotificationPool({
		telegram: tg, telegramChatId: ownerChatId()!,
		weixin: wx ? { transport: wx, chatId: wx.ownerId } : undefined,
		stateDir: join(PP_VAR, "notify", "client-pool"),
		settingsFile: join(paths.workspace, "channel-pool.json"),
	});
	const reviewer = new Reviewer(tg, pool);
	const conversations = new Map<string, Promise<Conversation>>();
	const open = new Set<Conversation>();
	const conversation = (key: string, transport: ChatTransport, recipient: string, channel?: ClientChannel,
		notifications: NotificationSink = pool): Promise<Conversation> => {
		let conv = conversations.get(key);
		if (!conv) {
			conv = Conversation.open(key, transport, reviewer, { recipient, notifications, channel });
			conv.then((c) => open.add(c)).catch(() => conversations.delete(key));
			conversations.set(key, conv);
		}
		return conv;
	};
	const fixedSink = (chat?: string): NotificationSink => chat ? {
		notify: (text, options) => pool.notify(text, { ...options, via: "telegram", chat }),
		status: () => pool.status(), setBroadcast: (v) => pool.setBroadcast(v),
		touch: (c, at) => pool.touch(c, at), retryPending: () => pool.retryPending(),
	} : pool;
	const wakeSource = async (source: string, text: string, targetChat?: string) => {
		const key = `automation-${createHash("sha256").update(source + "\0" + (targetChat ?? "")).digest("hex").slice(0, 32)}`;
		const conv = await conversation(key, tg, targetChat ?? ownerChatId()!, undefined, fixedSink(targetChat));
		await conv.handle({ text, name: source, date: new Date(), isEvent: true });
	};
	const actions: ActionRuntime = {
		notify: async (chatId, text) => pool.notify(text, { via: "telegram", chat: chatId }),
		wake: async (_chatId, text) => wakeSource("legacy", text),
		notifyVia: async (text, via, chat, source, title) => {
			await pool.notify(title ? `${title}\n${text}` : text, {
				via: via === "weixin" || via === "telegram" ? via : "pool", chat, source,
			});
		},
		wakeSource, defaultChat: ownerChatId,
	};
	const tasks = new TaskScheduler(actions);
	const hooks = new HookServer(actions);
	let activeHandlers = 0;

	async function onMessage(m: IncomingMessage, channel: ClientChannel = "telegram", transport: ChatTransport = tg): Promise<void> {
		if (m.service) return;
		if (channel === "telegram" ? !settings.allowedUsers.has(m.fromId) : !wx || m.fromId !== wx.ownerId) {
			log.warn(channel, "ignored unauthorized message");
			return;
		}
		pool.touch(channel);
		void pool.retryPending().catch((err) => log.warn("notify", "retry failed", errorText(err)));
		// Existing Telegram paths stay unchanged; upstream IDs never enter new paths raw.
		const key = channel === "telegram" ? m.chatId
			: `weixin-${createHash("sha256").update(wx!.accountId + "\0" + m.chatId).digest("hex").slice(0, 32)}`;
		const conv = await conversation(key, transport, m.chatId, channel);
		if (await handleCommand(m.text, { tg: transport, conv, tasks, chatId: m.chatId, fromId: m.fromId, notifications: pool })) return;
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
	const accept = (m: IncomingMessage, channel: ClientChannel = "telegram", transport: ChatTransport = tg) => {
		activeHandlers++;
		onMessage(m, channel, transport).catch((err) => {
			log.error(channel, "message handling failed", errorText(err));
			transport.send(m.chatId, `⚠️ ${errorText(err)}`).catch(() => {});
		}).finally(() => { activeHandlers--; });
	};
	const offset = existsSync(paths.telegramOffset) ? Number(readFileSync(paths.telegramOffset, "utf8")) || 0 : 0;
	const polling = tg.poll(offset, (m) => accept(m), (next) => writeFileSync(paths.telegramOffset, String(next)), stop.signal);
	const weixinPolling = wx ? (async () => {
		while (!stop.signal.aborted) {
			try {
				await wx.poll((m) => accept(m, "weixin", wx), stop.signal, () => void pool.retryPending().catch(() => {}));
			} catch (err) {
				if (!stop.signal.aborted) log.warn("weixin", "client stopped; retrying independently", errorText(err));
			}
			if (!stop.signal.aborted) await delay(5000, undefined, { signal: stop.signal }).catch(() => {});
		}
	})() : undefined;
	const notificationRetry = setInterval(() => void pool.retryPending().catch((err) => log.warn("notify", "retry failed", errorText(err))), 60_000);
	notificationRetry.unref();
	void pool.retryPending().catch(() => {});
	tasks.start();
	hooks.start();
	let stopping = false;
	const shutdown = async (reason: string, code = 0) => {
		if (stopping) return;
		stopping = true;
		log.info("daemon", `${reason}: shutting down`);
		stop.abort();
		clearInterval(notificationRetry);
		tasks.stop();
		hooks.stop();
		cancelDelegations();
		reviewer.cancelAll();
		for (const pending of conversations.values()) {
			try {
				const conv = await pending;
				await conv.abort();
				await conv.dispose();
			} catch { /* Failed to open. */ }
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
		if (!existsSync(paths.restartFlag) || activeHandlers || [...open].some((c) => c.busy)) return;
		try { unlinkSync(paths.restartFlag); } catch { /* Already consumed. */ }
		void shutdown("restart requested", RESTART_EXIT);
	}, 5000).unref();
	log.info("daemon", `clients active: telegram${wx ? ", weixin" : "; run pp weixin login to bind Weixin"}`);
	await Promise.all([polling, weixinPolling]);
}

main().catch((err) => {
	log.error("daemon", "fatal", errorText(err));
	process.exit(1);
});
