// Drive one delegation to an external coding agent (Codex, Claude Code)
// over the Agent Client Protocol, using the official SDK and adapters.
//
// The adapters are installed outside this project next to the codex and
// claude CLIs; agent/delegates.json says how to start each one.  A run
// spawns the adapter, opens one session in `cwd`, sends the task, collects
// the agent's reply and a log of its tool calls, and answers permission
// requests itself:
//   full  every request is allowed
//   read  edits, deletes and moves are rejected (the agent is also started
//         in its own read-only mode); reads, searches and commands pass
// The whole exchange is written to var/logs/delegations/<id>.log.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AGENT_DIR, PP_VAR } from "../config.ts";

export type DelegateMode = "read" | "full";

export interface AgentSpec {
	/** Adapter entry script, run with the current node. */
	script: string;
	/** Extra environment for the adapter. */
	env?: Record<string, string>;
	/** Environment added per mode, e.g. the agent's initial mode id. */
	modeEnv?: Partial<Record<DelegateMode, Record<string, string>>>;
	/** ACP session mode ids to switch to after the session opens, per mode. */
	sessionMode?: Partial<Record<DelegateMode, string>>;
}

export interface DelegationRequest {
	id: string;
	agent: string;
	task: string;
	cwd: string;
	mode: DelegateMode;
	timeoutMin: number;
	signal: AbortSignal;
}

export interface DelegationResult {
	ok: boolean;
	stopReason: string;
	/** The agent's final reply (text after its last tool call, else all text). */
	reply: string;
	/** Titles of the tool calls it made, in order. */
	tools: string[];
	seconds: number;
	logPath: string;
	error?: string;
}

const MUTATING = new Set(["edit", "delete", "move"]);
const MAX_REPLY = 12_000;

export const delegationLogDir = join(PP_VAR, "logs", "delegations");

export function loadAgents(): Record<string, AgentSpec> {
	return JSON.parse(readFileSync(join(AGENT_DIR, "delegates.json"), "utf8")).agents;
}

export async function runDelegation(req: DelegationRequest): Promise<DelegationResult> {
	const started = Date.now();
	mkdirSync(delegationLogDir, { recursive: true });
	const logPath = join(delegationLogDir, `${req.id}.log`);
	const logLine = (line: string) => appendFileSync(logPath, `${line}\n`);
	logLine(`# ${req.id} ${req.agent} (${req.mode}) in ${req.cwd}\n## Task\n${req.task}\n## Run`);

	const spec = loadAgents()[req.agent];
	if (!spec) throw new Error(`unknown agent ${req.agent}; see agent/delegates.json`);

	const child = spawn(process.execPath, [spec.script], {
		cwd: req.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...spec.env, ...spec.modeEnv?.[req.mode] },
	});
	let stderr = "";
	child.stderr.on("data", (d: Buffer) => {
		stderr = (stderr + d.toString()).slice(-4000);
	});

	let text = "";
	let replyStart = 0;
	const tools: string[] = [];
	let stopReason = "unknown";
	let error: string | undefined;
	let timedOut = false;
	/** Sends ACP session/cancel once the session is open. */
	let cancelSession: (() => Promise<void>) | undefined;

	// Ask the agent to stop gracefully, then kill the adapter if it lingers.
	const stopRun = () => {
		void cancelSession?.().catch(() => {});
		setTimeout(() => child.kill("SIGTERM"), 5000).unref();
	};
	const timer = setTimeout(() => {
		timedOut = true;
		stopRun();
	}, req.timeoutMin * 60_000);
	req.signal.addEventListener("abort", stopRun, { once: true });

	try {
		const stream = acp.ndJsonStream(
			Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
		);
		const response = await acp
			.client({ name: "pangpang" })
			.onRequest(acp.methods.client.session.requestPermission, (ctx) => {
				const { toolCall, options } = ctx.params;
				const deny = req.mode === "read" && MUTATING.has(String(toolCall.kind ?? ""));
				const want = deny ? ["reject_once"] : ["allow_once", "allow_always"];
				const option = options.find((o) => want.includes(o.kind)) ?? options[0];
				logLine(`permission ${deny ? "DENIED" : "allowed"}: ${toolCall.title ?? toolCall.kind}`);
				return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
			})
			.connectWith(stream, async (ctx) => {
				await ctx.request(acp.methods.agent.initialize, {
					protocolVersion: acp.PROTOCOL_VERSION,
					clientCapabilities: {},
				});
				return ctx.buildSession({ cwd: req.cwd, mcpServers: [] }).withSession(async (session) => {
					cancelSession = () => ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
					const modeId = spec.sessionMode?.[req.mode];
					if (modeId) {
						await ctx
							.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId })
							.catch((err: unknown) => logLine(`setMode ${modeId} failed: ${String(err)}`));
					}
					void session.prompt(req.task);
					for (;;) {
						const message = await session.nextUpdate();
						if (message.kind === "stop") return message.response;
						const u = message.notification.update as any;
						if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
							text += u.content.text;
						} else if (u.sessionUpdate === "tool_call") {
							tools.push(u.title ?? u.kind ?? "tool");
							logLine(`tool: ${u.title ?? u.kind}`);
							replyStart = text.length;
						}
					}
				});
			});
		stopReason = response.stopReason;
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		const data = (err as { data?: unknown })?.data;
		if (data) error += ` ${JSON.stringify(data).slice(0, 300)}`;
		if (stderr.trim()) error += `\n${stderr.trim().split("\n").slice(-5).join("\n")}`;
	} finally {
		clearTimeout(timer);
		req.signal.removeEventListener("abort", stopRun);
		child.kill("SIGTERM");
	}

	if (timedOut) error = `timed out after ${req.timeoutMin} min`;
	else if (req.signal.aborted) error = "cancelled";
	const tail = text.slice(replyStart).trim();
	const reply = (tail || text.trim()).slice(-MAX_REPLY);
	logLine(`## Reply (${stopReason}${error ? `, ${error}` : ""})\n${text}`);
	return {
		ok: !error && stopReason === "end_turn",
		stopReason,
		reply,
		tools,
		seconds: Math.round((Date.now() - started) / 1000),
		logPath,
		...(error ? { error } : {}),
	};
}
