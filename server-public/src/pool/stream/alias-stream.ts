import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Provider,
	type ProviderResponse,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PolicyLoad } from "../alias-config.ts";
import { mirrorTargetMetadata, targetsFor, ZERO_COST } from "../alias/alias-model.ts";
import type { DebugLog } from "../debug-log.ts";
import {
	describeFailure,
	failureStopReason,
	runFallbackChain,
	type AliasMap,
	type CooldownRegistry,
	type FailoverEntryData,
} from "../fallback/index.ts";
import { requestOptions, type ResolvedTargetAuth } from "./request-options.ts";
import type { ProviderResponseMetadata } from "../latency/stats.ts";
import type { AliasSession } from "../status/session-status.ts";
import { resolveAuthenticatedTarget } from "./target-auth.ts";

type Registry = ExtensionContext["modelRegistry"];
type StreamKind = keyof Pick<ProviderStreams, "stream" | "streamSimple">;

interface AliasStreamDependencies {
	aliases: AliasMap;
	/** Re-read per stream so every process follows the current shared rules. */
	policyFor(role: string): PolicyLoad;
	aliasModels: Model<Api>[];
	session: AliasSession<Registry, ExtensionContext["ui"]>;
	cooldowns: CooldownRegistry;
	debugLog: DebugLog;
	onTargetSelected(role: string, targetRef: string): void;
	onFailover(data: FailoverEntryData): void;
}

export interface AliasSourceIdentity {
	provider: string;
	api: string;
	model: string;
}

type AliasAssistantMessage = AssistantMessage & { aliasSource?: AliasSourceIdentity };
type HistorySourceIdentity = { provider: string; api?: string; model: string };

export function createAliasStreams(dependencies: AliasStreamDependencies): ProviderStreams {
	return {
		stream(model, context, options) {
			return createFallbackStream("stream", model, context, options, dependencies);
		},
		streamSimple(model, context, options) {
			return createFallbackStream("streamSimple", model, context, options, dependencies);
		},
	};
}

function createFallbackStream(
	kind: StreamKind,
	aliasModel: Model<Api>,
	context: Context,
	options: StreamOptions | SimpleStreamOptions | undefined,
	dependencies: AliasStreamDependencies,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const {
		aliases,
		policyFor,
		aliasModels,
		session,
		cooldowns,
		debugLog,
		onTargetSelected,
		onFailover,
	} = dependencies;
	const registry = session.registry;
	if (!registry) {
		const error = new Error(`Model alias "${aliasModel.id}" cannot stream before a session starts in this process`);
		debugLog.log("open-attempt", { role: aliasModel.id, ok: false, reason: error.message });
		endWithError(output, aliasModel, error, undefined, options?.signal);
		return output;
	}
	// Targets stay as registered at load; only policy follows the file.
	const targets = targetsFor(aliasModel, aliases);
	const { policy, configLoadMs, degraded } = policyFor(aliasModel.id);
	const metadataByTarget = new Map<string, ProviderResponseMetadata>();
	let lastPartial: AssistantMessage | undefined;
	let activeTarget: AliasSourceIdentity | undefined;

	void runFallbackChain({
		role: aliasModel.id,
		targets,
		cooldowns,
		policy,
		signal: options?.signal,
		open: async (targetRef, attemptSignal) => {
			try {
				metadataByTarget.delete(targetRef);
				const target = await resolveAuthenticatedTarget(aliasModel.id, targetRef, registry);
				mirrorTargetMetadata(aliasModel, aliasModels, target.model);
				activeTarget = identityOf(target.model);
				const stream = openTargetStream(
					kind,
					target,
					contextForTarget(context, target.model, aliases),
					withResponseCapture(options, (response) => metadataByTarget.set(targetRef, response)),
					linkedSignal(options?.signal, attemptSignal),
				);
				session.activeTargets.set(aliasModel.id, targetRef);
				onTargetSelected(aliasModel.id, targetRef);
				debugLog.log("open-attempt", { role: aliasModel.id, targetRef, ok: true });
				return stream;
			} catch (error) {
				debugLog.log("open-attempt", {
					role: aliasModel.id,
					targetRef,
					ok: false,
					reason: describeFailure(error),
				});
				throw error;
			}
		},
		forward: (event) => {
			const forwarded = withAliasIdentity(event, aliasModel, activeTarget);
			lastPartial = partialFrom(forwarded) ?? lastPartial;
			output.push(forwarded);
		},
		// configLoadMs and configDegraded ride the existing record; a separate event
		// would add one more synchronous append per stream.
		onLatency: (sample) =>
			debugLog.log("attempt-latency", {
				...sample,
				configLoadMs,
				configDegraded: degraded,
				...metadataByTarget.get(sample.targetRef),
			}),
		onTimeout: (targetRef, reason) => debugLog.log("attempt-timeout", { role: aliasModel.id, targetRef, reason }),
		warn: (failedTarget, reason, nextTarget, cooldown) =>
			onFailover({
				role: aliasModel.id,
				failedTarget,
				...(nextTarget ? { nextTarget } : {}),
				reason,
				cooldownMs: cooldown.durationMs,
				failCount: cooldown.failCount,
				timestamp: Date.now(),
				...metadataByTarget.get(failedTarget),
			}),
		// Pi treats a restart as a second assistant message, so safe prefixes stay hidden until commit.
		snapshot: (event) => structuredClone(event),
	})
		.then(() => output.end())
		.catch((error) => endWithError(output, aliasModel, error, lastPartial, options?.signal));
	return output;
}

function openTargetStream(
	kind: StreamKind,
	target: { model: Model<Api>; provider: Provider; auth: ResolvedTargetAuth },
	context: Context,
	options: StreamOptions | SimpleStreamOptions | undefined,
	signal: AbortSignal | undefined,
): AssistantMessageEventStream {
	const request = requestOptions(options, target.auth, signal);
	// pangpang: pi 0.87 brands transcript contexts; the alias forwards the one it received.
	const transcript = context as Parameters<Provider["stream"]>[1];
	return kind === "streamSimple"
		? target.provider.streamSimple(target.model, transcript, request as SimpleStreamOptions)
		: target.provider.stream(target.model, transcript, request);
}

function withResponseCapture<T extends StreamOptions | SimpleStreamOptions>(
	options: T | undefined,
	capture: (metadata: ProviderResponseMetadata) => void,
): T {
	return {
		...options,
		onResponse: async (response: ProviderResponse, model: Model<Api>) => {
			capture(responseMetadata(response));
			await options?.onResponse?.(response, model);
		},
	} as T;
}

function responseMetadata(response: ProviderResponse): ProviderResponseMetadata {
	const diagnosticHeaders = allowlistedHeaders(response.headers ?? {});
	return {
		httpStatus: response.status,
		...(diagnosticHeaders["x-amzn-requestid"] ? { requestId: diagnosticHeaders["x-amzn-requestid"] } : {}),
		...(diagnosticHeaders["x-amzn-trace-id"] ? { traceId: diagnosticHeaders["x-amzn-trace-id"] } : {}),
		...(Object.keys(diagnosticHeaders).length > 0 ? { diagnosticHeaders } : {}),
	};
}

const DIAGNOSTIC_HEADER_NAMES = new Set([
	"x-amzn-requestid",
	"x-amzn-trace-id",
	"x-amz-request-id",
	"x-request-id",
]);

function allowlistedHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers)
			.map(([name, value]) => [name.toLowerCase(), value] as const)
			.filter(([name]) => DIAGNOSTIC_HEADER_NAMES.has(name)),
	);
}

function linkedSignal(userSignal: AbortSignal | undefined, attemptSignal: AbortSignal | undefined): AbortSignal | undefined {
	if (!userSignal) return attemptSignal;
	if (!attemptSignal) return userSignal;
	return AbortSignal.any([userSignal, attemptSignal]);
}

function withAliasIdentity(
	event: AssistantMessageEvent,
	aliasModel: Model<Api>,
	activeTarget: AliasSourceIdentity | undefined,
): AssistantMessageEvent {
	if (event.type === "done") {
		return { ...event, message: withAliasMessageIdentity(event.message, aliasModel, activeTarget) };
	}
	if (event.type === "error") {
		return { ...event, error: withAliasMessageIdentity(event.error, aliasModel, activeTarget) };
	}
	return { ...event, partial: withAliasMessageIdentity(event.partial, aliasModel, activeTarget) };
}

function withAliasMessageIdentity(
	message: AssistantMessage,
	aliasModel: Model<Api>,
	activeTarget: AliasSourceIdentity | undefined,
): AliasAssistantMessage {
	const source = identityOf(message) ?? activeTarget;
	return {
		...message,
		api: aliasModel.api,
		provider: aliasModel.provider,
		model: aliasModel.id,
		responseModel: message.responseModel ?? message.model,
		...(source ? { aliasSource: source } : {}),
	} as AliasAssistantMessage;
}

/**
 * Build the provider request transcript without mutating the session context.
 * Thinking is provider-specific state: keep it only when the current target
 * can replay it under the identity that originally produced it.
 */
export function contextForTarget(context: Context, targetModel: Pick<Model<Api>, "provider" | "api" | "id">, aliases: AliasMap): Context {
	const contextWithMessages = context as Context & { messages: Array<Record<string, any>> };
	const target: AliasSourceIdentity = {
		provider: targetModel.provider,
		api: targetModel.api,
		model: targetModel.id,
	};
	const messages = contextWithMessages.messages.map((message) => {
		if (message.role !== "assistant") return message;

		const isAliasHistory = message.provider === "alias" && message.api === "alias-delegate";
		const source: HistorySourceIdentity | undefined = isAliasHistory
			? explicitAliasSource(message) ?? legacyAliasSource(message, aliases)
			: identityOf(message);
		const sameTarget = source !== undefined && source.provider === target.provider && source.model === target.model
			&& (!isAliasHistory || source.api === undefined || source.api === target.api)
			&& (isAliasHistory || source.api === target.api);

		if (sameTarget) {
			if (!isAliasHistory || (message.provider === target.provider && message.api === target.api && message.model === target.model)) {
				return message;
			}
			// pi-ai compares the message identity with the target identity while
			// transforming history. Restore the original source before replay.
			return { ...message, provider: target.provider, api: target.api, model: target.model };
		}

		if (!Array.isArray(message.content) || !message.content.some((block: any) => block?.type === "thinking")) return message;
		return { ...message, content: message.content.filter((block: any) => block?.type !== "thinking") };
	});
	return { ...context, messages } as Context;
}

function identityOf(value: { provider?: unknown; api?: unknown; model?: unknown; id?: unknown }): AliasSourceIdentity | undefined {
	const provider = typeof value.provider === "string" ? value.provider : undefined;
	const api = typeof value.api === "string" ? value.api : undefined;
	const model = typeof value.model === "string" ? value.model : typeof value.id === "string" ? value.id : undefined;
	return provider && api && model ? { provider, api, model } : undefined;
}

function explicitAliasSource(message: Record<string, any>): AliasSourceIdentity | undefined {
	const source = message.aliasSource;
	if (!source || typeof source !== "object") return undefined;
	return identityOf(source);
}

/** Recover old alias transcripts only when their configured role has one exact model-id match. */
function legacyAliasSource(message: Record<string, any>, aliases: AliasMap): HistorySourceIdentity | undefined {
	if (typeof message.model !== "string" || typeof message.responseModel !== "string") return undefined;
	const configured = aliases.get(message.model);
	if (!configured) return undefined;
	const matches = configured.flatMap((targetRef) => {
		const slash = targetRef.indexOf("/");
		if (slash < 1 || slash === targetRef.length - 1) return [];
		const provider = targetRef.slice(0, slash);
		const model = targetRef.slice(slash + 1);
		return message.responseModel === model || message.responseModel === targetRef ? [{ provider, model }] : [];
	});
	return matches.length === 1 ? matches[0] : undefined;
}

function partialFrom(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

function endWithError(
	stream: AssistantMessageEventStream,
	aliasModel: Model<Api>,
	error: unknown,
	partial: AssistantMessage | undefined,
	signal: AbortSignal | undefined,
): void {
	const reason = failureStopReason(error, signal);
	const message = errorMessage(aliasModel, error, partial, reason);
	stream.push({ type: "error", reason, error: message });
	stream.end(message);
}

function errorMessage(
	aliasModel: Model<Api>,
	error: unknown,
	partial: AssistantMessage | undefined,
	reason: "error" | "aborted",
): AssistantMessage {
	return {
		...(partial ?? emptyAssistantMessage(aliasModel, reason)),
		stopReason: reason,
		errorMessage: describeFailure(error),
	};
}

function emptyAssistantMessage(model: Model<Api>, stopReason: "error" | "aborted"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { ...ZERO_COST, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}
