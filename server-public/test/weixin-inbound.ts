// Offline inbound contract: real Tencent helpers, mocked HTTP only.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ppVar = await mkdtemp(join(tmpdir(), "pangpang-weixin-inbound-"));
process.env.PP_HOME = root;
process.env.PP_VAR = ppVar;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PP_DATA = join(ppVar, "data");

const imageUrl = "https://media.test/owner.png";
const strangerImageUrl = "https://media.test/stranger.png";
const duplicateImageUrl = "https://media.test/duplicate.png";
const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from("mock-png-payload"),
]);

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function abortError(): Error {
	const err = new Error("mock long poll aborted");
	err.name = "AbortError";
	return err;
}

async function run(): Promise<void> {
	const { loadWeixinUpstream } = await import("../src/channels/weixin-upstream.ts");
	const { WeixinClient } = await import("../src/channels/weixin.ts");
	const upstream = await loadWeixinUpstream();
	const ownerId = "owner@im.wechat";
	const accountId = `inbound-test-${randomUUID()}`;
	const baseUrl = upstream.accounts.DEFAULT_BASE_URL as string;
	const Type = upstream.types.MessageType;
	const State = upstream.types.MessageState;
	const Item = upstream.types.MessageItemType;

	const textMessage = (messageId: string, contextToken: string, text: string, state?: number) => ({
		message_id: messageId,
		from_user_id: ownerId,
		message_type: Type.USER,
		...(state === undefined ? {} : { message_state: state }),
		context_token: contextToken,
		create_time_ms: Date.now(),
		item_list: [{ type: Item.TEXT, text_item: { text } }],
	});

	const imageMessage = (messageId: string, contextToken: string, fullUrl: string) => ({
		message_id: messageId,
		from_user_id: ownerId,
		message_type: Type.USER,
		message_state: State.FINISH,
		context_token: contextToken,
		create_time_ms: Date.now(),
		item_list: [{ type: Item.IMAGE, image_item: { media: { full_url: fullUrl } } }],
	});

	const batch = [
		textMessage("owner-1", "owner-context-1", "first owner text", State.FINISH),
		imageMessage("owner-image", "owner-context-2", imageUrl),
		imageMessage("owner-image", "duplicate-context-must-not-win", duplicateImageUrl),
		{
			...textMessage("bot-echo", "bot-context-must-not-win", "bot echo", State.FINISH),
			message_type: Type.BOT,
		},
		textMessage("in-progress", "new-state-must-not-win", "not finished", State.NEW),
		// The upstream message type permits message_state to be omitted.
		textMessage("owner-3", "owner-context-3", "owner state omitted"),
		{
			...imageMessage("stranger-image", "stranger-context-must-not-win", strangerImageUrl),
			from_user_id: "stranger@im.wechat",
		},
	];

	const getUpdatesCalls: Array<{ body: any; signal?: AbortSignal }> = [];
	const mediaFetches: string[] = [];
	let notifyStartCalls = 0;
	let notifyStopCalls = 0;
	const originalFetch = globalThis.fetch;
	const fakeFetch = async (input: any, init?: any): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const parsed = new URL(url);
		if (parsed.pathname.endsWith("/ilink/bot/msg/notifystart")) {
			notifyStartCalls++;
			return jsonResponse({ ret: 0 });
		}
		if (parsed.pathname.endsWith("/ilink/bot/msg/notifystop")) {
			notifyStopCalls++;
			return jsonResponse({ ret: 0 });
		}
		if (parsed.pathname.endsWith("/ilink/bot/getupdates")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			getUpdatesCalls.push({ body, signal: init?.signal });
			if (getUpdatesCalls.length === 1) {
				return jsonResponse({
					ret: 0,
					msgs: batch,
					get_updates_buf: "cursor-after-owner-batch",
					longpolling_timeout_ms: 1000,
				});
			}
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal as AbortSignal | undefined;
				if (signal?.aborted) {
					reject(abortError());
					return;
				}
				signal?.addEventListener("abort", () => reject(abortError()), { once: true });
			});
		}
		if (url === imageUrl) {
			mediaFetches.push(url);
			return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
		}
		if (url === strangerImageUrl || url === duplicateImageUrl) {
			mediaFetches.push(url);
			return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
		}
		throw new Error(`Unexpected mocked network request: ${url}`);
	};
	globalThis.fetch = fakeFetch as typeof fetch;

	let watchdog: ReturnType<typeof setTimeout> | undefined;
	try {
		const client: any = new (WeixinClient as any)(accountId, ownerId, "fake-token", baseUrl);
		const controller = new AbortController();
		const incoming: any[] = [];
		let readyCalls = 0;
		watchdog = setTimeout(() => controller.abort(), 10_000);
		await client.poll((message) => {
			incoming.push(message);
			if (incoming.length === 3) setTimeout(() => controller.abort(), 10);
		}, controller.signal, () => {
			readyCalls++;
		});

		assert.equal(readyCalls, 1);
		assert.equal(notifyStartCalls, 1);
		assert.equal(notifyStopCalls, 1);
		assert.equal(incoming.length, 3, "only the unique finished/unspecified-state owner USER messages should enqueue");
		assert.deepEqual(incoming.map((message) => message.text), ["first owner text", "[图片]", "owner state omitted"]);
		assert.ok(incoming.every((message) => message.chatId === ownerId && message.fromId === ownerId));
		assert.equal(upstream.inbound.getContextToken(accountId, ownerId), "owner-context-3");
		assert.deepEqual(mediaFetches, [imageUrl], "foreign and duplicate images must not trigger CDN I/O");
		assert.equal(incoming[1].document.fileName, "image.png", "PNG magic should produce a real PNG filename");
		assert.equal(typeof incoming[1].document.fileId, "string");

		assert.equal(getUpdatesCalls.length, 2);
		assert.equal(getUpdatesCalls[0].body.get_updates_buf, "");
		assert.equal(getUpdatesCalls[1].body.get_updates_buf, "cursor-after-owner-batch");
		const syncPath = upstream.syncBuf.getSyncBufFilePath(accountId) as string;
		assert.equal(upstream.syncBuf.loadGetUpdatesBuf(syncPath), "cursor-after-owner-batch");

		const destination = join(ppVar, "conversation", ownerId, incoming[1].document.fileName);
		await client.download(incoming[1].document.fileId, destination);
		assert.deepEqual(await readFile(destination), png);
		await assert.rejects(client.download("weixin:../../etc/passwd", join(ppVar, "rejected.bin")), /Unknown or expired/);
		process.stdout.write("Weixin inbound contract passed offline.\n");
	} finally {
		if (watchdog) clearTimeout(watchdog);
		globalThis.fetch = originalFetch;
	}
}

try {
	await run();
} finally {
	await rm(ppVar, { recursive: true, force: true });
}
