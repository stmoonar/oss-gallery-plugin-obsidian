import { describe, expect, it } from "vitest";
import {
	clampPan,
	clampScale,
	detectSwipe,
	doubleClickTarget,
	fitScale,
	fitView,
	overflow,
	panBy,
	wheelZoomFactor,
	zoomAround,
	zoomLimits,
	zoomPercent,
} from "../../src/components/zoomMath";

const viewport = { width: 1000, height: 800 };
const big = { width: 4000, height: 2000 };
const small = { width: 200, height: 100 };
const tall = { width: 500, height: 5000 };

describe("fit", () => {
	it("contain fits the whole image, never enlarging small ones", () => {
		expect(fitScale(big, viewport, "contain")).toBeCloseTo(0.25);
		expect(fitScale(small, viewport, "contain")).toBe(1);
		expect(fitScale(tall, viewport, "contain")).toBeCloseTo(0.16);
	});

	it("width fills the viewport width", () => {
		expect(fitScale(tall, viewport, "width")).toBeCloseTo(2);
		expect(fitScale(big, viewport, "width")).toBeCloseTo(0.25);
	});

	it("invalid sizes fall back to 1", () => {
		expect(fitScale({ width: 0, height: 10 }, viewport, "contain")).toBe(1);
		expect(fitScale(big, { width: 0, height: 0 }, "contain")).toBe(1);
	});

	it("contain view is centered", () => {
		const v = fitView(big, viewport, "contain");
		expect(v.scale).toBeCloseTo(0.25);
		expect(v.x).toBeCloseTo(0);
		expect(v.y).toBeCloseTo((800 - 500) / 2);
	});

	it("width view of a long image starts at the top", () => {
		const v = fitView(tall, viewport, "width");
		expect(v.scale).toBeCloseTo(2);
		expect(v.x).toBeCloseTo(0);
		expect(v.y).toBe(0);
		expect(overflow(v, tall, viewport)).toEqual({ x: false, y: true });
	});
});

describe("zoom", () => {
	it("limits are fit/4 .. 8x", () => {
		const { min, max } = zoomLimits(big, viewport);
		expect(min).toBeCloseTo(0.0625);
		expect(max).toBe(8);
		expect(clampScale(100, big, viewport)).toBe(8);
		expect(clampScale(0.001, big, viewport)).toBeCloseTo(0.0625);
		expect(clampScale(Number.NaN, big, viewport)).toBeCloseTo(0.0625);
	});

	it("fit width above 8x is still reachable", () => {
		const thin = { width: 10, height: 5000 };
		expect(zoomLimits(thin, viewport).max).toBeCloseTo(100);
	});

	it("keeps the point under the cursor in place", () => {
		const start = { scale: 1, x: 0, y: 0 };
		const point = { x: 300, y: 200 };
		const v = zoomAround(start, 2, point, big, viewport);
		expect(v.scale).toBe(2);
		// Image point under the cursor before: (300, 200); after: same stage point.
		expect((point.x - v.x) / v.scale).toBeCloseTo(300);
		expect((point.y - v.y) / v.scale).toBeCloseTo(200);
	});

	it("zooming out below the viewport recenters", () => {
		const v = zoomAround({ scale: 1, x: -500, y: -500 }, 0.1, { x: 0, y: 0 }, big, viewport);
		expect(v.scale).toBeCloseTo(0.1);
		expect(v.x).toBeCloseTo((1000 - 400) / 2);
		expect(v.y).toBeCloseTo((800 - 200) / 2);
	});

	it("wheel factor zooms in on negative delta, bounded", () => {
		expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
		expect(wheelZoomFactor(100)).toBeLessThan(1);
		expect(wheelZoomFactor(10000)).toBeCloseTo(wheelZoomFactor(200));
	});

	it("double click toggles between 100% and fit", () => {
		expect(doubleClickTarget({ scale: 0.25, x: 0, y: 0 })).toBe("actual");
		expect(doubleClickTarget({ scale: 1, x: 0, y: 0 })).toBe("fit");
		expect(zoomPercent(0.256)).toBe(26);
	});
});

describe("pan", () => {
	it("cannot drag the image off-screen", () => {
		const v = { scale: 1, x: 0, y: 0 };
		expect(panBy(v, 500, 500, big, viewport)).toEqual({ scale: 1, x: 0, y: 0 });
		const far = panBy(v, -10000, -10000, big, viewport);
		expect(far.x).toBe(1000 - 4000);
		expect(far.y).toBe(800 - 2000);
	});

	it("centers an axis that fits", () => {
		const v = clampPan({ scale: 1, x: 999, y: -999 }, small, viewport);
		expect(v.x).toBe(400);
		expect(v.y).toBe(350);
	});
});

describe("swipe", () => {
	it("detects quick horizontal swipes", () => {
		expect(detectSwipe(120, 10, 200)).toBe("prev");
		expect(detectSwipe(-120, 10, 200)).toBe("next");
	});

	it("ignores short, slow or vertical gestures", () => {
		expect(detectSwipe(20, 0, 100)).toBeNull();
		expect(detectSwipe(200, 0, 2000)).toBeNull();
		expect(detectSwipe(100, 90, 100)).toBeNull();
	});
});
