/**
 * Zoom / pan / swipe math of the image lightbox, kept free of DOM and
 * Obsidian imports so it is unit-tested.
 *
 * The image is drawn at its natural size with `transform: translate(x, y)
 * scale(s)` and `transform-origin: 0 0`, inside a viewport (the stage) of
 * `viewport` size: (x, y) is the image's top-left corner in stage pixels.
 */

export interface Size {
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}

export interface ZoomView {
	scale: number;
	x: number;
	y: number;
}

/** "contain": the whole image; "width": the image's width (long images scroll vertically). */
export type FitMode = "contain" | "width";

/** Largest zoom factor. */
export const MAX_ZOOM = 8;
/** Smallest zoom, relative to the contain-fit scale. */
export const MIN_ZOOM_OF_FIT = 1 / 4;
/** Zoom factor of one button / key step. */
export const ZOOM_STEP = 1.25;

function valid(size: Size): boolean {
	return size.width > 0 && size.height > 0 && Number.isFinite(size.width) && Number.isFinite(size.height);
}

/**
 * Scale that fits the image into the viewport. "contain" never enlarges a
 * small image beyond its natural size; "width" fills the viewport width.
 */
export function fitScale(natural: Size, viewport: Size, mode: FitMode): number {
	if (!valid(natural) || !valid(viewport)) return 1;
	if (mode === "width") {
		return viewport.width / natural.width;
	}
	return Math.min(1, viewport.width / natural.width, viewport.height / natural.height);
}

/** Allowed zoom range for this image: contain-fit / 4 .. 8x (fit itself always fits in). */
export function zoomLimits(natural: Size, viewport: Size): { min: number; max: number } {
	const contain = fitScale(natural, viewport, "contain");
	const width = fitScale(natural, viewport, "width");
	const min = contain * MIN_ZOOM_OF_FIT;
	const max = Math.max(MAX_ZOOM, contain, width);
	return { min, max };
}

export function clampScale(scale: number, natural: Size, viewport: Size): number {
	const { min, max } = zoomLimits(natural, viewport);
	if (!Number.isFinite(scale)) return min;
	return Math.min(max, Math.max(min, scale));
}

/**
 * Keep the image on screen: along an axis where it is smaller than the
 * viewport it is centered; where it is larger, no gap may open at either
 * edge (it can't be dragged off-screen).
 */
export function clampPan(view: ZoomView, natural: Size, viewport: Size): ZoomView {
	const w = natural.width * view.scale;
	const h = natural.height * view.scale;
	const clampAxis = (pos: number, length: number, room: number): number => {
		if (length <= room) return (room - length) / 2;
		return Math.min(0, Math.max(room - length, pos));
	};
	return {
		scale: view.scale,
		x: clampAxis(view.x, w, viewport.width),
		y: clampAxis(view.y, h, viewport.height),
	};
}

/** The fitted view: "contain" centered; "width" starts at the top of a long image. */
export function fitView(natural: Size, viewport: Size, mode: FitMode): ZoomView {
	const scale = fitScale(natural, viewport, mode);
	const centered = clampPan({ scale, x: 0, y: 0 }, natural, viewport);
	// clampPan puts an overflowing axis at 0 (top / left) and centers the rest.
	return centered;
}

/**
 * Zoom to `scale` keeping the image point under `point` (stage pixels)
 * where it is; the result is clamped (scale and pan).
 */
export function zoomAround(view: ZoomView, scale: number, point: Point, natural: Size, viewport: Size): ZoomView {
	const next = clampScale(scale, natural, viewport);
	const ratio = next / view.scale;
	return clampPan(
		{
			scale: next,
			x: point.x - (point.x - view.x) * ratio,
			y: point.y - (point.y - view.y) * ratio,
		},
		natural,
		viewport
	);
}

/** Move by (dx, dy) stage pixels, clamped. */
export function panBy(view: ZoomView, dx: number, dy: number, natural: Size, viewport: Size): ZoomView {
	return clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, natural, viewport);
}

/** Zoom factor for a wheel event (`deltaY` in pixels; pinch gestures send small deltas). */
export function wheelZoomFactor(deltaY: number): number {
	const clamped = Math.max(-200, Math.min(200, deltaY));
	return Math.exp(-clamped * 0.002);
}

/** The image is larger than the viewport along each axis (it can be panned there). */
export function overflow(view: ZoomView, natural: Size, viewport: Size): { x: boolean; y: boolean } {
	const eps = 0.5;
	return {
		x: natural.width * view.scale > viewport.width + eps,
		y: natural.height * view.scale > viewport.height + eps,
	};
}

/**
 * Double click: from a fit (or any zoom other than 100%) to actual pixels
 * at the click point; at 100%, back to the contain fit.
 */
export function doubleClickTarget(view: ZoomView): "actual" | "fit" {
	return Math.abs(view.scale - 1) < 0.01 ? "fit" : "actual";
}

/** Zoom percentage for display. */
export function zoomPercent(scale: number): number {
	return Math.round(scale * 100);
}

/** Minimum horizontal travel of a swipe, in CSS pixels. */
export const SWIPE_MIN_DISTANCE = 50;
/** Longest swipe gesture. */
export const SWIPE_MAX_DURATION_MS = 800;

/**
 * A horizontal swipe: right (positive dx) = previous image, left = next.
 * Mostly horizontal, long enough and quick enough; else null.
 */
export function detectSwipe(dx: number, dy: number, durationMs: number): "prev" | "next" | null {
	if (durationMs > SWIPE_MAX_DURATION_MS) return null;
	if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return null;
	if (Math.abs(dx) < Math.abs(dy) * 1.5) return null;
	return dx > 0 ? "prev" : "next";
}

/** Distance between two points (pinch). */
export function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
