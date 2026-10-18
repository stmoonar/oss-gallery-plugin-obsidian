/**
 * The plugin's per-device directory outside the vault (models, indexes,
 * local thumbnails), so Obsidian Sync / iCloud never copy them. Pure apart
 * from Node os/path.
 */
import * as os from "os";
import * as path from "path";

export const APP_DIR_NAME = "obsidian-oss-gallery";

export interface PlatformEnv {
	platform: string;
	env: Record<string, string | undefined>;
	homedir: string;
}

export function currentPlatform(): PlatformEnv {
	return { platform: process.platform, env: process.env, homedir: os.homedir() };
}

export function pathFor(platform: string): typeof path.posix {
	return platform === "win32" ? path.win32 : path.posix;
}

/** `.../obsidian-oss-gallery` (parent of the default model and index dirs). */
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
