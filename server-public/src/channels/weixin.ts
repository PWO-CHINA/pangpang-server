// Small pangpang transport over Tencent's published Weixin SDK primitives.
// This deliberately does not start or reuse OpenClaw's Gateway monitor.

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PP_VAR } from "../config.ts";
import { errorText, log } from "../log.ts";
import type { IncomingMessage } from "../telegram.ts";
import type { ChatTransport } from "./types.ts";
import { loadWeixinUpstream, weixinRuntimePaths } from "./weixin-upstream.ts";

type SavedAccount = { token?: string; baseUrl?: string; userId?: string };
type Attachment = { path: string; fileName: string };

const ACCOUNT_ID_RE = /^[A-Za-z0-9@._-]+$/;
const MAX_SEEN_IDS = 4096;
const MAX_BACKOFF_MS = 60_000;

function isValidAccountId(value: string): boolean {
	return value.length > 0 && value === value.trim() && ACCOUNT_ID_RE.test(value) && !value.includes("..") && !value.includes("/") && !value.includes("\\");
}

function safeBaseUrl(value: string | undefined, fallback: string): string {
	const candidate = value?.trim() || fallback;
	const url = new URL(candidate);
	if (url.protocol !== "https:") throw new Error("Weixin account baseUrl must use HTTPS");
	return url.toString().replace(/\/$/, "");
}

export function weixinApiResponseError(operation: string, response: any): Error | undefined {
	if (!response || typeof response !== "object") return new Error(`${operation} returned no response`);
	const ret = typeof response.ret === "number" ? response.ret : undefined;
	const errcode = typeof response.errcode === "number" ? response.errcode : undefined;
	if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
		return new Error(`${operation} failed (ret=${ret ?? "none"}, errcode=${errcode ?? "none"})`);
	}
	return undefined;
}

function pauseOnStaleToken(upstream: Awaited<ReturnType<typeof loadWeixinUpstream>>, accountId: string, err: unknown): void {
	const message = errorText(err);
	if (/\b(?:ret|errcode)\s*=\s*-14\b/i.test(message)) upstream.sessionGuard.pauseSession(accountId);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolveSleep) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolveSleep();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

function safeFileName(value: string | undefined, fallback: string): string {
	const normalized = (value || fallback).replaceAll("\\", "/");
	const leaf = basename(normalized).replace(/[^\p{L}\p{N}._-]/gu, "_");
	return leaf && leaf !== "." && leaf !== ".." ? leaf : fallback;
}

function imageContentType(buffer: Buffer): string | undefined {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
	if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (buffer.length >= 2 && buffer.toString("ascii", 0, 2) === "BM") return "image/bmp";
	if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
		const brand = buffer.toString("ascii", 8, 12);
		if (/^(?:avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return brand.startsWith("av") ? "image/avif" : "image/heic";
	}
	if (buffer.length >= 4 && ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0) || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0 && buffer[3] === 0x2a))) return "image/tiff";
	return undefined;
}

function mediaExtension(fileName: string, contentType?: string, buffer?: Buffer): string {
	const extension = extname(fileName);
	if (/^\.[a-z0-9]{1,10}$/i.test(extension)) return extension.toLowerCase();
	const effectiveType = contentType || (buffer ? imageContentType(buffer) : undefined);
	const subtype = effectiveType?.split("/")[1]?.split(";")[0]?.toLowerCase();
	const normalized = subtype === "jpeg" ? "jpg" : subtype;
	return normalized && /^[a-z0-9]{1,10}$/.test(normalized) ? `.${normalized}` : ".media";
}

function mediaFileName(fileName: string, contentType?: string, buffer?: Buffer): string {
	const safeName = safeFileName(fileName, "attachment");
	if (extname(safeName)) return safeName;
	return `${safeName}${mediaExtension(safeName, contentType, buffer)}`;
}

function privateFilePath(path: string): boolean {
	const abs = resolve(path);
	const rel = relative(resolve(weixinRuntimePaths.mediaDir), abs);
	return rel !== "" && !rel.startsWith("..") && !resolve(rel).startsWith("..");
}

export class WeixinClient implements ChatTransport {
	readonly channel = "weixin" as const;
	readonly supportsEdits = false;
	readonly ownerId: string;
	readonly accountId: string;
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly attachments = new Map<string, Attachment>();
	private readonly seen = new Set<string>();
	private seenOrder: string[] = [];
	private localMessageId = 0;
	private pollActive = false;

	private constructor(accountId: string, ownerId: string, token: string, baseUrl: string) {
		this.accountId = accountId;
		this.ownerId = ownerId;
		this.token = token;
		this.baseUrl = baseUrl;
	}

	static async load(): Promise<WeixinClient | undefined> {
		const upstream = await loadWeixinUpstream();
		for (const candidate of [...(upstream.accounts.listIndexedWeixinAccountIds() as string[])].reverse()) {
			if (!isValidAccountId(candidate)) continue;
			const data = upstream.accounts.loadWeixinAccount(candidate) as SavedAccount | null;
			const ownerId = data?.userId?.trim();
			const token = data?.token?.trim();
			if (!ownerId || !token) continue;
			try {
				const baseUrl = safeBaseUrl(data?.baseUrl, upstream.accounts.DEFAULT_BASE_URL);
				upstream.inbound.restoreContextTokens(candidate);
				return new WeixinClient(candidate, ownerId, token, baseUrl);
			} catch (err) {
				log.warn("weixin", `ignoring invalid saved account ${candidate}`, errorText(err));
			}
		}
		return undefined;
	}

	private assertOwnerChat(chatId: string): void {
		if (chatId !== this.ownerId) throw new Error("Weixin transport is bound to its QR-login owner only");
	}

	private contextToken(upstream: Awaited<ReturnType<typeof loadWeixinUpstream>>): string | undefined {
		return upstream.inbound.getContextToken(this.accountId, this.ownerId) as string | undefined;
	}

	private nextLocalMessageId(): number {
		this.localMessageId += 1;
		if (this.localMessageId >= Number.MAX_SAFE_INTEGER) this.localMessageId = 1;
		return this.localMessageId;
	}

	private rememberMessage(key: string): boolean {
		if (this.seen.has(key)) return false;
		this.seen.add(key);
		this.seenOrder.push(key);
		if (this.seenOrder.length > MAX_SEEN_IDS) {
			const oldest = this.seenOrder.shift();
			if (oldest) this.seen.delete(oldest);
		}
		return true;
	}

	private async storeMedia(buffer: Buffer, fileName: string, contentType?: string): Promise<{ path: string }> {
		const safeName = mediaFileName(fileName, contentType, buffer);
		const destination = join(weixinRuntimePaths.mediaDir, `${randomUUID()}${mediaExtension(safeName, contentType, buffer)}`);
		await writeFile(destination, buffer, { flag: "wx", mode: 0o600 });
		return { path: destination };
	}

	private createAttachmentHandle(path: string, fileName: string): string {
		if (!privateFilePath(path)) throw new Error("Upstream media path escaped the private Weixin media directory");
		const fileId = `weixin:${randomUUID()}`;
		this.attachments.set(fileId, { path, fileName });
		return fileId;
	}

	private async dispatchIncoming(upstream: Awaited<ReturnType<typeof loadWeixinUpstream>>, msg: any, onMessage: (m: IncomingMessage) => void): Promise<void> {
		const senderId = typeof msg?.from_user_id === "string" ? msg.from_user_id.trim() : "";
		if (!senderId || senderId !== this.ownerId) return;

		// Only authenticated owner messages can update tokens or trigger media I/O.
		const newContextToken = typeof msg.context_token === "string" ? msg.context_token.trim() : "";
		if (newContextToken) upstream.inbound.setContextToken(this.accountId, this.ownerId, newContextToken);

		const items = Array.isArray(msg.item_list) ? msg.item_list : [];
		const mediaItem = items.find((item: any) => upstream.inbound.isMediaItem(item));
		const voiceHasTranscript = mediaItem?.type === upstream.types.MessageItemType.VOICE && Boolean(mediaItem.voice_item?.text?.trim());
		let mediaOptions: any = {};
		let attachment: Attachment | undefined;

		if (mediaItem && !voiceHasTranscript) {
			const fallbackName = mediaItem.type === upstream.types.MessageItemType.IMAGE
				? "image"
				: mediaItem.type === upstream.types.MessageItemType.VIDEO
					? "video.mp4"
					: mediaItem.type === upstream.types.MessageItemType.VOICE
						? "voice.silk"
						: mediaItem.file_item?.file_name || "attachment";
			const fileName = safeFileName(mediaItem.file_item?.file_name, fallbackName);
			let actualFileName = fileName;
			try {
				mediaOptions = await upstream.mediaDownload.downloadMediaFromItem(mediaItem, {
					cdnBaseUrl: upstream.accounts.CDN_BASE_URL,
					mediaSubdir: "weixin-inbound",
					label: "authorized owner message",
					log: (message: string) => log.info("weixin", message),
					errLog: (message: string) => log.warn("weixin", message),
					saveMedia: async (buffer: Buffer, contentType?: string, _subdir?: string, _maxBytes?: number, originalFilename?: string) => {
						actualFileName = mediaFileName(originalFilename || fileName, contentType, buffer);
						return this.storeMedia(buffer, actualFileName, contentType);
					},
				});
				const savedPath = mediaOptions.decryptedPicPath ?? mediaOptions.decryptedFilePath ?? mediaOptions.decryptedVideoPath ?? mediaOptions.decryptedVoicePath;
				if (typeof savedPath === "string") {
					attachment = { path: savedPath, fileName: actualFileName };
				}
			} catch (err) {
				log.warn("weixin", "authorized attachment could not be downloaded", errorText(err));
			}
		}

		const context = upstream.inbound.weixinMessageToMsgContext(msg, this.accountId, mediaOptions) as { Body?: string; Timestamp?: number };
		const text = typeof context.Body === "string" ? context.Body : "";
		if (!text && !attachment) return;

		let document: IncomingMessage["document"];
		if (attachment) {
			const fileId = this.createAttachmentHandle(attachment.path, attachment.fileName);
			document = { fileId, fileName: attachment.fileName };
		}
		const localId = this.nextLocalMessageId();
		const incoming: IncomingMessage = {
			updateId: localId,
			chatId: this.ownerId,
			messageId: localId,
			fromId: this.ownerId,
			fromName: this.ownerId,
			text,
			date: new Date(typeof context.Timestamp === "number" ? context.Timestamp : Date.now()),
			chatType: "private",
			...(document ? { document } : {}),
		};
		try {
			onMessage(incoming);
		} catch (err) {
			log.warn("weixin", "message callback failed", errorText(err));
			throw err;
		}
	}

	async poll(onMessage: (m: IncomingMessage) => void, signal: AbortSignal, onReady?: () => void): Promise<void> {
		if (this.pollActive) throw new Error("Weixin poll is already active");
		const upstream = await loadWeixinUpstream();
		const syncPath = upstream.syncBuf.getSyncBufFilePath(this.accountId) as string;
		let cursor = (upstream.syncBuf.loadGetUpdatesBuf(syncPath) as string | undefined) ?? "";
		let backoff = 1000;
		let nextPollTimeoutMs: number | undefined;
		let started = false;
		this.pollActive = true;
		try {
			try {
				upstream.sessionGuard.assertSessionActive(this.accountId);
				const start = await upstream.api.notifyStart({ baseUrl: this.baseUrl, token: this.token });
				const startError = weixinApiResponseError("notifyStart", start);
				if (startError) throw startError;
				started = true;
			} catch (err) {
				pauseOnStaleToken(upstream, this.accountId, err);
				log.warn("weixin", "notifyStart failed; continuing to poll", errorText(err));
			}
			try {
				onReady?.();
			} catch (err) {
				log.warn("weixin", "ready callback failed", errorText(err));
			}

			while (!signal.aborted) {
				try {
					upstream.sessionGuard.assertSessionActive(this.accountId);
					const response = await upstream.api.getUpdates({
						baseUrl: this.baseUrl,
						token: this.token,
						get_updates_buf: cursor,
						...(nextPollTimeoutMs ? { timeoutMs: nextPollTimeoutMs } : {}),
						abortSignal: signal,
					});
					const responseError = weixinApiResponseError("getUpdates", response);
					if (responseError) {
						pauseOnStaleToken(upstream, this.accountId, responseError);
						throw responseError;
					}
					backoff = 1000;
					let nextCursor = cursor;
					if (typeof response.get_updates_buf === "string") nextCursor = response.get_updates_buf;
					if (typeof response.longpolling_timeout_ms === "number" && response.longpolling_timeout_ms > 0) {
						nextPollTimeoutMs = Math.max(1000, Math.min(120_000, response.longpolling_timeout_ms + 5000));
					}
					for (const msg of Array.isArray(response.msgs) ? response.msgs : []) {
						if (signal.aborted) break;
						if (
							msg.message_type !== upstream.types.MessageType.USER ||
							(msg.message_state !== undefined && msg.message_state !== upstream.types.MessageState.FINISH)
						) continue;
						const messageId = upstream.inbound.getWeixinMessageId(msg) as string | undefined;
						const key = messageId || JSON.stringify(msg);
						if (this.seen.has(key)) continue;
						// Normalize and persist any authorized attachment before acknowledging the cursor.
						await this.dispatchIncoming(upstream, msg, onMessage);
						this.rememberMessage(key);
					}
					if (!signal.aborted && nextCursor !== cursor) {
						cursor = nextCursor;
						upstream.syncBuf.saveGetUpdatesBuf(syncPath, cursor);
					}
				} catch (err) {
					if (signal.aborted) break;
					pauseOnStaleToken(upstream, this.accountId, err);
					log.warn("weixin", `poll failed; retrying in ${backoff / 1000}s`, errorText(err));
					await sleep(backoff, signal);
					backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
				}
			}
		} finally {
			this.pollActive = false;
			if (started) {
				try {
					const stop = await upstream.api.notifyStop({ baseUrl: this.baseUrl, token: this.token });
					const stopError = weixinApiResponseError("notifyStop", stop);
					if (stopError) log.warn("weixin", "notifyStop failed", errorText(stopError));
				} catch (err) {
					log.warn("weixin", "notifyStop failed", errorText(err));
				}
			}
		}
	}

	async send(chatId: string, text: string, _opts: { silent?: boolean } = {}): Promise<number> {
		this.assertOwnerChat(chatId);
		const upstream = await loadWeixinUpstream();
		upstream.sessionGuard.assertSessionActive(this.accountId);
		try {
			const result = await upstream.send.sendMessageWeixin({
				to: this.ownerId,
				text,
				opts: { baseUrl: this.baseUrl, token: this.token, contextToken: this.contextToken(upstream), accountId: this.accountId },
			});
			const responseError = weixinApiResponseError("sendMessageWeixin", result);
			if (responseError) throw responseError;
			return this.nextLocalMessageId();
		} catch (err) {
			pauseOnStaleToken(upstream, this.accountId, err);
			throw err;
		}
	}

	async edit(_chatId: string, _messageId: number, _text: string): Promise<void> {
		throw new Error("Weixin does not support editing messages");
	}

	async remove(_chatId: string, _messageId: number): Promise<void> {
		throw new Error("Weixin does not support removing messages");
	}

	async typing(chatId: string): Promise<void> {
		try {
			this.assertOwnerChat(chatId);
			const upstream = await loadWeixinUpstream();
			upstream.sessionGuard.assertSessionActive(this.accountId);
			const config = await upstream.api.getConfig({
				baseUrl: this.baseUrl,
				token: this.token,
				ilinkUserId: this.ownerId,
				contextToken: this.contextToken(upstream),
			});
			const configError = weixinApiResponseError("getConfig", config);
			if (configError) {
				pauseOnStaleToken(upstream, this.accountId, configError);
				throw configError;
			}
			if (typeof config.typing_ticket !== "string" || !config.typing_ticket) return;
			await upstream.api.sendTyping({
				baseUrl: this.baseUrl,
				token: this.token,
				body: { ilink_user_id: this.ownerId, typing_ticket: config.typing_ticket },
			});
		} catch (err) {
			log.warn("weixin", "typing indicator failed", errorText(err));
		}
	}

	async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
		this.assertOwnerChat(chatId);
		const upstream = await loadWeixinUpstream();
		upstream.sessionGuard.assertSessionActive(this.accountId);
		try {
			const result = await upstream.sendMedia.sendWeixinMediaFile({
				filePath: path,
				to: this.ownerId,
				text: caption ?? "",
				opts: { baseUrl: this.baseUrl, token: this.token, contextToken: this.contextToken(upstream), accountId: this.accountId },
				cdnBaseUrl: upstream.accounts.CDN_BASE_URL,
			});
			const responseError = weixinApiResponseError("sendWeixinMediaFile", result);
			if (responseError) throw responseError;
		} catch (err) {
			pauseOnStaleToken(upstream, this.accountId, err);
			throw err;
		}
	}

	async download(fileId: string, dest: string): Promise<void> {
		const attachment = this.attachments.get(fileId);
		if (!attachment || !privateFilePath(attachment.path)) throw new Error("Unknown or expired Weixin attachment handle");
		await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
		await copyFile(attachment.path, dest);
	}
}
