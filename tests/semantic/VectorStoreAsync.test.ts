import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seededVector } from "../../src/semantic/EmbeddingBackend";
import { IndexHeader, META_FILE, VectorStore } from "../../src/semantic/VectorStore";
import { FakeTimers, makeTempDir, removeDir } from "./helpers";

const DIMS = 8;
const HEADER: IndexHeader = { modelId: "m", revision: "r", dtype: "q4", dims: DIMS, imageTokenBudget: 70, preprocessVersion: 1 };
const vec = (n: number) => seededVector(500 + n, DIMS);

let root: string;
let dir: string;
beforeEach(() => {
	root = makeTempDir("vs-async-");
	dir = path.join(root, "scope");
});
afterEach(() => {
	removeDir(root);
});

function openAsync(): VectorStore {
	return VectorStore.open(dir, HEADER, { flushDelayMs: 0, asyncIo: true });
}

function expectReopened(keys: string[]): void {
	const store = VectorStore.open(dir, HEADER, { flushDelayMs: 0 });
	expect(store.openResult.dropped).toBe(0);
	expect(store.keys().sort()).toEqual([...keys].sort());
	for (const k of keys) {
		expect(Array.from(store.get(k)?.vec ?? [])).toEqual(Array.from(vec(Number(k.slice(1)))));
	}
}

describe("VectorStore asyncIo", () => {
	it("flush() commits with async I/O", async () => {
		const store = openAsync();
		store.upsert("k1", "fp", vec(1));
		store.upsert("k2", "fp", vec(2));
		await store.flush();
		expect(store.stats()).toMatchObject({ dirty: false, pendingSlots: 0 });
		expectReopened(["k1", "k2"]);
		expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	it("changes made during an async flush stay dirty and are committed by the next flush", async () => {
		const store = openAsync();
		store.upsert("k1", "fp", vec(1));
		const first = store.flush();
		// Let the flush take its snapshot and start its I/O.
		await new Promise((resolve) => setImmediate(resolve));
		store.upsert("k2", "fp", vec(2));
		await first;
		expect(store.stats().dirty).toBe(true);
		await store.flush();
		expect(store.stats().dirty).toBe(false);
		expectReopened(["k1", "k2"]);
	});

	it("a synchronous close during an async flush wins and stays consistent", async () => {
		const store = openAsync();
		for (let i = 0; i < 20; i++) store.upsert(`k${i}`, "fp", vec(i));
		const pending = store.flush();
		await new Promise((resolve) => setImmediate(resolve));
		store.upsert("k20", "fp", vec(20));
		store.close();
		await pending;
		expectReopened(Array.from({ length: 21 }, (_, i) => `k${i}`));
		expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	it("a compaction during an async flush is not undone by it", async () => {
		const store = openAsync();
		for (let i = 0; i < 10; i++) store.upsert(`k${i}`, "fp", vec(i));
		store.flushSync();
		for (let i = 0; i < 6; i++) store.remove(`k${i}`);
		store.upsert("k10", "fp", vec(10));
		const pending = store.flush();
		await new Promise((resolve) => setImmediate(resolve));
		store.compactSync();
		await pending;
		store.close();
		expectReopened(["k6", "k7", "k8", "k9", "k10"]);
	});

	it("the debounced timer uses the async path", async () => {
		const timers = new FakeTimers();
		const store = VectorStore.open(dir, HEADER, { flushDelayMs: 100, timers, asyncIo: true });
		store.upsert("k1", "fp", vec(1));
		timers.fireAll();
		expect(fs.existsSync(path.join(dir, META_FILE))).toBe(false);
		await store.flush();
		expectReopened(["k1"]);
	});

	it("open removes an orphaned async meta tmp file", () => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "meta.json.a7.tmp"), "{}");
		fs.writeFileSync(path.join(dir, "unrelated.tmp"), "keep");
		VectorStore.open(dir, HEADER, { flushDelayMs: 0 });
		expect(fs.readdirSync(dir).sort()).toEqual(["unrelated.tmp"]);
	});

	it("peek and setFingerprint work without copying vectors", () => {
		const store = openAsync();
		store.upsert("k1", "u:5", vec(1));
		store.markMissing("k1", 9);
		expect(store.peek("k1")).toEqual({ fp: "u:5", missingSince: 9, missCount: 1 });
		store.setFingerprint("k1", "e:x");
		expect(store.peek("k1")?.fp).toBe("e:x");
		expect(store.visibleCount()).toBe(0);
		store.restore("k1");
		expect(store.visibleCount()).toBe(1);
		store.close();
		expect(VectorStore.open(dir, HEADER, { flushDelayMs: 0 }).peek("k1")).toEqual({ fp: "e:x" });
	});
});
