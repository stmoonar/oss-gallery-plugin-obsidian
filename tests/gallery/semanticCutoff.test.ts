import { describe, expect, it } from "vitest";
import {
	bestMatchCount,
	MAX_BEST_MATCHES,
	MIN_BEST_MATCHES,
	revealMore,
	SHOW_MORE_PAGE,
} from "../../src/components/semanticCutoff";

/** Deterministic pseudo-random numbers (no flaky tests). */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** Roughly normal background scores around `mean` (sum of uniforms). */
function background(count: number, mean: number, width: number, seed = 1): number[] {
	const r = rng(seed);
	return Array.from({ length: count }, () => mean + ((r() + r() + r() + r()) / 4 - 0.5) * width);
}

const desc = (xs: number[]) => [...xs].sort((a, b) => b - a);

describe("bestMatchCount", () => {
	it("shows short lists whole", () => {
		expect(bestMatchCount([])).toBe(0);
		expect(bestMatchCount([0.6])).toBe(1);
		expect(bestMatchCount(desc(background(MIN_BEST_MATCHES, 0.5, 0.1)))).toBe(MIN_BEST_MATCHES);
	});

	it("shows the minimum when every score is the same", () => {
		expect(bestMatchCount(new Array<number>(200).fill(0.5))).toBe(MIN_BEST_MATCHES);
	});

	it("never goes below the minimum or above the maximum", () => {
		for (let seed = 1; seed < 30; seed++) {
			const scores = desc(background(552, 0.5, 0.2, seed));
			const count = bestMatchCount(scores);
			expect(count).toBeGreaterThanOrEqual(MIN_BEST_MATCHES);
			expect(count).toBeLessThanOrEqual(MAX_BEST_MATCHES);
		}
	});

	it("keeps a clear group of strong matches and cuts at the break after it", () => {
		// 20 strong matches well above a background of 532 unrelated images.
		const strong = Array.from({ length: 20 }, (_, i) => 0.66 - i * 0.001);
		const scores = desc([...strong, ...background(532, 0.5, 0.06, 7)]);
		expect(bestMatchCount(scores)).toBe(20);
	});

	it("cuts a large group at the maximum", () => {
		const strong = Array.from({ length: 150 }, (_, i) => 0.7 - i * 0.0002);
		const scores = desc([...strong, ...background(400, 0.5, 0.05, 3)]);
		expect(bestMatchCount(scores)).toBe(MAX_BEST_MATCHES);
	});

	it("does not depend on the absolute score level (text vs. image similarity)", () => {
		const strong = Array.from({ length: 25 }, (_, i) => 0.66 - i * 0.001);
		const text = desc([...strong, ...background(500, 0.5, 0.06, 11)]);
		const shifted = text.map((s) => s + 0.3);
		expect(bestMatchCount(shifted)).toBe(bestMatchCount(text));
	});

	it("shows the top of a list without any standout as a small first page", () => {
		const scores = desc(background(552, 0.5, 0.1, 5));
		const count = bestMatchCount(scores);
		expect(count).toBeLessThan(552 / 4);
	});

	it("does not cut on noise inside a smooth decline", () => {
		// Linear decline: no gap stands out, so the window decides.
		const scores = Array.from({ length: 300 }, (_, i) => 0.8 - i * 0.001);
		// median 0.65, threshold 0.725 → 76 in the window, capped at 60.
		expect(bestMatchCount(scores)).toBe(MAX_BEST_MATCHES);
	});
});

describe("revealMore", () => {
	it("adds one page and stops at the total", () => {
		expect(revealMore(24, 552)).toBe(24 + SHOW_MORE_PAGE);
		expect(revealMore(540, 552)).toBe(552);
		expect(revealMore(10, 30, 5)).toBe(15);
		expect(revealMore(-3, 10, 0)).toBe(1);
	});
});
