import { describe, expect, it } from "vitest";
import {
	intersectHits,
	needsSemanticRerank,
	SemanticAvailability,
	semanticBarVisible,
	shouldStopIndexing,
} from "../../src/components/searchMode";

describe("semantic bar visibility (availability, not just `enabled`)", () => {
	it("shows the strip when search works or only the index is missing", () => {
		expect(semanticBarVisible({ ok: true, indexing: false })).toBe(true);
		expect(semanticBarVisible({ ok: true, indexing: true })).toBe(true);
		expect(semanticBarVisible({ ok: false, reason: "no-index" })).toBe(true);
	});

	it("hides it on a device without the model / WebGPU, when off or not listable", () => {
		const hidden: SemanticAvailability[] = [
			{ ok: false, reason: "not-installed" },
			{ ok: false, reason: "webgpu" },
			{ ok: false, reason: "disabled" },
			{ ok: false, reason: "checking" },
			{ ok: false, reason: "no-list" },
		];
		for (const availability of hidden) {
			expect(semanticBarVisible(availability)).toBe(false);
		}
	});
});

describe("stopping a running index", () => {
	it("stops when the feature is turned off, whatever the install state", () => {
		expect(shouldStopIndexing(false, "installed")).toBe(true);
		expect(shouldStopIndexing(false, "checking")).toBe(true);
	});

	it("stops when the model is gone, broken, being replaced or WebGPU is missing", () => {
		for (const kind of ["not-installed", "incomplete", "needs-repair", "deleting", "downloading", "invalid-dir", "unsupported"]) {
			expect(shouldStopIndexing(true, kind)).toBe(true);
		}
	});

	it("keeps running through transient checks", () => {
		expect(shouldStopIndexing(true, "installed")).toBe(false);
		expect(shouldStopIndexing(true, "checking")).toBe(false);
		expect(shouldStopIndexing(true, "verifying")).toBe(false);
	});
});

describe("re-running a text query on a newer listing", () => {
	const listing = (...keys: string[]) => keys.map((key) => ({ key }));

	it("re-runs a query typed before the first listing arrived", () => {
		expect(needsSemanticRerank(new Set(), listing("a.png", "b.png"))).toBe(true);
	});

	it("re-runs when the listing gained images", () => {
		expect(needsSemanticRerank(new Set(["a.png"]), listing("a.png", "b.png"))).toBe(true);
	});

	it("keeps the cached ranking when nothing new was listed (deletes only intersect)", () => {
		const ranked = new Set(["a.png", "b.png"]);
		expect(needsSemanticRerank(ranked, listing("a.png", "b.png"))).toBe(false);
		expect(needsSemanticRerank(ranked, listing("b.png"))).toBe(false);
		expect(needsSemanticRerank(new Set(), [])).toBe(false);
	});

	it("never shows images outside the current listing", () => {
		const hits = [{ key: "gone.png", score: 0.9 }, { key: "a.png", score: 0.5 }];
		expect(intersectHits(listing("a.png"), hits).map((h) => h.object.key)).toEqual(["a.png"]);
	});
});
