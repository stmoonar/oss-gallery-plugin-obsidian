/**
 * Index status texts for the gallery chip, the status bar and the details
 * dialog (docs/semantic-search.md §9.2, §12). Pure: templates come from the
 * locale, so the formatting is unit-tested without Obsidian.
 */

/** Thousands separators regardless of the UI language ("1,234"). */
export function formatCount(n: number): string {
	return Math.max(0, Math.round(n)).toLocaleString("en-US");
}

export interface SummaryCounts {
	indexed: number;
	converted: number;
	unsupported: number;
	failed: number;
	pending: number;
}

/** Templates with a `{count}` placeholder. */
export interface SummaryTemplates {
	indexed: string;
	converted: string;
	unsupported: string;
	failed: string;
	pending: string;
	separator: string;
}

/**
 * "1,234 indexed · 3 converted · 2 unsupported": the indexed count always,
 * the other parts only when non-zero.
 */
export function formatIndexSummary(counts: SummaryCounts, tpl: SummaryTemplates): string {
	const part = (template: string, n: number) => template.replace("{count}", formatCount(n));
	const parts = [part(tpl.indexed, counts.indexed)];
	if (counts.converted > 0) parts.push(part(tpl.converted, counts.converted));
	if (counts.unsupported > 0) parts.push(part(tpl.unsupported, counts.unsupported));
	if (counts.failed > 0) parts.push(part(tpl.failed, counts.failed));
	if (counts.pending > 0) parts.push(part(tpl.pending, counts.pending));
	return parts.join(tpl.separator);
}

/** "12 / 340" with separators. */
export function formatProgressCount(done: number, total: number): string {
	return `${formatCount(done)} / ${formatCount(Math.max(done, total))}`;
}

/** 0–100, for a progress bar. */
export function progressPercent(done: number, total: number): number {
	if (total <= 0) {
		return 0;
	}
	return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

/** Last path segment of an object key ("2025/10/cat.png" → "cat.png"). */
export function fileNameOf(key: string): string {
	const trimmed = key.replace(/\/+$/, "");
	const slash = trimmed.lastIndexOf("/");
	return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Templates for the on-disk index size; `{size}`, `{scope}` and `{vault}` are sizes. */
export interface IndexSizeTemplates {
	/** Only the current provider's index exists: "{size} on disk". */
	single: string;
	/** Other providers of the vault have indexes too: "{scope} on disk; {vault} for this vault". */
	split: string;
	/** No index for the current provider, others exist: "{vault} on disk for other providers". */
	othersOnly: string;
}

/**
 * Index size line for the settings tab and the details dialog: the current
 * scope's size, and the vault total when other scopes add to it. '' when
 * this vault has no index files at all.
 */
export function formatIndexSize(
	size: { total: number; byScope: Readonly<Record<string, number>> },
	scopeId: string | null,
	tpl: IndexSizeTemplates,
	formatSize: (bytes: number) => string
): string {
	const scopeBytes = scopeId !== null ? size.byScope[scopeId] : undefined;
	if (scopeBytes === undefined) {
		return size.total > 0 ? tpl.othersOnly.replace("{vault}", formatSize(size.total)) : "";
	}
	if (size.total <= scopeBytes) {
		return tpl.single.replace("{size}", formatSize(scopeBytes));
	}
	return tpl.split.replace("{scope}", formatSize(scopeBytes)).replace("{vault}", formatSize(size.total));
}
