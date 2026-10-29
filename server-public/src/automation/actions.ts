// Actions shared by the event model (webhooks, src/automation/hooks.ts) and
// the task model (cron, src/automation/tasks.ts).  Cheapest first:
//
//   { "notify": "template" }                 text to Telegram; no model call
//   { "run": "shell", "then": "notify" }     a command; its output decides what happens
//   { "agent": "template" }                  a model turn in the chat
//
// Templates use {{dotted.path}} into the event context.  A command gets the
// event as JSON on stdin and in $PP_EVENT.  Empty output or a bare NO_REPLY
// is silent; otherwise `then` picks notify (default), agent (only now spend
// tokens, with the output attached), or silent.  A failing command always
// notifies.

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { PP_HOME, paths } from "../config.ts";
import { errorText, log } from "../log.ts";
import { sendBark, sendEmail } from "../notify.ts";

/** Where a notify action (and run output) goes: the chat (default), Bark, or email. */
export type Via = "telegram" | "bark" | "email";

export type Action =
	| { notify: string; via?: Via; title?: string; chat?: string }
	| { run: string; then?: "notify" | "agent" | "silent"; via?: Via; title?: string; prompt?: string; timeoutSec?: number; chat?: string }
	| { agent: string; chat?: string };

export interface ActionRuntime {
	/** Send plain text to a chat. */
	notify(chatId: string, text: string): Promise<void>;
	/** Start a model turn in a chat. */
	wake(chatId: string, text: string): Promise<void>;
	/** Owner chat, used when an action names none. */
	defaultChat(): string | undefined;
}

export type Match = Record<string, string | number | boolean | { re: string } | { in: unknown[] } | { exists: boolean }>;

const MAX_OUTPUT = 64 * 1024;

export function getPath(value: unknown, path: string): unknown {
	let cur = value;
	for (const key of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : (cur as Record<string, unknown>)[key];
	}
	return cur;
}

export function render(template: string, ctx: unknown): string {
	return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
		const v = getPath(ctx, path);
		if (v === undefined || v === null) return "";
		return typeof v === "object" ? JSON.stringify(v) : String(v);
	});
}

/** Every condition must hold.  Plain values compare as strings. */
export function matches(match: Match | undefined, ctx: unknown): boolean {
	if (!match) return true;
	return Object.entries(match).every(([path, want]) => {
		const got = getPath(ctx, path);
		if (want !== null && typeof want === "object") {
			if ("re" in want) return got !== undefined && new RegExp(want.re).test(String(got));
			if ("in" in want) return want.in.map(String).includes(String(got));
			if ("exists" in want) return (got !== undefined) === want.exists;
			return false;
		}
		return got !== undefined && String(got) === String(want);
	});
}

export function runCommand(command: string, input: string, timeoutSec: number): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", command], {
			cwd: PP_HOME,
			env: { ...process.env, PP_EVENT: input },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const take = (buf: Buffer, into: "out" | "err") => {
			if (into === "out" && out.length < MAX_OUTPUT) out += buf.toString();
			if (into === "err" && err.length < MAX_OUTPUT) err += buf.toString();
		};
		child.stdout.on("data", (b: Buffer) => take(b, "out"));
		child.stderr.on("data", (b: Buffer) => take(b, "err"));
		// A command that exits without reading stdin (e.g. `exit 3`) closes the
		// pipe first; that EPIPE is expected and must not crash the daemon.
		child.stdin.on("error", () => {});
		const timer = setTimeout(() => {
			err += `\n(timed out after ${timeoutSec}s)`;
			child.kill("SIGKILL");
		}, timeoutSec * 1000);
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: 127, out: errorText(e) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const text = out.trim() || err.trim();
			resolve({ code, out: text.slice(0, MAX_OUTPUT) });
		});
		child.stdin.end(input);
	});
}

function record(source: string, kind: string, outcome: string, startedAt: number): void {
	const line = { ts: new Date().toISOString(), source, kind, outcome, ms: Date.now() - startedAt };
	try {
		appendFileSync(paths.automationLog, `${JSON.stringify(line)}\n`);
	} catch {
		// History is best effort.
	}
}

async function deliver(rt: ActionRuntime, chat: string, action: { via?: Via; title?: string }, source: string, text: string): Promise<void> {
	const title = action.title ?? `pangpang: ${source}`;
	if (action.via === "bark") await sendBark({ title, body: text });
	else if (action.via === "email") await sendEmail(title, text);
	else await rt.notify(chat, text);
}

/** Execute one action.  Never throws; failures are logged and recorded. */
export async function runAction(source: string, action: Action, ctx: unknown, rt: ActionRuntime): Promise<string> {
	const started = Date.now();
	const chat = action.chat ?? rt.defaultChat();
	let outcome = "ok";
	let kind = "invalid";
	try {
		if (!chat) throw new Error("no chat to deliver to (set TELEGRAM_ALLOWED_USERS)");
		if ("notify" in action) {
			kind = "notify";
			await deliver(rt, chat, action, source, render(action.notify, ctx));
		} else if ("run" in action) {
			kind = "run";
			const { code, out } = await runCommand(action.run, JSON.stringify(ctx), action.timeoutSec ?? 600);
			const silent = out === "" || out === "NO_REPLY";
			if (code !== 0) {
				outcome = `exit ${code}`;
				await rt.notify(chat, `⚠️ ${source} failed (exit ${code})\n\`\`\`\n${out.slice(-3000)}\n\`\`\``);
			} else if (silent || action.then === "silent") {
				outcome = "silent";
			} else if (action.then === "agent") {
				outcome = "woke agent";
				const intro = action.prompt ? render(action.prompt, ctx) : `Output of ${source}:`;
				await rt.wake(chat, `[EVENT:${source}] ${intro}\n\n<output>\n${out}\n</output>`);
			} else {
				outcome = "notified";
				await deliver(rt, chat, action, source, out);
			}
		} else if ("agent" in action) {
			kind = "agent";
			await rt.wake(chat, `[EVENT:${source}] ${render(action.agent, ctx)}`);
		} else {
			throw new Error("action needs one of notify, run, agent");
		}
	} catch (err) {
		outcome = `error: ${errorText(err)}`;
		log.warn("automation", `${source} failed`, errorText(err));
	}
	record(source, kind, outcome, started);
	log.info("automation", `${source}: ${kind} -> ${outcome}`);
	return outcome;
}
