/**
 * Per-vault directory names for the per-device files outside the vault
 * (semantic indexes, local thumbnails). Pure apart from Node path/crypto.
 */
import { createHash } from "crypto";
import * as path from "path";

/** Scope and vault ids are used as directory names. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Directory name for this vault. Obsidian's per-vault `app.appId` (not part
 * of the public API, so type-guarded) is stable across renames/moves; without
 * it, a hash of the vault's base path. Restricted to [A-Za-z0-9_-]{1,64}.
 */
export function vaultIdFor(appId: unknown, vaultBasePath: string): string {
	if (typeof appId === "string") {
		const cleaned = appId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
		if (cleaned !== "" && /[A-Za-z0-9]/.test(cleaned) && SAFE_ID.test(cleaned)) {
			return cleaned;
		}
	}
	const normalized = path.resolve(vaultBasePath).replace(/\\/g, "/").toLowerCase();
	return `v${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}
