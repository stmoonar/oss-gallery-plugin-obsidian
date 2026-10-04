/**
 * Helpers for the upload placeholder written into a note while a file is
 * uploading: `[<label>](#oss-upload-<timestamp>-<counter>)`.
 *
 * The placeholder text never changes during an upload; progress is shown by
 * the editor extension / reading-mode post processor, which render a widget in
 * place of the placeholder without touching the file.
 *
 * This module has no Obsidian imports so it can be sanity-tested in Node.
 */

export const UPLOAD_ID_PREFIX = "oss-upload-";

/** Matches any upload placeholder; capture group 1 is the upload id. */
const ANY_PLACEHOLDER_SOURCE = String.raw`\[[^\]\n]*\]\(#(oss-upload-[a-z0-9-]+)\)`;

export interface PlaceholderMatch {
	/** Absolute start offset of the placeholder. */
	from: number;
	/** Absolute end offset (exclusive) of the placeholder. */
	to: number;
	id: string;
}

export function createUploadId(counter: number): string {
	return `${UPLOAD_ID_PREFIX}${Date.now()}-${counter}`;
}

/** Matches the placeholder with the given id, whatever its current label. */
export function placeholderPattern(id: string, withTrailingNewline = false): RegExp {
	// Ids only contain [a-z0-9-], so they need no escaping.
	return new RegExp(`\\[[^\\]\\n]*\\]\\(#${id}\\)${withTrailingNewline ? "\\n?" : ""}`);
}

/**
 * Find every upload placeholder in `text`. `offset` is added to the returned
 * positions so callers can scan a slice of a larger document.
 */
export function findUploadPlaceholders(text: string, offset = 0): PlaceholderMatch[] {
	const matches: PlaceholderMatch[] = [];
	const pattern = new RegExp(ANY_PLACEHOLDER_SOURCE, "g");
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const id = match[1];
		if (id === undefined) continue;
		matches.push({
			from: offset + match.index,
			to: offset + match.index + match[0].length,
			id,
		});
	}
	return matches;
}

/** Extract the upload id from a link target such as `#oss-upload-1-2`. */
export function uploadIdFromHref(href: string | null): string | null {
	if (!href) return null;
	const id = href.startsWith("#") ? href.slice(1) : href;
	return /^oss-upload-[a-z0-9-]+$/.test(id) ? id : null;
}
