/**
 * Image dimensions from file headers, without decoding (docs/semantic-search.md
 * §12). Chromium decodes a Blob to a full-size bitmap before any
 * createImageBitmap resize option applies, so the pixel limit has to be
 * enforced from the header. Pure, bounds-checked and linear in the input:
 * shared by the main thread (prepareImage) and the worker (engine.ts).
 */

export interface ImageSize {
	width: number;
	height: number;
}

/** Largest image decoded at full resolution (RGBA: 400 MB). */
export const MAX_IMAGE_PIXELS = 100_000_000;

export function has(b: Uint8Array, offset: number, length: number): boolean {
	return offset >= 0 && length >= 0 && offset + length <= b.length;
}

export function u16be(b: Uint8Array, o: number): number {
	return (b[o] << 8) | b[o + 1];
}

export function u16le(b: Uint8Array, o: number): number {
	return b[o] | (b[o + 1] << 8);
}

export function u32be(b: Uint8Array, o: number): number {
	return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

export function u32le(b: Uint8Array, o: number): number {
	return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function i32le(b: Uint8Array, o: number): number {
	return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

function ascii(b: Uint8Array, start: number, length: number): string {
	let out = "";
	for (let i = start; i < start + length && i < b.length; i++) {
		out += String.fromCharCode(b[i]);
	}
	return out;
}

function size(width: number, height: number): ImageSize | null {
	return width > 0 && height > 0 ? { width, height } : null;
}

function larger(a: ImageSize | null, b: ImageSize | null): ImageSize | null {
	if (!a) {
		return b;
	}
	if (!b) {
		return a;
	}
	return b.width * b.height > a.width * a.height ? b : a;
}

/** PNG: IHDR is the mandatory first chunk. `o` = start of the signature. */
function pngSize(b: Uint8Array, o = 0): ImageSize | null {
	if (!has(b, o, 24) || b[o] !== 0x89 || ascii(b, o + 1, 3) !== "PNG" || ascii(b, o + 12, 4) !== "IHDR") {
		return null;
	}
	return size(u32be(b, o + 16), u32be(b, o + 20));
}

/**
 * GIF: logical screen, enlarged by the first frame (Blink grows the image to
 * fit a first frame that does not fit the screen).
 */
function gifSize(b: Uint8Array): ImageSize | null {
	if (!has(b, 0, 13)) {
		return null;
	}
	let width = u16le(b, 6);
	let height = u16le(b, 8);
	const flags = b[10];
	let p = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
	while (p < b.length) {
		const block = b[p];
		if (block === 0x2c) {
			if (has(b, p, 10)) {
				width = Math.max(width, u16le(b, p + 1) + u16le(b, p + 5));
				height = Math.max(height, u16le(b, p + 3) + u16le(b, p + 7));
			}
			break;
		}
		if (block !== 0x21) {
			break;
		}
		// Extension: introducer, label, then sub-blocks up to a 0 terminator.
		p += 2;
		while (p < b.length) {
			const n = b[p];
			p += 1 + n;
			if (n === 0) {
				break;
			}
		}
	}
	return size(width, height);
}

/** BMP: BITMAPCOREHEADER (12 bytes, 16-bit dims) or a later 32-bit header. */
function bmpSize(b: Uint8Array): ImageSize | null {
	if (!has(b, 14, 4)) {
		return null;
	}
	if (u32le(b, 14) === 12) {
		return has(b, 18, 4) ? size(u16le(b, 18), u16le(b, 20)) : null;
	}
	return has(b, 18, 8) ? size(Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22))) : null;
}

/** WebP: the first chunk is VP8X (canvas), VP8L (lossless) or "VP8 " (lossy). */
function webpSize(b: Uint8Array): ImageSize | null {
	if (!has(b, 12, 8)) {
		return null;
	}
	const chunk = ascii(b, 12, 4);
	if (chunk === "VP8X") {
		if (!has(b, 24, 6)) {
			return null;
		}
		const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
		const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
		return size(w, h);
	}
	if (chunk === "VP8L") {
		if (!has(b, 20, 5) || b[20] !== 0x2f) {
			return null;
		}
		const bits = u32le(b, 21);
		return size(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
	}
	if (chunk === "VP8 ") {
		if (!has(b, 20, 10) || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
			return null;
		}
		return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
	}
	return null;
}

/** ICO/CUR: the largest entry; PNG entries carry their own IHDR. */
function icoSize(b: Uint8Array): ImageSize | null {
	if (!has(b, 0, 6)) {
		return null;
	}
	const count = u16le(b, 4);
	let best: ImageSize | null = null;
	for (let i = 0; i < count; i++) {
		const e = 6 + i * 16;
		if (!has(b, e, 16)) {
			break;
		}
		let entry = size(b[e] || 256, b[e + 1] || 256);
		const offset = u32le(b, e + 12);
		if (has(b, offset, 8) && b[offset] === 0x89 && ascii(b, offset + 1, 3) === "PNG") {
			const png = pngSize(b, offset);
			if (!png) {
				return null;
			}
			entry = png;
		} else if (has(b, offset, 12) && u32le(b, offset) >= 40) {
			// BMP entry: the DIB height covers the image and its AND mask.
			const dib = size(Math.abs(i32le(b, offset + 4)), Math.floor(Math.abs(i32le(b, offset + 8)) / 2));
			if (dib && entry && dib.width * dib.height > entry.width * entry.height) {
				entry = dib;
			}
		}
		best = larger(best, entry);
	}
	return best;
}

/**
 * AVIF: the largest `ispe` (image spatial extents) property in
 * meta/iprp/ipco. MIAF requires one for every image item, grids included.
 */
function avifSize(b: Uint8Array): ImageSize | null {
	let best: ImageSize | null = null;
	let boxes = 0;
	const walk = (start: number, end: number, depth: number): void => {
		let p = start;
		while (p + 8 <= end && boxes++ < 10_000) {
			let boxSize = u32be(b, p);
			const type = ascii(b, p + 4, 4);
			let header = 8;
			if (boxSize === 1) {
				if (p + 16 > end) {
					return;
				}
				boxSize = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12);
				header = 16;
			} else if (boxSize === 0) {
				boxSize = end - p;
			}
			if (boxSize < header || p + boxSize > end) {
				return;
			}
			const boxEnd = p + boxSize;
			if (type === "meta" && depth === 0) {
				walk(p + header + 4, boxEnd, 1);
			} else if ((type === "iprp" && depth === 1) || (type === "ipco" && depth === 2)) {
				walk(p + header, boxEnd, depth + 1);
			} else if (type === "ispe" && depth === 3 && p + header + 12 <= boxEnd) {
				best = larger(best, size(u32be(b, p + header + 4), u32be(b, p + header + 8)));
			}
			p = boxEnd;
		}
	};
	walk(0, b.length, 0);
	return best;
}

function isSof(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Frame headers (SOFn) of a JPEG stream in [start, end): {width, height} as
 * stored (height 0 = defined later by a DNL marker). Segments are skipped by
 * their length; with `throughScans` the entropy-coded data after each SOS is
 * skipped too, so frame headers hidden after a scan are found as well.
 */
export function jpegFrames(b: Uint8Array, start = 0, end = b.length, throughScans = false): ImageSize[] {
	const frames: ImageSize[] = [];
	const limit = Math.min(end, b.length);
	let p = Math.max(0, start);
	while (p + 1 < limit) {
		if (b[p] !== 0xff) {
			p++;
			continue;
		}
		const marker = b[p + 1];
		if (marker === 0xff) {
			p++;
			continue;
		}
		p += 2;
		if (marker === 0xd8 || marker === 0x01 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
			continue;
		}
		if (marker === 0xd9 || p + 2 > limit) {
			break;
		}
		const length = u16be(b, p);
		if (length < 2) {
			break;
		}
		if (isSof(marker) && p + 7 <= limit) {
			frames.push({ height: u16be(b, p + 3), width: u16be(b, p + 5) });
		}
		p += length;
		if (marker === 0xda) {
			if (!throughScans) {
				break;
			}
			while (p + 1 < limit && !(b[p] === 0xff && b[p + 1] !== 0 && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7))) {
				p++;
			}
		}
	}
	return frames;
}

/** JPEG: the frame header(s) before the first scan. */
function jpegSize(b: Uint8Array): ImageSize | null {
	let best: ImageSize | null = null;
	for (const frame of jpegFrames(b)) {
		if (frame.height === 0 || frame.width === 0) {
			return null;
		}
		best = larger(best, frame);
	}
	return best;
}

export type NativeImageFormat = "jpeg" | "png" | "gif" | "webp" | "bmp" | "ico" | "avif";

/** Size from the header, or null when it can't be read. */
export function readImageSize(bytes: Uint8Array, format: NativeImageFormat): ImageSize | null {
	switch (format) {
		case "jpeg": return jpegSize(bytes);
		case "png": return pngSize(bytes);
		case "gif": return gifSize(bytes);
		case "webp": return webpSize(bytes);
		case "bmp": return bmpSize(bytes);
		case "ico": return icoSize(bytes);
		case "avif": return avifSize(bytes);
	}
}
