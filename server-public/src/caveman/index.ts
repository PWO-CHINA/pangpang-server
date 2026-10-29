// caveman: token compression for pangpang's chat sessions.
//
// Internalized from @caveman-ai/pi 0.1.1 (packages/pi-extension of
// JuliusBrussee/caveman at 2fd153c, MIT).  Kept from upstream: the
// caveman_retrieve recovery tool, the lifecycle bridge into caveman's native
// runtime (Core context, per-turn context, tool-output shrinking), and the
// recovery gate.  pangpang changes:
//   - routing applies to model-pool targets (routes.ts), not the selected
//     model, which is the virtual alias/main;
//   - hooks call the Go `caveman-proxy native-hook` (CAVEMAN_PI_HOOK_CMD in
//     .envrc) instead of the Node CLI, a few ms per event instead of a Node
//     cold start;
//   - no ~/.caveman-cloud lookup, no UI notices (pangpangd logs instead);
//   - the proxy is run by `pp up` (bin/pp), configured by agent/caveman.yaml.
//
// Factory rule (upstream): register synchronously, start nothing until
// session_start.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "../log.ts";
import { HookBridge, promptDigest, taskContinuation, taskTerms, taskType } from "./lifecycle.ts";
import { MAX_CONTEXT_BYTES, additionalContextOf, isLoopbackUrl } from "./protocol.ts";
import { publishedForwardHeadersOf, publishedUpstreamsOf } from "./provider-routing.ts";
import { RecoveryClient } from "./recovery.ts";
import { closeRoutes, openRoutes } from "./routes.ts";
import { shrinkToolResult } from "./tool-output.ts";

const HEALTH_TIMEOUT_MS = 750;
const RECOVERY_TOOL = "caveman_retrieve";

function cavemanHome(): string {
	return process.env.CAVEMAN_HOME ?? "";
}

function gatewayUrl(): string {
	return process.env.CAVE_GATEWAY_URL?.trim() || "http://127.0.0.1:8787";
}

type RunState = {
	instanceToken: string;
	recoveryViaMcp: boolean;
	compatUpstreams: Record<string, string>;
	providerUpstreams: Record<string, string>;
	compatForwardHeaders: Record<string, string[]>;
};

// The gate inputs the running proxy published, or undefined without a valid,
// live run-state file for this gateway.
function readRunState(gateway: string): RunState | undefined {
	let port: string;
	try {
		const url = new URL(gateway);
		if (!isLoopbackUrl(gateway) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return undefined;
		port = url.port || (url.protocol === "https:" ? "443" : "80");
	} catch {
		return undefined;
	}
	try {
		const state = JSON.parse(readFileSync(join(cavemanHome(), "run", `${port}.json`), "utf8"));
		if (state?.schema !== "caveman.proxy.run.v1") return undefined;
		if (!Number.isSafeInteger(state.pid) || state.pid < 1 || state.port !== Number(port)
			|| typeof state.instance_token !== "string" || !state.instance_token) return undefined;
		if (state.owner !== "wrap" && state.owner !== "start") return undefined;
		try {
			process.kill(state.pid, 0);
		} catch {
			return undefined;
		}
		return {
			instanceToken: state.instance_token,
			recoveryViaMcp: state.recovery_via_mcp === true,
			compatUpstreams: publishedUpstreamsOf(state.compat_upstreams),
			providerUpstreams: publishedUpstreamsOf(state.provider_upstreams),
			compatForwardHeaders: publishedForwardHeadersOf(state.compat_forward_headers),
		};
	} catch {
		return undefined;
	}
}

async function proxyAliveOnce(gateway: string, instanceToken: string): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
	try {
		const response = await fetch(`${gateway.replace(/\/+$/, "")}/health/live`, { signal: controller.signal, redirect: "error" });
		await response.body?.cancel();
		return response.ok && response.headers.get("x-caveman-instance") === instanceToken;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

async function readLiveRunState(gateway: string): Promise<RunState | undefined> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const state = readRunState(gateway);
		if (state && await proxyAliveOnce(gateway, state.instanceToken)) return state;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return undefined;
}

export default function caveman(pi: ExtensionAPI): void {
	const bridge = new HookBridge();
	const recovery = new RecoveryClient();
	let sessionId = "default";
	let coreContext: string | undefined;
	let pendingContext: string[] = [];
	let pendingBytes = 0;

	// An extension exception must never crash the session.
	const guard = <H extends (...args: never[]) => unknown>(label: string, fn: H): H =>
		(async (...args: Parameters<H>) => {
			try {
				return await fn(...args);
			} catch (error) {
				log.warn("caveman", `${label}: ${(error as Error).message}`);
				return undefined;
			}
		}) as unknown as H;

	pi.registerTool({
		name: RECOVERY_TOOL,
		label: "Retrieve compressed context",
		description:
			"Recover exact original content from a Caveman recovery handle. Tool outputs may be " +
			"compressed with a <<ccr:HANDLE>> marker; call this when you need the elided details.",
		parameters: Type.Object({
			recovery_handle: Type.String({ description: "Exact ccr_ handle returned by Caveman or copied from a <<ccr:HANDLE>> marker." }),
			query: Type.Optional(Type.String({ description: "One broad description covering every detail needed from this handle." })),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await recovery.retrieve(params.recovery_handle, params.query, signal);
			if (result.isError) throw new Error(result.text || "caveman_retrieve failed");
			return { content: [{ type: "text", text: result.text }], details: { recovery_handle: params.recovery_handle } };
		},
	});

	pi.on("session_start", guard("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		coreContext = undefined;
		pendingContext = [];
		pendingBytes = 0;
		try {
			sessionId = ctx.sessionManager.getSessionId() || "default";
		} catch {
			sessionId = "default";
		}
		// The Go hook prints nothing when there is no Core context to inject, so
		// an empty answer is normal here (the Node CLI always printed JSON).  The
		// gate below proves the runtime is usable instead.
		const start = await bridge.call("SessionStart", { session_id: sessionId });
		coreContext = additionalContextOf(start);
		// Route only when the proxy is alive, published MCP recovery, and this
		// session's recovery client initialized (upstream's recovery gate).
		const gateway = gatewayUrl();
		const published = await readLiveRunState(gateway);
		const recoveryReady = published ? await recovery.ensure() : false;
		const refuse = (reason: string) => {
			log.warn("caveman", `${sessionId}: direct mode, no compression (${reason})`);
			closeRoutes(reason);
		};
		if (!published) return refuse("local proxy not running");
		if (!published.recoveryViaMcp) return refuse("proxy does not publish MCP recovery; set CAVEMAN_RECOVERY=mcp");
		if (!recoveryReady) return refuse("caveman-mcp recovery client did not start");
		if (!isLoopbackUrl(gateway)) return refuse("gateway is not loopback");
		const gateOf = (state: RunState) => ({
			gateway,
			compatUpstreams: state.compatUpstreams,
			providerUpstreams: state.providerUpstreams,
			compatForwardHeaders: state.compatForwardHeaders,
		});
		openRoutes({
			...gateOf(published),
			// The watchdog re-runs the same gate: live run state, recovery published.
			recheck: async () => {
				const state = readRunState(gateway);
				if (!state || !state.recoveryViaMcp || !(await proxyAliveOnce(gateway, state.instanceToken))) return undefined;
				return gateOf(state);
			},
		});
	}));

	pi.on("before_agent_start", guard("before_agent_start", async (event: { prompt: string; systemPrompt: string }, ctx: ExtensionContext) => {
		const response = await bridge.call("UserPromptSubmit", {
			session_id: sessionId,
			model: ctx.model?.id,
			provider: ctx.model?.provider,
			prompt: promptDigest(event.prompt),
			task_type: taskType(event.prompt),
			task_terms: taskTerms(event.prompt),
			task_continuation: taskContinuation(event.prompt),
		});
		const dynamic = [additionalContextOf(response), ...pendingContext].filter(Boolean) as string[];
		pendingContext = [];
		pendingBytes = 0;
		if (!coreContext && dynamic.length === 0) return undefined;
		// Core is appended byte-stably every turn (prefix caching); dynamic
		// context rides only the turn it arrived on.
		const parts = [event.systemPrompt, coreContext, ...dynamic].filter(Boolean) as string[];
		return { systemPrompt: parts.join("\n\n") };
	}));

	pi.on("turn_start", guard("turn_start", () => {
		void bridge.call("ModelBefore", { session_id: sessionId });
	}));
	pi.on("turn_end", guard("turn_end", async () => {
		await bridge.call("ModelAfter", { session_id: sessionId });
		void bridge.call("Stop", { session_id: sessionId });
	}));

	pi.on("tool_call", guard("tool_call", async (event: { toolName: string; input: Record<string, unknown> }) => {
		const response = await bridge.call("PreToolUse", {
			session_id: sessionId,
			tool_name: event.toolName,
			tool_input: event.input,
		});
		const context = additionalContextOf(response);
		const bytes = context ? Buffer.byteLength(context, "utf8") : 0;
		if (context && pendingBytes + bytes <= MAX_CONTEXT_BYTES) {
			pendingContext.push(context);
			pendingBytes += bytes;
		}
		return undefined;
	}));

	// The recovered original must not be shrunk again, or recovery would loop.
	pi.on("tool_result", guard("tool_result", (event: Parameters<typeof shrinkToolResult>[2]) =>
		event.toolName === RECOVERY_TOOL ? undefined : shrinkToolResult(bridge, sessionId, event)));

	pi.on("session_before_compact", guard("session_before_compact", () => {
		void bridge.call("PreCompact", { session_id: sessionId });
		return undefined;
	}));

	pi.on("session_compact", guard("session_compact", async () => {
		const response = await bridge.call("PostCompact", { session_id: sessionId });
		const context = additionalContextOf(response);
		if (context) coreContext = context;
	}));

	pi.on("session_shutdown", guard("session_shutdown", async () => {
		await bridge.call("SessionEnd", { session_id: sessionId });
		recovery.dispose();
	}));
}
