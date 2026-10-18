/**
 * How many semantic / "find similar" results the gallery shows first as the
 * "best matches"; the rest come in pages through "Show more". Pure and unit
 * tested (tests/gallery/semanticCutoff.test.ts).
 *
 * Scores are dot products of normalized EmbeddingGemma vectors (cosine
 * similarity, SemanticSearchService). Their absolute level says little:
 * unrelated text–image pairs still score about 0.5 (self-test), image–image
 * pairs ("find similar") sit much higher, and the level moves with the image
 * detail setting. A fixed threshold would therefore be wrong for one of them,
 * so the rule only looks at the shape of the sorted list:
 *
 * 1. Background: the median score. Almost every image in a gallery is
 *    unrelated to any one query, so the median is what "unrelated" scores.
 * 2. Window: keep the scores in the upper half between that background and
 *    the top score, `s >= top - 0.5 * (top - median)`: images that stand
 *    clearly out of the background, however high or low it lies.
 * 3. Bounds: at least MIN_BEST_MATCHES (a strict query still shows a useful
 *    first screen), at most MAX_BEST_MATCHES (a vague query does not dump
 *    the whole gallery), never more than there are hits.
 * 4. Natural break: within those bounds, if one gap between neighbours is
 *    much larger than the average step over the kept range (at least
 *    GAP_FACTOR times, and at least MIN_GAP_SHARE of `top - median`), the
 *    list is cut at the largest such gap.
 *
 * Lists of MIN_BEST_MATCHES or fewer are shown whole; a list without any
 * spread (every score equal) shows MIN_BEST_MATCHES.
 */

export const MIN_BEST_MATCHES = 12;
export const MAX_BEST_MATCHES = 60;
/** Images revealed by each "Show more". */
export const SHOW_MORE_PAGE = 60;

/** Keep scores within this share of the distance from the median to the top. */
const WINDOW_SHARE = 0.5;
/** A break must be this many times the average step of the kept range... */
const GAP_FACTOR = 3;
/** ...and at least this share of `top - median` (ignores noise in flat lists). */
const MIN_GAP_SHARE = 0.05;

/**
 * Number of best matches among `scores` (sorted descending, as the search
 * returns them).
 */
export function bestMatchCount(scores: readonly number[]): number {
	const n = scores.length;
	if (n <= MIN_BEST_MATCHES) {
		return n;
	}
	const top = scores[0] ?? 0;
	const median = scores[Math.floor(n / 2)] ?? top;
	const spread = top - median;
	if (!(spread > 0)) {
		return MIN_BEST_MATCHES;
	}

	const threshold = top - WINDOW_SHARE * spread;
	let inWindow = 0;
	while (inWindow < n && (scores[inWindow] ?? -Infinity) >= threshold) {
		inWindow++;
	}
	const upper = Math.min(n, Math.max(MIN_BEST_MATCHES, Math.min(MAX_BEST_MATCHES, inWindow)));

	// Largest gap between neighbours inside [MIN_BEST_MATCHES, upper): a cut
	// at `count` keeps scores[0 .. count - 1].
	const last = scores[upper - 1] ?? top;
	const averageStep = (top - last) / Math.max(1, upper - 1);
	let cut = upper;
	let bestGap = 0;
	for (let count = MIN_BEST_MATCHES; count < upper; count++) {
		const gap = (scores[count - 1] ?? 0) - (scores[count] ?? 0);
		if (gap > bestGap) {
			bestGap = gap;
			cut = count;
		}
	}
	if (bestGap > 0 && bestGap >= GAP_FACTOR * averageStep && bestGap >= MIN_GAP_SHARE * spread) {
		return cut;
	}
	return upper;
}

/** How many results to show after one more "Show more" (in similarity order). */
export function revealMore(shown: number, total: number, page = SHOW_MORE_PAGE): number {
	return Math.min(total, Math.max(0, shown) + Math.max(1, page));
}
