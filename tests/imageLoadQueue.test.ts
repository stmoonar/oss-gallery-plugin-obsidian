import { describe, expect, it } from "vitest";
import { ImageLoadQueue, LoadQueueOptions, QueueTimers } from "../src/services/imageLoadQueue";
import { isTiffKey } from "../src/providers/shared/image";

/** Manual clock: timers fire only on `advance`. */
class FakeClock implements QueueTimers {
	now = 0;
	private nextId = 1;
	private readonly pending = new Map<number, { at: number; fn: () => void }>();

	setTimeout(fn: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.pending.set(id, { at: this.now + ms, fn });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.pending.delete(handle as number);
	}

	advance(ms: number): void {
		const end = this.now + ms;
		for (;;) {
			let nextId = -1;
			let nextAt = Infinity;
			for (const [id, timer] of this.pending) {
				if (timer.at <= end && timer.at < nextAt) {
					nextAt = timer.at;
					nextId = id;
				}
			}
			if (nextId < 0) break;
			const timer = this.pending.get(nextId)!;
			this.pending.delete(nextId);
			this.now = timer.at;
			timer.fn();
		}
		this.now = end;
	}

	get timerCount(): number {
		return this.pending.size;
	}
}

function setup(options: Partial<LoadQueueOptions> = {}, shouldStart?: (item: string) => boolean) {
	const clock = new FakeClock();
	const starts: Array<[string, number]> = [];
	const failures: string[] = [];
	const queue = new ImageLoadQueue<string>(
		{
			start: (item, attempt) => starts.push([item, attempt]),
			onFailed: (item) => failures.push(item),
			shouldStart,
		},
		{ maxConcurrent: 2, maxAttempts: 3, backoffMs: () => 1000, stallTimeoutMs: 60_000, timers: clock, ...options }
	);
	const started = () => starts.map(([item]) => item);
	return { clock, queue, starts, failures, started };
}

describe("ImageLoadQueue", () => {
	it("never runs more than maxConcurrent loads; a slot frees on load/error/cancel", () => {
		const { queue, started } = setup();
		for (const item of ["a", "b", "c", "d", "e"]) queue.request(item, true);
		expect(started()).toEqual(["a", "b"]);
		expect(queue.activeCount).toBe(2);
		expect(queue.queuedCount).toBe(3);

		queue.loaded("a");
		expect(started()).toEqual(["a", "b", "c"]);
		queue.failed("b"); // retry goes to backoff, slot freed
		expect(started()).toEqual(["a", "b", "c", "d"]);
		queue.cancel("c");
		expect(started()).toEqual(["a", "b", "c", "d", "e"]);
		expect(queue.activeCount).toBe(2);
	});

	it("starts in request order, viewport-visible items first", () => {
		const { queue, started } = setup({ maxConcurrent: 1 });
		queue.request("busy", true);
		queue.request("p1", false);
		queue.request("p2", false);
		queue.request("v1", true);
		queue.request("v2", true);
		queue.setVisible("p2", true); // scrolled into view while queued
		const order = ["busy"];
		for (let i = 0; i < 5; i++) {
			queue.loaded(order[order.length - 1]);
			order.push(started()[started().length - 1]);
		}
		expect(started()).toEqual(["busy", "p2", "v1", "v2", "p1"]);
	});

	it("drops an item that leaves the zone before starting and requeues it on return", () => {
		const { queue, started } = setup({ maxConcurrent: 1 });
		queue.request("a", true);
		queue.request("b", false);
		queue.leave("b");
		expect(queue.stateOf("b")).toBe("waiting");
		queue.loaded("a");
		expect(started()).toEqual(["a"]);
		expect(queue.activeCount).toBe(0);
		queue.request("b", true);
		expect(started()).toEqual(["a", "b"]);
	});

	it("leaving the zone doesn't stop a load that already started", () => {
		const { queue } = setup();
		queue.request("a", true);
		queue.leave("a");
		expect(queue.stateOf("a")).toBe("active");
		queue.loaded("a");
		expect(queue.stateOf("a")).toBe("done");
	});

	it("never restarts a load in flight: no total timeout, only real errors retry", () => {
		const { clock, queue, starts } = setup({ stallTimeoutMs: 0 });
		queue.request("big", true);
		clock.advance(10 * 60_000); // slow multi-MB download
		expect(starts).toEqual([["big", 1]]);
		expect(queue.stateOf("big")).toBe("active");
		queue.loaded("big");
		expect(queue.stateOf("big")).toBe("done");
		expect(clock.timerCount).toBe(0);
	});

	it("retries after an error with backoff, then reports the final failure", () => {
		const { clock, queue, starts, failures } = setup();
		queue.request("x", true);
		queue.failed("x");
		expect(queue.stateOf("x")).toBe("backoff");
		clock.advance(999);
		expect(starts).toEqual([["x", 1]]);
		clock.advance(1);
		expect(starts).toEqual([["x", 1], ["x", 2]]);
		queue.failed("x");
		clock.advance(1000);
		queue.failed("x");
		expect(starts.map(([, attempt]) => attempt)).toEqual([1, 2, 3]);
		expect(failures).toEqual(["x"]);
		expect(queue.stateOf("x")).toBe("failed");
		clock.advance(10_000);
		expect(starts).toHaveLength(3);
	});

	it("a retry whose item left the zone waits until it comes back", () => {
		const { clock, queue, starts } = setup();
		queue.request("x", true);
		queue.failed("x");
		queue.leave("x");
		clock.advance(5000);
		expect(queue.stateOf("x")).toBe("waiting");
		expect(starts).toHaveLength(1);
		queue.request("x", false);
		expect(starts).toEqual([["x", 1], ["x", 2]]);
	});

	it("stall timeout counts from the start, frees the slot once and never restarts", () => {
		const { clock, queue, started } = setup({ maxConcurrent: 1, stallTimeoutMs: 60_000 });
		queue.request("slow", true);
		queue.request("next", true);
		// Time spent queued doesn't count for "next".
		clock.advance(59_999);
		expect(started()).toEqual(["slow"]);
		clock.advance(1);
		expect(queue.stateOf("slow")).toBe("stalled");
		expect(started()).toEqual(["slow", "next"]);
		expect(queue.stateOf("next")).toBe("active");
		clock.advance(5 * 60_000);
		expect(started()).toEqual(["slow", "next"]); // no restart loop
		// The stalled download finishing late still counts, without freeing a
		// slot it no longer holds.
		queue.loaded("slow");
		expect(queue.stateOf("slow")).toBe("done");
		expect(queue.activeCount).toBe(0);
	});

	it("a stalled load that errors goes through the normal retry path", () => {
		const { clock, queue, starts } = setup({ maxConcurrent: 1, stallTimeoutMs: 1000, backoffMs: () => 10 });
		queue.request("s", true);
		clock.advance(1000);
		expect(queue.stateOf("s")).toBe("stalled");
		queue.failed("s");
		clock.advance(10);
		expect(starts).toEqual([["s", 1], ["s", 2]]);
		expect(queue.activeCount).toBe(1);
	});

	it("cancel forgets the item: timers stop and late events are ignored", () => {
		const { clock, queue, starts, failures } = setup();
		queue.request("a", true);
		queue.failed("a");
		queue.cancel("a");
		expect(clock.timerCount).toBe(0);
		clock.advance(10_000);
		expect(starts).toHaveLength(1);
		queue.failed("a");
		queue.loaded("a");
		expect(failures).toEqual([]);
		expect(queue.stateOf("a")).toBeUndefined();

		queue.request("b", true);
		queue.cancel("b");
		expect(queue.activeCount).toBe(0);
		expect(clock.timerCount).toBe(0); // stall timer cleared too
	});

	it("cancelAll and destroy clear everything; destroy ignores new requests", () => {
		const { clock, queue, starts } = setup();
		for (const item of ["a", "b", "c"]) queue.request(item, true);
		queue.failed("a");
		queue.cancelAll();
		expect(queue.activeCount).toBe(0);
		expect(queue.queuedCount).toBe(0);
		expect(clock.timerCount).toBe(0);
		queue.destroy();
		queue.request("d", true);
		expect(starts.map(([item]) => item)).toEqual(["a", "b", "c"]);
	});

	it("shouldStart = false drops the item (detached tile) and fills the slot with the next", () => {
		const detached = new Set(["gone"]);
		const { queue, started } = setup({ maxConcurrent: 1 }, (item) => !detached.has(item));
		queue.request("a", true);
		queue.request("gone", true);
		queue.request("b", true);
		queue.loaded("a");
		expect(started()).toEqual(["a", "b"]);
		expect(queue.stateOf("gone")).toBeUndefined();
	});

	it("tolerates loaded() called synchronously from start()", () => {
		const clock = new FakeClock();
		const started: string[] = [];
		const queue: ImageLoadQueue<string> = new ImageLoadQueue<string>(
			{ start: (item) => { started.push(item); queue.loaded(item); } },
			{ maxConcurrent: 1, timers: clock }
		);
		queue.request("a", true);
		queue.request("b", true);
		expect(started).toEqual(["a", "b"]);
		expect(queue.activeCount).toBe(0);
		expect(clock.timerCount).toBe(0);
	});
});

describe("isTiffKey", () => {
	it("matches .tif/.tiff keys only", () => {
		expect(isTiffKey("a/b/photo.TIF")).toBe(true);
		expect(isTiffKey("scan.tiff")).toBe(true);
		expect(isTiffKey("scan.tiff?x=1")).toBe(true);
		expect(isTiffKey("photo.jpg")).toBe(false);
		expect(isTiffKey("tiff/photo.png")).toBe(false);
	});
});
