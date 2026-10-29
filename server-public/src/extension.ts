// The pangpang pi extension: tools and hooks shared by chat sessions and
// the background reviewer.
//
//   memory, session_search, skill_manage, attach   custom tools
//   before_agent_start                              append the frozen memory snapshot
//   session_before_compact                          Hermes-style handoff summary
//   session_compact                                 refresh the frozen snapshot

import { compact, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { log, errorText } from "./log.ts";
import { applyMemoryOps, type MemoryOp, type MemoryTarget } from "./memory.ts";
import { COMPACTION_HANDOFF_PREFIX, COMPACTION_INSTRUCTIONS, stripHandoffPrefix } from "./prompts.ts";
import { resolvePoolModel } from "./pool/resolve.ts";
import { recall } from "./recall.ts";
import { searchLogs } from "./search.ts";
import { sendBark, sendEmail } from "./notify.ts";
import { manageSkill, type SkillRequest } from "./skills.ts";

export interface ExtensionHost {
	/** Current frozen memory snapshot for the system prompt. */
	snapshot(): string;
	/** Rebuild the snapshot (memory and skills) after a compaction. */
	refresh(): Promise<void>;
	/** Send a file to the owner; undefined for sessions without a chat. */
	attach?: (path: string, caption?: string) => Promise<void>;
	/** Count tool calls for the review trigger. */
	onToolCall?: (name: string) => void;
	/** Working directory used to resolve relative paths. */
	cwd: string;
}

function textResult(value: unknown) {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return { content: [{ type: "text" as const, text }], details: {} };
}

const memoryOpSchema = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
	content: Type.Optional(Type.String({ description: "Entry text for add/replace. For replace, the COMPLETE new entry." })),
	old_text: Type.Optional(Type.String({ description: "Short unique substring identifying the entry to replace/remove." })),
});

export function pangpangExtension(host: ExtensionHost): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "memory",
			label: "Memory",
			description:
				"Save durable facts to persistent memory that survives across sessions and compactions. " +
				"Memory is injected into every future turn, so keep entries compact and high-signal.\n\n" +
				"HOW: put ALL changes in ONE call via 'operations' (each {action, content?, old_text?}). The " +
				"batch is atomic and the character budget is checked on the final result, so one call can " +
				"remove stale entries to make room AND add new ones. One call finishes the update.\n\n" +
				"TARGETS: 'user' = who the owner is (preferences, style, expectations). 'memory' = your " +
				"notes about the environment (paths, conventions, tool quirks, lessons).\n\n" +
				"SKIP: trivial or easily rediscovered facts, task progress, completed-work logs, temporary " +
				"state (session_search finds those). Procedures for a class of task belong in a skill.\n\n" +
				"IF FULL: the add is rejected and current entries are shown; reissue ONE batch that removes " +
				"or shortens entries and adds the new one.",
			parameters: Type.Object({
				target: Type.Union([Type.Literal("memory"), Type.Literal("user")]),
				operations: Type.Array(memoryOpSchema, { minItems: 1 }),
			}),
			async execute(_id, params) {
				const result = applyMemoryOps(params.target as MemoryTarget, params.operations as MemoryOp[]);
				return textResult(result);
			},
		});

		pi.registerTool({
			name: "session_search",
			label: "Search history",
			description:
				"Full-text search over every past message in every chat, including turns that were " +
				"compacted out of your context. Use it before saying you do not remember something, and " +
				"to find earlier decisions, commands or results. All terms must match; terms of 3+ " +
				"characters use the index. Returns newest first. When nothing matches exactly, it falls " +
				"back to related past exchanges (fuzzy and semantic recall).",
			parameters: Type.Object({
				query: Type.String({ description: "Words or phrases to find (Chinese works)." }),
				limit: Type.Optional(Type.Number({ description: "Maximum hits, default 20." })),
				chat_id: Type.Optional(Type.String({ description: "Restrict to one chat." })),
			}),
			async execute(_id, params) {
				const hits = searchLogs(params.query, Math.min(params.limit ?? 20, 100), params.chat_id);
				if (hits.length === 0) {
					const related = params.chat_id ? [] : recall(params.query, { limit: 5 });
					if (related.length === 0) return textResult("No matches.");
					return textResult(
						"No exact matches. Related:\n" +
							related.map((h) => `[${h.date.slice(0, 16) || h.source}] ${h.source}: ${h.text.slice(0, 600)}`).join("\n---\n"),
					);
				}
				return textResult(
					hits.map((h) => `[${h.date.slice(0, 16)}] ${h.chat} ${h.role}: ${h.snippet}`).join("\n"),
				);
			},
		});

		pi.registerTool({
			name: "skill_manage",
			label: "Skills",
			description:
				"Create and maintain your skill library: instructions for doing a class of task for this " +
				"owner (procedure, working commands, pitfalls, preferences). Actions: create (content = " +
				"full SKILL.md with frontmatter name/description), patch (old_text -> new_text in SKILL.md; " +
				"read it first), write_file (file_path under references/, templates/ or scripts/), delete. " +
				"Name skills by class of work, never after a single task.",
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("create"),
					Type.Literal("patch"),
					Type.Literal("write_file"),
					Type.Literal("delete"),
				]),
				name: Type.String({ description: "Skill name: lowercase letters, digits, dashes." }),
				content: Type.Optional(Type.String()),
				old_text: Type.Optional(Type.String()),
				new_text: Type.Optional(Type.String()),
				file_path: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				return textResult(manageSkill(params as SkillRequest));
			},
		});

		if (host.attach) {
			const attach = host.attach;
			pi.registerTool({
				name: "attach",
				label: "Send file",
				description: "Send a file to the owner on Telegram (max 50 MB).",
				parameters: Type.Object({
					path: Type.String({ description: "Path of the file to send." }),
					caption: Type.Optional(Type.String()),
				}),
				async execute(_id, params) {
					const file = resolve(host.cwd, params.path);
					if (!existsSync(file) || !statSync(file).isFile()) return textResult(`not a file: ${file}`);
					await attach(file, params.caption);
					return textResult(`sent ${file}`);
				},
			});
		}

		pi.registerTool({
			name: "notify",
			label: "Notify owner",
			description:
				"Push a notification to the owner outside Telegram. Telegram is for conversation; use this " +
				"for things that must reach the owner even when they are not chatting: alerts, reminders, " +
				"finished long work. via 'bark' (iPhone push, default) or 'email' (longer content, records). " +
				"level for bark: passive (silent), active (default), timeSensitive (breaks focus), critical " +
				"(breaks mute; real emergencies only).",
			parameters: Type.Object({
				title: Type.String(),
				body: Type.String(),
				via: Type.Optional(Type.Union([Type.Literal("bark"), Type.Literal("email")])),
				level: Type.Optional(
					Type.Union([Type.Literal("passive"), Type.Literal("active"), Type.Literal("timeSensitive"), Type.Literal("critical")]),
				),
				url: Type.Optional(Type.String({ description: "bark: link opened on tap" })),
			}),
			async execute(_id, params) {
				if ((params.via ?? "bark") === "email") await sendEmail(params.title, params.body);
				else await sendBark({ title: params.title, body: params.body, level: params.level, url: params.url });
				return textResult(`sent via ${params.via ?? "bark"}`);
			},
		});

		pi.on("tool_call", async (event) => {
			host.onToolCall?.(event.toolName);
			return undefined;
		});

		pi.on("before_agent_start", async (event) => {
			return { systemPrompt: `${event.systemPrompt}\n\n${host.snapshot()}` };
		});

		pi.on("session_before_compact", async (event, ctx) => {
			if (!ctx.model) return undefined;
			// compact() calls the provider directly, so a pool alias must be a real model.
			const model = resolvePoolModel(ctx.model, (p, id) => ctx.modelRegistry.find(p, id));
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) return undefined;
				const preparation = {
					...event.preparation,
					previousSummary: stripHandoffPrefix(event.preparation.previousSummary),
				};
				// ProviderHeaders allows null to unset a header; compact() takes plain strings.
				const headers = auth.headers
					? Object.fromEntries(
							Object.entries(auth.headers).filter((e): e is [string, string] => typeof e[1] === "string"),
						)
					: undefined;
				const instructions = [COMPACTION_INSTRUCTIONS, event.customInstructions].filter(Boolean).join("\n\n");
				const result = await compact(
					preparation,
					model,
					auth.apiKey,
					headers,
					instructions,
					event.signal,
					undefined,
					undefined,
					auth.env,
				);
				log.info("compact", `summarized ${result.tokensBefore} tokens (${event.reason})`);
				return { compaction: { ...result, summary: `${COMPACTION_HANDOFF_PREFIX}\n\n${result.summary}` } };
			} catch (err) {
				// Fall back to pi's default compaction rather than failing the turn.
				log.warn("compact", "custom summary failed, using default", errorText(err));
				return undefined;
			}
		});

		pi.on("session_compact", async () => {
			await host.refresh();
		});
	};
}
