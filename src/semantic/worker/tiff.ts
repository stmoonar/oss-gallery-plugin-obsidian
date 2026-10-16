/**
 * TIFF decoding inside the semantic worker (Chromium has no TIFF decoder).
 * UTIF.js (MIT, photopea) + pako (MIT/Zlib) are bundled into the worker
 * only, never into main.js. Handles uncompressed, LZW, PackBits, Deflate,
 * JPEG-in-TIFF, CCITT; the largest page is used (multi-page files often
 * carry thumbnails).
 */
import * as UTIF from "utif";

/** Refuse absurd sizes before allocating w*h*4 bytes of RGBA. */
export const MAX_TIFF_PIXELS = 64_000_000;

interface Ifd {
	t256?: number[];
	t257?: number[];
	width?: number;
	height?: number;
}

function dims(ifd: Ifd): number {
	const w = ifd.t256?.[0] ?? 0;
	const h = ifd.t257?.[0] ?? 0;
	return w * h;
}

/** Decode the largest page of a TIFF to RGBA. Throws on unsupported variants. */
export function decodeTiff(bytes: ArrayBuffer): { rgba: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
	const ifds = UTIF.decode(bytes) as Ifd[];
	let best: Ifd | null = null;
	for (const ifd of ifds) {
		if (dims(ifd) > (best ? dims(best) : 0)) {
			best = ifd;
		}
	}
	if (!best) {
		throw new Error("TIFF contains no image");
	}
	if (dims(best) > MAX_TIFF_PIXELS) {
		throw new Error(`TIFF is too large (${dims(best)} pixels)`);
	}
	UTIF.decodeImage(bytes, best, ifds);
	const width = best.width ?? 0;
	const height = best.height ?? 0;
	if (width <= 0 || height <= 0) {
		throw new Error("TIFF image could not be decoded");
	}
	const rgba = UTIF.toRGBA8(best);
	if (rgba.length !== width * height * 4) {
		throw new Error("TIFF variant is not supported");
	}
	return { rgba: new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.length), width, height };
}
