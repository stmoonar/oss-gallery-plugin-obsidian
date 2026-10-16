/**
 * Obsidian glue for local gallery thumbnails (docs/semantic-search.md §13):
 * where they live (<appDir>/thumbs/<vaultId>/<scopeId>/), which scope a
 * provider's listing is (the provider's index identity, same scope ids as
 * the semantic index), how a tile loads an original as bytes (Local: disk;
 * remote: Obsidian requestUrl with the signed GET fallback), the gallery
 * hooks and the "Clear thumbnails" action. Works with semantic search off
 * or not installed; never imports src/semantic.
 */
import { App, FileSystemAdapter, Notice, requestUrl } from "obsidian";
import * as path from "path";
import { t } from "../i18n";
import { ClearThumbnailsModal } from "../modals/ClearThumbnailsModal";
import { LocalProvider } from "../providers/LocalProvider";
import type { OssProviderManager } from "../providers/OssProviderManager";
import { providerRegistry } from "../providers/registry";
import { fetchRemoteImageBytes, MAX_INDEX_IMAGE_BYTES } from "../services/remoteBytes";
import type { TileSourceFactory } from "../types/gallery";
import type { ListResult, OssImage } from "../types/oss";
import type { PluginSettings } from "../types/settings";
import { defaultAppDir } from "../utils/appDir";
import { computeScopeId } from "../utils/objectScope";
import { vaultIdFor } from "../utils/vaultId";
import { ThumbnailCache, ThumbnailStats } from "./ThumbnailCache";
import { ThumbnailClearResult, THUMBS_DIR_NAME, thumbsVaultDir } from "./thumbnailFiles";
import { ThumbnailGenerator } from "./ThumbnailGenerator";
import { OriginalLoader, ThumbnailService } from "./ThumbnailService";

/** First eviction after startup (never competes with opening the vault). */
const STARTUP_EVICT_DELAY_MS = 30_000;
/** Eviction after the cap was lowered (typing in the settings field). */
const SETTINGS_EVICT_DELAY_MS = 2_000;
const BYTES_PER_MB = 1_000_000;

/** What OssGalleryView uses. Calls never throw. */
export interface GalleryThumbnailHooks {
	/** Tile sources for this provider's listing, or null (thumbnails off / provider not listable). */
	tileSources(providerName: string, listPrefix: string): TileSourceFactory | null;
	/** After every successful listing; `startedAt` = when the listing request started. */
	onListing(providerName: string, listPrefix: string, listing: ListResult, startedAt: number): void;
	/** An object was deleted through the gallery. */
	onDeleted(providerName: string, listPrefix: string, key: string): void;
}

export interface GalleryThumbnailsHost {
	app: App;
	settings: PluginSettings;
	providerManager: OssProviderManager;
}

/** GIF keeps its animation, SVG renders natively, TIFF can't be decoded: no lazy thumbnail. */
function lazyThumbnailSkipped(key: string): boolean {
	return /\.(gif|svg|tiff?)$/i.test(key.split(/[?#]/)[0] ?? key);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class GalleryThumbnails {
	readonly service: ThumbnailService;
	readonly vaultId: string;
	private lastMaxSizeMB: number;

	constructor(private readonly host: GalleryThumbnailsHost) {
		const adapter = host.app.vault.adapter;
		const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : host.app.vault.getName();
		const appId = (host.app as unknown as { appId?: unknown }).appId;
		this.vaultId = vaultIdFor(appId, basePath);
		this.lastMaxSizeMB = host.settings.thumbnails.maxSizeMB;
		this.service = new ThumbnailService({
			cache: new ThumbnailCache(() => this.vaultDir()),
			generator: new ThumbnailGenerator(),
			isEnabled: () => host.settings.thumbnails.enabled,
			maxBytes: () => host.settings.thumbnails.maxSizeMB * BYTES_PER_MB,
		});
	}

	/** <appDir>/thumbs/<vaultId>, or null when it can't be determined. */
	vaultDir(): string | null {
		try {
			return thumbsVaultDir(path.join(defaultAppDir(), THUMBS_DIR_NAME), this.vaultId);
		} catch (error) {
			console.error("OSS Gallery: local thumbnail directory unavailable", error);
			return null;
		}
	}

	/** Startup: trim the cache to the cap once the vault has settled. */
	start(): void {
		this.service.scheduleEviction(STARTUP_EVICT_DELAY_MS);
	}

	onSettingsChanged(): void {
		const maxSizeMB = this.host.settings.thumbnails.maxSizeMB;
		if (maxSizeMB !== this.lastMaxSizeMB) {
			this.lastMaxSizeMB = maxSizeMB;
			this.service.scheduleEviction(SETTINGS_EVICT_DELAY_MS);
		}
	}

	/** Scope id of a provider's listing (same as the semantic index scope), or null. */
	scopeIdFor(providerId: string, listPrefix: string): string | null {
		const identity = providerRegistry.getIndexIdentity(
			providerId,
			this.host.settings.providers[providerId as keyof PluginSettings["providers"]],
			this.host.app
		);
		return identity ? computeScopeId(providerId, identity, listPrefix) : null;
	}

	/**
	 * How a tile loads its original as bytes, or null (<img src> as before):
	 * GIF/SVG/TIFF, objects above the size cap.
	 */
	private originalLoader(providerName: string, obj: OssImage): OriginalLoader | null {
		if (lazyThumbnailSkipped(obj.key) || obj.size > MAX_INDEX_IMAGE_BYTES) {
			return null;
		}
		const provider = this.host.providerManager.getProvider(providerName);
		if (!provider) {
			return null;
		}
		if (provider instanceof LocalProvider) {
			// Straight from disk, no network.
			return () => provider.readObjectBytes(obj.key);
		}
		const signer = provider.signedObjectGet?.bind(provider);
		if (!obj.url && !signer) {
			return null;
		}
		return (signal) => fetchRemoteImageBytes(obj, {
			request: (request) => requestUrl(request),
			signedGet: signer,
			signal,
		});
	}

	galleryHooks(): GalleryThumbnailHooks {
		return {
			tileSources: (providerName, listPrefix) => {
				try {
					if (!this.service.enabled) {
						return null;
					}
					const scopeId = this.scopeIdFor(providerName, listPrefix);
					if (!scopeId) {
						return null;
					}
					return (obj) => this.service.tileSource(scopeId, obj, this.originalLoader(providerName, obj)) ?? {};
				} catch (error) {
					console.error("OSS Gallery: local thumbnails unavailable", error);
					return null;
				}
			},
			onListing: (providerName, listPrefix, listing, startedAt) => {
				try {
					const scopeId = this.scopeIdFor(providerName, listPrefix);
					if (scopeId) {
						void this.service.onListing(scopeId, listing, startedAt);
					}
				} catch (error) {
					console.error("OSS Gallery: updating local thumbnails failed", error);
				}
			},
			onDeleted: (providerName, listPrefix, key) => {
				try {
					const scopeId = this.scopeIdFor(providerName, listPrefix);
					if (scopeId) {
						void this.service.onDeleted(scopeId, key);
					}
				} catch (error) {
					console.error("OSS Gallery: removing a local thumbnail failed", error);
				}
			},
		};
	}

	/** Count and size of this vault's thumbnails (settings). Never rejects. */
	stats(): Promise<ThumbnailStats> {
		return this.service.stats();
	}

	/**
	 * Ask, then delete this vault's local thumbnails. Never touches the
	 * semantic index or the model.
	 */
	confirmClear(onDone: () => void): void {
		const dir = this.vaultDir();
		if (!dir) {
			return;
		}
		new ClearThumbnailsModal(this.host.app, dir.replace(/\\/g, "/"), () => {
			void this.clear().then((result) => {
				if (result) {
					new Notice(result.failed.length > 0
						? `${t("Some thumbnails could not be deleted")}: ${result.failed.join(", ")}`
						: t("Local thumbnails cleared"));
				}
				onDone();
			});
		}).open();
	}

	/** Delete this vault's thumbnail files (only names the plugin writes). Never rejects. */
	async clear(): Promise<ThumbnailClearResult | null> {
		try {
			return await this.service.clear();
		} catch (error) {
			console.error("OSS Gallery: clearing local thumbnails failed", error);
			return { deleted: 0, failed: [errorMessage(error)], kept: 0 };
		}
	}

	dispose(): void {
		this.service.close();
	}
}
