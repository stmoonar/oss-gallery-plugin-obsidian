import { App, Modal, setIcon } from "obsidian";
import { t } from "../i18n";
import { ImagePreviewOptions } from "../types/gallery";
import { fileNameOf } from "../semantic/statusText";
import {
	detectSwipe,
	distance,
	doubleClickTarget,
	fitView,
	FitMode,
	midpoint,
	overflow,
	panBy,
	Point,
	Size,
	wheelZoomFactor,
	ZOOM_STEP,
	zoomAround,
	ZoomView,
	zoomPercent,
} from "../components/zoomMath";

/** "manual": the user zoomed or panned; a resize keeps the zoom instead of re-fitting. */
type ZoomMode = FitMode | "manual";

/** Pixels a pointer may move before a press counts as a drag (not a click). */
const DRAG_SLOP = 6;
/** Arrow-key pan step in stage pixels. */
const KEY_PAN_STEP = 80;
/** How long the zoom percentage stays visible. */
const ZOOM_BADGE_MS = 1000;
/** The spinner only shows for loads slower than this. */
const LOADING_DELAY = 500;

interface PointerInfo {
	/** Element pressed (pointer capture retargets later events to the stage). */
	target: EventTarget | null;
	start: Point;
	last: Point;
	startTime: number;
}

/**
 * Lightbox of the gallery: the original image with zoom (wheel, pinch,
 * double click, buttons, keys), pan by dragging, prev/next by buttons,
 * arrows or swipe, a position counter and per-image actions. Zoom/pan math
 * lives in `components/zoomMath.ts`.
 */
export class ImagePreviewModal extends Modal {
	private imageUrl: string;
	private key: string;
	private readonly options: ImagePreviewOptions;
	private container!: HTMLElement;
	private stage!: HTMLElement;
	private imgElement: HTMLImageElement | null = null;
	private placeholderElement: HTMLElement | null = null;
	private pathElement: HTMLElement | null = null;
	private counterElement: HTMLElement | null = null;
	private prevBtn: HTMLButtonElement | null = null;
	private nextBtn: HTMLButtonElement | null = null;
	private actionsElement: HTMLElement | null = null;
	private zoomBadge: HTMLElement | null = null;
	private zoomBadgeTimer: number | null = null;
	private errorElement: HTMLElement | null = null;
	private loadingSpinner: HTMLElement | null = null;
	private loadingTimer: number | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private currentTheme: "dark" | "light" = "dark";
	/** Bumped per load: a late load of a previous image is ignored. */
	private loadToken = 0;
	private closed = false;

	// Zoom state
	private natural: Size | null = null;
	private view: ZoomView = { scale: 1, x: 0, y: 0 };
	private zoomMode: ZoomMode = "contain";
	private readonly pointers = new Map<number, PointerInfo>();
	private dragged = false;
	private pinchStart: { distance: number; view: ZoomView } | null = null;

	constructor(app: App, imageUrl: string, key: string, options: ImagePreviewOptions = {}) {
		super(app);
		this.imageUrl = imageUrl;
		this.key = key;
		this.options = options;
		this.modalEl.addClass("oss-gallery-image-preview-modal-shell");
	}

	/** Key of the image shown. */
	get currentKey(): string {
		return this.key;
	}

	onOpen(): void {
		this.closed = false;
		// Obsidian's own close button sits under the lightbox; ours is in the top bar.
		this.modalEl.querySelector(".modal-close-button")?.remove();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("oss-gallery-image-preview-modal-content");

		this.container = contentEl.createDiv({ cls: "oss-gallery-image-preview-container" });
		this.createTopBar();
		this.createStage();
		this.createActionBar();
		this.applyTheme(this.currentTheme);
		this.bindKeys();

		this.resizeObserver = new ResizeObserver(() => this.onResize());
		this.resizeObserver.observe(this.stage);

		window.requestAnimationFrame(() => this.container.addClass("oss-gallery-show"));
		this.updateImage(this.imageUrl, this.key);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
		const btn = parent.createEl("button", {
			cls: `oss-gallery-preview-btn ${cls}`.trim(),
			attr: { type: "button", "aria-label": label },
		});
		setIcon(btn, icon);
		btn.addEventListener("click", (event) => {
			event.stopPropagation();
			onClick();
		});
		return btn;
	}

	private createTopBar(): void {
		const bar = this.container.createDiv({ cls: "oss-gallery-preview-control-bar" });
		this.counterElement = bar.createDiv({ cls: "oss-gallery-preview-counter", attr: { "aria-live": "polite" } });
		this.pathElement = bar.createDiv({ cls: "oss-gallery-preview-path" });

		const tools = bar.createDiv({ cls: "oss-gallery-preview-tools" });
		this.iconButton(tools, "zoom-out", t("Zoom out"), () => this.zoomStep(1 / ZOOM_STEP));
		this.iconButton(tools, "zoom-in", t("Zoom in"), () => this.zoomStep(ZOOM_STEP));
		this.iconButton(tools, "minimize", t("Fit to screen"), () => this.setFit("contain", true));
		this.iconButton(tools, "move-horizontal", t("Fit width"), () => this.setFit("width", true));
		this.iconButton(tools, "scan", t("Actual size"), () => this.zoomTo(1, this.stageCenter(), true));
		const themeBtn = this.iconButton(tools, "sun", t("Toggle background"), () => {
			this.currentTheme = this.currentTheme === "dark" ? "light" : "dark";
			this.applyTheme(this.currentTheme);
			setIcon(themeBtn, this.currentTheme === "dark" ? "sun" : "moon");
		});
		this.iconButton(tools, "x", t("Close"), () => this.close(), "oss-gallery-preview-close-btn");
	}

	private createStage(): void {
		this.stage = this.container.createDiv({ cls: "oss-gallery-preview-stage" });

		this.placeholderElement = this.stage.createDiv({ cls: "oss-gallery-preview-placeholder" });
		setIcon(this.placeholderElement.createDiv({ cls: "oss-gallery-preview-placeholder-icon" }), "image");

		this.imgElement = this.stage.createEl("img", {
			cls: "oss-gallery-image-preview oss-gallery-is-hidden",
			attr: { alt: "", draggable: "false" },
		});

		this.zoomBadge = this.stage.createDiv({ cls: "oss-gallery-preview-zoom-badge", attr: { "aria-live": "polite" } });

		if (this.options.onNavigate) {
			this.prevBtn = this.iconButton(this.stage, "chevron-left", t("Previous image"), () => this.navigate("prev"), "oss-gallery-preview-nav oss-gallery-preview-prev");
			this.nextBtn = this.iconButton(this.stage, "chevron-right", t("Next image"), () => this.navigate("next"), "oss-gallery-preview-nav oss-gallery-preview-next");
		}

		this.stage.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		this.stage.addEventListener("pointermove", (e) => this.onPointerMove(e));
		this.stage.addEventListener("pointerup", (e) => this.onPointerUp(e));
		this.stage.addEventListener("pointercancel", (e) => this.onPointerCancel(e));
		this.stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
		this.stage.addEventListener("dblclick", (e) => this.onDoubleClick(e));
	}

	private createActionBar(): void {
		this.actionsElement = this.container.createDiv({
			cls: "oss-gallery-preview-actions",
			attr: { role: "toolbar", "aria-label": t("Image actions") },
		});
	}

	/** Actions depend on the image (find similar needs it indexed). */
	private renderActions(): void {
		const bar = this.actionsElement;
		if (!bar) return;
		bar.empty();
		const key = this.key;
		const o = this.options;
		const action = (icon: string, label: string, run: () => void, cls = "") => {
			const btn = this.iconButton(bar, icon, label, run, `oss-gallery-preview-action ${cls}`);
			btn.createSpan({ text: label });
		};
		if (o.onCopyUrl) action("link", t("Copy URL"), () => o.onCopyUrl?.(key));
		if (o.onCopyEmbed) action("copy", t("Copy as embed"), () => o.onCopyEmbed?.(key));
		if (o.onFindSimilar && o.canFindSimilar?.(key)) {
			action("images", t("Find similar images"), () => {
				this.close();
				o.onFindSimilar?.(key);
			});
		}
		if (o.onDelete) action("trash", t("Delete"), () => o.onDelete?.(key), "mod-warning");
		bar.toggleClass("oss-gallery-is-hidden", bar.childElementCount === 0);
	}

	private updatePosition(): void {
		const pos = this.options.position?.(this.key) ?? null;
		this.counterElement?.setText(pos
			? t("Image position").replace("{index}", String(pos.index)).replace("{total}", String(pos.total))
			: "");
		const setNav = (btn: HTMLButtonElement | null, enabled: boolean) => {
			if (!btn) return;
			btn.disabled = !enabled;
			btn.toggleClass("oss-gallery-is-hidden", !enabled);
		};
		setNav(this.prevBtn, pos ? pos.index > 1 : true);
		setNav(this.nextBtn, pos ? pos.index < pos.total : true);
	}

	private navigate(direction: "prev" | "next"): void {
		this.options.onNavigate?.(direction);
	}

	private applyTheme(theme: "dark" | "light"): void {
		this.container.toggleClass("oss-gallery-dark", theme === "dark");
		this.container.toggleClass("oss-gallery-light", theme === "light");
	}

	private setHidden(element: HTMLElement | null, hidden: boolean): void {
		element?.toggleClass("oss-gallery-is-hidden", hidden);
	}

	/** Show another image (navigation, or the same one again for Retry). Resets to fit. */
	updateImage(newUrl: string, newKey?: string): void {
		if (this.closed || !this.imgElement) return;
		const img = this.imgElement;
		const token = ++this.loadToken;
		this.imageUrl = newUrl;
		if (newKey) this.key = newKey;
		const name = fileNameOf(this.key);

		this.hideError();
		this.clearLoadingTimer();
		this.setHidden(this.loadingSpinner, true);
		this.pathElement?.setText(name);
		this.pathElement?.setAttr("title", this.key);
		this.updatePosition();
		this.renderActions();

		this.natural = null;
		this.zoomMode = "contain";
		this.pointers.clear();
		this.pinchStart = null;
		this.setHidden(img, true);
		img.removeAttribute("src");
		img.alt = name;
		this.setHidden(this.placeholderElement, false);

		this.loadingTimer = window.setTimeout(() => {
			if (token === this.loadToken) this.showLoadingSpinner();
		}, LOADING_DELAY);

		// Load off-screen first so the previous image never shows half-decoded.
		const loader = new Image();
		loader.onload = () => {
			if (this.closed || token !== this.loadToken || !this.imgElement) return;
			this.clearLoadingTimer();
			this.setHidden(this.loadingSpinner, true);
			this.setHidden(this.placeholderElement, true);
			const fallback = this.stageSize();
			this.natural = {
				width: loader.naturalWidth || fallback.width,
				height: loader.naturalHeight || fallback.height,
			};
			img.setCssProps({
				"--oss-preview-w": `${this.natural.width}px`,
				"--oss-preview-h": `${this.natural.height}px`,
			});
			img.src = newUrl;
			this.setFit("contain", false);
			this.setHidden(img, false);
		};
		loader.onerror = () => {
			if (this.closed || token !== this.loadToken) return;
			this.clearLoadingTimer();
			this.setHidden(this.loadingSpinner, true);
			this.showError();
		};
		loader.src = newUrl;
	}

	private clearLoadingTimer(): void {
		if (this.loadingTimer !== null) {
			window.clearTimeout(this.loadingTimer);
			this.loadingTimer = null;
		}
	}

	private showLoadingSpinner(): void {
		if (!this.loadingSpinner) {
			this.loadingSpinner = this.stage.createDiv({ cls: "oss-gallery-preview-loading" });
			this.loadingSpinner.createDiv({ cls: "oss-gallery-preview-spinner" });
			this.loadingSpinner.createDiv({ cls: "oss-gallery-preview-loading-text", text: t("Loading...") });
		}
		this.setHidden(this.loadingSpinner, false);
	}

	/** Load failure: stays until the next image or a retry. */
	private showError(): void {
		this.hideError();
		this.setHidden(this.placeholderElement, true);
		const box = this.stage.createDiv({ cls: "oss-gallery-preview-error", attr: { role: "alert" } });
		setIcon(box.createDiv({ cls: "oss-gallery-preview-error-icon" }), "image-off");
		box.createDiv({ cls: "oss-gallery-preview-error-message", text: t("Failed to load image") });
		box.createDiv({ cls: "oss-gallery-preview-error-url", text: this.imageUrl });
		const retry = box.createEl("button", { cls: "mod-cta", text: t("Retry"), attr: { type: "button" } });
		retry.addEventListener("click", (event) => {
			event.stopPropagation();
			this.updateImage(this.imageUrl, this.key);
		});
		box.addEventListener("pointerdown", (event) => event.stopPropagation());
		this.errorElement = box;
	}

	private hideError(): void {
		this.errorElement?.remove();
		this.errorElement = null;
	}

	// ---- zoom / pan ----

	private stageSize(): Size {
		return { width: this.stage?.clientWidth || 1, height: this.stage?.clientHeight || 1 };
	}

	private stageCenter(): Point {
		const s = this.stageSize();
		return { x: s.width / 2, y: s.height / 2 };
	}

	private stagePoint(event: { clientX: number; clientY: number }): Point {
		const rect = this.stage.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	private applyView(animate: boolean): void {
		const img = this.imgElement;
		if (!img) return;
		img.toggleClass("oss-gallery-zoom-animate", animate);
		img.setCssProps({
			"--oss-preview-x": `${this.view.x}px`,
			"--oss-preview-y": `${this.view.y}px`,
			"--oss-preview-scale": String(this.view.scale),
		});
		const over = this.isPannable();
		this.stage.toggleClass("oss-gallery-is-pannable", over);
	}

	private isPannable(): boolean {
		if (!this.natural) return false;
		const o = overflow(this.view, this.natural, this.stageSize());
		return o.x || o.y;
	}

	private setFit(mode: FitMode, animate: boolean): void {
		if (!this.natural) return;
		this.zoomMode = mode;
		this.view = fitView(this.natural, this.stageSize(), mode);
		this.applyView(animate);
		if (animate) this.flashZoom();
	}

	private zoomTo(scale: number, point: Point, animate: boolean): void {
		if (!this.natural) return;
		this.zoomMode = "manual";
		this.view = zoomAround(this.view, scale, point, this.natural, this.stageSize());
		this.applyView(animate);
		this.flashZoom();
	}

	private zoomStep(factor: number): void {
		this.zoomTo(this.view.scale * factor, this.stageCenter(), true);
	}

	private pan(dx: number, dy: number): void {
		if (!this.natural) return;
		this.view = panBy(this.view, dx, dy, this.natural, this.stageSize());
		// Panning a fitted long image keeps "fit width" for resizes.
		if (this.zoomMode === "contain") this.zoomMode = "manual";
		this.applyView(false);
	}

	private flashZoom(): void {
		const badge = this.zoomBadge;
		if (!badge) return;
		badge.setText(`${zoomPercent(this.view.scale)}%`);
		badge.addClass("oss-gallery-show");
		if (this.zoomBadgeTimer !== null) window.clearTimeout(this.zoomBadgeTimer);
		this.zoomBadgeTimer = window.setTimeout(() => {
			badge.removeClass("oss-gallery-show");
			this.zoomBadgeTimer = null;
		}, ZOOM_BADGE_MS);
	}

	/** Re-fit while the user hasn't zoomed; otherwise keep the zoom and re-clamp. */
	private onResize(): void {
		if (!this.natural) return;
		if (this.zoomMode === "manual") {
			this.view = panBy(this.view, 0, 0, this.natural, this.stageSize());
			this.applyView(false);
		} else if (this.zoomMode === "width") {
			// Keep the scroll position of a long image (relative), refit the width.
			const before = this.view;
			const fitted = fitView(this.natural, this.stageSize(), "width");
			const ratio = fitted.scale / before.scale;
			this.view = panBy({ scale: fitted.scale, x: fitted.x, y: before.y * ratio }, 0, 0, this.natural, this.stageSize());
			this.applyView(false);
		} else {
			this.setFit("contain", false);
		}
	}

	private onWheel(event: WheelEvent): void {
		if (!this.natural) return;
		event.preventDefault();
		// Fit width: the wheel scrolls the long image; Ctrl/pinch still zooms.
		if (!event.ctrlKey && !event.metaKey && this.zoomMode === "width") {
			this.pan(-event.deltaX, -event.deltaY);
			return;
		}
		const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
		this.zoomTo(this.view.scale * wheelZoomFactor(delta), this.stagePoint(event), false);
	}

	/** The stage point lies on the image (pointer capture retargets clicks to the stage). */
	private isOnImage(point: Point): boolean {
		if (!this.natural) return false;
		const { x, y, scale } = this.view;
		return point.x >= x && point.x <= x + this.natural.width * scale
			&& point.y >= y && point.y <= y + this.natural.height * scale;
	}

	private onDoubleClick(event: MouseEvent): void {
		if (!this.natural || !this.isOnImage(this.stagePoint(event))) return;
		event.preventDefault();
		if (doubleClickTarget(this.view) === "actual") {
			this.zoomTo(1, this.stagePoint(event), true);
		} else {
			this.setFit("contain", true);
		}
	}

	private onPointerDown(event: PointerEvent): void {
		if ((event.target as HTMLElement).closest("button")) return;
		if (event.pointerType === "mouse" && event.button !== 0) return;
		const point = this.stagePoint(event);
		this.pointers.set(event.pointerId, { target: event.target, start: point, last: point, startTime: performance.now() });
		this.stage.setPointerCapture(event.pointerId);
		if (this.pointers.size === 1) {
			this.dragged = false;
		} else if (this.pointers.size === 2) {
			const [a, b] = [...this.pointers.values()];
			if (a && b) this.pinchStart = { distance: distance(a.last, b.last), view: this.view };
			this.dragged = true;
		}
	}

	private onPointerMove(event: PointerEvent): void {
		const info = this.pointers.get(event.pointerId);
		if (!info) return;
		const point = this.stagePoint(event);
		const dx = point.x - info.last.x;
		const dy = point.y - info.last.y;
		info.last = point;

		if (this.pointers.size >= 2 && this.pinchStart && this.natural) {
			const [a, b] = [...this.pointers.values()];
			if (!a || !b || this.pinchStart.distance <= 0) return;
			const scale = this.pinchStart.view.scale * (distance(a.last, b.last) / this.pinchStart.distance);
			this.zoomTo(scale, midpoint(a.last, b.last), false);
			return;
		}

		if (!this.dragged && distance(point, info.start) > DRAG_SLOP) {
			this.dragged = true;
		}
		if (this.dragged && this.isPannable()) {
			this.stage.addClass("oss-gallery-is-dragging");
			this.pan(dx, dy);
		}
	}

	private onPointerUp(event: PointerEvent): void {
		const info = this.pointers.get(event.pointerId);
		if (!info) return;
		const wasPinch = this.pointers.size >= 2 || this.pinchStart !== null;
		this.pointers.delete(event.pointerId);
		this.stage.removeClass("oss-gallery-is-dragging");
		if (this.pointers.size > 0) return;
		this.pinchStart = null;
		if (wasPinch) return;

		if (!this.dragged) {
			// A click on the backdrop (not the image) closes the lightbox.
			if (info.target === this.stage || info.target === this.placeholderElement) {
				this.close();
			}
			return;
		}
		// Swipe only while the image fits (a drag of a zoomed image pans).
		if (!this.isPannable()) {
			const swipe = detectSwipe(info.last.x - info.start.x, info.last.y - info.start.y, performance.now() - info.startTime);
			if (swipe) this.navigate(swipe);
		}
	}

	private onPointerCancel(event: PointerEvent): void {
		this.pointers.delete(event.pointerId);
		if (this.pointers.size === 0) this.pinchStart = null;
		this.stage.removeClass("oss-gallery-is-dragging");
	}

	/**
	 * Keys: arrows pan along an axis where the image overflows, otherwise
	 * Left/Right go to the previous/next image; + / - zoom, 0 fits, 1 is 100%.
	 */
	private bindKeys(): void {
		const arrow = (dx: number, dy: number, nav: "prev" | "next" | null) => () => {
			const o = this.natural ? overflow(this.view, this.natural, this.stageSize()) : { x: false, y: false };
			if ((dx !== 0 && o.x) || (dy !== 0 && o.y)) {
				this.pan(dx, dy);
			} else if (nav) {
				this.navigate(nav);
			}
			return false;
		};
		this.scope.register(null, "ArrowLeft", arrow(KEY_PAN_STEP, 0, "prev"));
		this.scope.register(null, "ArrowRight", arrow(-KEY_PAN_STEP, 0, "next"));
		this.scope.register(null, "ArrowUp", arrow(0, KEY_PAN_STEP, null));
		this.scope.register(null, "ArrowDown", arrow(0, -KEY_PAN_STEP, null));
		const zoomIn = () => {
			this.zoomStep(ZOOM_STEP);
			return false;
		};
		const zoomOut = () => {
			this.zoomStep(1 / ZOOM_STEP);
			return false;
		};
		this.scope.register(null, "+", zoomIn);
		this.scope.register(null, "=", zoomIn);
		this.scope.register(null, "-", zoomOut);
		this.scope.register(null, "_", zoomOut);
		this.scope.register(null, "0", () => {
			this.setFit("contain", true);
			return false;
		});
		this.scope.register(null, "1", () => {
			this.zoomTo(1, this.stageCenter(), true);
			return false;
		});
	}

	onClose(): void {
		this.closed = true;
		this.loadToken++;
		this.clearLoadingTimer();
		if (this.zoomBadgeTimer !== null) {
			window.clearTimeout(this.zoomBadgeTimer);
			this.zoomBadgeTimer = null;
		}
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.pointers.clear();
		this.contentEl.empty();
		this.imgElement = null;
		this.pathElement = null;
		this.counterElement = null;
		this.loadingSpinner = null;
		this.errorElement = null;
		this.actionsElement = null;
		this.options.onClosed?.();
	}
}
