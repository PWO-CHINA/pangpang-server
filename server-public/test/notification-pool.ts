import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ChatTransport } from "../src/channels/types.ts";
import { NotificationPool } from "../src/channels/notification-pool.ts";

type FakeOptions = {
	limit?: number;
	fail?: number;
	neverResolve?: boolean;
	delayMs?: number;
	active?: { now: number; max: number };
};

function fake(channel: "telegram" | "weixin", options: FakeOptions = {}) {
	const calls: Array<{ kind: string; chatId: string; text?: string; path?: string; caption?: string; silent?: boolean }> = [];
	let failures = options.fail ?? 0;
	const transport: ChatTransport = {
		channel,
		messageLimit: options.limit,
		async send(chatId, text, opts) {
			calls.push({ kind: "text", chatId, text, silent: opts?.silent });
			if (options.active) {
				options.active.now++;
				options.active.max = Math.max(options.active.max, options.active.now);
			}
			if (options.neverResolve) return await new Promise<number>(() => {});
			if (options.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			}
			if (options.active) options.active.now--;
			if (failures > 0) { failures--; throw new Error(`${channel} offline`); }
			return calls.length;
		},
		async sendFile(chatId, path, caption) {
			calls.push({ kind: "file", chatId, path, caption });
			if (failures > 0) { failures--; throw new Error(`${channel} offline`); }
		},
		async edit() {},
		async remove() {},
		async typing() {},
		async download() {},
	};
	return { transport, calls };
}

const varRoot = resolve("var");
const tempBase = join(varRoot, "tmp");
mkdirSync(tempBase, { recursive: true });
const root = mkdtempSync(join(tempBase, "notification-pool-"));
const rel = relative(varRoot, root);
assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`), "test scratch must stay under PP_VAR");
const filePath = join(root, "attachment.txt");
writeFileSync(filePath, "attachment body must not be copied into the outbox");

function environment(name: string) {
	const dir = join(root, name);
	return { stateDir: join(dir, "state"), settingsFile: join(dir, "settings.json") };
}

let currentEnvironment = environment("default");
function makePool(tg: ReturnType<typeof fake>, wx?: ReturnType<typeof fake>, timeoutMs?: number) {
	return new NotificationPool({
		telegram: tg.transport,
		telegramChatId: "tg-group",
		...(wx ? { weixin: { transport: wx.transport, chatId: "wx-owner" } } : {}),
		stateDir: currentEnvironment.stateDir,
		settingsFile: currentEnvironment.settingsFile,
	}, { timeoutMs });
}

try {
	// New installs default to Telegram; touch persists the last authorized inbound platform.
	{
		const tg = fake("telegram");
		const wx = fake("weixin");
		const pool = makePool(tg, wx);
		assert.match(readFileSync(currentEnvironment.settingsFile, "utf8"), /"notificationBroadcast": false/);
		await pool.notify("default");
		assert.deepEqual(tg.calls.map((call) => call.chatId), ["tg-group"]);
		assert.equal(wx.calls.length, 0);
		pool.touch("weixin", new Date("2026-11-06T12:00:00.000Z"));
		await pool.notify("latest inbound");
		assert.equal(wx.calls.at(-1)?.chatId, "wx-owner");
		assert.match(pool.status(), /Recent platform: weixin at 2026-11-06T12:00:00.000Z/);
	}

	// If Weixin has not been bound, Telegram remains the usable default recipient.
	{
		currentEnvironment = environment("no-weixin");
		const tg = fake("telegram");
		const pool = makePool(tg);
		await pool.notify("telegram still works");
		assert.deepEqual(tg.calls.map((call) => call.chatId), ["tg-group"]);
		assert.match(pool.status(), /Pending: 0/);
	}

	// Broadcast attempts both channels; successful copies survive a later restart without duplication.
	{
		currentEnvironment = environment("broadcast-recovery");
		const tg = fake("telegram");
		const wx = fake("weixin", { fail: 1 });
		const pool = makePool(tg, wx);
		pool.setBroadcast(true);
		await pool.notify("broadcast");
		assert.equal(tg.calls.length, 1);
		assert.equal(wx.calls.length, 1);
		assert.match(readFileSync(currentEnvironment.settingsFile, "utf8"), /"notificationBroadcast": true/);
		assert.match(pool.status(), /Pending: 1/);
		const tgRetry = fake("telegram");
		const wxRetry = fake("weixin");
		const recovered = makePool(tgRetry, wxRetry);
		await recovered.retryPending();
		assert.equal(recovered.status().match(/Pending: 0/)?.length, 1);
		assert.equal(tgRetry.calls.length, 0, "already successful broadcast copy must not be sent again");
		assert.equal(wxRetry.calls.length, 1, "only the failed broadcast endpoint is retried");
		assert.equal(readdirSync(join(currentEnvironment.stateDir, "outbox")).length, 0, "completed broadcast job should be removed");
	}

	// Changing modes is persisted; failover uses the latest inbound platform.
	{
		currentEnvironment = environment("mode-switch");
		const tg = fake("telegram");
		const wx = fake("weixin");
		const pool = makePool(tg, wx);
		pool.setBroadcast(true);
		await pool.notify("both");
		assert.equal(tg.calls.length, 1);
		assert.equal(wx.calls.length, 1);
		pool.touch("weixin");
		pool.setBroadcast(false);
		const restarted = makePool(tg, wx);
		assert.match(restarted.status(), /Notification mode: failover/);
		await restarted.notify("one preferred");
		assert.equal(tg.calls.length, 1);
		assert.equal(wx.calls.length, 2);
	}

	// Preferred-channel errors fall through. If both channels fail, notify queues the item instead of throwing.
	{
		currentEnvironment = environment("failover-recovery");
		const tg = fake("telegram", { fail: 1 });
		const wx = fake("weixin", { fail: 1 });
		const pool = makePool(tg, wx);
		pool.touch("telegram");
		await pool.notify("queued", { file: filePath, caption: "report" });
		assert.equal(tg.calls.length, 1);
		assert.equal(wx.calls.length, 1);
		assert.match(pool.status(), /Pending: 1/);
		const jobPath = join(currentEnvironment.stateDir, "outbox", readdirSync(join(currentEnvironment.stateDir, "outbox"))[0]);
		const persisted = readFileSync(jobPath, "utf8");
		assert.match(persisted, /attachment\.txt/);
		assert.ok(!persisted.includes("attachment body"), "file content must not be read into the outbox");
		const restartTg = fake("telegram");
		const restartWx = fake("weixin");
		const restarted = makePool(restartTg, restartWx);
		await restarted.retryPending();
		assert.equal(restartTg.calls.filter((call) => call.kind === "text").length, 1);
		assert.equal(restartTg.calls.filter((call) => call.kind === "file").length, 1, "queued attachment should be retried after its text");
		assert.equal(restartWx.calls.length, 0, "successful Telegram retry ends failover job");
		assert.match(restarted.status(), /Pending: 0/);
	}

	// Missing Weixin binding does not block Telegram and can be retried after a later bind.
	{
		currentEnvironment = environment("late-bind");
		const firstTg = fake("telegram", { fail: 1 });
		const first = makePool(firstTg);
		await first.notify("waiting for bind");
		assert.equal(firstTg.calls.length, 1);
		assert.match(first.status(), /Pending: 1/);
		const retryTg = fake("telegram", { fail: 1 });
		const retryWx = fake("weixin");
		const restarted = makePool(retryTg, retryWx);
		await restarted.retryPending();
		assert.equal(retryTg.calls.length, 1);
		assert.equal(retryWx.calls.length, 1);
		assert.match(restarted.status(), /Pending: 0/);
	}

	// Explicit destinations bypass the pool mode; file delivery and per-client segmentation are preserved.
	{
		currentEnvironment = environment("explicit-and-segments");
		const tg = fake("telegram", { limit: 4 });
		const wx = fake("weixin", { limit: 4 });
		const pool = makePool(tg, wx);
		pool.setBroadcast(true);
		await pool.notify("abcdefgh", { via: "weixin", chat: "wx-direct", silent: true, file: filePath, caption: "chart" });
		assert.deepEqual(wx.calls.filter((call) => call.kind === "text").map((call) => call.text), ["abcd", "efgh"]);
		assert.ok(wx.calls.filter((call) => call.kind === "text").every((call) => call.chatId === "wx-direct" && call.silent));
		assert.deepEqual(wx.calls.find((call) => call.kind === "file"), { kind: "file", chatId: "wx-direct", path: filePath, caption: "chart" });
		assert.equal(tg.calls.length, 0);
		await pool.notify("telegram direct", { chat: "tg-direct" });
		assert.ok(tg.calls.every((call) => call.chatId === "tg-direct"));
		assert.equal(wx.calls.length, 3);
	}

	// A crash during send recovers as unknown and remains eligible for retry.
	{
		currentEnvironment = environment("crash-recovery");
		const first = makePool(fake("telegram", { fail: 1 }));
		await first.notify("interrupted");
		const outbox = join(currentEnvironment.stateDir, "outbox");
		const jobPath = join(outbox, readdirSync(outbox)[0]);
		const job = JSON.parse(readFileSync(jobPath, "utf8"));
		job.targets.telegram.status = "sending";
		writeFileSync(jobPath, JSON.stringify(job));
		const recovered = makePool(fake("telegram"), fake("weixin"));
		const recoveredJob = JSON.parse(readFileSync(jobPath, "utf8"));
		assert.equal(recoveredJob.targets.telegram.status, "unknown", "a crash during send must recover as unknown");
		assert.match(recovered.status(), /telegram: unknown/);
		await recovered.retryPending();
		assert.match(recovered.status(), /Pending: 0/);
	}

	// A timed out broadcast endpoint runs alongside the other endpoint and records an unknown result.
	{
		currentEnvironment = environment("timeout");
		const active = { now: 0, max: 0 };
		const tg = fake("telegram", { neverResolve: true, active });
		const wx = fake("weixin", { delayMs: 2, active });
		const pool = makePool(tg, wx, 15);
		pool.setBroadcast(true);
		await pool.notify("timeout fallback");
		assert.equal(wx.calls.length, 1);
		assert.equal(active.max, 2, "broadcast attempts should overlap instead of waiting on the first endpoint");
		assert.match(pool.status(), /telegram: unknown/);
	}

	// Multiple pending notifications flush one at a time even when callers enqueue concurrently.
	{
		currentEnvironment = environment("serial-flush");
		const tg = fake("telegram", { fail: 2 });
		const wx = fake("weixin", { fail: 2 });
		const pool = makePool(tg, wx);
		await Promise.all([pool.notify("one"), pool.notify("two")]);
		const active = { now: 0, max: 0 };
		const onlineTg = fake("telegram", { delayMs: 5, active });
		const onlineWx = fake("weixin", { delayMs: 5, active });
		// Pool's Telegram transport is fixed at construction, so use a fresh pool with the same persisted outbox.
		const flush = makePool(onlineTg, onlineWx);
		await flush.retryPending();
		assert.equal(active.max, 1, "outbox jobs should not be in flight concurrently");
		assert.match(flush.status(), /Pending: 0/);
	}

	assert.ok(existsSync(join(currentEnvironment.stateDir, "outbox")) && readdirSync(join(currentEnvironment.stateDir, "outbox")).length === 0);
	console.log("ok notification pool");
} finally {
	// The only recursive removal is the unique scratch directory created below PP_VAR above.
	rmSync(root, { recursive: true, force: true });
}
