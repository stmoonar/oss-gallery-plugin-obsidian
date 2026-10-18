import { describe, expect, it } from "vitest";
import { columnsFromTops, isGridNavKey, navigateGrid } from "../../src/components/gridNavigation";
import {
	clickAction,
	EMPTY_SELECTION,
	orderedSelection,
	retainKeys,
	selectAll,
	selectRange,
	toggleKey,
} from "../../src/components/tileSelection";
import {
	emptyStateKind,
	nextFocusAfterRemoval,
	previewNames,
	summarizeBatchDelete,
} from "../../src/components/galleryUx";

describe("grid keyboard navigation", () => {
	it("counts the columns of the first row", () => {
		expect(columnsFromTops([])).toBe(1);
		expect(columnsFromTops([10])).toBe(1);
		expect(columnsFromTops([10, 10.4, 10, 120, 120])).toBe(3);
		expect(columnsFromTops([10, 10, 10, 10])).toBe(4);
	});

	it("moves left / right within bounds", () => {
		expect(navigateGrid(0, "ArrowLeft", 10, 3)).toBeNull();
		expect(navigateGrid(0, "ArrowRight", 10, 3)).toBe(1);
		expect(navigateGrid(9, "ArrowRight", 10, 3)).toBeNull();
		// Left/right wrap across rows (reading order).
		expect(navigateGrid(3, "ArrowLeft", 10, 3)).toBe(2);
	});

	it("moves up / down by the column count", () => {
		expect(navigateGrid(4, "ArrowUp", 10, 3)).toBe(1);
		expect(navigateGrid(1, "ArrowUp", 10, 3)).toBeNull();
		expect(navigateGrid(1, "ArrowDown", 10, 3)).toBe(4);
		// 10 items, 3 columns: rows 0-2, 3-5, 6-8, 9. From 8 down: no item 11 → last.
		expect(navigateGrid(8, "ArrowDown", 10, 3)).toBe(9);
		expect(navigateGrid(9, "ArrowDown", 10, 3)).toBeNull();
	});

	it("Home / End go to the ends", () => {
		expect(navigateGrid(5, "Home", 10, 3)).toBe(0);
		expect(navigateGrid(5, "End", 10, 3)).toBe(9);
		expect(navigateGrid(0, "Home", 10, 3)).toBeNull();
		expect(navigateGrid(0, "End", 0, 3)).toBeNull();
	});

	it("tolerates odd inputs", () => {
		expect(navigateGrid(99, "ArrowLeft", 10, 3)).toBe(8);
		expect(navigateGrid(0, "ArrowDown", 10, 0)).toBe(1);
		expect(isGridNavKey("ArrowUp")).toBe(true);
		expect(isGridNavKey("Enter")).toBe(false);
	});
});

describe("tile selection", () => {
	const order = ["a", "b", "c", "d", "e"];

	it("click actions", () => {
		expect(clickAction({ toggle: false, shift: false }, false)).toBe("open");
		expect(clickAction({ toggle: false, shift: false }, true)).toBe("toggle");
		expect(clickAction({ toggle: true, shift: false }, false)).toBe("toggle");
		expect(clickAction({ toggle: false, shift: true }, false)).toBe("range");
		expect(clickAction({ toggle: true, shift: true }, true)).toBe("range-add");
	});

	it("toggles keys and moves the anchor", () => {
		let s = toggleKey(EMPTY_SELECTION, "b");
		expect([...s.keys]).toEqual(["b"]);
		expect(s.anchor).toBe("b");
		s = toggleKey(s, "b");
		expect(s.keys.size).toBe(0);
		expect(EMPTY_SELECTION.keys.size).toBe(0);
	});

	it("selects ranges from the anchor in both directions", () => {
		const s = toggleKey(EMPTY_SELECTION, "b");
		expect(orderedSelection(selectRange(s, order, "d", false), order)).toEqual(["b", "c", "d"]);
		const back = selectRange(toggleKey(EMPTY_SELECTION, "d"), order, "a", false);
		expect(orderedSelection(back, order)).toEqual(["a", "b", "c", "d"]);
		expect(back.anchor).toBe("d");
	});

	it("replaces or adds the range", () => {
		let s = toggleKey(EMPTY_SELECTION, "e");
		s = toggleKey(s, "a");
		expect(orderedSelection(selectRange(s, order, "b", false), order)).toEqual(["a", "b"]);
		expect(orderedSelection(selectRange(s, order, "b", true), order)).toEqual(["a", "b", "e"]);
	});

	it("without an anchor selects the target only", () => {
		const s = selectRange(EMPTY_SELECTION, order, "c", false);
		expect([...s.keys]).toEqual(["c"]);
		expect(s.anchor).toBe("c");
		expect(selectRange(s, order, "zzz", false)).toBe(s);
	});

	it("select all and retain shown keys", () => {
		const all = selectAll(order);
		expect(all.keys.size).toBe(5);
		const kept = retainKeys(all, ["b", "c"]);
		expect(orderedSelection(kept, order)).toEqual(["b", "c"]);
		expect(kept.anchor).toBeNull();
		expect(retainKeys(kept, ["b", "c", "x"])).toBe(kept);
		expect(retainKeys(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION);
	});
});

describe("gallery empty states and deletes", () => {
	it("picks the empty-state message", () => {
		expect(emptyStateKind({ listed: 0, searching: false, semantic: false })).toBe("empty-listing");
		expect(emptyStateKind({ listed: 0, searching: true, semantic: false })).toBe("empty-listing");
		expect(emptyStateKind({ listed: 5, searching: true, semantic: false })).toBe("no-text-match");
		expect(emptyStateKind({ listed: 5, searching: true, semantic: true })).toBe("no-semantic-match");
	});

	it("focus goes to the next remaining tile, else the previous", () => {
		const order = ["a", "b", "c", "d"];
		expect(nextFocusAfterRemoval(order, new Set(["b"]))).toBe("c");
		expect(nextFocusAfterRemoval(order, new Set(["b", "c"]))).toBe("d");
		expect(nextFocusAfterRemoval(order, new Set(["d"]))).toBe("c");
		expect(nextFocusAfterRemoval(order, new Set(["c", "d"]))).toBe("b");
		expect(nextFocusAfterRemoval(order, new Set(order))).toBeNull();
		expect(nextFocusAfterRemoval(order, new Set(["x"]))).toBeNull();
	});

	it("lists the first names of a batch", () => {
		expect(previewNames(["a", "b"], 5)).toEqual({ shown: ["a", "b"], more: 0 });
		expect(previewNames(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b"], more: 1 });
	});

	it("summarizes batch deletes", () => {
		expect(summarizeBatchDelete(3, 0)).toEqual({ kind: "all", deleted: 3 });
		expect(summarizeBatchDelete(2, 1)).toEqual({ kind: "partial", deleted: 2, failed: 1 });
		expect(summarizeBatchDelete(0, 2)).toEqual({ kind: "none", failed: 2 });
	});
});
