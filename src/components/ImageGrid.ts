import { Notice, setIcon } from "obsidian";
import { t } from "../i18n";
import { isTiffKey } from "../providers/shared/image";
import { LazyImageService } from "../services/LazyImageService";
import { TileSourceFactory } from "../types/gallery";
import { OssImage } from "../types/oss";

export class ImageGrid {
	private lazyImageService: LazyImageService;
	private imageElements: Set<HTMLImageElement> = new Set();
	private renderToken = 0;
	/** Batched rendering still in progress (reveal waits for it). */
	private rendering = false;
	/** Tile elements by object key. */
	private readonly items = new Map<string, HTMLElement>();
	private static readonly MAX_DISPLAY_DIMENSION = 4096;
	private static readonly MAX_PIXEL_COUNT = 12_000_000;

	constructor(
		private container: HTMLElement,
		private options: {
			getObjectUrl: (objectName: string) => Promise<string>;
			canDelete?: boolean;
			/** Called with the object key: indexes shift after deletes. */
			onPreview?: (objectName: string) => void;
			onCopy?: (url: string) => void;
			onDelete?: (objectName: string, element: HTMLElement) => void;
			/** Right click / context-menu key on a tile. */
			onContextMenu?: (objectName: string, event: MouseEvent, element: HTMLElement) => void;
			/** Show the "find similar" hover action for this image. */
			canFindSimilar?: (objectName: string) => boolean;
			onFindSimilar?: (objectName: string) => void;
			/**
			 * Local thumbnails (src/thumbnails): tiles show a cached one, else
			 * load the original once and make one from it. Preview, copy URL
			 * and embeds always use the original. null = load URLs as before.
			 */
			tileSources?: TileSourceFactory | null;
		}
	) {
		this.lazyImageService = new LazyImageService({
			onImageLoaded: (img) => {
				this.optimizeLargeImage(img).catch((err) => {
					console.warn("Optimize image failed", err);
				});
			},
		});
	}

	/**
	 * Render tiles in batches. `scores` (semantic results) adds a small score
	 * badge per tile.
	 */
	async renderImages(objects: OssImage[], batchSize = 10, scores?: Map<string, number>): Promise<void> {
		this.cleanup();
		const token = ++this.renderToken;
		this.rendering = true;

		try {
			for (let i = 0; i < objects.length; i += batchSize) {
				// 渲染期间发生了新一轮渲染或 destroy：停止向已失效的容器继续渲染
				if (token !== this.renderToken || !this.container.isConnected) {
					return;
				}

				const batch = objects.slice(i, i + batchSize);
				await Promise.all(
					batch.map((obj) => this.renderImageItem(obj, scores?.get(obj.key)))
				);
				await new Promise((resolve) => window.setTimeout(resolve, 10));
			}
		} finally {
			if (token === this.renderToken) {
				this.rendering = false;
			}
		}
	}

	/**
	 * Scroll to a tile, select it (highlight + focus). Waits for batched
	 * rendering to reach it. Returns false when the image isn't in the grid.
	 */
	async reveal(objectName: string): Promise<boolean> {
		const token = this.renderToken;
		let item = this.items.get(objectName);
		while (!item && this.rendering && token === this.renderToken) {
			await new Promise((resolve) => window.setTimeout(resolve, 30));
			item = this.items.get(objectName);
		}
		if (!item || !item.isConnected) {
			return false;
		}
		this.container.querySelectorAll(".oss-gallery-item.is-selected")
			.forEach((el) => el.removeClass("is-selected"));
		item.addClass("is-selected");
		item.scrollIntoView({ block: "center", behavior: "smooth" });
		item.focus({ preventScroll: true });
		return true;
	}

	private async renderImageItem(obj: OssImage, score?: number): Promise<void> {
		const objectName = obj.key;
		const objectUrl = await this.options.getObjectUrl(objectName);

		const imgDiv = this.container.createDiv({
			cls: "oss-gallery-item",
			attr: { tabindex: "0", "aria-label": objectName },
		});
		this.items.set(objectName, imgDiv);

		// Keyboard: Enter/Space previews; the context-menu key / Shift+F10
		// fire `contextmenu` on the focused tile.
		imgDiv.addEventListener("keydown", (event) => {
			if (event.target === imgDiv && (event.key === "Enter" || event.key === " ")) {
				event.preventDefault();
				this.options.onPreview?.(objectName);
			}
		});
		if (this.options.onContextMenu) {
			imgDiv.addEventListener("contextmenu", (event) => {
				event.preventDefault();
				this.options.onContextMenu?.(objectName, event, imgDiv);
			});
		}

		// Chromium's <img> can't render TIFF: show a neutral tile instead of
		// downloading it only to end up with "Load failed" (a local thumbnail,
		// e.g. made by semantic indexing, still replaces the placeholder).
		const unsupported = isTiffKey(objectName);
		const imgAttrs: Record<string, string> = {
			src: unsupported ? this.getPlaceholderUrl("TIFF") : this.getPlaceholderUrl(),
			alt: objectName,
			decoding: "async",
		};
		if (!unsupported) {
			imgAttrs["data-src"] = objectUrl;
		}
		const img = imgDiv.createEl("img", { attr: imgAttrs });
		img.dataset.originalUrl = objectUrl;

		this.imageElements.add(img);
		const source = this.options.tileSources?.(obj);
		if (unsupported) {
			img.addClass("oss-gallery-img-placeholder");
		}
		if (!unsupported || source?.readThumbnail) {
			this.lazyImageService.observe(img, source);
		}

		img.onclick = () => {
			this.options.onPreview?.(objectName);
		};

		if (score !== undefined) {
			imgDiv.createDiv({
				cls: "oss-gallery-score-badge",
				text: score.toFixed(2),
				attr: { "aria-label": `${t("Score")} ${score.toFixed(3)}` },
			});
		}

		const buttonContainer = imgDiv.createDiv({
			cls: "oss-gallery-buttons",
		});

		if (this.options.onFindSimilar && this.options.canFindSimilar?.(objectName)) {
			this.createFindSimilarButton(buttonContainer, objectName);
		}
		this.createCopyButton(buttonContainer, objectUrl);
		if (this.options.canDelete !== false) {
			this.createDeleteButton(buttonContainer, objectName, imgDiv);
		}
	}

	private createFindSimilarButton(container: HTMLElement, objectName: string): void {
		const btn = container.createEl("button", {
			cls: "oss-gallery-icon-btn oss-gallery-similar-btn",
			attr: { type: "button", "aria-label": t("Find similar images") },
		});
		setIcon(btn, "images");
		btn.onclick = (event) => {
			event.stopPropagation();
			this.options.onFindSimilar?.(objectName);
		};
	}

	private async optimizeLargeImage(img: HTMLImageElement): Promise<void> {
		if (img.dataset.optimized === "true") return;

		const originalUrl = img.dataset.originalUrl ?? img.currentSrc ?? img.src;
		// Remote images can display without CORS, but canvas-based downscaling cannot.
		if (/^https?:\/\//i.test(originalUrl)) {
			return;
		}

		const naturalWidth = img.naturalWidth;
		const naturalHeight = img.naturalHeight;
		if (!naturalWidth || !naturalHeight) return;

		const largestSide = Math.max(naturalWidth, naturalHeight);
		const pixelCount = naturalWidth * naturalHeight;
		if (
			largestSide <= ImageGrid.MAX_DISPLAY_DIMENSION &&
			pixelCount <= ImageGrid.MAX_PIXEL_COUNT
		) {
			return;
		}

		if (typeof createImageBitmap !== "function") {
			return;
		}

		const dimensionScale = ImageGrid.MAX_DISPLAY_DIMENSION / largestSide;
		const pixelScale = Math.sqrt(ImageGrid.MAX_PIXEL_COUNT / pixelCount);
		const scale = Math.min(1, dimensionScale, pixelScale);
		if (scale >= 1) {
			return;
		}

		const targetWidth = Math.max(1, Math.round(naturalWidth * scale));
		const targetHeight = Math.max(1, Math.round(naturalHeight * scale));

		try {
			const bitmap = await createImageBitmap(img, {
				resizeWidth: targetWidth,
				resizeHeight: targetHeight,
				resizeQuality: "high",
			});

			const canvas = createEl("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				bitmap.close();
				return;
			}

			ctx.drawImage(bitmap, 0, 0);
			bitmap.close();

			img.src = canvas.toDataURL("image/jpeg", 0.85);
			img.dataset.optimized = "true";
		} catch (error) {
			console.warn("Downscale large image failed", error);
		}
	}

	private createCopyButton(container: HTMLElement, url: string): void {
		const copyBtn = container.createEl("button", {
			cls: "oss-gallery-icon-btn oss-gallery-copy-btn",
			attr: { type: "button", "aria-label": t("Copy URL") },
		});
		setIcon(copyBtn, "copy");

		copyBtn.onclick = async () => {
			try {
				await navigator.clipboard.writeText(url);
			} catch (error) {
				console.error("Copy URL failed", error);
				new Notice(t("Copy failed"));
				return;
			}
			new Notice(t("URL copied"));
			this.options.onCopy?.(url);
		};
	}

	private createDeleteButton(
		container: HTMLElement,
		objectName: string,
		imgDiv: HTMLElement
	): void {
		const deleteBtn = container.createEl("button", {
			cls: "oss-gallery-icon-btn oss-gallery-delete-btn",
			attr: { type: "button", "aria-label": t("Delete") },
		});
		setIcon(deleteBtn, "trash");

		deleteBtn.onclick = async () => {
			this.options.onDelete?.(objectName, imgDiv);
		};
	}

	/** `label` is ASCII only (btoa). */
	private getPlaceholderUrl(label = "Loading..."): string {
		return (
			"data:image/svg+xml;base64," +
			btoa(`
	            <svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
	                <rect width="100" height="100" fill="#ccc"/>
	                <text x="50" y="50" text-anchor="middle" dy=".3em" fill="#666" font-size="12">${label}</text>
	            </svg>
	        `)
		);
	}

	private cleanup(): void {
		this.renderToken++;
		this.rendering = false;
		this.items.clear();
		this.container.empty();
		// unobserve cancels queued/running loads and retries and clears the
		// element's src, so a discarded grid stops downloading right away.
		this.imageElements.forEach((img) => {
			this.lazyImageService.unobserve(img);
		});
		this.lazyImageService.cleanup();
		this.imageElements.clear();
	}

	destroy(): void {
		this.cleanup();
		this.lazyImageService.destroy();
	}

	getImageCount(): number {
		return this.imageElements.size;
	}
}
