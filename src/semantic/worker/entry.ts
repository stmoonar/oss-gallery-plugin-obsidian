/**
 * Semantic search worker (P1 stub).
 *
 * Bundled separately by esbuild.config.mjs into dist/semantic-worker.js
 * (IIFE, browser platform, `process` defined as undefined) and shipped as a
 * GitHub release asset; it is never part of main.js. The plugin downloads it
 * on request, verifies its SHA-256 and starts it from a Blob URL.
 *
 * P1 only answers `ping`. P2 adds init/embedText/embedImages/dispose (see
 * docs/semantic-search.md §4.3). The model classes are imported now so the
 * bundle (and its release hash/size) is already the real one.
 */
import {
	AutoConfig,
	AutoModel,
	AutoProcessor,
	RawImage,
	env,
} from "@huggingface/transformers";

/** Bumped whenever the main-thread <-> worker message protocol changes. */
const PROTOCOL_VERSION = 1;

interface WorkerRequest {
	id: number;
	type: string;
	payload?: unknown;
}

interface WorkerScope {
	postMessage(message: unknown): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<WorkerRequest>) => void
	): void;
}

const scope = self as unknown as WorkerScope;

// Never touch the Chromium Cache API: model files live in the user-chosen
// model directory and are served through a custom fs cache (P2).
env.useBrowserCache = false;
env.useWasmCache = false;
env.allowLocalModels = false;

function describe(): Record<string, unknown> {
	const onnx = env.backends.onnx;
	return {
		protocol: PROTOCOL_VERSION,
		transformers: env.version,
		onnxruntime: onnx.versions?.web ?? null,
		webgpu: typeof navigator !== "undefined" && "gpu" in navigator,
		classes: [AutoConfig, AutoModel, AutoProcessor, RawImage].every(
			(c) => typeof c === "function"
		),
	};
}

scope.addEventListener("message", (event) => {
	const request = event.data;
	if (!request || typeof request.id !== "number") {
		return;
	}
	if (request.type === "ping") {
		scope.postMessage({ id: request.id, ok: true, result: describe() });
		return;
	}
	scope.postMessage({
		id: request.id,
		ok: false,
		error: `Unsupported request: ${String(request.type)}`,
	});
});
