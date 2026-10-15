import { describe, expect, it } from "vitest";
import { currentEmbeddingConfig, seededVector } from "../../src/semantic/EmbeddingBackend";
import {
	EMBEDDING_DIMS,
	EmbeddingError,
	EmbeddingMode,
	ImageInput,
	InitPayload,
	l2norm,
	PROTOCOL_VERSION,
} from "../../src/semantic/protocol";
import type { VerifiedRuntime } from "../../src/semantic/runtimeFiles";
import { createWorkerHandler, Engine, EngineLoadResult, RawEmbeddings } from "../../src/semantic/worker/handler";
import {
	INDEX_IDLE_TIMEOUT_MS,
	QUERY_IDLE_TIMEOUT_MS,
	TerminateReason,
	WorkerEmbeddingBackend,
	WorkerLike,
} from "../../src/semantic/WorkerEmbeddingBackend";
import { deferred, Deferred, FakeTimers, flushMicrotasks, toArrayBuffer } from "./helpers";

const CFG = currentEmbeddingConfig(70);
const RAW_DIMS = 768;

function rawRows(count: number, seedBase: number): RawEmbeddings {
	const data = new Float32Array(count * RAW_DIMS);
	for (let i = 0; i < count; i++) {
		data.set(seededVector(seedBase + i, RAW_DIMS), i * RAW_DIMS);
	}
	return { data, rows: count, dims: RAW_DIMS };
}

class FakeEngine implements Engine<number> {
	loadError: Error | null = null;
	/** Held embedText calls wait for this. */
	gate: Deferred<void> | null = null;
	texts: string[][] = [];

	load(payload: InitPayload): Promise<EngineLoadResult> {
		if (this.loadError) {
			return Promise.reject(this.loadError);
		}
		return Promise.resolve({
			sessions: payload.mode === "index" ? ["model", "vision_encoder"] : ["model"],
			filesRead: payload.files.length,
		});
	}

	async embedText(texts: string[]): Promise<RawEmbeddings> {
		this.texts.push(texts);
		if (this.gate) {
			await this.gate.promise;
		}
		return rawRows(texts.length, texts[0].length);
	}

	decodeImage(bytes: ArrayBuffer): Promise<number> {
		return Promise.resolve(new Uint8Array(bytes)[0]);
	}

	embedImages(images: number[]): Promise<RawEmbeddings> {
		return Promise.resolve(rawRows(images.length, images[0]));
	}
}

/** Runs the real worker handler in-process; responses are delivered asynchronously. */
class FakeWorker implements WorkerLike {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: { message?: string }) => void) | null = null;
	terminated = false;
	readonly received: Array<{ message: unknown; transfer: Transferable[] }> = [];
	private readonly handler: ReturnType<typeof createWorkerHandler<number>>;

	constructor(readonly engine: FakeEngine, readonly script: ArrayBuffer) {
		this.handler = createWorkerHandler(
			engine,
			{ transformersVersion: "test", webgpu: true, now: () => 0 },
			(message) => {
				if (!this.terminated) {
					this.onmessage?.({ data: message });
				}
			}
		);
	}

	postMessage(message: unknown, transfer: Transferable[]): void {
		if (this.terminated) {
			throw new Error("posted to a terminated worker");
		}
		this.received.push({ message, transfer });
		void Promise.resolve().then(() => this.handler.handle(message));
	}

	terminate(): void {
		this.terminated = true;
	}

	types(): string[] {
		return this.received.map((r) => (r.message as { type: string }).type);
	}

	crash(message: string): void {
		this.onerror?.({ message });
	}
}

interface SetupOptions {
	idleTimeoutMs?: number;
	/** Applied to each new worker's engine. */
	configure?: (engine: FakeEngine, index: number) => void;
}

function setup(options: SetupOptions = {}) {
	const timers = new FakeTimers();
	const workers: FakeWorker[] = [];
	const runtimeCalls: EmbeddingMode[] = [];
	const runtimes: VerifiedRuntime[] = [];
	const terminations: TerminateReason[] = [];
	const state: { runtimeError: Error | null } = { runtimeError: null };
	const backend = new WorkerEmbeddingBackend({
		modelDir: "/models",
		pluginVersion: "1.2.3",
		idleTimeoutMs: options.idleTimeoutMs,
		timers,
		loadRuntime: (mode) => {
			runtimeCalls.push(mode);
			if (state.runtimeError !== null) {
				return Promise.reject(state.runtimeError);
			}
			const rt: VerifiedRuntime = {
				workerScript: toArrayBuffer(new Uint8Array([1, 2, 3])),
				wasmBinary: new ArrayBuffer(16),
				wasmFactory: "export default 0",
				modelFiles: [{ name: "huggingface.co/x/config.json", size: 10 }],
				verifyMs: 3,
			};
			runtimes.push(rt);
			return Promise.resolve(rt);
		},
		createWorker: (script) => {
			const engine = new FakeEngine();
			options.configure?.(engine, workers.length);
			const worker = new FakeWorker(engine, script);
			workers.push(worker);
			return worker;
		},
		onTerminated: (reason) => terminations.push(reason),
	});
	return { backend, timers, workers, runtimeCalls, runtimes, terminations, state };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<EmbeddingError> {
	const error: unknown = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(EmbeddingError);
	expect((error as EmbeddingError).code).toBe(code);
	return error as EmbeddingError;
}

/** Collect a promise's outcome without leaving it unhandled. */
function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	return promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error })
	);
}

function codeOf(outcome: { ok: boolean; error?: unknown }): string | null {
	return !outcome.ok && outcome.error instanceof EmbeddingError ? outcome.error.code : null;
}

describe("WorkerEmbeddingBackend: start", () => {
	it("init starts one worker with the verified runtime", async () => {
		const { backend, workers, runtimeCalls, runtimes } = setup();
		const info = await backend.init("query", CFG);
		expect(info).toEqual({ mode: "query", sessions: ["model"], loadMs: 0, verifyMs: 3 });
		expect(backend.getLastInit()).toEqual(info);
		expect(backend.getMode()).toBe("query");
		expect(runtimeCalls).toEqual(["query"]);
		expect(workers).toHaveLength(1);
		expect(backend.isRunning()).toBe(true);
		expect(workers[0].script).toBe(runtimes[0].workerScript);

		const init = workers[0].received[0];
		const payload = (init.message as { type: string; payload: InitPayload }).payload;
		expect((init.message as { type: string }).type).toBe("init");
		expect(payload).toMatchObject({
			protocol: PROTOCOL_VERSION,
			mode: "query",
			config: CFG,
			modelDir: "/models",
			files: runtimes[0].modelFiles,
			wasmFactory: "export default 0",
		});
		expect(payload.wasmBinary).toBe(runtimes[0].wasmBinary);
		expect(init.transfer).toEqual([runtimes[0].wasmBinary]);
	});

	it("a repeated init with the same mode reuses the running worker", async () => {
		const { backend, workers, runtimeCalls } = setup();
		const [a, b] = await Promise.all([backend.init("index", CFG), backend.init("index", CFG)]);
		expect(a).toEqual(b);
		expect(a.sessions).toEqual(["model", "vision_encoder"]);
		expect(workers).toHaveLength(1);
		expect(runtimeCalls).toEqual(["index"]);
	});

	it("init with a different mode is rejected", async () => {
		const { backend } = setup();
		await backend.init("query", CFG);
		await expectCode(backend.init("index", CFG), "already-initialized");
	});

	it("rejects requests before init", async () => {
		const { backend, workers } = setup();
		await expectCode(backend.embedText(["x"]), "not-initialized");
		await expectCode(backend.embedImages([]), "not-initialized");
		await expectCode(backend.ping(), "not-initialized");
		expect(workers).toHaveLength(0);
	});

	it("maps a model load failure to model-load and terminates the worker", async () => {
		const { backend, workers, terminations } = setup({
			configure: (engine, i) => {
				if (i === 0) {
					engine.loadError = new Error("WebGPU device lost");
				}
			},
		});
		const err = await expectCode(backend.init("query", CFG), "model-load");
		expect(err.message).toBe("WebGPU device lost");
		expect(workers[0].terminated).toBe(true);
		expect(terminations).toEqual(["init-failed"]);
		expect(backend.isRunning()).toBe(false);
		// A later request starts a fresh worker.
		const vectors = await backend.embedText(["hello"]);
		expect(vectors).toHaveLength(1);
		expect(workers).toHaveLength(2);
	});

	it("maps a plain loadRuntime error to runtime-verify", async () => {
		const { backend, workers, state } = setup();
		state.runtimeError = new Error("hash mismatch");
		const err = await expectCode(backend.init("query", CFG), "runtime-verify");
		expect(err.message).toBe("hash mismatch");
		expect(workers).toHaveLength(0);
		state.runtimeError = new EmbeddingError("model-load", "custom");
		await expectCode(backend.init("query", CFG), "model-load");
		state.runtimeError = null;
		await backend.init("query", CFG);
		expect(backend.isRunning()).toBe(true);
	});
});

describe("WorkerEmbeddingBackend: requests", () => {
	it("embedText returns unit vectors of the configured dims", async () => {
		const { backend, workers } = setup();
		await backend.init("query", CFG);
		const vectors = await backend.embedText(["a red car", "a boat"]);
		expect(vectors).toHaveLength(2);
		for (const v of vectors) {
			expect(v).toBeInstanceOf(Float32Array);
			expect(v).toHaveLength(EMBEDDING_DIMS);
			expect(l2norm(v)).toBeCloseTo(1, 5);
		}
		const detailed = await backend.embedTextDetailed(["x"]);
		expect(detailed.vectors).toHaveLength(1);
		expect(workers[0].types()).toEqual(["init", "embedText", "embedText"]);
		expect((await backend.ping()).initialized).toBe("query");
	});

	it("serializes requests: one in flight at a time", async () => {
		const gate = deferred<void>();
		const { backend, workers } = setup({
			configure: (engine) => {
				engine.gate = gate;
			},
		});
		await backend.init("query", CFG);
		const p1 = settle(backend.embedText(["one"]));
		const p2 = settle(backend.embedText(["two"]));
		await flushMicrotasks();
		expect(workers[0].types()).toEqual(["init", "embedText"]);
		gate.resolve();
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1.ok && r2.ok).toBe(true);
		expect(workers[0].types()).toEqual(["init", "embedText", "embedText"]);
		expect(workers[0].engine.texts.map((t) => t.length)).toEqual([1, 1]);
	});

	it("embedImages transfers the input buffers", async () => {
		const { backend, workers } = setup();
		await backend.init("index", CFG);
		const images: ImageInput[] = [
			{ id: "a", bytes: toArrayBuffer(new Uint8Array([5, 1])), mime: "image/png" },
			{ id: "b", bytes: toArrayBuffer(new Uint8Array([9, 2])), mime: "image/jpeg" },
		];
		const buffers = images.map((i) => i.bytes);
		const items = await backend.embedImages(images);
		expect(items.map((i) => [i.id, i.ok])).toEqual([["a", true], ["b", true]]);
		const last = workers[0].received[workers[0].received.length - 1];
		expect((last.message as { type: string }).type).toBe("embedImages");
		expect(last.transfer).toHaveLength(2);
		expect(last.transfer[0]).toBe(buffers[0]);
		expect(last.transfer[1]).toBe(buffers[1]);
		const detailed = await backend.embedImagesDetailed([
			{ id: "c", bytes: toArrayBuffer(new Uint8Array([7])), mime: "image/png" },
		]);
		expect(detailed.batches).toBe(1);
	});

	it("surfaces worker-side errors with their code", async () => {
		const { backend } = setup();
		await backend.init("query", CFG);
		await expectCode(backend.embedImages([{ id: "a", bytes: new ArrayBuffer(1), mime: "image/png" }]), "unsupported");
		// The backend keeps working.
		expect(await backend.embedText(["ok"])).toHaveLength(1);
	});
});

describe("WorkerEmbeddingBackend: lifecycle", () => {
	it("terminates after the idle timeout and restarts transparently", async () => {
		const { backend, timers, workers, runtimeCalls, terminations } = setup({ idleTimeoutMs: 1000 });
		await backend.init("query", CFG);
		expect(timers.delays()).toEqual([1000]);
		await backend.embedText(["a"]);
		expect(timers.delays()).toEqual([1000]);
		expect(backend.isRunning()).toBe(true);

		timers.fireAll();
		expect(backend.isRunning()).toBe(false);
		expect(workers[0].terminated).toBe(true);
		expect(terminations).toEqual(["idle"]);
		expect(timers.size).toBe(0);

		const vectors = await backend.embedText(["b"]);
		expect(vectors).toHaveLength(1);
		expect(runtimeCalls).toEqual(["query", "query"]);
		expect(workers).toHaveLength(2);
		expect(workers[1].types()).toEqual(["init", "embedText"]);
		expect(backend.isRunning()).toBe(true);
		expect(timers.delays()).toEqual([1000]);
	});

	it("a request before the timer fires cancels it", async () => {
		const gate = deferred<void>();
		const { backend, timers, terminations } = setup({
			idleTimeoutMs: 1000,
			configure: (engine) => {
				engine.gate = gate;
			},
		});
		await backend.init("query", CFG);
		expect(timers.size).toBe(1);
		const pending = settle(backend.embedText(["a"]));
		expect(timers.size).toBe(0);
		expect(timers.cleared).toHaveLength(1);
		await flushMicrotasks();
		expect(timers.size).toBe(0);
		gate.resolve();
		expect((await pending).ok).toBe(true);
		expect(timers.delays()).toEqual([1000]);
		expect(terminations).toEqual([]);
		expect(backend.isRunning()).toBe(true);
	});

	it("uses mode-specific default idle timeouts and 0 disables it", async () => {
		const q = setup();
		await q.backend.init("query", CFG);
		expect(q.timers.delays()).toEqual([QUERY_IDLE_TIMEOUT_MS]);
		const i = setup();
		await i.backend.init("index", CFG);
		expect(i.timers.delays()).toEqual([INDEX_IDLE_TIMEOUT_MS]);
		const off = setup({ idleTimeoutMs: 0 });
		await off.backend.init("query", CFG);
		await off.backend.embedText(["a"]);
		expect(off.timers.size).toBe(0);
	});

	it("recycle() rejects the in-flight and queued requests, then recovers", async () => {
		const gate = deferred<void>();
		const { backend, workers, runtimeCalls, terminations } = setup({
			configure: (engine, i) => {
				if (i === 0) {
					engine.gate = gate;
				}
			},
		});
		await backend.init("query", CFG);
		const inFlight = settle(backend.embedText(["one"]));
		const queued = settle(backend.embedText(["two"]));
		await flushMicrotasks();
		expect(workers[0].types()).toEqual(["init", "embedText"]);

		backend.recycle();
		expect(codeOf(await inFlight)).toBe("terminated");
		expect(codeOf(await queued)).toBe("terminated");
		expect(terminations).toEqual(["recycle"]);
		expect(workers[0].terminated).toBe(true);
		expect(backend.isRunning()).toBe(false);
		// The queued request never reached a worker.
		expect(workers[0].types()).toEqual(["init", "embedText"]);
		gate.resolve();

		expect(await backend.embedText(["three"])).toHaveLength(1);
		expect(workers).toHaveLength(2);
		expect(runtimeCalls).toEqual(["query", "query"]);
	});

	it("recycle() with no worker is a no-op", async () => {
		const { backend, terminations } = setup();
		backend.recycle();
		expect(terminations).toEqual([]);
		await backend.init("query", CFG);
		expect(backend.isRunning()).toBe(true);
	});

	it("dispose() rejects pending and all later calls", async () => {
		const gate = deferred<void>();
		const { backend, workers, terminations, timers } = setup({
			idleTimeoutMs: 1000,
			configure: (engine) => {
				engine.gate = gate;
			},
		});
		await backend.init("query", CFG);
		const inFlight = settle(backend.embedText(["one"]));
		const queued = settle(backend.embedText(["two"]));
		await flushMicrotasks();
		await backend.dispose();
		expect(codeOf(await inFlight)).toBe("terminated");
		expect(codeOf(await queued)).toBe("terminated");
		expect(terminations).toEqual(["dispose"]);
		expect(workers[0].terminated).toBe(true);
		expect(backend.getLastInit()).toBeNull();
		gate.resolve();
		await flushMicrotasks();

		await expectCode(backend.embedText(["x"]), "terminated");
		await expectCode(backend.embedImages([]), "terminated");
		await expectCode(backend.ping(), "terminated");
		await expectCode(backend.init("query", CFG), "terminated");
		expect(workers).toHaveLength(1);
		expect(timers.size).toBe(0);
	});

	it("a worker error rejects the in-flight request with worker-crashed", async () => {
		const gate = deferred<void>();
		const { backend, workers, terminations } = setup({
			configure: (engine, i) => {
				if (i === 0) {
					engine.gate = gate;
				}
			},
		});
		await backend.init("query", CFG);
		const inFlight = settle(backend.embedText(["one"]));
		await flushMicrotasks();
		workers[0].crash("out of memory");
		const outcome = await inFlight;
		expect(codeOf(outcome)).toBe("worker-crashed");
		expect(!outcome.ok && outcome.error instanceof Error ? outcome.error.message : "").toBe("out of memory");
		expect(terminations).toEqual(["crash"]);
		expect(backend.isRunning()).toBe(false);
		gate.resolve();

		expect(await backend.embedText(["again"])).toHaveLength(1);
		expect(workers).toHaveLength(2);
	});
});
