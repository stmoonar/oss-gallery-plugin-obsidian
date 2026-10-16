/**
 * Lazy thumbnails without semantic search (src/thumbnails/ThumbnailService):
 * one download serves the display and the thumbnail, the gallery hooks
 * keep the cache in step with listings and deletes, the size cap is
 * enforced in the background, and src/thumbnails never imports src/semantic.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EncodedThumbnail } from "../../src/thumbnails/encode";
import { ThumbnailCache } from "../../src/thumbnails/ThumbnailCache";
import { THUMBS_DIR_NAME, thumbnailFileName, thumbsVaultDir } from "../../src/thumbnails/thumbnailFiles";
import { lazyThumbnailMime, ThumbnailEncoder, ThumbnailGenerator } from "../../src/thumbnails/ThumbnailGenerator";
import { EVICT_AFTER_WRITE_MS, ThumbnailService } from "../../src/thumbnails/ThumbnailService";
import type { ListResult, OssImage } from "../../src/types/oss";
import { fingerprint, uploadFingerprint } from "../../src/utils/objectScope";
import { deferred, FakeTimers, flushMicrotasks, makeTempDir, removeDir, toArrayBuffer } from "../semantic/helpers";
import { bytes as concat, png } from "../semantic/imageBuilders";

const SCOPE = "0123456789abcdef";

let root: string;
let vaultDir: string;
beforeEach(() => {
	root = makeTempDir("thumb-svc-");
	vaultDir = thumbsVaultDir(path.join(root, THUMBS_DIR_NAME), "vault1");
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

/** A decodable-looking PNG (valid header) of the given size. */
function pngBytes(width = 640, height = 480): ArrayBuffer {
	return toArrayBuffer(concat(png(width, height), new Uint8Array(64)));
}

function encoded(text: string): EncodedThumbnail {
	return { bytes: toArrayBuffer(new TextEncoder().encode(text)), mime: "image/webp" };
}

interface Harness {
	service: ThumbnailService;
	cache: ThumbnailCache;
	settings: { enabled: boolean; maxBytes: number };
	timers: FakeTimers;
	/** Decodes seen by the fake encoder: mime per call. */
	encodes: string[];
	/** Originals downloaded through loadOriginal. */
	downloads: string[];
	loader(o: OssImage, data?: ArrayBuffer): (signal: AbortSignal) => Promise<ArrayBuffer>;
	text(o: OssImage): Promise<string | null>;
}

function harness(options: { encode?: ThumbnailEncoder } = {}): Harness {
	const timers = new FakeTimers();
	const settings = { enabled: true, maxBytes: 500_000_000 };
	const encodes: string[] = [];
	const downloads: string[] = [];
	const cache = new ThumbnailCache(() => vaultDir, { flushDelayMs: 0 });
	const generator = new ThumbnailGenerator({
		encode: options.encode ?? ((_bytes, mime) => {
			encodes.push(mime);
			return Promise.resolve(encoded(`thumb:${encodes.length}`));
		}),
	});
	const service = new ThumbnailService({
		cache,
		generator,
		isEnabled: () => settings.enabled,
		maxBytes: () => settings.maxBytes,
		timers,
	});
	return {
		service,
		cache,
		settings,
		timers,
		encodes,
		downloads,
		loader: (o, data = pngBytes()) => () => {
			downloads.push(o.key);
			return Promise.resolve(data);
		},
		text: async (o) => {
			const r = await cache.read(SCOPE, o);
			return r ? new TextDecoder().decode(r.bytes) : null;
		},
	};
}

/** What LazyImageService does for a tile: cached thumbnail, else the original once + a thumbnail from it. */
async function showTile(h: Harness, o: OssImage, data?: ArrayBuffer): Promise<{ shown: "thumbnail" | "original"; swapped: string | null }> {
	const source = h.service.tileSource(SCOPE, o, h.loader(o, data));
	if (!source) {
		throw new Error("thumbnails are off");
	}
	const cached = await source.readThumbnail?.();
	if (cached) {
		return { shown: "thumbnail", swapped: null };
	}
	const bytes = await source.loadOriginal?.(new AbortController().signal);
	if (!bytes) {
		throw new Error("no original");
	}
	const thumb = await source.thumbnailFrom?.(bytes);
	return { shown: "original", swapped: thumb ? new TextDecoder().decode(thumb.bytes) : null };
}

describe("lazy thumbnails (semantic search off / not installed)", () => {
	it("one download serves the display and the thumbnail; the next view needs no download", async () => {
		const h = harness();
		const a = obj("img/a.png", { etag: "\"1\"" });
		expect(await showTile(h, a)).toEqual({ shown: "original", swapped: "thumb:1" });
		expect(h.downloads).toEqual(["img/a.png"]);
		expect(h.encodes).toEqual(["image/png"]);
		expect(await h.text(a)).toBe("thumb:1");
		expect(fs.readdirSync(path.join(vaultDir, SCOPE))).toContain(thumbnailFileName(a.key, fingerprint(a), "webp"));

		expect(await showTile(h, a)).toEqual({ shown: "thumbnail", swapped: null });
		expect(h.downloads).toEqual(["img/a.png"]);
		expect(h.encodes).toHaveLength(1);
	});

	it("a changed object gets a new thumbnail (the old one is replaced)", async () => {
		const h = harness();
		const v1 = obj("a.png", { etag: "\"1\"" });
		const v2 = obj("a.png", { etag: "\"2\"" });
		await showTile(h, v1);
		expect((await showTile(h, v2)).shown).toBe("original");
		await h.service.flush();
		expect(fs.readdirSync(path.join(vaultDir, SCOPE)).filter((n) => n.endsWith(".webp")))
			.toEqual([thumbnailFileName("a.png", fingerprint(v2), "webp")]);
	});

	it("no thumbnail for GIF, SVG, TIFF, unknown data or images over the pixel limit; the tile still shows the original", async () => {
		const h = harness();
		const gif = toArrayBuffer(concat("GIF89a", new Uint8Array([10, 0, 10, 0, 0, 0, 0]), new Uint8Array(32)));
		const svg = toArrayBuffer(new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"));
		const tiff = toArrayBuffer(new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0]));
		for (const [key, data] of [["a.gif", gif], ["b.svg", svg], ["c.tif", tiff], ["d.png", toArrayBuffer(new Uint8Array(40))], ["e.png", pngBytes(20_000, 20_000)]] as const) {
			expect(await showTile(h, obj(key), data)).toEqual({ shown: "original", swapped: null });
		}
		expect(h.encodes).toEqual([]);
		expect((await h.service.stats()).count).toBe(0);
		expect(lazyThumbnailMime(pngBytes(), "x.png")).toBe("image/png");
	});

	it("a failing encoder never breaks the tile", async () => {
		const h = harness({ encode: () => Promise.reject(new Error("decode failed")) });
		expect(await showTile(h, obj("a.png"))).toEqual({ shown: "original", swapped: null });
		expect((await h.service.stats()).count).toBe(0);
	});

	it("thumbnails off: no tile source (originals load as before) and writes are ignored", async () => {
		const h = harness();
		h.settings.enabled = false;
		expect(h.service.tileSource(SCOPE, obj("a.png"), h.loader(obj("a.png")))).toBeNull();
		await h.service.put(SCOPE, "a.png", fingerprint(obj("a.png")), encoded("from indexing"));
		expect(await h.service.thumbnailFrom(SCOPE, obj("a.png"), pngBytes())).toBeNull();
		expect((await h.service.stats()).count).toBe(0);
		expect(h.timers.size).toBe(0);
	});

	it("without a loader the tile only tries the cache (TIFF placeholder, GIF/SVG through <img>)", async () => {
		const h = harness();
		const source = h.service.tileSource(SCOPE, obj("a.tif"), null);
		expect(source?.readThumbnail).toBeDefined();
		expect(source?.loadOriginal).toBeUndefined();
		expect(source?.thumbnailFrom).toBeUndefined();
	});
});

describe("generator", () => {
	it("runs at most two encodes at once and drops work beyond its queue", async () => {
		const gates = [deferred<EncodedThumbnail | null>(), deferred<EncodedThumbnail | null>()];
		let started = 0;
		const generator = new ThumbnailGenerator({
			encode: () => gates[started++]?.promise ?? Promise.resolve(encoded("late")),
			maxConcurrent: 2,
			maxQueued: 1,
		});
		const first = generator.generate(pngBytes(), "1.png");
		const second = generator.generate(pngBytes(), "2.png");
		const third = generator.generate(pngBytes(), "3.png");
		const dropped = generator.generate(pngBytes(), "4.png");
		await flushMicrotasks();
		expect(started).toBe(2);
		expect(generator.pending).toBe(3);
		expect(await dropped).toBeNull();
		gates[0].resolve(encoded("one"));
		gates[1].resolve(null);
		expect(await first).not.toBeNull();
		expect(await second).toBeNull();
		expect(new TextDecoder().decode((await third)?.bytes)).toBe("late");
		generator.dispose();
		expect(await generator.generate(pngBytes(), "5.png")).toBeNull();
	});
});

describe("gallery hooks: listings, deletes, uploads", () => {
	async function seed(h: Harness, items: OssImage[]): Promise<void> {
		for (const o of items) {
			await h.service.put(SCOPE, o.key, fingerprint(o), encoded(o.key));
		}
	}

	it("a delete in the gallery removes the thumbnail", async () => {
		const h = harness();
		await seed(h, [obj("a.png"), obj("b.png")]);
		await h.service.onDeleted(SCOPE, "a.png");
		expect(await h.text(obj("a.png"))).toBeNull();
		expect(await h.text(obj("b.png"))).toBe("b.png");
	});

	it("a complete listing prunes thumbnails of unlisted keys inside its prefix only; an incomplete one never", async () => {
		const h = harness();
		await seed(h, [obj("img/a.png"), obj("img/b.png"), obj("x/c.png")]);
		const startedAt = Date.now() + 1;
		await h.service.onListing(SCOPE, listing([obj("img/a.png")], false, "img/"), startedAt);
		expect((await h.service.stats()).count).toBe(3);
		await h.service.onListing(SCOPE, listing([obj("img/a.png")], true, "img/"), startedAt);
		expect(await h.text(obj("img/b.png"))).toBeNull();
		expect(await h.text(obj("img/a.png"))).toBe("img/a.png");
		expect(await h.text(obj("x/c.png"))).toBe("x/c.png");
	});

	it("listings work with thumbnails turned off (cleanup only)", async () => {
		const h = harness();
		await seed(h, [obj("a.png")]);
		h.settings.enabled = false;
		await h.service.onListing(SCOPE, listing([]), Date.now() + 1);
		h.settings.enabled = true;
		expect((await h.service.stats()).count).toBe(0);
	});

	it("an upload thumbnail (from semantic indexing) adopts the listed fingerprint", async () => {
		const h = harness();
		await h.service.put(SCOPE, "up.png", uploadFingerprint(1234), encoded("U"));
		const listed = obj("up.png", { etag: "\"real\"", size: 1234 });
		await h.service.onListing(SCOPE, listing([listed]), Date.now() + 1);
		await h.service.flush();
		const names = fs.readdirSync(path.join(vaultDir, SCOPE));
		expect(names).toContain(thumbnailFileName("up.png", fingerprint(listed), "webp"));
		expect(names).not.toContain(thumbnailFileName("up.png", uploadFingerprint(1234), "webp"));
		expect(await h.text(listed)).toBe("U");
	});
});

describe("size cap", () => {
	it("writes schedule a debounced eviction that trims to the cap", async () => {
		const h = harness();
		h.settings.maxBytes = 25;
		for (const key of ["a.png", "b.png", "c.png"]) {
			await h.service.put(SCOPE, key, fingerprint(obj(key)), encoded("0123456789"));
		}
		expect(h.timers.delays()).toEqual([EVICT_AFTER_WRITE_MS]);
		expect((await h.service.stats()).count).toBe(3);
		h.timers.fireAll();
		// Joins the eviction the timer started (calls share a running one).
		expect((await h.cache.enforceCap(h.settings.maxBytes)).evicted).toBe(1);
		await h.service.flush();
		expect((await h.service.stats()).bytes).toBeLessThanOrEqual(25);
	});

	it("close() cancels a pending eviction", async () => {
		const h = harness();
		await h.service.put(SCOPE, "a.png", fingerprint(obj("a.png")), encoded("x"));
		expect(h.timers.size).toBe(1);
		h.service.close();
		expect(h.timers.size).toBe(0);
	});
});

describe("module boundaries", () => {
	/** Every module reachable through relative imports from `file`. */
	function reachable(file: string, seen = new Set<string>()): Set<string> {
		if (seen.has(file)) {
			return seen;
		}
		seen.add(file);
		const source = fs.readFileSync(file, "utf8");
		for (const m of source.matchAll(/(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']/g)) {
			const base = path.resolve(path.dirname(file), m[1]);
			const target = [`${base}.ts`, path.join(base, "index.ts")].find((p) => fs.existsSync(p));
			if (target) {
				reachable(target, seen);
			}
		}
		return seen;
	}

	it("src/thumbnails never imports src/semantic (directly or through other modules)", () => {
		const dir = path.resolve(__dirname, "../../src/thumbnails");
		const semantic = `${path.resolve(__dirname, "../../src/semantic")}${path.sep}`;
		for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
			const leaks = [...reachable(path.join(dir, name))].filter((f) => f.startsWith(semantic));
			expect(leaks, name).toEqual([]);
		}
	});

	it("the worker-side encoder imports nothing but types", () => {
		const source = fs.readFileSync(path.resolve(__dirname, "../../src/thumbnails/encode.ts"), "utf8");
		expect(source).not.toMatch(/^import /m);
	});
});
