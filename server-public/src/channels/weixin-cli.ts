// Minimal interactive login/status entrypoint. The QR implementation owns
// verification-code prompting and QR refresh behavior.

import { errorText, log } from "../log.ts";
import { unlink, writeFile } from "node:fs/promises";
import { WeixinClient } from "./weixin.ts";
import { loadWeixinUpstream, weixinRuntimePaths } from "./weixin-upstream.ts";

async function login(): Promise<void> {
	const upstream = await loadWeixinUpstream();
	const apiBaseUrl = upstream.accounts.DEFAULT_BASE_URL as string;
	const start = await upstream.loginQr.startWeixinLoginWithQr({ apiBaseUrl });
	if (!start.qrcodeUrl) throw new Error(start.message || "Weixin did not return a QR code");
	await writeFile(weixinRuntimePaths.loginQrFile, `${start.qrcodeUrl}\n`, { mode: 0o600 });
	process.stdout.write(`首个二维码已私密保存到 ${weixinRuntimePaths.loginQrFile}；请尽快扫码。上游刷新二维码时请以终端中新二维码为准。\n`);
	let result: Awaited<ReturnType<typeof upstream.loginQr.waitForWeixinLogin>>;
	try {
		await upstream.loginQr.displayQRCode(start.qrcodeUrl);
		result = await upstream.loginQr.waitForWeixinLogin({
			sessionKey: start.sessionKey,
			apiBaseUrl,
		});
	} finally {
		await unlink(weixinRuntimePaths.loginQrFile).catch(() => {});
	}
	if (!result.connected) {
		if (result.alreadyConnected) throw new Error("This Weixin account is already connected in the upstream state directory");
		throw new Error(result.message || "Weixin login did not complete");
	}

	const accountId = typeof result.accountId === "string" ? result.accountId.trim() : "";
	const ownerId = typeof result.userId === "string" ? result.userId.trim() : "";
	const token = typeof result.botToken === "string" ? result.botToken.trim() : "";
	if (!accountId || !ownerId || !token) throw new Error("Weixin login omitted its account ID, owner ID, or token; no account was saved");
	if (!/^[A-Za-z0-9@._-]+$/.test(accountId) || accountId.includes("..") || /[\\/]/.test(accountId)) {
		throw new Error("Weixin returned an invalid account ID; no account was saved");
	}
	const baseUrl = typeof result.baseUrl === "string" && result.baseUrl.trim() ? result.baseUrl.trim() : undefined;
	if (baseUrl && new URL(baseUrl).protocol !== "https:") throw new Error("Weixin returned a non-HTTPS API URL; no account was saved");

	upstream.accounts.saveWeixinAccount(accountId, { token, baseUrl, userId: ownerId });
	upstream.accounts.registerWeixinAccountId(accountId);
	process.stdout.write(`Weixin login saved for owner ${ownerId}.\n`);
}

async function status(): Promise<void> {
	const client = await WeixinClient.load();
	if (client) {
		process.stdout.write(`Weixin connected: account ${client.accountId}, owner ${client.ownerId}\n`);
		return;
	}
	process.stdout.write("Weixin is not configured. Run pp weixin login to scan a QR code.\n");
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command === "login") await login();
	else if (command === "status") await status();
	else throw new Error("Usage: node src/channels/weixin-cli.ts login|status");
}

void main().catch((err) => {
	log.error("weixin-cli", "command failed", errorText(err));
	process.stderr.write(`Weixin command failed: ${errorText(err)}\n`);
	process.exitCode = 1;
});
