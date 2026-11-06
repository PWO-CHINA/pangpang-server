import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatTransport, ClientChannel, NotificationOptions, NotificationSink } from "./types.ts";

type WeixinTarget = { transport: ChatTransport; chatId: string };
type PoolConfig = {
	telegram: ChatTransport;
	telegramChatId: string;
	weixin?: WeixinTarget;
	stateDir: string;
	settingsFile: string;
};

export type NotificationPoolRuntimeOptions = { timeoutMs?: number };

type ChannelResult = { result: "sent" | "failed" | "unknown"; at: string; detail?: string };
type TargetState = {
	segments: string[];
	sentSegments: number;
	fileSent: boolean;
	status: "pending" | "sending" | "sent" | "failed" | "unknown";
	updatedAt?: string;
	error?: string;
};
type OutboxJob = {
	version: 1;
	id: string;
	text: string;
	options: NotificationOptions;
	createdAt: string;
	mode: "broadcast" | "failover" | "explicit";
	channels: ClientChannel[];
	targets: Partial<Record<ClientChannel, TargetState>>;
};

const CHANNELS: ClientChannel[] = ["telegram", "weixin"];
const DEFAULT_TIMEOUT_MS = 30_000;

/** Delivers proactive notifications with persisted failover and an offline outbox. */
export class NotificationPool implements NotificationSink {
	private readonly telegram: ChatTransport;
	private readonly telegramChatId: string;
	private weixin?: WeixinTarget;
	private readonly stateDir: string;
	private readonly outboxDir: string;
	private readonly settingsFile: string;
	private readonly timeoutMs: number;
	private broadcast = false;
	private preferred: { channel: ClientChannel; at?: string } = { channel: "telegram" };
	private lastResults: Partial<Record<ClientChannel, ChannelResult>> = {};
	private tail: Promise<void> = Promise.resolve();

	constructor(config: PoolConfig, runtime: NotificationPoolRuntimeOptions = {}) {
		this.telegram = config.telegram;
		this.telegramChatId = config.telegramChatId;
		this.weixin = config.weixin;
		this.stateDir = config.stateDir;
		this.outboxDir = join(config.stateDir, "outbox");
		this.settingsFile = config.settingsFile;
		this.timeoutMs = Math.max(1, runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		this.ensurePrivateDirectory(this.stateDir);
		this.ensurePrivateDirectory(this.outboxDir);
		this.readSettings();
		this.readPreference();
		this.readResults();
		this.recoverInterruptedJobs();
	}

	/** Replace or add the bound Weixin owner transport. */
	setWeixin(weixin?: WeixinTarget): void {
		this.weixin = weixin;
	}

	/** Record the platform of an authorized inbound message. */
	touch(channel: ClientChannel, at = new Date()): void {
		if (!CHANNELS.includes(channel) || !Number.isFinite(at.getTime())) return;
		this.preferred = { channel, at: at.toISOString() };
		this.atomicWrite(join(this.stateDir, "preferred.json"), this.preferred);
	}

	/** Persist the pool's default broadcast mode. */
	setBroadcast(enabled: boolean): void {
		const settings = this.readSettingsObject();
		settings.notificationBroadcast = enabled;
		this.atomicWrite(this.settingsFile, settings);
		this.broadcast = enabled;
	}

	status(): string {
		const mode = this.broadcast ? "broadcast" : "failover";
		const recent = this.preferred.at ? `${this.preferred.channel} at ${this.preferred.at}` : `${this.preferred.channel} (default)`;
		const pending = this.listJobs().length;
		const result = CHANNELS.map((channel) => {
			const r = this.lastResults[channel];
			return `${channel}: ${r ? `${r.result}${r.at ? ` at ${r.at}` : ""}${r.detail ? ` (${r.detail})` : ""}` : "no result yet"}`;
		}).join("; ");
		return `Notification mode: ${mode}\nRecent platform: ${recent}\nPending: ${pending}\nRecent results: ${result}`;
	}

	/** Send once; failed deliveries are persisted and considered queued, never cron errors. */
	notify(text: string, options: NotificationOptions = {}): Promise<void> {
		return this.enqueue(async () => {
			const job = this.createJob(text, options);
			if (!job.channels.length) return;
			this.saveJob(job);
			await this.deliver(job);
		});
	}

	/** Retry persisted jobs in creation order. Successful targets are checkpointed and skipped. */
	retryPending(): Promise<void> {
		return this.enqueue(async () => {
			for (const job of this.listJobs()) await this.deliver(job);
		});
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.tail.then(work, work);
		this.tail = run.then(() => undefined, () => undefined);
		return run;
	}

	private createJob(text: string, options: NotificationOptions): OutboxJob {
		const explicit = options.via === "telegram" || options.via === "weixin" || !!options.chat;
		let channels: ClientChannel[];
		let mode: OutboxJob["mode"];
		if (explicit) {
			channels = [options.via === "weixin" ? "weixin" : "telegram"];
			mode = "explicit";
		} else if (this.broadcast) {
			channels = CHANNELS.filter((channel) => this.isAvailable(channel));
			mode = "broadcast";
		} else {
			const ordered: ClientChannel[] = [this.preferred.channel, this.preferred.channel === "telegram" ? "weixin" : "telegram"];
			// Keep the unbound channel in the persisted failover plan. It is skipped
			// immediately, but can become a useful retry target if the owner binds later.
			channels = ordered;
			mode = "failover";
		}
		const targets: OutboxJob["targets"] = {};
		for (const channel of channels) {
			const limit = Math.max(1, this.transport(channel)?.messageLimit ?? 3800);
			const segments = text ? splitText(text, limit) : [];
			targets[channel] = {
				segments,
				sentSegments: 0,
				fileSent: !options.file,
				status: "pending",
			};
		}
		return {
			version: 1,
			id: randomUUID(),
			text,
			options: { ...options },
			createdAt: new Date().toISOString(),
			mode,
			channels,
			targets,
		};
	}

	private async deliver(job: OutboxJob): Promise<void> {
		if (job.mode === "broadcast") {
			const delivered = await Promise.all(job.channels.map((channel) => this.deliverTarget(job, channel)));
			if (delivered.every(Boolean)) this.removeJob(job);
			return;
		}

		for (const channel of job.channels) {
			if (await this.deliverTarget(job, channel)) {
				this.removeJob(job);
				return;
			}
		}
		// Keep the record for a later recovery attempt. A later call may have a bound Weixin owner.
		this.saveJob(job);
	}

	private async deliverTarget(job: OutboxJob, channel: ClientChannel): Promise<boolean> {
		const target = job.targets[channel];
		if (!target) return false;
		if (target.status === "sent") return true;
		const transport = this.transport(channel);
		const chatId = this.recipient(job, channel);
		if (target.sentSegments === 0 && transport) {
			const limit = Math.max(1, transport.messageLimit ?? 3800);
			target.segments = job.text ? splitText(job.text, limit) : [];
		}
		if (!transport || !chatId) {
			target.status = "failed";
			target.error = "recipient is not bound";
			target.updatedAt = new Date().toISOString();
			this.saveJob(job);
			this.recordResult(channel, "failed", target.error, job);
			return false;
		}

		try {
			while (target.sentSegments < target.segments.length) {
				const i = target.sentSegments;
				await this.sendStep(job, channel, target, () => transport.send(chatId, target.segments[i], { silent: job.options.silent }));
				target.sentSegments++;
				target.status = "pending";
				target.error = undefined;
				target.updatedAt = new Date().toISOString();
				this.saveJob(job);
			}
			if (!target.fileSent && job.options.file) {
				await this.sendStep(job, channel, target, () => transport.sendFile(chatId, job.options.file!, job.options.caption));
				target.fileSent = true;
				target.status = "pending";
				target.error = undefined;
				target.updatedAt = new Date().toISOString();
				this.saveJob(job);
			}
			target.status = "sent";
			target.updatedAt = new Date().toISOString();
			target.error = undefined;
			this.saveJob(job);
			this.recordResult(channel, "sent", undefined, job);
			return true;
		} catch (error) {
			const unknown = error instanceof DeliveryTimeout;
			target.status = unknown ? "unknown" : "failed";
			target.error = briefError(error);
			target.updatedAt = new Date().toISOString();
			this.saveJob(job);
			this.recordResult(channel, unknown ? "unknown" : "failed", target.error, job);
			return false;
		}
	}

	private async sendStep(job: OutboxJob, channel: ClientChannel, target: TargetState, action: () => Promise<unknown>): Promise<void> {
		target.status = "sending";
		target.updatedAt = new Date().toISOString();
		target.error = undefined;
		this.saveJob(job);
		await withTimeout(action(), this.timeoutMs, channel);
	}

	private transport(channel: ClientChannel): ChatTransport | undefined {
		return channel === "telegram" ? this.telegram : this.weixin?.transport;
	}

	private recipient(job: OutboxJob, channel: ClientChannel): string | undefined {
		if (job.mode === "explicit") {
			if (job.options.via === "weixin") return job.options.chat || this.weixin?.chatId;
			return job.options.chat || this.telegramChatId;
		}
		return channel === "telegram" ? this.telegramChatId : this.weixin?.chatId;
	}

	private isAvailable(channel: ClientChannel): boolean {
		return channel === "telegram" || !!this.weixin?.chatId;
	}

	private jobPath(id: string): string {
		return join(this.outboxDir, `${id}.json`);
	}

	private saveJob(job: OutboxJob): void {
		this.atomicWrite(this.jobPath(job.id), job);
	}

	private removeJob(job: OutboxJob): void {
		const path = this.jobPath(job.id);
		if (existsSync(path)) unlinkSync(path);
	}

	private listJobs(): OutboxJob[] {
		const jobs: OutboxJob[] = [];
		for (const name of readdirSync(this.outboxDir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const job = JSON.parse(readFileSync(join(this.outboxDir, name), "utf8")) as OutboxJob;
				if (job.version === 1 && typeof job.id === "string" && Array.isArray(job.channels)) jobs.push(job);
			} catch {
				// Ignore incomplete or unrelated files; atomic writes keep normal records complete.
			}
		}
		return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	}

	private recordResult(channel: ClientChannel, result: ChannelResult["result"], detail?: string, job?: OutboxJob): void {
		this.lastResults[channel] = { result, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
		this.atomicWrite(join(this.stateDir, "last-results.json"), this.lastResults);
		// Receipt history survives successful outbox removal; never include message bodies or tokens.
		appendFileSync(join(this.stateDir, "deliveries.jsonl"), `${JSON.stringify({
			at: new Date().toISOString(), id: job?.id, source: job?.options.source, channel, result,
		})}\n`, { mode: 0o600 });
	}

	private readSettingsObject(): Record<string, unknown> {
		if (!existsSync(this.settingsFile)) return {};
		try {
			const value = JSON.parse(readFileSync(this.settingsFile, "utf8"));
			return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
		} catch {
			return {};
		}
	}

	private readSettings(): void {
		const settings = this.readSettingsObject();
		const value = settings.notificationBroadcast;
		this.broadcast = typeof value === "boolean" ? value : false;
		if (typeof value !== "boolean") {
			settings.notificationBroadcast = false;
			this.atomicWrite(this.settingsFile, settings);
		}
	}

	private readPreference(): void {
		const path = join(this.stateDir, "preferred.json");
		if (!existsSync(path)) return;
		try {
			const value = JSON.parse(readFileSync(path, "utf8"));
			if (CHANNELS.includes(value.channel)) {
				this.preferred = { channel: value.channel, ...(typeof value.at === "string" ? { at: value.at } : {}) };
			}
		} catch {
			// A missing or malformed preference safely falls back to Telegram.
		}
	}

	private readResults(): void {
		const path = join(this.stateDir, "last-results.json");
		if (!existsSync(path)) return;
		try {
			const value = JSON.parse(readFileSync(path, "utf8"));
			this.lastResults = value && typeof value === "object" && !Array.isArray(value)
				? value as Partial<Record<ClientChannel, ChannelResult>>
				: {};
		} catch {
			this.lastResults = {};
		}
	}

	private recoverInterruptedJobs(): void {
		for (const job of this.listJobs()) {
			let changed = false;
			for (const channel of job.channels) {
				const target = job.targets[channel];
				if (target?.status === "sending") {
					target.status = "unknown";
					target.error = "process stopped during send; result unknown";
					target.updatedAt = new Date().toISOString();
					this.lastResults[channel] = { result: "unknown", at: target.updatedAt, detail: target.error };
					changed = true;
				}
			}
			if (changed) this.saveJob(job);
		}
		this.atomicWrite(join(this.stateDir, "last-results.json"), this.lastResults);
	}

	private atomicWrite(path: string, value: unknown): void {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			renameSync(temp, path);
		} catch (error) {
			try { if (existsSync(temp)) unlinkSync(temp); } catch { /* Preserve the original write error. */ }
			throw error;
		}
	}

	private ensurePrivateDirectory(path: string): void {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		chmodSync(path, 0o700);
	}
}

class DeliveryTimeout extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, channel: ClientChannel): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new DeliveryTimeout(`${channel} send timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function briefError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.slice(0, 300) || "send failed";
}

function splitText(text: string, limit: number): string[] {
	const chars = [...text];
	if (chars.length <= limit) return [text];
	const parts: string[] = [];
	let rest = chars;
	while (rest.length > limit) {
		let cut = -1;
		for (let i = limit; i > Math.floor(limit / 2); i--) {
			if (rest[i] === "\n" || rest[i] === " ") { cut = i; break; }
		}
		if (cut < 1) cut = limit;
		parts.push(rest.slice(0, cut).join(""));
		rest = rest.slice(cut);
		while (rest[0] === "\n" || rest[0] === " ") rest = rest.slice(1);
	}
	if (rest.length) parts.push(rest.join(""));
	return parts;
}
