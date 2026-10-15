/**
 * Semantic search worker (docs/semantic-search.md §4.3).
 *
 * Bundled separately by esbuild.config.mjs into dist/semantic-worker.js
 * (IIFE, browser platform, `process` defined as undefined) and shipped as a
 * GitHub release asset; it is never part of main.js. The host verifies its
 * SHA-256 and starts it from a Blob URL (WorkerEmbeddingBackend).
 *
 * Message protocol: src/semantic/protocol.ts. Dispatch: ./handler.ts.
 * Model runtime: ./engine.ts (WebGPU, q4, offline).
 */
import { env } from "@huggingface/transformers";
import type { WorkerResponse } from "../protocol";
import { blockNetwork, TransformersEngine } from "./engine";
import { createWorkerHandler } from "./handler";

interface WorkerScope {
	fetch: typeof fetch;
	postMessage(message: WorkerResponse, transfer: Transferable[]): void;
	addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

const scope = self as unknown as WorkerScope;

blockNetwork(scope);

const handler = createWorkerHandler(
	new TransformersEngine(),
	{
		transformersVersion: env.version,
		webgpu: typeof navigator !== "undefined" && "gpu" in navigator,
		now: () => performance.now(),
	},
	(message, transfer) => scope.postMessage(message, transfer)
);

scope.addEventListener("message", (event) => {
	void handler.handle(event.data);
});
