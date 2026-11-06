// Runtime bridge to Tencent's published OpenClaw Weixin plugin.
// Upstream code is loaded only after its state paths and the logger temp-path
// shim are configured. No upstream protocol or monitor code is copied here.

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PP_VAR } from "../config.ts";

const TEMP_PATH_SPECIFIER = "openclaw/plugin-sdk/temp-path";

export const weixinRuntimePaths = {
	stateDir: join(PP_VAR, "weixin", "upstream"),
	configFile: join(PP_VAR, "weixin", "upstream", "openclaw.json"),
	oauthDir: join(PP_VAR, "weixin", "upstream", "credentials"),
	tmpDir: join(PP_VAR, "weixin", "tmp"),
	tmpFallbackDir: join(PP_VAR, "tmp"),
	mediaDir: join(PP_VAR, "weixin", "media"),
	loginQrFile: join(PP_VAR, "weixin", "login-qr.txt"),
};

let prepared = false;
let upstreamPromise: Promise<WeixinUpstream> | undefined;

export type WeixinUpstream = {
	accounts: any;
	api: any;
	inbound: any;
	loginQr: any;
	mediaDownload: any;
	send: any;
	sendMedia: any;
	sessionGuard: any;
	syncBuf: any;
	types: any;
	loggerModule: any;
};

function createPrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Best effort on filesystems without POSIX modes.
	}
}

/** Establish isolated OpenClaw state and the logger hook before loading Tencent code. */
export async function prepareWeixinRuntime(): Promise<void> {
	if (prepared) return;
	process.umask(0o077);

	const { stateDir, configFile, oauthDir, tmpDir, tmpFallbackDir, mediaDir } = weixinRuntimePaths;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	process.env.OPENCLAW_CONFIG = configFile;
	process.env.OPENCLAW_CONFIG_PATH = configFile;
	process.env.OPENCLAW_OAUTH_DIR = oauthDir;

	for (const dir of [stateDir, dirname(configFile), oauthDir, tmpDir, tmpFallbackDir, mediaDir]) {
		createPrivateDir(dir);
	}

	const loggerUrl = import.meta.resolve("@tencent-weixin/openclaw-weixin/dist/src/util/logger.js");
	const tempPathUrl = new URL("./weixin-temp-path.ts", import.meta.url).href;
	const moduleApi = (await import("node:module")) as unknown as {
		registerHooks?: (hooks: any) => unknown;
	};
	if (typeof moduleApi.registerHooks !== "function") {
		throw new Error("Node.js module.registerHooks is required for the Weixin temp-path shim");
	}
	moduleApi.registerHooks({
		resolve(specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => unknown) {
			if (specifier === TEMP_PATH_SPECIFIER && context.parentURL === loggerUrl) {
				return { url: tempPathUrl, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	prepared = true;
}

/** Dynamically import the real package after runtime isolation is in place. */
export function loadWeixinUpstream(): Promise<WeixinUpstream> {
	if (!upstreamPromise) {
		upstreamPromise = (async () => {
			await prepareWeixinRuntime();
			const importPackage = (specifier: string): Promise<any> => import(specifier);
			const [accounts, api, inbound, loginQr, mediaDownload, send, sendMedia, sessionGuard, syncBuf, types, loggerModule] =
				await Promise.all([
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/api/api.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/messaging/inbound.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/auth/login-qr.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/media/media-download.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/messaging/send-media.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/api/session-guard.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/storage/sync-buf.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/api/types.js"),
					importPackage("@tencent-weixin/openclaw-weixin/dist/src/util/logger.js"),
				]);
			// Tencent's INFO login log includes the temporary QR URL; keep it out of logs.
			loggerModule.setLogLevel("WARN");
			return { accounts, api, inbound, loginQr, mediaDownload, send, sendMedia, sessionGuard, syncBuf, types, loggerModule };
		})();
	}
	return upstreamPromise;
}
