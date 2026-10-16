import { describe, expect, it } from "vitest";
import { jpegFrames, MAX_IMAGE_PIXELS, NativeImageFormat, readImageSize } from "../../src/semantic/imageHeader";
import { prepareImage } from "../../src/semantic/imageFormat";
import { be16, be32, bytes, jpeg, le16, le24, le32, Part, png } from "./imageBuilders";

function box(type: string, ...content: Part[]): Uint8Array {
	const body = bytes(...content);
	return bytes(be32(body.length + 8), type, body);
}

function avif(...sizes: Array<[number, number]>): Uint8Array {
	const ispes = sizes.map(([w, h]) => box("ispe", 0, 0, 0, 0, be32(w), be32(h)));
	return bytes(
		box("ftyp", "avif", 0, 0, 0, 0, "avifmif1"),
		box("meta", 0, 0, 0, 0, box("hdlr", 0, 0, 0, 0, 0, 0, 0, 0, "pict"), box("iprp", box("ipco", ...ispes))),
		box("mdat", 1, 2, 3)
	);
}

describe("readImageSize", () => {
	it.each([
		["png", png(640, 480), [640, 480]],
		["jpeg", jpeg(1920, 1080), [1920, 1080]],
		// An EXIF APP1 segment holding an embedded thumbnail's SOF is skipped by length.
		["jpeg", jpeg(800, 600, bytes(0xff, 0xe1, be16(12), 0xff, 0xc0, be16(11), 8, be16(9999), be16(9999), 0)), [800, 600]],
		["gif", bytes("GIF89a", le16(10), le16(10), 0, 0, 0, 0x2c, le16(0), le16(0), le16(10), le16(10), 0), [10, 10]],
		// First frame larger than the logical screen: Blink grows the image.
		["gif", bytes("GIF89a", le16(10), le16(10), 0x80, 0, 0, new Uint8Array(6), 0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, le16(5), le16(0), le16(30000), le16(20), 0), [30005, 20]],
		["bmp", bytes("BM", new Uint8Array(12), le32(40), le32(300), le32(-200 >>> 0), new Uint8Array(8)), [300, 200]],
		["bmp", bytes("BM", new Uint8Array(12), le32(12), le16(30), le16(20), new Uint8Array(4)), [30, 20]],
		["webp", bytes("RIFF", le32(30), "WEBPVP8X", le32(10), 0, 0, 0, 0, le24(4999), le24(2999)), [5000, 3000]],
		["webp", bytes("RIFF", le32(30), "WEBPVP8L", le32(10), 0x2f, le32((99) | (49 << 14)), 0), [100, 50]],
		["webp", bytes("RIFF", le32(30), "WEBPVP8 ", le32(10), 0, 0, 0, 0x9d, 0x01, 0x2a, le16(320), le16(240)), [320, 240]],
		["ico", bytes(0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, le32(0), le32(22)), [16, 16]],
		["ico", bytes(0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0, le32(33), le32(22), png(4000, 3000)), [4000, 3000]],
		["avif", avif([1024, 768], [512, 384]), [1024, 768]],
	] as Array<[NativeImageFormat, Uint8Array, [number, number]]>)("%s %#", (format, data, [width, height]) => {
		expect(readImageSize(data, format)).toEqual({ width, height });
	});

	it.each([
		["png", bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)],
		["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)],
		["jpeg", jpeg(100, 0)],
		["webp", bytes("RIFF", le32(30), "WEBPVP8 ", le32(10), 0, 0, 0, 1, 2, 3, 0, 0, 0, 0)],
		["avif", bytes(box("ftyp", "avif", 0, 0, 0, 0))],
		["gif", bytes("GIF8")],
	] as Array<[NativeImageFormat, Uint8Array]>)("unreadable %s %# -> null", (format, data) => {
		expect(readImageSize(data, format)).toBeNull();
	});

	it("finds frame headers after a scan when asked (TIFF JPEG checks)", () => {
		const twoFrames = bytes(jpeg(16, 16).subarray(0, -2), 0xff, 0xc2, be16(11), 8, be16(60000), be16(60000), 1, 1, 0x11, 0, 0xff, 0xd9);
		expect(jpegFrames(twoFrames)).toEqual([{ width: 16, height: 16 }]);
		expect(jpegFrames(twoFrames, 0, twoFrames.length, true)).toEqual([{ width: 16, height: 16 }, { width: 60000, height: 60000 }]);
	});

	it("is linear on adversarial input", () => {
		const ffs = new Uint8Array(4 << 20).fill(0xff);
		const started = Date.now();
		expect(jpegFrames(ffs, 0, ffs.length, true)).toEqual([]);
		expect(readImageSize(bytes("GIF89a", le16(1), le16(1), 0, 0, 0, new Uint8Array(1 << 20).fill(0x21)), "gif")).toEqual({ width: 1, height: 1 });
		expect(readImageSize(bytes(0, 0, 1, 0, 0xff, 0xff), "ico")).toBeNull();
		expect(Date.now() - started).toBeLessThan(2000);
	});
});

describe("prepareImage pixel limit (native formats)", () => {
	const raster = { rasterizeSvg: () => Promise.reject(new Error("unused")) };
	const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer;

	it("a 30000×30000 PNG (100 KB as 1-bit) is unsupported, not decoded", async () => {
		await expect(prepareImage(buf(png(30000, 30000)), "big.png", raster)).resolves.toMatchObject({
			kind: "unsupported",
			format: "png",
			reason: "Image is too large (30000×30000, limit 100 MP)",
		});
	});

	it("images up to the limit pass through unchanged", async () => {
		const side = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS));
		const data = buf(jpeg(side, side));
		const prepared = await prepareImage(data, "ok.jpg", raster);
		expect(prepared).toMatchObject({ kind: "embed", mime: "image/jpeg", format: "jpeg" });
		expect(prepared.kind === "embed" && prepared.bytes).toBe(data);
	});

	it("an unreadable header fails like a decode error (retried), without reaching the worker", async () => {
		await expect(prepareImage(buf(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)), "x.jpg", raster)).resolves.toMatchObject({
			kind: "failed",
			format: "jpeg",
			reason: "Could not read the JPEG image size",
		});
	});
});
