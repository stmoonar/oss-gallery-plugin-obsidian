/**
 * Main thread <-> semantic worker message protocol (docs/semantic-search.md
 * §4.3). Shared by src/semantic/worker/ and the main-thread host, so it must
 * not import transformers.js, Obsidian or Node modules.
 *
 * Request:  { id, type, payload }
 * Response: { id, ok: true, result } | { id, ok: false, error: { code, message } }
 *
 * ArrayBuffers (image bytes, the ORT wasm, output vectors) are transferred,
 * never copied.
 */

/** Bumped whenever a message shape changes. The worker rejects other versions. */
export const PROTOCOL_VERSION = 2;

/** `task: search result | query: {q}` (D11). Images get no prefix. */
export const QUERY_PREFIX = "task: search result | query: ";

/** Stored/compared vector size after Matryoshka truncation (D8). */
export const EMBEDDING_DIMS = 256;

/** Bump when image decoding/resizing changes; it is part of the index header. */
export const PREPROCESS_VERSION = 1;

export type ImageTokenBudget = 70 | 140 | 280;
export const IMAGE_TOKEN_BUDGETS: readonly ImageTokenBudget[] = [70, 140, 280];

/**
 * Images per inference batch, by token budget. P0 [§3]: at 70 tokens a batch
 * of 8 runs at 235 ms/img vs 309 ms single; at 280 tokens batching gains
 * nothing and costs ~900 MB of (shared) GPU memory per batch of 4. 140 was not
 * measured; 4 keeps its per-batch patch count equal to 8 x 70.
 */
export const MAX_BATCH_BY_BUDGET: Readonly<Record<ImageTokenBudget, number>> = {
	70: 8,
	140: 4,
	280: 1,
};

export type EmbeddingMode = "query" | "index";

export interface EmbeddingConfig {
	/** 'onnx-community/embeddinggemma-2-ONNX' */
	modelId: string;
	/** Pinned Hugging Face commit (assets.ts MODEL_REVISION). */
	revision: string;
	dtype: "q4";
	/** Output dimensions after truncation. */
	dims: number;
	imageTokenBudget: ImageTokenBudget;
	/** PREPROCESS_VERSION of the code that produced the vectors. */
	preprocessVersion: number;
}

/** A model file the worker may read: path relative to the model dir and its size. */
export interface ModelFileRef {
	name: string;
	size: number;
}

export interface InitPayload {
	protocol: number;
	mode: EmbeddingMode;
	config: EmbeddingConfig;
	/** Absolute model directory (files are read from it with Node fs, never fetched). */
	modelDir: string;
	/** The only files the worker may serve to transformers.js (already size-checked). */
	files: ModelFileRef[];
	/** ORT `ort-wasm-simd-threaded.asyncify.wasm`, verified on the main thread. Transferred. */
	wasmBinary: ArrayBuffer;
	/** ORT `ort-wasm-simd-threaded.asyncify.mjs` source, verified on the main thread. */
	wasmFactory: string;
}

export interface InitResult {
	mode: EmbeddingMode;
	/** ONNX sessions created, e.g. ["model", "vision_encoder"]. */
	sessions: string[];
	loadMs: number;
	/** Files served from the model dir during load. */
	filesRead: number;
	transformersVersion: string;
}

export interface ImageInput {
	/** Caller's id, echoed back. */
	id: string;
	bytes: ArrayBuffer;
	mime: string;
}

export interface EmbedTextPayload {
	queries: string[];
}

export interface EmbedImagesPayload {
	images: ImageInput[];
}

export type ImageErrorCode = "decode" | "inference";

export type ImageEmbedding =
	| { id: string; ok: true; vector: Float32Array }
	| { id: string; ok: false; code: ImageErrorCode; message: string };

export interface EmbedTextResult {
	vectors: Float32Array[];
	ms: number;
}

export interface EmbedImagesResult {
	items: ImageEmbedding[];
	ms: number;
	/** Number of model calls (batches) used. */
	batches: number;
}

export interface PingResult {
	protocol: number;
	transformers: string;
	webgpu: boolean;
	initialized: EmbeddingMode | null;
}

export type WorkerRequest =
	| { id: number; type: "ping"; payload?: undefined }
	| { id: number; type: "init"; payload: InitPayload }
	| { id: number; type: "embedText"; payload: EmbedTextPayload }
	| { id: number; type: "embedImages"; payload: EmbedImagesPayload };

export type WorkerRequestType = WorkerRequest["type"];

export interface WorkerResultMap {
	ping: PingResult;
	init: InitResult;
	embedText: EmbedTextResult;
	embedImages: EmbedImagesResult;
}

export type WorkerErrorCode =
	/** Malformed request or protocol version mismatch. */
	| "bad-request"
	/** embed* before a successful init, or init twice. */
	| "not-initialized"
	| "already-initialized"
	/** Wrong mode, e.g. embedImages on a query worker. */
	| "unsupported"
	/** Model/runtime failed to load (missing file, WebGPU failure...). */
	| "model-load"
	| "inference"
	/** Host side: the worker was terminated while the request was pending. */
	| "terminated"
	/** Host side: runtime file missing or failed its SHA-256 check. */
	| "runtime-verify"
	/** Host side: the worker crashed (error event). */
	| "worker-crashed"
	| "internal";

export interface WorkerErrorInfo {
	code: WorkerErrorCode;
	message: string;
}

export type WorkerResponse =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; error: WorkerErrorInfo };

export class EmbeddingError extends Error {
	constructor(readonly code: WorkerErrorCode, message: string) {
		super(message);
		this.name = "EmbeddingError";
	}
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as { id?: unknown; ok?: unknown };
	return typeof v.id === "number" && typeof v.ok === "boolean";
}

/** Truncate to `dims` and L2-normalize (Matryoshka). Zero vectors stay zero. */
export function truncateAndNormalize(source: ArrayLike<number>, dims: number): Float32Array {
	if (source.length < dims) {
		throw new Error(`Embedding has ${source.length} dims, expected at least ${dims}`);
	}
	const out = new Float32Array(dims);
	let sum = 0;
	for (let i = 0; i < dims; i++) {
		const x = source[i];
		out[i] = x;
		sum += x * x;
	}
	const norm = Math.sqrt(sum);
	if (norm > 0) {
		for (let i = 0; i < dims; i++) {
			out[i] /= norm;
		}
	}
	return out;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
	const n = Math.min(a.length, b.length);
	let s = 0;
	for (let i = 0; i < n; i++) {
		s += a[i] * b[i];
	}
	return s;
}

export function l2norm(a: ArrayLike<number>): number {
	return Math.sqrt(dot(a, a));
}

/** Split `count` items into consecutive batches of at most `maxBatch`. */
export function planBatches(count: number, maxBatch: number): Array<[start: number, end: number]> {
	const size = Math.max(1, Math.floor(maxBatch));
	const out: Array<[number, number]> = [];
	for (let start = 0; start < count; start += size) {
		out.push([start, Math.min(count, start + size)]);
	}
	return out;
}

export function maxBatchFor(budget: number): number {
	return (MAX_BATCH_BY_BUDGET as Record<number, number | undefined>)[budget] ?? 1;
}

/**
 * Longest-side cap for decoded images, so a 6000x4000 photo is not copied
 * around at full size before the image processor resizes it to at most
 * `budget * 9` patches of 16x16 px. 4x the processor's pixel target keeps the
 * processor's own resize in charge of the final size.
 */
export function decodePixelCap(budget: number): number {
	return Math.max(1_000_000, budget * 9 * 256 * 4);
}

/** Target size for a decode-time downscale, or null when the image is small enough. */
export function decodeSize(
	width: number,
	height: number,
	pixelCap: number
): { width: number; height: number } | null {
	if (width <= 0 || height <= 0 || width * height <= pixelCap) {
		return null;
	}
	const scale = Math.sqrt(pixelCap / (width * height));
	return {
		width: Math.max(1, Math.floor(width * scale)),
		height: Math.max(1, Math.floor(height * scale)),
	};
}
