/**
 * Image format handling for indexing (docs/semantic-search.md §12).
 *
 * The worker decodes with Chromium's image decoder (createImageBitmap), which
 * reads JPEG, PNG, WebP, GIF (first frame), BMP, ICO and AVIF. Other formats:
 * - SVG: rasterized on the main thread (workers cannot decode SVG), then sent
 *   as PNG -> status "converted".
 * - TIFF: structure and size checked here (tiffStructure.ts), decoded inside
 *   the worker with UTIF.js -> status "converted". BigTIFF, unsupported
 *   variants and oversized pages are "unsupported".
 * - HEIC/HEIF, PSD, camera RAW, unrecognized bytes: status "unsupported",
 *   never retried until the object changes.
 *
 * Native formats are checked against MAX_IMAGE_PIXELS from their header:
 * Chromium decodes a Blob at full resolution before any resize applies, so a
 * small file with huge dimensions (a 30000×30000 1-bit PNG is ~100 KB) would
 * otherwise allocate gigabytes in the worker.
 *
 * Detection trusts the bytes (magic numbers) over the file extension. Pure
 * module apart from the injected SVG rasterizer.
 */
import { MAX_IMAGE_PIXELS, NativeImageFormat, readImageSize } from "./imageHeader";
import { tiffProblem } from "./tiffStructure";

export type ImageFormat =
	| "jpeg" | "png" | "gif" | "webp" | "bmp" | "ico" | "avif"
	| "svg" | "tiff"
	| "heic" | "psd" | "raw" | "unknown";

export type ConvertedFormat = "svg" | "tiff";

export const NATIVE_FORMATS: ReadonlySet<ImageFormat> = new Set<ImageFormat>([
	"jpeg", "png", "gif", "webp", "bmp", "ico", "avif",
]);

export function isNativeFormat(format: ImageFormat): format is NativeImageFormat {
	return NATIVE_FORMATS.has(format);
}

/**
 * Why the worker must not decode these native-format bytes, or null. Also
 * checked inside the worker. "unreadable" = no size in the header (corrupt or
 * truncated, so a decode error anyway: retried like one); "too-large" = over
 * MAX_IMAGE_PIXELS (permanent).
 */
export function nativeImageProblem(
	bytes: Uint8Array,
	format: NativeImageFormat
): { kind: "unreadable" | "too-large"; reason: string } | null {
	const size = readImageSize(bytes, format);
	if (!size) {
		return { kind: "unreadable", reason: `Could not read the ${format.toUpperCase()} image size` };
	}
	if (size.width * size.height > MAX_IMAGE_PIXELS) {
		return {
			kind: "too-large",
			reason: `Image is too large (${size.width}×${size.height}, limit ${MAX_IMAGE_PIXELS / 1_000_000} MP)`,
		};
	}
	return null;
}

const MIME: Partial<Record<ImageFormat, string>> = {
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	ico: "image/x-icon",
	avif: "image/avif",
	tiff: "image/tiff",
	svg: "image/svg+xml",
};

/** Camera RAW extensions; most are TIFF containers, so check before TIFF. */
const RAW_EXTENSIONS = new Set(["cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "pef", "srw", "x3f", "3fr", "erf", "kdc", "mrw"]);

/** Largest SVG source accepted for rasterizing. */
export const MAX_SVG_BYTES = 10 * 1024 * 1024;

function ascii(bytes: Uint8Array, start: number, length: number): string {
	let out = "";
	for (let i = start; i < start + length && i < bytes.length; i++) {
		out += String.fromCharCode(bytes[i]);
	}
	return out;
}

function extensionOf(key: string): string {
	const name = key.split("/").pop() ?? key;
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** ISO-BMFF brands: AVIF vs HEIF family. */
function ftypFormat(bytes: Uint8Array): ImageFormat | null {
	if (bytes.length < 12 || ascii(bytes, 4, 4) !== "ftyp") {
		return null;
	}
	const boxSize = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
	const end = Math.min(bytes.length, Math.max(16, boxSize));
	const brands: string[] = [ascii(bytes, 8, 4)];
	for (let i = 16; i + 4 <= end; i += 4) {
		brands.push(ascii(bytes, i, 4));
	}
	if (brands.some((b) => b === "avif" || b === "avis")) {
		return "avif";
	}
	if (brands.some((b) => ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(b))) {
		return "heic";
	}
	return "unknown";
}

function looksLikeSvg(bytes: Uint8Array): boolean {
	let head = ascii(bytes, 0, 2048);
	if (head.startsWith("ï»¿")) {
		head = head.slice(3);
	}
	head = head.trimStart().toLowerCase();
	if (!head.startsWith("<")) {
		return false;
	}
	return head.includes("<svg");
}

/** Detect the format from the bytes; the key's extension only breaks ties (RAW). */
export function detectImageFormat(data: ArrayBuffer | Uint8Array, key = ""): ImageFormat {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const ext = extensionOf(key);
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "jpeg";
	}
	if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") {
		return "png";
	}
	if (ascii(bytes, 0, 4) === "GIF8") {
		return "gif";
	}
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
		return "webp";
	}
	if (ascii(bytes, 0, 2) === "BM" && bytes.length >= 26) {
		return "bmp";
	}
	if (bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0) {
		return "ico";
	}
	const ftyp = ftypFormat(bytes);
	if (ftyp) {
		return ftyp;
	}
	if (ascii(bytes, 0, 4) === "8BPS") {
		return "psd";
	}
	const tiffMagic = (bytes[0] === 0x49 && bytes[1] === 0x49 && (bytes[2] === 0x2a || bytes[2] === 0x2b) && bytes[3] === 0)
		|| (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && (bytes[3] === 0x2a || bytes[3] === 0x2b));
	if (tiffMagic || ascii(bytes, 0, 4) === "FUJI" || ascii(bytes, 0, 4) === "IIRO" || ascii(bytes, 0, 4) === "IIU\u0000") {
		return RAW_EXTENSIONS.has(ext) || !tiffMagic ? "raw" : "tiff";
	}
	if (looksLikeSvg(bytes)) {
		return "svg";
	}
	return "unknown";
}

export function mimeForFormat(format: ImageFormat): string {
	return MIME[format] ?? "application/octet-stream";
}

/** Bytes ready for the worker, or why they can't be indexed. */
export type PreparedImage =
	| { kind: "embed"; bytes: ArrayBuffer; mime: string; format: ImageFormat; convertedFrom?: ConvertedFormat }
	| { kind: "unsupported"; format: ImageFormat; reason: string }
	| { kind: "failed"; format: ImageFormat; reason: string };

export interface PrepareOptions {
	/** SVG -> PNG on the main thread (svgRasterizer.ts); throws on failure. */
	rasterizeSvg(bytes: ArrayBuffer): Promise<ArrayBuffer>;
}

const UNSUPPORTED_REASON: Partial<Record<ImageFormat, string>> = {
	heic: "HEIC/HEIF is not supported",
	psd: "PSD is not supported",
	raw: "Camera RAW is not supported",
	unknown: "Unrecognized image data",
};

/**
 * Classify `bytes` and convert what needs converting. SVG rasterizing errors
 * are "failed" (retried with backoff, like any decode error of a supported
 * format); unknown formats are "unsupported" (never retried).
 */
export async function prepareImage(bytes: ArrayBuffer, key: string, options: PrepareOptions): Promise<PreparedImage> {
	const format = detectImageFormat(bytes, key);
	if (isNativeFormat(format)) {
		const problem = nativeImageProblem(new Uint8Array(bytes), format);
		if (problem) {
			return { kind: problem.kind === "too-large" ? "unsupported" : "failed", format, reason: problem.reason };
		}
		return { kind: "embed", bytes, mime: mimeForFormat(format), format };
	}
	if (format === "tiff") {
		let problem: string | null;
		try {
			problem = tiffProblem(new Uint8Array(bytes));
		} catch (error) {
			return { kind: "failed", format, reason: `TIFF check: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (problem) {
			return { kind: "unsupported", format, reason: problem };
		}
		return { kind: "embed", bytes, mime: mimeForFormat(format), format, convertedFrom: "tiff" };
	}
	if (format === "svg") {
		if (bytes.byteLength > MAX_SVG_BYTES) {
			return { kind: "unsupported", format, reason: "SVG is larger than 10 MB" };
		}
		try {
			const png = await options.rasterizeSvg(bytes);
			return { kind: "embed", bytes: png, mime: "image/png", format, convertedFrom: "svg" };
		} catch (error) {
			return { kind: "failed", format, reason: `SVG rasterize: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	return { kind: "unsupported", format, reason: UNSUPPORTED_REASON[format] ?? `${format} is not supported` };
}
