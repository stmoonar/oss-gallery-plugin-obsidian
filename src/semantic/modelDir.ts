/**
 * Model directory resolution (docs/semantic-search.md §8.4).
 *
 * Files live outside the vault, shared by every vault on this machine, so
 * Obsidian Sync / iCloud never copy ~340 MB of weights.
 */
import * as os from "os";
import * as path from "path";

export const APP_DIR_NAME = "obsidian-oss-gallery";
export const MODELS_DIR_NAME = "models";
/** Per-device semantic indexes: <appDir>/indexes/<vaultId>/<scopeId>/ (§4.4). */
export const INDEXES_DIR_NAME = "indexes";

export interface PlatformEnv {
	platform: string;
	env: Record<string, string | undefined>;
	homedir: string;
}

function currentPlatform(): PlatformEnv {
	return { platform: process.platform, env: process.env, homedir: os.homedir() };
}

function pathFor(platform: string): typeof path.posix {
	return platform === "win32" ? path.win32 : path.posix;
}

/** Parent of the default model dir (`.../obsidian-oss-gallery`). */
export function defaultAppDir(p: PlatformEnv = currentPlatform()): string {
	const P = pathFor(p.platform);
	if (p.platform === "win32") {
		const localAppData = p.env.LOCALAPPDATA;
		const base = localAppData && P.isAbsolute(localAppData)
			? localAppData
			: P.join(p.homedir, "AppData", "Local");
		return P.join(base, APP_DIR_NAME);
	}
	if (p.platform === "darwin") {
		return P.join(p.homedir, "Library", "Application Support", APP_DIR_NAME);
	}
	// XDG: ignore relative values, as the spec requires.
	const xdg = p.env.XDG_CACHE_HOME;
	const base = xdg && P.isAbsolute(xdg) ? xdg : P.join(p.homedir, ".cache");
	return P.join(base, APP_DIR_NAME);
}

export function defaultModelDir(p: PlatformEnv = currentPlatform()): string {
	return pathFor(p.platform).join(defaultAppDir(p), MODELS_DIR_NAME);
}

export function defaultIndexDir(p: PlatformEnv = currentPlatform()): string {
	return pathFor(p.platform).join(defaultAppDir(p), INDEXES_DIR_NAME);
}

export type ResolvedModelDir =
	| { ok: true; dir: string; isDefault: boolean }
	| { ok: false; error: "relative-path" };

/**
 * `''` means the platform default. A leading `~` expands to the home
 * directory; anything else must be absolute (there is no sensible base for a
 * relative path, and it must not silently land inside the vault).
 */
export function resolveModelDir(
	configured: string,
	p: PlatformEnv = currentPlatform()
): ResolvedModelDir {
	return resolveConfiguredDir(configured, defaultModelDir(p), p);
}

/** Index directory setting; same rules as the model directory. */
export function resolveIndexDir(
	configured: string,
	p: PlatformEnv = currentPlatform()
): ResolvedModelDir {
	return resolveConfiguredDir(configured, defaultIndexDir(p), p);
}

function resolveConfiguredDir(configured: string, defaultDir: string, p: PlatformEnv): ResolvedModelDir {
	const P = pathFor(p.platform);
	const trimmed = configured.trim();
	if (trimmed === "") {
		return { ok: true, dir: defaultDir, isDefault: true };
	}
	let candidate = trimmed;
	if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
		candidate = P.join(p.homedir, candidate.slice(1));
	}
	if (!P.isAbsolute(candidate)) {
		return { ok: false, error: "relative-path" };
	}
	const dir = P.normalize(candidate);
	return { ok: true, dir, isDefault: dir === P.normalize(defaultDir) };
}
