// Offline semantic stage of recall (see src/recall.ts).  Run by `pp embed`,
// weekly from data/tasks/recall-embed.json, never inside the daemon: the
// embedding model costs ~400 MB while loaded, so it lives in this
// short-lived, niced, single-threaded process and the memory is returned
// when it exits.
//
//   1. sync chunks from the logs and skills
//   2. embed chunks without a vector (local model, cached under var/cache/models)
//   3. link each new chunk to its nearest neighbours, both directions,
//      keeping the best NEIGHBORS per chunk.  Small embedding models score
//      everything in a narrow high band, so a fixed cut-off does not work:
//      a neighbour must stand out from that chunk's own similarity profile
//      (Z standard deviations above its mean) and clear MIN_SIM.
//
// Silent on success (the weekly task notifies only on output or failure);
// -v prints a summary.  A summary line always goes to stdout of `pp embed`
// when run by hand with -v, and to var/logs/recall.log.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { PP_VAR } from "./config.ts";
import { fromBlob, openRecall, recallMeta, setRecallMeta, syncChunks, toBlob } from "./recall.ts";

const MODEL = process.env.PP_RECALL_MODEL ?? "Xenova/bge-small-zh-v1.5";
const NEIGHBORS = 4;
const MIN_SIM = Number(process.env.PP_RECALL_MIN_SIM ?? 0.7);
const Z = 2;
/** Small batches keep the padded attention buffers, and so peak memory, low. */
const BATCH = 2;

const verbose = process.argv.includes("-v");
const started = Date.now();
const db = openRecall();
syncChunks(db);

// A different model makes every stored vector incomparable: start over.
if (recallMeta(db, "model") !== MODEL) {
	db.exec("UPDATE chunks SET vec = NULL; DELETE FROM neighbors;");
	setRecallMeta(db, "model", MODEL);
}

const pending = db.prepare("SELECT id, text FROM chunks WHERE vec IS NULL ORDER BY id").all() as { id: number; text: string }[];
let linked = 0;
if (pending.length > 0) {
	const { env, pipeline } = await import("@huggingface/transformers");
	env.cacheDir = join(PP_VAR, "cache", "models");
	const embed = await pipeline("feature-extraction", MODEL, {
		dtype: "q8",
		session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
	});
	const setVec = db.prepare("UPDATE chunks SET vec = ? WHERE id = ?");
	for (let i = 0; i < pending.length; i += BATCH) {
		const batch = pending.slice(i, i + BATCH);
		const out = await embed(
			batch.map((c) => c.text),
			{ pooling: "cls", normalize: true },
		);
		const dim = out.dims[1];
		const data = out.data as Float32Array;
		db.exec("BEGIN");
		batch.forEach((c, j) => setVec.run(toBlob(data.slice(j * dim, (j + 1) * dim)), c.id));
		db.exec("COMMIT");
	}
	await embed.dispose();

	// Link new chunks against everything.  Vectors are normalized: dot = cosine.
	// Old chunks keep the profile (mean, sd) computed when they were new.
	const all = (
		db.prepare("SELECT id, vec, mu, sd FROM chunks WHERE vec IS NOT NULL").all() as {
			id: number;
			vec: Uint8Array;
			mu: number | null;
			sd: number | null;
		}[]
	).map((r) => ({ id: r.id, v: fromBlob(r.vec), mu: r.mu, sd: r.sd }));
	const fresh = new Set(pending.map((c) => c.id));
	const link = db.prepare(
		"INSERT INTO neighbors (id, nb, sim) VALUES (?, ?, ?) ON CONFLICT(id, nb) DO UPDATE SET sim = excluded.sim",
	);
	const setProfile = db.prepare("UPDATE chunks SET mu = ?, sd = ? WHERE id = ?");
	const cut = (mu: number | null, sd: number | null) => Math.max(MIN_SIM, (mu ?? 1) + Z * (sd ?? 0));
	db.exec("BEGIN");
	for (const a of all) {
		if (!fresh.has(a.id)) continue;
		const sims = all.map((b) => {
			let dot = 0;
			for (let k = 0; k < a.v.length; k++) dot += a.v[k] * b.v[k];
			return dot;
		});
		const others = sims.filter((_, j) => all[j].id !== a.id);
		const mu = others.reduce((s, x) => s + x, 0) / (others.length || 1);
		const sd = Math.sqrt(others.reduce((s, x) => s + (x - mu) ** 2, 0) / (others.length || 1));
		a.mu = mu;
		a.sd = sd;
		setProfile.run(mu, sd, a.id);
		all.forEach((b, j) => {
			if (b.id === a.id) return;
			const sim = sims[j];
			if (sim >= cut(mu, sd)) {
				link.run(a.id, b.id, sim);
				linked++;
			}
			if (sim >= cut(b.mu, b.sd)) link.run(b.id, a.id, sim);
		});
	}
	db.exec(`DELETE FROM neighbors WHERE rowid IN (
		SELECT rowid FROM (SELECT rowid, row_number() OVER (PARTITION BY id ORDER BY sim DESC) AS rn FROM neighbors)
		WHERE rn > ${NEIGHBORS})`);
	db.exec("COMMIT");
}

const total = (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
const summary =
	`embedded ${pending.length} new of ${total} chunks, ${linked} links, ` +
	`${((Date.now() - started) / 1000).toFixed(1)}s, peak ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`;
appendFileSync(join(PP_VAR, "logs", "recall.log"), `${new Date().toISOString()} ${summary}\n`);
if (verbose) console.log(summary);
db.close();
