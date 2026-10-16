/**
 * Object fingerprints and index scopes (docs/semantic-search.md §4.2, §4.6).
 * Pure: no Obsidian imports.
 */
import { createHash } from "crypto";
import type { OssImage } from "../types/oss";

/** etag (S3 ETag, Qiniu hash, GitHub blob sha) > size + lastModified (§7.5). */
export function fingerprint(o: OssImage): string {
	if (o.etag) {
		return `e:${o.etag}`;
	}
	return `s:${o.size}:${o.lastModified?.getTime() ?? 0}`;
}

/**
 * Fingerprint stored for an in-plugin upload, before any listing reported
 * the object's real etag/mtime. The next listing that shows the key with the
 * same size (or an unknown size, 0) adopts its real fingerprint without
 * re-embedding (SemanticIndexService.reconcile).
 */
export function uploadFingerprint(size: number): string {
	return `u:${size}`;
}

export function isUploadFingerprint(fp: string): boolean {
	return fp.startsWith("u:");
}

/** Does a listed object match a provisional upload fingerprint? */
export function matchesUploadFingerprint(fp: string, listed: OssImage): boolean {
	if (!isUploadFingerprint(fp)) {
		return false;
	}
	const size = Number(fp.slice(2));
	return listed.size === 0 || listed.size === size;
}

export interface IndexScope {
	/** Hash of provider id + identity + list prefix; the index directory name. */
	id: string;
	providerId: string;
	/** The gallery list prefix (global base path + '/', or ''). */
	listPrefix: string;
	/** Bytes come from disk (Local provider): no traffic, no confirmation. */
	local: boolean;
}

/** JSON with sorted object keys, so equal identities hash equally. */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const rec = value as Record<string, unknown>;
		return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** `sha256({ providerId, identity, listPrefix }).slice(0, 16)` (§4.6). */
export function computeScopeId(providerId: string, identity: object, listPrefix: string): string {
	const payload = stableStringify({ providerId, identity, listPrefix });
	return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

export function makeIndexScope(providerId: string, identity: object, listPrefix: string): IndexScope {
	return {
		id: computeScopeId(providerId, identity, listPrefix),
		providerId,
		listPrefix,
		local: providerId === "local",
	};
}
