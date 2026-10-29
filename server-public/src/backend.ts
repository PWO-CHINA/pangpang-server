// The `backend` tool: pangpang inspects and switches its own model backend.
//
//   status     current model, thinking level, defaults, pool chain and health
//   use        switch this chat's session to a model (or back to the pool);
//              persist: true also makes it the default for new sessions
//   pool       reorder / replace the pool chain in agent/model-alias.json
//              (read per request, so it applies to the next call)
//   thinking   set the thinking level for this session
//
// How to use it well is in the backend skill (agent/skills/backend).

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config.ts";
import { log } from "./log.ts";
import { healthSnapshot, lastGoodTarget, resetSticky } from "./pool/fallback/health.ts";

const SETTINGS = join(AGENT_DIR, "settings.json");
const ALIASES = join(AGENT_DIR, "model-alias.json");
/** The pool is the alias provider's "main" model. */
const POOL = "alias/main";
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} };
}

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Atomic write, so the pool never reads a half-written chain. */
function writeJson(path: string, value: unknown): void {
	writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}

function normalize(ref: string): string {
	const r = ref.trim();
	return r === "pool" || r === "main" ? POOL : r;
}

export function backendExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "backend",
			label: "Backend",
			description:
				"Inspect or switch your own model backend. status: current model, defaults, pool chain and " +
				"health, models available. use: switch this chat to model 'provider/id', or 'pool' for the " +
				"smart pool (persist: true also makes it the default after restarts). pool: set the pool " +
				"chain order (first = preferred). thinking: set the thinking level. Read the backend skill " +
				"before switching.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("status"), Type.Literal("use"), Type.Literal("pool"), Type.Literal("thinking")]),
				model: Type.Optional(Type.String({ description: "use: 'provider/id' or 'pool'." })),
				persist: Type.Optional(Type.Boolean({ description: "use: also save as the default model." })),
				chain: Type.Optional(Type.Array(Type.String(), { description: "pool: 'provider/id' refs, preferred first." })),
				level: Type.Optional(Type.String({ description: `thinking: ${LEVELS.join(", ")}` })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const registry = ctx.modelRegistry;
				const find = (ref: string) => {
					const slash = ref.indexOf("/");
					return slash > 0 ? registry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
				};
				const available = () => new Set(registry.getAvailable().map((m) => `${m.provider}/${m.id}`));

				if (params.action === "status") {
					const settings = readJson(SETTINGS);
					const chain: string[] = readJson(ALIASES).main ?? [];
					const health = healthSnapshot();
					const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
					const lines = [
						`this chat: ${current}${current === POOL ? ` (last served by ${lastGoodTarget("main") ?? "nothing yet"})` : ""}`,
						`thinking: ${pi.getThinkingLevel()}`,
						`default for new sessions: ${settings.defaultProvider}/${settings.defaultModel}, thinking ${settings.defaultThinkingLevel ?? "medium"}`,
						"pool chain (preferred first; reordered live by health and speed):",
						...chain.map((t) => {
							const h = health[t];
							return `  ${t}${h ? `: ${Math.round(h.success * 100)}% ok${h.ttfbMs ? `, first token ${(h.ttfbMs / 1000).toFixed(1)}s` : ""}, ${h.samples} calls` : ": no calls yet"}`;
						}),
						`available: ${[...available()].filter((r) => r !== POOL).join(", ")}`,
					];
					return text(lines.join("\n"));
				}

				if (params.action === "use") {
					if (!params.model) return text("model is required: 'provider/id' or 'pool'");
					const ref = normalize(params.model);
					const model = find(ref);
					if (!model || !available().has(ref)) return text(`${ref} is not available; see backend status`);
					if (!(await pi.setModel(model))) return text(`${ref}: no credentials configured`);
					let saved = "";
					if (params.persist) {
						const settings = readJson(SETTINGS);
						settings.defaultProvider = model.provider;
						settings.defaultModel = model.id;
						writeJson(SETTINGS, settings);
						saved = " and saved as the default for new sessions";
					}
					log.info("backend", `switched to ${ref}${params.persist ? " (default)" : ""}`);
					return text(`switched this chat to ${ref}${saved}; it applies from your next model call.`);
				}

				if (params.action === "pool") {
					const chain = (params.chain ?? []).map((r) => r.trim()).filter(Boolean);
					if (chain.length === 0) return text("chain is required, preferred first");
					const have = available();
					const bad = chain.filter((r) => r === POOL || !have.has(r));
					if (bad.length) return text(`not usable in the pool: ${bad.join(", ")}; see backend status`);
					const aliases = readJson(ALIASES);
					const before: string[] = aliases.main ?? [];
					aliases.main = [...new Set(chain)];
					writeJson(ALIASES, aliases);
					resetSticky("main");
					log.info("backend", `pool chain: ${aliases.main.join(" > ")}`);
					return text(`pool chain: ${aliases.main.join(" > ")} (was ${before.join(" > ")}). Applies to the next pool call.`);
				}

				const level = params.level as (typeof LEVELS)[number] | undefined;
				if (!level || !LEVELS.includes(level)) return text(`level must be one of ${LEVELS.join(", ")}`);
				pi.setThinkingLevel(level);
				return text(`thinking: ${pi.getThinkingLevel()} (clamped to what the model supports)`);
			},
		});
	};
}
