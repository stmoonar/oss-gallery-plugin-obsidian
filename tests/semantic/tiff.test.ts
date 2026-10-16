import { deflateSync } from "node:zlib";
import * as UTIF from "utif";
import { describe, expect, it } from "vitest";
import { detectImageFormat, prepareImage } from "../../src/semantic/imageFormat";
import { MAX_TIFF_DECODED_BYTES, parseTiff, planTiffDecode, TiffError, tiffProblem } from "../../src/semantic/tiffStructure";
import { decodeTiff, inflateInto, lzwDecode, packBitsDecode } from "../../src/semantic/worker/tiff";
import { lzwEncode, packBitsEncode, predict8, stripTiff, TiffWriter } from "./imageBuilders";

/** Minimal little-endian, uncompressed RGB TIFF (one strip). */
export function makeRgbTiff(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): ArrayBuffer {
	const data = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			data.set(pixel(x, y), (y * width + x) * 3);
		}
	}
	return stripTiff({ width, height, samples: 3, strips: [data], rowsPerStrip: height });
}

/** Deterministic noise-ish RGB samples. */
function samples(length: number, seed = 1): Uint8Array {
	const out = new Uint8Array(length);
	let s = seed;
	for (let i = 0; i < length; i++) {
		s = (s * 1103515245 + 12345) >>> 0;
		out[i] = (i % 7 < 4 ? (i >> 3) & 0xff : s >>> 24);
	}
	return out;
}

/** The pre-fix path: UTIF.decode + decodeImage + toRGBA8 on the original file. */
function legacyDecode(bytes: ArrayBuffer): Uint8Array {
	const ifds = UTIF.decode(bytes);
	UTIF.decodeImage(bytes, ifds[0], ifds);
	return UTIF.toRGBA8(ifds[0]);
}

const SAFE_TIFF = makeRgbTiff(3, 2, (x, y) => [x * 100, y * 200, 7]);

describe("decodeTiff (worker, UTIF.js)", () => {
	it("decodes an uncompressed RGB TIFF to RGBA", async () => {
		expect(detectImageFormat(SAFE_TIFF, "a.tif")).toBe("tiff");
		const { rgba, width, height } = await decodeTiff(SAFE_TIFF);
		expect([width, height]).toEqual([3, 2]);
		expect(Array.from(rgba.subarray(0, 8))).toEqual([0, 0, 7, 255, 100, 0, 7, 255]);
		expect(Array.from(rgba.subarray(12, 16))).toEqual([0, 200, 7, 255]);
	});

	it("throws on data without an image", async () => {
		const header = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		await expect(decodeTiff(header.buffer)).rejects.toThrow(/no image/);
	});

	describe("same pixels as UTIF's own decoder for valid files", () => {
		const width = 37;
		const height = 23;
		const rps = 8;
		const rgb = samples(width * height * 3);
		const strips = (encode: (s: Uint8Array) => Uint8Array, source = rgb, rowBytes = width * 3): Uint8Array[] => {
			const out: Uint8Array[] = [];
			for (let y = 0; y < height; y += rps) {
				out.push(encode(source.subarray(y * rowBytes, Math.min(height, y + rps) * rowBytes)));
			}
			return out;
		};
		const cases: Array<[string, ArrayBuffer]> = [
			["uncompressed", stripTiff({ width, height, samples: 3, rowsPerStrip: rps, strips: strips((s) => s) })],
			["LZW", stripTiff({ width, height, samples: 3, rowsPerStrip: rps, compression: 5, strips: strips(lzwEncode) })],
			["Deflate", stripTiff({ width, height, samples: 3, rowsPerStrip: rps, compression: 8, strips: strips((s) => deflateSync(s)) })],
			["PackBits", stripTiff({ width, height, samples: 3, rowsPerStrip: rps, compression: 32773, strips: strips(packBitsEncode) })],
			["LZW + predictor", stripTiff({
				width, height, samples: 3, rowsPerStrip: rps, compression: 5, predictor: 2,
				strips: strips((s) => lzwEncode(predict8(s, width * 3, 3))),
			})],
			["16-bit big-endian gray", stripTiff({
				width, height, samples: 1, bits: 16, littleEndian: false, rowsPerStrip: rps, compression: 8,
				strips: strips((s) => deflateSync(s), samples(width * height * 2, 7), width * 2),
			})],
			["bilevel WhiteIsZero", stripTiff({
				width, height, samples: 1, bits: 1, photometric: 0, rowsPerStrip: rps,
				strips: strips((s) => s, samples(Math.ceil(width / 8) * height, 3), Math.ceil(width / 8)),
			})],
		];
		it.each(cases)("%s", async (_name, tiff) => {
			const { rgba } = await decodeTiff(tiff);
			expect(new Set(rgba).size).toBeGreaterThan(1);
			expect(Array.from(rgba)).toEqual(Array.from(legacyDecode(tiff)));
		});

		it("LZW matches UTIF's _decodeLZW", () => {
			const raw = samples(20_000, 9);
			const encoded = lzwEncode(raw);
			const ours = new Uint8Array(raw.length);
			expect(lzwDecode(encoded, ours)).toBe(raw.length);
			expect(ours).toEqual(raw);
			const theirs = new Uint8Array(raw.length);
			(UTIF.decode as unknown as { _decodeLZW(d: Uint8Array, o: number, t: Uint8Array, to: number): void })._decodeLZW(encoded, 0, theirs, 0);
			expect(theirs).toEqual(raw);
		});
	});

	it("decodes tiled TIFFs, applying the predictor per tile", async () => {
		const width = 40;
		const height = 20;
		const tw = 16;
		const th = 16;
		const gray = samples(width * height, 5);
		const w = new TiffWriter();
		const tiles: number[] = [];
		const counts: number[] = [];
		for (let ty = 0; ty < height; ty += th) {
			for (let tx = 0; tx < width; tx += tw) {
				const tile = new Uint8Array(tw * th);
				for (let y = 0; y < th && ty + y < height; y++) {
					for (let x = 0; x < tw && tx + x < width; x++) {
						tile[y * tw + x] = gray[(ty + y) * width + tx + x];
					}
				}
				const encoded = lzwEncode(predict8(tile, tw, 1));
				tiles.push(w.blob(encoded));
				counts.push(encoded.length);
			}
		}
		const tiff = w.first(w.ifd([
			[256, 3, [width]], [257, 3, [height]], [258, 3, [8]], [259, 3, [5]], [262, 3, [1]],
			[277, 3, [1]], [317, 3, [2]], [322, 3, [tw]], [323, 3, [th]], [324, 4, tiles], [325, 4, counts],
		])).build();
		const { rgba } = await decodeTiff(tiff);
		const red = Array.from({ length: width * height }, (_, i) => rgba[i * 4]);
		expect(red).toEqual(Array.from(gray));
	});
});

describe("untrusted TIFF structure", () => {
	it("terminates on a self-referencing IFD (UTIF.decode would loop forever)", async () => {
		const loop = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 8, 0, 0, 0]);
		expect(parseTiff(loop).ifds).toHaveLength(1);
		await expect(decodeTiff(loop.buffer)).rejects.toThrow(TiffError);
		expect(tiffProblem(loop)).toMatch(/no image/);
	});

	it("follows a cyclic IFD chain only once and still decodes the image", async () => {
		const w = new TiffWriter();
		const strip = w.blob(new Uint8Array([1, 2, 3]));
		const a = w.ifd([[256, 3, [1]], [257, 3, [1]], [258, 3, [8, 8, 8]], [262, 3, [2]], [273, 4, [strip]], [277, 3, [3]], [279, 4, [3]]]);
		const b = w.ifd([[256, 3, [1]], [257, 3, [1]]]);
		const tiff = w.first(a).link(a, b).link(b, a).build();
		expect(parseTiff(new Uint8Array(tiff)).ifds).toHaveLength(2);
		await expect(decodeTiff(tiff)).resolves.toMatchObject({ width: 1, height: 1 });
	});

	it("caps the number of pages", () => {
		const w = new TiffWriter();
		const ifds = Array.from({ length: 100 }, () => w.ifd([[256, 3, [1]], [257, 3, [1]]]));
		ifds.slice(1).forEach((to, i) => w.link(ifds[i], to));
		expect(parseTiff(new Uint8Array(w.first(ifds[0]).build())).ifds).toHaveLength(32);
	});

	it("ignores SubIFD / EXIF pointers (UTIF recurses into them without limit)", async () => {
		const w = new TiffWriter();
		const strip = w.blob(new Uint8Array([9, 9, 9]));
		const at = w.length + (w.length % 2);
		// The SubIFD and EXIF pointers point back at this very IFD.
		const ifd = w.ifd([
			[256, 3, [1]], [257, 3, [1]], [258, 3, [8, 8, 8]], [262, 3, [2]], [273, 4, [strip]], [277, 3, [3]], [279, 4, [3]],
			[330, 4, [at, at]], [34665, 4, [at]],
		]);
		expect(ifd).toBe(at);
		await expect(decodeTiff(w.first(ifd).build())).resolves.toMatchObject({ width: 1, height: 1 });
	});

	it("drops values whose count reaches past the file instead of looping over them", () => {
		const bytes = new Uint8Array(new TiffWriter().build().byteLength + 26);
		const v = new DataView(bytes.buffer);
		bytes.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
		v.setUint16(8, 1, true);
		v.setUint16(10, 273, true);
		v.setUint16(12, 3, true);
		v.setUint32(14, 0xffffffff, true);
		v.setUint32(18, 8, true);
		const started = Date.now();
		expect(parseTiff(bytes).ifds[0].t273).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("rejects an IFD whose entry table runs past the end", () => {
		const bytes = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0xff, 0xff, 0, 0]);
		expect(() => parseTiff(bytes)).toThrow(/no image/);
	});

	it("BigTIFF is unsupported", async () => {
		const big = new Uint8Array([0x49, 0x49, 0x2b, 0, 8, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0]);
		expect(detectImageFormat(big)).toBe("tiff");
		expect(tiffProblem(big)).toBe("BigTIFF is not supported");
		await expect(prepareImage(big.buffer, "x.tif", { rasterizeSvg: () => Promise.reject(new Error("no")) }))
			.resolves.toMatchObject({ kind: "unsupported", format: "tiff", reason: "BigTIFF is not supported" });
	});

	const page = (tags: Array<[number, number, number[]]>, data = new Uint8Array(16)): ArrayBuffer => {
		const w = new TiffWriter();
		const strip = w.blob(data);
		const merged = new Map<number, [number, number, number[]]>();
		const defaults: Array<[number, number, number[]]> = [
			[258, 3, [8]], [259, 3, [1]], [262, 3, [1]], [273, 4, [strip]], [277, 3, [1]], [279, 4, [data.length]],
		];
		for (const t of [...defaults, ...tags]) {
			merged.set(t[0], t);
		}
		return w.first(w.ifd([...merged.values()])).build();
	};
	const problem = (tiff: ArrayBuffer): string | null => tiffProblem(new Uint8Array(tiff));

	it.each([
		["pixel limit", [[256, 4, [10_000]], [257, 4, [6_000]]], /too large \(10000×6000, limit 50 MP\)/],
		["decoded-bytes limit", [[256, 4, [7_000]], [257, 4, [7_000]], [258, 3, [16, 16, 16, 16]], [262, 3, [2]], [277, 3, [4]]], /too large to decode/],
		["huge tiles on a tiny image", [[256, 3, [10]], [257, 3, [10]], [322, 4, [65_535]], [323, 4, [65_535]], [324, 4, [8]], [325, 4, [1]]], /tile layout/],
		["tiny tiles on a large image", [[256, 3, [5_000]], [257, 3, [5_000]], [322, 3, [16]], [323, 3, [16]], [324, 4, [8]], [325, 4, [1]]], /tile layout/],
		["too many bits per pixel", [[256, 3, [4]], [257, 3, [4]], [258, 3, [32, 32, 32, 32, 32, 32]], [262, 3, [2]], [277, 3, [6]]], /color layout/],
		["mismatched BitsPerSample", [[256, 3, [4]], [257, 3, [4]], [258, 3, [8, 8, 8]], [262, 3, [2]], [277, 3, [1]]], /BitsPerSample/],
		["CCITT G4", [[256, 3, [4]], [257, 3, [4]], [259, 3, [4]]], /compression 4/],
		["old-style JPEG", [[256, 3, [4]], [257, 3, [4]], [259, 3, [6]]], /compression 6/],
		["planar RGB", [[256, 3, [4]], [257, 3, [4]], [258, 3, [8, 8, 8]], [262, 3, [2]], [277, 3, [3]], [284, 3, [2]]], /Planar/],
		["unknown photometric", [[256, 3, [4]], [257, 3, [4]], [262, 3, [32803]]], /color layout/],
		["strip offset past the end", [[256, 3, [4]], [257, 3, [4]], [273, 4, [1_000_000]]], /outside the file/],
		["floating-point predictor", [[256, 3, [4]], [257, 3, [4]], [317, 3, [3]]], /predictor 3/],
	] as Array<[string, Array<[number, number, number[]]>, RegExp]>)("rejects %s", (_name, tags, reason) => {
		expect(problem(page(tags))).toMatch(reason);
	});

	it("accepts the page used by those cases when nothing is wrong", () => {
		expect(problem(page([[256, 3, [4]], [257, 3, [4]]]))).toBeNull();
	});

	it("rejects JPEG segments whose frame header is larger than the strip", () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0xea, 0x60, 0xea, 0x60, 1, 1, 0x11, 0, 0xff, 0xd9]);
		const tiff = page([[256, 3, [16]], [257, 3, [16]], [259, 3, [7]], [279, 4, [jpeg.length]]], jpeg);
		expect(problem(tiff)).toMatch(/JPEG frame 60000×60000 does not fit its 16×16 segment/);
	});

	it("falls back to a smaller page when the largest is over the limit (pyramid TIFF)", () => {
		const w = new TiffWriter();
		const strip = w.blob(new Uint8Array(4));
		const big = w.ifd([[256, 4, [100_000]], [257, 4, [100_000]], [258, 3, [8]], [262, 3, [1]], [273, 4, [strip]], [279, 4, [4]]]);
		const small = w.ifd([[256, 3, [2]], [257, 3, [2]], [258, 3, [8]], [262, 3, [1]], [273, 4, [strip]], [279, 4, [4]]]);
		const bytes = new Uint8Array(w.first(big).link(big, small).build());
		expect(planTiffDecode(parseTiff(bytes), bytes)).toMatchObject({ index: 1, width: 2, height: 2 });
	});
});

describe("bounded decompression", () => {
	it("a Deflate bomb only inflates up to the strip size", async () => {
		const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024));
		const out = new Uint8Array(1000);
		const started = Date.now();
		await expect(inflateInto(bomb, out)).resolves.toBe(1000);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("a Deflate-bomb TIFF decodes to its declared size", async () => {
		const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024).fill(200));
		const tiff = stripTiff({ width: 100, height: 10, samples: 1, compression: 8, rowsPerStrip: 10, strips: [bomb] });
		const { rgba, width, height } = await decodeTiff(tiff);
		expect([width, height, rgba[0]]).toEqual([100, 10, 200]);
	});

	it("truncated Deflate data keeps the decoded prefix", async () => {
		const data = deflateSync(samples(100_000));
		const out = new Uint8Array(100_000);
		const n = await inflateInto(data.subarray(0, data.length >> 1), out);
		expect(n).toBeGreaterThan(0);
		expect(n).toBeLessThan(100_000);
	});

	it("LZW without EOI stops at the end of the input or the output", () => {
		const garbage = samples(10_000, 3);
		expect(lzwDecode(garbage, new Uint8Array(100))).toBeLessThanOrEqual(100);
		const zeros = new Uint8Array(10_000);
		expect(lzwDecode(zeros, new Uint8Array(1 << 20))).toBeLessThanOrEqual(1 << 20);
	});

	it("PackBits runs are capped at the output size", () => {
		const runs = new Uint8Array(20_000).map((_, i) => (i % 2 ? 7 : 0x81));
		const out = new Uint8Array(1000);
		expect(packBitsDecode(runs, out)).toBe(1000);
		expect(out.every((b) => b === 7)).toBe(true);
	});

	it("the decoded-bytes limit stays below what the worker can hold", () => {
		expect(MAX_TIFF_DECODED_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024);
	});
});
