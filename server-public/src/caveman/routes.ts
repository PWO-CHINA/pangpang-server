// Route model-pool targets through the local caveman proxy (pangpang).
//
// Upstream's ProviderRouter rewrites the *selected* model with pi.setModel.
// pangpang selects the pool's virtual alias/main model, and the pool resolves
// a concrete target per request, so routing happens here instead: the pool
// calls routeTarget() on each resolved target before opening its stream.
// Every safety check of the upstream router is kept; a target that fails one
// stays direct, with one log line.
//
// While routing is open, a watchdog probes the proxy every 15 s.  If the
// proxy stops answering (crash, restart), routing closes so every target
// goes direct instead of failing; it reopens when the same checks pass again.

import { log } from "../log.ts";
import { compatForRoutedModel, unpreservedAttributionHeaders } from "./provider-compat.ts";
import { compatUpstreamFor, hostOf, routeForApi, upstreamHostFor } from "./protocol.ts";
import { unforwardedProviderHeaders } from "./provider-routing.ts";

interface Gate {
	gateway: string;
	/** Re-runs the full gate check; true when the proxy is fit to route. */
	recheck: () => Promise<Omit<Gate, "recheck"> | undefined>;
	compatUpstreams: Readonly<Record<string, string>>;
	providerUpstreams: Readonly<Record<string, string>>;
	compatForwardHeaders: Readonly<Record<string, readonly string[]>>;
}

interface RoutableModel {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
	headers?: Record<string, string>;
	compat?: unknown;
}

let gate: Gate | undefined;
/** Kept while the proxy is down, so the watchdog can reopen routing. */
let lastGate: Gate | undefined;
let watchdog: NodeJS.Timeout | undefined;
const warned = new Set<string>();
const WATCH_MS = 15_000;

function watch(): void {
	if (watchdog) return;
	watchdog = setInterval(async () => {
		const current = gate ?? lastGate;
		if (!current) return;
		const fresh = await current.recheck().catch(() => undefined);
		if (fresh && !gate) {
			gate = { ...fresh, recheck: current.recheck };
			log.info("caveman", `proxy is back; routing reopened through ${gate.gateway}`);
		} else if (fresh && gate) {
			gate = { ...fresh, recheck: current.recheck };
		} else if (!fresh && gate) {
			lastGate = gate;
			gate = undefined;
			log.warn("caveman", "proxy stopped answering; pool targets go direct until it is back");
		}
	}, WATCH_MS);
	watchdog.unref();
}

/** Opened once the proxy is alive and recovery works (see index.ts). */
export function openRoutes(next: Gate): void {
	if (!gate || gate.gateway !== next.gateway) log.info("caveman", `routing pool targets through ${next.gateway}`);
	gate = next;
	lastGate = next;
	watch();
}

export function closeRoutes(reason: string): void {
	if (gate) log.warn("caveman", `routing closed: ${reason}`);
	gate = undefined;
}

export function routingOpen(): boolean {
	return gate !== undefined;
}

function direct<M>(model: M & RoutableModel, reason: string): M {
	const key = `${model.provider}/${model.id}`;
	if (!warned.has(key)) {
		warned.add(key);
		log.warn("caveman", `pass-through for ${key}: ${reason}`);
	}
	return model;
}

/**
 * The model to send a request to: routed through the proxy when every check
 * holds, else the model unchanged.
 */
export function routeTarget<M>(model: M, authHeaders: Record<string, unknown> | undefined, oauth: boolean): M {
	const m = model as M & RoutableModel;
	if (!gate || !m?.baseUrl) return model;
	const g = gate;
	if (oauth) return direct(m, "OAuth/subscription credentials are not routed");
	// Pi derives the OpenAI Chat prompt-cache key from this URL (upstream note).
	if (m.api === "openai-completions" && m.baseUrl.includes("api.openai.com")) {
		return direct(m, "Pi cannot preserve this OpenAI Chat endpoint's prompt cache keys");
	}
	const route = routeForApi(g.gateway, m.api, m.provider, m.baseUrl, g.compatUpstreams, g.providerUpstreams);
	if (!route) {
		const mount = compatUpstreamFor(m.provider, g.compatUpstreams);
		const expected = mount !== undefined ? hostOf(mount) : upstreamHostFor(m.provider);
		return direct(
			m,
			expected === undefined
				? `no compat mount "${m.provider}" in agent/caveman.yaml`
				: hostOf(m.baseUrl) !== expected
					? `endpoint ${hostOf(m.baseUrl)} is not ${expected}`
					: `endpoint path or API ${m.api} is not verified by the proxy`,
		);
	}
	const published = { compat_upstreams: g.compatUpstreams, compat_forward_headers: g.compatForwardHeaders };
	const headers = Object.fromEntries(
		Object.entries(authHeaders ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"),
	);
	const missing = [
		...new Set([
			...unforwardedProviderHeaders(m.api, m.provider, m.headers, published),
			...unforwardedProviderHeaders(m.api, m.provider, headers, published),
		]),
	];
	if (missing.length) return direct(m, `headers ${missing.join(", ")} are not forwarded by the proxy`);
	const attribution = unpreservedAttributionHeaders(m as never, headers, undefined);
	if (attribution.length) return direct(m, `URL-derived headers ${attribution.join(", ")} cannot be preserved`);
	const compat = compatForRoutedModel(m as never);
	return { ...m, baseUrl: route, ...(compat === undefined ? {} : { compat }) } as M;
}
