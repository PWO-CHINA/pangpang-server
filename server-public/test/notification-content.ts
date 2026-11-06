// Regression coverage for text that may reach the notification pool.
//
// Run with a Node version that supports node:module.registerHooks:
//   node --disable-warning=ExperimentalWarning test/notification-content.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type RecordedEvent = any;
type Notice = { text: string; options?: Record<string, unknown> };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempParent = resolve(repoRoot, "var", "tmp");
mkdirSync(tempParent, { recursive: true });
const scratch = mkdtempSync(join(tempParent, "notification-content-"));

function isWithin(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assistantEnd(content: unknown[], stopReason: string): RecordedEvent {
	return { type: "message_end", message: { role: "assistant", content, stopReason } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

const failures: string[] = [];
async function check(name: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
		console.log(`ok ${name}`);
	} catch (error) {
		failures.push(`${name}: ${errorMessage(error)}`);
	}
}

try {
	assert.ok(isWithin(tempParent, scratch), "scratch must be a child of var/tmp");

	const testVar = join(scratch, "var");
	const testData = join(scratch, "data");
	const testAgent = join(scratch, "agent");
	process.env.PP_HOME = scratch;
	process.env.PP_VAR = testVar;
	process.env.PP_DATA = testData;
	process.env.PI_CODING_AGENT_DIR = testAgent;
	process.env.PI_MODEL_ALIAS_STATE_DIR = join(scratch, "pool-state");
	for (const [name, path] of Object.entries({ PP_HOME: scratch, PP_VAR: testVar, PP_DATA: testData, PI_CODING_AGENT_DIR: testAgent })) {
		assert.ok(name === "PP_HOME" ? resolve(path) === scratch : isWithin(scratch, path), `${name} must stay inside test scratch`);
	}

	mkdirSync(testAgent, { recursive: true });
	writeFileSync(join(testAgent, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 100 } }));
	writeFileSync(join(testAgent, "models.json"), JSON.stringify({ providers: {} }));
	writeFileSync(join(testAgent, "model-alias.json"), JSON.stringify({}));

	const { registerHooks } = await import("node:module") as any;
	assert.equal(typeof registerHooks, "function", "notification-content test needs node:module.registerHooks");

	const hookKey = "__pangpangNotificationContentTestState";
	const hookState: {
		growth: string[];
		reviewSession?: { prompt: (...args: any[]) => Promise<void>; getLastAssistantText: () => string; dispose: () => void };
	} = { growth: [] };
	(globalThis as any)[hookKey] = hookState;
	const gitMockUrl = `data:text/javascript,${encodeURIComponent(
		`export async function commitGrowth(summary) { globalThis[${JSON.stringify(hookKey)}].growth.push(summary); }`,
	)}`;
	const reviewSessionMockUrl = `data:text/javascript,${encodeURIComponent(
		`export async function createSession() { return globalThis[${JSON.stringify(hookKey)}].reviewSession; }`,
	)}`;
	const conversationPath = resolve(repoRoot, "src", "conversation.ts");
	const reviewPath = resolve(repoRoot, "src", "review.ts");
	const samePath = (url: string | undefined, path: string): boolean => {
		if (!url?.startsWith("file:")) return false;
		return resolve(fileURLToPath(url)).toLocaleLowerCase() === resolve(path).toLocaleLowerCase();
	};
	registerHooks({
		resolve(specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => unknown) {
			if (specifier === "./git.ts" && (samePath(context.parentURL, conversationPath) || samePath(context.parentURL, reviewPath))) {
				return { url: gitMockUrl, shortCircuit: true };
			}
			if (specifier === "./session.ts" && samePath(context.parentURL, reviewPath)) {
				return { url: reviewSessionMockUrl, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});

	const { ensureDirs, paths } = await import("../src/config.ts");
	ensureDirs();
	const { Conversation } = await import("../src/conversation.ts");
	const routeReview = { schedule() {}, cancel() {} };

	function makeConversation(key: string, isEvent: boolean, steps: RecordedEvent[][]) {
		const dir = join(paths.chats, key);
		mkdirSync(join(dir, "scratch"), { recursive: true });
		mkdirSync(join(dir, "attachments"), { recursive: true });
		const sent: { chat: string; text: string }[] = [];
		const notices: Notice[] = [];
		const typing: string[] = [];
		const transport: any = {
			channel: "telegram",
			supportsEdits: true,
			messageLimit: 3800,
			send: async (chat: string, text: string) => (sent.push({ chat, text }), sent.length),
			edit: async () => {},
			remove: async () => {},
			typing: async (chat: string) => void typing.push(chat),
			sendFile: async () => {},
			download: async () => {},
		};
		const notifications: any = {
			notify: async (text: string, options?: Record<string, unknown>) => void notices.push({ text, options }),
			status: () => "pool available",
			setBroadcast: () => {},
			touch: () => {},
			retryPending: async () => {},
		};
		const conv = Object.create(Conversation.prototype) as any;
		Object.assign(conv, {
			chatId: key,
			recipient: `${key}-recipient`,
			dir,
			scratch: join(dir, "scratch"),
			transport,
			notifications,
			channel: "telegram",
			review: routeReview,
			snapshot: "",
			needsReload: false,
			reply: undefined,
			lastAssistant: undefined,
			turnTexts: [],
			queue: Promise.resolve(),
			runningRuns: 0,
			pendingRuns: 0,
			activeEventTurn: false,
			toolCalls: 0,
			userTurns: 0,
			reviewedUpTo: 0,
		});
		let promptCount = 0;
		conv.session = {
			get isStreaming() { return false; },
			messages: [],
			prompt: async () => {
				const events = steps[promptCount++] ?? [];
				for (const event of events) conv.onEvent(event);
			},
			dispose() {},
		};
		return {
			conv,
			sent,
			notices,
			typing,
			get promptCount() { return promptCount; },
			async run() {
				await conv.handle({ text: "test input", name: "owner", date: new Date(), isEvent });
			},
			async dispose() { await conv.dispose(); },
		};
	}

	const toolStart = {
		type: "tool_execution_start",
		toolName: "exec",
		args: { command: "private-command-should-not-be-notified" },
	};

	await check("background event sends only final assistant stop text", async () => {
		const test = makeConversation("content-event-final-only", true, [[
			assistantEnd([{ type: "thinking", thinking: "private-thinking-should-not-be-notified" }], "toolUse"),
			assistantEnd([
				{ type: "text", text: "private-pretool-should-not-be-notified" },
				{ type: "toolCall", name: "exec", input: { command: "private-tool-call-should-not-be-notified" } },
			], "toolUse"),
			toolStart,
			assistantEnd([{ type: "text", text: "final-answer-only" }], "stop"),
		]]);
		try {
			await test.run();
			assert.deepEqual(test.notices.map((notice) => notice.text), ["final-answer-only"]);
			assert.ok(!test.notices.some((notice) => /private-|private-command/.test(notice.text)));
			assert.deepEqual(test.sent, [], "event turn must not send progress or final text to the conversation transport");
			assert.deepEqual(test.typing, [], "event turn must not show typing");
		} finally {
			await test.dispose();
		}
	});

	await check("final SILENT remains silent after a preamble", async () => {
		const test = makeConversation("content-event-silent", true, [[
			assistantEnd([{ type: "text", text: "private-preamble" }], "toolUse"),
			assistantEnd([{ type: "text", text: "[SILENT]" }], "stop"),
		]]);
		try {
			await test.run();
			assert.deepEqual(test.notices, []);
		} finally {
			await test.dispose();
		}
	});

	await check("empty final with pretool text triggers one final follow-up", async () => {
		const test = makeConversation("content-event-empty-followup", true, [
			[
				assistantEnd([{ type: "text", text: "private-before-empty-final" }], "toolUse"),
				assistantEnd([{ type: "text", text: "" }], "stop"),
			],
			[assistantEnd([{ type: "text", text: "follow-up-final-answer" }], "stop")],
		]);
		try {
			await test.run();
			assert.equal(test.promptCount, 2, "the empty final should request exactly one follow-up");
			assert.deepEqual(test.notices.map((notice) => notice.text), ["follow-up-final-answer"]);
		} finally {
			await test.dispose();
		}
	});

	await check("empty follow-up never falls back to pretool text", async () => {
		const test = makeConversation("content-event-empty-fallback", true, [
			[
				assistantEnd([{ type: "text", text: "private-before-empty-final" }], "toolUse"),
				assistantEnd([{ type: "text", text: "" }], "stop"),
			],
			[assistantEnd([{ type: "text", text: "" }], "stop")],
		]);
		try {
			await test.run();
			assert.equal(test.promptCount, 2, "the empty final should request exactly one follow-up");
			assert.deepEqual(test.notices.map((notice) => notice.text), ["(no reply)"]);
		} finally {
			await test.dispose();
		}
	});

	await check("aborted background turn does not leak pretool text", async () => {
		const test = makeConversation("content-event-aborted", true, [[
			assistantEnd([{ type: "text", text: "private-before-abort" }], "toolUse"),
			assistantEnd([], "aborted"),
		]]);
		try {
			await test.run();
			assert.deepEqual(test.notices.map((notice) => notice.text), ["(stopped)"]);
		} finally {
			await test.dispose();
		}
	});

	await check("ordinary owner turn keeps pretool text", async () => {
		const test = makeConversation("content-owner-aggregate", false, [[
			assistantEnd([{ type: "text", text: "visible-before-tool" }], "toolUse"),
			toolStart,
			assistantEnd([{ type: "text", text: "visible-final-answer" }], "stop"),
		]]);
		try {
			await test.run();
			assert.deepEqual(test.sent, [{ chat: "content-owner-aggregate-recipient", text: "visible-before-tool\nvisible-final-answer" }]);
			assert.deepEqual(test.notices, []);
		} finally {
			await test.dispose();
		}
	});

	await check("background reviewer keeps its freeform result out of notifications", async () => {
		const { Reviewer } = await import("../src/review.ts");
		const result = "Updated memory: internal summary that must stay out of the push group.";
		let disposed = false;
		let markedReviewed = false;
		hookState.reviewSession = {
			prompt: async () => {},
			getLastAssistantText: () => result,
			dispose: () => void (disposed = true),
		};
		const notifications: Notice[] = [];
		const sent: string[] = [];
		const sink = { notify: async (text: string, options?: Record<string, unknown>) => void notifications.push({ text, options }) };
		const transport = { send: async (_recipient: string, text: string) => void sent.push(text) };
		const reviewer = new (Reviewer as any)(transport, sink);
		const growthBeforeReview = hookState.growth.length;
		const conversation = {
			chatId: "review-private-result",
			recipient: "review-private-recipient",
			busy: false,
			unreviewedMessages: () => [{ role: "user", content: "Review these changes", timestamp: Date.now() }],
			markReviewed: () => void (markedReviewed = true),
		};
		await (reviewer as any).review(conversation);
		assert.deepEqual(notifications, [], "reviewer text must not reach the notification sink");
		assert.deepEqual(sent, [], "reviewer text must not reach the chat transport");
		assert.equal(markedReviewed, true, "reviewed messages should still be marked");
		assert.equal(disposed, true, "the short-lived review session should still be disposed");
		assert.equal(hookState.growth.length - growthBeforeReview, 1, "reviewed memory/skills should still be committed");
	});
} catch (error) {
	failures.push(`setup: ${errorMessage(error)}`);
} finally {
	const safeScratch = isWithin(tempParent, scratch) && resolve(scratch) !== resolve(tempParent);
	if (safeScratch) rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`notification-content failures:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
	process.exitCode = 1;
} else {
	console.log("all notification-content checks passed");
}
