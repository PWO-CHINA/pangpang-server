// Offline contract check for the pinned SDK, temp-path hook, and send errors.
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ppVar = await mkdtemp(join(tmpdir(), "pangpang-weixin-contract-"));
process.env.PP_HOME = root;
process.env.PP_VAR = ppVar;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PP_DATA = join(ppVar, "data");

async function packageVersionFromEntry(entry: string, expectedName: string): Promise<string> {
	let dir = dirname(entry);
	while (dir !== parse(dir).root) {
		try {
			const packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
			if (packageJson.name === expectedName && packageJson.version) return packageJson.version;
		} catch {
			// Keep walking toward the package root.
		}
		dir = dirname(dir);
	}
	throw new Error(`Could not find package.json for ${expectedName}`);
}

try {
	const tencentPackage = JSON.parse(await readFile(join(root, "node_modules", "@tencent-weixin", "openclaw-weixin", "package.json"), "utf8")) as { version?: string };
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const name of ["@tencent-weixin/openclaw-weixin", "openclaw"]) {
	assert.match(manifest.dependencies[name], /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `${name} must use an exact version`);
}
assert.equal(tencentPackage.version, manifest.dependencies["@tencent-weixin/openclaw-weixin"]);
	const require = createRequire(import.meta.url);
	const openclawEntry = require.resolve("openclaw/plugin-sdk/temp-path");
assert.equal(await packageVersionFromEntry(openclawEntry, "openclaw"), manifest.dependencies.openclaw);

	const { loadWeixinUpstream, weixinRuntimePaths } = await import("../src/channels/weixin-upstream.ts");
	const { WeixinClient, weixinApiResponseError } = await import("../src/channels/weixin.ts");
	const upstream = await loadWeixinUpstream();
	const tempPath = await import("../src/channels/weixin-temp-path.ts");
	assert.equal(typeof WeixinClient.load, "function");
	assert.equal(typeof upstream.loginQr.startWeixinLoginWithQr, "function");
	assert.equal(typeof upstream.loginQr.waitForWeixinLogin, "function");
	assert.equal(typeof upstream.accounts.loadWeixinAccount, "function");
	assert.equal(typeof upstream.api.getUpdates, "function");
	assert.equal(typeof upstream.inbound.weixinMessageToMsgContext, "function");
	assert.equal(typeof upstream.mediaDownload.downloadMediaFromItem, "function");
	assert.equal(tempPath.resolvePreferredOpenClawTmpDir(), weixinRuntimePaths.tmpDir);

	const now = new Date();
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	upstream.loggerModule.logger.warn("weixin contract temp-path probe");
	await access(join(weixinRuntimePaths.tmpDir, `openclaw-${today}.log`));

	const accountId = `weixin-contract-${randomUUID()}`;
	const ownerId = "contract-owner";
	upstream.accounts.saveWeixinAccount(accountId, { token: "contract-only-fake-token", userId: ownerId });
	upstream.accounts.registerWeixinAccountId(accountId);
	const client = await WeixinClient.load();
	assert.ok(client);
	assert.equal(client.ownerId, ownerId);

	const originalFetch = globalThis.fetch;
	const fakeFetch = (payload: Record<string, unknown>) =>
		(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
	try {
		// Successful upstream response is allowed to omit message_id.
		globalThis.fetch = fakeFetch({ ret: 0 });
		await client.send(ownerId, "successful mock send");

		globalThis.fetch = fakeFetch({ ret: -2, errmsg: "mock ret failure" });
		await assert.rejects(client.send(ownerId, "ret failure"));

		// The official getUpdates helper preserves errcode in its response; the
		// wrapper's shared status gate must reject it even if ret is zero.
		globalThis.fetch = fakeFetch({ ret: 0, errcode: -2, msgs: [] });
		const response = await upstream.api.getUpdates({
			baseUrl: upstream.accounts.DEFAULT_BASE_URL,
			token: "contract-only-fake-token",
			get_updates_buf: "",
			timeoutMs: 1000,
		});
		assert.match(weixinApiResponseError("getUpdates", response)?.message ?? "", /errcode=-2/);
	} finally {
		globalThis.fetch = originalFetch;
	}
	process.stdout.write("Weixin upstream contract passed offline.\n");
} finally {
	await rm(ppVar, { recursive: true, force: true });
}
