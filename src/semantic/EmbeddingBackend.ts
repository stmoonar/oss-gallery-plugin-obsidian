/**
 * Embedding backends (docs/semantic-search.md §4.3).
 *
 * - WorkerEmbeddingBackend (./WorkerEmbeddingBackend.ts): the real one, a
 *   transformers.js Web Worker on WebGPU.
 * - FakeEmbeddingBackend (below): deterministic vectors without a GPU, for
 *   tests and for building the index/search layers (P3).
 *
 * Every returned vector is truncated to `cfg.dims` and L2-normalized, so the
 * similarity of two vectors is their dot product.
 */
import {
	EmbeddingConfig,
	EmbeddingError,
	EncodedThumbnail,
	EmbeddingMode,
	ImageEmbedding,
	ImageInput,
	truncateAndNormalize,
} from "./protocol";
import { MODEL_ID, MODEL_REVISION } from "./assets";
import { EMBEDDING_DIMS, ImageTokenBudget, PREPROCESS_VERSION } from "./protocol";

export type { EmbeddingConfig, EmbeddingMode, ImageEmbedding, ImageInput } from "./protocol";

export interface BackendInitInfo {
	mode: EmbeddingMode;
	sessions: string[];
	/** Worker-side model load time. */
	loadMs: number;
	/** Host-side time spent verifying runtime files before the worker started. */
	verifyMs: number;
}

export interface EmbeddingBackend {
	/** 'query' loads the text model only; 'index' loads text + vision. */
	init(mode: EmbeddingMode, cfg: EmbeddingConfig): Promise<BackendInitInfo>;
	/** Adds the query prefix, truncates and normalizes. One vector per query. */
	embedText(queries: string[]): Promise<Float32Array[]>;
	/**
	 * Batched internally; one result per input, in order. Failures are per
	 * image. Inputs with `thumbnail` set may come back with a thumbnail
	 * (only together with a vector; never required).
	 */
	embedImages(images: ImageInput[]): Promise<ImageEmbedding[]>;
	/** Terminates the worker (D13: never reuse it). Pending requests reject. */
	dispose(): Promise<void>;
}

/** The configuration this build produces vectors for (the index header). */
export function currentEmbeddingConfig(imageTokenBudget: ImageTokenBudget): EmbeddingConfig {
	return {
		modelId: MODEL_ID,
		revision: MODEL_REVISION,
		dtype: "q4",
		dims: EMBEDDING_DIMS,
		imageTokenBudget,
		preprocessVersion: PREPROCESS_VERSION,
	};
}

/** FNV-1a 32-bit over bytes. */
export function fnv1a(bytes: Uint8Array, seed = 0x811c9dc5): number {
	let h = seed >>> 0;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** Deterministic pseudo-random unit vector for a seed (mulberry32). */
export function seededVector(seed: number, dims: number): Float32Array {
	let a = seed >>> 0;
	const raw = new Float32Array(dims);
	for (let i = 0; i < dims; i++) {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		raw[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
	}
	return truncateAndNormalize(raw, dims);
}

/** Prefix that makes FakeEmbeddingBackend treat image bytes as a caption. */
export const FAKE_IMAGE_CAPTION_PREFIX = "fake-image:";

export interface FakeEmbeddingBackendOptions {
	/** Artificial latency per call, in ms (0 = resolve on the next microtask). */
	latencyMs?: number;
	/** Image ids that fail with a `decode` error. */
	failImageIds?: Iterable<string>;
	/** Image ids that get no thumbnail even when one is requested. */
	failThumbnailIds?: Iterable<string>;
	sleep?: (ms: number) => Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Deterministic backend: the same text always gives the same vector. An image
 * whose bytes are the UTF-8 string `fake-image:<caption>` gets exactly the
 * vector of the text `<caption>`, so tests can build "matching" pairs;
 * other images get a vector derived from their bytes.
 */
export class FakeEmbeddingBackend implements EmbeddingBackend {
	private mode: EmbeddingMode | null = null;
	private cfg: EmbeddingConfig | null = null;
	private disposed = false;
	private readonly failIds: Set<string>;
	private readonly failThumbnailIds: Set<string>;
	readonly calls: Array<{ type: "init" | "embedText" | "embedImages"; count: number }> = [];

	constructor(private readonly options: FakeEmbeddingBackendOptions = {}) {
		this.failIds = new Set(options.failImageIds ?? []);
		this.failThumbnailIds = new Set(options.failThumbnailIds ?? []);
	}

	private async delay(): Promise<void> {
		const ms = this.options.latencyMs ?? 0;
		if (ms > 0 && this.options.sleep) {
			await this.options.sleep(ms);
		} else {
			await Promise.resolve();
		}
	}

	private ready(): { mode: EmbeddingMode; cfg: EmbeddingConfig } {
		if (this.disposed) {
			throw new EmbeddingError("terminated", "Backend disposed");
		}
		if (!this.mode || !this.cfg) {
			throw new EmbeddingError("not-initialized", "Backend not initialized");
		}
		return { mode: this.mode, cfg: this.cfg };
	}

	async init(mode: EmbeddingMode, cfg: EmbeddingConfig): Promise<BackendInitInfo> {
		if (this.disposed) {
			throw new EmbeddingError("terminated", "Backend disposed");
		}
		if (this.mode) {
			throw new EmbeddingError("already-initialized", "Backend already initialized");
		}
		await this.delay();
		this.mode = mode;
		this.cfg = cfg;
		this.calls.push({ type: "init", count: 1 });
		return {
			mode,
			sessions: mode === "index" ? ["model", "vision_encoder"] : ["model"],
			loadMs: 0,
			verifyMs: 0,
		};
	}

	/** Vector of a caption, without the query prefix (shared by text and fake images). */
	vectorFor(text: string): Float32Array {
		const dims = this.cfg?.dims ?? EMBEDDING_DIMS;
		return seededVector(fnv1a(encoder.encode(text.trim().toLowerCase())), dims);
	}

	async embedText(queries: string[]): Promise<Float32Array[]> {
		this.ready();
		await this.delay();
		this.calls.push({ type: "embedText", count: queries.length });
		return queries.map((q) => this.vectorFor(q));
	}

	async embedImages(images: ImageInput[]): Promise<ImageEmbedding[]> {
		const { mode, cfg } = this.ready();
		if (mode !== "index") {
			throw new EmbeddingError("unsupported", "Query backend cannot embed images");
		}
		await this.delay();
		this.calls.push({ type: "embedImages", count: images.length });
		return images.map((img): ImageEmbedding => {
			if (this.failIds.has(img.id)) {
				return { id: img.id, ok: false, code: "decode", message: "Fake decode failure" };
			}
			const bytes = new Uint8Array(img.bytes);
			const head = decoder.decode(bytes.subarray(0, 256));
			const thumbnail = img.thumbnail && !this.failThumbnailIds.has(img.id) ? fakeThumbnail(img.id) : undefined;
			const result = (vector: Float32Array): ImageEmbedding =>
				thumbnail ? { id: img.id, ok: true, vector, thumbnail } : { id: img.id, ok: true, vector };
			if (head.startsWith(FAKE_IMAGE_CAPTION_PREFIX)) {
				const caption = decoder.decode(bytes).slice(FAKE_IMAGE_CAPTION_PREFIX.length);
				return result(this.vectorFor(caption));
			}
			return result(seededVector(fnv1a(bytes, cfg.imageTokenBudget), cfg.dims));
		});
	}

	dispose(): Promise<void> {
		this.disposed = true;
		return Promise.resolve();
	}
}

/** The thumbnail FakeEmbeddingBackend returns for image `id`: WebP-labelled UTF-8 `fake-thumb:<id>`. */
export function fakeThumbnail(id: string): EncodedThumbnail {
	const bytes = encoder.encode(`fake-thumb:${id}`);
	return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mime: "image/webp" };
}

/** Bytes of a fake image whose FakeEmbeddingBackend vector equals `caption`'s. */
export function fakeImageBytes(caption: string): ArrayBuffer {
	const bytes = encoder.encode(FAKE_IMAGE_CAPTION_PREFIX + caption);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
