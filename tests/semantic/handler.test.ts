import { describe, expect, it } from "vitest";
import { currentEmbeddingConfig, fnv1a, seededVector } from "../../src/semantic/EmbeddingBackend";
import {
	EMBEDDING_DIMS,
	EmbeddingMode,
	EmbedImagesResult,
	EmbedTextResult,
	ImageTokenBudget,
	InitPayload,
	InitResult,
	l2norm,
	PingResult,
	PROTOCOL_VERSION,
	QUERY_PREFIX,
	truncateAndNormalize,
	WorkerErrorCode,
	WorkerResponse,
} from "../../src/semantic/protocol";
import { createWorkerHandler, Engine, EngineLoadResult, RawEmbeddings } from "../../src/semantic/worker/handler";
import { deferred, Deferred, flushMicrotasks, toArrayBuffer } from "./helpers";

const RAW_DIMS = 768;
const TAG_OK = 1;
/** decodeImage throws for bytes starting with this. */
const TAG_BAD_DECODE = 0xde;
/** Any model batch containing this image throws. */
const TAG_BAD_INFERENCE = 0xbb;

interface FakeImage {
	seed: number;
	poison: boolean;
}

/** Raw (un-normalized, full-size) embedding for a seed. */
function rawFor(seed: number): Float32Array {
	const v = seededVector(seed, RAW_DIMS);
	return v.map((x) => x * 3);
}

function textSeed(text: string): number {
	return fnv1a(new TextEncoder().encode(text));
}

function expectedText(query: string): Float32Array {
	return truncateAndNormalize(rawFor(textSeed(QUERY_PREFIX + query)), EMBEDDING_DIMS);
}

function expectedImage(seed: number): Float32Array {
	return truncateAndNormalize(rawFor(seed), EMBEDDING_DIMS);
}

function stack(rows: Float32Array[]): RawEmbeddings {
	const data = new Float32Array(rows.length * RAW_DIMS);
	rows.forEach((r, i) => data.set(r, i * RAW_DIMS));
	return { data, rows: rows.length, dims: RAW_DIMS };
}

class FakeEngine implements Engine<FakeImage> {
	loadCalls: InitPayload[] = [];
	loadError: Error | null = null;
	textCalls: string[][] = [];
	imageBatches: number[] = [];
	budgets: number[] = [];
	decodeCalls = 0;
	active = 0;
	maxActive = 0;
	/** When set, embedText waits for it (to hold a request in flight). */
	textGate: Deferred<void> | null = null;
	/** Override the number of rows embedText returns. */
	textRows: number | null = null;
	textError: Error | null = null;

	private async track<T>(fn: () => Promise<T>): Promise<T> {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			await Promise.resolve();
			return await fn();
		} finally {
			this.active--;
		}
	}

	load(payload: InitPayload): Promise<EngineLoadResult> {
		return this.track(() => {
			this.loadCalls.push(payload);
			if (this.loadError) {
				return Promise.reject(this.loadError);
			}
			return Promise.resolve({
				sessions: payload.mode === "index" ? ["model", "vision_encoder"] : ["model"],
				filesRead: payload.files.length,
			});
		});
	}

	embedText(texts: string[]): Promise<RawEmbeddings> {
		return this.track(async () => {
			this.textCalls.push(texts);
			if (this.textGate) {
				await this.textGate.promise;
			}
			if (this.textError) {
				throw this.textError;
			}
			const rows = texts.map((t) => rawFor(textSeed(t)));
			return stack(this.textRows === null ? rows : rows.slice(0, this.textRows));
		});
	}

	decodeImage(bytes: ArrayBuffer, _mime: string, budget: number): Promise<FakeImage> {
		return this.track(() => {
			this.decodeCalls++;
			this.budgets.push(budget);
			const b = new Uint8Array(bytes);
			if (b[0] === TAG_BAD_DECODE) {
				return Promise.reject(new Error("cannot decode"));
			}
			return Promise.resolve({ seed: b[1], poison: b[0] === TAG_BAD_INFERENCE });
		});
	}

	embedImages(images: FakeImage[], budget: number): Promise<RawEmbeddings> {
		return this.track(() => {
			this.imageBatches.push(images.length);
			this.budgets.push(budget);
			if (images.some((i) => i.poison)) {
				return Promise.reject(new Error("GPU fell over"));
			}
			return Promise.resolve(stack(images.map((i) => rawFor(i.seed))));
		});
	}
}

interface Posted {
	message: WorkerResponse;
	transfer: Transferable[];
}

function setup() {
	const engine = new FakeEngine();
	const posts: Posted[] = [];
	let t = 0;
	const handler = createWorkerHandler(
		engine,
		{ transformersVersion: "4.3.1-test", webgpu: true, now: () => (t += 5) },
		(message, transfer) => posts.push({ message, transfer })
	);
	let nextId = 1;
	async function send(type: string, payload?: unknown): Promise<Posted> {
		const id = nextId++;
		await handler.handle({ id, type, payload });
		const post = posts.find((p) => p.message.id === id);
		if (!post) {
			throw new Error(`no response for ${id}`);
		}
		return post;
	}
	return { engine, posts, handler, send };
}

function initPayload(mode: EmbeddingMode, budget: ImageTokenBudget = 70, overrides: Partial<InitPayload> = {}): InitPayload {
	return {
		protocol: PROTOCOL_VERSION,
		mode,
		config: currentEmbeddingConfig(budget),
		modelDir: "/models",
		files: [
			{ name: "a.json", size: 1 },
			{ name: "b.onnx", size: 2 },
		],
		wasmBinary: new ArrayBuffer(4),
		wasmFactory: "export default 1",
		...overrides,
	};
}

function okResult<T>(post: Posted): T {
	if (!post.message.ok) {
		throw new Error(`expected ok, got ${post.message.error.code}: ${post.message.error.message}`);
	}
	return post.message.result as T;
}

function errorCode(post: Posted): WorkerErrorCode {
	if (post.message.ok) {
		throw new Error("expected an error response");
	}
	expect(post.transfer).toEqual([]);
	return post.message.error.code;
}

function image(id: string, seed: number, tag = TAG_OK): { id: string; bytes: ArrayBuffer; mime: string } {
	return { id, bytes: toArrayBuffer(new Uint8Array([tag, seed, 0, 0])), mime: "image/png" };
}

describe("worker handler: init", () => {
	it("initializes and reports sessions, timing and versions", async () => {
		const { engine, send } = setup();
		const res = okResult<InitResult>(await send("init", initPayload("index")));
		expect(res).toEqual({
			mode: "index",
			sessions: ["model", "vision_encoder"],
			loadMs: 5,
			filesRead: 2,
			transformersVersion: "4.3.1-test",
		});
		expect(engine.loadCalls).toHaveLength(1);
		expect(engine.loadCalls[0].modelDir).toBe("/models");
	});

	it("rejects a protocol mismatch or missing payload", async () => {
		const { engine, send } = setup();
		expect(errorCode(await send("init", initPayload("query", 70, { protocol: PROTOCOL_VERSION + 1 })))).toBe("bad-request");
		expect(errorCode(await send("init"))).toBe("bad-request");
		expect(engine.loadCalls).toHaveLength(0);
	});

	it("rejects an unknown mode", async () => {
		const { send } = setup();
		const bad = { ...initPayload("query"), mode: "both" };
		expect(errorCode(await send("init", bad))).toBe("bad-request");
	});

	it("rejects a second init", async () => {
		const { engine, send } = setup();
		okResult<InitResult>(await send("init", initPayload("query")));
		expect(errorCode(await send("init", initPayload("query")))).toBe("already-initialized");
		expect(errorCode(await send("init", initPayload("index")))).toBe("already-initialized");
		expect(engine.loadCalls).toHaveLength(1);
	});

	it("maps a load failure to model-load and allows a later init", async () => {
		const { engine, send } = setup();
		engine.loadError = new Error("no WebGPU adapter");
		const failed = await send("init", initPayload("query"));
		expect(errorCode(failed)).toBe("model-load");
		expect(failed.message.ok ? "" : failed.message.error.message).toBe("no WebGPU adapter");
		// Still uninitialized: embed fails, a new init is accepted.
		expect(errorCode(await send("embedText", { queries: ["x"] }))).toBe("not-initialized");
		engine.loadError = null;
		expect(okResult<InitResult>(await send("init", initPayload("query"))).mode).toBe("query");
		expect(engine.loadCalls).toHaveLength(2);
	});

	it("ping reports the protocol and init state", async () => {
		const { send } = setup();
		expect(okResult<PingResult>(await send("ping"))).toEqual({
			protocol: PROTOCOL_VERSION,
			transformers: "4.3.1-test",
			webgpu: true,
			initialized: null,
		});
		await send("init", initPayload("query"));
		expect(okResult<PingResult>(await send("ping")).initialized).toBe("query");
	});
});

describe("worker handler: requests", () => {
	it("rejects embeds before init", async () => {
		const { send } = setup();
		expect(errorCode(await send("embedText", { queries: ["x"] }))).toBe("not-initialized");
		expect(errorCode(await send("embedImages", { images: [] }))).toBe("not-initialized");
	});

	it("ignores malformed messages and answers unknown types with bad-request", async () => {
		const { handler, posts, send } = setup();
		await handler.handle(null);
		await handler.handle(undefined);
		await handler.handle("ping");
		await handler.handle({ type: "ping" });
		await handler.handle({ id: "1", type: "ping" });
		expect(posts).toHaveLength(0);
		expect(errorCode(await send("dispose"))).toBe("bad-request");
		expect(errorCode(await send("bogus"))).toBe("bad-request");
	});

	it("embedText prefixes queries and returns transferred unit vectors", async () => {
		const { engine, send } = setup();
		await send("init", initPayload("query"));
		const post = await send("embedText", { queries: ["red car", "blue boat"] });
		const res = okResult<EmbedTextResult>(post);
		expect(engine.textCalls).toEqual([[QUERY_PREFIX + "red car", QUERY_PREFIX + "blue boat"]]);
		expect(res.vectors).toHaveLength(2);
		for (const v of res.vectors) {
			expect(v).toBeInstanceOf(Float32Array);
			expect(v).toHaveLength(EMBEDDING_DIMS);
			expect(l2norm(v)).toBeCloseTo(1, 5);
		}
		expect(Array.from(res.vectors[0])).toEqual(Array.from(expectedText("red car")));
		expect(Array.from(res.vectors[1])).toEqual(Array.from(expectedText("blue boat")));
		expect(post.transfer).toHaveLength(2);
		expect(post.transfer[0]).toBe(res.vectors[0].buffer);
		expect(post.transfer[1]).toBe(res.vectors[1].buffer);
		expect(res.ms).toBe(5);
	});

	it("embedText handles empty and invalid input", async () => {
		const { engine, send } = setup();
		await send("init", initPayload("query"));
		expect(okResult<EmbedTextResult>(await send("embedText", { queries: [] })).vectors).toEqual([]);
		expect(engine.textCalls).toHaveLength(0);
		expect(errorCode(await send("embedText", { queries: "x" }))).toBe("bad-request");
		expect(errorCode(await send("embedText", { queries: [1] }))).toBe("bad-request");
		expect(errorCode(await send("embedText"))).toBe("bad-request");
	});

	it("embedText maps engine failures and wrong row counts to inference", async () => {
		const { engine, send } = setup();
		await send("init", initPayload("query"));
		engine.textError = new Error("boom");
		expect(errorCode(await send("embedText", { queries: ["a"] }))).toBe("inference");
		engine.textError = null;
		engine.textRows = 1;
		expect(errorCode(await send("embedText", { queries: ["a", "b"] }))).toBe("inference");
	});

	it("rejects embedImages on a query worker", async () => {
		const { engine, send } = setup();
		await send("init", initPayload("query"));
		expect(errorCode(await send("embedImages", { images: [image("a", 1)] }))).toBe("unsupported");
		expect(engine.decodeCalls).toBe(0);
	});

	it("embedImages rejects a non-array payload", async () => {
		const { send } = setup();
		await send("init", initPayload("index"));
		expect(errorCode(await send("embedImages", { images: "nope" }))).toBe("bad-request");
		expect(errorCode(await send("embedImages"))).toBe("bad-request");
	});

	it("embedImages reports decode failures per image, in input order", async () => {
		const { engine, send } = setup();
		await send("init", initPayload("index", 140));
		const post = await send("embedImages", {
			images: [
				image("a", 10),
				image("b", 11, TAG_BAD_DECODE),
				image("c", 12),
				{ id: "d", bytes: "not a buffer", mime: "image/png" },
				image("e", 14),
			],
		});
		const res = okResult<EmbedImagesResult>(post);
		expect(res.items.map((i) => i.id)).toEqual(["a", "b", "c", "d", "e"]);
		expect(res.items[1]).toMatchObject({ ok: false, code: "decode", message: "cannot decode" });
		expect(res.items[3]).toMatchObject({ ok: false, code: "decode" });
		const okItems = [0, 2, 4].map((i) => res.items[i]);
		[10, 12, 14].forEach((seed, j) => {
			const item = okItems[j];
			expect(item.ok).toBe(true);
			if (item.ok) {
				expect(item.vector).toHaveLength(EMBEDDING_DIMS);
				expect(Array.from(item.vector)).toEqual(Array.from(expectedImage(seed)));
			}
		});
		// Only decoded images reach the model, in one batch (max 4 at 140).
		expect(engine.imageBatches).toEqual([3]);
		expect(res.batches).toBe(1);
		// Every decode/model call got the configured budget.
		expect(new Set(engine.budgets)).toEqual(new Set([140]));
		// Only successful vectors are transferred.
		expect(post.transfer).toEqual(okItems.map((i) => (i.ok ? i.vector.buffer : null)));
	});

	it.each([
		[70, [8, 2]],
		[140, [4, 4, 2]],
		[280, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
	] as const)("batches by token budget %i", async (budget, sizes) => {
		const { engine, send } = setup();
		await send("init", initPayload("index", budget));
		const images = Array.from({ length: 10 }, (_, i) => image(`i${i}`, i + 1));
		const res = okResult<EmbedImagesResult>(await send("embedImages", { images }));
		expect(engine.imageBatches).toEqual(sizes);
		expect(res.batches).toBe(sizes.length);
		expect(res.items.every((i) => i.ok)).toBe(true);
		res.items.forEach((item, i) => {
			if (item.ok) {
				expect(Array.from(item.vector)).toEqual(Array.from(expectedImage(i + 1)));
			}
		});
	});

	it("retries a failed batch one by one so only the bad image fails", async () => {
		const { engine, send } = setup();
		await send("init", initPayload("index", 70));
		const images = Array.from({ length: 10 }, (_, i) => image(`i${i}`, i + 1, i === 3 ? TAG_BAD_INFERENCE : TAG_OK));
		const res = okResult<EmbedImagesResult>(await send("embedImages", { images }));
		expect(engine.imageBatches).toEqual([8, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
		expect(res.batches).toBe(10);
		res.items.forEach((item, i) => {
			if (i === 3) {
				expect(item).toMatchObject({ id: "i3", ok: false, code: "inference", message: "GPU fell over" });
			} else {
				expect(item.ok).toBe(true);
				if (item.ok) {
					expect(Array.from(item.vector)).toEqual(Array.from(expectedImage(i + 1)));
				}
			}
		});
	});

	it("does not retry a failed single-image batch", async () => {
		const { engine, send } = setup();
		await send("init", initPayload("index", 280));
		const res = okResult<EmbedImagesResult>(
			await send("embedImages", { images: [image("a", 1), image("b", 2, TAG_BAD_INFERENCE), image("c", 3)] })
		);
		expect(engine.imageBatches).toEqual([1, 1, 1]);
		expect(res.batches).toBe(3);
		expect(res.items.map((i) => i.ok)).toEqual([true, false, true]);
		expect(res.items[1]).toMatchObject({ code: "inference" });
	});

	it("processes concurrent requests one at a time, in order", async () => {
		const { engine, handler, posts } = setup();
		await handler.handle({ id: 1, type: "init", payload: initPayload("query") });
		engine.textGate = deferred<void>();
		engine.maxActive = 0;
		const p2 = handler.handle({ id: 2, type: "embedText", payload: { queries: ["first"] } });
		const p3 = handler.handle({ id: 3, type: "embedText", payload: { queries: ["second"] } });
		const p4 = handler.handle({ id: 4, type: "ping" });
		await flushMicrotasks();
		// Request 2 is held inside the engine; 3 and 4 have not started.
		expect(engine.textCalls).toEqual([[QUERY_PREFIX + "first"]]);
		expect(posts.map((p) => p.message.id)).toEqual([1]);

		engine.textGate.resolve();
		await Promise.all([p2, p3, p4]);
		expect(engine.textCalls).toEqual([[QUERY_PREFIX + "first"], [QUERY_PREFIX + "second"]]);
		expect(engine.maxActive).toBe(1);
		expect(posts.map((p) => p.message.id)).toEqual([1, 2, 3, 4]);
		expect(posts.every((p) => p.message.ok)).toBe(true);
	});

	it("keeps processing after a failed request", async () => {
		const { engine, send } = setup();
		await send("init", initPayload("query"));
		engine.textError = new Error("transient");
		expect(errorCode(await send("embedText", { queries: ["a"] }))).toBe("inference");
		engine.textError = null;
		expect(okResult<EmbedTextResult>(await send("embedText", { queries: ["a"] })).vectors).toHaveLength(1);
	});
});
