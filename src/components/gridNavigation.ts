/**
 * Keyboard navigation in the gallery grid (roving tabindex), kept free of
 * DOM and Obsidian imports so the index math is unit-tested.
 */

/** Keys the grid handles for moving focus. */
export type GridNavKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

export function isGridNavKey(key: string): key is GridNavKey {
	return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp"
		|| key === "ArrowDown" || key === "Home" || key === "End";
}

/**
 * Columns of a wrapped grid from the top offsets of its items in order:
 * the number of leading items on the first row (at least 1).
 */
export function columnsFromTops(tops: readonly number[]): number {
	if (tops.length === 0) return 1;
	const first = tops[0] ?? 0;
	let columns = 0;
	for (const top of tops) {
		// Sub-pixel layout: items of one row may differ by a fraction of a pixel.
		if (Math.abs(top - first) > 1) break;
		columns++;
	}
	return Math.max(1, columns);
}

/**
 * Index focus moves to from `index` in a grid of `count` items laid out in
 * `columns` columns; null = stay (edge reached or nothing to move to).
 * ArrowDown from a full row above a shorter last row goes to the last item.
 */
export function navigateGrid(index: number, key: GridNavKey, count: number, columns: number): number | null {
	if (count <= 0) return null;
	const cols = Math.max(1, Math.floor(columns));
	const current = Math.min(Math.max(0, index), count - 1);
	let next: number;
	switch (key) {
		case "ArrowLeft":
			next = current - 1;
			break;
		case "ArrowRight":
			next = current + 1;
			break;
		case "ArrowUp":
			next = current - cols;
			break;
		case "ArrowDown": {
			next = current + cols;
			const lastRow = Math.floor((count - 1) / cols);
			if (next >= count && Math.floor(current / cols) < lastRow) {
				next = count - 1;
			}
			break;
		}
		case "Home":
			next = 0;
			break;
		case "End":
			next = count - 1;
			break;
	}
	if (next < 0 || next >= count || next === current) return null;
	return next;
}
