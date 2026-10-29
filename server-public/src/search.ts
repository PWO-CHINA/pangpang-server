// Cross-session recall, internalized from Hermes Agent's session_search
// (FTS5 over past conversations).  Every chat's log.jsonl is the source of
// truth; this SQLite FTS5 index makes it searchable across chats and across
// compactions.  The trigram tokenizer handles Chinese and code identifiers,
// which word tokenizers split badly.  If the index is lost it is rebuilt
// from the logs.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "./config.ts";

export interface LogRecord {
	date: string;
	chatId: string;
	role: "user" | "assistant" | "event";
	name?: string;
	text: string;
}

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
	if (db) return db;
	const fresh = !existsSync(paths.searchDb);
	db = new DatabaseSync(paths.searchDb);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(
		"CREATE VIRTUAL TABLE IF NOT EXISTS logs USING fts5(" +
			"text, date UNINDEXED, chat UNINDEXED, role UNINDEXED, tokenize = 'trigram')",
	);
	if (fresh) rebuild(db);
	return db;
}

function rebuild(database: DatabaseSync): void {
	if (!existsSync(paths.chats)) return;
	for (const chat of readdirSync(paths.chats)) {
		const file = join(paths.chats, chat, "log.jsonl");
		if (!existsSync(file)) continue;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				insert(database, JSON.parse(line) as LogRecord);
			} catch {
				// Skip malformed lines; the log stays authoritative.
			}
		}
	}
}

function insert(database: DatabaseSync, r: LogRecord): void {
	database
		.prepare("INSERT INTO logs (text, date, chat, role) VALUES (?, ?, ?, ?)")
		.run(r.text, r.date, r.chatId, r.role);
}

export function indexRecord(record: LogRecord): void {
	insert(open(), record);
}

export interface SearchHit {
	date: string;
	chat: string;
	role: string;
	snippet: string;
}

/**
 * Search past messages.  Queries of three or more characters use the FTS
 * index (every whitespace-separated term must appear); shorter ones fall
 * back to a substring scan.
 */
export function searchLogs(query: string, limit = 20, chat?: string): SearchHit[] {
	const database = open();
	const terms = query.trim().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [];
	const chatClause = chat ? " AND chat = ?" : "";
	const chatArgs = chat ? [chat] : [];

	let rows: Record<string, unknown>[];
	if (terms.every((t) => [...t].length >= 3)) {
		const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
		rows = database
			.prepare(
				"SELECT date, chat, role, snippet(logs, 0, '«', '»', ' … ', 64) AS snippet " +
					`FROM logs WHERE logs MATCH ?${chatClause} ORDER BY date DESC LIMIT ?`,
			)
			.all(match, ...chatArgs, limit);
	} else {
		const likes = terms.map(() => "text LIKE ?").join(" AND ");
		rows = database
			.prepare(
				"SELECT date, chat, role, substr(text, 1, 300) AS snippet " +
					`FROM logs WHERE ${likes}${chatClause} ORDER BY date DESC LIMIT ?`,
			)
			.all(...terms.map((t) => `%${t}%`), ...chatArgs, limit);
	}
	return rows as unknown as SearchHit[];
}

export function closeSearch(): void {
	db?.close();
	db = undefined;
}
