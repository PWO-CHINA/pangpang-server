// Curated long-term memory, internalized from Hermes Agent's memory tool
// (tools/memory_tool.py, MIT, Nous Research).
//
// Two bounded stores:
//   MEMORY.md  the agent's notes about its environment: conventions, quirks, lessons
//   USER.md    who the user is: preferences, style, expectations
//
// Entries are separated by a "§" line.  Each store has a character budget,
// so the agent must consolidate instead of hoarding.  The rendered snapshot
// enters the system prompt frozen: writes land on disk immediately but only
// reach the prompt when the snapshot is refreshed (at compaction or restart),
// which keeps the provider's prefix cache valid between refreshes.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, settings } from "./config.ts";

export type MemoryTarget = "memory" | "user";

export interface MemoryOp {
	action: "add" | "replace" | "remove";
	content?: string;
	new_text?: string;
	old_text?: string;
}

const DELIMITER = "\n§\n";

const HEADERS: Record<MemoryTarget, string> = {
	memory: "MEMORY (your personal notes)",
	user: "USER PROFILE (who the user is)",
};

function fileFor(target: MemoryTarget): string {
	return join(paths.memories, target === "user" ? "USER.md" : "MEMORY.md");
}

function limitFor(target: MemoryTarget): number {
	return target === "user" ? settings.userCharLimit : settings.memoryCharLimit;
}

export function readEntries(target: MemoryTarget): string[] {
	const file = fileFor(target);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split(DELIMITER)
		.map((e) => e.trim())
		.filter(Boolean);
}

function writeEntries(target: MemoryTarget, entries: string[]): void {
	const file = fileFor(target);
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, entries.length ? `${entries.join(DELIMITER)}\n` : "");
	renameSync(tmp, file);
}

function size(entries: string[]): number {
	return entries.join(DELIMITER).length;
}

function findEntry(entries: string[], oldText: string): { index: number; error?: string } {
	const needle = oldText.trim();
	if (!needle) return { index: -1, error: "old_text is required for replace/remove" };
	const hits = entries.flatMap((e, i) => (e.includes(needle) ? [i] : []));
	if (hits.length === 0) return { index: -1, error: `no entry contains ${JSON.stringify(needle)}` };
	if (hits.length > 1) {
		return { index: -1, error: `old_text matches ${hits.length} entries; use a longer, unique substring` };
	}
	return { index: hits[0] };
}

export interface MemoryResult {
	success: boolean;
	message: string;
	target: MemoryTarget;
	usage: string;
	entries?: string[];
}

/** Apply operations atomically: all succeed and fit the budget, or nothing changes. */
export function applyMemoryOps(target: MemoryTarget, ops: MemoryOp[]): MemoryResult {
	const limit = limitFor(target);
	const original = readEntries(target);
	const entries = [...original];
	const usage = (list: string[]) => `${size(list)}/${limit} chars`;
	const fail = (message: string, showEntries = false): MemoryResult => ({
		success: false,
		message,
		target,
		usage: usage(original),
		...(showEntries ? { entries: original } : {}),
	});

	if (ops.length === 0) return fail("no operations given");

	for (const [i, op] of ops.entries()) {
		const label = ops.length > 1 ? `operation ${i + 1}: ` : "";
		const content = (op.content ?? op.new_text ?? "").trim();
		if (op.action === "add") {
			if (!content) return fail(`${label}content is required for add`);
			if (entries.includes(content)) continue;
			entries.push(content);
		} else if (op.action === "replace" || op.action === "remove") {
			const { index, error } = findEntry(entries, op.old_text ?? "");
			if (error) return fail(`${label}${error}`, true);
			if (op.action === "remove") {
				entries.splice(index, 1);
			} else {
				if (!content) return fail(`${label}content is required for replace`);
				entries[index] = content;
			}
		} else {
			return fail(`${label}unknown action ${JSON.stringify(op.action)}`);
		}
	}

	if (size(entries) > limit) {
		return fail(
			`over budget: result would be ${size(entries)}/${limit} chars. ` +
				"Reissue as ONE batch that removes or shortens stale entries and adds the new one together.",
			true,
		);
	}

	writeEntries(target, entries);
	return {
		success: true,
		message: `saved; ${entries.length} entries. This update is complete, do not repeat it.`,
		target,
		usage: usage(entries),
	};
}

function renderBlock(target: MemoryTarget): string {
	const entries = readEntries(target);
	const header = `══ ${HEADERS[target]} [${size(entries)}/${limitFor(target)} chars] ══`;
	return `${header}\n${entries.length ? entries.join(DELIMITER) : "(empty)"}`;
}

/** The frozen memory section appended to the system prompt. */
export function renderMemorySnapshot(): string {
	return [
		"# Persistent memory",
		"This snapshot was taken when the current context began. Writes made with the memory " +
			"tool are saved at once but appear here only after the next refresh.",
		renderBlock("user"),
		renderBlock("memory"),
	].join("\n\n");
}
