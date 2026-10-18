/**
 * Small gallery rules (empty states, focus after delete, delete summaries),
 * kept free of DOM and Obsidian imports so they are unit-tested.
 */

/** Which empty-state message the gallery shows when nothing is rendered. */
export type EmptyStateKind =
	/** The listing itself is empty (bucket / base path). */
	| "empty-listing"
	/** A text search matched nothing. */
	| "no-text-match"
	/** A semantic / similar result is empty. */
	| "no-semantic-match";

export function emptyStateKind(state: {
	listed: number;
	searching: boolean;
	semantic: boolean;
}): EmptyStateKind {
	if (state.semantic) return "no-semantic-match";
	if (state.listed === 0) return "empty-listing";
	return state.searching ? "no-text-match" : "empty-listing";
}

/**
 * Key that should get focus after `removed` keys left `order` (the order
 * before removal): the first remaining key after the first removed one,
 * else the closest remaining key before it; null when nothing remains.
 */
export function nextFocusAfterRemoval(order: readonly string[], removed: ReadonlySet<string>): string | null {
	const first = order.findIndex((k) => removed.has(k));
	if (first < 0) return null;
	for (let i = first + 1; i < order.length; i++) {
		const key = order[i];
		if (key !== undefined && !removed.has(key)) return key;
	}
	for (let i = first - 1; i >= 0; i--) {
		const key = order[i];
		if (key !== undefined && !removed.has(key)) return key;
	}
	return null;
}

/** Names listed in a batch confirmation: the first `max`, plus how many more. */
export function previewNames(names: readonly string[], max = 5): { shown: string[]; more: number } {
	const shown = names.slice(0, Math.max(0, max));
	return { shown, more: Math.max(0, names.length - shown.length) };
}

/** Outcome of a batch delete, for the notice. */
export type BatchDeleteSummary =
	| { kind: "all"; deleted: number }
	| { kind: "partial"; deleted: number; failed: number }
	| { kind: "none"; failed: number };

export function summarizeBatchDelete(deleted: number, failed: number): BatchDeleteSummary {
	if (failed === 0) return { kind: "all", deleted };
	if (deleted === 0) return { kind: "none", failed };
	return { kind: "partial", deleted, failed };
}
