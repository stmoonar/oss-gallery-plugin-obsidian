/**
 * TIFF decoding inside the semantic worker (Chromium has no TIFF decoder).
 * UTIF.js (MIT, photopea) is bundled into the worker only, never into main.js.
 *
 * Untrusted input (docs/semantic-search.md §12): UTIF.decode is never called
 * (it loops on cyclic IFD chains); tiffStructure.ts parses and checks the page
 * first. Byte-stream compressions (LZW, Deflate, PackBits) are decompressed
 * here with output capped at the expected size of each strip/tile, so a
 * decompression bomb can't allocate more than the page itself; the predictor
 * and 16-bit byte order are undone here too. UTIF.decodeImage then only copies
 * uncompressed segments (or decodes size-checked JPEG segments) and toRGBA8
 * converts the samples.
 */
import * as UTIF from "utif";
import { parseTiff, planTiffDecode, TiffIfd, TiffPlan } from "../tiffStructure";

export { MAX_TIFF_PIXELS } from "../tiffStructure";

/**
 * TIFF LZW (MSB-first codes, "early change"), decoded into `out` until EOI,
 * the end of the input or a full output buffer. Returns the bytes written.
 */
export function lzwDecode(src: Uint8Array, out: Uint8Array): number {
	const prefix = new Uint16Array(4096);
	const suffix = new Uint8Array(4096);
	const firstByte = new Uint8Array(4096);
	const lengths = new Uint16Array(4096);
	for (let i = 0; i < 256; i++) {
		suffix[i] = i;
		firstByte[i] = i;
		lengths[i] = 1;
	}
	const totalBits = src.length * 8;
	let bitPos = 0;
	let width = 9;
	let next = 258;
	let prev = -1;
	let pos = 0;
	while (bitPos + width <= totalBits && pos < out.length) {
		// Up to 12 bits starting anywhere in a byte span at most 3 bytes.
		const byte = bitPos >>> 3;
		const b1 = byte + 1 < src.length ? src[byte + 1] : 0;
		const b2 = byte + 2 < src.length ? src[byte + 2] : 0;
		const window = (src[byte] << 16) | (b1 << 8) | b2;
		const code = (window >>> (24 - (bitPos & 7) - width)) & ((1 << width) - 1);
		bitPos += width;
		if (code === 257) {
			break;
		}
		if (code === 256) {
			next = 258;
			width = 9;
			prev = -1;
			continue;
		}
		if (prev === -1) {
			if (code > 255) {
				break;
			}
			out[pos++] = code;
			prev = code;
			continue;
		}
		if (code > next || (code === next && next >= 4096)) {
			break;
		}
		if (next < 4096) {
			prefix[next] = prev;
			suffix[next] = code < next ? firstByte[code] : firstByte[prev];
			firstByte[next] = firstByte[prev];
			lengths[next] = lengths[prev] + 1;
			next++;
			if (next === (1 << width) - 1 && width < 12) {
				width++;
			}
		}
		// Write the string of `code` back to front, dropping what doesn't fit.
		const length = lengths[code];
		let c = code;
		for (let i = length - 1; i >= 0; i--) {
			if (pos + i < out.length) {
				out[pos + i] = suffix[c];
			}
			c = prefix[c];
		}
		pos = Math.min(out.length, pos + length);
		prev = code;
	}
	return pos;
}

/** PackBits into `out`, stopping at the end of either buffer. */
export function packBitsDecode(src: Uint8Array, out: Uint8Array): number {
	let i = 0;
	let pos = 0;
	while (i < src.length && pos < out.length) {
		const n = (src[i++] << 24) >> 24;
		if (n >= 0) {
			const count = Math.min(n + 1, src.length - i, out.length - pos);
			out.set(src.subarray(i, i + count), pos);
			i += n + 1;
			pos += count;
		} else if (n !== -128) {
			if (i >= src.length) {
				break;
			}
			const count = Math.min(1 - n, out.length - pos);
			out.fill(src[i++], pos, pos + count);
			pos += count;
		}
	}
	return pos;
}

/** Input fed per write: a zlib chunk inflates to at most ~1032× its size. */
const INFLATE_CHUNK = 4096;

/**
 * zlib (TIFF Deflate) into `out` with DecompressionStream, fed in small
 * chunks so at most one chunk's output is pending beyond `out`. Truncated or
 * corrupt streams keep what was decoded (pako, which UTIF uses, does the same
 * for truncated data); the rest stays zero.
 */
export async function inflateInto(src: Uint8Array, out: Uint8Array): Promise<number> {
	if (src.length === 0 || out.length === 0) {
		return 0;
	}
	const stream = new DecompressionStream("deflate");
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();
	let stopped = false;
	const pump = (async () => {
		for (let i = 0; i < src.length && !stopped; i += INFLATE_CHUNK) {
			await writer.write(src.slice(i, i + INFLATE_CHUNK));
		}
		if (!stopped) {
			await writer.close();
		}
	})().catch(() => undefined);
	let pos = 0;
	try {
		while (pos < out.length) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			const n = Math.min(value.length, out.length - pos);
			out.set(value.subarray(0, n), pos);
			pos += n;
		}
	} catch {
		// Corrupt or truncated: keep the decoded prefix.
	} finally {
		stopped = true;
		await reader.cancel().catch(() => undefined);
		await writer.abort().catch(() => undefined);
		await pump;
	}
	return pos;
}

function swap16(buf: Uint8Array): void {
	for (let i = 0; i + 1 < buf.length; i += 2) {
		const t = buf[i];
		buf[i] = buf[i + 1];
		buf[i + 1] = t;
	}
}

/** Horizontal differencing (Predictor 2) on 8-bit or little-endian 16-bit samples. */
function undoPredictor(buf: Uint8Array, rows: number, rowBytes: number, spp: number, bps: number): void {
	for (let r = 0; r < rows; r++) {
		const o = r * rowBytes;
		if (o + rowBytes > buf.length) {
			break;
		}
		if (bps === 8) {
			for (let j = spp; j < rowBytes; j++) {
				buf[o + j] += buf[o + j - spp];
			}
		} else {
			const stride = spp * 2;
			for (let j = stride; j + 1 < rowBytes; j += 2) {
				const v = (buf[o + j] | (buf[o + j + 1] << 8)) + (buf[o + j - stride] | (buf[o + j - stride + 1] << 8));
				buf[o + j] = v & 0xff;
				buf[o + j + 1] = (v >>> 8) & 0xff;
			}
		}
	}
}

/**
 * Decompress every segment into a little-endian, uncompressed TIFF buffer
 * for UTIF.decodeImage, and the page's tags rewritten to match. Output for a
 * valid file is the same as UTIF's own decompression.
 */
async function normalize(data: Uint8Array, plan: TiffPlan, littleEndian: boolean): Promise<{ buffer: ArrayBuffer; ifd: TiffIfd }> {
	const total = plan.segments.reduce((sum, s) => sum + s.decodedBytes, 0);
	const out = new Uint8Array(8 + total);
	out.set([0x49, 0x49, 42, 0, 0, 0, 0, 0]);
	const offsets: number[] = [];
	const counts: number[] = [];
	let pos = 8;
	for (const seg of plan.segments) {
		const target = out.subarray(pos, pos + seg.decodedBytes);
		const src = data.subarray(seg.offset, seg.offset + seg.length);
		switch (plan.compression) {
			case 1: target.set(src.subarray(0, target.length)); break;
			case 5: lzwDecode(src, target); break;
			case 8: case 32946: await inflateInto(src, target); break;
			case 32773: packBitsDecode(src, target); break;
		}
		if (plan.bitsPerSample === 16 && !littleEndian) {
			swap16(target);
		}
		if (plan.predictor === 2) {
			undoPredictor(target, seg.rows, plan.segmentRowBytes, plan.samplesPerPixel, plan.bitsPerSample);
		}
		offsets.push(pos);
		counts.push(seg.decodedBytes);
		pos += seg.decodedBytes;
	}
	const ifd: TiffIfd = { ...plan.ifd, t259: [1] };
	delete ifd.t317;
	delete ifd.t273;
	delete ifd.t279;
	delete ifd.t324;
	delete ifd.t325;
	if (plan.tiled) {
		// UTIF reads a lone uncompressed segment as height × row bytes, which
		// truncates a tile wider than the image; a spare entry avoids that
		// (the tile loop only visits real tiles).
		if (offsets.length === 1) {
			offsets.push(pos);
			counts.push(0);
		}
		ifd.t324 = offsets;
		ifd.t325 = counts;
	} else {
		ifd.t273 = offsets;
		ifd.t279 = counts;
	}
	return { buffer: out.buffer, ifd };
}

/** JPEG segments stay compressed; only the checked segments are passed on. */
function jpegIfd(plan: TiffPlan): TiffIfd {
	const ifd: TiffIfd = { ...plan.ifd };
	const offsets = plan.segments.map((s) => s.offset);
	const counts = plan.segments.map((s) => s.length);
	delete ifd.t273;
	delete ifd.t279;
	delete ifd.t324;
	delete ifd.t325;
	if (plan.tiled) {
		ifd.t324 = offsets;
		ifd.t325 = counts;
	} else {
		ifd.t273 = offsets;
		ifd.t279 = counts;
	}
	return ifd;
}

interface UtifPage {
	width?: number;
	height?: number;
}

/** Decode the largest decodable page of a TIFF to RGBA. Throws on unsupported or oversized files. */
export async function decodeTiff(bytes: ArrayBuffer): Promise<{ rgba: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }> {
	const data = new Uint8Array(bytes);
	const tiff = parseTiff(data);
	const plan = planTiffDecode(tiff, data);
	const { buffer, ifd } = plan.compression === 7
		? { buffer: bytes, ifd: jpegIfd(plan) }
		: await normalize(data, plan, tiff.littleEndian);
	UTIF.decodeImage(buffer, ifd, [ifd]);
	const page = ifd as unknown as UtifPage;
	const width = page.width ?? 0;
	const height = page.height ?? 0;
	if (width !== plan.width || height !== plan.height) {
		throw new Error("TIFF image could not be decoded");
	}
	const rgba = UTIF.toRGBA8(ifd);
	if (rgba.length !== width * height * 4) {
		throw new Error("TIFF variant is not supported");
	}
	return { rgba: new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.length), width, height };
}
