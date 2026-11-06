// Regression test for alias transcript identity and provider-specific thinking.
// Run inside the deployed/source tree where package-lock dependencies are present:
//   node --disable-warning=ExperimentalWarning test/alias-thinking.ts

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

type Identity = { provider: string; api: string; model: string };
type Message = Record<string, any>;

const piAiEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
function findPiAiRoot(entry: string): string {
	let dir = dirname(entry);
	for (;;) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				if (JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-ai") return dir;
			} catch {}
		}
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`could not find pi-ai package root from ${entry}`);
		dir = parent;
	}
}

const piAiRoot = findPiAiRoot(piAiEntry);
const transformPath = join(piAiRoot, "dist", "api", "transform-messages.js");
assert.ok(existsSync(transformPath), `pi-ai transform module not found: ${transformPath}`);
const { transformMessages } = await import(pathToFileURL(transformPath).href) as {
	transformMessages: (messages: Message[], model: Record<string, any>) => Message[];
};
assert.equal(typeof transformMessages, "function", "pi-ai transformMessages export unavailable");

const deepseek = {
	provider: "deepseek",
	api: "openai-completions",
	id: "deepseek-flash",
	input: ["text", "image"],
};
const aliases = new Map<string, readonly string[]>([
	["main", ["deepseek/deepseek-flash"]],
	["ambiguous", ["deepseek/flash", "mimo/flash"]],
	["mimo", ["mimo/mimo-v2.6-pro"]],
]);
const thinkingBlock = () => ({
	type: "thinking",
	thinking: "PRIVATE_THINKING_CANARY",
	thinkingSignature: "reasoning_content",
});
const publicText = { type: "text", text: "PUBLIC_FINAL_CANARY" };
const legacyAliasMessage = (changes: Record<string, unknown> = {}): Message => ({
	role: "assistant",
	provider: "alias",
	api: "alias-delegate",
	model: "main",
	responseModel: "deepseek-flash",
	stopReason: "stop",
	content: [thinkingBlock(), publicText],
	timestamp: Date.now(),
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	...changes,
});
const sdkTarget = (id = deepseek.id, provider = deepseek.provider) => ({
	provider,
	api: "openai-completions",
	id,
	input: ["text", "image"],
});
const privateText = (messages: Message[]) => messages.flatMap((message) =>
	(Array.isArray(message.content) ? message.content : []).filter((block: any) => block?.type === "text").map((block: any) => block.text),
).join("\n");
const thinking = (messages: Message[]) => messages.flatMap((message) =>
	(Array.isArray(message.content) ? message.content : []).filter((block: any) => block?.type === "thinking"),
);

const streamModule = await import("../src/pool/stream/alias-stream.ts") as any;
const prepareContext = typeof streamModule.contextForTarget === "function"
	? streamModule.contextForTarget as (context: any, target: any, aliases: Map<string, readonly string[]>) => any
	// On the old implementation, pass-through makes the SDK itself expose the
	// regression as thinking-to-text conversion instead of failing to import.
	: (context: any) => context;

const failures: string[] = [];
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
	try {
		await run();
		console.log(`ok ${name}`);
	} catch (error) {
		failures.push(`${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	}
}

await check("legacy unique alias history restores source identity and reasoning_content", () => {
	const system = { role: "system", content: "NORMALIZED_SYSTEM_CANARY" };
	const toolCall = { type: "toolCall", id: "call-1", name: "exec", arguments: { command: "true" } };
	const userImage = { role: "user", content: [{ type: "text", text: "IMAGE_CANARY" }, { type: "image", data: "AA==", mimeType: "image/png" }] };
	const original = {
		messages: [system, legacyAliasMessage({ content: [thinkingBlock(), publicText, toolCall] }), userImage],
		tools: [{ name: "exec", description: "test tool", parameters: { type: "object", properties: {} } }],
	};
	const snapshot = structuredClone(original);
	const request = prepareContext(original, deepseek, aliases);
	const transformed = transformMessages(request.messages, sdkTarget());
	assert.ok(
		thinking(transformed).some((block: any) => block.thinking === "PRIVATE_THINKING_CANARY"),
		`SDK downgraded same-target reasoning into text: ${privateText(transformed)}`,
	);
	assert.doesNotMatch(privateText(transformed), /PRIVATE_THINKING_CANARY/);
	assert.notEqual(request, original, "provider context should be a copy");
	assert.notEqual(request.messages, original.messages, "provider messages should use a fresh array");
	assert.deepEqual(original, snapshot, "preparing a request must not mutate session history");
	assert.equal(request.messages[0], system, "normalized system message should be reused, not reinserted");
	assert.equal(request.messages.length, original.messages.length, "system message should not be duplicated");
	assert.equal(request.tools, original.tools, "tool definitions should stay attached to the context");
	const restored = request.messages[1];
	assert.deepEqual({ provider: restored.provider, api: restored.api, model: restored.model }, {
		provider: "deepseek", api: "openai-completions", model: "deepseek-flash",
	});
	assert.equal(restored.content[0].type, "thinking");
	assert.equal(restored.content[0].thinkingSignature, "reasoning_content");
	assert.equal(restored.content[2], toolCall, "tool call block should be preserved");
	assert.equal(request.messages[2], userImage, "image-bearing user message should be preserved");
});

await check("new aliasSource metadata restores only the matching target", () => {
	const message = legacyAliasMessage({
		aliasSource: { provider: "deepseek", api: "openai-completions", model: "deepseek-flash" },
	});
	const request = prepareContext({ messages: [message] }, deepseek, new Map());
	const transformed = transformMessages(request.messages, sdkTarget());
	assert.ok(thinking(transformed).some((block: any) => block.thinking === "PRIVATE_THINKING_CANARY"));
	assert.deepEqual({
		provider: request.messages[0].provider,
		api: request.messages[0].api,
		model: request.messages[0].model,
	}, { provider: "deepseek", api: "openai-completions", model: "deepseek-flash" });
	assert.equal(request.messages[0].content[0].type, "thinking");
	assert.equal(thinking(transformed)[0]?.thinkingSignature, "reasoning_content");
});

await check("legacy source matching is conservative for duplicate model IDs", () => {
	const ambiguous = legacyAliasMessage({ model: "ambiguous", responseModel: "flash" });
	const request = prepareContext({ messages: [ambiguous] }, sdkTarget("flash"), aliases);
	assert.equal(request.messages[0].provider, "alias", "ambiguous legacy identity must not be guessed");
	assert.equal(request.messages[0].api, "alias-delegate");
	assert.equal(request.messages[0].content.some((block: any) => block.type === "thinking"), false);
	const transformed = transformMessages(request.messages, sdkTarget("flash"));
	assert.doesNotMatch(JSON.stringify(transformed), /PRIVATE_THINKING_CANARY/);
});

await check("foreign native thinking is removed before SDK transformation", () => {
	const foreign: Message = {
		role: "assistant",
		provider: "mimo",
		api: "openai-completions",
		model: "mimo-v2.6-pro",
		content: [thinkingBlock(), publicText],
	};
	const request = prepareContext({ messages: [foreign] }, deepseek, aliases);
	assert.equal(request.messages[0].content.length, 1);
	assert.equal(request.messages[0].content[0].type, "text");
	const transformed = transformMessages(request.messages, sdkTarget());
	assert.doesNotMatch(JSON.stringify(transformed), /PRIVATE_THINKING_CANARY/);
	assert.match(privateText(transformed), /PUBLIC_FINAL_CANARY/);
});

await check("native same-target assistant remains unchanged", () => {
	const native: Message = {
		role: "assistant",
		provider: "deepseek",
		api: "openai-completions",
		model: "deepseek-flash",
		content: [thinkingBlock(), publicText],
	};
	const request = prepareContext({ messages: [native] }, deepseek, aliases);
	assert.equal(request.messages[0], native);
	assert.equal(request.messages[0].content[0].type, "thinking");
	const transformed = transformMessages(request.messages, sdkTarget());
	assert.match(JSON.stringify(thinking(transformed)), /PRIVATE_THINKING_CANARY/);
	assert.doesNotMatch(privateText(transformed), /PRIVATE_THINKING_CANARY/);
});

await check("createAliasStreams sends a copied, target-correct transcript and records true source", async () => {
	const source = legacyAliasMessage({ content: [thinkingBlock(), publicText] });
	const original = {
		messages: [{ role: "system", content: "NORMALIZED_SYSTEM_CANARY" }, source],
		tools: [{ name: "exec", description: "test tool", parameters: { type: "object", properties: {} } }],
	};
	const originalSnapshot = structuredClone(original);
	let receivedContext: any;
	const targetModel: any = {
		...deepseek,
		baseUrl: "https://api.deepseek.com/v1",
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
	const provider: any = {
		stream: async (_model: unknown, context: any) => {
			receivedContext = context;
			return {
				async *[Symbol.asyncIterator]() {
					yield {
						type: "done",
						message: {
							role: "assistant",
							provider: "deepseek",
							api: "openai-completions",
							model: "deepseek-flash",
							responseModel: "deepseek-flash",
							stopReason: "stop",
							content: [publicText],
							timestamp: Date.now(),
							usage: {
								input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					};
				},
			};
		},
	};
	const registry: any = {
		find: (providerId: string, modelId: string) => providerId === "deepseek" && modelId === "deepseek-flash" ? targetModel : undefined,
		getProvider: (providerId: string) => providerId === "deepseek" ? provider : undefined,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		isUsingOAuth: () => false,
	};
	const aliasModel: any = {
		id: "main", provider: "alias", api: "alias-delegate", baseUrl: "https://pi-model-alias.invalid",
		input: ["text", "image"], reasoning: true, contextWindow: 128000, maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const streams = streamModule.createAliasStreams({
		aliases: new Map([["main", ["deepseek/deepseek-flash"]]]),
		policyFor: () => ({ policy: { cooldown: { baseMs: 1, capMs: 2, resetSuccesses: 1 } }, configLoadMs: 0, degraded: false }),
		aliasModels: [aliasModel],
		session: { registry, activeTargets: new Map() },
		cooldowns: {
			isActive: () => false,
			recordFailure: () => ({ failCount: 1, nextRetryAt: Date.now() + 1, durationMs: 1 }),
			recordSuccess: () => {},
			resetSuccesses: () => {},
			clearAll: () => 0,
			state: () => undefined,
		},
		debugLog: { log: () => {} },
		onTargetSelected: () => {},
		onFailover: () => {},
	});
	const output = streams.stream(aliasModel, original as any, {} as any);
	const emitted: any[] = [];
	for await (const event of output as any) emitted.push(event);
	const transformed = transformMessages(receivedContext.messages, sdkTarget());
	assert.ok(
		thinking(transformed).some((block: any) => block.thinking === "PRIVATE_THINKING_CANARY"),
		`SDK downgraded historical reasoning into text: ${privateText(transformed)}`,
	);
	assert.doesNotMatch(privateText(transformed), /PRIVATE_THINKING_CANARY/);
	assert.deepEqual(original, originalSnapshot, "stream preparation must not mutate the context");
	assert.ok(receivedContext && receivedContext !== original);
	assert.equal(receivedContext.tools, original.tools);
	assert.equal(receivedContext.messages.length, 2, "normalized system message should be forwarded once");
	const done = emitted.find((event) => event.type === "done");
	assert.ok(done);
	assert.deepEqual({ provider: done.message.provider, api: done.message.api, model: done.message.model }, {
		provider: "alias", api: "alias-delegate", model: "main",
	}, "alias identity should remain stable for the UI and transcript");
	assert.deepEqual(done.message.aliasSource, {
		provider: "deepseek", api: "openai-completions", model: "deepseek-flash",
	}, "new transcripts should record the real provider identity");
});

if (failures.length > 0) {
	console.error(`alias-thinking failures:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
	process.exitCode = 1;
} else {
	console.log("all alias-thinking checks passed");
}
