// Telegram command system, modelled on OpenClaw's slash commands and cut to
// what a single-owner server agent needs.  Commands are parsed and executed
// here without a model call, except /btw and /skill, which exist to ask one.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "./config.ts";
import type { Conversation } from "./conversation.ts";
import { errorText } from "./log.ts";
import { renderMemorySnapshot } from "./memory.ts";
import { runCommand } from "./automation/actions.ts";
import { cancelJob, formatJob, listJobs, startJob } from "./delegate/jobs.ts";
import type { TaskScheduler } from "./automation/tasks.ts";
import type { Telegram } from "./telegram.ts";

export interface CommandContext {
	tg: Telegram;
	conv: Conversation;
	tasks: TaskScheduler;
	chatId: string;
	fromId: string;
}

interface Command {
	name: string;
	aliases?: string[];
	args?: string;
	description: string;
	/** Hidden from Telegram's command menu (still listed in /help). */
	hidden?: boolean;
	run(ctx: CommandContext, args: string): Promise<string | undefined>;
}

const code = (text: string) => `\`\`\`\n${text.slice(0, 3500)}\n\`\`\``;

const COMMANDS: Command[] = [
	{
		name: "new",
		description: "Fresh context (history stays searchable)",
		async run({ conv }) {
			await conv.reset();
			return "fresh context. Earlier messages are still searchable.";
		},
	},
	{
		name: "stop",
		description: "Stop the current task",
		async run({ conv }) {
			return (await conv.abort()) ? "stopped" : "nothing is running";
		},
	},
	{
		name: "compact",
		args: "[focus]",
		description: "Summarize the context now",
		async run({ conv }, args) {
			return conv.compact(args).catch((err) => `compaction failed: ${errorText(err)}`);
		},
	},
	{
		name: "status",
		description: "Model, pool health, context, state",
		async run({ conv }) {
			const paused = existsSync(paths.pausedFlag) ? "\nautomation: PAUSED" : "";
			return code(conv.status() + paused);
		},
	},
	{
		name: "usage",
		description: "Tokens and cost of this session",
		async run({ conv }) {
			return code(conv.usage());
		},
	},
	{
		name: "model",
		args: "[list | pool | provider/id]",
		description: "Show, list or switch the model",
		async run({ conv }, args) {
			if (!args) return code(conv.status().split("\n").filter((l) => /^(model|pool|  )/.test(l)).join("\n"));
			if (args === "list") return code(conv.models().join("\n"));
			return conv.setModel(args === "pool" ? "alias/main" : args);
		},
	},
	{
		name: "think",
		aliases: ["thinking", "t"],
		args: "[off|minimal|low|medium|high|xhigh]",
		description: "Show or set thinking level",
		async run({ conv }, args) {
			return conv.thinking(args || undefined);
		},
	},
	{
		name: "btw",
		args: "<question>",
		description: "Side question; does not touch the context",
		async run({ conv, tg, chatId }, args) {
			if (!args) return "usage: /btw <question>";
			void tg.typing(chatId);
			return conv.btw(args);
		},
	},
	{
		name: "skill",
		args: "<name> [input]",
		description: "Run a skill",
		async run({ conv }, args) {
			const [name, ...rest] = args.split(/\s+/);
			if (!name) return "usage: /skill <name> [input]";
			void conv.handle({
				text: `Use the "${name}" skill: read its SKILL.md first, then follow it.${rest.length ? `\n\n${rest.join(" ")}` : ""}`,
				name: "owner",
				date: new Date(),
			});
			return undefined;
		},
	},
	{
		name: "caveman",
		args: "[lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra|off]",
		description: "Reply terseness (default full)",
		async run({ conv }, args) {
			const level = args || "full";
			void conv.handle({
				text:
					level === "off"
						? "Stop caveman: reply in normal prose from now on."
						: `Switch reply style to caveman ${level}; read agent/skills/caveman/SKILL.md for the level.`,
				name: "owner",
				date: new Date(),
			});
			return undefined;
		},
	},
	...(["codex", "claude"] as const).map(
		(agent): Command => ({
			name: agent,
			args: "<task>",
			description: `Send a task straight to ${agent === "codex" ? "Codex" : "Claude Code"} (no pangpang tokens)`,
			async run({ tg, chatId, conv }, args) {
				if (!args) return `usage: /${agent} <task>; it runs in the background and replies here`;
				const job = startJob({
					agent,
					task: args,
					cwd: conv.scratch,
					onDone: (j) => tg.send(chatId, formatJob(j)).then(() => {}),
				});
				return `${job.id} started. /jobs to watch, /cancel ${job.id} to stop.`;
			},
		}),
	),
	{
		name: "jobs",
		description: "Delegation jobs (Codex, Claude Code)",
		async run() {
			const jobs = listJobs();
			if (jobs.length === 0) return "no delegation jobs";
			return code(jobs.map((j) => `${j.status.padEnd(9)} ${j.id}
  ${j.task.split("\n")[0].slice(0, 90)}`).join("\n"));
		},
	},
	{
		name: "cancel",
		args: "<job id>",
		description: "Cancel a running delegation",
		async run(_ctx, args) {
			if (!args) return "usage: /cancel <job id>; see /jobs";
			return cancelJob(args) ? `cancelling ${args}` : `${args} is not running`;
		},
	},
	{
		name: "memory",
		description: "Show persistent memory",
		async run() {
			return code(renderMemorySnapshot());
		},
	},
	{
		name: "tasks",
		description: "Scheduled tasks and webhooks",
		async run({ tasks }) {
			const lines = tasks.list().map(
				(t) => `${t.enabled ? "•" : "○"} ${t.name}  ${t.kind}  ${t.when}${t.next && t.next !== t.when ? `  next ${t.next.slice(0, 16)}` : ""}`,
			);
			const hooks = existsSync(paths.hooks)
				? readdirSync(paths.hooks).filter((f) => f.endsWith(".json")).map((f) => {
						let kind = "?";
						try {
							kind = Object.keys(JSON.parse(readFileSync(join(paths.hooks, f), "utf8")).do ?? {})[0] ?? "?";
						} catch {}
						return `• POST /hooks/${basename(f, ".json")}  ${kind}`;
					})
				: [];
			const paused = existsSync(paths.pausedFlag) ? "PAUSED: cron tasks and review are skipped\n\n" : "";
			return code(`${paused}tasks:\n${lines.join("\n") || "(none)"}\n\nhooks:\n${hooks.join("\n") || "(none)"}`);
		},
	},
	{
		name: "run",
		args: "<task>",
		description: "Run a task now",
		async run({ tasks }, args) {
			if (!args) return "usage: /run <task>";
			if (!tasks.has(args)) return `no task ${args}; see /tasks`;
			return `${args}: ${await tasks.fire(`${args}.json`)}`;
		},
	},
	{
		name: "pause",
		description: "Pause cron tasks and background review",
		async run() {
			writeFileSync(paths.pausedFlag, "");
			return "paused: cron tasks and background review are skipped. Chat and reminders still work.";
		},
	},
	{
		name: "resume",
		description: "Resume automation",
		async run() {
			rmSync(paths.pausedFlag, { force: true });
			return "resumed";
		},
	},
	{
		name: "bash",
		args: "<command>",
		description: "Run a shell command (also: !command)",
		async run({ tg, chatId }, args) {
			if (!args) return "usage: /bash <command>";
			void tg.typing(chatId);
			const { code: exit, out } = await runCommand(args, "", 120);
			return `${exit === 0 ? "" : `exit ${exit}\n`}${code(out || "(no output)")}`;
		},
	},
	{
		name: "restart",
		description: "Restart pangpang once idle",
		async run() {
			writeFileSync(paths.restartFlag, "");
			return "restarting once every chat is idle";
		},
	},
	{
		name: "whoami",
		aliases: ["id"],
		description: "Your Telegram ids",
		async run({ chatId, fromId }) {
			return `user ${fromId}, chat ${chatId}`;
		},
	},
	{
		name: "help",
		aliases: ["start", "commands"],
		description: "List commands",
		async run() {
			return [
				"pangpang works on your server. Just write to it; a message sent while it works redirects the task.",
				"",
				...COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""} — ${c.description}`),
			].join("\n");
		},
	},
];

const BY_NAME = new Map<string, Command>();
for (const c of COMMANDS) for (const n of [c.name, ...(c.aliases ?? [])]) BY_NAME.set(n, c);

/** Entries for Telegram's setMyCommands menu. */
export const MENU = COMMANDS.filter((c) => !c.hidden).map((c) => ({ command: c.name, description: c.description }));

/** Handle a command message.  Returns false if the text is not a command. */
export async function handleCommand(text: string, ctx: CommandContext): Promise<boolean> {
	let name: string;
	let args: string;
	if (text.startsWith("!") && text.length > 1) {
		name = "bash";
		args = text.slice(1).trim();
	} else {
		const m = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
		if (!m) return false;
		name = m[1].toLowerCase();
		args = (m[2] ?? "").trim();
	}
	const command = BY_NAME.get(name);
	if (!command) return false;
	let reply: string | undefined;
	try {
		reply = await command.run(ctx, args);
	} catch (err) {
		reply = `/${command.name} failed: ${errorText(err)}`;
	}
	if (reply) await ctx.tg.send(ctx.chatId, reply);
	return true;
}
