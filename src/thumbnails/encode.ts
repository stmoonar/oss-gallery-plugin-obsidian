/**
 * Gallery thumbnail encoding (docs/semantic-search.md §13): a separate
 * downscaled copy of a decoded image, longest side 320 px, WebP with alpha,
 * JPEG on white where the encoder can't produce WebP.
 *
 * Used on the main thread (lazy thumbnails, ThumbnailGenerator) and inside
 * the semantic worker (thumbnails made from the bitmap decoded for the
 * embedding). DOM APIs only: no Obsidian, no Node modules, so it is safe in
 * both bundles.
 */

export interface ThumbnailRequest {
	/** Longest side in px (never upscaled). */
	maxSide: number;
	/** Encoder quality, 0..1. */
	quality: number;
}

export const THUMBNAIL_MAX_SIDE = 320;
export const THUMBNAIL_QUALITY = 0.8;
/** Larger encodings are dropped (a 320 px WebP is normally 5-40 KB). */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;
export const DEFAULT_THUMBNAIL_REQUEST: Readonly<ThumbnailRequest> = {
	maxSide: THUMBNAIL_MAX_SIDE,
	quality: THUMBNAIL_QUALITY,
};

export type ThumbnailMime = "image/webp" | "image/jpeg";

export interface EncodedThumbnail {
	/** Transferred between threads, written to disk as is. */
	bytes: ArrayBuffer;
	mime: ThumbnailMime;
}

/** Thumbnail size: longest side <= maxSide, aspect ratio kept, never upscaled. */
export function thumbnailSize(width: number, height: number, maxSide: number): { width: number; height: number } | null {
	if (!(width > 0) || !(height > 0) || !(maxSide > 0)) {
		return null;
	}
	const scale = Math.min(1, maxSide / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * Encode a thumbnail of `source` (read only: an embedding made from the same
 * bitmap is unaffected). null when it can't be made or is too big.
 */
export async function encodeThumbnail(source: ImageBitmap, request: ThumbnailRequest = DEFAULT_THUMBNAIL_REQUEST): Promise<EncodedThumbnail | null> {
	const size = thumbnailSize(source.width, source.height, request.maxSide);
	if (!size) {
		return null;
	}
	const canvas = new OffscreenCanvas(size.width, size.height);
	let scaled: ImageBitmap | null = null;
	try {
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return null;
		}
		if (size.width !== source.width || size.height !== source.height) {
			scaled = await createImageBitmap(source, {
				resizeWidth: size.width,
				resizeHeight: size.height,
				resizeQuality: "high",
			});
			ctx.drawImage(scaled, 0, 0);
		} else {
			ctx.drawImage(source, 0, 0);
		}
		let mime: ThumbnailMime = "image/webp";
		let blob = await canvas.convertToBlob({ type: mime, quality: request.quality });
		if (blob.type !== mime) {
			mime = "image/jpeg";
			// JPEG has no alpha: put white behind the drawn pixels.
			ctx.globalCompositeOperation = "destination-over";
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, size.width, size.height);
			blob = await canvas.convertToBlob({ type: mime, quality: request.quality });
			if (blob.type !== mime) {
				return null;
			}
		}
		if (blob.size === 0 || blob.size > MAX_THUMBNAIL_BYTES) {
			return null;
		}
		return { bytes: await blob.arrayBuffer(), mime };
	} finally {
		scaled?.close();
		// Release the backing store now rather than at the next GC.
		canvas.width = 0;
		canvas.height = 0;
	}
}
