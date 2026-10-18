import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentEmbeddingConfig, seededVector } from "../../src/semantic/EmbeddingBackend";
import {
	headerFromConfig,
	IndexHeader,
	META_FILE,
	sameHeader,
	scopeIndexDir,
	StoreFs,
	VECTORS_FILE,
	VectorStore,
	VectorStoreOptions,
} from "../../src/semantic/VectorStore";
import { FakeTimers, makeTempDir, removeDir } from "./helpers";

const DIMS = 8;
const SLOT_BYTES = DIMS * 4;
const HEADER: IndexHeader = {
	modelId: "test/model",
	revision: "rev-1",
	dtype: "q4",
	dims: DIMS,
	imageTokenBudget: 70,
	preprocessVersion: 1,
};

/** Deterministic unit vector for test key `n`. */
function vec(n: number): Float32Array {
	return seededVector(1000 + n, DIMS);
}

function key(n: number): string {
	return `img/${n}.png`;
}

let root: string;
let dir: string;
let metaPath: string;
let vecPath: string;

beforeEach(() => {
	root = makeTempDir("vs-test-");
	dir = path.join(root, "scope");
	metaPath = path.join(dir, META_FILE);
	vecPath = path.join(dir, VECTORS_FILE);
});

afterEach(() => {
	removeDir(root);
});

function open(options: VectorStoreOptions = {}, header: IndexHeader = HEADER): VectorStore {
	return VectorStore.open(dir, header, { flushDelayMs: 0, ...options });
}

/** Insert keys 0..n-1 (slot i = key i on a fresh store). */
function fill(store: VectorStore, n: number, start = 0): void {
	for (let i = start; i < start + n; i++) {
		store.upsert(key(i), `fp-${i}`, vec(i));
	}
}

function allHits(store: VectorStore, q: Float32Array = vec(0)): Array<{ key: string; score: number }> {
	return store.search(q, 1000);
}

function fileSize(p: string): number {
	return fs.statSync(p).size;
}

/** Real fs with optional overrides (failure injection). */
function wrapFs(overrides: Partial<StoreFs> = {}): StoreFs {
	return {
		existsSync: (p) => fs.existsSync(p),
		mkdirSync: (p, o) => fs.mkdirSync(p, o),
		readFileSync: (p) => fs.readFileSync(p),
		statSync: (p) => fs.statSync(p),
		openSync: (p, f) => fs.openSync(p, f),
		writeSync: (fd, b, o, l, pos) => fs.writeSync(fd, b, o, l, pos),
		fsyncSync: (fd) => fs.fsyncSync(fd),
		ftruncateSync: (fd, len) => fs.ftruncateSync(fd, len),
		closeSync: (fd) => fs.closeSync(fd),
		renameSync: (a, b) => fs.renameSync(a, b),
		unlinkSync: (p) => fs.unlinkSync(p),
		...overrides,
	};
}

function tmpFiles(): string[] {
	return fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
}

describe("VectorStore basics", () => {
	it("creates an empty store", () => {
		const store = open();
		expect(store.openResult).toEqual({ status: "created", dropped: 0, recoveredTmp: false });
		expect(store.size).toBe(0);
		expect(store.search(vec(0), 5)).toEqual([]);
		expect(fs.existsSync(dir)).toBe(true);
	});

	it("upserts, gets, has and counts entries", () => {
		const store = open();
		fill(store, 3);
		expect(store.size).toBe(3);
		expect(store.has(key(1))).toBe(true);
		expect(store.has("nope")).toBe(false);
		expect(store.keys().sort()).toEqual([key(0), key(1), key(2)].sort());
		const got = store.get(key(1));
		expect(got?.fp).toBe("fp-1");
		expect(Array.from(got?.vec ?? [])).toEqual(Array.from(vec(1)));
		expect(got?.missingSince).toBeUndefined();
		expect(store.get("nope")).toBeUndefined();
	});

	it("get returns a copy", () => {
		const store = open();
		fill(store, 1);
		const got = store.get(key(0));
		got?.vec.fill(0);
		expect(Array.from(store.get(key(0))?.vec ?? [])).toEqual(Array.from(vec(0)));
	});

	it("orders search hits by score and respects k", () => {
		const store = open();
		fill(store, 10);
		const hits = store.search(vec(4), 10);
		expect(hits).toHaveLength(10);
		expect(hits[0].key).toBe(key(4));
		expect(hits[0].score).toBeCloseTo(1, 5);
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
		}
		expect(store.search(vec(4), 3)).toEqual(hits.slice(0, 3));
		expect(store.search(vec(4), 0)).toEqual([]);
		expect(store.search(vec(4), 100)).toEqual(hits);
	});

	it("breaks score ties by key", () => {
		const store = open();
		store.upsert("b", "fp", vec(1));
		store.upsert("a", "fp", vec(1));
		expect(store.search(vec(1), 2).map((h) => h.key)).toEqual(["a", "b"]);
	});

	it("filters by an allow Set or predicate", () => {
		const store = open();
		fill(store, 6);
		const allowSet = new Set([key(1), key(3), "not-indexed"]);
		expect(store.search(vec(0), 10, allowSet).map((h) => h.key).sort()).toEqual([key(1), key(3)]);
		const pred = (k: string): boolean => k.endsWith("5.png") || k.endsWith("2.png");
		expect(store.search(vec(0), 10, pred).map((h) => h.key).sort()).toEqual([key(2), key(5)]);
	});

	it("tombstones with markMissing and restores them", () => {
		const store = open();
		fill(store, 3);
		store.markMissing(key(1), 1000);
		expect(store.get(key(1))).toMatchObject({ missingSince: 1000, missCount: 1 });
		store.markMissing(key(1), 2000);
		expect(store.get(key(1))).toMatchObject({ missingSince: 1000, missCount: 2 });
		expect(store.search(vec(1), 10).map((h) => h.key)).not.toContain(key(1));
		expect(store.search(vec(1), 10, new Set([key(1)]))).toEqual([]);
		expect([...store.visibleKeys()].sort()).toEqual([key(0), key(2)]);
		expect(store.has(key(1))).toBe(true);
		expect(store.size).toBe(3);

		store.restore(key(1));
		const restored = store.get(key(1));
		expect(restored?.missingSince).toBeUndefined();
		expect(restored?.missCount).toBeUndefined();
		expect(store.search(vec(1), 1)[0].key).toBe(key(1));
		expect(store.visibleKeys().has(key(1))).toBe(true);

		// Unknown keys are ignored.
		store.markMissing("nope", 1);
		store.restore("nope");
		expect(store.size).toBe(3);
	});

	it("upsert clears a tombstone", () => {
		const store = open();
		fill(store, 1);
		store.markMissing(key(0), 5);
		store.upsert(key(0), "fp-new", vec(9));
		expect(store.get(key(0))?.missingSince).toBeUndefined();
		expect(store.visibleKeys().has(key(0))).toBe(true);
	});

	it("removes entries", () => {
		const store = open();
		fill(store, 3);
		store.remove(key(0));
		store.remove("nope");
		expect(store.size).toBe(2);
		expect(store.has(key(0))).toBe(false);
		expect(store.search(vec(0), 10).map((h) => h.key)).not.toContain(key(0));
		expect(store.stats().holes).toBe(1);
	});

	it("re-embedding the same key leaves a hole and returns the latest vector", () => {
		const store = open();
		fill(store, 4);
		expect(store.holeRatio()).toBe(0);
		store.upsert(key(2), "fp-2b", vec(50));
		expect(store.size).toBe(4);
		expect(store.stats()).toMatchObject({ entries: 4, slots: 5, holes: 1 });
		expect(store.holeRatio()).toBeCloseTo(1 / 5);
		expect(store.get(key(2))?.fp).toBe("fp-2b");
		expect(Array.from(store.get(key(2))?.vec ?? [])).toEqual(Array.from(vec(50)));
		expect(store.search(vec(50), 1)[0].key).toBe(key(2));
	});

	it("rejects vectors with the wrong dims or non-finite values", () => {
		const store = open();
		expect(() => store.upsert("a", "fp", new Float32Array(DIMS + 1))).toThrow(/dims/);
		const nan = vec(1);
		nan[3] = NaN;
		expect(() => store.upsert("a", "fp", nan)).toThrow(/non-finite/);
		const inf = vec(1);
		inf[0] = Infinity;
		expect(() => store.upsert("a", "fp", inf)).toThrow(/non-finite/);
		expect(store.size).toBe(0);
	});

	it("rejects queries with the wrong dims", () => {
		const store = open();
		fill(store, 2);
		expect(() => store.search(new Float32Array(DIMS - 1), 5)).toThrow(/dims/);
	});

	it("rejects an invalid dims header", () => {
		expect(() => open({}, { ...HEADER, dims: 0 })).toThrow(/dims/);
	});

	it("clear() empties the store and the files", () => {
		const store = open();
		fill(store, 5);
		store.flushSync();
		store.clear();
		expect(store.size).toBe(0);
		expect(store.search(vec(0), 10)).toEqual([]);
		store.close();
		const reopened = open();
		expect(reopened.openResult.status).toBe("loaded");
		expect(reopened.size).toBe(0);
		expect(fileSize(vecPath)).toBe(0);
		// Usable afterwards.
		reopened.upsert("x", "fp", vec(1));
		reopened.close();
		expect(open().get("x")?.fp).toBe("fp");
	});

	it("throws on writes after close()", () => {
		const store = open();
		fill(store, 1);
		store.close();
		expect(() => store.upsert("a", "fp", vec(1))).toThrow(/closed/);
		store.close(); // idempotent
	});
});

describe("VectorStore persistence", () => {
	it("persists entries and tombstones across close/reopen", () => {
		const store = open();
		fill(store, 8);
		store.markMissing(key(3), 1234);
		store.markMissing(key(3), 5678);
		store.markMissing(key(4), 42);
		const before = allHits(store, vec(2));
		store.close();
		expect(fileSize(vecPath)).toBe(8 * SLOT_BYTES);

		const reopened = open();
		expect(reopened.openResult).toEqual({ status: "loaded", dropped: 0, recoveredTmp: false });
		expect(reopened.size).toBe(8);
		expect(allHits(reopened, vec(2))).toEqual(before);
		expect(reopened.get(key(3))).toMatchObject({ missingSince: 1234, missCount: 2 });
		expect(reopened.get(key(4))).toMatchObject({ missingSince: 42, missCount: 1 });
		expect(reopened.get(key(5))?.fp).toBe("fp-5");
		expect(Array.from(reopened.get(key(5))?.vec ?? [])).toEqual(Array.from(vec(5)));
	});

	it("persists holes and the latest vector of a re-embedded key", () => {
		const store = open();
		fill(store, 3);
		store.flushSync();
		store.upsert(key(1), "fp-1b", vec(77));
		store.remove(key(2));
		store.close();
		const reopened = open();
		expect(reopened.openResult.status).toBe("loaded");
		expect(reopened.stats()).toMatchObject({ entries: 2, slots: 4, holes: 2 });
		expect(Array.from(reopened.get(key(1))?.vec ?? [])).toEqual(Array.from(vec(77)));
		expect(reopened.has(key(2))).toBe(false);
	});

	it("flush() resolves and commits", async () => {
		const store = open();
		fill(store, 2);
		await store.flush();
		expect(store.stats().dirty).toBe(false);
		expect(fs.existsSync(metaPath)).toBe(true);
	});

	it.each([
		["modelId", "other/model"],
		["revision", "rev-2"],
		["dtype", "fp16"],
		["dims", 16],
		["imageTokenBudget", 280],
		["preprocessVersion", 2],
	] as const)("resets on a header mismatch in %s", (field, value) => {
		const store = open();
		fill(store, 4);
		store.close();
		const header: IndexHeader = { ...HEADER, [field]: value };
		const reopened = open({}, header);
		expect(reopened.openResult).toEqual({
			status: "reset",
			reason: "header-mismatch",
			dropped: 0,
			recoveredTmp: false,
		});
		expect(reopened.size).toBe(0);
		expect(fs.existsSync(metaPath)).toBe(false);
		expect(fs.existsSync(vecPath)).toBe(false);
		// Writing with the new header works and survives a reopen.
		reopened.upsert("a", "fp", seededVector(1, header.dims));
		reopened.close();
		const again = open({}, header);
		expect(again.openResult.status).toBe("loaded");
		expect(again.size).toBe(1);
	});

	it("resets on a corrupt meta.json", () => {
		const store = open();
		fill(store, 3);
		store.close();
		fs.writeFileSync(metaPath, "{ not json");
		const reopened = open();
		expect(reopened.openResult).toMatchObject({ status: "reset", reason: "corrupt-meta", dropped: 0 });
		expect(reopened.size).toBe(0);
		expect(fs.existsSync(metaPath)).toBe(false);
		expect(fs.existsSync(vecPath)).toBe(false);
	});

	it("resets on a meta.json with an unknown format", () => {
		const store = open();
		fill(store, 1);
		store.close();
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
		meta.format = 999;
		fs.writeFileSync(metaPath, JSON.stringify(meta));
		expect(open().openResult).toMatchObject({ status: "reset", reason: "corrupt-meta" });
	});
});

describe("VectorStore debounced flush", () => {
	it("flushes only when the injected timer fires", () => {
		const timers = new FakeTimers();
		const store = open({ flushDelayMs: 1000, timers });
		store.upsert("a", "fp-a", vec(1));
		expect(timers.delays()).toEqual([1000]);
		store.upsert("b", "fp-b", vec(2));
		store.markMissing("a", 1);
		// One timer for a burst of changes.
		expect(timers.size).toBe(1);
		expect(fs.existsSync(metaPath)).toBe(false);
		expect(store.stats().dirty).toBe(true);

		timers.fireAll();
		expect(store.stats().dirty).toBe(false);
		expect(fs.existsSync(metaPath)).toBe(true);
		const other = open();
		expect(other.size).toBe(2);
		expect(other.get("a")?.missingSince).toBe(1);

		// The next change arms a new timer.
		store.upsert("c", "fp-c", vec(3));
		expect(timers.size).toBe(1);
	});

	it("an explicit flush cancels the pending timer", () => {
		const timers = new FakeTimers();
		const store = open({ flushDelayMs: 500, timers });
		store.upsert("a", "fp-a", vec(1));
		expect(timers.size).toBe(1);
		store.flushSync();
		expect(timers.size).toBe(0);
		expect(timers.cleared).toHaveLength(1);
		expect(fs.existsSync(metaPath)).toBe(true);
	});

	it("reports automatic flush failures to onFlushError", () => {
		const timers = new FakeTimers();
		const errors: unknown[] = [];
		const failing = wrapFs({
			renameSync: () => {
				throw new Error("injected rename failure");
			},
		});
		const store = open({ flushDelayMs: 100, timers, fs: failing, onFlushError: (e) => errors.push(e) });
		store.upsert("a", "fp", vec(1));
		timers.fireAll();
		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toMatch(/injected rename failure/);
		expect(store.stats().dirty).toBe(true);
	});

	it("flushDelayMs 0 never arms a timer", () => {
		const timers = new FakeTimers();
		const store = open({ flushDelayMs: 0, timers });
		fill(store, 3);
		expect(timers.armed).toEqual([]);
		expect(fs.existsSync(metaPath)).toBe(false);
	});
});

describe("VectorStore compaction", () => {
	it("compacts only above the hole threshold, keeping results identical", async () => {
		const store = open();
		fill(store, 10);
		store.flushSync();
		for (let i = 0; i < 3; i++) {
			store.upsert(key(i), `fp-${i}b`, vec(100 + i));
		}
		// 3 holes / 13 slots = 0.23
		expect(await store.compactIfNeeded()).toBe(false);
		for (let i = 3; i < 5; i++) {
			store.upsert(key(i), `fp-${i}b`, vec(100 + i));
		}
		store.markMissing(key(7), 99);
		// 5 holes / 15 slots = 0.33
		expect(store.holeRatio()).toBeCloseTo(5 / 15);
		const q = vec(101);
		const before = allHits(store, q);
		expect(await store.compactIfNeeded()).toBe(true);
		expect(store.stats()).toMatchObject({ entries: 10, slots: 10, holes: 0, pendingSlots: 0, dirty: false });
		expect(store.holeRatio()).toBe(0);
		expect(allHits(store, q)).toEqual(before);
		expect(fileSize(vecPath)).toBe(10 * SLOT_BYTES);
		expect(tmpFiles()).toEqual([]);
		expect(await store.compactIfNeeded()).toBe(false);

		store.close();
		const reopened = open();
		expect(reopened.openResult).toEqual({ status: "loaded", dropped: 0, recoveredTmp: false });
		expect(allHits(reopened, q)).toEqual(before);
		expect(reopened.get(key(7))).toMatchObject({ missingSince: 99, missCount: 1 });
		expect(reopened.get(key(2))?.fp).toBe("fp-2b");
		expect(fileSize(vecPath)).toBe(10 * SLOT_BYTES);
	});

	it("keeps working after compaction (appends after the compacted slots)", () => {
		const store = open();
		fill(store, 4);
		store.remove(key(0));
		store.remove(key(1));
		store.compactSync();
		store.upsert("new", "fp-new", vec(200));
		store.close();
		const reopened = open();
		expect(reopened.openResult.status).toBe("loaded");
		expect(reopened.keys().sort()).toEqual([key(2), key(3), "new"].sort());
		expect(reopened.search(vec(200), 1)[0].key).toBe("new");
		expect(fileSize(vecPath)).toBe(3 * SLOT_BYTES);
	});
});

describe("VectorStore crash recovery", () => {
	function seeded(n: number): { before: Array<{ key: string; score: number }> } {
		const store = open();
		fill(store, n);
		const before = allHits(store);
		store.close();
		return { before };
	}

	it("(a) trims extra bytes appended to vectors.bin", () => {
		const { before } = seeded(5);
		fs.appendFileSync(vecPath, Buffer.alloc(SLOT_BYTES + 13, 7));
		const store = open();
		expect(store.openResult).toEqual({ status: "repaired", dropped: 0, recoveredTmp: false });
		expect(fileSize(vecPath)).toBe(store.stats().slots * SLOT_BYTES);
		expect(fileSize(vecPath)).toBe(5 * SLOT_BYTES);
		expect(allHits(store)).toEqual(before);
		store.close();
		expect(open().openResult.status).toBe("loaded");
	});

	it("(b) drops entries whose slots are past the end of a truncated file", () => {
		const { before } = seeded(6);
		// Keep slots 0..2 whole, cut slot 3 partially, slots 4..5 gone.
		fs.truncateSync(vecPath, 3 * SLOT_BYTES + 10);
		const store = open();
		expect(store.openResult).toEqual({ status: "repaired", dropped: 3, recoveredTmp: false });
		expect(store.keys().sort()).toEqual([key(0), key(1), key(2)].sort());
		expect(allHits(store)).toEqual(before.filter((h) => [key(0), key(1), key(2)].includes(h.key)));
		expect(fileSize(vecPath)).toBe(3 * SLOT_BYTES);
		for (let i = 0; i < 3; i++) {
			expect(Array.from(store.get(key(i))?.vec ?? [])).toEqual(Array.from(vec(i)));
		}
		store.close();
		expect(open().openResult).toMatchObject({ status: "loaded", dropped: 0 });
	});

	it("(c) drops only the entry whose slot bytes are corrupted", () => {
		const { before } = seeded(5);
		const bytes = fs.readFileSync(vecPath);
		bytes[2 * SLOT_BYTES + 5] ^= 0xff;
		fs.writeFileSync(vecPath, bytes);
		const store = open();
		expect(store.openResult).toEqual({ status: "repaired", dropped: 1, recoveredTmp: false });
		expect(store.has(key(2))).toBe(false);
		expect(store.size).toBe(4);
		expect(allHits(store)).toEqual(before.filter((h) => h.key !== key(2)));
		// The bad slot became a hole; the file length is unchanged.
		expect(store.stats()).toMatchObject({ slots: 5, holes: 1 });
		expect(fileSize(vecPath)).toBe(5 * SLOT_BYTES);
	});

	it("(d) drops every entry when vectors.bin is missing", () => {
		seeded(4);
		fs.unlinkSync(vecPath);
		const store = open();
		expect(store.openResult).toEqual({ status: "repaired", dropped: 4, recoveredTmp: false });
		expect(store.size).toBe(0);
		store.upsert("a", "fp", vec(1));
		store.close();
		const reopened = open();
		expect(reopened.openResult.status).toBe("loaded");
		expect(reopened.keys()).toEqual(["a"]);
	});

	it("drops entries that point at a duplicated slot", () => {
		seeded(3);
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
			entries: Record<string, { fp: string; slot: number; h: number }>;
		};
		meta.entries["dup"] = { ...meta.entries[key(1)] };
		fs.writeFileSync(metaPath, JSON.stringify(meta));
		const store = open();
		expect(store.openResult.status).toBe("repaired");
		expect(store.openResult.dropped).toBe(1);
		expect(store.size).toBe(3);
	});
});

describe("VectorStore atomic meta write", () => {
	function failingRename(state: { fail: (from: string) => boolean }): StoreFs {
		return wrapFs({
			renameSync: (from, to) => {
				if (state.fail(from)) {
					throw new Error(`injected rename failure: ${path.basename(from)}`);
				}
				fs.renameSync(from, to);
			},
		});
	}

	it("a failed meta rename leaves the old meta.json; a retry succeeds", () => {
		const state = { fail: (_from: string) => false };
		const store = open({ fs: failingRename(state) });
		fill(store, 3);
		store.flushSync();
		const oldMeta = fs.readFileSync(metaPath, "utf8");

		state.fail = (from) => path.basename(from) === `${META_FILE}.tmp`;
		store.upsert(key(3), "fp-3", vec(3));
		expect(() => store.flushSync()).toThrow(/injected rename failure/);
		expect(fs.readFileSync(metaPath, "utf8")).toBe(oldMeta);
		expect(store.stats().dirty).toBe(true);

		state.fail = () => false;
		store.flushSync();
		expect(store.stats()).toMatchObject({ dirty: false, pendingSlots: 0 });
		store.close();
		const reopened = open();
		expect(reopened.openResult).toEqual({ status: "loaded", dropped: 0, recoveredTmp: false });
		expect(reopened.size).toBe(4);
		expect(fileSize(vecPath)).toBe(4 * SLOT_BYTES);
	});

	it("a complete, fsynced meta.json.tmp left by a failed rename is rolled forward on open", () => {
		const state = { fail: (_from: string) => false };
		const store = open({ fs: failingRename(state) });
		fill(store, 3);
		store.flushSync();
		const oldKeys = new Set(store.keys());
		const before = allHits(store);
		state.fail = (from) => path.basename(from) === `${META_FILE}.tmp`;
		store.upsert(key(3), "fp-3", vec(3));
		expect(() => store.flushSync()).toThrow();
		expect(fs.existsSync(metaPath + ".tmp")).toBe(true);

		// The new slot was appended and fsynced and the tmp meta is whole and
		// matches vectors.bin, so open() completes the commit.
		const reopened = open();
		expect(reopened.openResult).toEqual({ status: "loaded", dropped: 0, recoveredTmp: true });
		expect(reopened.search(vec(0), 1000, oldKeys)).toEqual(before);
		expect(reopened.has(key(3))).toBe(true);
		expect(tmpFiles()).toEqual([]);
	});

	it("a meta.json.tmp that failed mid-write is discarded; old entries survive", () => {
		const state = { failTmpWrite: false };
		const tmpFds = new Set<number>();
		const store = open({
			fs: wrapFs({
				openSync: (p, flags) => {
					const fd = fs.openSync(p, flags);
					if (path.basename(p) === `${META_FILE}.tmp`) {
						tmpFds.add(fd);
					}
					return fd;
				},
				writeSync: (fd, b, o, l, pos) => {
					if (state.failTmpWrite && tmpFds.has(fd)) {
						throw new Error("injected write failure");
					}
					return fs.writeSync(fd, b, o, l, pos);
				},
				closeSync: (fd) => {
					tmpFds.delete(fd);
					fs.closeSync(fd);
				},
			}),
		});
		fill(store, 3);
		store.flushSync();
		const oldMeta = fs.readFileSync(metaPath, "utf8");
		const before = allHits(store);

		state.failTmpWrite = true;
		store.upsert(key(3), "fp-3", vec(3));
		expect(() => store.flushSync()).toThrow(/injected write failure/);
		expect(fs.readFileSync(metaPath, "utf8")).toBe(oldMeta);
		// The new slot was already appended to vectors.bin.
		expect(fileSize(vecPath)).toBe(4 * SLOT_BYTES);

		const reopened = open();
		expect(reopened.openResult).toEqual({ status: "repaired", dropped: 0, recoveredTmp: true });
		expect(reopened.has(key(3))).toBe(false);
		expect(allHits(reopened)).toEqual(before);
		expect(fileSize(vecPath)).toBe(3 * SLOT_BYTES);
		expect(tmpFiles()).toEqual([]);
	});

	function holeyStore(state: { fail: (from: string) => boolean }): {
		store: VectorStore;
		before: Array<{ key: string; score: number }>;
	} {
		const store = open({ fs: failingRename(state) });
		fill(store, 10);
		store.flushSync();
		for (let i = 0; i < 5; i++) {
			store.upsert(key(i), `fp-${i}b`, vec(300 + i));
		}
		store.flushSync();
		return { store, before: allHits(store, vec(302)) };
	}

	it("(e) a failed vectors.bin rename leaves the store open and usable", async () => {
		const state = { fail: (_from: string) => false };
		const { store, before } = holeyStore(state);
		const oldMeta = fs.readFileSync(metaPath, "utf8");
		state.fail = (from) => path.basename(from) === `${VECTORS_FILE}.tmp`;
		await expect(store.compactIfNeeded()).rejects.toThrow(/injected rename failure/);
		expect(fs.readFileSync(metaPath, "utf8")).toBe(oldMeta);
		expect(tmpFiles()).toEqual([]);
		expect(store.isClosed).toBe(false);
		expect(allHits(store, vec(302))).toEqual(before);
		// Still writable (Windows EPERM from a scanner must not need a restart).
		store.upsert(key(20), "fp-20", vec(20));
		store.flushSync();
		state.fail = () => false;
		expect(await store.compactIfNeeded()).toBe(true);
		const reopened = open();
		expect(reopened.has(key(20))).toBe(true);
		expect(reopened.stats()).toMatchObject({ entries: 11, holes: 0 });
	});

	it("(e2) compaction crash before vectors.bin is replaced rolls back", async () => {
		const state = { fail: (_from: string) => false };
		const { store, before } = holeyStore(state);
		const oldMeta = fs.readFileSync(metaPath, "utf8");
		// A crash leaves both tmp files (simulated: the process died before the renames).
		store.close();
		fs.writeFileSync(vecPath + ".tmp", Buffer.alloc(10 * SLOT_BYTES));
		fs.writeFileSync(metaPath + ".tmp", oldMeta.replace(/"slotCount":\d+/, "\"slotCount\":10"));
		expect(tmpFiles().sort()).toEqual([`${META_FILE}.tmp`, `${VECTORS_FILE}.tmp`]);

		const reopened = open();
		expect(reopened.openResult).toEqual({ status: "loaded", dropped: 0, recoveredTmp: true });
		expect(allHits(reopened, vec(302))).toEqual(before);
		expect(reopened.stats()).toMatchObject({ slots: 15, holes: 5 });
		expect(fileSize(vecPath)).toBe(15 * SLOT_BYTES);
		expect(tmpFiles()).toEqual([]);
	});

	it("(f) compaction crash between the renames rolls forward", async () => {
		const state = { fail: (_from: string) => false };
		const { store, before } = holeyStore(state);
		state.fail = (from) => path.basename(from) === `${META_FILE}.tmp`;
		await expect(store.compactIfNeeded()).rejects.toThrow(/injected rename failure/);
		expect(fileSize(vecPath)).toBe(10 * SLOT_BYTES);
		expect(tmpFiles()).toEqual([`${META_FILE}.tmp`]);
		// Memory no longer matches the disk: closed until reopened.
		expect(store.isClosed).toBe(true);
		expect(() => store.upsert(key(30), "fp", vec(30))).toThrow(/closed/);

		const reopened = open();
		expect(reopened.openResult).toEqual({ status: "loaded", dropped: 0, recoveredTmp: true });
		expect(allHits(reopened, vec(302))).toEqual(before);
		expect(reopened.stats()).toMatchObject({ entries: 10, slots: 10, holes: 0 });
		expect(fileSize(vecPath)).toBe(10 * SLOT_BYTES);
		expect(tmpFiles()).toEqual([]);
	});

	it("discards a stray meta.json.tmp that does not match vectors.bin", () => {
		const store = open();
		fill(store, 2);
		store.close();
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { slotCount: number };
		meta.slotCount = 7;
		fs.writeFileSync(metaPath + ".tmp", JSON.stringify(meta));
		const reopened = open();
		expect(reopened.openResult).toEqual({ status: "loaded", dropped: 0, recoveredTmp: true });
		expect(reopened.size).toBe(2);
		expect(tmpFiles()).toEqual([]);
	});
});

describe("VectorStore helpers", () => {
	it("scopeIndexDir builds <indexRoot>/<vaultId>/<scopeId>", () => {
		const base = path.join(root, "indexes");
		expect(scopeIndexDir(base, "vault_1", "abc_DEF-123")).toBe(path.join(base, "vault_1", "abc_DEF-123"));
	});

	it.each(["", "a/b", "..", "a b", "a.b", "x".repeat(65), "a\\b"])("scopeIndexDir rejects %j", (id) => {
		expect(() => scopeIndexDir("/indexes", "vault", id)).toThrow(/Invalid scope id/);
	});

	it.each(["", "..", "a/b", "a\\b", "a.b"])("scopeIndexDir rejects vault id %j", (id) => {
		expect(() => scopeIndexDir("/indexes", id, "scope")).toThrow(/Invalid vault id/);
	});

	it("headerFromConfig copies exactly the header fields", () => {
		const cfg = currentEmbeddingConfig(140);
		const header = headerFromConfig(cfg);
		expect(header).toEqual({
			modelId: cfg.modelId,
			revision: cfg.revision,
			dtype: "q4",
			dims: 256,
			imageTokenBudget: 140,
			preprocessVersion: cfg.preprocessVersion,
		});
	});

	it("sameHeader compares every header field", () => {
		expect(sameHeader({ ...HEADER }, HEADER)).toBe(true);
		expect(sameHeader({ ...HEADER, extra: 1 }, HEADER)).toBe(true);
		expect(sameHeader(null, HEADER)).toBe(false);
		expect(sameHeader("x", HEADER)).toBe(false);
		for (const field of Object.keys(HEADER) as Array<keyof IndexHeader>) {
			const other: Record<string, unknown> = { ...HEADER };
			other[field] = typeof HEADER[field] === "number" ? Number(HEADER[field]) + 1 : `${String(HEADER[field])}x`;
			expect(sameHeader(other, HEADER)).toBe(false);
			delete other[field];
			expect(sameHeader(other, HEADER)).toBe(false);
		}
		// Types matter: "8" is not 8.
		expect(sameHeader({ ...HEADER, dims: String(DIMS) }, HEADER)).toBe(false);
	});
});
