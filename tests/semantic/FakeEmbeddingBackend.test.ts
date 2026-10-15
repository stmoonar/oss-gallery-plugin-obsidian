import { describe, expect, it } from "vitest";
import {
	currentEmbeddingConfig,
	FakeEmbeddingBackend,
	fakeImageBytes,
	fnv1a,
	seededVector,
} from "../../src/semantic/EmbeddingBackend";
import { MODEL_ID, MODEL_REVISION } from "../../src/semantic/assets";
import {
	dot,
	EMBEDDING_DIMS,
	EmbeddingConfig,
	EmbeddingError,
	l2norm,
	PREPROCESS_VERSION,
} from "../../src/semantic/protocol";
import { toArrayBuffer } from "./helpers";

const CFG: EmbeddingConfig = currentEmbeddingConfig(70);

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	const error: unknown = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(EmbeddingError);
	expect((error as EmbeddingError).code).toBe(code);
}

describe("currentEmbeddingConfig", () => {
	it("describes this build's model", () => {
		expect(currentEmbeddingConfig(70)).toEqual({
			modelId: MODEL_ID,
			revision: MODEL_REVISION,
			dtype: "q4",
			dims: EMBEDDING_DIMS,
			imageTokenBudget: 70,
			preprocessVersion: PREPROCESS_VERSION,
		});
		expect(currentEmbeddingConfig(280).imageTokenBudget).toBe(280);
		expect(EMBEDDING_DIMS).toBe(256);
	});
});

describe("fnv1a / seededVector", () => {
	it("fnv1a matches known values", () => {
		expect(fnv1a(new Uint8Array())).toBe(0x811c9dc5);
		expect(fnv1a(new TextEncoder().encode("a"))).toBe(0xe40c292c);
		expect(fnv1a(new TextEncoder().encode("foobar"))).toBe(0xbf9cf968);
	});

	it("seededVector is deterministic and unit length", () => {
		const a = seededVector(42, 64);
		expect(Array.from(seededVector(42, 64))).toEqual(Array.from(a));
		expect(Array.from(seededVector(43, 64))).not.toEqual(Array.from(a));
		expect(a).toHaveLength(64);
		expect(l2norm(a)).toBeCloseTo(1, 5);
	});
});

describe("FakeEmbeddingBackend", () => {
	it("returns deterministic unit vectors of cfg.dims", async () => {
		const backend = new FakeEmbeddingBackend();
		const info = await backend.init("query", CFG);
		expect(info).toEqual({ mode: "query", sessions: ["model"], loadMs: 0, verifyMs: 0 });
		const [a1, b, a2] = await backend.embedText(["a red car", "a blue boat", "a red car"]);
		expect(a1).toHaveLength(CFG.dims);
		expect(l2norm(a1)).toBeCloseTo(1, 5);
		expect(l2norm(b)).toBeCloseTo(1, 5);
		expect(Array.from(a2)).toEqual(Array.from(a1));
		expect(Array.from(b)).not.toEqual(Array.from(a1));
		expect(dot(a1, b)).toBeLessThan(0.99);

		const other = new FakeEmbeddingBackend();
		await other.init("query", CFG);
		const [again] = await other.embedText(["a red car"]);
		expect(Array.from(again)).toEqual(Array.from(a1));
	});

	it("uses cfg.dims", async () => {
		const backend = new FakeEmbeddingBackend();
		await backend.init("index", { ...CFG, dims: 32 });
		const [v] = await backend.embedText(["x"]);
		expect(v).toHaveLength(32);
		const [img] = await backend.embedImages([{ id: "i", bytes: toArrayBuffer(new Uint8Array([1, 2, 3])), mime: "image/png" }]);
		expect(img.ok && img.vector.length).toBe(32);
	});

	it("gives a fake image the vector of its caption", async () => {
		const backend = new FakeEmbeddingBackend();
		const info = await backend.init("index", CFG);
		expect(info.sessions).toEqual(["model", "vision_encoder"]);
		const [text] = await backend.embedText(["a cat on a sofa"]);
		const items = await backend.embedImages([
			{ id: "cat", bytes: fakeImageBytes("a cat on a sofa"), mime: "image/png" },
			{ id: "raw", bytes: toArrayBuffer(new Uint8Array([9, 9, 9, 9])), mime: "image/jpeg" },
		]);
		expect(items.map((i) => i.id)).toEqual(["cat", "raw"]);
		const [cat, raw] = items;
		expect(cat.ok).toBe(true);
		expect(raw.ok).toBe(true);
		if (cat.ok && raw.ok) {
			expect(Array.from(cat.vector)).toEqual(Array.from(text));
			expect(raw.vector).toHaveLength(CFG.dims);
			expect(l2norm(raw.vector)).toBeCloseTo(1, 5);
			expect(dot(raw.vector, text)).toBeLessThan(0.99);
		}
	});

	it("fakeImageBytes returns a standalone ArrayBuffer", () => {
		const bytes = fakeImageBytes("x");
		expect(new TextDecoder().decode(bytes)).toBe("fake-image:x");
		expect(bytes.byteLength).toBe("fake-image:x".length);
	});

	it("rejects embedImages on a query backend", async () => {
		const backend = new FakeEmbeddingBackend();
		await backend.init("query", CFG);
		await expectCode(backend.embedImages([{ id: "a", bytes: fakeImageBytes("a"), mime: "image/png" }]), "unsupported");
	});

	it("fails the configured image ids with decode errors", async () => {
		const backend = new FakeEmbeddingBackend({ failImageIds: ["bad"] });
		await backend.init("index", CFG);
		const items = await backend.embedImages([
			{ id: "good", bytes: fakeImageBytes("good"), mime: "image/png" },
			{ id: "bad", bytes: fakeImageBytes("bad"), mime: "image/png" },
		]);
		expect(items[0].ok).toBe(true);
		expect(items[1]).toMatchObject({ id: "bad", ok: false, code: "decode" });
	});

	it("rejects use before init and init twice", async () => {
		const backend = new FakeEmbeddingBackend();
		await expectCode(backend.embedText(["x"]), "not-initialized");
		await expectCode(backend.embedImages([]), "not-initialized");
		await backend.init("query", CFG);
		await expectCode(backend.init("query", CFG), "already-initialized");
	});

	it("rejects everything after dispose", async () => {
		const backend = new FakeEmbeddingBackend();
		await backend.init("index", CFG);
		await backend.dispose();
		await expectCode(backend.embedText(["x"]), "terminated");
		await expectCode(backend.embedImages([]), "terminated");
		await expectCode(backend.init("index", CFG), "terminated");
	});

	it("records calls and honours injected latency", async () => {
		const sleeps: number[] = [];
		const backend = new FakeEmbeddingBackend({
			latencyMs: 25,
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		await backend.init("index", CFG);
		await backend.embedText(["a", "b"]);
		await backend.embedImages([{ id: "a", bytes: fakeImageBytes("a"), mime: "image/png" }]);
		expect(sleeps).toEqual([25, 25, 25]);
		expect(backend.calls).toEqual([
			{ type: "init", count: 1 },
			{ type: "embedText", count: 2 },
			{ type: "embedImages", count: 1 },
		]);
	});
});
