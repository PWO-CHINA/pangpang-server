// Delegation jobs: every run of Codex or Claude Code is a job, whether the
// agent waits for it (foreground) or is told when it finishes (background).
// At most MAX_RUNNING run at once, to keep the NAS responsive; the last
// KEEP finished jobs stay listable (/jobs, delegate_jobs).

import { log } from "../log.ts";
import { type DelegateMode, type DelegationResult, runDelegation } from "./acp.ts";

export interface Job {
	id: string;
	agent: string;
	task: string;
	mode: DelegateMode;
	cwd: string;
	status: "running" | "done" | "failed" | "cancelled";
	startedAt: Date;
	result?: DelegationResult;
	controller: AbortController;
	done: Promise<DelegationResult>;
}

export interface JobRequest {
	agent: string;
	task: string;
	cwd: string;
	mode?: DelegateMode;
	timeoutMin?: number;
	/** Called once the job has finished, in any state. */
	onDone?: (job: Job) => void | Promise<void>;
}

const MAX_RUNNING = 2;
const KEEP = 20;
const jobs = new Map<string, Job>();
let counter = 0;

function newId(agent: string): string {
	counter = (counter + 1) % 1000;
	const t = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${agent}-${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}-${counter}`;
}

function prune(): void {
	const finished = [...jobs.values()].filter((j) => j.status !== "running");
	for (const job of finished.slice(0, Math.max(0, finished.length - KEEP))) jobs.delete(job.id);
}

export function runningCount(): number {
	return [...jobs.values()].filter((j) => j.status === "running").length;
}

export function startJob(req: JobRequest): Job {
	if (runningCount() >= MAX_RUNNING) {
		throw new Error(`${MAX_RUNNING} delegations are already running; wait for one or cancel it`);
	}
	const controller = new AbortController();
	const id = newId(req.agent);
	const job = {
		id,
		agent: req.agent,
		task: req.task,
		mode: req.mode ?? "full",
		cwd: req.cwd,
		status: "running",
		startedAt: new Date(),
		controller,
	} as Job;
	log.info("delegate", `${id}: start (${job.mode}) in ${job.cwd}`);
	job.done = runDelegation({
		id,
		agent: req.agent,
		task: req.task,
		cwd: req.cwd,
		mode: job.mode,
		timeoutMin: req.timeoutMin ?? 60,
		signal: controller.signal,
	})
		.catch((err): DelegationResult => ({
			ok: false,
			stopReason: "error",
			reply: "",
			tools: [],
			seconds: Math.round((Date.now() - job.startedAt.getTime()) / 1000),
			logPath: "",
			error: err instanceof Error ? err.message : String(err),
		}))
		.then(async (result) => {
			job.result = result;
			job.status = controller.signal.aborted ? "cancelled" : result.ok ? "done" : "failed";
			log.info("delegate", `${id}: ${job.status} in ${result.seconds}s (${result.tools.length} tool calls)`);
			prune();
			try {
				await req.onDone?.(job);
			} catch (err) {
				log.warn("delegate", `${id}: completion handler failed`, String(err));
			}
			return result;
		});
	jobs.set(id, job);
	return job;
}

export function listJobs(): Job[] {
	return [...jobs.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

export function cancelJob(id: string): boolean {
	const job = jobs.get(id);
	if (!job || job.status !== "running") return false;
	job.controller.abort();
	return true;
}

export function cancelAll(): void {
	for (const job of jobs.values()) if (job.status === "running") job.controller.abort();
}

/** A compact report of a finished job, for the chat or the calling agent. */
export function formatJob(job: Job): string {
	const r = job.result;
	if (!r) return `${job.id}: running for ${Math.round((Date.now() - job.startedAt.getTime()) / 60000)} min`;
	const head = `${job.id}: ${job.status}, ${r.seconds}s, ${r.tools.length} tool calls${r.error ? `, error: ${r.error}` : ""}`;
	const tools = r.tools.length ? `\nTools: ${r.tools.slice(-12).join(" | ")}` : "";
	return `${head}${tools}\nLog: ${r.logPath}\n\n${r.reply || "(no reply text)"}`;
}
