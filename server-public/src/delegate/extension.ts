// pi tools that let pangpang hand heavy work to Codex or Claude Code.
// How to use them well is in the delegation skill (agent/skills/delegation).

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, resolve } from "node:path";
import { loadAgents } from "./acp.ts";
import { cancelJob, formatJob, listJobs, startJob } from "./jobs.ts";

export interface DelegateHost {
	/** Default working directory for delegations from this chat. */
	cwd: string;
	/** Wake this chat with a finished background job's report. */
	deliver(text: string): Promise<void>;
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} };
}

export function delegateExtension(host: DelegateHost): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description:
				"Hand a substantial task to an external coding agent: codex (OpenAI Codex) or claude " +
				"(Claude Code). They run on this server with their own tools and can work for a long " +
				"time. Write the task as a complete brief: goal, where (cwd, hosts), constraints, what to " +
				"verify, and what to report back; they do not see this chat. mode 'read' forbids edits " +
				"(investigations, reviews); 'full' allows everything. background (default true) returns at " +
				"once and wakes you with the report when the job ends; use false only for short jobs you " +
				"need before replying. Read the delegation skill before your first delegation in a session.",
			parameters: Type.Object({
				agent: Type.Union([Type.Literal("codex"), Type.Literal("claude")]),
				task: Type.String({ description: "The complete brief." }),
				mode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("read")])),
				cwd: Type.Optional(Type.String({ description: "Working directory, absolute. Default: this chat's scratch dir." })),
				background: Type.Optional(Type.Boolean()),
				timeout_min: Type.Optional(Type.Number({ description: "Default 60." })),
			}),
			async execute(_id, params) {
				if (!loadAgents()[params.agent]) return text(`agent ${params.agent} is not configured in agent/delegates.json`);
				const cwd = params.cwd ? (isAbsolute(params.cwd) ? params.cwd : resolve(host.cwd, params.cwd)) : host.cwd;
				const background = params.background ?? true;
				const job = startJob({
					agent: params.agent,
					task: params.task,
					cwd,
					mode: params.mode ?? "full",
					timeoutMin: params.timeout_min,
					onDone: background ? (j) => host.deliver(`[EVENT:delegate:${j.id}] ${formatJob(j)}`) : undefined,
				});
				if (background) {
					return text(`${job.id} started in the background (${job.mode}, ${cwd}). You will be woken with its report; tell the owner it is running.`);
				}
				await job.done;
				return text(formatJob(job));
			},
		});

		pi.registerTool({
			name: "delegate_jobs",
			label: "Delegation jobs",
			description: "List recent delegation jobs with their state, or cancel a running one.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("cancel")]),
				id: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				if (params.action === "cancel") {
					if (!params.id) return text("id is required to cancel");
					return text(cancelJob(params.id) ? `cancelling ${params.id}` : `${params.id} is not running`);
				}
				const jobs = listJobs();
				if (jobs.length === 0) return text("no delegation jobs");
				return text(
					jobs
						.map((j) => `${j.id} ${j.status} ${j.mode} ${j.cwd}\n  ${j.task.split("\n")[0].slice(0, 120)}`)
						.join("\n"),
				);
			},
		});
	};
}
