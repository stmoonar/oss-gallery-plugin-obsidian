/**
 * transformers.js engine for the semantic worker (docs/semantic-search.md
 * §4.3, P0 §7/§8). Offline only: model files come from the verified model
 * directory through a read-only fs cache, remote models are disabled and
 * fetch is blocked for anything but blob:/data: URLs.
 */
import { AutoConfig, AutoModel, AutoProcessor, RawImage, env } from "@huggingface/transformers";
import { decodePixelCap, decodeSize, EncodedThumbnail, InitPayload, ThumbnailRequest } from "../protocol";
import { encodeThumbnail } from "../../thumbnails/encode";
import { createFsModelCache, FsModelCache } from "./fsModelCache";
import { detectImageFormat, isNativeFormat, nativeImageProblem } from "../imageFormat";
import { decodeTiff } from "./tiff";
import type { Engine, EngineLoadResult, RawEmbeddings } from "./handler";

interface NodeFs {
	promises: {
		readFile(path: string): Promise<Uint8Array>;
		stat(path: string): Promise<{ size: number; isFile(): boolean }>;
	};
}

interface NodePath {
	join(...parts: string[]): string;
}

type NodeRequire = (id: string) => unknown;

/**
 * Obsidian workers have `nodeIntegrationInWorker`, so Node's `require` is a
 * property of the worker global, even in a Blob-URL worker (P0 §7). Reading
 * it as a property keeps esbuild from resolving or stubbing it.
 */
function getNodeRequire(): NodeRequire | null {
	const candidate = (self as unknown as { require?: unknown }).require;
	return typeof candidate === "function" ? (candidate as NodeRequire) : null;
}

interface TensorLike {
	data: ArrayLike<number>;
	dims: number[];
}

interface ModelLike {
	(inputs: unknown): Promise<{ sentence_embedding: TensorLike }>;
	sessions: Record<string, unknown>;
}

interface ProcessorLike {
	(...args: unknown[]): Promise<unknown>;
	image_processor: { max_soft_tokens: number };
}

interface MutableConfig {
	audio_config: unknown;
	vision_config: unknown;
}

/** ORT's Emscripten glue would see the worker's real Node `process` (P0 §8). */
function patchWasmFactory(source: string): string {
	return source.split("globalThis.process?.versions?.node").join("false");
}

function isLocalUrl(input: unknown): boolean {
	let url: string;
	if (typeof input === "string") {
		url = input;
	} else if (input instanceof URL) {
		url = input.href;
	} else if (input instanceof Request) {
		url = input.url;
	} else {
		return false;
	}
	return url.startsWith("blob:") || url.startsWith("data:");
}

/** The worker never touches the network: only blob:/data: fetches are allowed. */
export function blockNetwork(scope: { fetch: typeof fetch }): void {
	const original = scope.fetch.bind(scope);
	scope.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (isLocalUrl(input)) {
			return original(input, init);
		}
		const target = input instanceof Request ? input.url : String(input);
		return Promise.reject(new Error(`Network access is disabled in the semantic worker: ${target}`));
	};
}

function toRaw(tensor: TensorLike): RawEmbeddings {
	const [rows, dims] = tensor.dims;
	return { data: tensor.data, rows, dims };
}

/** Embedding input: the bitmap on white (PREPROCESS_VERSION 1). */
function toRawImage(bitmap: ImageBitmap): RawImage {
	const { width, height } = bitmap;
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("2D canvas is not available");
	}
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(bitmap, 0, 0);
	const pixels = ctx.getImageData(0, 0, width, height).data;
	// getImageData copied the pixels: free the backing store now.
	canvas.width = 0;
	canvas.height = 0;
	return new RawImage(pixels, width, height, 4);
}

export class TransformersEngine implements Engine<RawImage> {
	private model: ModelLike | null = null;
	private processor: ProcessorLike | null = null;
	private cache: FsModelCache | null = null;

	async load(payload: InitPayload): Promise<EngineLoadResult> {
		const nodeRequire = getNodeRequire();
		if (!nodeRequire) {
			throw new Error("Node integration is not available in this worker");
		}
		const fs = nodeRequire("fs") as NodeFs;
		const path = nodeRequire("path") as NodePath;
		this.cache = createFsModelCache(payload.modelDir, payload.files, {
			readFile: (abs) => fs.promises.readFile(abs),
			size: async (abs) => {
				try {
					const st = await fs.promises.stat(abs);
					return st.isFile() ? st.size : null;
				} catch {
					return null;
				}
			},
			join: (...parts) => path.join(...parts),
		}, { revision: payload.config.revision });

		env.useBrowserCache = false;
		env.useFSCache = false;
		env.useCustomCache = true;
		env.customCache = this.cache;
		// Local models must be "allowed" or transformers.js rejects the
		// config outright; the local path is never served (fetch is blocked),
		// so a file missing from the cache fails the load.
		env.allowRemoteModels = false;
		env.allowLocalModels = true;
		env.localModelPath = "/__oss-gallery-no-local-models__/";
		env.fetch = (input: string | URL) =>
			Promise.reject(new Error(`Network access is disabled in the semantic worker: ${String(input)}`));

		// ORT runtime in binary mode: bytes verified by the host, no URLs.
		env.useWasmCache = false;
		const wasm = env.backends.onnx.wasm as {
			wasmBinary?: ArrayBuffer;
			wasmPaths?: unknown;
			proxy?: boolean;
		};
		wasm.wasmBinary = payload.wasmBinary;
		const factory = new Blob([patchWasmFactory(payload.wasmFactory)], { type: "text/javascript" });
		wasm.wasmPaths = { mjs: URL.createObjectURL(factory) };
		wasm.proxy = false;

		const { modelId, revision } = payload.config;
		const options = { revision, local_files_only: true };
		const config = await AutoConfig.from_pretrained(modelId, options);
		const sessionsConfig = config as unknown as MutableConfig;
		// D12: never load audio; the query worker loads the text model only.
		sessionsConfig.audio_config = null;
		if (payload.mode === "query") {
			sessionsConfig.vision_config = null;
		}
		this.processor = (await AutoProcessor.from_pretrained(modelId, options)) as unknown as ProcessorLike;
		this.model = await AutoModel.from_pretrained(modelId, {
			...options,
			config,
			device: "webgpu",
			dtype: { model: "q4", vision_encoder: "q4" },
		});
		this.processor.image_processor.max_soft_tokens = payload.config.imageTokenBudget;
		return {
			sessions: Object.keys(this.model.sessions),
			filesRead: this.cache.stats.hits.length,
		};
	}

	private loaded(): { model: ModelLike; processor: ProcessorLike } {
		if (!this.model || !this.processor) {
			throw new Error("Model not loaded");
		}
		return { model: this.model, processor: this.processor };
	}

	async embedText(texts: string[]): Promise<RawEmbeddings> {
		const { model, processor } = this.loaded();
		const out = await model(await processor(texts));
		return toRaw(out.sentence_embedding);
	}

	/**
	 * Decode with the browser's image decoder, downscale images above
	 * decodePixelCap and composite onto white so transparent pixels don't
	 * turn black. Part of PREPROCESS_VERSION 1.
	 *
	 * Chromium decodes a Blob to a full-size bitmap before any resize option
	 * applies, so passing resizeWidth/Height to the first createImageBitmap
	 * would not save memory (and could change vectors of indexed images).
	 * Memory is bounded instead by the header size check (MAX_IMAGE_PIXELS,
	 * also done by prepareImage on the main thread) before decoding.
	 */
	async decodeImage(bytes: ArrayBuffer, mime: string, budget: number): Promise<RawImage> {
		const bitmap = await this.decodeBitmap(bytes, mime, budget);
		try {
			return toRawImage(bitmap);
		} finally {
			bitmap.close();
		}
	}

	/**
	 * decodeImage plus a gallery thumbnail encoded from the same bitmap,
	 * after the embedding pixels were read (the RawImage is identical to
	 * decodeImage's). A thumbnail failure only yields null.
	 */
	async decodeImageWithThumbnail(
		bytes: ArrayBuffer,
		mime: string,
		budget: number,
		request: ThumbnailRequest
	): Promise<{ image: RawImage; thumbnail: EncodedThumbnail | null }> {
		const bitmap = await this.decodeBitmap(bytes, mime, budget);
		try {
			const image = toRawImage(bitmap);
			let thumbnail: EncodedThumbnail | null = null;
			try {
				thumbnail = await encodeThumbnail(bitmap, request);
			} catch {
				thumbnail = null;
			}
			return { image, thumbnail };
		} finally {
			bitmap.close();
		}
	}

	/** The decoded (and, above decodePixelCap, downscaled) bitmap. The caller closes it. */
	private async decodeBitmap(bytes: ArrayBuffer, mime: string, budget: number): Promise<ImageBitmap> {
		let bitmap: ImageBitmap;
		if (mime === "image/tiff") {
			// No TIFF decoder in Chromium: UTIF.js -> RGBA -> bitmap, then the
			// same downscale/white-composite path as every other format.
			const { rgba, width, height } = await decodeTiff(bytes);
			bitmap = await createImageBitmap(new ImageData(rgba, width, height));
		} else {
			const format = detectImageFormat(bytes);
			if (!isNativeFormat(format)) {
				throw new Error(`Unsupported image data (${format})`);
			}
			const problem = nativeImageProblem(new Uint8Array(bytes), format);
			if (problem) {
				throw new Error(problem.reason);
			}
			bitmap = await createImageBitmap(new Blob([bytes], mime ? { type: mime } : undefined));
		}
		try {
			const target = decodeSize(bitmap.width, bitmap.height, decodePixelCap(budget));
			if (target) {
				const resized = await createImageBitmap(bitmap, {
					resizeWidth: target.width,
					resizeHeight: target.height,
					resizeQuality: "high",
				});
				bitmap.close();
				bitmap = resized;
			}
			return bitmap;
		} catch (error) {
			bitmap.close();
			throw error;
		}
	}

	async embedImages(images: RawImage[], budget: number): Promise<RawEmbeddings> {
		const { model, processor } = this.loaded();
		processor.image_processor.max_soft_tokens = budget;
		// One list per sample; a flat list would be a single sample (P0 §3).
		const inputs = await processor(null, images.map((image) => [image]));
		const out = await model(inputs);
		return toRaw(out.sentence_embedding);
	}
}
