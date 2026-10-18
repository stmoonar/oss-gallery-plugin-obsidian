/**
 * Sorting dropped / pasted / picked files into what gets uploaded and what
 * is left out, and grouping the left-out ones into one notice. No Obsidian
 * imports (unit tested).
 */

export interface FileTriage<F> {
	/** Files the active provider takes. */
	accepted: F[];
	/** Files the plugin handles in general, but not the active provider (e.g. video on Imgur). */
	rejectedByProvider: F[];
	/** Files of a type the plugin never uploads. */
	unsupported: F[];
}

export function triageFiles<F>(
	files: readonly F[],
	isSupported: (file: F) => boolean,
	isAcceptedByProvider: (file: F) => boolean
): FileTriage<F> {
	const result: FileTriage<F> = { accepted: [], rejectedByProvider: [], unsupported: [] };
	for (const file of files) {
		if (!isSupported(file)) {
			result.unsupported.push(file);
		} else if (isAcceptedByProvider(file)) {
			result.accepted.push(file);
		} else {
			result.rejectedByProvider.push(file);
		}
	}
	return result;
}

/**
 * - "drop": paste / drop in the editor. When nothing is uploaded the event is
 *   left to Obsidian, which inserts the files the usual way.
 * - "picker": the file upload command. Left-out files are simply not used.
 */
export type TriageSource = "drop" | "picker";

export type SkippedHeading =
	/** Some files are uploaded, the rest are left out. */
	| "partial"
	/** Nothing is uploaded; Obsidian handles the files itself. */
	| "native"
	/** Nothing is uploaded (file picker). */
	| "none";

export interface SkippedSummary {
	heading: SkippedHeading;
	rejectedNames: string[];
	unsupportedNames: string[];
}

/**
 * What to tell the user about left-out files, or null when nothing needs
 * saying. A paste/drop with nothing the plugin handles at all stays silent:
 * it is an ordinary Obsidian paste.
 */
export function summarizeSkipped<F extends { name: string }>(
	triage: FileTriage<F>,
	source: TriageSource
): SkippedSummary | null {
	const rejectedNames = triage.rejectedByProvider.map((file) => file.name);
	const unsupportedNames = triage.unsupported.map((file) => file.name);
	if (rejectedNames.length === 0 && unsupportedNames.length === 0) return null;

	if (triage.accepted.length > 0) {
		return { heading: "partial", rejectedNames, unsupportedNames };
	}
	if (source === "picker") {
		return { heading: "none", rejectedNames, unsupportedNames };
	}
	// Drop / paste without anything to upload: only worth a word when the
	// plugin would have taken some of it with another provider.
	if (rejectedNames.length === 0) return null;
	return { heading: "native", rejectedNames, unsupportedNames };
}

/**
 * Join at most `max` names; the rest is counted. `more` formats the tail,
 * e.g. (list, count) => `${list} and ${count} more`.
 */
export function formatNameList(
	names: readonly string[],
	separator: string,
	more: (list: string, count: number) => string,
	max = 3
): string {
	const shown = names.slice(0, max).join(separator);
	const rest = names.length - Math.min(names.length, max);
	return rest > 0 ? more(shown, rest) : shown;
}
