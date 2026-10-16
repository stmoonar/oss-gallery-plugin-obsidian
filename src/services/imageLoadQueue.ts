/**
 * Pure scheduling logic for gallery tile loading (no DOM, no obsidian).
 *
 * - At most `maxConcurrent` loads hold a slot at once.
 * - Waiting items start in FIFO order (order of `request`), items flagged
 *   visible before prefetch-only ones.
 * - An item that leaves the prefetch zone before it started is dropped from
 *   the queue (it is queued again when it comes back).
 * - Retries happen only after a real failure (`failed`), with backoff.
 * - There is no total timeout: a load is never restarted while in flight.
 *   A load that holds its slot longer than `stallTimeoutMs` gives the slot
 *   up (state "stalled") but keeps running; its later load/error still
 *   counts.
 * - `cancel` forgets an item: its slot and timers are released and late
 *   events for it are ignored.
 */

export interface QueueTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface LoadQueueHooks<T> {
	/** Start (or restart, `attempt` > 1) loading the item. */
	start(item: T, attempt: number): void;
	/** Called after the last attempt failed. */
	onFailed?(item: T): void;
	/** Return false to drop the item instead of starting it (e.g. detached). */
	shouldStart?(item: T): boolean;
}

export interface LoadQueueOptions {
	maxConcurrent?: number;
	/** Attempts in total (first try included). */
	maxAttempts?: number;
	/** Delay before attempt `attempt + 1` after attempt `attempt` failed. */
	backoffMs?: (attempt: number) => number;
	/** Slot time limit once a load started; 0 disables it. */
	stallTimeoutMs?: number;
	timers: QueueTimers;
}

export type LoadState =
	| "queued"   // waiting for a slot, inside the prefetch zone
	| "waiting"  // needs a (re)start but is outside the zone
	| "active"   // in flight, holds a slot
	| "stalled"  // in flight, slot given up after the stall timeout
	| "backoff"  // failed, waiting to retry
	| "done"
	| "failed";

interface Entry {
	state: LoadState;
	visible: boolean;
	inZone: boolean;
	attempt: number;
	seq: number;
	timer: unknown;
	hasTimer: boolean;
}

export const DEFAULT_MAX_CONCURRENT = 6;
export const DEFAULT_STALL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export function defaultBackoffMs(attempt: number): number {
	return Math.min(1000 * Math.pow(2, attempt - 1), 4000);
}

export class ImageLoadQueue<T> {
	private readonly entries = new Map<T, Entry>();
	private readonly maxConcurrent: number;
	private readonly maxAttempts: number;
	private readonly backoffMs: (attempt: number) => number;
	private readonly stallTimeoutMs: number;
	private readonly timers: QueueTimers;
	private active = 0;
	private seq = 0;
	private destroyed = false;
	private pumping = false;

	constructor(private readonly hooks: LoadQueueHooks<T>, options: LoadQueueOptions) {
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
		this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
		this.backoffMs = options.backoffMs ?? defaultBackoffMs;
		this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
		this.timers = options.timers;
	}

	/** The item entered the prefetch zone (`visible`: also the viewport). */
	request(item: T, visible: boolean): void {
		if (this.destroyed) return;
		let entry = this.entries.get(item);
		if (!entry) {
			entry = { state: "queued", visible, inZone: true, attempt: 0, seq: this.seq++, timer: undefined, hasTimer: false };
			this.entries.set(item, entry);
		} else {
			entry.visible = visible;
			entry.inZone = true;
			if (entry.state === "waiting") {
				entry.state = "queued";
				entry.seq = this.seq++;
			}
		}
		this.pump();
	}

	/** Viewport visibility changed (priority only). */
	setVisible(item: T, visible: boolean): void {
		const entry = this.entries.get(item);
		if (!entry) return;
		entry.visible = visible;
		if (visible) entry.inZone = true;
	}

	/** The item left the prefetch zone: drop it if it hasn't started. */
	leave(item: T): void {
		const entry = this.entries.get(item);
		if (!entry) return;
		entry.inZone = false;
		entry.visible = false;
		if (entry.state === "queued") entry.state = "waiting";
	}

	loaded(item: T): void {
		const entry = this.entries.get(item);
		if (!entry || (entry.state !== "active" && entry.state !== "stalled")) return;
		this.releaseSlot(entry);
		entry.state = "done";
		this.pump();
	}

	failed(item: T): void {
		const entry = this.entries.get(item);
		if (!entry || (entry.state !== "active" && entry.state !== "stalled")) return;
		this.releaseSlot(entry);
		if (entry.attempt >= this.maxAttempts) {
			entry.state = "failed";
			this.hooks.onFailed?.(item);
		} else {
			entry.state = "backoff";
			this.setTimer(entry, this.backoffMs(entry.attempt), () => {
				if (this.entries.get(item) !== entry || entry.state !== "backoff") return;
				entry.seq = this.seq++;
				entry.state = entry.inZone ? "queued" : "waiting";
				this.pump();
			});
		}
		this.pump();
	}

	/** Forget the item: frees its slot and timers; later events are ignored. */
	cancel(item: T): void {
		const entry = this.entries.get(item);
		if (!entry) return;
		this.releaseSlot(entry);
		this.clearTimer(entry);
		this.entries.delete(item);
		this.pump();
	}

	cancelAll(): void {
		for (const entry of this.entries.values()) {
			this.clearTimer(entry);
		}
		this.entries.clear();
		this.active = 0;
	}

	destroy(): void {
		this.cancelAll();
		this.destroyed = true;
	}

	stateOf(item: T): LoadState | undefined {
		return this.entries.get(item)?.state;
	}

	get activeCount(): number {
		return this.active;
	}

	get queuedCount(): number {
		let n = 0;
		for (const entry of this.entries.values()) {
			if (entry.state === "queued") n++;
		}
		return n;
	}

	private releaseSlot(entry: Entry): void {
		if (entry.state === "active") {
			this.active--;
			this.clearTimer(entry);
		}
	}

	private setTimer(entry: Entry, ms: number, fn: () => void): void {
		this.clearTimer(entry);
		entry.timer = this.timers.setTimeout(fn, ms);
		entry.hasTimer = true;
	}

	private clearTimer(entry: Entry): void {
		if (entry.hasTimer) {
			this.timers.clearTimeout(entry.timer);
			entry.hasTimer = false;
			entry.timer = undefined;
		}
	}

	private next(): [T, Entry] | null {
		let best: [T, Entry] | null = null;
		for (const pair of this.entries) {
			const entry = pair[1];
			if (entry.state !== "queued") continue;
			if (!best
				|| (entry.visible && !best[1].visible)
				|| (entry.visible === best[1].visible && entry.seq < best[1].seq)) {
				best = pair;
			}
		}
		return best;
	}

	private pump(): void {
		if (this.pumping || this.destroyed) return;
		this.pumping = true;
		try {
			while (this.active < this.maxConcurrent) {
				const next = this.next();
				if (!next) break;
				const [item, entry] = next;
				if (this.hooks.shouldStart && !this.hooks.shouldStart(item)) {
					this.clearTimer(entry);
					this.entries.delete(item);
					continue;
				}
				entry.state = "active";
				entry.attempt++;
				this.active++;
				const attempt = entry.attempt;
				if (this.stallTimeoutMs > 0) {
					this.setTimer(entry, this.stallTimeoutMs, () => {
						if (this.entries.get(item) !== entry || entry.state !== "active" || entry.attempt !== attempt) return;
						entry.hasTimer = false;
						this.active--;
						entry.state = "stalled";
						this.pump();
					});
				}
				try {
					this.hooks.start(item, attempt);
				} catch (error) {
					console.error("Image load start failed", error);
					if (this.entries.get(item) === entry && entry.state === "active") {
						this.releaseSlot(entry);
						entry.state = "failed";
						this.hooks.onFailed?.(item);
					}
				}
			}
		} finally {
			this.pumping = false;
		}
	}
}
