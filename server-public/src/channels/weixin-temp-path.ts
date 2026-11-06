// Tencent's logger is the only module redirected by the resolve hook in
// weixin-upstream.ts. All helper behavior still comes from OpenClaw itself.
import * as tempPathSdk from "openclaw/plugin-sdk/temp-path";
import { join } from "node:path";
import { PP_VAR } from "../config.ts";

export * from "openclaw/plugin-sdk/temp-path";

type ResolveOptions = Parameters<typeof tempPathSdk.resolvePreferredOpenClawTmpDir>[0];

export function resolvePreferredOpenClawTmpDir(options: ResolveOptions = {}): string {
	return tempPathSdk.resolvePreferredOpenClawTmpDir({
		...options,
		preferredDir: join(PP_VAR, "weixin", "tmp"),
		tmpdir: () => join(PP_VAR, "tmp"),
	});
}
