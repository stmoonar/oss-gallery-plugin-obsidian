import { Notice, setIcon } from "obsidian";
import { t } from "../i18n";
import { isTiffKey } from "../providers/shared/image";
import { LazyImageService } from "../services/LazyImageService";
import { fileNameOf } from "../semantic/statusText";
import { TileSource, TileSourceFactory } from "../types/gallery";
import { OssImage } from "../types/oss";
import { columnsFromTops, isGridNavKey, navigateGrid } from "./gridNavigation";
import { nextFocusAfterRemoval } from "./galleryUx";
import {
	clickAction,
	EMPTY_SELECTION,
	orderedSelection,
	retainKeys,
	selectAll,
	selectRange,
	SelectionState,
	toggleKey,
} from "./tileSelection";

/** Tiles measured to find the column count (first row). */
const COLUMN_PROBE = 64;

export interface ImageGridOptions {
	getObjectUrl: (objectName: string) => Promise<string>;
	canDelete?: boolean;
	/** Called with the object key: indexes shift after deletes. */
	onPreview?: (objectName: string) => void;
	onCopy?: (url: string) => void;
	/** Delete these keys (one tile, or the selection); the view confirms. */
	onDelete?: (keys: string[]) => void;
	/** Right click / context-menu key / long press on a tile. */
	onContextMenu?: (objectName: string, event: MouseEvent, element: HTMLElement) => void;
	/** The tile's "more actions" button: same menu, anchored to the button. */
	onMore?: (objectName: string, anchor: HTMLElement) => void;
	/** Show the "find similar" hover action for this image. */
	canFindSimilar?: (objectName: string) => boolean;
	onFindSimilar?: (objectName: string) => void;
	/**
	 * Local thumbnails (src/thumbnails): tiles show a cached one, else
	 * load the original once and make one from it. Preview, copy URL
	 * and embeds always use the original. null = load URLs as before.
	 */
	tileSources?: TileSourceFactory | null;
	/** Text a tile drag carries into a note (embeds of these keys); null = not draggable. */
	dragText?: (keys: string[]) => string | null;
	/** Selection kept from the previous grid (keys no longer shown are dropped). */
	initialSelection?: SelectionState;
	onSelectionChange?: (selection: SelectionState) => void;
	/** Accessible name of the image list. */
	label?: string;
}

interface Tile {
	el: HTMLElement;
	img: HTMLImageElement;
	placeholder: HTMLElement;
	url: string;
	source: TileSource | undefined;
}

export class ImageGrid {
	private lazyImageService: LazyImageService;
	private imageElements: Set<HTMLImageElement> = new Set();
	private renderToken = 0;
	/** Batched rendering still in progress (reveal waits for it). */
	private rendering = false;
	/** Tiles by object key, in render order. */
	private readonly items = new Map<string, Tile>();
	private readonly tileByImg = new Map<HTMLImageElement, Tile>();
	/** Keys of the current render, in display order (also the not yet rendered ones). */
	private order: string[] = [];
	private selection: SelectionState;
	/** The tile with tabindex 0 (roving tabindex). */
	private activeKey: string | null = null;
	private static readonly MAX_DISPLAY_DIMENSION = 4096;
	private static readonly MAX_PIXEL_COUNT = 12_000_000;

	constructor(
		private container: HTMLElement,
		private options: ImageGridOptions
	) {
		this.selection = options.initialSelection ?? EMPTY_SELECTION;
		this.lazyImageService = new LazyImageService({
			onImageLoaded: (img) => {
				this.optimizeLargeImage(img).catch((err) => {
					console.warn("Optimize image failed", err);
				});
			},
			onImageFailed: (img) => {
				const tile = this.tileByImg.get(img);
				if (tile) this.setTileFailed(tile, true);
			},
		});
		container.setAttrs({
			role: "listbox",
			"aria-multiselectable": "true",
			"aria-label": options.label ?? t("Gallery images"),
		});
		this.bindEvents();
	}

	/**
	 * Render tiles in batches. `scores` (semantic results) adds a small score
	 * badge per tile (shown on hover / focus).
	 */
	async renderImages(objects: OssImage[], batchSize = 10, scores?: Map<string, number>): Promise<void> {
		this.cleanup();
		const token = ++this.renderToken;
		this.rendering = true;
		this.order = objects.map((o) => o.key);
		this.setSelectionState(retainKeys(this.selection, this.order), true);
		this.activeKey = this.order[0] ?? null;

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
	 * Scroll to a tile, highlight and focus it. Waits for batched rendering
	 * to reach it. Returns false when the image isn't in the grid.
	 */
	async reveal(objectName: string): Promise<boolean> {
		const token = this.renderToken;
		let item = this.items.get(objectName);
		while (!item && this.rendering && token === this.renderToken) {
			await new Promise((resolve) => window.setTimeout(resolve, 30));
			item = this.items.get(objectName);
		}
		if (!item || !item.el.isConnected) {
			return false;
		}
		this.container.querySelectorAll(".oss-gallery-item.is-selected")
			.forEach((el) => el.removeClass("is-selected"));
		item.el.addClass("is-selected");
		item.el.scrollIntoView({ block: "center", behavior: "smooth" });
		this.focusKey(objectName, true);
		return true;
	}

	private async renderImageItem(obj: OssImage, score?: number): Promise<void> {
		const objectName = obj.key;
		const objectUrl = await this.options.getObjectUrl(objectName);
		const name = fileNameOf(objectName);
		const selected = this.selection.keys.has(objectName);
		const draggable = !!this.options.dragText;

		const imgDiv = this.container.createDiv({
			cls: "oss-gallery-item",
			attr: {
				role: "option",
				tabindex: objectName === this.activeKey ? "0" : "-1",
				"aria-label": name,
				"aria-selected": String(selected),
				title: objectName,
				"data-key": objectName,
				draggable: String(draggable),
			},
		});
		imgDiv.toggleClass("is-checked", selected);

		// Chromium's <img> can't render TIFF: show a neutral tile instead of
		// downloading it only to end up with "Load failed" (a local thumbnail,
		// e.g. made by semantic indexing, still replaces the placeholder).
		const unsupported = isTiffKey(objectName);
		const imgAttrs: Record<string, string> = {
			alt: name,
			decoding: "async",
			draggable: "false",
		};
		if (!unsupported) {
			imgAttrs["data-src"] = objectUrl;
		}
		const img = imgDiv.createEl("img", { attr: imgAttrs });
		img.dataset.originalUrl = objectUrl;

		// Drawn under the image until it loads (theme colors, not baked into an SVG).
		const placeholder = imgDiv.createDiv({ cls: "oss-gallery-tile-placeholder", attr: { "aria-hidden": "true" } });
		const source = this.options.tileSources?.(obj);
		const tile: Tile = { el: imgDiv, img, placeholder, url: unsupported ? "" : objectUrl, source };
		this.items.set(objectName, tile);
		this.tileByImg.set(img, tile);
		this.drawPlaceholder(tile, unsupported ? "tiff" : "loading");

		const check = imgDiv.createDiv({ cls: "oss-gallery-check", attr: { "aria-hidden": "true" } });
		setIcon(check, "check");

		this.imageElements.add(img);
		if (!unsupported || source?.readThumbnail) {
			this.lazyImageService.observe(img, source);
		}

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
			this.createButton(buttonContainer, "images", t("Find similar images"), "oss-gallery-similar-btn", () => {
				this.options.onFindSimilar?.(objectName);
			});
		}
		this.createButton(buttonContainer, "copy", t("Copy URL"), "oss-gallery-copy-btn", () => {
			void this.copyUrl(objectUrl);
		});
		if (this.options.canDelete !== false && this.options.onDelete) {
			this.createButton(buttonContainer, "trash", t("Delete"), "oss-gallery-delete-btn", () => {
				this.options.onDelete?.([objectName]);
			});
		}
		if (this.options.onMore) {
			const more = this.createButton(buttonContainer, "more-horizontal", t("More actions"), "oss-gallery-more-btn", () => {
				this.options.onMore?.(objectName, more);
			});
			more.setAttr("aria-haspopup", "menu");
		}
	}

	/** Tile buttons: pointer shortcuts; keyboard users get the same actions from the menu. */
	private createButton(parent: HTMLElement, icon: string, label: string, cls: string, onClick: () => void): HTMLButtonElement {
		const btn = parent.createEl("button", {
			cls: `oss-gallery-icon-btn ${cls}`,
			attr: { type: "button", "aria-label": label, tabindex: "-1" },
		});
		setIcon(btn, icon);
		btn.addEventListener("click", (event) => {
			event.stopPropagation();
			onClick();
		});
		return btn;
	}

	private async copyUrl(url: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(url);
		} catch (error) {
			console.error("Copy URL failed", error);
			new Notice(t("Copy failed"));
			return;
		}
		new Notice(t("URL copied"));
		this.options.onCopy?.(url);
	}

	private drawPlaceholder(tile: Tile, state: "loading" | "tiff" | "failed"): void {
		const p = tile.placeholder;
		p.empty();
		setIcon(p.createSpan({ cls: "oss-gallery-tile-placeholder-icon" }), state === "failed" ? "image-off" : "image");
		const text = state === "failed" ? t("Tile load failed") : state === "tiff" ? t("Tile TIFF") : t("Loading...");
		p.createSpan({ cls: "oss-gallery-tile-placeholder-text", text });
		if (state === "failed") {
			p.createSpan({ cls: "oss-gallery-tile-placeholder-hint", text: t("Tile retry hint") });
		}
	}

	private setTileFailed(tile: Tile, failed: boolean): void {
		tile.el.toggleClass("oss-gallery-is-failed", failed);
		this.drawPlaceholder(tile, failed ? "failed" : "loading");
	}

	/** A failed tile: try once more from scratch. Returns false when the tile isn't failed. */
	private retryTile(tile: Tile): boolean {
		if (!tile.el.hasClass("oss-gallery-is-failed")) return false;
		this.setTileFailed(tile, false);
		this.lazyImageService.retry(tile.img, tile.url, tile.source);
		return true;
	}

	// ---- events (delegated) ----

	private tileFromEvent(event: Event): { key: string; tile: Tile } | null {
		const target = event.target as HTMLElement | null;
		const el = target?.closest<HTMLElement>(".oss-gallery-item");
		const key = el?.dataset.key;
		if (!el || key === undefined) return null;
		const tile = this.items.get(key);
		return tile && tile.el === el ? { key, tile } : null;
	}

	private bindEvents(): void {
		const c = this.container;
		c.addEventListener("click", (event) => {
			if ((event.target as HTMLElement).closest("button")) return;
			const hit = this.tileFromEvent(event);
			if (!hit) return;
			const mods = { toggle: event.ctrlKey || event.metaKey, shift: event.shiftKey };
			if (!mods.toggle && !mods.shift && this.retryTile(hit.tile)) return;
			this.setActive(hit.key);
			this.applyClick(hit.key, clickAction(mods, this.selection.keys.size > 0));
		});

		c.addEventListener("keydown", (event) => {
			const hit = this.tileFromEvent(event);
			if (!hit || event.target !== hit.tile.el) return;
			this.onTileKey(event, hit.key, hit.tile);
		});

		// The context-menu key / Shift+F10 fire `contextmenu` on the focused tile.
		c.addEventListener("contextmenu", (event) => {
			const hit = this.tileFromEvent(event);
			if (!hit || !this.options.onContextMenu) return;
			event.preventDefault();
			this.setActive(hit.key);
			this.options.onContextMenu(hit.key, event, hit.tile.el);
		});

		c.addEventListener("focusin", (event) => {
			const hit = this.tileFromEvent(event);
			if (hit && event.target === hit.tile.el) this.setActive(hit.key);
		});

		// Drag into a note: plain text only (the embed), so the editor inserts
		// it at the drop point instead of a URL, HTML or a downloaded file.
		c.addEventListener("dragstart", (event) => {
			const hit = this.tileFromEvent(event);
			const dt = event.dataTransfer;
			if (!hit || !dt) return;
			const keys = this.selection.keys.has(hit.key) && this.selection.keys.size > 1
				? orderedSelection(this.selection, this.order)
				: [hit.key];
			const text = this.options.dragText?.(keys) ?? null;
			if (!text) {
				event.preventDefault();
				return;
			}
			dt.clearData();
			dt.setData("text/plain", text);
			dt.effectAllowed = "copy";
			if (hit.tile.img.hasClass("oss-gallery-img-loaded")) {
				dt.setDragImage(hit.tile.img, 16, 16);
			}
		});
	}

	private applyClick(key: string, action: ReturnType<typeof clickAction>): void {
		switch (action) {
			case "open":
				this.options.onPreview?.(key);
				return;
			case "toggle":
				this.setSelectionState(toggleKey(this.selection, key));
				return;
			case "range":
				this.setSelectionState(selectRange(this.selection, this.order, key, false));
				return;
			case "range-add":
				this.setSelectionState(selectRange(this.selection, this.order, key, true));
				return;
		}
	}

	private onTileKey(event: KeyboardEvent, key: string, tile: Tile): void {
		const mod = event.ctrlKey || event.metaKey;
		if (isGridNavKey(event.key) && !event.altKey) {
			const rendered = this.renderedKeys();
			const next = navigateGrid(rendered.indexOf(key), event.key, rendered.length, this.columns());
			event.preventDefault();
			if (next === null) return;
			const nextKey = rendered[next];
			if (nextKey === undefined) return;
			if (event.shiftKey) {
				this.setSelectionState(selectRange(
					this.selection.anchor ? this.selection : { keys: this.selection.keys, anchor: key },
					this.order, nextKey, true
				));
			}
			this.focusKey(nextKey, false);
			return;
		}
		switch (event.key) {
			case "Enter":
				event.preventDefault();
				if (!this.retryTile(tile)) this.options.onPreview?.(key);
				return;
			case " ":
				event.preventDefault();
				if (this.selection.keys.size > 0 || mod) {
					this.setSelectionState(toggleKey(this.selection, key));
				} else if (!this.retryTile(tile)) {
					this.options.onPreview?.(key);
				}
				return;
			case "Escape":
				if (this.selection.keys.size > 0) {
					event.preventDefault();
					event.stopPropagation();
					this.clearSelection();
				}
				return;
			case "Delete":
				if (this.options.canDelete !== false && this.options.onDelete) {
					event.preventDefault();
					this.options.onDelete(this.selection.keys.has(key)
						? orderedSelection(this.selection, this.order)
						: [key]);
				}
				return;
			case "a":
			case "A":
				if (mod) {
					event.preventDefault();
					this.setSelectionState(selectAll(this.order));
				}
				return;
		}
	}

	private renderedKeys(): string[] {
		return this.order.filter((k) => this.items.has(k));
	}

	private columns(): number {
		const tops: number[] = [];
		for (const tile of this.items.values()) {
			tops.push(tile.el.offsetTop);
			if (tops.length >= COLUMN_PROBE) break;
		}
		return columnsFromTops(tops);
	}

	private setActive(key: string): void {
		if (this.activeKey === key) return;
		const prev = this.activeKey !== null ? this.items.get(this.activeKey) : undefined;
		prev?.el.setAttr("tabindex", "-1");
		this.activeKey = key;
		this.items.get(key)?.el.setAttr("tabindex", "0");
	}

	/** Move keyboard focus (and the tab stop) to a tile. */
	focusKey(key: string, preventScroll: boolean): boolean {
		const tile = this.items.get(key);
		if (!tile) return false;
		this.setActive(key);
		tile.el.focus({ preventScroll });
		if (!preventScroll) tile.el.scrollIntoView({ block: "nearest" });
		return true;
	}

	// ---- selection ----

	private setSelectionState(next: SelectionState, silent = false): void {
		const prev = this.selection;
		this.selection = next;
		for (const key of new Set([...prev.keys, ...next.keys])) {
			const tile = this.items.get(key);
			if (!tile) continue;
			const on = next.keys.has(key);
			tile.el.toggleClass("is-checked", on);
			tile.el.setAttr("aria-selected", String(on));
		}
		this.container.toggleClass("oss-gallery-is-selecting", next.keys.size > 0);
		if (!silent || prev !== next) this.options.onSelectionChange?.(next);
	}

	getSelection(): SelectionState {
		return this.selection;
	}

	/** Selected keys in display order. */
	getSelectedKeys(): string[] {
		return orderedSelection(this.selection, this.order);
	}

	clearSelection(): void {
		if (this.selection.keys.size === 0) return;
		this.setSelectionState(EMPTY_SELECTION);
	}

	/** Context menu "Select" (touch users start selecting this way). */
	toggleSelected(key: string): void {
		this.setSelectionState(toggleKey(this.selection, key));
	}

	isSelected(key: string): boolean {
		return this.selection.keys.has(key);
	}

	/**
	 * Remove deleted tiles; focus moves to the next tile (or the previous)
	 * when `moveFocus`. Returns the number of tiles left.
	 */
	removeItems(keys: readonly string[], moveFocus: boolean): number {
		const removed = new Set(keys);
		const before = this.renderedKeys();
		const focusTarget = nextFocusAfterRemoval(before, removed);
		const hadFocus = this.container.contains(document.activeElement);
		for (const key of removed) {
			const tile = this.items.get(key);
			if (!tile) continue;
			this.lazyImageService.unobserve(tile.img);
			this.imageElements.delete(tile.img);
			this.tileByImg.delete(tile.img);
			this.items.delete(key);
			tile.el.remove();
		}
		this.order = this.order.filter((k) => !removed.has(k));
		this.setSelectionState(retainKeys(this.selection, this.order));
		if (this.activeKey !== null && removed.has(this.activeKey)) {
			this.activeKey = null;
			if (focusTarget !== null) {
				if (moveFocus || hadFocus) {
					this.focusKey(focusTarget, false);
				} else {
					this.setActive(focusTarget);
				}
			}
		}
		return this.order.length;
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

	private cleanup(): void {
		this.renderToken++;
		this.rendering = false;
		this.items.clear();
		this.tileByImg.clear();
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
		return this.order.length;
	}
}
