/**
 * Search box modes of the gallery (docs/semantic-search.md §9.1), kept free of
 * DOM and Obsidian imports so the rules are unit-tested:
 * - text search (optionally regex) over keys/URLs, as before;
 * - semantic search (natural-language query, ranked by the index);
 * - "find similar" (ranked by an image's stored vector).
 * Semantic and regex are mutually exclusive; semantic can only be switched on
 * while the feature is available for the current provider.
 */

/** Why the semantic toggle is disabled (shown as its tooltip). */
export type SemanticUnavailableReason =
	| "checking"
	| "not-installed"
	| "webgpu"
	| "disabled"
	| "no-list"
	| "no-index";

export type SemanticAvailability =
	| { ok: true; /** Indexing runs: results may be incomplete. */ indexing: boolean }
	| { ok: false; reason: SemanticUnavailableReason };

export interface SearchModeState {
	semantic: boolean;
	regex: boolean;
}

export const INITIAL_SEARCH_MODE: SearchModeState = { semantic: false, regex: false };

/** Click on the semantic toggle. Turning it on turns regex off. */
export function toggleSemantic(state: SearchModeState, availability: SemanticAvailability): SearchModeState {
	if (state.semantic) {
		return { ...state, semantic: false };
	}
	if (!availability.ok) {
		return state;
	}
	return { semantic: true, regex: false };
}

/** Click on the regex toggle: ignored (disabled) in semantic mode. */
export function toggleRegex(state: SearchModeState): SearchModeState {
	if (state.semantic) {
		return state;
	}
	return { ...state, regex: !state.regex };
}

/** The feature became unavailable (index cleared, model deleted...): leave semantic mode. */
export function applyAvailability(state: SearchModeState, availability: SemanticAvailability): SearchModeState {
	return state.semantic && !availability.ok ? { ...state, semantic: false } : state;
}

export type GalleryQuery =
	| { kind: "all" }
	| { kind: "text"; term: string; regex: boolean }
	| { kind: "semantic"; query: string }
	| { kind: "similar"; key: string };

/** What pressing Enter with `text` in the box means in this mode. */
export function queryFor(state: SearchModeState, text: string): GalleryQuery {
	const trimmed = text.trim();
	if (trimmed === "") {
		return { kind: "all" };
	}
	return state.semantic
		? { kind: "semantic", query: trimmed }
		: { kind: "text", term: text, regex: state.regex };
}

/**
 * Re-apply cached semantic hits to a fresh listing (§7.6): keep the hit
 * order, drop keys that are no longer listed, and use the listed objects
 * (their URLs may have changed).
 */
export function intersectHits<T extends { key: string }>(
	listed: readonly T[],
	hits: readonly { key: string; score: number }[]
): { object: T; score: number }[] {
	const byKey = new Map(listed.map((o) => [o.key, o]));
	const out: { object: T; score: number }[] = [];
	for (const hit of hits) {
		const object = byKey.get(hit.key);
		if (object) {
			out.push({ object, score: hit.score });
		}
	}
	return out;
}

/**
 * Does the gallery show the semantic index strip and feed listings to the
 * index? Only while the feature is actually usable on this device
 * (installed, enabled, WebGPU, listable provider); a missing index still
 * shows the strip ("Build index"). `enabled` syncs between devices, so it
 * alone says nothing about this device.
 */
export function semanticBarVisible(availability: SemanticAvailability): boolean {
	return availability.ok || availability.reason === "no-index";
}

/**
 * Must a running index stop? Yes when the feature was turned off or the
 * model files are gone / being replaced. Transient checks (startup
 * presence check, "Verify files") keep it running.
 */
export function shouldStopIndexing(enabled: boolean, installKind: string): boolean {
	if (!enabled) {
		return true;
	}
	return !(installKind === "installed" || installKind === "checking" || installKind === "verifying");
}

/**
 * A text result was ranked against `rankedKeys` (the listing at query
 * time). When a newer listing holds keys that were not ranked (the query
 * was typed while the first listing loaded, or images were added), the
 * query must run again; dropped keys are handled by `intersectHits`.
 */
export function needsSemanticRerank(
	rankedKeys: ReadonlySet<string>,
	listed: readonly { key: string }[]
): boolean {
	return listed.some((o) => !rankedKeys.has(o.key));
}
