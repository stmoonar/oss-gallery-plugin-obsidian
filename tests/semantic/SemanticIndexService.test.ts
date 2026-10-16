import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	currentEmbeddingConfig,
	FAKE_IMAGE_CAPTION_PREFIX,
	FakeEmbeddingBackend,
	fakeImageBytes,
} from "../../src/semantic/EmbeddingBackend";
import { fingerprint, IndexScope, makeIndexScope, uploadFingerprint } from "../../src/semantic/fingerprint";
import { prepareImage, PreparedImage } from "../../src/semantic/imageFormat";
import {
	AUTO_CONFIRM_LIMIT_BYTES,
	IndexServiceDeps,
	MAX_ATTEMPTS,
	PURGE_AFTER_MS,
	RunSummary,
	SemanticIndexService,
	TrafficEstimate,
} from "../../src/semantic/SemanticIndexService";
import { SemanticSearchService } from "../../src/semantic/SemanticSearchService";
import type { ListResult, OssImage } from "../../src/types/oss";
import { flushMicrotasks, makeTempDir, removeDir, toArrayBuffer } from "./helpers";

const CFG = currentEmbeddingConfig(70);
const DAY = 24 * 60 * 60 * 1000;

let root: string;
beforeEach(() => {
	root = makeTempDir("idx-svc-");
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

function isFake(bytes: ArrayBuffer): boolean {
	return new TextDecoder().decode(new Uint8Array(bytes).subarray(0, 11)) === FAKE_IMAGE_CAPTION_PREFIX;
}

interface Harness {
	service: SemanticIndexService;
	backends: FakeEmbeddingBackend[];
	reads: string[];
	confirms: TrafficEstimate[];
	summaries: RunSummary[];
	clock: { now: number };
	bytes: Map<string, ArrayBuffer>;
	settings: { autoIndex: boolean; confirm: boolean; enabled: boolean };
	search: SemanticSearchService;
	embeddedCount(): number;
}

function harness(options: { failIds?: string[]; deps?: Partial<IndexServiceDeps> } = {}): Harness {
	const backends: FakeEmbeddingBackend[] = [];
	const reads: string[] = [];
	const confirms: TrafficEstimate[] = [];
	const summaries: RunSummary[] = [];
	const clock = { now: 1_000_000 };
	const bytes = new Map<string, ArrayBuffer>();
	const settings = { autoIndex: false, confirm: true, enabled: true };
	const service = new SemanticIndexService({
		indexRoot: () => root,
		vaultId: "vault1",
		embeddingConfig: () => CFG,
		isEnabled: () => settings.enabled,
		isReady: () => settings.enabled,
		autoIndex: () => settings.autoIndex,
		createBackend: () => {
			const b = new FakeEmbeddingBackend({ failImageIds: options.failIds });
			backends.push(b);
			return b;
		},
		readBytes: (_scope, o) => {
			reads.push(o.key);
			const b = bytes.get(o.key);
			return b ? Promise.resolve(b.slice(0)) : Promise.reject(new Error("404"));
		},
		rasterizeSvg: () => Promise.resolve(fakeImageBytes("vector drawing")),
		prepare: (b, key): Promise<PreparedImage> => isFake(b)
			? Promise.resolve({ kind: "embed", bytes: b, mime: "image/png", format: "png" })
			: prepareImage(b, key, { rasterizeSvg: () => Promise.resolve(fakeImageBytes("vector drawing")) }),
		confirmTraffic: (_scope, estimate) => {
			confirms.push(estimate);
			return Promise.resolve(settings.confirm);
		},
		onRunFinished: (s) => summaries.push(s),
		now: () => clock.now,
		storeOptions: { flushDelayMs: 0 },
		statusFlushDelayMs: 0,
		...options.deps,
	});
	const search = new SemanticSearchService({
		getStore: (scope) => service.getSearchStore(scope),
		createQueryBackend: () => new FakeEmbeddingBackend(),
		embeddingConfig: () => CFG,
	});
	return {
		service, backends, reads, confirms, summaries, clock, bytes, settings, search,
		embeddedCount: () => backends.reduce((n, b) => n + b.calls.filter((c) => c.type === "embedImages").reduce((m, c) => m + c.count, 0), 0),
	};
}

const LOCAL: IndexScope = makeIndexScope("local", { storagePath: "attachments", useRelativePath: true }, "");
const REMOTE: IndexScope = makeIndexScope("s3", { bucket: "b", endpoint: "s3.example", region: "r", forcePathStyle: false }, "");

/** Listing + start + wait: index `items` of `scope` (captions = key). */
async function indexAll(h: Harness, scope: IndexScope, items: OssImage[]): Promise<void> {
	for (const o of items) {
		if (!h.bytes.has(o.key)) {
			h.bytes.set(o.key, fakeImageBytes(o.key));
		}
	}
	h.service.reconcile(h.service.beginListing(scope), scope, listing(items));
	await h.service.start(scope);
	await h.service.whenIdle();
}

function visible(h: Harness, scope: IndexScope): string[] {
	return [...(h.service.getSearchStore(scope)?.visibleKeys() ?? [])].sort();
}

describe("SemanticIndexService reconcile (§7)", () => {
	it("indexes a local scope without confirmation and reads every object once", async () => {
		const h = harness();
		await indexAll(h, LOCAL, [obj("a.png"), obj("b.png")]);
		expect(h.confirms).toEqual([]);
		expect(h.reads.sort()).toEqual(["a.png", "b.png"]);
		expect(visible(h, LOCAL)).toEqual(["a.png", "b.png"]);
		expect(h.summaries.at(-1)).toMatchObject({ indexed: 2, fromListing: true, cancelled: false });
	});

	it("an incomplete listing never deletes or advances tombstones", async () => {
		const h = harness();
		await indexAll(h, LOCAL, [obj("a.png"), obj("b.png")]);
		const s = h.service;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("a.png")], false));
		expect(visible(h, LOCAL)).toEqual(["a.png", "b.png"]);
		expect(s.getSearchStore(LOCAL)?.peek("b.png")?.missingSince).toBeUndefined();
	});

	it("hides a key missing from a complete listing immediately and purges after 2 misses", async () => {
		const h = harness();
		await indexAll(h, LOCAL, [obj("a.png"), obj("b.png")]);
		const s = h.service;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("a.png")]));
		const store = s.getSearchStore(LOCAL)!;
		expect(visible(h, LOCAL)).toEqual(["a.png"]);
		expect(store.peek("b.png")).toMatchObject({ missCount: 1, missingSince: h.clock.now });
		// Search never returns it.
		const hits = await h.search.searchByTextScored(LOCAL, "b.png", [obj("a.png"), obj("b.png")]);
		expect(hits.map((x) => x.object.key)).toEqual(["a.png"]);
		// An incomplete listing in between does not count.
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("a.png")], false));
		expect(store.has("b.png")).toBe(true);
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("a.png")]));
		expect(store.has("b.png")).toBe(false);
	});

	it("purges a tombstone that has been missing for 7 days", async () => {
		const h = harness();
		await indexAll(h, LOCAL, [obj("a.png"), obj("b.png")]);
		const s = h.service;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("a.png")]));
		const store = s.getSearchStore(LOCAL)!;
		h.clock.now += PURGE_AFTER_MS - 1;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("a.png")], false));
		expect(store.has("b.png")).toBe(true);
		h.clock.now += 1;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("a.png")]));
		expect(store.has("b.png")).toBe(false);
		expect(h.clock.now - 1_000_000).toBe(7 * DAY);
	});

	it("restores a reappearing key with the same fingerprint without downloading", async () => {
		const h = harness();
		await indexAll(h, REMOTE, [obj("a.png"), obj("b.png")]);
		const s = h.service;
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png")]));
		expect(visible(h, REMOTE)).toEqual(["a.png"]);
		const reads = h.reads.length;
		const embedded = h.embeddedCount();
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png"), obj("b.png")]));
		expect(visible(h, REMOTE)).toEqual(["a.png", "b.png"]);
		expect(s.estimate(REMOTE).pendingCount).toBe(0);
		expect(h.reads.length).toBe(reads);
		expect(h.embeddedCount()).toBe(embedded);
	});

	it("re-embeds an object whose fingerprint changed", async () => {
		const h = harness();
		await indexAll(h, LOCAL, [obj("a.png", { etag: "\"v1\"" })]);
		const store = h.service.getSearchStore(LOCAL)!;
		expect(store.peek("a.png")?.fp).toBe("e:\"v1\"");
		h.bytes.set("a.png", fakeImageBytes("a new picture"));
		await indexAll(h, LOCAL, [obj("a.png", { etag: "\"v2\"" })]);
		expect(store.peek("a.png")?.fp).toBe("e:\"v2\"");
		expect(h.reads.filter((k) => k === "a.png")).toHaveLength(2);
	});

	it("drops a stale listing (older token) after a newer one was applied", async () => {
		const h = harness();
		await indexAll(h, LOCAL, [obj("a.png"), obj("b.png")]);
		const s = h.service;
		const older = s.beginListing(LOCAL);
		const newer = s.beginListing(LOCAL);
		expect(s.reconcile(newer, LOCAL, listing([obj("a.png"), obj("b.png")]))).toBe(true);
		expect(s.reconcile(older, LOCAL, listing([obj("a.png")]))).toBe(false);
		expect(visible(h, LOCAL)).toEqual(["a.png", "b.png"]);
	});

	it("invalidates tokens of other scopes when the scope changes", () => {
		const h = harness();
		const s = h.service;
		const token = s.beginListing(REMOTE);
		s.onScopeChanged(LOCAL.id);
		expect(s.reconcile(token, REMOTE, listing([obj("a.png")]))).toBe(false);
		expect(s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png")]))).toBe(true);
	});

	it("only reconciles deletions under the listed prefix", async () => {
		const h = harness();
		await indexAll(h, LOCAL, [obj("base/a.png"), obj("old/b.png")]);
		const s = h.service;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([], true, "base/"));
		const store = s.getSearchStore(LOCAL)!;
		expect(store.peek("base/a.png")?.missCount).toBe(1);
		expect(store.peek("old/b.png")?.missingSince).toBeUndefined();
	});

	it("ignores listings while the feature is disabled", () => {
		const h = harness();
		h.settings.enabled = false;
		expect(h.service.reconcile(h.service.beginListing(LOCAL), LOCAL, listing([obj("a.png")]))).toBe(false);
		expect(fs.existsSync(path.join(root, "vault1"))).toBe(false);
	});
});

describe("SemanticIndexService hooks", () => {
	it("embeds an upload from its bytes without downloading, then adopts the listed fingerprint", async () => {
		const h = harness();
		await indexAll(h, REMOTE, [obj("a.png")]);
		const confirms = h.confirms.length;
		h.service.onUploaded(REMOTE, obj("new.png", { size: 42 }), fakeImageBytes("new.png"));
		await h.service.whenIdle();
		const store = h.service.getSearchStore(REMOTE)!;
		expect(store.peek("new.png")?.fp).toBe(uploadFingerprint(42));
		expect(h.reads).not.toContain("new.png");
		expect(h.confirms.length).toBe(confirms);
		const embedded = h.embeddedCount();
		const listed = obj("new.png", { size: 42, etag: "\"x\"" });
		h.service.reconcile(h.service.beginListing(REMOTE), REMOTE, listing([obj("a.png"), listed]));
		expect(store.peek("new.png")?.fp).toBe(fingerprint(listed));
		expect(h.service.estimate(REMOTE).pendingCount).toBe(0);
		expect(h.embeddedCount()).toBe(embedded);
	});

	it("removes a deleted object's vector immediately", async () => {
		const h = harness();
		await indexAll(h, LOCAL, [obj("a.png"), obj("b.png")]);
		h.service.onDeleted(LOCAL, "b.png");
		const store = h.service.getSearchStore(LOCAL)!;
		expect(store.has("b.png")).toBe(false);
		expect(visible(h, LOCAL)).toEqual(["a.png"]);
	});
});

describe("SemanticIndexService traffic safety (§9.4)", () => {
	it("never downloads a remote scope until the user confirms", async () => {
		const h = harness();
		h.settings.confirm = false;
		const items = [obj("a.png", { size: 1500 }), obj("b.png", { size: 2500 })];
		items.forEach((o) => h.bytes.set(o.key, fakeImageBytes(o.key)));
		const s = h.service;
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing(items));
		expect(await s.start(REMOTE)).toBe(false);
		await s.whenIdle();
		expect(h.reads).toEqual([]);
		expect(h.embeddedCount()).toBe(0);
		expect(h.confirms).toEqual([{ pendingCount: 2, pendingBytes: 4000, indexedCount: 0 }]);
		h.settings.confirm = true;
		expect(await s.start(REMOTE)).toBe(true);
		await s.whenIdle();
		expect(h.reads.sort()).toEqual(["a.png", "b.png"]);
	});

	it("autoIndex starts local scopes by itself but asks once for a new remote scope", async () => {
		const h = harness();
		h.settings.autoIndex = true;
		h.settings.confirm = false;
		h.bytes.set("a.png", fakeImageBytes("a"));
		const s = h.service;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("a.png")]));
		await flushMicrotasks();
		await s.whenIdle();
		expect(visible(h, LOCAL)).toEqual(["a.png"]);
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png")]));
		await flushMicrotasks();
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png")]));
		await flushMicrotasks();
		expect(h.confirms).toHaveLength(1);
		expect(h.reads).toEqual(["a.png"]);
	});

	it("autoIndex re-confirms only above the 200 MB estimate once confirmed", async () => {
		const h = harness();
		await indexAll(h, REMOTE, [obj("a.png")]);
		expect(h.confirms).toHaveLength(1);
		h.settings.autoIndex = true;
		h.bytes.set("b.png", fakeImageBytes("b"));
		h.service.reconcile(h.service.beginListing(REMOTE), REMOTE, listing([obj("a.png"), obj("b.png")]));
		await flushMicrotasks();
		await h.service.whenIdle();
		expect(h.confirms).toHaveLength(1);
		expect(visible(h, REMOTE)).toEqual(["a.png", "b.png"]);
		h.settings.confirm = false;
		const big = obj("c.png", { size: AUTO_CONFIRM_LIMIT_BYTES + 1 });
		h.service.reconcile(h.service.beginListing(REMOTE), REMOTE, listing([obj("a.png"), obj("b.png"), big]));
		await flushMicrotasks();
		expect(h.confirms).toHaveLength(2);
		expect(h.reads).not.toContain("c.png");
	});

	it("estimates bytes of objects not yet indexed (Local = 0)", async () => {
		const h = harness();
		await indexAll(h, REMOTE, [obj("a.png", { size: 100 })]);
		await indexAll(h, LOCAL, [obj("a.png", { size: 100 })]);
		const s = h.service;
		const remoteItems = [obj("a.png", { size: 100 }), obj("b.png", { size: 2000 }), obj("c.png", { size: 3000 })];
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing(remoteItems));
		expect(s.estimate(REMOTE)).toEqual({ pendingCount: 2, pendingBytes: 5000, indexedCount: 1 });
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing(remoteItems));
		expect(s.estimate(LOCAL)).toEqual({ pendingCount: 2, pendingBytes: 0, indexedCount: 1 });
	});
});

describe("SemanticIndexService image formats", () => {
	const SVG = toArrayBuffer(new TextEncoder().encode("<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>"));
	// 1×1 8-bit gray, uncompressed (prepareImage checks the TIFF structure).
	const TIFF = toArrayBuffer(new Uint8Array([
		0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 6, 0,
		0x00, 0x01, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0,
		0x01, 0x01, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0,
		0x02, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0,
		0x06, 0x01, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0,
		0x11, 0x01, 4, 0, 1, 0, 0, 0, 86, 0, 0, 0,
		0x17, 0x01, 4, 0, 1, 0, 0, 0, 1, 0, 0, 0,
		0, 0, 0, 0, 0x80,
	]));
	const HEIC = toArrayBuffer(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]));
	const BAD_JPG = toArrayBuffer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]));

	it("converts SVG and TIFF, marks HEIC unsupported and corrupt JPEG failed", async () => {
		const h = harness({ failIds: ["bad.jpg"] });
		h.bytes.set("draw.svg", SVG);
		h.bytes.set("scan.tiff", TIFF);
		h.bytes.set("phone.png", HEIC);
		h.bytes.set("bad.jpg", BAD_JPG);
		await indexAll(h, LOCAL, [obj("draw.svg"), obj("scan.tiff"), obj("phone.png"), obj("bad.jpg"), obj("ok.png")]);
		const stats = h.service.getStats(LOCAL);
		expect(stats).toMatchObject({ indexed: 3, ok: 1, converted: 2, unsupported: 1, failed: 1 });
		const byKey = Object.fromEntries(stats.items.map((i) => [i.key, i]));
		expect(byKey["draw.svg"]).toMatchObject({ status: "converted", format: "svg" });
		expect(byKey["scan.tiff"]).toMatchObject({ status: "converted", format: "tiff" });
		expect(byKey["phone.png"]).toMatchObject({ status: "unsupported", format: "heic" });
		expect(byKey["bad.jpg"]).toMatchObject({ status: "failed", attempts: 1 });
		// SVG was embedded from its rasterized PNG.
		const hits = await h.search.searchByTextScored(LOCAL, "vector drawing", [obj("draw.svg"), obj("ok.png")]);
		expect(hits[0]).toMatchObject({ object: { key: "draw.svg" } });
		expect(hits[0].score).toBeCloseTo(1, 5);
		expect(h.summaries.at(-1)).toMatchObject({
			indexed: 3, converted: 2, unsupported: 1, failed: 1,
			convertedFormats: ["svg", "tiff"], unsupportedFormats: ["heic"],
		});
	});

	it("never retries unsupported files and retries failed ones with backoff up to the cap", async () => {
		const h = harness({ failIds: ["bad.jpg"] });
		h.bytes.set("bad.jpg", BAD_JPG);
		h.bytes.set("phone.png", HEIC);
		const items = [obj("bad.jpg"), obj("phone.png")];
		await indexAll(h, LOCAL, items);
		const s = h.service;
		// Within the backoff nothing is pending.
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing(items));
		expect(s.estimate(LOCAL).pendingCount).toBe(0);
		for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
			h.clock.now += DAY;
			await indexAll(h, LOCAL, items);
		}
		expect(h.reads.filter((k) => k === "bad.jpg")).toHaveLength(MAX_ATTEMPTS);
		expect(h.reads.filter((k) => k === "phone.png")).toHaveLength(1);
		h.clock.now += 30 * DAY;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing(items));
		expect(s.estimate(LOCAL).pendingCount).toBe(0);
		expect(s.getStats(LOCAL).items.find((i) => i.key === "bad.jpg")).toMatchObject({ attempts: MAX_ATTEMPTS });
		// A changed file is tried again.
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("bad.jpg", { size: 7 }), obj("phone.png")]));
		expect(s.estimate(LOCAL).pendingCount).toBe(1);
	});

	it("records download failures as failed", async () => {
		const h = harness();
		h.service.reconcile(h.service.beginListing(LOCAL), LOCAL, listing([obj("gone.png")]));
		await h.service.start(LOCAL);
		await h.service.whenIdle();
		expect(h.service.getStats(LOCAL).items).toEqual([
			expect.objectContaining({ key: "gone.png", status: "failed", reason: "Download: 404" }),
		]);
	});
});

describe("SemanticIndexService run control", () => {
	it("cancel stops the run and keeps the rest pending; persistence survives a new service", async () => {
		const h = harness();
		const items = Array.from({ length: 20 }, (_, i) => obj(`img${i}.png`));
		items.forEach((o) => h.bytes.set(o.key, fakeImageBytes(o.key)));
		const s = h.service;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing(items));
		const progress: number[] = [];
		s.onProgress((p) => {
			progress.push(p.done);
			if (p.done >= 8) {
				s.cancel();
			}
		});
		await s.start(LOCAL);
		await s.whenIdle();
		const indexed = s.getSearchStore(LOCAL)!.size;
		expect(indexed).toBeGreaterThan(0);
		expect(indexed).toBeLessThan(20);
		expect(s.estimate(LOCAL).pendingCount).toBe(20 - indexed);
		expect(h.summaries.at(-1)?.cancelled).toBe(true);
		s.dispose();

		const h2 = harness();
		h2.service.reconcile(h2.service.beginListing(LOCAL), LOCAL, listing(items));
		expect(h2.service.estimate(LOCAL).pendingCount).toBe(20 - indexed);
	});

	it("pause holds the run until resume", async () => {
		const h = harness();
		const items = Array.from({ length: 12 }, (_, i) => obj(`p${i}.png`));
		items.forEach((o) => h.bytes.set(o.key, fakeImageBytes(o.key)));
		const s = h.service;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing(items));
		let pausedOnce = false;
		s.onProgress((p) => {
			if (p.state === "running" && p.done >= 8 && !pausedOnce) {
				pausedOnce = true;
				s.pause();
			}
		});
		await s.start(LOCAL);
		for (let i = 0; i < 5; i++) {
			await flushMicrotasks(50);
		}
		expect(s.getProgress().state).toBe("paused");
		expect(s.getSearchStore(LOCAL)!.size).toBe(8);
		s.resume();
		await s.whenIdle();
		expect(s.getSearchStore(LOCAL)!.size).toBe(12);
	});
});

describe("SemanticSearchService", () => {
	it("ranks by text, intersects with the current listing and finds similar images", async () => {
		const h = harness();
		const items = [obj("cat.png"), obj("dog.png"), obj("car.png")];
		h.bytes.set("cat.png", fakeImageBytes("a cat"));
		h.bytes.set("dog.png", fakeImageBytes("a dog"));
		h.bytes.set("car.png", fakeImageBytes("a car"));
		await indexAll(h, LOCAL, items);
		const hits = await h.search.searchByTextScored(LOCAL, "a dog", items, 10);
		expect(hits[0].object.key).toBe("dog.png");
		expect(hits).toHaveLength(3);
		// Not in the current listing -> never returned.
		const subset = await h.search.searchByText(LOCAL, "a dog", [obj("cat.png")]);
		expect(subset.map((o) => o.key)).toEqual(["cat.png"]);
		const similar = h.search.searchSimilar(LOCAL, "cat.png", items);
		expect(similar.map((o) => o.key).sort()).toEqual(["car.png", "dog.png"]);
		expect(h.search.searchSimilar(LOCAL, "unknown.png", items)).toEqual([]);
	});
});
