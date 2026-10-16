import { LazyImageOptions } from "../types/gallery";
import {
	DEFAULT_MAX_CONCURRENT,
	DEFAULT_STALL_TIMEOUT_MS,
	ImageLoadQueue,
} from "./imageLoadQueue";

/** Prefetch distance around the scroll viewport. */
const PREFETCH_ROOT_MARGIN = "300px";

/**
 * Lazy loading for gallery tiles (`<img data-src>`). Scheduling (bounded
 * concurrency, visible-first FIFO, retries, stall handling) lives in
 * `ImageLoadQueue`; this class only wires it to IntersectionObservers and
 * the `<img>` elements.
 */
export class LazyImageService {
	private readonly queue: ImageLoadQueue<HTMLImageElement>;
	/** Tracked images and their URLs. */
	private readonly urls = new Map<HTMLImageElement, string>();
	/** Images currently inside the (un-expanded) viewport. */
	private readonly visible = new Set<HTMLImageElement>();
	private nearObserver: IntersectionObserver | null = null;
	private visibleObserver: IntersectionObserver | null = null;
	private destroyed = false;
	private readonly rootMargin: string;
	private readonly threshold: number;
	private readonly onImageLoaded?: (img: HTMLImageElement, url: string) => void;

	constructor(options: LazyImageOptions = {}) {
		this.rootMargin = options.rootMargin ?? PREFETCH_ROOT_MARGIN;
		this.threshold = options.threshold ?? 0;
		this.onImageLoaded = options.onImageLoaded;
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
						this.queue.request(target, this.visible.has(target));
					} else if (!target.isConnected) {
						this.release(target);
					} else {
						this.visible.delete(target);
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
						this.queue.request(target, true);
					} else {
						this.visible.delete(target);
						this.queue.setVisible(target, false);
					}
				}
			},
			{ root, rootMargin: "0px", threshold: this.threshold }
		);
	}

	/**
	 * 观察图片元素
	 */
	observe(img: HTMLImageElement): void {
		const url = img.dataset.src;
		if (!url || this.destroyed) return;

		this.urls.set(img, url);

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

	private startLoad(img: HTMLImageElement, attempt: number): void {
		const url = this.urls.get(img);
		if (!url) return;
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

	private showFailed(img: HTMLImageElement): void {
		clearHandlers(img);
		this.stopObserving(img);
		img.classList.add("oss-gallery-img-error");
		img.src = this.getPlaceholderUrl();
		console.warn("Image load failed after retries:", this.urls.get(img));
	}

	private stopObserving(img: HTMLImageElement): void {
		this.nearObserver?.unobserve(img);
		this.visibleObserver?.unobserve(img);
		this.visible.delete(img);
	}

	/** Cancel the load, clear the element and forget it. */
	private release(img: HTMLImageElement): void {
		const tracked = this.urls.delete(img);
		this.stopObserving(img);
		this.queue.cancel(img);
		if (!tracked) return;
		clearHandlers(img);
		// Aborts an in-flight request and frees decoded memory. Removing the
		// attribute (instead of src = "") fires no error event.
		img.removeAttribute("src");
	}

	/**
	 * 获取占位图 URL
	 */
	private getPlaceholderUrl(): string {
		return (
			"data:image/svg+xml;base64," +
			btoa(`
            <svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
                <rect width="100" height="100" fill="#ccc"/>
                <text x="50" y="50" text-anchor="middle" dy=".3em" fill="#666" font-size="12">Load failed</text>
            </svg>
        `)
		);
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
		this.nearObserver?.disconnect();
		this.visibleObserver?.disconnect();
		this.nearObserver = null;
		this.visibleObserver = null;
		this.visible.clear();
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
