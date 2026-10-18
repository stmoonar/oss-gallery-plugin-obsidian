/**
 * Where semantic indexes live (docs/semantic-search.md §4.4, §5):
 *
 *   <indexDir>/<vaultId>/<scopeId>/{meta.json, vectors.bin, status.json}
 *
 * indexDir is per device and outside the vault (default
 * <appDir>/indexes, next to the models), so indexes are never synced: each
 * device builds its own. Local gallery thumbnails live elsewhere
 * (<appDir>/thumbs, src/thumbnails). Pure apart from Node fs/path.
 */
import * as nodeFs from "fs";
import * as path from "path";
import { SAFE_ID } from "../utils/vaultId";

export { vaultIdFor } from "../utils/vaultId";

/** Files this plugin writes into a scope directory. Nothing else is ever deleted. */
export const INDEX_FILE_NAMES: ReadonlySet<string> = new Set([
	"meta.json",
	"meta.json.tmp",
	"vectors.bin",
	"vectors.bin.tmp",
	"status.json",
	"status.json.tmp",
]);
const ASYNC_TMP = /^meta\.json\.a\d+\.tmp$/;

export function isIndexFileName(name: string): boolean {
	return INDEX_FILE_NAMES.has(name) || ASYNC_TMP.test(name);
}

/** The fs calls used by clearVaultIndex (Node's fs satisfies it). */
export interface ClearFs {
	existsSync(p: string): boolean;
	lstatSync(p: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
	readdirSync(p: string): string[];
	unlinkSync(p: string): void;
	rmdirSync(p: string): void;
}

export interface ClearResult {
	deleted: number;
	/** Files/directories that could not be removed (relative to the vault dir). */
	failed: string[];
	/** Other files left alone (not written by this plugin). */
	kept: number;
}

/**
 * "Clear index for this vault": delete only the index files this plugin
 * writes (INDEX_FILE_NAMES) in <indexDir>/<vaultId>/<scopeId>/, then remove
 * directories that became empty, the vault directory included. Symlinks,
 * unknown files and directories whose names are not scope ids are left
 * alone; the index root itself and other vaults' folders are never touched.
 */
export function clearVaultIndex(indexRoot: string, vaultId: string, fs: ClearFs = nodeFs): ClearResult {
	if (!SAFE_ID.test(vaultId)) {
		throw new Error(`Invalid vault id: ${vaultId}`);
	}
	const vaultDir = path.join(indexRoot, vaultId);
	const result: ClearResult = { deleted: 0, failed: [], kept: 0 };
	if (!fs.existsSync(vaultDir)) {
		return result;
	}
	const vaultStat = fs.lstatSync(vaultDir);
	if (vaultStat.isSymbolicLink() || !vaultStat.isDirectory()) {
		result.kept++;
		return result;
	}
	for (const scopeName of fs.readdirSync(vaultDir)) {
		const scopeDir = path.join(vaultDir, scopeName);
		let st;
		try {
			st = fs.lstatSync(scopeDir);
		} catch {
			continue;
		}
		if (!SAFE_ID.test(scopeName) || st.isSymbolicLink() || !st.isDirectory()) {
			result.kept++;
			continue;
		}
		for (const name of fs.readdirSync(scopeDir)) {
			const file = path.join(scopeDir, name);
			let fst;
			try {
				fst = fs.lstatSync(file);
			} catch {
				continue;
			}
			if (!isIndexFileName(name) || !fst.isFile()) {
				result.kept++;
				continue;
			}
			try {
				fs.unlinkSync(file);
				result.deleted++;
			} catch {
				result.failed.push(`${scopeName}/${name}`);
			}
		}
		removeIfEmpty(fs, scopeDir, result, scopeName);
	}
	removeIfEmpty(fs, vaultDir, result, ".");
	return result;
}

/** The fs calls used by vaultIndexSize (Node's fs satisfies it). */
export interface SizeFs {
	existsSync(p: string): boolean;
	lstatSync(p: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number };
	readdirSync(p: string): string[];
}

export interface VaultIndexSize {
	/** Bytes of all index files of this vault (every scope). */
	total: number;
	/** Bytes per scope id (only scopes with index files). */
	byScope: Record<string, number>;
}

/**
 * On-disk size of this vault's semantic indexes: the same files "Clear
 * index for this vault" would delete (INDEX_FILE_NAMES in scope-id
 * directories under <indexDir>/<vaultId>/, regular files only, no
 * symlinks), so the number shown is exactly what clearing frees.
 */
export function vaultIndexSize(indexRoot: string, vaultId: string, fs: SizeFs = nodeFs): VaultIndexSize {
	if (!SAFE_ID.test(vaultId)) {
		throw new Error(`Invalid vault id: ${vaultId}`);
	}
	const result: VaultIndexSize = { total: 0, byScope: {} };
	const vaultDir = path.join(indexRoot, vaultId);
	if (!fs.existsSync(vaultDir)) {
		return result;
	}
	const vaultStat = fs.lstatSync(vaultDir);
	if (vaultStat.isSymbolicLink() || !vaultStat.isDirectory()) {
		return result;
	}
	for (const scopeName of fs.readdirSync(vaultDir)) {
		if (!SAFE_ID.test(scopeName)) {
			continue;
		}
		const scopeDir = path.join(vaultDir, scopeName);
		let names: string[];
		try {
			const st = fs.lstatSync(scopeDir);
			if (st.isSymbolicLink() || !st.isDirectory()) {
				continue;
			}
			names = fs.readdirSync(scopeDir);
		} catch {
			continue;
		}
		let bytes = 0;
		let files = 0;
		for (const name of names) {
			if (!isIndexFileName(name)) {
				continue;
			}
			try {
				const fst = fs.lstatSync(path.join(scopeDir, name));
				if (fst.isFile()) {
					bytes += fst.size;
					files++;
				}
			} catch {
				// Removed meanwhile (e.g. a temp file renamed into place).
			}
		}
		if (files > 0) {
			result.byScope[scopeName] = bytes;
			result.total += bytes;
		}
	}
	return result;
}

function removeIfEmpty(fs: ClearFs, dir: string, result: ClearResult, label: string): void {
	try {
		if (fs.readdirSync(dir).length === 0) {
			fs.rmdirSync(dir);
		}
	} catch {
		result.failed.push(label);
	}
}
