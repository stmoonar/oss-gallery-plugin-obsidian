/**
 * Load the semantic runtime for a worker start (docs/semantic-search.md
 * §4.3, §8.1).
 *
 * Runtime files (worker bundle, ORT wasm + mjs) are read once, SHA-256
 * checked against the build-generated manifest, and the *same bytes* are
 * handed to the worker (Blob URL / transfer), so nothing can be swapped
 * between the check and the use. Model files are only size-checked here:
 * they are 316 MB, were hashed at install/verify time, and the worker reads
 * them itself (and re-checks their size).
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { MODEL_ASSETS, runtimeDirName } from "./assets";
import { GENERATED_RUNTIME_FILES, GeneratedRuntimeFile } from "./assets.generated";
import { EmbeddingError, EmbeddingMode, ModelFileRef } from "./protocol";

export const WORKER_FILE = "semantic-worker.js";
export const ORT_WASM_FILE = "ort-wasm-simd-threaded.asyncify.wasm";
export const ORT_MJS_FILE = "ort-wasm-simd-threaded.asyncify.mjs";

export interface VerifiedRuntime {
	workerScript: ArrayBuffer;
	wasmBinary: ArrayBuffer;
	wasmFactory: string;
	/** Model files the worker may read for this mode. */
	modelFiles: ModelFileRef[];
	verifyMs: number;
}

export interface RuntimeSources {
	runtimeFiles?: readonly GeneratedRuntimeFile[];
	modelFiles?: readonly ModelFileRef[];
	now?: () => number;
}

/** The query worker never opens the vision encoder (D12). */
export function modelFilesFor(mode: EmbeddingMode, files: readonly ModelFileRef[] = MODEL_ASSETS): ModelFileRef[] {
	return files
		.filter((f) => mode === "index" || !f.name.includes("/onnx/vision_encoder"))
		.map((f) => ({ name: f.name, size: f.size }));
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function readVerified(dir: string, entry: GeneratedRuntimeFile): Promise<Buffer> {
	const file = path.join(dir, entry.file);
	let bytes: Buffer;
	try {
		bytes = await fs.promises.readFile(file);
	} catch {
		throw new EmbeddingError("runtime-verify", `Runtime file missing: ${entry.file}`);
	}
	if (bytes.length !== entry.size) {
		throw new EmbeddingError("runtime-verify", `Runtime file has the wrong size: ${entry.file}`);
	}
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== entry.sha256) {
		throw new EmbeddingError("runtime-verify", `Runtime file failed the SHA-256 check: ${entry.file}`);
	}
	return bytes;
}

export async function loadVerifiedRuntime(
	modelDir: string,
	pluginVersion: string,
	mode: EmbeddingMode,
	sources: RuntimeSources = {}
): Promise<VerifiedRuntime> {
	const now = sources.now ?? (() => Date.now());
	const t0 = now();
	const runtimeFiles = sources.runtimeFiles ?? GENERATED_RUNTIME_FILES;
	const runtimeDir = path.join(modelDir, ...runtimeDirName(pluginVersion).split("/"));
	const find = (name: string): GeneratedRuntimeFile => {
		const entry = runtimeFiles.find((f) => f.file === name);
		if (!entry) {
			throw new EmbeddingError("runtime-verify", `Runtime manifest has no entry for ${name}`);
		}
		return entry;
	};

	const [worker, wasm, mjs] = await Promise.all([
		readVerified(runtimeDir, find(WORKER_FILE)),
		readVerified(runtimeDir, find(ORT_WASM_FILE)),
		readVerified(runtimeDir, find(ORT_MJS_FILE)),
	]);

	const modelFiles = modelFilesFor(mode, sources.modelFiles ?? MODEL_ASSETS);
	for (const f of modelFiles) {
		let size: number | null = null;
		try {
			const st = await fs.promises.stat(path.join(modelDir, ...f.name.split("/")));
			size = st.isFile() ? st.size : null;
		} catch {
			size = null;
		}
		if (size === null) {
			throw new EmbeddingError("runtime-verify", `Model file missing: ${f.name}`);
		}
		if (size !== f.size) {
			throw new EmbeddingError("runtime-verify", `Model file has the wrong size: ${f.name}`);
		}
	}

	return {
		workerScript: toArrayBuffer(worker),
		wasmBinary: toArrayBuffer(wasm),
		wasmFactory: mjs.toString("utf8"),
		modelFiles,
		verifyMs: Math.round(now() - t0),
	};
}
