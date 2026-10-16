/**
 * Local gallery thumbnails, independent of semantic search (docs/semantic-search.md
 * §13): the cache (ThumbnailCache), lazy generation from originals the
 * gallery downloads anyway (ThumbnailGenerator), the size cap (LRU) and
 * the lifecycle hooks the gallery calls (listing, delete).
 *
 * Semantic indexing may add thumbnails through `put` (the worker makes them
 * from the bitmap it decodes for the embedding); this module never imports
 * src/semantic. Pure apart from what the cache uses (Node fs): no Obsidian
 * imports, so it is unit tested; GalleryThumbnails.ts is the Obsidian glue.
 */
import type { LocalThumbnail, TileSource } from "../types/gallery";
import type { ListResult, OssImage } from "../types/oss";
import { fingerprint } from "../utils/objectScope";
import type { Timers } from "../utils/timers";
import type { EncodedThumbnail } from "./encode";
import type { ThumbnailCache, ThumbnailStats, ThumbnailWriter } from "./ThumbnailCache";
import type { ThumbnailClearResult } from "./thumbnailFiles";
import type { ThumbnailGenerator } from "./ThumbnailGenerator";

/** Eviction runs this long after the last write (writes come in bursts while scrolling). */
export const EVICT_AFTER_WRITE_MS = 5_000;

export interface ThumbnailServiceDeps {
	cache: ThumbnailCache;
	generator: ThumbnailGenerator;
	/** Setting `thumbnails.enabled`: off = no new thumbnails and no cache reads. */
	isEnabled(): boolean;
	/** Setting `thumbnails.maxSizeMB` in bytes (all scopes of the vault). */
	maxBytes(): number;
	timers?: Timers;
}

/** Loads an original as bytes for a tile (null = the tile uses <img src>). */
export type OriginalLoader = (signal: AbortSignal) => Promise<ArrayBuffer>;

function toLocal(thumbnail: EncodedThumbnail): LocalThumbnail {
	return { bytes: new Uint8Array(thumbnail.bytes), mime: thumbnail.mime };
}

export class ThumbnailService implements ThumbnailWriter {
	private evictTimer: number | null = null;
	private closed = false;

	constructor(private readonly deps: ThumbnailServiceDeps) {}

	get enabled(): boolean {
		return !this.closed && this.deps.isEnabled();
	}

	/**
	 * Store a thumbnail made elsewhere (semantic indexing). Ignored while
	 * thumbnails are off. Never rejects.
	 */
	put(scopeId: string, key: string, fp: string, thumbnail: EncodedThumbnail | null): Promise<void> {
		if (!this.enabled) {
			return Promise.resolve();
		}
		const done = this.deps.cache.put(scopeId, key, fp, thumbnail);
		if (thumbnail) {
			this.scheduleEviction();
		}
		return done;
	}

	/**
	 * How a tile of `obj` gets its image: the cached thumbnail first; then,
	 * with `loadOriginal`, the original as bytes (one download serves the
	 * display and the new thumbnail). Null while thumbnails are off: the
	 * tile loads its URL exactly as before.
	 */
	tileSource(scopeId: string, obj: OssImage, loadOriginal: OriginalLoader | null): TileSource | null {
		if (!this.enabled) {
			return null;
		}
		const source: TileSource = {
			readThumbnail: () => this.deps.cache.read(scopeId, obj),
		};
		if (loadOriginal) {
			source.loadOriginal = loadOriginal;
			source.thumbnailFrom = (bytes) => this.thumbnailFrom(scopeId, obj, bytes);
		}
		return source;
	}

	/** Lazy generation from an original's bytes; stored under the listed fingerprint. Never rejects. */
	async thumbnailFrom(scopeId: string, obj: OssImage, bytes: ArrayBuffer): Promise<LocalThumbnail | null> {
		try {
			if (!this.enabled) {
				return null;
			}
			const thumbnail = await this.deps.generator.generate(bytes, obj.key);
			if (!thumbnail || !this.enabled) {
				return null;
			}
			await this.put(scopeId, obj.key, fingerprint(obj), thumbnail);
			return toLocal(thumbnail);
		} catch (error) {
			console.warn("OSS Gallery: local thumbnail failed", error);
			return null;
		}
	}

	/**
	 * A gallery listing of `scopeId` (started at `startedAt`): upload
	 * thumbnails adopt the listed fingerprint; a complete listing deletes
	 * thumbnails of unlisted keys under its prefix. Runs with thumbnails
	 * off too (cleanup only). Never rejects.
	 */
	onListing(scopeId: string, listing: ListResult, startedAt: number): Promise<void> {
		if (this.closed) {
			return Promise.resolve();
		}
		return this.deps.cache.reconcile(
			scopeId,
			listing.items,
			listing.complete ? { prefix: listing.prefix, since: startedAt } : null
		);
	}

	/** The object was deleted through the gallery. Never rejects. */
	onDeleted(scopeId: string, key: string): Promise<void> {
		if (this.closed) {
			return Promise.resolve();
		}
		return this.deps.cache.remove(scopeId, key);
	}

	/** Trim the cache to the cap after `delayMs` (debounced). Never blocks rendering. */
	scheduleEviction(delayMs = EVICT_AFTER_WRITE_MS): void {
		if (this.closed) {
			return;
		}
		const timers = this.timers();
		if (this.evictTimer !== null) {
			timers.clearTimeout(this.evictTimer);
		}
		this.evictTimer = timers.setTimeout(() => {
			this.evictTimer = null;
			void this.evictNow();
		}, delayMs);
	}

	/** Trim the cache to the cap now. Never rejects. */
	async evictNow(): Promise<void> {
		if (this.closed) {
			return;
		}
		await this.deps.cache.enforceCap(this.deps.maxBytes());
	}

	stats(): Promise<ThumbnailStats> {
		return this.deps.cache.stats();
	}

	/** "Clear thumbnails" (never the semantic index or the model). */
	clear(): Promise<ThumbnailClearResult | null> {
		return this.deps.cache.clear();
	}

	flush(): Promise<void> {
		return this.deps.cache.flush();
	}

	/** Unload: pending manifests are written synchronously. */
	close(): void {
		this.closed = true;
		if (this.evictTimer !== null) {
			this.timers().clearTimeout(this.evictTimer);
			this.evictTimer = null;
		}
		this.deps.generator.dispose();
		this.deps.cache.close();
	}

	private timers(): Timers {
		return this.deps.timers ?? {
			setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
			clearTimeout: (id: number) => window.clearTimeout(id),
		};
	}
}
