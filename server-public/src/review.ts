// Background review, internalized from Hermes Agent's learning loop
// (agent/background_review.py, MIT, Nous Research).
//
// After a chat has been idle for a while following enough activity, a
// separate short-lived pi session reads the unreviewed stretch of the
// conversation and updates memory and skills.  It never talks in the chat
// itself; it only posts a one-line silent note when it changed something.

import {
	type AgentSession,
	convertToLlm,
	DefaultResourceLoader,
	serializeConversation,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { AGENT_DIR, paths, settings } from "./config.ts";
import type { Conversation, ReviewHooks } from "./conversation.ts";
import { pangpangExtension } from "./extension.ts";
import piModelPool from "./pool/index.ts";
import { commitGrowth } from "./git.ts";
import { errorText, log } from "./log.ts";
import { renderMemorySnapshot } from "./memory.ts";
import { REVIEW_PROMPT } from "./prompts.ts";
import { createSession } from "./session.ts";
import type { Telegram } from "./telegram.ts";

/** Keep the transcript handed to the reviewer bounded. */
const MAX_TRANSCRIPT_CHARS = 80_000;

export class Reviewer implements ReviewHooks {
	private tg: Telegram;
	private timers = new Map<string, NodeJS.Timeout>();
	private running: Promise<void> = Promise.resolve();

	constructor(tg: Telegram) {
		this.tg = tg;
	}

	schedule(conv: Conversation): void {
		this.cancel(conv);
		if (conv.toolCalls < settings.reviewMinToolCalls && conv.userTurns < settings.reviewMinUserTurns) return;
		const timer = setTimeout(() => {
			this.timers.delete(conv.chatId);
			// One review at a time across chats keeps load on the NAS predictable.
			this.running = this.running.then(() => this.review(conv));
		}, settings.reviewIdleMs);
		timer.unref();
		this.timers.set(conv.chatId, timer);
	}

	cancel(conv: Conversation): void {
		const timer = this.timers.get(conv.chatId);
		if (timer) clearTimeout(timer);
		this.timers.delete(conv.chatId);
	}

	cancelAll(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	private async review(conv: Conversation): Promise<void> {
		if (existsSync(paths.pausedFlag)) {
			log.info("review", `${conv.chatId}: skipped, paused`);
			return;
		}
		if (conv.busy) return;
		const messages = conv.unreviewedMessages();
		if (messages.length === 0) return;

		let transcript = serializeConversation(convertToLlm(messages as any));
		if (transcript.length > MAX_TRANSCRIPT_CHARS) {
			transcript = `[... earlier part omitted ...]\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
		}

		log.info("review", `${conv.chatId}: reviewing ${messages.length} messages`);
		const loader = new DefaultResourceLoader({
			cwd: paths.workspace,
			agentDir: AGENT_DIR,
			agentsFilesOverride: (base) => ({
				agentsFiles: base.agentsFiles.filter((f) => f.path.startsWith(AGENT_DIR)),
			}),
			extensionFactories: [
				{ name: "pool", factory: piModelPool },
				{
					name: "pangpang-review",
					factory: pangpangExtension({
						cwd: paths.workspace,
						snapshot: renderMemorySnapshot,
						refresh: async () => {},
					}),
				},
			],
		});
		let session: AgentSession | undefined;
		try {
			await loader.reload();
			session = await createSession({
				cwd: paths.workspace,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(paths.workspace),
				tools: ["read", "memory", "skill_manage"],
			});
			await session.prompt(`<transcript>\n${transcript}\n</transcript>\n\n${REVIEW_PROMPT}`, {
				expandPromptTemplates: false,
			});
			const result = (session.getLastAssistantText() ?? "").trim();
			conv.markReviewed();
			log.info("review", `${conv.chatId}: ${result || "(no reply)"}`);
			if (result && !/^nothing to save/i.test(result)) {
				await commitGrowth(`review: ${result.split("\n")[0].slice(0, 120)}`);
				await this.tg.send(conv.chatId, `🧠 ${result.slice(0, 500)}`, { silent: true });
			}
		} catch (err) {
			log.warn("review", `${conv.chatId}: failed`, errorText(err));
		} finally {
			session?.dispose();
		}
	}
}
