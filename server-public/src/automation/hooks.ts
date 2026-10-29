// Event model: inbound webhooks, one JSON file per hook in data/hooks/.
//
//   POST http://<nas>:<PP_HOOK_PORT>/hooks/<name>
//
//   {
//     "token": "secret",                         optional; else PP_HOOK_TOKEN from .env
//     "match": { "action": "opened", "repo.name": { "re": "^pang" } },
//     "cooldownSec": 60,                         drop repeats inside this window
//     "do": { "notify": "New issue: {{issue.title}}" }
//   }
//
// Matching and templating are plain parsing, so most events cost no tokens;
// only an "agent" action (or a "run" with then: "agent") calls the model.
// The event context is { hook, body, query, headers, now }.  A request that
// does not match returns 204.  Hook files are read per request, so edits
// apply without a restart.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { paths, settings } from "../config.ts";
import { errorText, log } from "../log.ts";
import { type Action, type ActionRuntime, type Match, matches, runAction } from "./actions.ts";

interface HookSpec {
	token?: string;
	match?: Match;
	cooldownSec?: number;
	enabled?: boolean;
	do: Action;
}

const MAX_BODY = 1024 * 1024;
const NAME = /^[\w-]{1,64}$/;

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function presentedToken(req: IncomingMessage, url: URL): string | undefined {
	const header = req.headers["x-pangpang-token"];
	if (typeof header === "string") return header;
	const auth = req.headers.authorization;
	if (auth?.startsWith("Bearer ")) return auth.slice(7);
	return url.searchParams.get("token") ?? undefined;
}

export class HookServer {
	private rt: ActionRuntime;
	private server: Server | undefined;
	private lastFired = new Map<string, number>();

	constructor(rt: ActionRuntime) {
		this.rt = rt;
	}

	start(): void {
		this.server = createServer((req, res) => {
			this.handle(req)
				.then(({ status, body }) => {
					res.writeHead(status, { "content-type": "application/json" });
					res.end(JSON.stringify(body));
				})
				.catch((err) => {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: errorText(err) }));
				});
		});
		this.server.on("error", (err) => log.error("hooks", "server error", err));
		this.server.listen(settings.hookPort, "0.0.0.0", () => log.info("hooks", `listening on :${settings.hookPort}`));
	}

	stop(): void {
		this.server?.close();
	}

	private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "GET" && url.pathname === "/health") return { status: 200, body: { ok: true } };
		const name = url.pathname.match(/^\/hooks\/([^/]+)$/)?.[1];
		if (req.method !== "POST" || !name || !NAME.test(name)) return { status: 404, body: { error: "not found" } };

		const file = join(paths.hooks, `${name}.json`);
		if (!existsSync(file)) return { status: 404, body: { error: "no such hook" } };
		let spec: HookSpec;
		try {
			spec = JSON.parse(readFileSync(file, "utf8")) as HookSpec;
		} catch (err) {
			return { status: 500, body: { error: `invalid hook file: ${errorText(err)}` } };
		}
		if (spec.enabled === false) return { status: 404, body: { error: "hook disabled" } };

		const expected = spec.token ?? settings.hookToken;
		if (!expected) return { status: 403, body: { error: "hook has no token and PP_HOOK_TOKEN is unset" } };
		if (presentedToken(req, url) !== expected) return { status: 401, body: { error: "bad token" } };

		const raw = await readBody(req);
		let body: unknown = raw;
		try {
			body = raw ? JSON.parse(raw) : {};
		} catch {
			// Not JSON: templates can still use {{body}}.
		}
		const ctx = {
			hook: name,
			body,
			query: Object.fromEntries(url.searchParams),
			headers: req.headers,
			now: new Date().toISOString(),
		};
		// Match paths are relative to the body, the common case; "query.x" etc. also work.
		const matchCtx = typeof body === "object" && body !== null ? { ...ctx, ...(body as object) } : ctx;
		if (!matches(spec.match, matchCtx)) return { status: 204, body: {} };

		const now = Date.now();
		const cooldown = (spec.cooldownSec ?? 0) * 1000;
		if (cooldown && now - (this.lastFired.get(name) ?? 0) < cooldown) {
			return { status: 429, body: { error: "cooldown" } };
		}
		this.lastFired.set(name, now);

		// Answer at once; the action (maybe a model turn) runs in the background.
		void runAction(`hook:${name}`, spec.do, matchCtx, this.rt);
		return { status: 202, body: { accepted: true } };
	}
}
