// Automatic recall (RAG over pangpang's own history and skills).
//
// Before each owner turn the conversation asks recall() for past exchanges
// that bear on the new message and appends the best few to it, so relevant
// history reaches the model without a session_search round trip.  The block
// goes into the user message, not the system prompt, so the prompt cache
// stays valid.
//
// Two stages, split so the daemon never loads a model:
//   lexical   every turn, in SQLite: FTS5 BM25 over Han bigrams and Latin words.
//             Chunks come from the chat logs (one owner message plus the
//             reply) and skill sections, synced incrementally from disk.
//   semantic  offline, in a separate short-lived process (src/recall-embed.ts,
//             `pp embed`, weekly task): embeds new chunks with a small local
//             model and stores each chunk's nearest neighbours.  At query time
//             the lexical hits pull in their neighbours, which finds related
//             exchanges that share no words with the question.
//
// var/recall.sqlite is rebuildable: delete it and the next sync and embed
// rebuild everything from the logs and skills.

import { existsSync, openSync, readdirSync, readFileSync, readSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths, settings } from "./config.ts";

export interface Chunk {
	id: number;
	source: string;
	date: string;
	text: string;
}

export interface RecallHit extends Chunk {
	score: number;
	via: "words" | "related";
}

const CHUNK_CHARS = 2000;
/** Vendor skills are generic; recalling them is noise. */
const SKIP_SKILLS = /^(caveman|cavecrew|generated|native|investigate-first|lean-build|migration|safe-refactor|surgical-patch|verify-and-stop)/;

let db: DatabaseSync | undefined;

export function openRecall(file = paths.recallDb): DatabaseSync {
	if (db) return db;
	db = new DatabaseSync(file);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 10000");
	db.exec(`
		CREATE TABLE IF NOT EXISTS chunks (
			id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, source TEXT NOT NULL,
			date TEXT NOT NULL, text TEXT NOT NULL, vec BLOB, mu REAL, sd REAL);
		CREATE TABLE IF NOT EXISTS neighbors (id INTEGER NOT NULL, nb INTEGER NOT NULL, sim REAL NOT NULL,
			PRIMARY KEY (id, nb));
		CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, pos INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
		CREATE VIRTUAL TABLE IF NOT EXISTS lex USING fts5(tok, tokenize = 'unicode61');
		CREATE VIRTUAL TABLE IF NOT EXISTS lex_vocab USING fts5vocab(lex, 'row');`);
	return db;
}

export function closeRecall(): void {
	db?.close();
	db = undefined;
}

function meta(database: DatabaseSync, k: string): string | undefined {
	return (database.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
}

function setMeta(database: DatabaseSync, k: string, v: string): void {
	database.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

function deleteChunks(database: DatabaseSync, where: string, arg: string): void {
	const ids = database.prepare(`SELECT id FROM chunks WHERE ${where}`).all(arg) as { id: number }[];
	for (const { id } of ids) {
		database.prepare("DELETE FROM neighbors WHERE id = ? OR nb = ?").run(id, id);
		database.prepare("DELETE FROM lex WHERE rowid = ?").run(id);
		database.prepare("DELETE FROM chunks WHERE id = ?").run(id);
	}
}

function upsert(database: DatabaseSync, key: string, source: string, date: string, text: string): void {
	const clipped = text.length > CHUNK_CHARS ? `${text.slice(0, CHUNK_CHARS)}…` : text;
	const old = database.prepare("SELECT text FROM chunks WHERE key = ?").get(key) as { text: string } | undefined;
	if (old?.text === clipped) return;
	if (old) deleteChunks(database, "key = ?", key);
	const { lastInsertRowid } = database
		.prepare("INSERT INTO chunks (key, source, date, text) VALUES (?, ?, ?, ?)")
		.run(key, source, date, clipped);
	database.prepare("INSERT INTO lex (rowid, tok) VALUES (?, ?)").run(lastInsertRowid, tokenize(clipped).join(" "));
}

/** Read what was appended to a log since the last sync; keep an unanswered tail for next time. */
function syncLog(database: DatabaseSync, chat: string, file: string): void {
	const size = statSync(file).size;
	const row = database.prepare("SELECT pos FROM files WHERE path = ?").get(file) as { pos: number } | undefined;
	let pos = row && row.pos <= size ? row.pos : 0;
	if (pos === size) return;
	const buf = Buffer.alloc(size - pos);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buf, 0, buf.length, pos);
	} finally {
		closeSync(fd);
	}
	const base = pos;
	let asked: { date: string; lines: string[]; start: number } | undefined;
	let offset = 0;
	for (const line of buf.toString("utf8").split("\n")) {
		const start = base + offset;
		offset += Buffer.byteLength(line) + 1;
		if (!line.trim()) continue;
		let r: { date: string; role: string; text: string };
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		if (r.role === "assistant") {
			// Greetings and stray punctuation are noise, not history.
			if (asked && asked.lines.join("").trim().length >= 4) {
				upsert(database, `chat:${chat}:${asked.date}`, `chat ${chat}`, asked.date, `owner: ${asked.lines.join("\n")}\npangpang: ${r.text}`);
			}
			asked = undefined;
			pos = start + Buffer.byteLength(line) + 1;
		} else {
			asked ??= { date: r.date, lines: [], start };
			asked.lines.push(r.text);
		}
	}
	if (!asked) pos = Math.min(base + offset, size);
	else pos = asked.start;
	database.prepare("INSERT INTO files (path, pos) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET pos = excluded.pos").run(file, pos);
}

function syncSkills(database: DatabaseSync): void {
	if (!existsSync(paths.skills)) return;
	const seen = new Set<string>();
	for (const name of readdirSync(paths.skills)) {
		if (SKIP_SKILLS.test(name)) continue;
		const file = join(paths.skills, name, "SKILL.md");
		if (!existsSync(file)) continue;
		seen.add(name);
		const mtime = Math.floor(statSync(file).mtimeMs);
		const row = database.prepare("SELECT pos FROM files WHERE path = ?").get(file) as { pos: number } | undefined;
		if (row?.pos === mtime) continue;
		deleteChunks(database, "source = ?", `skill ${name}`);
		const body = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
		body.split(/\n(?=## )/).forEach((section, i) => {
			if (section.trim().length > 20) upsert(database, `skill:${name}:${i}`, `skill ${name}`, "", section.trim());
		});
		database.prepare("INSERT INTO files (path, pos) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET pos = excluded.pos").run(file, mtime);
	}
	const sources = database.prepare("SELECT DISTINCT source FROM chunks WHERE source LIKE 'skill %'").all() as { source: string }[];
	for (const { source } of sources) {
		if (!seen.has(source.slice(6))) deleteChunks(database, "source = ?", source);
	}
}

/** Bring chunks up to date with the logs and skills.  Cheap when nothing changed. */
export function syncChunks(database = openRecall()): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		if (existsSync(paths.chats)) {
			for (const chat of readdirSync(paths.chats)) {
				const file = join(paths.chats, chat, "log.jsonl");
				if (existsSync(file)) syncLog(database, chat, file);
			}
		}
		syncSkills(database);
		database.exec("COMMIT");
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

// ---- lexical stage ------------------------------------------------------

/**
 * Latin words and numbers (2+ chars) plus Han bigrams; single Han characters
 * are too common to mean anything.  Stored space-separated in the `lex` FTS5
 * table, so SQLite does the BM25 ranking and nothing is held in memory.
 */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	const lower = text.toLowerCase();
	for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) out.push(m[0]);
	for (const m of lower.matchAll(/\p{Script=Han}+/gu)) {
		const run = [...m[0]];
		for (let i = 0; i + 2 <= run.length; i++) out.push(run[i] + run[i + 1]);
	}
	return out;
}

export interface RecallOptions {
	/** Skip chunks dated at or after this ISO time: they are already in the live context. */
	before?: string;
	/** Maximum hits returned. */
	limit?: number;
}

export function recall(query: string, opts: RecallOptions = {}): RecallHit[] {
	const database = openRecall();
	syncChunks(database);
	const terms = [...new Set(tokenize(query))].slice(0, 200);
	if (terms.length === 0) return [];
	const n = (database.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
	if (n === 0) return [];

	// Matched terms must carry a real share of the query's information (IDF),
	// so one shared common bigram does not make a chunk relevant.  Terms that
	// occur nowhere say nothing about which chunk fits and are left out.
	const dfStmt = database.prepare("SELECT doc FROM lex_vocab WHERE term = ?");
	// A long message is reduced to its most informative terms.
	const weighted: [string, number][] = [];
	for (const t of terms) {
		const df = (dfStmt.get(t) as { doc: number } | undefined)?.doc ?? 0;
		if (df > 0) weighted.push([t, Math.log(1 + (n - df + 0.5) / (df + 0.5))]);
	}
	const idf = new Map(weighted.sort((x, y) => y[1] - x[1]).slice(0, 12));
	const totalIdf = [...idf.values()].reduce((s, x) => s + x, 0);
	if (totalIdf === 0) return [];
	const match = [...idf.keys()].map((t) => `"${t}"`).join(" OR ");
	const rows = database
		.prepare("SELECT rowid AS id, tok FROM lex WHERE lex MATCH ? ORDER BY bm25(lex) LIMIT 50")
		.all(match) as { id: number; tok: string }[];
	const lexical = rows.filter((r) => {
		const have = new Set(r.tok.split(" "));
		const covered = [...idf].reduce((s, [t, w]) => s + (have.has(t) ? w : 0), 0);
		return covered / totalIdf >= 0.35;
	});

	// Reciprocal rank fusion of the lexical ranking and neighbour expansion.
	const fused = new Map<number, { score: number; via: RecallHit["via"] }>();
	lexical.slice(0, 20).forEach(({ id }, rank) => fused.set(id, { score: 1 / (10 + rank), via: "words" }));
	const nbStmt = database.prepare("SELECT nb, sim FROM neighbors WHERE id = ? ORDER BY sim DESC");
	lexical.slice(0, 5).forEach(({ id }, rank) => {
		for (const { nb, sim } of nbStmt.all(id) as { nb: number; sim: number }[]) {
			const add = (sim / (10 + rank)) * 0.6;
			const cur = fused.get(nb);
			if (cur) cur.score += add;
			else fused.set(nb, { score: add, via: "related" });
		}
	});

	const get = database.prepare("SELECT id, source, date, text FROM chunks WHERE id = ?");
	const hits: RecallHit[] = [];
	for (const [id, f] of [...fused.entries()].sort((x, y) => y[1].score - x[1].score)) {
		const c = get.get(id) as Chunk | undefined;
		if (!c) continue;
		if (opts.before && c.date && c.date >= opts.before) continue;
		hits.push({ ...c, score: f.score, via: f.via });
		if (hits.length >= (opts.limit ?? 3)) break;
	}
	return hits;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The block appended to an owner message, or "" when nothing relevant was found. */
export function recallBlock(query: string, opts: RecallOptions = {}): string {
	if (!settings.recallChars) return "";
	const hits = recall(query, opts);
	if (hits.length === 0) return "";
	const per = Math.max(160, Math.floor(settings.recallChars / hits.length));
	const lines = hits.map((h) => {
		const when = h.date ? h.date.slice(0, 10) : h.source;
		return `- [${when}${h.date ? `, ${h.source}` : ""}] ${oneLine(h.text, per)}`;
	});
	return (
		"<recall>\nAutomatic recall from earlier conversations and skills, outside your current " +
		"context. Background only: answer the message above; facts here may be stale, check " +
		"before acting on them. session_search has the full text.\n" +
		`${lines.join("\n")}\n</recall>`
	);
}

// ---- semantic stage storage (written by src/recall-embed.ts) -------------

export function toBlob(v: Float32Array): Uint8Array {
	return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Uint8Array): Float32Array {
	const copy = new Uint8Array(b);
	return new Float32Array(copy.buffer);
}

export { meta as recallMeta, setMeta as setRecallMeta };
