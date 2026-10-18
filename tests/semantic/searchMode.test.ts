import { describe, expect, it } from "vitest";
import {
	applyAvailability,
	INITIAL_SEARCH_MODE,
	intersectHits,
	queryFor,
	SemanticAvailability,
	toggleRegex,
	toggleSemantic,
} from "../../src/components/searchMode";

const OK: SemanticAvailability = { ok: true, indexing: false };
const NO_INDEX: SemanticAvailability = { ok: false, reason: "no-index" };

describe("search box modes (§9.1)", () => {
	it("semantic and regex are mutually exclusive", () => {
		const regex = toggleRegex(INITIAL_SEARCH_MODE);
		expect(regex).toEqual({ semantic: false, regex: true });
		const semantic = toggleSemantic(regex, OK);
		expect(semantic).toEqual({ semantic: true, regex: false });
		// Regex is disabled in semantic mode.
		expect(toggleRegex(semantic)).toBe(semantic);
		expect(toggleSemantic(semantic, OK)).toEqual({ semantic: false, regex: false });
	});

	it("semantic mode can't be switched on while unavailable, but can always be switched off", () => {
		expect(toggleSemantic(INITIAL_SEARCH_MODE, NO_INDEX)).toBe(INITIAL_SEARCH_MODE);
		expect(toggleSemantic({ semantic: true, regex: false }, NO_INDEX)).toEqual({ semantic: false, regex: false });
	});

	it("losing availability leaves semantic mode; other states are untouched", () => {
		expect(applyAvailability({ semantic: true, regex: false }, { ok: false, reason: "disabled" }))
			.toEqual({ semantic: false, regex: false });
		const regex = { semantic: false, regex: true };
		expect(applyAvailability(regex, NO_INDEX)).toBe(regex);
		const semantic = { semantic: true, regex: false };
		expect(applyAvailability(semantic, { ok: true, indexing: true })).toBe(semantic);
	});

	it("Enter: empty → all images, semantic mode → query, otherwise text/regex", () => {
		expect(queryFor({ semantic: true, regex: false }, "   ")).toEqual({ kind: "all" });
		expect(queryFor({ semantic: true, regex: false }, "  a red car ")).toEqual({ kind: "semantic", query: "a red car" });
		expect(queryFor({ semantic: false, regex: true }, "^img")).toEqual({ kind: "text", term: "^img", regex: true });
		expect(queryFor(INITIAL_SEARCH_MODE, "cat")).toEqual({ kind: "text", term: "cat", regex: false });
	});

	it("cached hits keep their order, drop unlisted keys and use the listed objects", () => {
		const listed = [{ key: "a", url: "new-a" }, { key: "b", url: "new-b" }, { key: "c", url: "new-c" }];
		const hits = [{ key: "c", score: 0.9 }, { key: "gone", score: 0.8 }, { key: "a", score: 0.5 }];
		expect(intersectHits(listed, hits)).toEqual([
			{ object: { key: "c", url: "new-c" }, score: 0.9 },
			{ object: { key: "a", url: "new-a" }, score: 0.5 },
		]);
	});
});
