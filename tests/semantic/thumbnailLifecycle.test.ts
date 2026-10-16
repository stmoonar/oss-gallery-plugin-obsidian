/**
 * Semantic indexing as a source of local gallery thumbnails (docs §13): the
 * worker makes them from the bitmap it decodes for the embedding and the
 * index service hands them to the thumbnail module (src/thumbnails) through
 * its public put(), only while thumbnails are on. Vectors never change.
 * Their lifecycle (deletes, listings, size cap) belongs to the thumbnail
 * module (tests/thumbnails); "Clear index" and "Clear thumbnails" are
 * independent.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	currentEmbeddingConfig,
	FAKE_IMAGE_CAPTION_PREFIX,
	FakeEmbeddingBackend,
	FakeEmbeddingBackendOptions,
	fakeImageBytes,
} from "../../src/semantic/EmbeddingBackend";
import { fingerprint, IndexScope, makeIndexScope, uploadFingerprint } from "../../src/semantic/fingerprint";
import { clearVaultIndex } from "../../src/semantic/indexFiles";
import { ThumbnailCache } from "../../src/thumbnails/ThumbnailCache";
import { THUMBS_DIR_NAME, THUMBS_MANIFEST, thumbnailFileName, thumbsVaultDir } from "../../src/thumbnails/thumbnailFiles";
import { ThumbnailGenerator } from "../../src/thumbnails/ThumbnailGenerator";
import { ThumbnailService } from "../../src/thumbnails/ThumbnailService";
import type { ImageInput } from "../../src/semantic/protocol";
import { IndexServiceDeps, SemanticIndexService } from "../../src/semantic/SemanticIndexService";
import { SemanticSearchService } from "../../src/semantic/SemanticSearchService";
import { META_FILE } from "../../src/semantic/VectorStore";
import type { ListResult, OssImage } from "../../src/types/oss";
import { FakeTimers, makeTempDir, removeDir } from "./helpers";

const CFG = currentEmbeddingConfig(70);
const VAULT = "vault1";
const LOCAL: IndexScope = makeIndexScope("local", { storagePath: "attachments", useRelativePath: true }, "");

/** Plays <appDir>: indexes in <root>/indexes, thumbnails in <root>/thumbs. */
let root: string;
let indexRoot: string;
let thumbsDir: string;
beforeEach(() => {
	root = makeTempDir("thumb-life-");
	indexRoot = path.join(root, "indexes");
	thumbsDir = thumbsVaultDir(path.join(root, THUMBS_DIR_NAME), VAULT);
});
afterEach(() => {
	removeDir(root);
});

function obj(key: string, opts: Partial<OssImage> = {}): OssImage {
	return { key, url: `https://cdn.example/${key}`, size: 1000, lastModified: new Date(1_700_000_000_000), ...opts };
}

function listing(items: OssImage[], complete = true, prefix = ""): ListResult {
	return { items, complete, prefix };
}

/** Records the inputs each embedImages call got. */
class RecordingBackend extends FakeEmbeddingBackend {
	readonly inputs: ImageInput[] = [];

	override embedImages(images: ImageInput[]) {
		this.inputs.push(...images.map((i) => ({ ...i })));
		return super.embedImages(images);
	}
}

interface Harness {
	service: SemanticIndexService;
	thumbs: ThumbnailService;
	backends: RecordingBackend[];
	settings: { thumbnails: boolean };
	clock: { now: number };
	/** Format each key is detected as (default png). */
	formats: Map<string, string>;
	settle(): Promise<void>;
	read(o: OssImage): Promise<string | null>;
}

function harness(options: { backend?: FakeEmbeddingBackendOptions; deps?: Partial<IndexServiceDeps> } = {}): Harness {
	const settings = { thumbnails: true };
	const thumbs = new ThumbnailService({
		cache: new ThumbnailCache(() => thumbsDir, { flushDelayMs: 0 }),
		generator: new ThumbnailGenerator({ encode: () => Promise.reject(new Error("not used by indexing")) }),
		isEnabled: () => settings.thumbnails,
		maxBytes: () => 500_000_000,
		timers: new FakeTimers(),
	});
	const backends: RecordingBackend[] = [];
	const clock = { now: 1_000_000 };
	const formats = new Map<string, string>();
	const service = new SemanticIndexService({
		indexRoot: () => indexRoot,
		vaultId: VAULT,
		embeddingConfig: () => CFG,
		isEnabled: () => true,
		isReady: () => true,
		autoIndex: () => false,
		createBackend: () => {
			const b = new RecordingBackend(options.backend);
			backends.push(b);
			return b;
		},
		readBytes: (_scope, o) => Promise.resolve(fakeImageBytes(`${o.key}#${fingerprint(o)}`)),
		rasterizeSvg: () => Promise.resolve(fakeImageBytes("svg")),
		prepare: (bytes, key) => {
			const format = formats.get(key) ?? "png";
			if (format === "heic") {
				return Promise.resolve({ kind: "unsupported", format: "heic", reason: "HEIC/HEIF is not supported" });
			}
			return Promise.resolve({ kind: "embed", bytes, mime: `image/${format}`, format: format as "png" });
		},
		confirmTraffic: () => Promise.resolve(true),
		now: () => clock.now,
		storeOptions: { flushDelayMs: 0 },
		statusFlushDelayMs: 0,
		thumbnails: thumbs,
		thumbnailsEnabled: () => settings.thumbnails,
		...options.deps,
	});
	return {
		service,
		thumbs,
		backends,
		settings,
		clock,
		formats,
		settle: async () => {
			await service.whenIdle();
			await thumbs.flush();
		},
		read: async (o) => {
			const r = await thumbs.tileSource(LOCAL.id, o, null)?.readThumbnail?.();
			return r ? new TextDecoder().decode(r.bytes) : null;
		},
	};
}

async function indexAll(h: Harness, items: OssImage[]): Promise<void> {
	h.service.reconcile(h.service.beginListing(LOCAL), LOCAL, listing(items));
	await h.service.start(LOCAL);
	await h.settle();
}

function thumbFiles(): string[] {
	const dir = path.join(thumbsDir, LOCAL.id);
	return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n !== THUMBS_MANIFEST).sort() : [];
}

function requested(h: Harness): Map<string, boolean> {
	const out = new Map<string, boolean>();
	for (const b of h.backends) {
		for (const i of b.inputs) {
			out.set(i.id, i.thumbnail !== undefined);
		}
	}
	return out;
}

describe("thumbnails from indexing", () => {
	it("asks the worker for a thumbnail per image and stores it for the object's fingerprint", async () => {
		const h = harness();
		const a = obj("a.png");
		const b = obj("b.png", { etag: "\"b\"" });
		await indexAll(h, [a, b]);
		expect(h.backends[0].inputs.every((i) => i.thumbnail?.maxSide === 320 && i.thumbnail.quality === 0.8)).toBe(true);
		expect(await h.read(a)).toBe("fake-thumb:a.png");
		expect(await h.read(b)).toBe("fake-thumb:b.png");
		expect(thumbFiles()).toEqual([
			thumbnailFileName("a.png", fingerprint(a), "webp"),
			thumbnailFileName("b.png", fingerprint(b), "webp"),
		].sort());
	});

	it("thumbnails do not change the embedding vectors", async () => {
		const withThumbs = harness();
		await indexAll(withThumbs, [obj("a.png")]);
		const vecWith = withThumbs.service.getSearchStore(LOCAL)?.get("a.png")?.vec;
		expect(vecWith?.length).toBe(CFG.dims);
		expect(withThumbs.backends[0].inputs[0].thumbnail).toBeDefined();
		withThumbs.service.dispose();
		removeDir(root);
		fs.mkdirSync(root, { recursive: true });
		const without = harness();
		without.settings.thumbnails = false;
		await indexAll(without, [obj("a.png")]);
		expect([...(without.service.getSearchStore(LOCAL)?.get("a.png")?.vec ?? [])]).toEqual([...(vecWith ?? [])]);
	});

	it("requests none when thumbnails are turned off, and none for GIFs (animation stays)", async () => {
		const h = harness();
		h.formats.set("anim.gif", "gif");
		await indexAll(h, [obj("anim.gif"), obj("a.png")]);
		expect(requested(h)).toEqual(new Map([["anim.gif", false], ["a.png", true]]));
		expect(await h.read(obj("anim.gif"))).toBeNull();

		const off = harness();
		off.settings.thumbnails = false;
		await indexAll(off, [obj("c.png")]);
		expect(requested(off).get("c.png")).toBe(false);
	});

	it("a thumbnail failure never fails the embedding", async () => {
		const h = harness({ backend: { failThumbnailIds: ["a.png"] } });
		await indexAll(h, [obj("a.png"), obj("b.png")]);
		expect(h.service.isIndexed(LOCAL, "a.png")).toBe(true);
		expect(await h.read(obj("a.png"))).toBeNull();
		expect(await h.read(obj("b.png"))).toBe("fake-thumb:b.png");
	});

	it("a failed embedding stores no thumbnail", async () => {
		const h = harness({ backend: { failImageIds: ["a.png"] } });
		await indexAll(h, [obj("a.png")]);
		expect(h.service.isIndexed(LOCAL, "a.png")).toBe(false);
		expect(thumbFiles()).toEqual([]);
	});

	it("a changed fingerprint re-embeds and replaces the thumbnail", async () => {
		const h = harness();
		const v1 = obj("a.png", { etag: "\"1\"" });
		const v2 = obj("a.png", { etag: "\"2\"" });
		await indexAll(h, [v1]);
		await indexAll(h, [v2]);
		expect(await h.read(v1)).toBeNull();
		expect(await h.read(v2)).toBe("fake-thumb:a.png");
		expect(thumbFiles()).toEqual([thumbnailFileName("a.png", fingerprint(v2), "webp")]);
	});

	it("an object that became unsupported shows no stale thumbnail", async () => {
		const h = harness();
		await indexAll(h, [obj("a.png", { etag: "\"1\"" })]);
		h.formats.set("a.png", "heic");
		await indexAll(h, [obj("a.png", { etag: "\"2\"" })]);
		expect(await h.read(obj("a.png", { etag: "\"2\"" }))).toBeNull();
	});

	it("indexing with thumbnails turned off writes none (the module ignores puts too)", async () => {
		const h = harness();
		h.settings.thumbnails = false;
		await indexAll(h, [obj("a.png")]);
		expect(thumbFiles()).toEqual([]);
		await h.thumbs.put(LOCAL.id, "a.png", fingerprint(obj("a.png")), { bytes: new ArrayBuffer(4), mime: "image/webp" });
		expect(thumbFiles()).toEqual([]);
	});
});

describe("thumbnails and the index stay independent", () => {
	it("an upload gets a thumbnail from the bytes in hand; the gallery listing adopts its fingerprint", async () => {
		const h = harness();
		await indexAll(h, [obj("a.png")]);
		const upload = obj("up.png", { url: "", size: 1234 });
		h.service.onUploaded(LOCAL, upload, fakeImageBytes("uploaded"));
		await h.settle();
		expect(thumbFiles()).toContain(thumbnailFileName("up.png", uploadFingerprint(1234), "webp"));

		const listed = obj("up.png", { etag: "\"real\"", size: 1234 });
		expect(await h.read(listed)).toBe("fake-thumb:up.png");
		const items = listing([obj("a.png"), listed]);
		h.service.reconcile(h.service.beginListing(LOCAL), LOCAL, items);
		await h.thumbs.onListing(LOCAL.id, items, Date.now());
		await h.settle();
		expect(thumbFiles()).toContain(thumbnailFileName("up.png", fingerprint(listed), "webp"));
		expect(thumbFiles()).not.toContain(thumbnailFileName("up.png", uploadFingerprint(1234), "webp"));
		expect(await h.read(listed)).toBe("fake-thumb:up.png");
		// Adopted, not re-embedded.
		expect(h.backends.flatMap((b) => b.inputs.map((i) => i.id)).filter((id) => id === "up.png")).toHaveLength(1);
	});

	it("Clear index keeps thumbnails; Clear thumbnails keeps the index", async () => {
		const h = harness();
		const items = [obj("cat.png"), obj("dog.png")];
		await indexAll(h, items);
		const indexDir = path.join(indexRoot, VAULT, LOCAL.id);

		await h.thumbs.clear();
		expect(thumbFiles()).toEqual([]);
		expect(fs.existsSync(path.join(indexDir, META_FILE))).toBe(true);
		expect(h.service.isIndexed(LOCAL, "cat.png")).toBe(true);
		const search = new SemanticSearchService({
			getStore: (scope) => h.service.getSearchStore(scope),
			createQueryBackend: () => new FakeEmbeddingBackend(),
			embeddingConfig: () => CFG,
		});
		expect(search.searchSimilar(LOCAL, "cat.png", items).map((o) => o.key)).toEqual(["dog.png"]);

		// Rebuild the thumbnails (re-index after an index reset), then clear the index.
		h.service.closeAll();
		clearVaultIndex(indexRoot, VAULT);
		await indexAll(h, items);
		expect(thumbFiles()).toHaveLength(2);
		h.service.closeAll();
		clearVaultIndex(indexRoot, VAULT);
		expect(fs.existsSync(indexDir)).toBe(false);
		expect(thumbFiles()).toHaveLength(2);
		expect(await h.read(obj("cat.png"))).toBe("fake-thumb:cat.png");
	});

	it("deletes and complete listings in the index service leave thumbnails to the thumbnail module", async () => {
		const h = harness();
		await indexAll(h, [obj("a.png"), obj("b.png")]);
		h.service.onDeleted(LOCAL, "a.png");
		h.service.reconcile(h.service.beginListing(LOCAL), LOCAL, listing([]));
		await h.settle();
		expect(thumbFiles()).toHaveLength(2);
	});

	it("a thumbnail writer that throws never breaks indexing", async () => {
		const failing = { put: () => Promise.reject(new Error("disk full")) };
		const h = harness({ deps: { thumbnails: failing } });
		await indexAll(h, [obj("a.png")]);
		h.service.onDeleted(LOCAL, "a.png");
		expect(h.service.isIndexed(LOCAL, "a.png")).toBe(false);
		await indexAll(h, [obj("b.png")]);
		expect(h.service.isIndexed(LOCAL, "b.png")).toBe(true);

		const throwing = harness({ deps: { thumbnails: { put: () => { throw new Error("boom"); } } } });
		await indexAll(throwing, [obj("c.png")]);
		expect(throwing.service.isIndexed(LOCAL, "c.png")).toBe(true);
	});
});

describe("fake backend thumbnails", () => {
	it("returns a thumbnail only when asked", async () => {
		const b = new FakeEmbeddingBackend();
		await b.init("index", CFG);
		const [plain, asked] = await b.embedImages([
			{ id: "p", bytes: fakeImageBytes("p"), mime: "image/png" },
			{ id: "q", bytes: fakeImageBytes("q"), mime: "image/png", thumbnail: { maxSide: 320, quality: 0.8 } },
		]);
		expect(plain.ok && plain.thumbnail).toBeFalsy();
		expect(asked.ok && asked.thumbnail?.mime).toBe("image/webp");
		expect(FAKE_IMAGE_CAPTION_PREFIX).toBe("fake-image:");
	});
});
