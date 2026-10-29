// Task model: scheduled actions, one JSON file per task in data/tasks/.
//
//   { "schedule": "0 9 * * 1-5", "timezone": "Asia/Shanghai", "do": { ... } }
//   { "at": "2026-12-15T09:00:00+11:00", "do": { ... } }      one-shot, file deleted after
//   { "enabled": false, ... }                                  kept but not scheduled
//
// "do" is an action (src/automation/actions.ts).  fs.watch reacts to edits;
// a rescan every minute covers missed notifications.  While paused, cron
// tasks are skipped; one-shot tasks (reminders the owner asked for) still run.
// Evolved from pi-mom's EventsWatcher (MIT, Mario Zechner).

import { Cron } from "croner";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "../config.ts";
import { errorText, log } from "../log.ts";
import { type Action, type ActionRuntime, runAction } from "./actions.ts";

export interface TaskSpec {
	schedule?: string;
	at?: string;
	timezone?: string;
	enabled?: boolean;
	do: Action;
}

interface Scheduled {
	mtime: number;
	spec: TaskSpec;
	cron?: Cron;
	timer?: NodeJS.Timeout;
}

const RESCAN_MS = 60_000;
/** A one-shot task this late is still run (e.g. the NAS was rebooting); older ones are dropped. */
const LATE_GRACE_MS = 10 * 60_000;

function parse(text: string): TaskSpec {
	const spec = JSON.parse(text) as TaskSpec;
	if (!spec.do || typeof spec.do !== "object") throw new Error('missing "do" action');
	if (!spec.schedule && !spec.at) throw new Error('needs "schedule" (cron) or "at" (ISO time)');
	return spec;
}

export class TaskScheduler {
	private rt: ActionRuntime;
	private tasks = new Map<string, Scheduled>();
	private watcher: FSWatcher | undefined;
	private rescan: NodeJS.Timeout | undefined;
	private debounce = new Map<string, NodeJS.Timeout>();

	constructor(rt: ActionRuntime) {
		this.rt = rt;
	}

	start(): void {
		this.scan();
		try {
			this.watcher = watch(paths.tasks, (_kind, file) => {
				if (!file?.endsWith(".json") || file.startsWith(".")) return;
				clearTimeout(this.debounce.get(file));
				this.debounce.set(
					file,
					setTimeout(() => {
						this.debounce.delete(file);
						this.sync(file);
					}, 200),
				);
			});
			this.watcher.on("error", (err) => log.warn("tasks", "watch error; relying on rescans", errorText(err)));
		} catch (err) {
			log.warn("tasks", "fs.watch unavailable; relying on rescans", errorText(err));
		}
		this.rescan = setInterval(() => this.scan(), RESCAN_MS);
		log.info("tasks", `watching ${paths.tasks} (${this.tasks.size} tasks)`);
	}

	stop(): void {
		this.watcher?.close();
		clearInterval(this.rescan);
		for (const t of this.debounce.values()) clearTimeout(t);
		for (const name of [...this.tasks.keys()]) this.unschedule(name);
	}

	private scan(): void {
		let files: string[] = [];
		try {
			files = readdirSync(paths.tasks).filter((f) => f.endsWith(".json") && !f.startsWith("."));
		} catch (err) {
			log.warn("tasks", "cannot read tasks dir", errorText(err));
			return;
		}
		const present = new Set(files);
		for (const f of files) this.sync(f);
		for (const f of [...this.tasks.keys()]) if (!present.has(f)) this.sync(f);
	}

	private unschedule(file: string): void {
		const t = this.tasks.get(file);
		t?.cron?.stop();
		clearTimeout(t?.timer);
		this.tasks.delete(file);
	}

	private sync(file: string): void {
		const path = join(paths.tasks, file);
		if (!existsSync(path)) {
			if (this.tasks.has(file)) log.info("tasks", `removed ${file}`);
			this.unschedule(file);
			return;
		}
		const mtime = statSync(path).mtimeMs;
		if (this.tasks.get(file)?.mtime === mtime) return;
		this.unschedule(file);

		let spec: TaskSpec;
		try {
			spec = parse(readFileSync(path, "utf8"));
		} catch (err) {
			// Keep the file so the owner or agent can fix it; it is retried on edit.
			log.warn("tasks", `invalid ${file}`, errorText(err));
			this.tasks.set(file, { mtime, spec: { do: { notify: "" } } });
			return;
		}
		const entry: Scheduled = { mtime, spec };
		this.tasks.set(file, entry);
		if (spec.enabled === false) return;

		if (spec.schedule) {
			try {
				entry.cron = new Cron(spec.schedule, { timezone: spec.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }, () => {
					if (existsSync(paths.pausedFlag)) {
						log.info("tasks", `${file} skipped, paused`);
						return;
					}
					void this.fire(file);
				});
				log.info("tasks", `${file}: next ${entry.cron.nextRun()?.toISOString() ?? "never"}`);
			} catch (err) {
				log.warn("tasks", `bad schedule in ${file}`, errorText(err));
			}
			return;
		}

		const delay = new Date(spec.at!).getTime() - Date.now();
		if (!Number.isFinite(delay)) {
			log.warn("tasks", `bad "at" in ${file}`);
		} else if (delay < -LATE_GRACE_MS) {
			log.info("tasks", `${file} is long past, deleting`);
			this.remove(file);
		} else {
			// setTimeout caps at ~24.8 days; re-check later for anything further out.
			const wait = Math.max(0, Math.min(delay, 2 ** 31 - 1));
			entry.timer = setTimeout(() => {
				if (wait < delay) {
					this.tasks.delete(file);
					this.sync(file);
				} else {
					void this.fire(file, true);
				}
			}, wait);
		}
	}

	private remove(file: string): void {
		this.unschedule(file);
		try {
			unlinkSync(join(paths.tasks, file));
		} catch {
			// Already gone.
		}
	}

	/** Run a task now.  One-shot tasks are deleted once they have run. */
	async fire(file: string, oneShot = false): Promise<string> {
		const spec = this.tasks.get(file)?.spec;
		if (!spec) return "no such task";
		if (oneShot) this.remove(file);
		const name = basename(file, ".json");
		return runAction(`task:${name}`, spec.do, { task: name, now: new Date().toISOString() }, this.rt);
	}

	/** Name, kind and next run of every task, for /tasks. */
	list(): { name: string; when: string; next?: string; kind: string; enabled: boolean }[] {
		return [...this.tasks.entries()].map(([file, t]) => ({
			name: basename(file, ".json"),
			when: t.spec.schedule ?? t.spec.at ?? "?",
			next: t.cron?.nextRun()?.toISOString() ?? t.spec.at,
			kind: Object.keys(t.spec.do ?? {}).find((k) => ["notify", "run", "agent"].includes(k)) ?? "?",
			enabled: t.spec.enabled !== false,
		}));
	}

	has(name: string): boolean {
		return this.tasks.has(`${name}.json`);
	}
}
