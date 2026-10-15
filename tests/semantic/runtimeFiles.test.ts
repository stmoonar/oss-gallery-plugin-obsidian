import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_ASSETS, runtimeDirName } from "../../src/semantic/assets";
import type { GeneratedRuntimeFile } from "../../src/semantic/assets.generated";
import { EmbeddingError, ModelFileRef } from "../../src/semantic/protocol";
import {
	loadVerifiedRuntime,
	modelFilesFor,
	ORT_MJS_FILE,
	ORT_WASM_FILE,
	RuntimeSources,
	WORKER_FILE,
} from "../../src/semantic/runtimeFiles";
import { makeTempDir, removeDir } from "./helpers";

const VERSION = "9.9.9-test";

const RUNTIME_CONTENT: Record<string, Uint8Array> = {
	[WORKER_FILE]: new TextEncoder().encode("self.onmessage = () => {};\n"),
	[ORT_WASM_FILE]: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 42, 255]),
	[ORT_MJS_FILE]: new TextEncoder().encode("export default function ortFactory() { return 'ünïcode'; }\n"),
};

const MODEL_CONTENT: Record<string, Uint8Array> = {
	"huggingface.co/org/m/resolve/r/config.json": new TextEncoder().encode("{}"),
	"huggingface.co/org/m/resolve/r/onnx/model_q4.onnx": new Uint8Array(37).fill(3),
	"huggingface.co/org/m/resolve/r/onnx/vision_encoder_q4.onnx": new Uint8Array(19).fill(5),
};

let modelDir: string;
let runtimeDir: string;

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function runtimeManifest(): GeneratedRuntimeFile[] {
	return Object.entries(RUNTIME_CONTENT).map(([file, bytes]) => ({ file, size: bytes.length, sha256: sha256(bytes) }));
}

function modelRefs(): ModelFileRef[] {
	return Object.entries(MODEL_CONTENT).map(([name, bytes]) => ({ name, size: bytes.length }));
}

function sources(overrides: Partial<RuntimeSources> = {}): RuntimeSources {
	let t = 1000;
	return {
		runtimeFiles: runtimeManifest(),
		modelFiles: modelRefs(),
		now: () => (t += 7),
		...overrides,
	};
}

function modelPath(name: string): string {
	return path.join(modelDir, ...name.split("/"));
}

async function expectVerifyError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
	const error: unknown = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(EmbeddingError);
	expect((error as EmbeddingError).code).toBe("runtime-verify");
	expect((error as EmbeddingError).message).toMatch(pattern);
}

beforeEach(() => {
	modelDir = makeTempDir("runtime-test-");
	runtimeDir = path.join(modelDir, ...runtimeDirName(VERSION).split("/"));
	fs.mkdirSync(runtimeDir, { recursive: true });
	for (const [file, bytes] of Object.entries(RUNTIME_CONTENT)) {
		fs.writeFileSync(path.join(runtimeDir, file), bytes);
	}
	for (const [name, bytes] of Object.entries(MODEL_CONTENT)) {
		fs.mkdirSync(path.dirname(modelPath(name)), { recursive: true });
		fs.writeFileSync(modelPath(name), bytes);
	}
});

afterEach(() => {
	removeDir(modelDir);
});

describe("loadVerifiedRuntime", () => {
	it("returns the exact verified bytes", async () => {
		const rt = await loadVerifiedRuntime(modelDir, VERSION, "index", sources());
		expect(new Uint8Array(rt.workerScript)).toEqual(RUNTIME_CONTENT[WORKER_FILE]);
		expect(new Uint8Array(rt.wasmBinary)).toEqual(RUNTIME_CONTENT[ORT_WASM_FILE]);
		expect(rt.workerScript.byteLength).toBe(RUNTIME_CONTENT[WORKER_FILE].length);
		expect(rt.wasmBinary.byteLength).toBe(RUNTIME_CONTENT[ORT_WASM_FILE].length);
		expect(rt.wasmFactory).toBe(new TextDecoder().decode(RUNTIME_CONTENT[ORT_MJS_FILE]));
		expect(rt.modelFiles).toEqual(modelRefs());
		expect(rt.verifyMs).toBe(7);
	});

	it("passes only the text model files in query mode", async () => {
		const rt = await loadVerifiedRuntime(modelDir, VERSION, "query", sources());
		expect(rt.modelFiles.map((f) => f.name)).toEqual([
			"huggingface.co/org/m/resolve/r/config.json",
			"huggingface.co/org/m/resolve/r/onnx/model_q4.onnx",
		]);
	});

	it("query mode does not need the vision encoder on disk", async () => {
		fs.unlinkSync(modelPath("huggingface.co/org/m/resolve/r/onnx/vision_encoder_q4.onnx"));
		await expect(loadVerifiedRuntime(modelDir, VERSION, "query", sources())).resolves.toBeDefined();
		await expectVerifyError(loadVerifiedRuntime(modelDir, VERSION, "index", sources()), /Model file missing: .*vision_encoder/);
	});

	it("rejects a tampered runtime file of the same size", async () => {
		const bytes = Uint8Array.from(RUNTIME_CONTENT[ORT_WASM_FILE]);
		bytes[4] ^= 0x01;
		fs.writeFileSync(path.join(runtimeDir, ORT_WASM_FILE), bytes);
		await expectVerifyError(loadVerifiedRuntime(modelDir, VERSION, "index", sources()), /SHA-256.*ort-wasm-simd-threaded\.asyncify\.wasm/);
	});

	it("rejects a runtime file with the wrong size", async () => {
		fs.appendFileSync(path.join(runtimeDir, WORKER_FILE), "// extra");
		await expectVerifyError(loadVerifiedRuntime(modelDir, VERSION, "query", sources()), /wrong size: semantic-worker\.js/);
	});

	it("rejects a missing runtime file", async () => {
		fs.unlinkSync(path.join(runtimeDir, ORT_MJS_FILE));
		await expectVerifyError(loadVerifiedRuntime(modelDir, VERSION, "query", sources()), /Runtime file missing: ort-wasm-simd-threaded\.asyncify\.mjs/);
	});

	it("rejects a runtime directory of another version", async () => {
		await expectVerifyError(loadVerifiedRuntime(modelDir, "0.0.1", "query", sources()), /Runtime file missing/);
	});

	it("rejects a manifest without an entry for a runtime file", async () => {
		const runtimeFiles = runtimeManifest().filter((f) => f.file !== ORT_WASM_FILE);
		await expectVerifyError(loadVerifiedRuntime(modelDir, VERSION, "query", sources({ runtimeFiles })), /no entry for ort-wasm/);
	});

	it("rejects a missing model file", async () => {
		fs.unlinkSync(modelPath("huggingface.co/org/m/resolve/r/config.json"));
		await expectVerifyError(loadVerifiedRuntime(modelDir, VERSION, "query", sources()), /Model file missing: .*config\.json/);
	});

	it("rejects a model directory entry that is not a file", async () => {
		const name = "huggingface.co/org/m/resolve/r/config.json";
		fs.unlinkSync(modelPath(name));
		fs.mkdirSync(modelPath(name));
		await expectVerifyError(loadVerifiedRuntime(modelDir, VERSION, "query", sources()), /Model file missing/);
	});

	it("rejects a model file with the wrong size", async () => {
		fs.appendFileSync(modelPath("huggingface.co/org/m/resolve/r/onnx/model_q4.onnx"), Buffer.from([1]));
		await expectVerifyError(loadVerifiedRuntime(modelDir, VERSION, "query", sources()), /wrong size: .*model_q4\.onnx/);
	});
});

describe("modelFilesFor", () => {
	it("excludes the vision encoder in query mode and keeps it for index", () => {
		const refs = modelRefs();
		expect(modelFilesFor("query", refs).map((f) => f.name)).not.toContain(
			"huggingface.co/org/m/resolve/r/onnx/vision_encoder_q4.onnx"
		);
		expect(modelFilesFor("query", refs)).toHaveLength(2);
		expect(modelFilesFor("index", refs)).toEqual(refs);
	});

	it("uses MODEL_ASSETS by default (query 8 files, index 10)", () => {
		const query = modelFilesFor("query");
		const index = modelFilesFor("index");
		expect(query).toHaveLength(8);
		expect(index).toHaveLength(10);
		expect(query.some((f) => f.name.includes("/onnx/vision_encoder"))).toBe(false);
		expect(index.filter((f) => f.name.includes("/onnx/vision_encoder"))).toHaveLength(2);
		// Only name and size are passed on (no URLs or hashes).
		expect(Object.keys(index[0]).sort()).toEqual(["name", "size"]);
		expect(index.map((f) => f.name)).toEqual(MODEL_ASSETS.map((a) => a.name));
	});
});
