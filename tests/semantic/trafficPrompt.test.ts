import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentEmbeddingConfig, FakeEmbeddingBackend, fakeImageBytes } from "../../src/semantic/EmbeddingBackend";
import { IndexScope, makeIndexScope } from "../../src/semantic/fingerprint";
import {
	AUTO_CONFIRM_LIMIT_BYTES,
	IndexProgress,
	SemanticIndexService,
	TrafficEstimate,
	TrafficPromptReason,
	trafficPromptReason,
} from "../../src/semantic/SemanticIndexService";
import type { OssImage } from "../../src/types/oss";
import { flushMicrotasks, makeTempDir, removeDir } from "./helpers";

const CFG = currentEmbeddingConfig(70);
const REMOTE: IndexScope = makeIndexScope("s3", { bucket: "b", endpoint: "s3.example", region: "r", forcePathStyle: false }, "");

describe("trafficPromptReason (§9.4)", () => {
	const base = { local: false, pendingCount: 3, auto: false, confirmedBefore: true, pendingBytes: 1000 };

	it("manual starts on a remote scope always ask", () => {
		expect(trafficPromptReason(base)).toBe("manual");
		expect(trafficPromptReason({ ...base, confirmedBefore: false })).toBe("manual");
	});

	it("Local and nothing-to-download never ask", () => {
		expect(trafficPromptReason({ ...base, local: true })).toBeNull();
		expect(trafficPromptReason({ ...base, local: true, auto: true, confirmedBefore: false })).toBeNull();
		expect(trafficPromptReason({ ...base, pendingCount: 0 })).toBeNull();
	});

	it("autoIndex asks the first time, then only above 200 MB", () => {
		const auto = { ...base, auto: true };
		expect(trafficPromptReason({ ...auto, confirmedBefore: false })).toBe("auto-first");
		expect(trafficPromptReason({ ...auto, pendingBytes: AUTO_CONFIRM_LIMIT_BYTES })).toBeNull();
		expect(trafficPromptReason({ ...auto, pendingBytes: AUTO_CONFIRM_LIMIT_BYTES + 1 })).toBe("auto-large");
		expect(AUTO_CONFIRM_LIMIT_BYTES).toBe(200_000_000);
	});
});

describe("SemanticIndexService P4 additions", () => {
	let root: string;
	beforeEach(() => {
		root = makeTempDir("idx-p4-");
	});
	afterEach(() => {
		removeDir(root);
	});

	function setup(fail: Set<string>) {
		const asked: { estimate: TrafficEstimate; reason: TrafficPromptReason }[] = [];
		const progress: IndexProgress[] = [];
		const service = new SemanticIndexService({
			indexRoot: () => root,
			vaultId: "vault1",
			embeddingConfig: () => CFG,
			isEnabled: () => true,
			isReady: () => true,
			autoIndex: () => false,
			createBackend: () => new FakeEmbeddingBackend(),
			readBytes: (_scope, o) => (fail.has(o.key)
				? Promise.reject(new Error("503"))
				: Promise.resolve(fakeImageBytes(o.key))),
			rasterizeSvg: () => Promise.reject(new Error("no svg")),
			// Fake "images" are text; embed them as PNG.
			prepare: (bytes) => Promise.resolve({ kind: "embed", bytes, mime: "image/png", format: "png" }),
			confirmTraffic: (_scope, estimate, reason) => {
				asked.push({ estimate, reason });
				return Promise.resolve(true);
			},
			storeOptions: { flushDelayMs: 0 },
			statusFlushDelayMs: 0,
		});
		service.onProgress((p) => progress.push(p));
		return { service, asked, progress };
	}

	const obj = (key: string, size = 1000): OssImage => ({ key, url: `https://cdn.example/${key}`, size, lastModified: new Date(1_700_000_000_000) });

	it("passes the reason and counts objects without a size", async () => {
		const { service, asked } = setup(new Set());
		service.reconcile(service.beginListing(REMOTE), REMOTE, { items: [obj("a.png", 5000), obj("b.png", 0)], complete: true, prefix: "" });
		await service.start(REMOTE);
		await service.whenIdle();
		expect(asked).toEqual([{ estimate: { pendingCount: 2, pendingBytes: 5000, indexedCount: 0, unknownSizeCount: 1 }, reason: "manual" }]);
	});

	it("reports the current file, then resets failures for a retry", async () => {
		const fail = new Set(["bad.png"]);
		const { service, progress } = setup(fail);
		const items = [obj("ok.png"), obj("bad.png")];
		service.reconcile(service.beginListing(REMOTE), REMOTE, { items, complete: true, prefix: "" });
		await service.start(REMOTE);
		await service.whenIdle();
		expect(progress.map((p) => p.currentKey).filter(Boolean)).toEqual(expect.arrayContaining(["ok.png", "bad.png"]));
		expect(service.getProgress().currentKey).toBeNull();
		expect(service.isIndexed(REMOTE, "ok.png")).toBe(true);
		expect(service.isIndexed(REMOTE, "bad.png")).toBe(false);
		expect(service.getStats(REMOTE).failed).toBe(1);
		// Backoff: not pending right after the failure...
		expect(service.estimate(REMOTE).pendingCount).toBe(0);
		// ...until "Retry failed" forgets the failure.
		fail.clear();
		expect(service.resetFailed(REMOTE)).toBe(1);
		expect(service.estimate(REMOTE).pendingCount).toBe(1);
		await service.start(REMOTE);
		await flushMicrotasks();
		await service.whenIdle();
		expect(service.isIndexed(REMOTE, "bad.png")).toBe(true);
		expect(service.getStats(REMOTE).failed).toBe(0);
		service.dispose();
	});
});
