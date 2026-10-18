/**
 * On-disk layout of the local thumbnail cache (docs/semantic-search.md §13):
 *
 *   <appDir>/thumbs/<vaultId>/<scopeId>/thumbs.json
 *   <appDir>/thumbs/<vaultId>/<scopeId>/<sha256(key)[:32]>-<sha256(fp)[:12]>.webp|.jpg
 *
 * Per device, outside the vault and independent of the semantic index
 * directory. Only names isThumbnailFileName accepts are ever deleted. Pure
 * apart from Node fs/path/crypto (tests inject fs). Never imports src/semantic.
 */
import { createHash } from "crypto";
import * as nodeFs from "fs";
import * as path from "path";
import type { OssImage } from "../types/oss";
import { fingerprint, matchesUploadFingerprint } from "../utils/objectScope";
import { SAFE_ID } from "../utils/vaultId";
import type { ThumbnailMime } from "./encode";

/** <appDir>/thumbs */
export const THUMBS_DIR_NAME = "thumbs";
export const THUMBS_MANIFEST = "thumbs.json";
export const MANIFEST_TMP = `${THUMBS_MANIFEST}.tmp`;

export const THUMB_FILE = /^[0-9a-f]{32}-[0-9a-f]{12}\.(webp|jpg)$/;
export const THUMB_TMP = /^[0-9a-f]{32}-[0-9a-f]{12}\.(webp|jpg)\.tmp$/;

export type ThumbnailExt = "webp" | "jpg";

/** Names this module writes into a scope's thumbnail directory (and nothing else is deleted). */
export function isThumbnailFileName(name: string): boolean {
	return THUMB_FILE.test(name) || THUMB_TMP.test(name) || name === THUMBS_MANIFEST || name === MANIFEST_TMP;
}

export function extForMime(mime: ThumbnailMime): ThumbnailExt {
	return mime === "image/webp" ? "webp" : "jpg";
}

export function mimeForExt(ext: ThumbnailExt): ThumbnailMime {
	return ext === "webp" ? "image/webp" : "image/jpeg";
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** File name of the thumbnail of `key` at fingerprint `fp`. */
export function thumbnailFileName(key: string, fp: string, ext: ThumbnailExt): string {
	return `${sha256Hex(key).slice(0, 32)}-${sha256Hex(fp).slice(0, 12)}.${ext}`;
}

/** <thumbsRoot>/<vaultId> (thumbsRoot = <appDir>/thumbs). */
export function thumbsVaultDir(thumbsRoot: string, vaultId: string): string {
	if (!SAFE_ID.test(vaultId)) {
		throw new Error(`Invalid vault id: ${vaultId}`);
	}
	return path.join(thumbsRoot, vaultId);
}

/** Can a thumbnail made at `entryFp` stand in for the listed object `obj`? */
export function thumbnailMatches(entryFp: string, obj: OssImage): boolean {
	return entryFp === fingerprint(obj) || matchesUploadFingerprint(entryFp, obj);
}

/** Async fs subset (Node's fs.promises + a few sync calls for close()). */
export interface ThumbFs {
	readFile(p: string): Promise<Uint8Array>;
	writeFile(p: string, data: Uint8Array | string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(p: string): Promise<void>;
	mkdir(p: string, options: { recursive: true }): Promise<unknown>;
	readdir(p: string): Promise<string[]>;
	lstat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
	rmdir(p: string): Promise<void>;
	/** close(): the manifest is written synchronously on unload. */
	mkdirSync(p: string, options: { recursive: true }): unknown;
	writeFileSync(p: string, data: string): void;
	renameSync(from: string, to: string): void;
}

export const nodeThumbFs: ThumbFs = {
	readFile: (p) => nodeFs.promises.readFile(p),
	writeFile: (p, data) => nodeFs.promises.writeFile(p, data),
	rename: (a, b) => nodeFs.promises.rename(a, b),
	unlink: (p) => nodeFs.promises.unlink(p),
	mkdir: (p, o) => nodeFs.promises.mkdir(p, o),
	readdir: (p) => nodeFs.promises.readdir(p),
	lstat: (p) => nodeFs.promises.lstat(p),
	rmdir: (p) => nodeFs.promises.rmdir(p),
	mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
	writeFileSync: (p, data) => nodeFs.writeFileSync(p, data),
	renameSync: (a, b) => nodeFs.renameSync(a, b),
};

export interface ThumbnailClearResult {
	deleted: number;
	/** Paths (relative to the vault's thumbs dir) that could not be removed. */
	failed: string[];
	/** Other files / directories left alone (not written by this plugin). */
	kept: number;
}

/**
 * Delete thumbnail files under `vaultDir` (= <appDir>/thumbs/<vaultId>):
 * only names isThumbnailFileName accepts, inside directories named like a
 * scope id; symlinks and unknown files/directories are left alone. Empty
 * scope directories and then the vault directory are removed (the thumbs
 * root itself never). Never touches models, indexes or other vaults.
 */
export async function clearThumbnailDir(vaultDir: string, fs: ThumbFs = nodeThumbFs): Promise<ThumbnailClearResult> {
	const result: ThumbnailClearResult = { deleted: 0, failed: [], kept: 0 };
	let rootStat;
	try {
		rootStat = await fs.lstat(vaultDir);
	} catch {
		return result;
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		result.kept++;
		return result;
	}
	for (const scopeName of await fs.readdir(vaultDir)) {
		const scopeDir = path.join(vaultDir, scopeName);
		let st;
		try {
			st = await fs.lstat(scopeDir);
		} catch {
			continue;
		}
		if (!SAFE_ID.test(scopeName) || st.isSymbolicLink() || !st.isDirectory()) {
			result.kept++;
			continue;
		}
		for (const name of await fs.readdir(scopeDir)) {
			const file = path.join(scopeDir, name);
			let fst;
			try {
				fst = await fs.lstat(file);
			} catch {
				continue;
			}
			if (!isThumbnailFileName(name) || !fst.isFile()) {
				result.kept++;
				continue;
			}
			try {
				await fs.unlink(file);
				result.deleted++;
			} catch {
				result.failed.push(`${scopeName}/${name}`);
			}
		}
		await removeIfEmpty(fs, scopeDir, result, scopeName);
	}
	await removeIfEmpty(fs, vaultDir, result, ".");
	return result;
}

async function removeIfEmpty(fs: ThumbFs, dir: string, result: ThumbnailClearResult, label: string): Promise<void> {
	try {
		if ((await fs.readdir(dir)).length === 0) {
			await fs.rmdir(dir);
		}
	} catch {
		result.failed.push(label);
	}
}
