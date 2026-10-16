import { describe, expect, it } from "vitest";
import { decodeTiff } from "../../src/semantic/worker/tiff";
import { detectImageFormat } from "../../src/semantic/imageFormat";

/** Minimal little-endian, uncompressed RGB TIFF (one strip). */
export function makeRgbTiff(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): ArrayBuffer {
	const entries: Array<[tag: number, type: number, count: number, value: number]> = [];
	const pixelBytes = width * height * 3;
	const ifdOffset = 8;
	const entryCount = 9;
	const ifdSize = 2 + entryCount * 12 + 4;
	const bpsOffset = ifdOffset + ifdSize;
	const dataOffset = bpsOffset + 6;
	entries.push([256, 3, 1, width]);
	entries.push([257, 3, 1, height]);
	entries.push([258, 3, 3, bpsOffset]);
	entries.push([259, 3, 1, 1]);
	entries.push([262, 3, 1, 2]);
	entries.push([273, 4, 1, dataOffset]);
	entries.push([277, 3, 1, 3]);
	entries.push([278, 3, 1, height]);
	entries.push([279, 4, 1, pixelBytes]);
	const buf = new ArrayBuffer(dataOffset + pixelBytes);
	const v = new DataView(buf);
	v.setUint8(0, 0x49);
	v.setUint8(1, 0x49);
	v.setUint16(2, 42, true);
	v.setUint32(4, ifdOffset, true);
	v.setUint16(ifdOffset, entryCount, true);
	entries.forEach(([tag, type, count, value], i) => {
		const o = ifdOffset + 2 + i * 12;
		v.setUint16(o, tag, true);
		v.setUint16(o + 2, type, true);
		v.setUint32(o + 4, count, true);
		if (type === 3 && count === 1) {
			v.setUint16(o + 8, value, true);
		} else {
			v.setUint32(o + 8, value, true);
		}
	});
	v.setUint32(ifdOffset + 2 + entryCount * 12, 0, true);
	for (let i = 0; i < 3; i++) {
		v.setUint16(bpsOffset + i * 2, 8, true);
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = pixel(x, y);
			const o = dataOffset + (y * width + x) * 3;
			v.setUint8(o, r);
			v.setUint8(o + 1, g);
			v.setUint8(o + 2, b);
		}
	}
	return buf;
}

describe("decodeTiff (worker, UTIF.js)", () => {
	it("decodes an uncompressed RGB TIFF to RGBA", () => {
		const tiff = makeRgbTiff(3, 2, (x, y) => [x * 100, y * 200, 7]);
		expect(detectImageFormat(tiff, "a.tif")).toBe("tiff");
		const { rgba, width, height } = decodeTiff(tiff);
		expect([width, height]).toEqual([3, 2]);
		expect(Array.from(rgba.subarray(0, 8))).toEqual([0, 0, 7, 255, 100, 0, 7, 255]);
		expect(Array.from(rgba.subarray(12, 16))).toEqual([0, 200, 7, 255]);
	});

	it("throws on data without an image", () => {
		const header = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(() => decodeTiff(header.buffer)).toThrow(/no image/);
	});
});
