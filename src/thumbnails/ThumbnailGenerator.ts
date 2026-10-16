/**
 * Lazy thumbnails on the main thread: a gallery tile downloaded the
 * original once (for display), the same bytes become its thumbnail here,
 * off the critical path and with bounded concurrency.
 *
 * Only natively decodable still formats (JPEG, PNG, WebP, BMP, ICO, AVIF)
 * whose header size is within MAX_IMAGE_PIXELS get one: the decoder
 * allocates the full bitmap before any resize applies. GIF keeps its
 * animation (no thumbnail); SVG, TIFF and everything else get none. Never
 * imports src/semantic.
 */
import { MAX_IMAGE_PIXELS, readImageSize } from "../utils/imageHeader";
import { detectImageFormat, isNativeFormat, mimeForFormat } from "../utils/imageType";
import { EncodedThumbnail, encodeThumbnail, MAX_THUMBNAIL_BYTES } from "./encode";

/** Decode `bytes` (`mime` sniffed from them) and encode a thumbnail; null = none. */
export type ThumbnailEncoder = (bytes: ArrayBuffer, mime: string) => Promise<EncodedThumbnail | null>;

/** Concurrent decodes + encodes. */
export const DEFAULT_GENERATOR_CONCURRENCY = 2;
/**
 * Waiting jobs (each holds an original in memory); more are dropped, the
 * tile gets its thumbnail on a later view.
 */
export const DEFAULT_GENERATOR_QUEUE = 12;

/** The MIME type to decode `bytes` as, or null when they get no lazy thumbnail. */
export function lazyThumbnailMime(bytes: ArrayBuffer, key: string): string | null {
	const view = new Uint8Array(bytes);
	const format = detectImageFormat(view, key);
	if (!isNativeFormat(format) || format === "gif") {
		return null;
	}
	const size = readImageSize(view, format);
	if (!size || size.width * size.height > MAX_IMAGE_PIXELS) {
		return null;
	}
	return mimeForFormat(format);
}

/** Chromium: decode at full size, then encodeThumbnail scales it down (orientation applied by the decoder). */
export const browserThumbnailEncoder: ThumbnailEncoder = async (bytes, mime) => {
	const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
	try {
		return await encodeThumbnail(bitmap);
	} finally {
		bitmap.close();
	}
};

export interface ThumbnailGeneratorOptions {
	encode?: ThumbnailEncoder;
	maxConcurrent?: number;
	maxQueued?: number;
}

interface Job {
	bytes: ArrayBuffer;
	mime: string;
	resolve: (thumbnail: EncodedThumbnail | null) => void;
}

export class ThumbnailGenerator {
	private readonly encode: ThumbnailEncoder;
	private readonly maxConcurrent: number;
	private readonly maxQueued: number;
	private readonly queue: Job[] = [];
	private active = 0;
	private disposed = false;

	constructor(options: ThumbnailGeneratorOptions = {}) {
		this.encode = options.encode ?? browserThumbnailEncoder;
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_GENERATOR_CONCURRENCY);
		this.maxQueued = Math.max(0, options.maxQueued ?? DEFAULT_GENERATOR_QUEUE);
	}

	/** Thumbnail of an original's bytes, or null (format, size, busy, failure). Never rejects. */
	generate(bytes: ArrayBuffer, key: string): Promise<EncodedThumbnail | null> {
		if (this.disposed) {
			return Promise.resolve(null);
		}
		let mime: string | null;
		try {
			mime = lazyThumbnailMime(bytes, key);
		} catch {
			mime = null;
		}
		if (!mime) {
			return Promise.resolve(null);
		}
		if (this.active >= this.maxConcurrent && this.queue.length >= this.maxQueued) {
			return Promise.resolve(null);
		}
		const decodeAs = mime;
		return new Promise((resolve) => {
			this.queue.push({ bytes, mime: decodeAs, resolve });
			this.pump();
		});
	}

	get pending(): number {
		return this.active + this.queue.length;
	}

	private pump(): void {
		while (this.active < this.maxConcurrent && this.queue.length > 0) {
			const job = this.queue.shift() as Job;
			this.active++;
			void this.run(job).finally(() => {
				this.active--;
				this.pump();
			});
		}
	}

	private async run(job: Job): Promise<void> {
		try {
			const thumbnail = await this.encode(job.bytes, job.mime);
			job.resolve(thumbnail && thumbnail.bytes.byteLength > 0 && thumbnail.bytes.byteLength <= MAX_THUMBNAIL_BYTES ? thumbnail : null);
		} catch (error) {
			console.warn("OSS Gallery: making a local thumbnail failed", error);
			job.resolve(null);
		}
	}

	/** Drop waiting jobs (they resolve null); running ones finish. */
	dispose(): void {
		this.disposed = true;
		for (const job of this.queue.splice(0)) {
			job.resolve(null);
		}
	}
}
