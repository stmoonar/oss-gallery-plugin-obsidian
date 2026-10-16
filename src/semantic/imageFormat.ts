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
import { MAX_IMAGE_PIXELS, NativeImageFormat, readImageSize } from "../utils/imageHeader";
import { detectImageFormat, ImageFormat, isNativeFormat, mimeForFormat } from "../utils/imageType";
import { tiffProblem } from "./tiffStructure";

export { detectImageFormat, isNativeFormat, mimeForFormat, NATIVE_FORMATS } from "../utils/imageType";
export type { ImageFormat } from "../utils/imageType";

export type ConvertedFormat = "svg" | "tiff";

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

/** Largest SVG source accepted for rasterizing. */
export const MAX_SVG_BYTES = 10 * 1024 * 1024;

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
