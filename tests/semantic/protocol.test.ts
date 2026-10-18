import { describe, expect, it } from "vitest";
import {
	decodePixelCap,
	decodeSize,
	dot,
	isWorkerResponse,
	l2norm,
	maxBatchFor,
	planBatches,
	truncateAndNormalize,
} from "../../src/semantic/protocol";

describe("truncateAndNormalize", () => {
	it("truncates to dims and L2-normalizes", () => {
		const src = [3, 4, 100, -7];
		const out = truncateAndNormalize(src, 2);
		expect(out).toBeInstanceOf(Float32Array);
		expect(out).toHaveLength(2);
		expect(out[0]).toBeCloseTo(0.6, 6);
		expect(out[1]).toBeCloseTo(0.8, 6);
		expect(l2norm(out)).toBeCloseTo(1, 6);
	});

	it("keeps the prefix direction (proportional to the source prefix)", () => {
		const src = Array.from({ length: 768 }, (_, i) => Math.sin(i + 1) * (i % 7));
		const out = truncateAndNormalize(src, 256);
		expect(out).toHaveLength(256);
		expect(l2norm(out)).toBeCloseTo(1, 5);
		const ratio = out[1] / src[1];
		for (let i = 0; i < 256; i++) {
			expect(out[i]).toBeCloseTo(src[i] * ratio, 5);
		}
		expect(ratio).toBeGreaterThan(0);
	});

	it("keeps a zero vector zero", () => {
		const out = truncateAndNormalize(new Float32Array(10), 4);
		expect(Array.from(out)).toEqual([0, 0, 0, 0]);
	});

	it("accepts an exact-length source and throws for a too-short one", () => {
		expect(truncateAndNormalize([1, 0, 0], 3)).toHaveLength(3);
		expect(() => truncateAndNormalize([1, 2], 3)).toThrow(/2 dims, expected at least 3/);
	});
});

describe("dot / l2norm", () => {
	it("computes dot products over the shorter length", () => {
		expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
		expect(dot([1, 2, 3], [4, 5])).toBe(14);
		expect(dot([], [1])).toBe(0);
	});

	it("computes the L2 norm", () => {
		expect(l2norm([3, 4])).toBe(5);
		expect(l2norm(new Float32Array(3))).toBe(0);
	});
});

describe("planBatches", () => {
	it("splits into consecutive batches of at most maxBatch", () => {
		expect(planBatches(10, 8)).toEqual([[0, 8], [8, 10]]);
		expect(planBatches(8, 8)).toEqual([[0, 8]]);
		expect(planBatches(3, 1)).toEqual([[0, 1], [1, 2], [2, 3]]);
		expect(planBatches(0, 4)).toEqual([]);
	});

	it("treats invalid batch sizes as 1 and floors fractions", () => {
		expect(planBatches(2, 0)).toEqual([[0, 1], [1, 2]]);
		expect(planBatches(2, -3)).toEqual([[0, 1], [1, 2]]);
		expect(planBatches(5, 2.9)).toEqual([[0, 2], [2, 4], [4, 5]]);
	});
});

describe("maxBatchFor", () => {
	it("maps token budgets to batch sizes", () => {
		expect(maxBatchFor(70)).toBe(8);
		expect(maxBatchFor(140)).toBe(4);
		expect(maxBatchFor(280)).toBe(1);
		expect(maxBatchFor(100)).toBe(1);
		expect(maxBatchFor(0)).toBe(1);
	});
});

describe("decodePixelCap / decodeSize", () => {
	it("is 4x the processor pixel target with a one-megapixel floor", () => {
		expect(decodePixelCap(70)).toBe(1_000_000);
		expect(decodePixelCap(140)).toBe(140 * 9 * 256 * 4);
		expect(decodePixelCap(280)).toBe(280 * 9 * 256 * 4);
	});

	it("returns null when the image is within the cap or degenerate", () => {
		expect(decodeSize(1000, 1000, 1_000_000)).toBeNull();
		expect(decodeSize(640, 480, 1_000_000)).toBeNull();
		expect(decodeSize(0, 5000, 1_000_000)).toBeNull();
		expect(decodeSize(5000, -1, 1_000_000)).toBeNull();
	});

	it("downscales preserving aspect ratio with area <= cap", () => {
		for (const [w, h] of [[6000, 4000], [4000, 6000], [10000, 200], [1001, 1000]]) {
			const cap = 1_000_000;
			const size = decodeSize(w, h, cap);
			expect(size).not.toBeNull();
			if (!size) {
				continue;
			}
			expect(size.width * size.height).toBeLessThanOrEqual(cap);
			expect(size.width).toBeLessThanOrEqual(w);
			expect(size.height).toBeLessThanOrEqual(h);
			// Aspect ratio within rounding (one pixel on either side).
			expect(Math.abs(size.width / size.height - w / h)).toBeLessThan((w / h) * (2 / Math.min(size.width, size.height)) + 1e-9);
			// Not shrunk much more than needed.
			expect(size.width * size.height).toBeGreaterThan(cap * 0.98);
		}
		expect(decodeSize(6000, 4000, 1_000_000)).toEqual({ width: 1224, height: 816 });
	});

	it("never returns a zero dimension", () => {
		expect(decodeSize(1_000_000, 1, 100)).toEqual({ width: 10000, height: 1 });
	});
});

describe("isWorkerResponse", () => {
	it("accepts responses with a numeric id and boolean ok", () => {
		expect(isWorkerResponse({ id: 1, ok: true, result: 3 })).toBe(true);
		expect(isWorkerResponse({ id: 0, ok: false, error: { code: "internal", message: "x" } })).toBe(true);
	});

	it("rejects everything else", () => {
		expect(isWorkerResponse(null)).toBe(false);
		expect(isWorkerResponse(undefined)).toBe(false);
		expect(isWorkerResponse("x")).toBe(false);
		expect(isWorkerResponse(5)).toBe(false);
		expect(isWorkerResponse({ id: "1", ok: true })).toBe(false);
		expect(isWorkerResponse({ id: 1, ok: "yes" })).toBe(false);
		expect(isWorkerResponse({ id: 1 })).toBe(false);
		expect(isWorkerResponse({ ok: true })).toBe(false);
	});
});
