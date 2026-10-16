/**
 * TIFF structure parsing and decode limits (docs/semantic-search.md §12).
 *
 * UTIF.decode trusts the file: it follows IFD "next" pointers without a
 * visited set (a self-referencing IFD loops forever), recurses into SubIFD /
 * EXIF / MakerNote pointers and loops over file-supplied value counts. So the
 * worker never calls it: `parseTiff` reads the main IFD chain itself (bounded,
 * same tag object shape as UTIF) and `planTiffDecode` checks every limit that
 * UTIF.decodeImage / toRGBA8 rely on before anything is allocated.
 *
 * Pure (no UTIF): the main thread runs the same checks in prepareImage so
 * unsupported or oversized TIFFs never reach the worker.
 */
import { has, jpegFrames, u16be, u16le, u32be, u32le } from "../utils/imageHeader";

export class TiffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TiffError";
	}
}

/** Pixel limit of the decoded page (RGBA 200 MB). */
export const MAX_TIFF_PIXELS = 50_000_000;
/** Limit of the decoded sample buffer (height × row bytes, all tiles). */
export const MAX_TIFF_DECODED_BYTES = 200_000_000;
/** Main-chain IFDs read (multi-page files); further pages are ignored. */
export const MAX_TIFF_IFDS = 32;
/** Strips or tiles of one page. */
export const MAX_TIFF_SEGMENTS = 65_536;
/** Numeric tag values read per file. */
const MAX_TAG_VALUES = 1 << 22;

/** Values of one tag, as UTIF stores them: byte types as a view, others as numbers. */
export type TagValue = number[] | Uint8Array;
export type TiffIfd = Record<string, TagValue>;

export interface ParsedTiff {
	littleEndian: boolean;
	ifds: TiffIfd[];
}

/** Bytes per value by TIFF field type (classic TIFF). */
const TYPE_SIZE: Readonly<Record<number, number>> = {
	1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4,
};

/** Read the main IFD chain. Throws TiffError for BigTIFF and broken headers. */
export function parseTiff(data: Uint8Array): ParsedTiff {
	if (!has(data, 0, 8)) {
		throw new TiffError("TIFF header is truncated");
	}
	const order = String.fromCharCode(data[0], data[1]);
	if (order !== "II" && order !== "MM") {
		throw new TiffError("Not a TIFF file");
	}
	const le = order === "II";
	const u16 = (o: number): number => (le ? u16le(data, o) : u16be(data, o));
	const u32 = (o: number): number => (le ? u32le(data, o) : u32be(data, o));
	const version = u16(2);
	if (version === 43) {
		throw new TiffError("BigTIFF is not supported");
	}
	if (version !== 42) {
		throw new TiffError("Not a TIFF file");
	}
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let valueBudget = MAX_TAG_VALUES;

	const readValues = (type: number, count: number, at: number): TagValue | null => {
		const n = TYPE_SIZE[type];
		if (type === 1 || type === 6 || type === 7) {
			return data.subarray(at, at + count);
		}
		if (type === 2 || !n || count > valueBudget) {
			return null;
		}
		valueBudget -= count;
		const out: number[] = new Array<number>(count);
		for (let j = 0; j < count; j++) {
			const o = at + j * n;
			switch (type) {
				case 3: out[j] = view.getUint16(o, le); break;
				case 8: out[j] = view.getInt16(o, le); break;
				case 4: case 13: out[j] = view.getUint32(o, le); break;
				case 9: out[j] = view.getInt32(o, le); break;
				case 5: out[j] = view.getUint32(o, le) / view.getUint32(o + 4, le); break;
				case 10: out[j] = view.getInt32(o, le) / view.getInt32(o + 4, le); break;
				case 11: out[j] = view.getFloat32(o, le); break;
				case 12: out[j] = view.getFloat64(o, le); break;
			}
		}
		return out;
	};

	const ifds: TiffIfd[] = [];
	const seen = new Set<number>();
	let offset = u32(4);
	while (offset !== 0 && ifds.length < MAX_TIFF_IFDS && !seen.has(offset)) {
		seen.add(offset);
		if (!has(data, offset, 2) || offset < 8) {
			break;
		}
		const entries = u16(offset);
		const end = offset + 2 + entries * 12;
		if (end > data.length) {
			break;
		}
		const ifd: TiffIfd = {};
		for (let i = 0; i < entries; i++) {
			const e = offset + 2 + i * 12;
			const tag = u16(e);
			const type = u16(e + 2);
			const count = u32(e + 4);
			const bytes = (TYPE_SIZE[type] ?? 0) * count;
			const at = bytes <= 4 ? e + 8 : u32(e + 8);
			// A value outside the file is dropped (only the tags the decoder
			// needs matter; planTiffDecode rejects pages missing those).
			if (!TYPE_SIZE[type] || !has(data, at, bytes)) {
				continue;
			}
			const values = readValues(type, count, at);
			if (values) {
				ifd[`t${tag}`] = values;
			}
		}
		ifds.push(ifd);
		offset = has(data, end, 4) ? u32(end) : 0;
	}
	if (ifds.length === 0) {
		throw new TiffError("TIFF contains no image");
	}
	return { littleEndian: le, ifds };
}

/** Compressions decoded: none, LZW, JPEG, Adobe Deflate, PackBits, old Deflate. */
export const TIFF_COMPRESSIONS: ReadonlySet<number> = new Set([1, 5, 7, 8, 32773, 32946]);

export interface TiffSegment {
	/** Byte range in the file, clamped to its end. */
	offset: number;
	length: number;
	/** Decoded size as UTIF lays it out, and its rows. */
	decodedBytes: number;
	rows: number;
}

export interface TiffPlan {
	/** Index of the page in ParsedTiff.ifds. */
	index: number;
	ifd: TiffIfd;
	width: number;
	height: number;
	compression: number;
	photometric: number;
	samplesPerPixel: number;
	bitsPerSample: number;
	predictor: number;
	tiled: boolean;
	/** Bytes per row of one segment (tile row or image row). */
	segmentRowBytes: number;
	segments: TiffSegment[];
}

function first(ifd: TiffIfd, tag: number): number | undefined {
	const v = ifd[`t${tag}`];
	return v && v.length > 0 ? v[0] : undefined;
}

function positiveInt(value: number | undefined, what: string): number {
	if (value === undefined || !Number.isInteger(value) || value < 1) {
		throw new TiffError(`TIFF ${what} is missing or invalid`);
	}
	return value;
}

/** Sample layouts UTIF.toRGBA8 converts, by PhotometricInterpretation. */
function checkColor(ifd: TiffIfd, photometric: number, spp: number, bps: number, compression: number): void {
	const ok = (() => {
		switch (photometric) {
			case 0: return spp === 1 && [1, 4, 8].includes(bps);
			case 1: return spp === 1 && [1, 2, 8, 16].includes(bps);
			case 2: return (spp === 3 || spp === 4) && (bps === 8 || bps === 16);
			case 3: return spp === 1 && bps === 8 && (ifd.t320?.length ?? 0) >= 768;
			case 5: return (spp === 4 || spp === 5) && bps === 8;
			case 6: return compression === 7 && spp === 3 && bps === 8;
			default: return false;
		}
	})();
	if (!ok) {
		throw new TiffError(`TIFF color layout is not supported (photometric ${photometric}, ${spp} × ${bps}-bit samples)`);
	}
	if (compression === 7 && (bps !== 8 || ![1, 2, 6].includes(photometric))) {
		throw new TiffError("TIFF JPEG variant is not supported");
	}
}

function checkJpegSegment(data: Uint8Array, tables: TagValue | undefined, seg: TiffSegment, maxWidth: number, maxHeight: number): void {
	const frames = jpegFrames(data, seg.offset, seg.offset + seg.length, true);
	if (tables instanceof Uint8Array) {
		frames.push(...jpegFrames(tables, 0, tables.length, true));
	}
	if (frames.length === 0) {
		throw new TiffError("TIFF JPEG data has no frame header");
	}
	for (const f of frames) {
		if (f.width < 1 || f.height < 1 || f.width > maxWidth || f.height > maxHeight) {
			throw new TiffError(`TIFF JPEG frame ${f.width}×${f.height} does not fit its ${maxWidth}×${maxHeight} segment`);
		}
	}
}

function planPage(data: Uint8Array, ifd: TiffIfd, index: number): TiffPlan {
	const width = positiveInt(first(ifd, 256), "width");
	const height = positiveInt(first(ifd, 257), "height");
	if (width * height > MAX_TIFF_PIXELS) {
		throw new TiffError(`TIFF is too large (${width}×${height}, limit ${MAX_TIFF_PIXELS / 1_000_000} MP)`);
	}
	const compression = first(ifd, 259) ?? 1;
	if (!TIFF_COMPRESSIONS.has(compression)) {
		throw new TiffError(`TIFF compression ${compression} is not supported`);
	}
	const photometric = first(ifd, 262);
	if (photometric === undefined) {
		throw new TiffError("TIFF PhotometricInterpretation is missing");
	}
	const spp = positiveInt(first(ifd, 277) ?? 1, "SamplesPerPixel");
	const bpsValues = ifd.t258 ?? [1];
	const bps = bpsValues[0];
	if (bpsValues.length !== spp || Array.from(bpsValues).some((v) => v !== bps)) {
		throw new TiffError("TIFF BitsPerSample does not match SamplesPerPixel");
	}
	checkColor(ifd, photometric, spp, bps, compression);
	if (spp > 1 && (first(ifd, 284) ?? 1) !== 1) {
		throw new TiffError("Planar TIFF (PlanarConfiguration 2) is not supported");
	}
	const predictor = first(ifd, 317) ?? 1;
	if (predictor !== 1 && !(predictor === 2 && compression !== 7 && (bps === 8 || bps === 16))) {
		throw new TiffError(`TIFF predictor ${predictor} is not supported here`);
	}

	const bitsPerPixel = bps * spp;
	const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
	if (height * rowBytes > MAX_TIFF_DECODED_BYTES) {
		throw new TiffError("TIFF is too large to decode");
	}

	const tiled = ifd.t322 !== undefined || ifd.t323 !== undefined;
	let offsets: TagValue | undefined;
	let counts: TagValue | undefined;
	const layout: Array<{ rows: number; decodedBytes: number }> = [];
	let segmentRowBytes: number;
	let maxSegmentWidth: number;
	let maxSegmentHeight: number;
	if (tiled) {
		const tw = positiveInt(first(ifd, 322), "TileWidth");
		const th = positiveInt(first(ifd, 323), "TileLength");
		const tiles = Math.ceil(width / tw) * Math.ceil(height / th);
		// UTIF's tile buffer: ceil(tw*th*bpp/8), zero-filled for every tile.
		const tileBytes = Math.ceil((tw * th * bitsPerPixel) / 8);
		if (tiles > MAX_TIFF_SEGMENTS || tiles * tileBytes > MAX_TIFF_DECODED_BYTES) {
			throw new TiffError("TIFF tile layout is too large to decode");
		}
		segmentRowBytes = Math.ceil((tw * bitsPerPixel) / 8);
		for (let i = 0; i < tiles; i++) {
			layout.push({ rows: th, decodedBytes: tileBytes });
		}
		offsets = ifd.t324 ?? ifd.t273;
		counts = ifd.t325 ?? ifd.t279;
		maxSegmentWidth = tw;
		maxSegmentHeight = th;
	} else {
		const rps = Math.min(positiveInt(first(ifd, 278) ?? height, "RowsPerStrip"), height);
		const strips = Math.ceil(height / rps);
		if (strips > MAX_TIFF_SEGMENTS) {
			throw new TiffError("TIFF has too many strips");
		}
		segmentRowBytes = rowBytes;
		for (let i = 0; i < strips; i++) {
			const rows = Math.min(rps, height - i * rps);
			layout.push({ rows, decodedBytes: rows * rowBytes });
		}
		offsets = ifd.t273 ?? ifd.t324;
		counts = ifd.t279 ?? ifd.t325;
		maxSegmentWidth = width;
		maxSegmentHeight = rps;
	}
	if (!offsets || offsets.length < layout.length) {
		throw new TiffError("TIFF strip/tile offsets are missing or incomplete");
	}
	// UTIF reads a single uncompressed strip as height × row bytes whatever
	// its byte count says; every other segment needs a count.
	const implicitCount = compression === 1 && offsets.length === 1;
	if (!implicitCount && (!counts || counts.length < layout.length)) {
		throw new TiffError("TIFF strip/tile byte counts are missing or incomplete");
	}

	const segments: TiffSegment[] = layout.map((seg, i) => {
		const offset = offsets[i];
		if (!Number.isInteger(offset) || offset < 0 || offset > data.length) {
			throw new TiffError("TIFF data offset is outside the file");
		}
		const declared = implicitCount ? seg.decodedBytes : counts[i];
		const length = Math.max(0, Math.min(Number.isFinite(declared) ? declared : 0, data.length - offset));
		return { offset, length, decodedBytes: seg.decodedBytes, rows: seg.rows };
	});
	if (compression === 7) {
		for (const seg of segments) {
			checkJpegSegment(data, ifd.t347, seg, maxSegmentWidth, maxSegmentHeight);
		}
	}
	return {
		index,
		ifd,
		width,
		height,
		compression,
		photometric,
		samplesPerPixel: spp,
		bitsPerSample: bps,
		predictor,
		tiled,
		segmentRowBytes,
		segments,
	};
}

/**
 * Pick the page to decode: the largest one that passes every check (a
 * pyramid TIFF whose full-size page is over the limit falls back to a
 * smaller level). Throws the largest page's TiffError if none does.
 */
export function planTiffDecode(tiff: ParsedTiff, data: Uint8Array): TiffPlan {
	const pages = tiff.ifds
		.map((ifd, index) => ({ ifd, index, area: (first(ifd, 256) ?? 0) * (first(ifd, 257) ?? 0) }))
		.filter((p) => p.area > 0)
		.sort((a, b) => b.area - a.area);
	if (pages.length === 0) {
		throw new TiffError("TIFF contains no image");
	}
	let firstError: TiffError | null = null;
	for (const page of pages) {
		try {
			return planPage(data, page.ifd, page.index);
		} catch (error) {
			if (!(error instanceof TiffError)) {
				throw error;
			}
			firstError ??= error;
		}
	}
	throw firstError as TiffError;
}

/** Main-thread check: why this TIFF can't be decoded, or null. */
export function tiffProblem(data: Uint8Array): string | null {
	try {
		planTiffDecode(parseTiff(data), data);
		return null;
	} catch (error) {
		if (error instanceof TiffError) {
			return error.message;
		}
		throw error;
	}
}
