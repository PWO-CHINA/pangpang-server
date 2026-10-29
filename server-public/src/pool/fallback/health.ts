// Smart target ordering for the model pool (pangpang addition, not part of
// upstream pi-model-fallback-alias).
//
// Every attempt feeds an exponentially weighted success rate and time to
// first event per target.  Before each request the available targets are
// ordered:
//   1. the role's last successful target, while it stays healthy, so the
//      provider's prompt cache keeps hitting;
//   2. the rest by success rate (in 10% bands), then by time to first event,
//      then by configured order.
// Targets in cooldown are still appended last by the chain.

import type { AttemptLatencyOutcome } from "./types.ts";

interface Health {
	/** EWMA of 1 (success) / 0 (failure). */
	success: number;
	/** EWMA of time to first event, ms. */
	ttfbMs: number | undefined;
	samples: number;
}

const ALPHA = 0.3;
/** Below this success rate the sticky target loses its priority. */
const STICKY_MIN_SUCCESS = 0.5;

const health = new Map<string, Health>();
const lastGood = new Map<string, string>();

export function recordAttempt(role: string, target: string, outcome: AttemptLatencyOutcome, ttfbMs?: number): void {
	// unsafe-throw covers user aborts and failures after output was committed;
	// neither says anything reliable about the target's health.
	if (outcome === "unsafe-throw") return;
	const ok = outcome === "complete";
	const h = health.get(target) ?? { success: 1, ttfbMs: undefined, samples: 0 };
	h.success = h.success * (1 - ALPHA) + (ok ? 1 : 0) * ALPHA;
	if (ok && ttfbMs !== undefined) h.ttfbMs = h.ttfbMs === undefined ? ttfbMs : h.ttfbMs * (1 - ALPHA) + ttfbMs * ALPHA;
	h.samples++;
	health.set(target, h);
	if (ok) lastGood.set(role, target);
}

function band(target: string): number {
	return Math.round((health.get(target)?.success ?? 1) * 10);
}

/** Order targets for one request.  Stable for targets without samples. */
export function orderTargets<T extends { target: string; targetIndex: number }>(role: string, attempts: readonly T[]): T[] {
	const sticky = lastGood.get(role);
	const stickyHealthy = sticky !== undefined && (health.get(sticky)?.success ?? 1) >= STICKY_MIN_SUCCESS;
	return [...attempts].sort((a, b) => {
		if (stickyHealthy) {
			if (a.target === sticky) return -1;
			if (b.target === sticky) return 1;
		}
		const byBand = band(b.target) - band(a.target);
		if (byBand !== 0) return byBand;
		const ta = health.get(a.target)?.ttfbMs;
		const tb = health.get(b.target)?.ttfbMs;
		if (ta !== undefined && tb !== undefined && Math.abs(ta - tb) > 500) return ta - tb;
		return a.targetIndex - b.targetIndex;
	});
}

export function healthSnapshot(): Record<string, { success: number; ttfbMs?: number; samples: number }> {
	const out: Record<string, { success: number; ttfbMs?: number; samples: number }> = {};
	for (const [target, h] of health) {
		out[target] = {
			success: Math.round(h.success * 100) / 100,
			...(h.ttfbMs === undefined ? {} : { ttfbMs: Math.round(h.ttfbMs) }),
			samples: h.samples,
		};
	}
	return out;
}

/** The target that last served `role`, if any. */
export function lastGoodTarget(role: string): string | undefined {
	return lastGood.get(role);
}

/** Forget the sticky target of `role`, so a reordered chain applies at once. */
export function resetSticky(role: string): void {
	lastGood.delete(role);
}
