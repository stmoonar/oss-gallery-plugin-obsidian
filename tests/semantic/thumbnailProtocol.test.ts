/**
 * Worker protocol for gallery thumbnails (PROTOCOL_VERSION 3): per-image
 * thumbnail requests, results only next to a vector, transferred buffers,
 * failures that never affect the embedding.
 */
import { describe, expect, it } from "vitest";
import { currentEmbeddingConfig, seededVector } from "../../src/semantic/EmbeddingBackend";
import {
	EmbedImagesResult,
	EncodedThumbnail,
	InitPayload,
	isEncodedThumbnail,
	isThumbnailRequest,
	MAX_THUMBNAIL_BYTES,
	PROTOCOL_VERSION,
	ThumbnailRequest,
	thumbnailSize,
	WorkerResponse,
} from "../../src/semantic/protocol";
import { createWorkerHandler, Engine, EngineLoadResult, RawEmbeddings } from "../../src/semantic/worker/handler";
import { toArrayBuffer } from "./helpers";

const RAW_DIMS = 768;
const REQUEST: ThumbnailRequest = { maxSide: 320, quality: 0.8 };

interface Img {
	seed: number;
	poison: boolean;
}

function raw(seeds: number[]): RawEmbeddings {
	const data = new Float32Array(seeds.length * RAW_DIMS);
	seeds.forEach((s, i) => data.set(seededVector(s, RAW_DIMS), i * RAW_DIMS));
	return { data, rows: seeds.length, dims: RAW_DIMS };
}

function thumbBytes(text: string): ArrayBuffer {
	return toArrayBuffer(new TextEncoder().encode(text));
}

/** Byte 0: 1 ok, 0xbb poison (inference fails), 0x7f thumbnail throws, 0x7e oversized thumbnail. */
class ThumbEngine implements Engine<Img> {
	plainDecodes = 0;
	thumbDecodes: ThumbnailRequest[] = [];

	load(payload: InitPayload): Promise<EngineLoadResult> {
		return Promise.resolve({ sessions: ["model", "vision_encoder"], filesRead: payload.files.length });
	}

	embedText(texts: string[]): Promise<RawEmbeddings> {
		return Promise.resolve(raw(texts.map((_, i) => i + 1)));
	}

	decodeImage(bytes: ArrayBuffer): Promise<Img> {
		this.plainDecodes++;
		const b = new Uint8Array(bytes);
		return Promise.resolve({ seed: b[1], poison: b[0] === 0xbb });
	}

	decodeImageWithThumbnail(bytes: ArrayBuffer, _mime: string, _budget: number, request: ThumbnailRequest): Promise<{ image: Img; thumbnail: EncodedThumbnail | null }> {
		this.thumbDecodes.push(request);
		const b = new Uint8Array(bytes);
		const image = { seed: b[1], poison: b[0] === 0xbb };
		if (b[0] === 0x7f) {
			return Promise.resolve({ image, thumbnail: null });
		}
		if (b[0] === 0x7e) {
			return Promise.resolve({ image, thumbnail: { bytes: new ArrayBuffer(MAX_THUMBNAIL_BYTES + 1), mime: "image/webp" } });
		}
		return Promise.resolve({ image, thumbnail: { bytes: thumbBytes(`t${b[1]}`), mime: b[2] === 1 ? "image/jpeg" : "image/webp" } });
	}

	embedImages(images: Img[]): Promise<RawEmbeddings> {
		if (images.some((i) => i.poison)) {
			return Promise.reject(new Error("GPU fell over"));
		}
		return Promise.resolve(raw(images.map((i) => i.seed)));
	}
}

async function setup(engine: Engine<Img> = new ThumbEngine()) {
	const posts: Array<{ message: WorkerResponse; transfer: Transferable[] }> = [];
	const handler = createWorkerHandler(engine, { transformersVersion: "test", webgpu: true, now: () => 0 }, (message, transfer) =>
		posts.push({ message, transfer }));
	let id = 0;
	const send = async (type: string, payload: unknown) => {
		const reqId = ++id;
		await handler.handle({ id: reqId, type, payload });
		const post = posts.find((p) => p.message.id === reqId);
		if (!post) throw new Error("no response");
		return post;
	};
	const init: InitPayload = {
		protocol: PROTOCOL_VERSION,
		mode: "index",
		config: currentEmbeddingConfig(70),
		modelDir: "/m",
		files: [],
		wasmBinary: new ArrayBuffer(1),
		wasmFactory: "",
	};
	await send("init", init);
	return { send };
}

function image(id: string, tag: number, seed: number, thumbnail?: unknown, jpeg = false) {
	return { id, bytes: toArrayBuffer(new Uint8Array([tag, seed, jpeg ? 1 : 0])), mime: "image/png", ...(thumbnail === undefined ? {} : { thumbnail }) };
}

function resultOf(post: { message: WorkerResponse }): EmbedImagesResult {
	if (!post.message.ok) throw new Error(post.message.error.message);
	return post.message.result as EmbedImagesResult;
}

describe("thumbnail protocol", () => {
	it("returns a thumbnail next to the vector only for images that asked, and transfers it", async () => {
		const engine = new ThumbEngine();
		const { send } = await setup(engine);
		const post = await send("embedImages", {
			images: [image("a", 1, 3, REQUEST), image("b", 1, 4), image("c", 1, 5, REQUEST, true)],
		});
		const { items } = resultOf(post);
		expect(items.map((i) => i.ok)).toEqual([true, true, true]);
		const [a, b, c] = items;
		expect(a.ok && new TextDecoder().decode(a.thumbnail?.bytes)).toBe("t3");
		expect(a.ok && a.thumbnail?.mime).toBe("image/webp");
		expect(b.ok && b.thumbnail).toBeUndefined();
		expect(c.ok && c.thumbnail?.mime).toBe("image/jpeg");
		expect(engine.plainDecodes).toBe(1);
		expect(engine.thumbDecodes).toEqual([REQUEST, REQUEST]);
		// Vectors and both thumbnail buffers are transferred.
		expect(post.transfer).toHaveLength(5);
		expect(post.transfer).toContain(a.ok ? a.thumbnail?.bytes : null);
	});

	it("the vector is the same with or without a thumbnail", async () => {
		const { send } = await setup();
		const { items } = resultOf(await send("embedImages", { images: [image("x", 1, 9, REQUEST), image("y", 1, 9)] }));
		const [x, y] = items;
		expect(x.ok && y.ok && [...x.vector]).toEqual(y.ok ? [...y.vector] : null);
	});

	it("a missing, oversized or malformed thumbnail is dropped without failing the image", async () => {
		const { send } = await setup();
		const { items } = resultOf(await send("embedImages", {
			images: [image("none", 0x7f, 1, REQUEST), image("big", 0x7e, 2, REQUEST), image("bad-req", 1, 3, { maxSide: "x" })],
		}));
		expect(items.map((i) => i.ok)).toEqual([true, true, true]);
		expect(items.every((i) => i.ok && i.thumbnail === undefined)).toBe(true);
	});

	it("an image whose inference fails gets no thumbnail; its batch mates keep theirs", async () => {
		const { send } = await setup();
		const post = await send("embedImages", { images: [image("ok", 1, 1, REQUEST), image("poison", 0xbb, 2, REQUEST)] });
		const [ok, poison] = resultOf(post).items;
		expect(ok.ok && ok.thumbnail).toBeTruthy();
		expect(poison.ok).toBe(false);
		expect("thumbnail" in poison).toBe(false);
		expect(post.transfer).toHaveLength(2);
	});

	it("engines without thumbnail support decode as before and return none", async () => {
		const plain: Engine<Img> = {
			load: (p) => Promise.resolve({ sessions: ["model"], filesRead: p.files.length }),
			embedText: () => Promise.resolve(raw([1])),
			decodeImage: (bytes) => Promise.resolve({ seed: new Uint8Array(bytes)[1], poison: false }),
			embedImages: (imgs) => Promise.resolve(raw(imgs.map((i) => i.seed))),
		};
		const { send } = await setup(plain);
		const { items } = resultOf(await send("embedImages", { images: [image("a", 1, 1, REQUEST)] }));
		expect(items[0].ok && items[0].thumbnail).toBeUndefined();
	});
});

describe("thumbnail helpers", () => {
	it("thumbnailSize keeps the aspect ratio, caps the longest side and never upscales", () => {
		expect(thumbnailSize(4000, 3000, 320)).toEqual({ width: 320, height: 240 });
		expect(thumbnailSize(1000, 4000, 320)).toEqual({ width: 80, height: 320 });
		expect(thumbnailSize(200, 100, 320)).toEqual({ width: 200, height: 100 });
		expect(thumbnailSize(10000, 1, 320)).toEqual({ width: 320, height: 1 });
		expect(thumbnailSize(0, 100, 320)).toBeNull();
	});

	it("validates requests and results", () => {
		expect(isThumbnailRequest(REQUEST)).toBe(true);
		expect(isThumbnailRequest({ maxSide: 0, quality: 0.8 })).toBe(false);
		expect(isThumbnailRequest({ maxSide: 320, quality: 2 })).toBe(false);
		expect(isThumbnailRequest(null)).toBe(false);
		expect(isEncodedThumbnail({ bytes: new ArrayBuffer(10), mime: "image/webp" })).toBe(true);
		expect(isEncodedThumbnail({ bytes: new ArrayBuffer(10), mime: "image/png" })).toBe(false);
		expect(isEncodedThumbnail({ bytes: new ArrayBuffer(0), mime: "image/jpeg" })).toBe(false);
		expect(isEncodedThumbnail({ bytes: "x", mime: "image/jpeg" })).toBe(false);
	});
});
