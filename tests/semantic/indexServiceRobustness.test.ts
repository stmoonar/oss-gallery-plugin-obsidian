/**
 * SemanticIndexService robustness: traffic authorization bound to one run,
 * backend failures, hung downloads, size cap, unknown sizes, compaction
 * failure (review fixes; docs/semantic-search.md §4.5, §9.4, §12).
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	currentEmbeddingConfig,
	EmbeddingBackend,
	FakeEmbeddingBackend,
	fakeImageBytes,
} from "../../src/semantic/EmbeddingBackend";
import { IndexScope, makeIndexScope } from "../../src/semantic/fingerprint";
import { STATUS_FILE } from "../../src/semantic/IndexStatusStore";
import { EmbeddingError } from "../../src/semantic/protocol";
import { RemoteFetchError } from "../../src/services/remoteBytes";
import {
	AUTO_CONFIRM_LIMIT_BYTES,
	FATAL_BACKOFF_MS,
	IndexServiceDeps,
	MAX_ATTEMPTS,
	RunSummary,
	SemanticIndexService,
	TrafficEstimate,
	TrafficPromptReason,
	trafficPromptReason,
} from "../../src/semantic/SemanticIndexService";
import { StoreAsyncFs, StoreFs } from "../../src/semantic/VectorStore";
import type { ListResult, OssImage } from "../../src/types/oss";
import { deferred, FakeTimers, flushMicrotasks, makeTempDir, removeDir } from "./helpers";

const CFG = currentEmbeddingConfig(70);
const DAY = 24 * 60 * 60 * 1000;
const LOCAL: IndexScope = makeIndexScope("local", { storagePath: "attachments", useRelativePath: true }, "");
const REMOTE: IndexScope = makeIndexScope("s3", { bucket: "b", endpoint: "s3.example", region: "r", forcePathStyle: false }, "");

let root: string;
beforeEach(() => {
	root = makeTempDir("idx-robust-");
});
afterEach(() => {
	removeDir(root);
});

function obj(key: string, opts: Partial<OssImage> = {}): OssImage {
	return { key, url: `https://cdn.example/${key}`, size: 1000, lastModified: new Date(1_700_000_000_000), ...opts };
}

function listing(items: OssImage[], complete = true): ListResult {
	return { items, complete, prefix: "" };
}

interface Asked {
	estimate: TrafficEstimate;
	reason: TrafficPromptReason;
}

function harness(deps: Partial<IndexServiceDeps> = {}) {
	const reads: string[] = [];
	const asked: Asked[] = [];
	const summaries: RunSummary[] = [];
	const clock = { now: 1_000_000 };
	const settings = { autoIndex: false, confirm: true as boolean | (() => Promise<boolean>) };
	let backends = 0;
	const service = new SemanticIndexService({
		indexRoot: () => root,
		vaultId: "vault1",
		embeddingConfig: () => CFG,
		isEnabled: () => true,
		isReady: () => true,
		autoIndex: () => settings.autoIndex,
		createBackend: () => {
			backends++;
			return new FakeEmbeddingBackend();
		},
		readBytes: (_scope, o) => {
			reads.push(o.key);
			return Promise.resolve(fakeImageBytes(o.key));
		},
		rasterizeSvg: () => Promise.resolve(fakeImageBytes("svg")),
		prepare: (b) => Promise.resolve({ kind: "embed", bytes: b, mime: "image/png", format: "png" }),
		confirmTraffic: (_scope, estimate, reason) => {
			asked.push({ estimate, reason });
			return typeof settings.confirm === "function" ? settings.confirm() : Promise.resolve(settings.confirm);
		},
		onRunFinished: (s) => summaries.push(s),
		now: () => clock.now,
		storeOptions: { flushDelayMs: 0 },
		statusFlushDelayMs: 0,
		...deps,
	});
	return { service, reads, asked, summaries, clock, settings, backendCount: () => backends };
}

async function idle(s: SemanticIndexService): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await flushMicrotasks();
		if (!s.isRunning()) {
			return;
		}
		await s.whenIdle();
	}
}

function visible(s: SemanticIndexService, scope: IndexScope): string[] {
	return [...(s.getSearchStore(scope)?.visibleKeys() ?? [])].sort();
}

describe("traffic authorization is bound to one run (§9.4)", () => {
	it("a start with nothing to do leaves no authorization behind for a later upload run", async () => {
		const h = harness();
		const s = h.service;
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png")]));
		await s.start(REMOTE);
		await idle(s);
		// Nothing pending: the start does not ask and starts no run.
		expect(await s.start(REMOTE)).toBe(true);
		await idle(s);
		// A new remote image appears; the user has not confirmed it.
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png"), obj("b.png")]));
		s.onUploaded(REMOTE, obj("up.png", { size: 5 }), fakeImageBytes("up.png"));
		await idle(s);
		expect(visible(s, REMOTE)).toEqual(["a.png", "up.png"]);
		expect(h.reads).toEqual(["a.png"]);
		expect(s.estimate(REMOTE).pendingCount).toBe(1);
	});

	it("objects a listing adds during a confirmed run are not downloaded by that run", async () => {
		const first = [obj("a.png"), obj("b.png")];
		let relisted = false;
		const h2 = harness({
			readBytes: (_scope, o) => {
				h2.reads.push(o.key);
				if (!relisted) {
					relisted = true;
					h2.service.reconcile(h2.service.beginListing(REMOTE), REMOTE, listing([...first, obj("c.png")]));
				}
				return Promise.resolve(fakeImageBytes(o.key));
			},
		});
		const t = h2.service;
		t.reconcile(t.beginListing(REMOTE), REMOTE, listing(first));
		await t.start(REMOTE);
		await idle(t);
		expect(h2.asked).toHaveLength(1);
		expect(h2.asked[0].estimate.pendingCount).toBe(2);
		expect(h2.reads.sort()).toEqual(["a.png", "b.png"]);
		expect(t.estimate(REMOTE).pendingCount).toBe(1);
		// The next start asks for exactly the new object.
		await t.start(REMOTE);
		await idle(t);
		expect(h2.asked[1].estimate.pendingCount).toBe(1);
		expect(h2.reads).toContain("c.png");
	});

	it("autoIndex applies the auto-large rule to objects found during a run", async () => {
		let relisted = false;
		const big = obj("big.png", { size: AUTO_CONFIRM_LIMIT_BYTES + 1 });
		const h = harness({
			readBytes: (_scope, o) => {
				h.reads.push(o.key);
				if (!relisted) {
					relisted = true;
					h.settings.confirm = false;
					h.service.reconcile(h.service.beginListing(REMOTE), REMOTE, listing([obj("a.png"), big]));
				}
				return Promise.resolve(fakeImageBytes(o.key));
			},
		});
		const s = h.service;
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png")]));
		await s.start(REMOTE);
		h.settings.autoIndex = true;
		await idle(s);
		expect(h.asked.map((a) => a.reason)).toEqual(["manual", "auto-large"]);
		expect(h.reads).toEqual(["a.png"]);
	});

	it("a start confirmed while a run is finishing up is not dropped", async () => {
		const dialog = deferred<boolean>();
		// The first async flush happens in the run's finally (flushDelayMs 0):
		// the user confirms exactly then.
		const asyncFs: StoreAsyncFs = {
			mkdir: (p, o) => {
				dialog.resolve(true);
				return fs.promises.mkdir(p, o);
			},
			open: (p, f) => fs.promises.open(p, f),
			unlink: (p) => fs.promises.unlink(p),
		};
		const h = harness({ storeOptions: { flushDelayMs: 0, asyncFs } });
		const s = h.service;
		// LOCAL first: the old code cleared the scopes one by one between awaits.
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("l.png")]));
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("r.png")]));
		h.settings.confirm = () => dialog.promise;
		await s.start(LOCAL);
		const started = s.start(REMOTE);
		expect(await started).toBe(true);
		await idle(s);
		expect(h.reads.sort()).toEqual(["l.png", "r.png"]);
		expect(visible(s, REMOTE)).toEqual(["r.png"]);
	});

	it("a scope change while the dialog is open does not start the old scope", async () => {
		const h = harness();
		const s = h.service;
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png")]));
		const dialog = deferred<boolean>();
		h.settings.confirm = () => dialog.promise;
		const started = s.start(REMOTE);
		await flushMicrotasks();
		s.onScopeChanged(LOCAL.id);
		dialog.resolve(true);
		expect(await started).toBe(false);
		await idle(s);
		expect(h.reads).toEqual([]);
		// closeAll / cancel during the dialog: same.
		const again = deferred<boolean>();
		h.settings.confirm = () => again.promise;
		const second = s.start(REMOTE);
		await flushMicrotasks();
		s.closeAll();
		again.resolve(true);
		expect(await second).toBe(false);
		await idle(s);
		expect(h.reads).toEqual([]);
	});
});

describe("unknown sizes (§9.4)", () => {
	it("count as ASSUMED_UNKNOWN_SIZE_BYTES each for the auto-large rule", () => {
		const base = { local: false, auto: true, confirmedBefore: true, pendingBytes: 0 };
		expect(trafficPromptReason({ ...base, pendingCount: 100, unknownSizeCount: 100 })).toBeNull();
		expect(trafficPromptReason({ ...base, pendingCount: 101, unknownSizeCount: 101 })).toBe("auto-large");
	});

	it("autoIndex asks again for many objects without a listed size", async () => {
		const h = harness();
		const s = h.service;
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png")]));
		await s.start(REMOTE);
		await idle(s);
		h.settings.autoIndex = true;
		h.settings.confirm = false;
		const many = Array.from({ length: 150 }, (_, i) => obj(`u${i}.png`, { size: 0 }));
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing([obj("a.png"), ...many]));
		await idle(s);
		expect(h.asked.at(-1)).toMatchObject({ reason: "auto-large", estimate: { pendingBytes: 0, unknownSizeCount: 150 } });
		expect(h.reads).toEqual(["a.png"]);
	});
});

describe("backend failures", () => {
	it("a model-load failure downloads nothing and blocks autoIndex for a while", async () => {
		let inits = 0;
		const failing: EmbeddingBackend = {
			init: () => {
				inits++;
				return Promise.reject(new EmbeddingError("model-load", "no GPU"));
			},
			embedText: () => Promise.reject(new Error("unused")),
			embedImages: () => Promise.reject(new Error("unused")),
			dispose: () => Promise.resolve(),
		};
		const h = harness({ createBackend: () => failing });
		const s = h.service;
		const items = [obj("a.png"), obj("b.png")];
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing(items));
		await s.start(REMOTE);
		await idle(s);
		expect(h.reads).toEqual([]);
		expect(h.summaries.at(-1)?.error).toBe("no GPU");
		expect(s.estimate(REMOTE).pendingCount).toBe(2);
		// autoIndex: the 2-minute re-listings do not retry right away.
		h.settings.autoIndex = true;
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing(items));
		await idle(s);
		expect(inits).toBe(1);
		h.clock.now += FATAL_BACKOFF_MS;
		s.reconcile(s.beginListing(REMOTE), REMOTE, listing(items));
		await idle(s);
		expect(inits).toBe(2);
		expect(h.reads).toEqual([]);
	});

	it("a batch whose embedding crashes counts an attempt for each image; retries isolate the poison image", async () => {
		const embedded: string[][] = [];
		class PoisonBackend extends FakeEmbeddingBackend {
			override embedImages(images: Parameters<EmbeddingBackend["embedImages"]>[0]) {
				embedded.push(images.map((i) => i.id));
				if (images.some((i) => i.id === "poison.png")) {
					return Promise.reject(new EmbeddingError("worker-crashed", "The worker did not answer within 120 s (embedImages); it was stopped"));
				}
				return super.embedImages(images);
			}
		}
		const h = harness({ createBackend: () => new PoisonBackend() });
		const s = h.service;
		const items = [obj("a.png"), obj("poison.png"), obj("c.png")];
		for (let round = 0; round < MAX_ATTEMPTS + 1; round++) {
			s.reconcile(s.beginListing(LOCAL), LOCAL, listing(items));
			await s.start(LOCAL);
			await idle(s);
			h.clock.now += DAY;
		}
		expect(visible(s, LOCAL)).toEqual(["a.png", "c.png"]);
		const stats = s.getStats(LOCAL);
		expect(stats.items).toEqual([
			expect.objectContaining({ key: "poison.png", status: "failed", attempts: MAX_ATTEMPTS }),
		]);
		// First batch together, then the poison image alone (never with others again).
		expect(embedded[0].sort()).toEqual(["a.png", "c.png", "poison.png"]);
		expect(embedded.filter((b) => b.includes("poison.png")).slice(1).every((b) => b.length === 1)).toBe(true);
		expect(embedded.filter((b) => b.includes("poison.png"))).toHaveLength(MAX_ATTEMPTS);
	});

	it("keys in flight when the app died count as an attempt on the next start", async () => {
		const hang: EmbeddingBackend = new (class extends FakeEmbeddingBackend {
			override embedImages(): ReturnType<EmbeddingBackend["embedImages"]> {
				return new Promise(() => undefined);
			}
		})();
		const h = harness({ createBackend: () => hang });
		h.service.reconcile(h.service.beginListing(LOCAL), LOCAL, listing([obj("a.png"), obj("b.png")]));
		await h.service.start(LOCAL);
		await flushMicrotasks(100);
		expect(h.service.getProgress().state).toBe("running");
		const status = JSON.parse(fs.readFileSync(path.join(root, "vault1", LOCAL.id, STATUS_FILE), "utf8")) as { inflight?: object };
		expect(Object.keys(status.inflight ?? {}).sort()).toEqual(["a.png", "b.png"]);
		// "Crash": the service is never disposed. A new session opens the index.
		const h2 = harness();
		h2.service.reconcile(h2.service.beginListing(LOCAL), LOCAL, listing([obj("a.png"), obj("b.png")]));
		await h2.service.start(LOCAL);
		await idle(h2.service);
		expect(h2.reads).toEqual([]);
		expect(h2.service.getStats(LOCAL).items).toEqual([
			expect.objectContaining({ key: "a.png", status: "failed", attempts: 1 }),
			expect.objectContaining({ key: "b.png", status: "failed", attempts: 1 }),
		]);
		// In backoff: not pending right now.
		expect(h2.service.estimate(LOCAL).pendingCount).toBe(0);
	});

	it("an orderly close does not count the batch in flight", async () => {
		const gate = deferred<void>();
		const slow = new (class extends FakeEmbeddingBackend {
			override async embedImages(images: Parameters<EmbeddingBackend["embedImages"]>[0]) {
				await gate.promise;
				return super.embedImages(images);
			}
		})();
		const h = harness({ createBackend: () => slow });
		h.service.reconcile(h.service.beginListing(LOCAL), LOCAL, listing([obj("a.png")]));
		await h.service.start(LOCAL);
		await flushMicrotasks(100);
		h.service.dispose();
		gate.resolve();
		const h2 = harness();
		h2.service.reconcile(h2.service.beginListing(LOCAL), LOCAL, listing([obj("a.png")]));
		expect(h2.service.getStats(LOCAL).items).toEqual([]);
		expect(h2.service.estimate(LOCAL).pendingCount).toBe(1);
	});
});

describe("downloads: cancel, timeout, size cap", () => {
	it("cancel interrupts a hung download (also while paused) and the run ends", async () => {
		const h = harness({ readBytes: () => new Promise<ArrayBuffer>(() => undefined) });
		const s = h.service;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("a.png"), obj("b.png")]));
		await s.start(LOCAL);
		await flushMicrotasks(100);
		expect(s.getProgress().currentKey).toBe("a.png");
		s.pause();
		s.cancel();
		await idle(s);
		expect(s.isRunning()).toBe(false);
		expect(h.summaries.at(-1)?.cancelled).toBe(true);
		expect(s.estimate(LOCAL).pendingCount).toBe(2);
	});

	it("a download that never finishes times out and is recorded as failed", async () => {
		const timers = new FakeTimers();
		const h = harness({
			timers,
			readBytes: (_scope, o) => o.key === "hung.png"
				? new Promise<ArrayBuffer>(() => undefined)
				: Promise.resolve(fakeImageBytes(o.key)),
		});
		const s = h.service;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing([obj("hung.png"), obj("ok.png")]));
		await s.start(LOCAL);
		await flushMicrotasks(100);
		expect(s.getProgress().currentKey).toBe("hung.png");
		timers.fireAll();
		await idle(s);
		expect(visible(s, LOCAL)).toEqual(["ok.png"]);
		const items = s.getStats(LOCAL).items;
		expect(items).toEqual([expect.objectContaining({ key: "hung.png", status: "failed" })]);
		expect(items[0].reason).toMatch(/Download timed out/);
	});

	it("objects above the size cap are unsupported and never read; too-large responses too", async () => {
		const h = harness({
			readBytes: (_scope, o) => {
				h.reads.push(o.key);
				return o.key === "huge-unknown.png"
					? Promise.reject(new RemoteFetchError("too-large", undefined, "Too large to index (60 MB, limit 50 MB)"))
					: Promise.resolve(fakeImageBytes(o.key));
			},
		});
		const s = h.service;
		const items = [obj("huge.png", { size: 60 * 1024 * 1024 }), obj("huge-unknown.png", { size: 0 }), obj("ok.png")];
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing(items));
		await s.start(LOCAL);
		await idle(s);
		expect(h.reads.sort()).toEqual(["huge-unknown.png", "ok.png"]);
		const byKey = Object.fromEntries(s.getStats(LOCAL).items.map((i) => [i.key, i]));
		expect(byKey["huge.png"]).toMatchObject({ status: "unsupported" });
		expect(byKey["huge.png"].reason).toBe("Too large to index (60 MB, limit 50 MB)");
		expect(byKey["huge-unknown.png"]).toMatchObject({ status: "unsupported" });
		// Not retried.
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing(items));
		expect(s.estimate(LOCAL).pendingCount).toBe(0);
	});
});

describe("compaction failure", () => {
	it("a compaction that fails half-way does not break reconcile, deletes or the next run", async () => {
		const state = { failNextMetaRename: false, armed: false };
		const storeFs: StoreFs = {
			existsSync: (p) => fs.existsSync(p),
			mkdirSync: (p, o) => fs.mkdirSync(p, o),
			readFileSync: (p) => fs.readFileSync(p),
			statSync: (p) => fs.statSync(p),
			openSync: (p, f) => fs.openSync(p, f),
			writeSync: (fd, b, o, l, pos) => fs.writeSync(fd, b, o, l, pos),
			fsyncSync: (fd) => fs.fsyncSync(fd),
			ftruncateSync: (fd, len) => fs.ftruncateSync(fd, len),
			closeSync: (fd) => fs.closeSync(fd),
			renameSync: (a, b) => {
				if (state.armed && path.basename(a) === "meta.json.tmp") {
					state.armed = false;
					throw new Error("EPERM: operation not permitted, rename");
				}
				if (state.failNextMetaRename && path.basename(a) === "vectors.bin.tmp") {
					// Compaction: vectors replaced, the meta rename fails.
					state.failNextMetaRename = false;
					state.armed = true;
				}
				fs.renameSync(a, b);
			},
			unlinkSync: (p) => fs.unlinkSync(p),
		};
		const h = harness({ storeOptions: { flushDelayMs: 0, fs: storeFs } });
		const s = h.service;
		const v1 = Array.from({ length: 10 }, (_, i) => obj(`k${i}.png`, { etag: "\"1\"" }));
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing(v1));
		await s.start(LOCAL);
		await idle(s);
		// Re-embed 6 of 10: holes 6/16 > 30 % -> compaction at the end of the run.
		const v2 = v1.map((o, i) => (i < 6 ? { ...o, etag: "\"2\"" } : o));
		state.failNextMetaRename = true;
		s.reconcile(s.beginListing(LOCAL), LOCAL, listing(v2));
		await s.start(LOCAL);
		await idle(s);
		expect(state.armed).toBe(false);
		// Everything keeps working: the store is reopened (and rolled forward).
		expect(s.reconcile(s.beginListing(LOCAL), LOCAL, listing(v2.slice(1)))).toBe(true);
		s.onDeleted(LOCAL, "k2.png");
		expect(visible(s, LOCAL)).toEqual(v2.slice(1).map((o) => o.key).filter((k) => k !== "k2.png").sort());
		expect(s.isIndexed(LOCAL, "k5.png")).toBe(true);
		expect(s.getSearchStore(LOCAL)?.peek("k5.png")?.fp).toBe("e:\"2\"");
	});
});
