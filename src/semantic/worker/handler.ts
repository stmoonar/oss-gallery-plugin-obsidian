/**
 * Worker-side request dispatch, independent of transformers.js so the
 * protocol (validation, prefixing, batching, per-image errors, truncation,
 * transfer lists) can be unit-tested with a fake engine. entry.ts wires it to
 * the real engine.
 */
import {
	EmbeddingMode,
	EmbedImagesResult,
	EmbedTextResult,
	ImageEmbedding,
	InitPayload,
	InitResult,
	maxBatchFor,
	PingResult,
	planBatches,
	PROTOCOL_VERSION,
	QUERY_PREFIX,
	truncateAndNormalize,
	WorkerErrorCode,
	WorkerRequest,
	WorkerResponse,
} from "../protocol";

/** Raw model output: `rows` embeddings of `dims` floats, row-major. */
export interface RawEmbeddings {
	data: ArrayLike<number>;
	rows: number;
	dims: number;
}

export interface EngineLoadResult {
	sessions: string[];
	filesRead: number;
}

/** What the handler needs from the model runtime. */
export interface Engine<Image = unknown> {
	load(payload: InitPayload): Promise<EngineLoadResult>;
	embedText(texts: string[]): Promise<RawEmbeddings>;
	decodeImage(bytes: ArrayBuffer, mime: string, budget: number): Promise<Image>;
	/** One sample per image (`processor(null, imgs.map(i => [i]))`). */
	embedImages(images: Image[], budget: number): Promise<RawEmbeddings>;
}

export interface HandlerInfo {
	transformersVersion: string;
	webgpu: boolean;
	now(): number;
}

export type Post = (message: WorkerResponse, transfer: Transferable[]) => void;

class HandlerError extends Error {
	constructor(readonly code: WorkerErrorCode, message: string) {
		super(message);
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message || error.name;
	}
	return String(error);
}

function rowsOf(raw: RawEmbeddings, expectedRows: number, dims: number): Float32Array[] {
	if (raw.rows !== expectedRows) {
		throw new HandlerError("inference", `Model returned ${raw.rows} embeddings for ${expectedRows} inputs`);
	}
	const out: Float32Array[] = [];
	for (let r = 0; r < raw.rows; r++) {
		const row = new Float32Array(raw.dims);
		for (let i = 0; i < raw.dims; i++) {
			row[i] = raw.data[r * raw.dims + i];
		}
		out.push(truncateAndNormalize(row, dims));
	}
	return out;
}

export function createWorkerHandler<Image>(engine: Engine<Image>, info: HandlerInfo, post: Post) {
	let mode: EmbeddingMode | null = null;
	let loading = false;
	let dims = 0;
	let budget = 70;
	// Requests run one at a time even if the host sends several.
	let queue: Promise<void> = Promise.resolve();

	async function init(payload: InitPayload): Promise<InitResult> {
		if (!payload || payload.protocol !== PROTOCOL_VERSION) {
			throw new HandlerError("bad-request", `Protocol mismatch: worker ${PROTOCOL_VERSION}, host ${String(payload?.protocol)}`);
		}
		if (mode !== null || loading) {
			// D13: never reload in the same worker; the host must terminate it.
			throw new HandlerError("already-initialized", "Worker already initialized; terminate it to reload");
		}
		if (payload.mode !== "query" && payload.mode !== "index") {
			throw new HandlerError("bad-request", `Unknown mode ${String(payload.mode)}`);
		}
		loading = true;
		const t0 = info.now();
		try {
			const loaded = await engine.load(payload);
			mode = payload.mode;
			dims = payload.config.dims;
			budget = payload.config.imageTokenBudget;
			return {
				mode: payload.mode,
				sessions: loaded.sessions,
				loadMs: Math.round(info.now() - t0),
				filesRead: loaded.filesRead,
				transformersVersion: info.transformersVersion,
			};
		} catch (error) {
			throw new HandlerError("model-load", errorMessage(error));
		} finally {
			loading = false;
		}
	}

	function requireMode(): EmbeddingMode {
		if (mode === null) {
			throw new HandlerError("not-initialized", "Worker not initialized");
		}
		return mode;
	}

	async function embedText(queries: unknown): Promise<EmbedTextResult> {
		requireMode();
		if (!Array.isArray(queries) || queries.some((q) => typeof q !== "string")) {
			throw new HandlerError("bad-request", "queries must be an array of strings");
		}
		const t0 = info.now();
		if (queries.length === 0) {
			return { vectors: [], ms: 0 };
		}
		let raw: RawEmbeddings;
		try {
			raw = await engine.embedText((queries as string[]).map((q) => QUERY_PREFIX + q));
		} catch (error) {
			throw new HandlerError("inference", errorMessage(error));
		}
		const vectors = rowsOf(raw, queries.length, dims);
		return { vectors, ms: Math.round(info.now() - t0) };
	}

	async function embedBatch(images: Image[]): Promise<Float32Array[]> {
		const raw = await engine.embedImages(images, budget);
		return rowsOf(raw, images.length, dims);
	}

	async function embedImages(payload: unknown): Promise<EmbedImagesResult> {
		if (requireMode() !== "index") {
			throw new HandlerError("unsupported", "This worker was loaded in query mode (text only)");
		}
		const images = (payload as { images?: unknown } | undefined)?.images;
		if (!Array.isArray(images)) {
			throw new HandlerError("bad-request", "images must be an array");
		}
		const t0 = info.now();
		const results: ImageEmbedding[] = images.map((img: { id?: unknown }) => ({
			id: String(img?.id),
			ok: false,
			code: "decode",
			message: "Not processed",
		}));
		const decoded: Array<{ index: number; image: Image }> = [];
		for (let i = 0; i < images.length; i++) {
			const item = images[i] as { bytes?: unknown; mime?: unknown };
			if (!(item?.bytes instanceof ArrayBuffer)) {
				results[i] = { id: results[i].id, ok: false, code: "decode", message: "bytes must be an ArrayBuffer" };
				continue;
			}
			try {
				const image = await engine.decodeImage(item.bytes, typeof item.mime === "string" ? item.mime : "", budget);
				decoded.push({ index: i, image });
			} catch (error) {
				results[i] = { id: results[i].id, ok: false, code: "decode", message: errorMessage(error) };
			}
		}

		let batches = 0;
		for (const [start, end] of planBatches(decoded.length, maxBatchFor(budget))) {
			const group = decoded.slice(start, end);
			batches++;
			try {
				const vectors = await embedBatch(group.map((g) => g.image));
				group.forEach((g, j) => {
					results[g.index] = { id: results[g.index].id, ok: true, vector: vectors[j] };
				});
				continue;
			} catch (error) {
				if (group.length === 1) {
					const g = group[0];
					results[g.index] = { id: results[g.index].id, ok: false, code: "inference", message: errorMessage(error) };
					continue;
				}
			}
			// The batch failed: retry one by one so a single bad image only fails itself.
			for (const g of group) {
				batches++;
				try {
					const [vector] = await embedBatch([g.image]);
					results[g.index] = { id: results[g.index].id, ok: true, vector };
				} catch (error) {
					results[g.index] = { id: results[g.index].id, ok: false, code: "inference", message: errorMessage(error) };
				}
			}
		}
		return { items: results, ms: Math.round(info.now() - t0), batches };
	}

	function ping(): PingResult {
		return {
			protocol: PROTOCOL_VERSION,
			transformers: info.transformersVersion,
			webgpu: info.webgpu,
			initialized: mode,
		};
	}

	async function run(request: WorkerRequest): Promise<{ result: unknown; transfer: Transferable[] }> {
		switch (request.type) {
			case "ping":
				return { result: ping(), transfer: [] };
			case "init":
				return { result: await init(request.payload), transfer: [] };
			case "embedText": {
				const result = await embedText(request.payload?.queries);
				return { result, transfer: result.vectors.map((v) => v.buffer) };
			}
			case "embedImages": {
				const result = await embedImages(request.payload);
				const transfer: Transferable[] = [];
				for (const item of result.items) {
					if (item.ok) {
						transfer.push(item.vector.buffer);
					}
				}
				return { result, transfer };
			}
			default:
				throw new HandlerError("bad-request", `Unsupported request: ${String((request as { type?: unknown }).type)}`);
		}
	}

	/** Handle one message from the host. Never throws; every request gets a response. */
	function handle(data: unknown): Promise<void> {
		const request = data as WorkerRequest | null;
		if (!request || typeof request !== "object" || typeof request.id !== "number") {
			return Promise.resolve();
		}
		const job = queue.then(async () => {
			try {
				const { result, transfer } = await run(request);
				post({ id: request.id, ok: true, result }, transfer);
			} catch (error) {
				const code: WorkerErrorCode = error instanceof HandlerError ? error.code : "internal";
				post({ id: request.id, ok: false, error: { code, message: errorMessage(error) } }, []);
			}
		});
		queue = job;
		return job;
	}

	return { handle };
}
