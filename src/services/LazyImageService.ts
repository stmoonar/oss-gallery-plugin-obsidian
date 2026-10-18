import { LazyImageOptions, LocalThumbnail, TileSource } from "../types/gallery";
import {
	DEFAULT_MAX_CONCURRENT,
	DEFAULT_STALL_TIMEOUT_MS,
	ImageLoadQueue,
} from "./imageLoadQueue";

/** Prefetch distance around the scroll viewport. */
const PREFETCH_ROOT_MARGIN = "300px";
/** Concurrent cached thumbnail reads (disk; not counted against the network limit). */
const DEFAULT_MAX_CONCURRENT_LOCAL = 4;
/** A local read holding its slot this long gives the slot up (it keeps running). */
const LOCAL_STALL_TIMEOUT_MS = 10_000;

/** A tracked image with a tile source (src/thumbnails). */
interface TileState {
	source: TileSource;
	/** Cached thumbnail: untried, being read, shown, or none. */
	local: "pending" | "reading" | "hit" | "miss";
	/** loadOriginal failed (or its bytes didn't display): the URL through <img> from now on. */
	direct: boolean;
	/** The running loadOriginal. */
	abort: AbortController | null;
}

/**
 * Lazy loading for gallery tiles (`<img data-src>`). Scheduling (bounded
 * concurrency, visible-first FIFO, retries, stall handling) lives in
 * `ImageLoadQueue`; this class only wires it to IntersectionObservers and
 * the `<img>` elements.
 *
 * Tiles observed with a TileSource (local thumbnails on):
 * 1. the cached thumbnail is read first through a second, small queue
 *    (disk, no network); a hit is shown from a Blob URL;
 * 2. otherwise, with `loadOriginal`, the original is loaded once as bytes
 *    (Obsidian requestUrl / local disk) in a slot of the network queue and
 *    shown from a Blob URL; the same bytes then become the thumbnail
 *    (`thumbnailFrom`, off the critical path) and the tile switches to it,
 *    which frees the original's memory;
 * 3. if loading the bytes fails or they don't display, the tile falls back
 *    once to its URL through <img> (hosts requestUrl can't reach, HTTP
 *    cache) and keeps the usual retries.
 * Without a source (thumbnails off) tiles load their URL through <img>
 * exactly as before. Blob URLs are revoked when the tile is released.
 */
export class LazyImageService {
	private readonly queue: ImageLoadQueue<HTMLImageElement>;
	/** Cached thumbnail reads (separate, small limit). */
	private readonly localQueue: ImageLoadQueue<HTMLImageElement>;
	/** Tracked images and their URLs ('' = no URL). */
	private readonly urls = new Map<HTMLImageElement, string>();
	/** Tracked images that have a tile source. */
	private readonly tiles = new Map<HTMLImageElement, TileState>();
	/** Blob URLs created for an image, revoked on release. */
	private readonly blobUrls = new Map<HTMLImageElement, Set<string>>();
	/** Images currently inside the (un-expanded) viewport. */
	private readonly visible = new Set<HTMLImageElement>();
	/** Images inside the prefetch zone. */
	private readonly nearZone = new Set<HTMLImageElement>();
	private nearObserver: IntersectionObserver | null = null;
	private visibleObserver: IntersectionObserver | null = null;
	private destroyed = false;
	private readonly rootMargin: string;
	private readonly threshold: number;
	private readonly onImageLoaded?: (img: HTMLImageElement, url: string) => void;
	private readonly onImageFailed?: (img: HTMLImageElement) => void;

	constructor(options: LazyImageOptions = {}) {
		this.rootMargin = options.rootMargin ?? PREFETCH_ROOT_MARGIN;
		this.threshold = options.threshold ?? 0;
		this.onImageLoaded = options.onImageLoaded;
		this.onImageFailed = options.onImageFailed;
		this.queue = new ImageLoadQueue<HTMLImageElement>(
			{
				start: (img, attempt) => this.startLoad(img, attempt),
				onFailed: (img) => this.showFailed(img),
				shouldStart: (img) => {
					if (img.isConnected && this.urls.has(img)) return true;
					this.release(img);
					return false;
				},
			},
			{
				maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
				maxAttempts: options.retryCount ?? 3,
				stallTimeoutMs: options.timeout ?? DEFAULT_STALL_TIMEOUT_MS,
				timers: {
					setTimeout: (fn, ms) => window.setTimeout(fn, ms),
					clearTimeout: (handle) => window.clearTimeout(handle as number),
				},
			}
		);
		this.localQueue = new ImageLoadQueue<HTMLImageElement>(
			{
				start: (img) => this.startLocal(img),
				onFailed: (img) => this.localMissed(img),
				shouldStart: (img) => {
					if (img.isConnected && this.tiles.has(img)) return true;
					this.release(img);
					return false;
				},
			},
			{
				maxConcurrent: options.maxConcurrentLocal ?? DEFAULT_MAX_CONCURRENT_LOCAL,
				maxAttempts: 1,
				stallTimeoutMs: LOCAL_STALL_TIMEOUT_MS,
				timers: {
					setTimeout: (fn, ms) => window.setTimeout(fn, ms),
					clearTimeout: (handle) => window.clearTimeout(handle as number),
				},
			}
		);
	}

	/** The original can still be loaded (its URL, or its bytes while not fallen back). */
	private canLoadOriginal(img: HTMLImageElement): boolean {
		if (this.urls.get(img)) return true;
		const tile = this.tiles.get(img);
		return !!tile && !tile.direct && !!tile.source.loadOriginal;
	}

	/** Route a load request: the cached thumbnail while untried, else the original. */
	private request(img: HTMLImageElement, visible: boolean): void {
		const tile = this.tiles.get(img);
		if (tile && (tile.local === "pending" || tile.local === "reading")) {
			this.localQueue.request(img, visible);
			return;
		}
		if (tile?.local === "hit" || !this.canLoadOriginal(img)) {
			return;
		}
		this.queue.request(img, visible);
	}

	/**
	 * Observers are created on first use: their root must be the scroll
	 * container (with the implicit viewport root, a scrolling ancestor clips
	 * the targets and the prefetch margin has no effect).
	 */
	private ensureObservers(img: HTMLImageElement): void {
		if (this.nearObserver) return;
		const root = findScrollParent(img);
		this.nearObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const target = entry.target as HTMLImageElement;
					if (!this.urls.has(target)) continue;
					if (entry.isIntersecting) {
						this.nearZone.add(target);
						this.request(target, this.visible.has(target));
					} else if (!target.isConnected) {
						this.release(target);
					} else {
						this.nearZone.delete(target);
						this.visible.delete(target);
						this.localQueue.leave(target);
						this.queue.leave(target);
					}
				}
			},
			{ root, rootMargin: this.rootMargin, threshold: 0 }
		);
		this.visibleObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const target = entry.target as HTMLImageElement;
					if (!this.urls.has(target)) continue;
					if (entry.isIntersecting) {
						this.visible.add(target);
						this.nearZone.add(target);
						this.request(target, true);
					} else {
						this.visible.delete(target);
						this.localQueue.setVisible(target, false);
						this.queue.setVisible(target, false);
					}
				}
			},
			{ root, rootMargin: "0px", threshold: this.threshold }
		);
	}

	/**
	 * 观察图片元素. With a `source` (local thumbnails), its cached thumbnail
	 * is tried first and its original is loaded as bytes; see the class doc.
	 */
	observe(img: HTMLImageElement, source?: TileSource): void {
		const url = img.dataset.src ?? "";
		if ((!url && !source) || this.destroyed) return;

		this.urls.set(img, url);
		this.tiles.get(img)?.abort?.abort();
		if (source) {
			this.tiles.set(img, {
				source,
				local: source.readThumbnail ? "pending" : "miss",
				direct: false,
				abort: null,
			});
		} else {
			this.tiles.delete(img);
		}

		// 延迟 observe 避免阻塞 UI。回调触发时必须重新检查状态：
		// destroy/unobserve 之后再 observe 会重新激活已 disconnect 的 observer。
		const deferredObserve = () => {
			if (this.destroyed || this.urls.get(img) !== url || !img.isConnected) {
				return;
			}
			this.ensureObservers(img);
			this.nearObserver?.observe(img);
			this.visibleObserver?.observe(img);
		};

		if (typeof window.requestIdleCallback === "function") {
			requestIdleCallback(deferredObserve, { timeout: 200 });
		} else {
			window.setTimeout(deferredObserve, 0);
		}
	}

	/**
	 * Stop tracking an image: a pending or running load is cancelled and
	 * the element's source is cleared (it is being discarded).
	 */
	unobserve(img: HTMLImageElement): void {
		this.release(img);
	}

	/**
	 * 批量观察图片元素
	 */
	observeAll(
		images: NodeListOf<HTMLImageElement> | HTMLImageElement[]
	): void {
		images.forEach((img) => this.observe(img));
	}

	/** A network slot was granted: the original as bytes, or through <img>. */
	private startLoad(img: HTMLImageElement, attempt: number): void {
		const tile = this.tiles.get(img);
		if (tile && !tile.direct && tile.source.loadOriginal) {
			this.startBytes(img, tile, attempt);
			return;
		}
		this.startDirect(img, attempt);
	}

	private startDirect(img: HTMLImageElement, attempt: number): void {
		const url = this.urls.get(img);
		if (!url) {
			this.queue.failed(img);
			return;
		}
		img.onload = () => {
			clearHandlers(img);
			if (!this.urls.has(img)) return;
			img.classList.add("oss-gallery-img-loaded");
			this.stopObserving(img);
			this.queue.loaded(img);
			this.onImageLoaded?.(img, url);
		};
		img.onerror = () => {
			clearHandlers(img);
			if (!this.urls.has(img)) return;
			if (!img.isConnected) {
				this.release(img);
				return;
			}
			this.queue.failed(img);
		};
		img.removeAttribute("data-src");
		// The service decides when to load; native lazy loading could hold
		// a slot without ever starting the request.
		img.loading = "eager";
		// A retry follows a finished (failed) request, so nothing in flight is
		// aborted here. Removing the attribute first makes the browser run a
		// fresh fetch even when the new value equals the old one; failed
		// images are not kept in the image cache, so no cache-busting needed
		// (it would also break signed URLs).
		if (attempt > 1 || img.getAttribute("src") === url) {
			img.removeAttribute("src");
		}
		img.src = url;
	}

	/** The tile's bytes path failed: its URL through <img> from now on (same slot). */
	private fallBackToUrl(img: HTMLImageElement, tile: TileState, attempt: number): void {
		tile.direct = true;
		this.startDirect(img, attempt);
	}

	/** Load the original once as bytes; shown from a Blob URL, then turned into the thumbnail. */
	private startBytes(img: HTMLImageElement, tile: TileState, attempt: number): void {
		const load = tile.source.loadOriginal;
		if (!load) return;
		const controller = new AbortController();
		tile.abort = controller;
		let work: Promise<ArrayBuffer>;
		try {
			work = load(controller.signal);
		} catch (error) {
			work = Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const current = () => this.tiles.get(img) === tile && tile.abort === controller;
		work.then(
			(bytes) => {
				if (!current()) return;
				tile.abort = null;
				if (!img.isConnected) {
					this.release(img);
					return;
				}
				this.showOriginalBytes(img, tile, bytes, attempt);
			},
			() => {
				if (!current()) return;
				tile.abort = null;
				if (!img.isConnected) {
					this.release(img);
					return;
				}
				this.fallBackToUrl(img, tile, attempt);
			}
		);
	}

	private showOriginalBytes(img: HTMLImageElement, tile: TileState, bytes: ArrayBuffer, attempt: number): void {
		const url = this.urls.get(img) ?? "";
		// No type: the browser sniffs image data (SVG never takes this path).
		const blobUrl = this.addBlob(img, new Blob([bytes]));
		img.onload = () => {
			clearHandlers(img);
			if (this.tiles.get(img) !== tile) return;
			img.classList.add("oss-gallery-img-loaded");
			this.stopObserving(img);
			this.queue.loaded(img);
			this.switchToThumbnail(img, tile, bytes, blobUrl, url);
		};
		img.onerror = () => {
			// Not displayable from bytes: the URL through <img> once.
			clearHandlers(img);
			if (this.tiles.get(img) !== tile) return;
			this.revokeBlob(img, blobUrl);
			this.fallBackToUrl(img, tile, attempt);
		};
		img.removeAttribute("data-src");
		img.loading = "eager";
		img.src = blobUrl;
	}

	/**
	 * Off the critical path: make the thumbnail from the bytes in hand and
	 * show it instead of the original (whose Blob is then revoked).
	 */
	private switchToThumbnail(img: HTMLImageElement, tile: TileState, bytes: ArrayBuffer, originalUrl: string, url: string): void {
		const make = tile.source.thumbnailFrom;
		const keepOriginal = () => {
			if (this.tiles.get(img) === tile && img.isConnected) {
				this.onImageLoaded?.(img, url);
			}
		};
		if (!make) {
			keepOriginal();
			return;
		}
		make(bytes).then((thumb) => {
			if (this.tiles.get(img) !== tile || !img.isConnected || img.getAttribute("src") !== originalUrl) return;
			if (!thumb) {
				keepOriginal();
				return;
			}
			const thumbUrl = this.addBlob(img, new Blob([thumb.bytes], { type: thumb.mime }));
			img.onload = () => {
				clearHandlers(img);
				this.revokeBlob(img, originalUrl);
			};
			img.onerror = () => {
				clearHandlers(img);
				if (this.tiles.get(img) !== tile) return;
				this.revokeBlob(img, thumbUrl);
				img.src = originalUrl;
			};
			img.src = thumbUrl;
		}, keepOriginal);
	}

	private startLocal(img: HTMLImageElement): void {
		const tile = this.tiles.get(img);
		if (!tile) return;
		const read = tile.source.readThumbnail;
		if (!read) {
			tile.local = "miss";
			this.localQueue.failed(img);
			return;
		}
		tile.local = "reading";
		const done = (thumb: LocalThumbnail | null) => {
			// Released or re-observed meanwhile: not ours any more.
			if (this.tiles.get(img) !== tile) return;
			if (!thumb || !img.isConnected) {
				tile.local = "miss";
				this.localQueue.failed(img);
				return;
			}
			this.showLocal(img, tile, thumb);
		};
		read().then(done, () => done(null));
	}

	private showLocal(img: HTMLImageElement, tile: TileState, thumb: LocalThumbnail): void {
		const blobUrl = this.addBlob(img, new Blob([thumb.bytes], { type: thumb.mime }));
		tile.local = "hit";
		// The placeholder, restored if the thumbnail turns out unreadable.
		const placeholder = img.getAttribute("src");
		img.onload = () => {
			clearHandlers(img);
			if (this.tiles.get(img) !== tile) return;
			img.classList.add("oss-gallery-img-loaded");
			this.stopObserving(img);
			this.localQueue.loaded(img);
		};
		img.onerror = () => {
			// Unreadable thumbnail: fall back to the original.
			clearHandlers(img);
			if (this.tiles.get(img) !== tile) return;
			this.revokeBlob(img, blobUrl);
			if (placeholder) {
				img.src = placeholder;
			}
			tile.local = "miss";
			this.localQueue.failed(img);
		};
		img.removeAttribute("data-src");
		img.loading = "eager";
		img.src = blobUrl;
	}

	/** No usable cached thumbnail: load the original (or keep the placeholder when there is none). */
	private localMissed(img: HTMLImageElement): void {
		const tile = this.tiles.get(img);
		if (tile) tile.local = "miss";
		if (!this.canLoadOriginal(img)) {
			this.stopObserving(img);
			return;
		}
		if (this.nearZone.has(img)) {
			this.queue.request(img, this.visible.has(img));
		}
	}

	private addBlob(img: HTMLImageElement, blob: Blob): string {
		const blobUrl = URL.createObjectURL(blob);
		let set = this.blobUrls.get(img);
		if (!set) {
			set = new Set();
			this.blobUrls.set(img, set);
		}
		set.add(blobUrl);
		return blobUrl;
	}

	private revokeBlob(img: HTMLImageElement, blobUrl: string): void {
		const set = this.blobUrls.get(img);
		if (set?.delete(blobUrl)) {
			URL.revokeObjectURL(blobUrl);
			if (set.size === 0) this.blobUrls.delete(img);
		}
	}

	private revokeAllBlobs(img: HTMLImageElement): void {
		const set = this.blobUrls.get(img);
		if (!set) return;
		this.blobUrls.delete(img);
		for (const blobUrl of set) {
			URL.revokeObjectURL(blobUrl);
		}
	}

	/**
	 * Every attempt failed: the element is emptied and marked; the tile
	 * draws its failed state in CSS (`onImageFailed`) and can `retry`.
	 */
	private showFailed(img: HTMLImageElement): void {
		clearHandlers(img);
		this.stopObserving(img);
		img.removeAttribute("src");
		img.classList.add("oss-gallery-img-error");
		console.warn("Image load failed after retries:", this.urls.get(img));
		this.onImageFailed?.(img);
	}

	/**
	 * Load a failed tile again from scratch (cached thumbnail, original,
	 * <img> fallback, with the usual attempts).
	 */
	retry(img: HTMLImageElement, url: string, source?: TileSource): void {
		this.release(img);
		img.classList.remove("oss-gallery-img-error");
		if (url) img.dataset.src = url;
		this.observe(img, source);
	}

	private stopObserving(img: HTMLImageElement): void {
		this.nearObserver?.unobserve(img);
		this.visibleObserver?.unobserve(img);
		this.visible.delete(img);
		this.nearZone.delete(img);
	}

	/** Cancel the load, clear the element and forget it. */
	private release(img: HTMLImageElement): void {
		const tracked = this.urls.delete(img);
		const tile = this.tiles.get(img);
		this.tiles.delete(img);
		// requestUrl itself can't be aborted: the download is abandoned.
		tile?.abort?.abort();
		this.stopObserving(img);
		this.queue.cancel(img);
		this.localQueue.cancel(img);
		if (!tracked) return;
		clearHandlers(img);
		// Aborts an in-flight request and frees decoded memory. Removing the
		// attribute (instead of src = "") fires no error event.
		img.removeAttribute("src");
		this.revokeAllBlobs(img);
	}

	/**
	 * Release tracked images that were removed from the document.
	 */
	cleanup(): void {
		for (const img of [...this.urls.keys()]) {
			if (!img.isConnected) {
				this.release(img);
			}
		}
	}

	/**
	 * 销毁服务
	 */
	destroy(): void {
		for (const img of [...this.urls.keys()]) {
			this.release(img);
		}
		this.destroyed = true;
		this.queue.destroy();
		this.localQueue.destroy();
		for (const img of [...this.blobUrls.keys()]) {
			this.revokeAllBlobs(img);
		}
		this.nearObserver?.disconnect();
		this.visibleObserver?.disconnect();
		this.nearObserver = null;
		this.visibleObserver = null;
		this.visible.clear();
		this.nearZone.clear();
	}
}

function clearHandlers(img: HTMLImageElement): void {
	img.onload = null;
	img.onerror = null;
}

/** Nearest scrolling ancestor, or null for the viewport. */
function findScrollParent(el: HTMLElement): Element | null {
	let node = el.parentElement;
	while (node && node !== document.body && node !== document.documentElement) {
		const overflowY = window.getComputedStyle(node).overflowY;
		if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
			return node;
		}
		node = node.parentElement;
	}
	return null;
}
