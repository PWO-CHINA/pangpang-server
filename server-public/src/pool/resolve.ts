// Resolve a pool alias to a concrete model (pangpang addition).  Direct
// provider calls such as pi's compact() bypass the session's stream and
// cannot use the virtual alias model, so they need the real target: the
// one that last served the role, else the first plain target in its chain.

import type { Api, Model } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { MAP_PATH } from "./alias-config.ts";
import { lastGoodTarget } from "./fallback/health.ts";

export const POOL_PROVIDER = "alias";

function firstTarget(role: string, seen = new Set<string>()): string | undefined {
	if (seen.has(role)) return undefined;
	seen.add(role);
	try {
		const entry = JSON.parse(readFileSync(MAP_PATH, "utf8"))[role];
		const targets: unknown[] = Array.isArray(entry) ? entry : (entry?.targets ?? []);
		for (const t of targets) {
			if (typeof t !== "string") continue;
			if (t.startsWith(`${POOL_PROVIDER}/`)) {
				const nested = firstTarget(t.slice(POOL_PROVIDER.length + 1), seen);
				if (nested) return nested;
			} else {
				return t;
			}
		}
	} catch {
		// No or unreadable config.
	}
	return undefined;
}

export function resolvePoolModel(
	model: Model<Api>,
	find: (provider: string, id: string) => Model<Api> | undefined,
): Model<Api> {
	if (model.provider !== POOL_PROVIDER) return model;
	const ref = lastGoodTarget(model.id) ?? firstTarget(model.id);
	if (!ref) return model;
	const slash = ref.indexOf("/");
	return find(ref.slice(0, slash), ref.slice(slash + 1)) ?? model;
}
