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
