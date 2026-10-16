import { describe, expect, it } from "vitest";
import { detectImageFormat, MAX_SVG_BYTES, prepareImage } from "../../src/semantic/imageFormat";
import { svgRasterSize } from "../../src/semantic/svgRasterizer";
import { toArrayBuffer } from "./helpers";

function bytes(...values: Array<number | string>): ArrayBuffer {
	const out: number[] = [];
	for (const v of values) {
		if (typeof v === "string") {
			for (const ch of v) out.push(ch.charCodeAt(0));
		} else {
			out.push(v);
		}
	}
	return toArrayBuffer(new Uint8Array(out));
}

const PNG = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const TIFF_LE = bytes("II", 0x2a, 0, 8, 0, 0, 0);
const TIFF_BE = bytes("MM", 0, 0x2a, 0, 0, 0, 8);
const HEIC = bytes(0, 0, 0, 24, "ftypheic", 0, 0, 0, 0, "mif1heic");
const AVIF = bytes(0, 0, 0, 28, "ftypavif", 0, 0, 0, 0, "avifmif1miaf");
const MIF1_AVIF = bytes(0, 0, 0, 24, "ftypmif1", 0, 0, 0, 0, "avifmiaf");
const SVG = toArrayBuffer(new TextEncoder().encode("﻿  <?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"));

describe("detectImageFormat", () => {
	it.each([
		[PNG, "a.jpg", "png"],
		[JPEG, "a.png", "jpeg"],
		[bytes("GIF89a", 0, 0), "a.gif", "gif"],
		[bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "), "a.webp", "webp"],
		[bytes("BM", ...new Array<number>(30).fill(0)), "a.bmp", "bmp"],
		[bytes(0, 0, 1, 0, 1, 0), "a.ico", "ico"],
		[AVIF, "a.avif", "avif"],
		[MIF1_AVIF, "a.avif", "avif"],
		[HEIC, "a.heic", "heic"],
		[TIFF_LE, "scan.tif", "tiff"],
		[TIFF_BE, "scan.tiff", "tiff"],
		[TIFF_LE, "photo.CR2", "raw"],
		[TIFF_LE, "photo.dng", "raw"],
		[bytes("8BPS", 0, 1), "a.psd", "psd"],
		[SVG, "a.svg", "svg"],
		[bytes("hello world"), "a.png", "unknown"],
		[bytes(), "empty.png", "unknown"],
	] as const)("%#: %s -> %s", (data, key, expected) => {
		expect(detectImageFormat(data, key)).toBe(expected);
	});
});

describe("prepareImage", () => {
	const raster = { rasterizeSvg: () => Promise.resolve(bytes(0x89, "PNG-from-svg")) };

	it("passes native formats through with their MIME type", async () => {
		await expect(prepareImage(JPEG, "x.jpg", raster)).resolves.toMatchObject({ kind: "embed", mime: "image/jpeg", format: "jpeg" });
	});

	it("rasterizes SVG on the main thread (converted)", async () => {
		const r = await prepareImage(SVG, "x.svg", raster);
		expect(r).toMatchObject({ kind: "embed", mime: "image/png", format: "svg", convertedFrom: "svg" });
	});

	it("sends TIFF to the worker decoder (converted)", async () => {
		await expect(prepareImage(TIFF_LE, "x.tif", raster)).resolves.toMatchObject({ kind: "embed", mime: "image/tiff", convertedFrom: "tiff" });
	});

	it.each([[HEIC, "heic"], [bytes("8BPS"), "psd"], [bytes("garbage!"), "unknown"]] as const)("marks %s unsupported", async (data, format) => {
		await expect(prepareImage(data, "x.png", raster)).resolves.toMatchObject({ kind: "unsupported", format });
	});

	it("a failing rasterizer is a (retryable) failure, a huge SVG is unsupported", async () => {
		const failing = { rasterizeSvg: () => Promise.reject(new Error("tainted")) };
		await expect(prepareImage(SVG, "x.svg", failing)).resolves.toMatchObject({ kind: "failed", reason: "SVG rasterize: tainted" });
		const huge = new Uint8Array(MAX_SVG_BYTES + 1).fill(0x20);
		huge.set(new TextEncoder().encode("<svg"), 0);
		await expect(prepareImage(toArrayBuffer(huge), "x.svg", raster)).resolves.toMatchObject({ kind: "unsupported" });
	});
});

describe("svgRasterSize", () => {
	it("scales into [512, 1024] keeping the aspect ratio", () => {
		expect(svgRasterSize(24, 12)).toEqual({ width: 512, height: 256 });
		expect(svgRasterSize(4000, 1000)).toEqual({ width: 1024, height: 256 });
		expect(svgRasterSize(800, 600)).toEqual({ width: 800, height: 600 });
		expect(svgRasterSize(0, 0)).toEqual({ width: 512, height: 512 });
	});
});
