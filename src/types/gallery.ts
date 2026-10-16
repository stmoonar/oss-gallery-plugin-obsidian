import { IOssProvider, OssImage } from "./oss";

export interface ImagePreviewOptions {
	onNavigate?: (direction: "prev" | "next") => void;
}

export interface SyncChanges {
	hasChanges: boolean;
	added: OssImage[];
	deleted: string[];
	modified: OssImage[];
}

/** A ranked semantic result; re-applied to every new listing (docs §7.6). */
export type SemanticResultState =
	| { kind: "semantic"; query: string; hits: { key: string; score: number }[] }
	| { kind: "similar"; key: string; hits: { key: string; score: number }[] };

export interface GalleryState {
	remoteObjects: OssImage[];
	visibleImages: OssImage[];
	isSearching: boolean;
	savedSearchTerm: string;
	useRegexSearch: boolean;
	/** The search box is in semantic mode (per view session). */
	useSemanticSearch: boolean;
	/** Shown semantic / "find similar" result, ranked (null = normal list or text search). */
	semanticResult: SemanticResultState | null;
	/** Key of the image shown in the preview modal (keys survive deletes, indexes do not). */
	currentPreviewKey: string | null;
	isLoading: boolean;
}

/** Bytes of a local gallery thumbnail (src/thumbnails). */
export interface LocalThumbnail {
	bytes: Uint8Array<ArrayBuffer>;
	mime: string;
}

/**
 * Where a gallery tile gets its image from (src/thumbnails/ThumbnailService).
 * Without a source the tile loads its URL through <img> as it always did.
 */
export interface TileSource {
	/** The cached thumbnail (null = none or stale). Tried first. Never rejects. */
	readThumbnail?: () => Promise<LocalThumbnail | null>;
	/**
	 * Load the original once as bytes (requestUrl / local disk) instead of
	 * <img src>: shown from a Blob URL and handed to `thumbnailFrom`. A
	 * rejection makes the tile fall back to its URL through <img> once.
	 */
	loadOriginal?: (signal: AbortSignal) => Promise<ArrayBuffer>;
	/**
	 * Make and store a thumbnail from the original's bytes; the tile then
	 * shows it instead (null = keep the original). Never rejects.
	 */
	thumbnailFrom?: (bytes: ArrayBuffer) => Promise<LocalThumbnail | null>;
}

/** Tile source per listed object, for one gallery listing scope. */
export type TileSourceFactory = (obj: OssImage) => TileSource;

export interface LazyImageOptions {
	/** Prefetch margin around the scroll container (default 300px). */
	rootMargin?: string;
	/** Visibility threshold for the visible-first priority. */
	threshold?: number;
	/** Attempts in total; retries only follow a real load error. */
	retryCount?: number;
	/**
	 * Stall timeout in ms, counted from when a load gets a slot. A stalled
	 * load gives its slot up but is never aborted or restarted.
	 */
	timeout?: number;
	/** Concurrent loads (default 6). */
	maxConcurrent?: number;
	/** Concurrent cached thumbnail reads (disk, separate from the network limit; default 4). */
	maxConcurrentLocal?: number;
	onImageLoaded?: (img: HTMLImageElement, url: string) => void;
}

export interface ServiceDependencies {
	provider: IOssProvider;
	/** Directory to scope listings to (the global base path), '' for all. */
	listPrefix?: string;
}
