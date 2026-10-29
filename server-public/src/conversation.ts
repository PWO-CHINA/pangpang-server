// One Telegram chat = one long-lived pi AgentSession.
//
// Layout (from pi-mom, MIT, Mario Zechner): each chat directory holds
//   context.jsonl  what the model sees; pi owns it and compacts it
//   log.jsonl      every message in and out, append-only, never compacted
//   attachments/   files the owner sent
//   scratch/       the agent's working directory
//
// Messages that arrive while the agent is working steer the current run.

import {
	type AgentSession,
	convertToLlm,
	DefaultResourceLoader,
	serializeConversation,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { AGENT_DIR, chatDir, paths } from "./config.ts";
import { pangpangExtension } from "./extension.ts";
import { healthSnapshot } from "./pool/fallback/health.ts";
import caveman from "./caveman/index.ts";
import { backendExtension } from "./backend.ts";
import { delegateExtension } from "./delegate/extension.ts";
import piModelPool from "./pool/index.ts";
import { commitGrowth } from "./git.ts";
import { errorText, log } from "./log.ts";
import { renderMemorySnapshot } from "./memory.ts";
import { agentPrompt } from "./prompts.ts";
import { recallBlock } from "./recall.ts";
import { indexRecord, type LogRecord } from "./search.ts";
import { createSession } from "./session.ts";
import { MESSAGE_LIMIT, splitMessage, type Telegram } from "./telegram.ts";

export interface Inbound {
	text: string;
	name: string;
	date: Date;
	isEvent?: boolean;
	images?: { type: "image"; mimeType: string; data: string }[];
}

export interface ReviewHooks {
	/** Called when the chat has been idle long enough after enough activity. */
	schedule(conv: Conversation): void;
	cancel(conv: Conversation): void;
}

const IMAGE_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

function localStamp(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
		`${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
	);
}

function assistantText(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n")
		.trim();
}

function toolLabel(name: string, args: any): string {
	const pick =
		args?.command ?? args?.path ?? args?.query ?? args?.name ?? args?.pattern ?? args?.target ?? "";
	const detail = String(pick).split("\n")[0];
	return detail ? `${name}: ${detail.length > 80 ? `${detail.slice(0, 77)}...` : detail}` : name;
}

/**
 * A Telegram message that shows progress while the agent works and is
 * replaced by the final answer.  Edits are throttled to stay well inside
 * Telegram's rate limits.
 */
class LiveReply {
	private tg: Telegram;
	private chatId: string;
	private messageId: number | undefined;
	private lines: string[] = [];
	private dirty = false;
	private timer: NodeJS.Timeout | undefined;
	private chain: Promise<void> = Promise.resolve();

	constructor(tg: Telegram, chatId: string) {
		this.tg = tg;
		this.chatId = chatId;
	}

	status(line: string): void {
		this.lines.push(line);
		if (this.lines.length > 12) this.lines.splice(0, this.lines.length - 12);
		this.dirty = true;
		this.timer ??= setTimeout(() => this.flush(), 1500);
	}

	private flush(): void {
		this.timer = undefined;
		if (!this.dirty) return;
		this.dirty = false;
		const text = `${this.lines.map((l) => `› ${l}`).join("\n")}\n…`;
		this.enqueue(async () => {
			if (this.messageId === undefined) this.messageId = await this.tg.send(this.chatId, text, { silent: true });
			else await this.tg.edit(this.chatId, this.messageId, text);
		});
	}

	private enqueue(fn: () => Promise<void>): void {
		this.chain = this.chain.then(fn).catch((err) => log.warn("telegram", "reply update failed", errorText(err)));
	}

	/** Replace the progress message with the final text (split if long), or delete it. */
	async finish(text: string | undefined): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.enqueue(async () => {
			const id = this.messageId;
			if (!text) {
				if (id !== undefined) await this.tg.remove(this.chatId, id);
				return;
			}
			const parts = splitMessage(text, MESSAGE_LIMIT);
			// A fresh message notifies the owner; editing the silent progress message would not.
			if (id !== undefined) await this.tg.remove(this.chatId, id).catch(() => {});
			for (const part of parts) await this.tg.send(this.chatId, part);
		});
		await this.chain;
	}
}

export class Conversation {
	readonly chatId: string;
	readonly dir: string;
	readonly scratch: string;
	private tg: Telegram;
	private review: ReviewHooks;
	private session!: AgentSession;
	private snapshot = "";
	private needsReload = false;
	private reply: LiveReply | undefined;
	/** The last completed assistant message of the current run. */
	private lastAssistant: any;
	private queue: Promise<void> = Promise.resolve();

	/** Activity since the last background review. */
	toolCalls = 0;
	userTurns = 0;
	reviewedUpTo = 0;

	private constructor(chatId: string, tg: Telegram, review: ReviewHooks) {
		this.chatId = chatId;
		this.dir = chatDir(chatId);
		this.scratch = join(this.dir, "scratch");
		this.tg = tg;
		this.review = review;
	}

	static async open(chatId: string, tg: Telegram, review: ReviewHooks): Promise<Conversation> {
		const conv = new Conversation(chatId, tg, review);
		mkdirSync(conv.scratch, { recursive: true });
		mkdirSync(join(conv.dir, "attachments"), { recursive: true });
		await conv.createSession();
		return conv;
	}

	private async createSession(): Promise<void> {
		this.snapshot = renderMemorySnapshot();
		const loader = new DefaultResourceLoader({
			cwd: this.scratch,
			agentDir: AGENT_DIR,
			appendSystemPrompt: [agentPrompt(this.chatId, this.dir)],
			// Only the global agent/AGENTS.md: the scratch dir sits inside the repo,
			// whose own AGENTS.md is for maintaining pangpang, not for chatting.
			agentsFilesOverride: (base) => ({
				agentsFiles: base.agentsFiles.filter((f) => f.path.startsWith(AGENT_DIR)),
			}),
			extensionFactories: [
				{ name: "pool", factory: piModelPool },
				// Chat sessions only: each one keeps a caveman-mcp recovery child.
				{ name: "caveman", factory: caveman },
				{ name: "backend", factory: backendExtension() },
				{
					name: "delegate",
					factory: delegateExtension({
						cwd: this.scratch,
						deliver: (text) => this.handle({ text, name: "delegate", date: new Date(), isEvent: true }),
					}),
				},
				{
					name: "pangpang",
					factory: pangpangExtension({
						cwd: this.scratch,
						snapshot: () => this.snapshot,
						refresh: async () => {
							this.snapshot = renderMemorySnapshot();
							this.needsReload = true;
							this.reviewedUpTo = 0;
						},
						attach: (file, caption) => this.tg.sendFile(this.chatId, file, caption),
						onToolCall: () => {
							this.toolCalls++;
						},
					}),
				},
			],
		});
		await loader.reload();
		const sessionManager = SessionManager.open(join(this.dir, "context.jsonl"), this.dir, this.scratch);
		const session = await createSession({ cwd: this.scratch, resourceLoader: loader, sessionManager });
		this.session = session;
		session.subscribe((event: any) => this.onEvent(event));
		log.info(this.chatId, `session ready (${session.messages.length} messages in context)`);
	}

	private onEvent(event: any): void {
		if (event.type === "message_end" && event.message?.role === "assistant") this.lastAssistant = event.message;
		const reply = this.reply;
		if (!reply) return;
		switch (event.type) {
			case "tool_execution_start":
				reply.status(toolLabel(event.toolName, event.args));
				break;
			case "tool_execution_end":
				if (event.isError) reply.status(`✗ ${event.toolName} failed`);
				break;
			case "compaction_start":
				reply.status("compacting context");
				break;
			case "auto_retry_start":
				reply.status(`retrying (${event.attempt}/${event.maxAttempts})`);
				break;
		}
	}

	private appendLog(record: Omit<LogRecord, "chatId">): void {
		const full: LogRecord = { ...record, chatId: this.chatId };
		appendFileSync(join(this.dir, "log.jsonl"), `${JSON.stringify(full)}\n`);
		try {
			indexRecord(full);
		} catch (err) {
			log.warn(this.chatId, "search index write failed", errorText(err));
		}
	}

	get busy(): boolean {
		return this.session.isStreaming;
	}

	/** Handle an owner message or an event.  Calls are serialized per chat. */
	handle(msg: Inbound): Promise<void> {
		this.review.cancel(this);
		this.appendLog({ date: msg.date.toISOString(), role: msg.isEvent ? "event" : "user", name: msg.name, text: msg.text });
		const prompt = msg.isEvent ? msg.text : `[${localStamp(msg.date)}] ${msg.text}`;

		// While a run is active, steer it instead of waiting behind it.
		if (this.session.isStreaming && !msg.isEvent) {
			this.userTurns++;
			return this.session.prompt(prompt, { streamingBehavior: "steer", images: msg.images }).catch((err) => {
				log.warn(this.chatId, "steer failed", errorText(err));
			});
		}

		this.queue = this.queue.then(() => this.run(msg.isEvent ? prompt : this.withRecall(prompt, msg.text), msg));
		return this.queue;
	}

	/**
	 * Append relevant earlier exchanges (src/recall.ts) to an owner message.
	 * Only history older than the live context is used; the model already
	 * sees the rest.
	 */
	private withRecall(prompt: string, text: string): string {
		try {
			const first = (this.session.messages as { timestamp?: number }[]).find((m) => typeof m.timestamp === "number");
			const before = first?.timestamp ? new Date(first.timestamp).toISOString() : undefined;
			const block = recallBlock(text, { before });
			if (!block) return prompt;
			log.info(this.chatId, `recall: ${block.split("\n").length - 3} hits`);
			return `${prompt}\n\n${block}`;
		} catch (err) {
			log.warn(this.chatId, "recall failed", errorText(err));
			return prompt;
		}
	}

	private async run(prompt: string, msg: Inbound): Promise<void> {
		if (!msg.isEvent) this.userTurns++;
		if (this.needsReload) {
			this.needsReload = false;
			await this.session.reload().catch((err) => log.warn(this.chatId, "reload failed", errorText(err)));
		}
		const reply = new LiveReply(this.tg, this.chatId);
		this.reply = reply;
		const typing = setInterval(() => void this.tg.typing(this.chatId), 4500);
		void this.tg.typing(this.chatId);
		this.lastAssistant = undefined;
		let failure: string | undefined;
		try {
			await this.session.prompt(prompt, { images: msg.images, expandPromptTemplates: false });
		} catch (err) {
			failure = errorText(err);
			log.error(this.chatId, "run failed", err);
		} finally {
			clearInterval(typing);
		}

		// Some models occasionally end a turn with only thinking, no visible
		// text.  Ask once for the answer rather than sending "(no reply)".
		if (!failure && this.lastAssistant?.stopReason === "stop" && !assistantText(this.lastAssistant)) {
			log.info(this.chatId, "empty reply; asking for the final answer");
			try {
				await this.session.prompt(
					"(Your last turn had no visible reply. Send the owner the final answer now, text only: output exactly the message that should reach them - no preamble, no narration, no commentary about the answer itself.)",
					{
						expandPromptTemplates: false,
					},
				);
			} catch (err) {
				log.warn(this.chatId, "follow-up failed", errorText(err));
			}
		}
		this.reply = undefined;

		// Taken from this run's events, not from session.messages: compaction
		// during the run shrinks the message list.
		const last = this.lastAssistant;
		let text = assistantText(last);
		if (!failure && last?.stopReason === "error") failure = last.errorMessage ?? "model error";
		if (!failure && last?.stopReason === "aborted") text = text || "(stopped)";

		if (failure) {
			await reply.finish(`⚠️ ${failure}`);
			return;
		}
		if (text.startsWith("[SILENT]")) {
			log.info(this.chatId, "silent reply");
			await reply.finish(undefined);
			return;
		}
		this.appendLog({ date: new Date().toISOString(), role: "assistant", name: "pangpang", text });
		await reply.finish(text || "(no reply)");
		void commitGrowth(`learn from chat ${this.chatId}`);
		this.review.schedule(this);
	}

	async abort(): Promise<boolean> {
		if (!this.session.isStreaming) return false;
		await this.session.abort();
		return true;
	}

	/** Start a fresh context.  The old context file is kept next to the log. */
	async reset(): Promise<void> {
		await this.abort();
		this.review.cancel(this);
		this.session.dispose();
		const file = join(this.dir, "context.jsonl");
		if (existsSync(file)) {
			renameSync(file, join(this.dir, `context-${new Date().toISOString().replaceAll(":", "-")}.jsonl`));
		}
		this.toolCalls = 0;
		this.userTurns = 0;
		this.reviewedUpTo = 0;
		await this.createSession();
	}

	async compact(instructions?: string): Promise<string> {
		const result = await this.session.compact(instructions || undefined);
		return `compacted ${result.tokensBefore} tokens`;
	}

	status(): string {
		const usage = this.session.getContextUsage() as any;
		const model = this.session.model as any;
		// pi only knows the size after a model reply, e.g. not right after compaction.
		const ctx = usage?.tokens != null
			? `${Math.round(usage.tokens / 1000)}k / ${Math.round(usage.contextWindow / 1000)}k tokens`
			: "measured after the next reply";
		const pool = Object.entries(healthSnapshot()).map(
			([target, h]) => `  ${target}: ${Math.round(h.success * 100)}% ok${h.ttfbMs ? `, first token ${(h.ttfbMs / 1000).toFixed(1)}s` : ""} (${h.samples})`,
		);
		return [
			`model: ${model ? `${model.provider}/${model.id}` : "none"}`,
			...(pool.length ? ["pool:", ...pool] : []),
			`context: ${ctx}, ${this.session.messages.length} messages`,
			`state: ${this.session.isStreaming ? "working" : "idle"}`,
			`since review: ${this.userTurns} turns, ${this.toolCalls} tool calls`,
		].join("\n");
	}

	/** `provider/id` of every model with usable credentials. */
	models(): string[] {
		return this.session.modelRuntime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`);
	}

	async setModel(ref: string): Promise<string> {
		const slash = ref.indexOf("/");
		const model = slash > 0 ? this.session.modelRuntime.getModel(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
		if (!model) return `unknown model ${ref}; see /model list`;
		await this.session.setModel(model);
		return `model: ${ref}`;
	}

	thinking(level?: string): string {
		const levels = this.session.getAvailableThinkingLevels();
		if (level) {
			if (!levels.includes(level as never)) return `levels for this model: ${levels.join(", ")}`;
			this.session.setThinkingLevel(level as never);
		}
		return `thinking: ${this.session.thinkingLevel} (available: ${levels.join(", ")})`;
	}

	usage(): string {
		const st = this.session.getSessionStats() as any;
		const t = st.tokens;
		const cost = typeof st.cost === "number" ? st.cost : st.cost?.total;
		return [
			`messages: ${st.userMessages} user, ${st.assistantMessages} assistant, ${st.toolCalls} tool calls`,
			`tokens: ${t.total} total (${t.input} in, ${t.output} out, ${t.cacheRead} cache read)`,
			...(typeof cost === "number" ? [`cost: $${cost.toFixed(4)}`] : []),
		].join("\n");
	}

	/**
	 * Answer a side question in a throwaway session that sees the recent
	 * conversation but writes nothing back to this chat's context.
	 */
	async btw(question: string): Promise<string> {
		let recent = serializeConversation(convertToLlm(this.session.messages.slice(-20) as any));
		if (recent.length > 30_000) recent = recent.slice(-30_000);
		const loader = new DefaultResourceLoader({
			cwd: this.scratch,
			agentDir: AGENT_DIR,
			agentsFilesOverride: (base) => ({
				agentsFiles: base.agentsFiles.filter((f) => f.path.startsWith(AGENT_DIR)),
			}),
			extensionFactories: [
				{ name: "pool", factory: piModelPool },
				{
					name: "pangpang-btw",
					factory: pangpangExtension({ cwd: this.scratch, snapshot: () => this.snapshot, refresh: async () => {} }),
				},
			],
		});
		await loader.reload();
		const side = await createSession({
			cwd: this.scratch,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(this.scratch),
			tools: ["read", "grep", "find", "ls", "session_search"],
		});
		try {
			await side.prompt(
				`<recent_conversation>\n${recent}\n</recent_conversation>\n\n` +
					`Side question from the owner. Answer briefly; do not change anything.\n\n${question}`,
				{ expandPromptTemplates: false },
			);
			return side.getLastAssistantText()?.trim() || "(no answer)";
		} finally {
			side.dispose();
		}
	}

	/** Messages added since the last review, for the background reviewer. */
	unreviewedMessages(): unknown[] {
		return this.session.messages.slice(this.reviewedUpTo);
	}

	markReviewed(): void {
		this.reviewedUpTo = this.session.messages.length;
		this.toolCalls = 0;
		this.userTurns = 0;
	}

	async saveAttachment(fileId: string, fileName: string): Promise<{ path: string; image?: Inbound["images"] }> {
		const safe = basename(fileName).replace(/[^\w.\-一-鿿]/g, "_") || "file";
		const path = join(this.dir, "attachments", `${Date.now()}-${safe}`);
		await this.tg.download(fileId, path);
		const mime = IMAGE_TYPES[extname(path).toLowerCase()];
		if (!mime) return { path };
		return { path, image: [{ type: "image", mimeType: mime, data: readFileSync(path).toString("base64") }] };
	}

	dispose(): void {
		this.review.cancel(this);
		this.session.dispose();
	}
}
