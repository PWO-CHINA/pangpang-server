// End-to-end smoke test for pangpangd without Telegram.
//
//   PP_VAR=var/tmp/smoke node --disable-warning=ExperimentalWarning test/smoke.ts [--live]
//
// Unit checks run offline.  --live also runs real model turns through a
// Conversation with a fake Telegram client, then a manual compaction.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const live = process.argv.includes("--live");

// A throwaway agent dir whose tiny keepRecentTokens lets a short
// conversation be compacted.
const agentDir = join(process.env.PP_VAR!, "agent");
mkdirSync(agentDir, { recursive: true });
// Live turns go through the model pool.  Its first target refuses every
// connection, so each turn exercises pre-output failover to DeepSeek.
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: "alias", defaultModel: "main", compaction: { keepRecentTokens: 100 } }),
);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			broken: {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				apiKey: "none",
				models: [{ id: "down", contextWindow: 128000, maxTokens: 8192 }],
			},
		},
	}),
);
writeFileSync(join(agentDir, "model-alias.json"), JSON.stringify({ main: ["broken/down", "deepseek/deepseek-v4-pro"] }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_MODEL_ALIAS_STATE_DIR = join(process.env.PP_VAR!, "pool-state");
process.env.PP_DATA = join(process.env.PP_VAR!, "data");
const { ensureDirs, paths } = await import("../src/config.ts");
assert.ok(paths.workspace.includes("smoke"), "run with PP_VAR pointing at a scratch directory");
rmSync(paths.workspace, { recursive: true, force: true });
mkdirSync(join(process.env.PP_VAR!, "run"), { recursive: true });
ensureDirs();

const { applyMemoryOps, readEntries, renderMemorySnapshot } = await import("../src/memory.ts");
const { manageSkill } = await import("../src/skills.ts");
const { indexRecord, searchLogs } = await import("../src/search.ts");
const { markdownToHtml, splitMessage } = await import("../src/telegram.ts");
const { COMPACTION_HANDOFF_PREFIX, stripHandoffPrefix } = await import("../src/prompts.ts");

// memory: batch, dedupe, replace, budget
assert.equal(applyMemoryOps("user", [{ action: "add", content: "User prefers short replies." }]).success, true);
let r = applyMemoryOps("user", [
	{ action: "replace", old_text: "short", content: "User prefers very short replies." },
	{ action: "add", content: "User likes sample projects." },
]);
assert.equal(r.success, true, r.message);
assert.deepEqual(readEntries("user"), ["User prefers very short replies.", "User likes sample projects."]);
r = applyMemoryOps("memory", [{ action: "add", content: "x".repeat(5000) }]);
assert.equal(r.success, false);
assert.match(r.message, /over budget/);
assert.equal(applyMemoryOps("user", [{ action: "remove", old_text: "nope" }]).success, false);
assert.match(renderMemorySnapshot(), /USER PROFILE[\s\S]*very short/);
console.log("ok memory");

// skills: create, patch, support file, protection
const skill = "---\nname: nas-docker\ndescription: Manage containers on the NAS\n---\n\n# NAS docker\n\n1. docker ps\n";
assert.equal(manageSkill({ action: "create", name: "nas-docker", content: skill }).success, true);
assert.equal(manageSkill({ action: "create", name: "nas-docker", content: skill }).success, false);
assert.equal(manageSkill({ action: "patch", name: "nas-docker", old_text: "1. docker ps", new_text: "1. docker ps -a" }).success, true);
assert.equal(manageSkill({ action: "write_file", name: "nas-docker", file_path: "../escape.md", content: "x" }).success, false);
assert.equal(manageSkill({ action: "write_file", name: "nas-docker", file_path: "references/ports.md", content: "x" }).success, true);
assert.equal(manageSkill({ action: "create", name: "Bad Name", content: skill }).success, false);
assert.match(readFileSync(join(paths.skills, "nas-docker", "SKILL.md"), "utf8"), /docker ps -a/);
console.log("ok skills");

// search: trigram FTS for Chinese and code, LIKE fallback for short terms
indexRecord({ date: "2026-09-27T01:00:00Z", chatId: "1", role: "user", text: "请检查示例目录的磁盘占用" });
indexRecord({ date: "2026-09-27T02:00:00Z", chatId: "1", role: "assistant", text: "example-service container uses 12G" });
assert.equal(searchLogs("磁盘占用").length, 1);
assert.equal(searchLogs("example-service").length, 1);
assert.equal(searchLogs("12G").length, 1);
assert.equal(searchLogs("nothing-like-this").length, 0);
console.log("ok search");

// recall: log exchanges and skill sections, IDF coverage, neighbours, live-context cutoff
{
	const { recall, recallBlock, openRecall, syncChunks, tokenize } = await import("../src/recall.ts");
	assert.deepEqual(tokenize("Example 记账 v3"), ["example", "v3", "记账"]);
	const chat = join(paths.chats, "1");
	mkdirSync(chat, { recursive: true });
	const rec = (date: string, role: string, text: string) => JSON.stringify({ date, role, text, chatId: "1" });
	writeFileSync(
		join(chat, "log.jsonl"),
		[
			rec("2026-09-01T01:00:00Z", "user", "示例账本在哪里"),
			rec("2026-09-01T01:01:00Z", "assistant", "账本在 /tmp/example/book.txt，Example 端口 1234"),
			rec("2026-09-02T01:00:00Z", "user", "帮我看看 example-service 的磁盘占用"),
			rec("2026-09-02T01:01:00Z", "assistant", "example-service 占 12G"),
			rec("2026-09-03T01:00:00Z", "user", "示例类别的总数是多少"),
			rec("2026-09-03T01:01:00Z", "assistant", "Category:Example 共 100 units"),
			rec("2026-09-04T01:00:00Z", "user", "still waiting for a reply"),
		].join("\n") + "\n",
	);
	let hits = recall("示例账本放在哪个目录");
	assert.equal(hits[0]?.text.includes("book.txt"), true, JSON.stringify(hits));
	assert.ok(!hits.some((h) => h.text.includes("example-service")), "unrelated exchange must not match");
	assert.equal(recall("still waiting").length, 0, "an unanswered message is not a chunk yet");
	assert.equal(recall("账本", { before: "2026-09-02T00:00:00Z" }).length, 1, "only history before the context");
	assert.equal(recall("账本", { before: "2026-08-01T00:00:00Z" }).length, 0);
	// Neighbour expansion: the food exchange shares no words with the query.
	const db = openRecall();
	const id = (needle: string) => (db.prepare("SELECT id FROM chunks WHERE text LIKE ?").get(`%${needle}%`) as { id: number }).id;
	db.prepare("INSERT INTO neighbors (id, nb, sim) VALUES (?, ?, 0.8)").run(id("book.txt"), id("100 units"));
	hits = recall("示例账本放在哪个目录");
	assert.ok(hits.some((h) => h.via === "related" && h.text.includes("100 units")), JSON.stringify(hits));
	// A new reply is picked up incrementally; skills are chunked by section.
	writeFileSync(join(chat, "log.jsonl"), `${readFileSync(join(chat, "log.jsonl"), "utf8")}${rec("2026-09-04T01:01:00Z", "assistant", "reply arrived")}\n`);
	assert.equal(recall("still waiting")[0]?.text, "owner: still waiting for a reply\npangpang: reply arrived");
	syncChunks();
	assert.match(recallBlock("nas-docker docker ps"), /<recall>[\s\S]*skill nas-docker/);
	assert.equal(recallBlock("完全无关的问题"), "");
}
console.log("ok recall");

// telegram formatting
assert.equal(markdownToHtml("**b** `a<b>` [x](https://e.com)"), '<b>b</b> <code>a&lt;b&gt;</code> <a href="https://e.com">x</a>');
assert.equal(markdownToHtml("```sh\necho <hi>\n```"), '<pre><code class="language-sh">echo &lt;hi&gt;</code></pre>');
assert.equal(
	markdownToHtml("结果：\n| 项目 | 用量 |\n|---|---|\n| **输入** | 6,627 |\n| 输出 | 1,998 |\n完"),
	"结果：\n<pre>项目  用量\n输入  6,627\n输出  1,998</pre>\n完",
);
assert.ok(splitMessage("a\n\n".repeat(3000), 3800).every((p) => p.length <= 3800));
assert.equal(stripHandoffPrefix(`${COMPACTION_HANDOFF_PREFIX}\n\n## Goal`), "## Goal");
console.log("ok formatting");

// automation: templates, matching, actions, one-shot tasks, webhooks
{
	const { render, matches, runAction } = await import("../src/automation/actions.ts");
	const ctx = { issue: { title: "Disk full", labels: ["ops"] }, action: "opened", n: 3 };
	assert.equal(render("{{issue.title}} ({{action}}, {{missing}})", ctx), "Disk full (opened, )");
	assert.equal(render("{{issue.labels.0}}", ctx), "ops");
	assert.ok(matches({ action: "opened", n: 3 }, ctx));
	assert.ok(matches({ "issue.title": { re: "^Disk" }, action: { in: ["opened", "edited"] } }, ctx));
	assert.ok(!matches({ action: "closed" }, ctx));
	assert.ok(matches({ "issue.body": { exists: false } }, ctx));

	const got: string[] = [];
	const rt = {
		notify: async (_c: string, t: string) => void got.push(`notify:${t}`),
		wake: async (_c: string, t: string) => void got.push(`wake:${t}`),
		defaultChat: () => "1",
	};
	await runAction("t", { notify: "hi {{action}}" }, ctx, rt);
	assert.equal(await runAction("t", { run: "echo NO_REPLY" }, ctx, rt), "silent");
	assert.equal(await runAction("t", { run: "jq -r .issue.title" }, ctx, rt), "notified");
	assert.equal(await runAction("t", { run: "echo found", then: "agent", prompt: "Check {{action}}" }, ctx, rt), "woke agent");
	assert.equal(await runAction("t", { run: "exit 3" }, ctx, rt), "exit 3");
	assert.deepEqual(got.slice(0, 2), ["notify:hi opened", "notify:Disk full"]);
	assert.match(got[2], /^wake:\[EVENT:t\] Check opened\n\n<output>\nfound/);
	assert.match(got[3], /failed \(exit 3\)/);

	const { TaskScheduler } = await import("../src/automation/tasks.ts");
	got.length = 0;
	writeFileSync(join(paths.tasks, "soon.json"), JSON.stringify({ at: new Date(Date.now() + 300).toISOString(), do: { notify: "ding" } }));
	writeFileSync(join(paths.tasks, "daily.json"), JSON.stringify({ schedule: "0 9 * * *", do: { run: "echo NO_REPLY" } }));
	const tasks = new TaskScheduler(rt);
	tasks.start();
	await new Promise((r) => setTimeout(r, 1200));
	assert.deepEqual(got, ["notify:ding"]);
	assert.ok(!existsSync(join(paths.tasks, "soon.json")), "one-shot task file should be deleted");
	assert.deepEqual(tasks.list().map((t) => t.name), ["daily"]);
	assert.equal(await tasks.fire("daily.json"), "silent");
	tasks.stop();

	process.env.PP_HOOK_PORT = "18799";
	const { settings } = await import("../src/config.ts");
	settings.hookPort = 18799;
	const { HookServer } = await import("../src/automation/hooks.ts");
	writeFileSync(
		join(paths.hooks, "gh.json"),
		JSON.stringify({ token: "s3", match: { action: "opened" }, cooldownSec: 60, do: { notify: "issue: {{issue.title}}" } }),
	);
	got.length = 0;
	const hooks = new HookServer(rt);
	hooks.start();
	await new Promise((r) => setTimeout(r, 200));
	const post = (token: string, body: unknown) =>
		fetch("http://127.0.0.1:18799/hooks/gh", { method: "POST", headers: { "x-pangpang-token": token }, body: JSON.stringify(body) }).then((r) => r.status);
	assert.equal(await post("nope", ctx), 401);
	assert.equal(await post("s3", { action: "closed" }), 204);
	assert.equal(await post("s3", ctx), 202);
	assert.equal(await post("s3", ctx), 429);
	await new Promise((r) => setTimeout(r, 100));
	assert.deepEqual(got, ["notify:issue: Disk full"]);
	hooks.stop();
	console.log("ok automation");
}

// caveman routing of pool targets
{
	const { openRoutes, closeRoutes, routeTarget } = await import("../src/caveman/routes.ts");
	const flash = { provider: "deepseek", id: "deepseek-flash", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", compat: { thinkingFormat: "deepseek" } };
	const relay = { provider: "mirror", id: "gpt-5.5", api: "openai-responses", baseUrl: "https://www.vibecodingmirrow.org/v1" };
	assert.equal(routeTarget(flash, {}, false), flash, "closed routing must leave targets direct");
	openRoutes({
		gateway: "http://127.0.0.1:8787",
		recheck: async () => undefined,
		compatUpstreams: { deepseek: "https://api.deepseek.com/v1", mirror: "https://www.vibecodingmirrow.org/v1" },
		providerUpstreams: {},
		compatForwardHeaders: {},
	});
	assert.equal(routeTarget(flash, {}, false).baseUrl, "http://127.0.0.1:8787/w/pi/compat/deepseek/v1");
	assert.equal(routeTarget(relay, {}, false).baseUrl, "http://127.0.0.1:8787/w/pi/compat/mirror/v1");
	assert.equal(routeTarget({ ...flash, baseUrl: "https://api.deepseek.com" }, {}, false).baseUrl, "https://api.deepseek.com", "unverified path stays direct");
	assert.equal(routeTarget(flash, {}, true).baseUrl, flash.baseUrl, "OAuth stays direct");
	assert.equal(routeTarget({ ...flash, provider: "other" }, {}, false).baseUrl, flash.baseUrl, "no mount stays direct");
	closeRoutes("test");
	console.log("ok caveman routing");
}

// backend tool: switch, persist, pool validation and rewrite
{
	const { backendExtension } = await import("../src/backend.ts");
	const models = [
		{ provider: "alias", id: "main" },
		{ provider: "broken", id: "down" },
		{ provider: "deepseek", id: "deepseek-v4-pro" },
	];
	let tool: any;
	let current: any = models[0];
	let thinking = "medium";
	backendExtension()({
		registerTool: (t: any) => (tool = t),
		setModel: async (m: any) => ((current = m), true),
		getThinkingLevel: () => thinking,
		setThinkingLevel: (l: string) => (thinking = l),
	} as any);
	const ctx = {
		get model() {
			return current;
		},
		modelRegistry: {
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
			getAvailable: () => models,
		},
	};
	const call = async (params: object) => (await tool.execute("t", params, undefined, undefined, ctx)).content[0].text as string;
	assert.match(await call({ action: "status" }), /this chat: alias\/main[\s\S]*broken\/down/);
	assert.match(await call({ action: "use", model: "deepseek/deepseek-v4-pro", persist: true }), /saved as the default/);
	assert.equal(current.id, "deepseek-v4-pro");
	assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).defaultModel, "deepseek-v4-pro");
	assert.match(await call({ action: "use", model: "nope/x" }), /not available/);
	assert.match(await call({ action: "pool", chain: ["alias/main"] }), /not usable/);
	assert.match(await call({ action: "pool", chain: ["deepseek/deepseek-v4-pro", "broken/down"] }), /pool chain: deepseek/);
	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "model-alias.json"), "utf8")).main, ["deepseek/deepseek-v4-pro", "broken/down"]);
	await call({ action: "use", model: "pool" });
	assert.equal(current.provider, "alias");
	await call({ action: "thinking", level: "high" });
	assert.equal(thinking, "high");
	// Restore what the live test expects.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "alias", defaultModel: "main", compaction: { keepRecentTokens: 100 } }));
	writeFileSync(join(agentDir, "model-alias.json"), JSON.stringify({ main: ["broken/down", "deepseek/deepseek-v4-pro"] }));
	console.log("ok backend");
}

if (live) {
	const { Conversation } = await import("../src/conversation.ts");
	const sent: string[] = [];
	const fakeTg: any = {
		send: async (_c: string, text: string) => (sent.push(text), sent.length),
		edit: async () => {},
		remove: async () => {},
		typing: async () => {},
		sendFile: async (_c: string, path: string) => void sent.push(`[file] ${path}`),
		download: async () => {},
	};
	const review = { schedule() {}, cancel() {} };
	const conv = await Conversation.open("smoke", fakeTg, review);

	await conv.handle({ text: "Remember with the memory tool: my server hostname is demo-box. Then reply OK.", name: "owner", date: new Date() });
	console.log("reply 1:", sent.at(-1));
	assert.ok(readEntries("memory").concat(readEntries("user")).some((e) => /demo-box/.test(e)), "memory tool was not used");

	await conv.handle({ text: "Run `df -h /` and tell me the free space in one line.", name: "owner", date: new Date() });
	console.log("reply 2:", sent.at(-1));
	assert.ok(conv.toolCalls >= 2, `tool calls counted: ${conv.toolCalls}`);

	await conv.handle({ text: "Use session_search to find what I asked about my server hostname, and quote it.", name: "owner", date: new Date() });
	console.log("reply 3:", sent.at(-1));

	// A tiny last turn puts the cut on a user-message boundary, so turns 1-3
	// go through the full (non split-turn) summarizer.
	await conv.handle({ text: "Reply with just: done", name: "owner", date: new Date() });
	console.log(await conv.compact());
	const summary = readFileSync(join(paths.chats, "smoke", "context.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.findLast((e) => e.type === "compaction")?.summary as string;
	console.log(`--- summary ---\n${summary.slice(COMPACTION_HANDOFF_PREFIX.length)}\n---`);
	assert.ok(summary.startsWith(COMPACTION_HANDOFF_PREFIX), "handoff prefix missing from compaction");
	assert.match(summary, /^## Historical Task Snapshot/m, "summary lacks the historical task section");
	assert.match(summary, /^## Relevant Files/m, "summary lacks the relevant files section");
	console.log(conv.status());
	const { healthSnapshot } = await import("../src/pool/fallback/health.ts");
	const pool = healthSnapshot();
	assert.ok((pool["broken/down"]?.success ?? 1) < 1, "pool did not record the broken target's failure");
	assert.equal(pool["deepseek/deepseek-v4-pro"]?.success, 1, "deepseek should have served every turn");
	assert.ok(existsSync(join(paths.chats, "smoke", "log.jsonl")));
	conv.dispose();
	console.log("ok live");
}
console.log("all smoke checks passed");
