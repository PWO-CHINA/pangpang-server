// Minimal Telegram Bot API client: long polling, messages, edits, files.
// No webhook, so the NAS needs no public address.

import { openAsBlob } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { errorText, log } from "./log.ts";

export interface IncomingMessage {
	updateId: number;
	chatId: string;
	messageId: number;
	fromId: string;
	fromName: string;
	text: string;
	date: Date;
	/** "private", "group", "supergroup" or "channel". */
	chatType?: string;
	chatTitle?: string;
	/** Set on membership service messages, which carry no text. */
	service?: string;
	photoFileId?: string;
	document?: { fileId: string; fileName: string };
}

interface ApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: { retry_after?: number };
}

export class TelegramError extends Error {
	code: number | undefined;
	constructor(message: string, code: number | undefined) {
		super(message);
		this.code = code;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Telegram's hard limit is 4096 characters; leave room for HTML tags. */
export const MESSAGE_LIMIT = 3800;

export class Telegram {
	private base: string;
	private fileBase: string;

	constructor(token: string) {
		this.base = `https://api.telegram.org/bot${token}`;
		this.fileBase = `https://api.telegram.org/file/bot${token}`;
	}

	async call<T>(method: string, params: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const body = params instanceof FormData ? params : JSON.stringify(params);
			const headers: Record<string, string> =
				params instanceof FormData ? {} : { "content-type": "application/json" };
			const res = await fetch(`${this.base}/${method}`, { method: "POST", body, headers, signal });
			const data = (await res.json()) as ApiResponse<T>;
			if (data.ok) return data.result as T;
			const retryAfter = data.parameters?.retry_after;
			if (data.error_code === 429 && retryAfter && attempt < 3) {
				await sleep((retryAfter + 1) * 1000);
				continue;
			}
			throw new TelegramError(`${method}: ${data.description ?? res.statusText}`, data.error_code);
		}
	}

	/** Long-poll for messages until the signal aborts.  Network errors back off and retry. */
	async poll(offset: number, onMessage: (m: IncomingMessage) => void, onOffset: (o: number) => void, signal: AbortSignal) {
		let backoff = 1000;
		while (!signal.aborted) {
			try {
				const updates = await this.call<any[]>(
					"getUpdates",
					{ offset, timeout: 50, allowed_updates: ["message"] },
					signal,
				);
				backoff = 1000;
				for (const u of updates) {
					offset = u.update_id + 1;
					const m = u.message;
					if (m) {
						const parsed = parseMessage(u.update_id, m);
						if (parsed) onMessage(parsed);
					}
				}
				if (updates.length) onOffset(offset);
			} catch (err) {
				if (signal.aborted) return;
				log.warn("telegram", `poll failed, retrying in ${backoff / 1000}s`, errorText(err));
				await sleep(backoff);
				backoff = Math.min(backoff * 2, 60_000);
			}
		}
	}

	/** Send text, converting Markdown to Telegram HTML, falling back to plain text. */
	async send(chatId: string, text: string, opts: { silent?: boolean } = {}): Promise<number> {
		const extra = opts.silent ? { disable_notification: true } : {};
		try {
			const m = await this.call<{ message_id: number }>("sendMessage", {
				chat_id: chatId,
				text: markdownToHtml(text),
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
				...extra,
			});
			return m.message_id;
		} catch (err) {
			if (!(err instanceof TelegramError) || err.code !== 400) throw err;
			const m = await this.call<{ message_id: number }>("sendMessage", { chat_id: chatId, text, ...extra });
			return m.message_id;
		}
	}

	async edit(chatId: string, messageId: number, text: string): Promise<void> {
		try {
			await this.call("editMessageText", {
				chat_id: chatId,
				message_id: messageId,
				text: markdownToHtml(text),
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
		} catch (err) {
			if (!(err instanceof TelegramError) || err.code !== 400) throw err;
			if (/not modified/i.test(err.message)) return;
			try {
				await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text });
			} catch (plainErr) {
				if (!/not modified/i.test(errorText(plainErr))) throw plainErr;
			}
		}
	}

	async remove(chatId: string, messageId: number): Promise<void> {
		await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
	}

	async typing(chatId: string): Promise<void> {
		await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
	}

	async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
		const form = new FormData();
		form.set("chat_id", chatId);
		if (caption) form.set("caption", caption.slice(0, 1000));
		form.set("document", await openAsBlob(path), basename(path));
		await this.call("sendDocument", form);
	}

	async download(fileId: string, dest: string): Promise<void> {
		const file = await this.call<{ file_path: string }>("getFile", { file_id: fileId });
		const res = await fetch(`${this.fileBase}/${file.file_path}`);
		if (!res.ok) throw new Error(`download failed: ${res.status}`);
		await writeFile(dest, Buffer.from(await res.arrayBuffer()));
	}
}

function parseMessage(updateId: number, m: any): IncomingMessage | undefined {
	if (!m.from || !m.chat) return undefined;
	const text: string = m.text ?? m.caption ?? "";
	const photos: any[] | undefined = m.photo;
	const msg: IncomingMessage = {
		updateId,
		chatId: String(m.chat.id),
		messageId: m.message_id,
		fromId: String(m.from.id),
		fromName: m.from.username ?? [m.from.first_name, m.from.last_name].filter(Boolean).join(" "),
		text,
		date: new Date(m.date * 1000),
		chatType: typeof m.chat.type === "string" ? m.chat.type : undefined,
		chatTitle: typeof m.chat.title === "string" ? m.chat.title : undefined,
	};
	if (photos?.length) msg.photoFileId = photos[photos.length - 1].file_id;
	if (m.document) msg.document = { fileId: m.document.file_id, fileName: m.document.file_name ?? "file" };
	if (!msg.text && !msg.photoFileId && !msg.document) {
		// The bot being added to a group is how we learn that group's chat id.
		if (m.new_chat_members) msg.service = "added to chat";
		else if (m.left_chat_member) msg.service = "left chat";
		else return undefined;
	}
	return msg;
}

function escapeHtml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Telegram has no tables: render a Markdown table as aligned monospace text. */
function tableToPre(block: string): string {
	const rows = block
		.trim()
		.split("\n")
		.filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line))
		.map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/\*\*/g, "")));
	const widths: number[] = [];
	for (const row of rows) row.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, [...c].length)));
	const text = rows.map((row) => row.map((c, i) => c + " ".repeat(widths[i] - [...c].length)).join("  ").trimEnd());
	return `<pre>${escapeHtml(text.join("\n"))}</pre>`;
}

/**
 * Convert the Markdown subset models write into Telegram HTML: fenced and
 * inline code, tables (as monospace text), bold, italic, links, and headings
 * (rendered bold).  Code is cut out first so its contents are never
 * reinterpreted.
 */
export function markdownToHtml(md: string): string {
	const slots: string[] = [];
	const keep = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

	let s = md.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) =>
		keep(
			lang
				? `<pre><code class="language-${lang}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`
				: `<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`,
		),
	);
	s = s.replace(/(?:^[ \t]*\|.*\|[ \t]*(?:\n|$)){2,}/gm, (table) => `${keep(tableToPre(table))}\n`);
	s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
	s = escapeHtml(s);
	s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
		keep(`<a href="${url.replaceAll('"', "&quot;")}">${label}</a>`),
	);
	s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
	s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
	s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<i>$2</i>");
	s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
	return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)]);
}

/** Split long text on paragraph, then line, boundaries. */
export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
	if (text.length <= limit) return [text];
	const parts: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n\n", limit);
		if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) cut = limit;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n+/, "");
	}
	if (rest) parts.push(rest);
	return parts;
}
