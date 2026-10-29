// Out-of-band notifications.  Telegram is where the owner talks with
// pangpang; pushes that must reach them regardless (alerts, reminders,
// finished background work while they are away) go through Bark (iOS push)
// or email.
//
//   BARK_KEY                          device key for https://api.day.app
//   SMTP_URL, SMTP_USER, SMTP_PASS    e.g. smtps://smtp.qq.com:465
//   MAIL_FROM, MAIL_TO                MAIL_FROM defaults to SMTP_USER, MAIL_TO to MAIL_FROM

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BarkLevel = "passive" | "active" | "timeSensitive" | "critical";

export interface BarkMessage {
	title: string;
	body: string;
	group?: string;
	level?: BarkLevel;
	url?: string;
}

export function barkConfigured(): boolean {
	return Boolean(process.env.BARK_KEY);
}

export async function sendBark(msg: BarkMessage): Promise<void> {
	const key = process.env.BARK_KEY;
	if (!key) throw new Error("BARK_KEY is not set in .env");
	const res = await fetch("https://api.day.app/push", {
		method: "POST",
		headers: { "content-type": "application/json; charset=utf-8" },
		body: JSON.stringify({
			device_key: key,
			title: msg.title.slice(0, 200),
			body: msg.body.slice(0, 3000),
			group: msg.group ?? "pangpang",
			level: msg.level ?? "active",
			...(msg.url ? { url: msg.url } : {}),
		}),
	});
	const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
	if (!res.ok || (data.code !== undefined && data.code !== 200)) {
		throw new Error(`bark: ${data.message ?? res.statusText}`);
	}
}

export function emailConfigured(): boolean {
	return Boolean(process.env.SMTP_URL && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function encodeHeader(text: string): string {
	return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;
}

/** Send a plain-text email with the project's curl over SMTP. */
export async function sendEmail(subject: string, body: string, to?: string): Promise<void> {
	const url = process.env.SMTP_URL;
	const user = process.env.SMTP_USER;
	const pass = process.env.SMTP_PASS;
	if (!url || !user || !pass) throw new Error("SMTP_URL, SMTP_USER and SMTP_PASS must be set in .env");
	const from = process.env.MAIL_FROM || user;
	const rcpt = to || process.env.MAIL_TO || from;
	const message = [
		`From: pangpang <${from}>`,
		`To: <${rcpt}>`,
		`Subject: ${encodeHeader(subject)}`,
		`Date: ${new Date().toUTCString()}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		Buffer.from(body).toString("base64").replace(/.{76}/g, "$&\r\n"),
	].join("\r\n");
	// The message goes through a private temp file (TMPDIR is under var/);
	// the password goes through curl's stdin config, never argv.
	const dir = mkdtempSync(join(tmpdir(), "pp-mail-"));
	const file = join(dir, "message.eml");
	writeFileSync(file, message, { mode: 0o600 });
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				"curl",
				["--silent", "--show-error", "--ssl-reqd", "--url", url, "--mail-from", from, "--mail-rcpt", rcpt, "--config", "-", "--upload-file", file],
				{ stdio: ["pipe", "ignore", "pipe"] },
			);
			let err = "";
			child.stderr.on("data", (d: Buffer) => {
				err += d.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`smtp: ${err.trim() || `curl exit ${code}`}`))));
			child.stdin.end(`user = "${user.replaceAll('"', '\\"')}:${pass.replaceAll('"', '\\"')}"\n`);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
