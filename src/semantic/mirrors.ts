/**
 * Download mirrors for semantic search files (docs/semantic-search.md §8.6).
 *
 * Mirrors only change where bytes are fetched from. Every file is still
 * checked against the SHA-256 in assets.ts, and local paths never depend on
 * the mirror, so switching mirrors never invalidates installed files.
 *
 * Free of Obsidian imports so it can be exercised from plain Node.
 */

export const OFFICIAL_HF_ENDPOINT = "https://huggingface.co";

export interface MirrorSettings {
	/** Replaces `https://huggingface.co`; '' = official. */
	hfEndpoint: string;
	/** Prefix put before the full GitHub URL; '' = official. */
	githubMirror: string;
}

export type MirrorUrlError = "not-https" | "invalid";

export type NormalizedMirrorUrl =
	| { ok: true; value: string }
	| { ok: false; error: MirrorUrlError };

/**
 * `''` (after trimming) means "official". Otherwise the value must be an
 * absolute `https://` URL without credentials, query or fragment (the file
 * path is appended to it). Trailing slashes are removed.
 */
export function normalizeMirrorUrl(raw: string): NormalizedMirrorUrl {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { ok: true, value: "" };
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, error: "invalid" };
	}
	if (url.protocol === "http:") {
		return { ok: false, error: "not-https" };
	}
	if (url.protocol !== "https:" || url.hostname === "") {
		return { ok: false, error: "invalid" };
	}
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
		return { ok: false, error: "invalid" };
	}
	const pathname = url.pathname.replace(/\/+$/, "");
	return { ok: true, value: `${url.origin}${pathname}` };
}

/** Normalized value, or '' (official) when the value is not acceptable. */
export function mirrorOrOfficial(raw: string): string {
	const normalized = normalizeMirrorUrl(raw);
	return normalized.ok ? normalized.value : "";
}

/**
 * `https://huggingface.co/<path>` or `<hfEndpoint>/<path>`.
 * `path` is `<repo>/resolve/<revision>/<file>`, which hf-mirror.com and other
 * Hugging Face mirrors serve under the same layout.
 */
export function buildHfUrl(path: string, hfEndpoint: string): string {
	const base = mirrorOrOfficial(hfEndpoint) || OFFICIAL_HF_ENDPOINT;
	return `${base}/${path}`;
}

/**
 * Official GitHub URL, or `<githubMirror>/<official URL>` ("proxy prefix"
 * style, e.g. `https://gh-proxy.com/https://github.com/...`).
 */
export function buildGithubUrl(officialUrl: string, githubMirror: string): string {
	const prefix = mirrorOrOfficial(githubMirror);
	return prefix ? `${prefix}/${officialUrl}` : officialUrl;
}

/** Distinct hosts of the URLs, in first-seen order. */
export function sourceHosts(urls: readonly string[]): string[] {
	const hosts: string[] = [];
	for (const url of urls) {
		let host: string;
		try {
			host = new URL(url).host;
		} catch {
			continue;
		}
		if (!hosts.includes(host)) {
			hosts.push(host);
		}
	}
	return hosts;
}
