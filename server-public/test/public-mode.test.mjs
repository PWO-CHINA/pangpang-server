import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { commitData, commitGrowth } from "../src/git.ts";

test("sample conversations are valid JSONL and contain only synthetic identifiers", async () => {
  const text = await readFile(new URL("../examples/chats/10001/log.jsonl", import.meta.url), "utf8");
  const records = text.trim().split("\n").map(JSON.parse);
  assert.ok(records.length >= 2);
  assert.ok(records.every(r => r.chatId === "10001" && ["user", "assistant"].includes(r.role)));
});

test("sample scheduled task is disabled", async () => {
  const task = JSON.parse(await readFile(new URL("../examples/tasks/sample-reminder.json", import.meta.url), "utf8"));
  assert.equal(task.enabled, false);
  assert.equal(typeof task.do.notify, "string");
});

test("automatic private-data commits and pushes are disabled", async () => {
  assert.equal(await commitGrowth("synthetic test"), undefined);
  assert.equal(await commitData(), undefined);
});
