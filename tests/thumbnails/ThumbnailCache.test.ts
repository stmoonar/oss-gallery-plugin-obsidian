/**
 * The local thumbnail cache (src/thumbnails): names, fingerprints, manifest,
 * LRU eviction under the size cap, and "Clear thumbnails" vs "Clear index".
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearVaultIndex } from "../../src/semantic/indexFiles";
import type { EncodedThumbnail } from "../../src/thumbnails/encode";
import { ThumbnailCache, TOUCH_RESOLUTION_MS } from "../../src/thumbnails/ThumbnailCache";
import {
	clearThumbnailDir,
	isThumbnailFileName,
	nodeThumbFs,
	THUMBS_DIR_NAME,
	THUMBS_MANIFEST,
	thumbnailFileName,
	thumbnailMatches,
	thumbsVaultDir,
} from "../../src/thumbnails/thumbnailFiles";
import type { OssImage } from "../../src/types/oss";
import { fingerprint, uploadFingerprint } from "../../src/utils/objectScope";
import { FakeTimers, makeTempDir, removeDir } from "../semantic/helpers";

const SCOPE = "0123456789abcdef";
const OTHER_SCOPE = "fedcba9876543210";

/** Plays <appDir>: <root>/thumbs/<vault> and <root>/indexes/<vault>. */
let root: string;
let thumbsDir: string;
let clock: { now: number };
beforeEach(() => {
	root = makeTempDir("thumbs-");
	thumbsDir = thumbsVaultDir(path.join(root, THUMBS_DIR_NAME), "vault1");
	clock = { now: 1_000_000 };
});
afterEach(() => {
	removeDir(root);
});

function obj(key: string, opts: Partial<OssImage> = {}): OssImage {
	return { key, url: `https://cdn.example/${key}`, size: 1000, lastModified: new Date(1_700_000_000_000), ...opts };
}

/** Object whose fingerprint is "s:1:1" (what most tests store). */
function small(key: string): OssImage {
	return obj(key, { size: 1, lastModified: new Date(1) });
}

function thumb(text: string, mime: EncodedThumbnail["mime"] = "image/webp"): EncodedThumbnail {
	const bytes = new TextEncoder().encode(text);
	return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mime };
}

function cache(options: { root?: () => string | null } = {}): ThumbnailCache {
	return new ThumbnailCache(options.root ?? (() => thumbsDir), { flushDelayMs: 0, now: () => clock.now });
}

function scopeFiles(scopeId = SCOPE): string[] {
	const dir = path.join(thumbsDir, scopeId);
	return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

async function readText(c: ThumbnailCache, o: OssImage, scopeId = SCOPE): Promise<string | null> {
	const r = await c.read(scopeId, o);
	return r ? new TextDecoder().decode(r.bytes) : null;
}

function manifest(scopeId = SCOPE): Record<string, { fp: string; atime: number; bytes: number }> {
	const file = path.join(thumbsDir, scopeId, THUMBS_MANIFEST);
	return (JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Record<string, { fp: string; atime: number; bytes: number }> }).entries;
}

describe("thumbnail names and fingerprints", () => {
	it("names files <hash(key)>-<hash(fp)>.<ext>, stable and fingerprint-specific", () => {
		const a = thumbnailFileName("2025/a.png", "e:\"1\"", "webp");
		expect(a).toMatch(/^[0-9a-f]{32}-[0-9a-f]{12}\.webp$/);
		expect(thumbnailFileName("2025/a.png", "e:\"1\"", "webp")).toBe(a);
		expect(thumbnailFileName("2025/a.png", "e:\"2\"", "webp")).not.toBe(a);
		expect(thumbnailFileName("2025/b.png", "e:\"1\"", "webp").slice(0, 32)).not.toBe(a.slice(0, 32));
		expect(thumbnailFileName("2025/a.png", "e:\"1\"", "jpg")).toMatch(/\.jpg$/);
	});

	it("recognizes only the names it writes", () => {
		const name = thumbnailFileName("a.png", "s:1:2", "webp");
		expect(isThumbnailFileName(name)).toBe(true);
		expect(isThumbnailFileName(`${name}.tmp`)).toBe(true);
		expect(isThumbnailFileName(THUMBS_MANIFEST)).toBe(true);
		expect(isThumbnailFileName(`${THUMBS_MANIFEST}.tmp`)).toBe(true);
		for (const other of ["meta.json", "vectors.bin", "status.json", "notes.txt", "a.webp", `${name}.bak`, "thumbs.json.old"]) {
			expect(isThumbnailFileName(other)).toBe(false);
		}
	});

	it("matches the listed fingerprint, or a provisional upload fingerprint of the same size", () => {
		const o = obj("a.png", { etag: "\"x\"" });
		expect(thumbnailMatches(fingerprint(o), o)).toBe(true);
		expect(thumbnailMatches("e:\"old\"", o)).toBe(false);
		expect(thumbnailMatches(uploadFingerprint(1000), o)).toBe(true);
		expect(thumbnailMatches(uploadFingerprint(999), o)).toBe(false);
	});

	it("puts each vault under <appDir>/thumbs and rejects unsafe vault ids", () => {
		expect(thumbsVaultDir("/app/thumbs", "v1")).toBe(path.join("/app/thumbs", "v1"));
		expect(() => thumbsVaultDir("/app/thumbs", "..")).toThrow(/Invalid vault id/);
	});
});

describe("ThumbnailCache", () => {
	it("stores, reads back and persists a thumbnail for the current fingerprint", async () => {
		const c = cache();
		const o = obj("img/a.png");
		await c.put(SCOPE, o.key, fingerprint(o), thumb("A"));
		await c.flush();
		expect(await readText(c, o)).toBe("A");
		expect((await c.read(SCOPE, o))?.mime).toBe("image/webp");
		expect(scopeFiles()).toEqual([THUMBS_MANIFEST, thumbnailFileName(o.key, fingerprint(o), "webp")].sort());

		const reopened = cache();
		expect(await readText(reopened, o)).toBe("A");
		// A changed object does not get the old thumbnail.
		expect(await reopened.read(SCOPE, obj("img/a.png", { size: 2000 }))).toBeNull();
		expect(await reopened.read(SCOPE, obj("img/missing.png"))).toBeNull();
		expect(await reopened.read(OTHER_SCOPE, o)).toBeNull();
	});

	it("stores JPEG fallbacks as .jpg", async () => {
		const c = cache();
		const o = obj("a.png");
		await c.put(SCOPE, o.key, fingerprint(o), thumb("J", "image/jpeg"));
		expect((await c.read(SCOPE, o))?.mime).toBe("image/jpeg");
		expect(scopeFiles()).toContain(thumbnailFileName(o.key, fingerprint(o), "jpg"));
	});

	it("a changed fingerprint replaces the old file", async () => {
		const c = cache();
		const v1 = obj("a.png", { etag: "\"1\"" });
		const v2 = obj("a.png", { etag: "\"2\"" });
		await c.put(SCOPE, v1.key, fingerprint(v1), thumb("one"));
		await c.put(SCOPE, v2.key, fingerprint(v2), thumb("two"));
		await c.flush();
		expect(await readText(c, v1)).toBeNull();
		expect(await readText(c, v2)).toBe("two");
		expect(scopeFiles()).toEqual([THUMBS_MANIFEST, thumbnailFileName("a.png", fingerprint(v2), "webp")].sort());
	});

	it("put(null) drops a thumbnail of another fingerprint and keeps one of the same", async () => {
		const c = cache();
		const v1 = obj("a.png", { etag: "\"1\"" });
		await c.put(SCOPE, v1.key, fingerprint(v1), thumb("one"));
		await c.put(SCOPE, v1.key, fingerprint(v1), null);
		expect(await readText(c, v1)).toBe("one");
		await c.put(SCOPE, v1.key, "e:\"2\"", null);
		await c.flush();
		expect(await readText(c, v1)).toBeNull();
		expect(scopeFiles()).toEqual([THUMBS_MANIFEST]);
	});

	it("remove deletes the file and the entry", async () => {
		const c = cache();
		const a = obj("a.png");
		const b = obj("b.png");
		await c.put(SCOPE, a.key, fingerprint(a), thumb("A"));
		await c.put(SCOPE, b.key, fingerprint(b), thumb("B"));
		await c.remove(SCOPE, a.key);
		await c.remove(SCOPE, "never-stored.png");
		await c.flush();
		expect(await readText(c, a)).toBeNull();
		expect(await readText(c, b)).toBe("B");
		expect(scopeFiles()).toEqual([THUMBS_MANIFEST, thumbnailFileName("b.png", fingerprint(b), "webp")].sort());
		expect(await readText(cache(), a)).toBeNull();
	});

	it("reconcile adopts the listed fingerprint of an upload thumbnail", async () => {
		const c = cache();
		const listed = obj("up.png", { etag: "\"real\"", size: 1000 });
		await c.put(SCOPE, listed.key, uploadFingerprint(1000), thumb("U"));
		// A listing that shows another size does not adopt.
		await c.reconcile(SCOPE, [obj("up.png", { etag: "\"other\"", size: 5 })], null);
		expect(scopeFiles()).toContain(thumbnailFileName("up.png", uploadFingerprint(1000), "webp"));
		await c.reconcile(SCOPE, [listed], null);
		await c.flush();
		expect(scopeFiles()).toEqual([THUMBS_MANIFEST, thumbnailFileName("up.png", fingerprint(listed), "webp")].sort());
		expect(await readText(cache(), listed)).toBe("U");
	});

	it("reconcile prunes unlisted keys under the prefix, keeping ones written or viewed since the listing started", async () => {
		const c = cache();
		for (const key of ["img/a.png", "img/b.png", "other/c.png"]) {
			await c.put(SCOPE, key, "s:1:1", thumb(key));
		}
		clock.now += 10_000;
		const startedAt = clock.now;
		await c.put(SCOPE, "img/new.png", "s:1:1", thumb("new"));
		await c.reconcile(SCOPE, [small("img/a.png")], { prefix: "img/", since: startedAt });
		await c.flush();
		expect(await c.read(SCOPE, small("img/b.png"))).toBeNull();
		expect(await readText(c, small("img/a.png"))).toBe("img/a.png");
		expect(await readText(c, small("other/c.png"))).toBe("other/c.png");
		expect(await readText(c, small("img/new.png"))).toBe("new");
		expect((await c.stats()).count).toBe(3);
	});

	it("on first use removes orphans and tmp files, drops entries without a file, keeps unknown files", async () => {
		const c = cache();
		const a = obj("a.png");
		const b = obj("b.png");
		await c.put(SCOPE, a.key, fingerprint(a), thumb("A"));
		await c.put(SCOPE, b.key, fingerprint(b), thumb("B"));
		await c.flush();
		c.close();
		const dir = path.join(thumbsDir, SCOPE);
		const orphan = thumbnailFileName("gone.png", "s:1:1", "webp");
		fs.writeFileSync(path.join(dir, orphan), "x");
		fs.writeFileSync(path.join(dir, `${orphan}.tmp`), "x");
		fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
		fs.unlinkSync(path.join(dir, thumbnailFileName("b.png", fingerprint(b), "webp")));

		const reopened = cache();
		expect(await reopened.stats()).toEqual({ count: 1, bytes: 1 });
		await reopened.flush();
		expect(scopeFiles()).toEqual([THUMBS_MANIFEST, thumbnailFileName("a.png", fingerprint(a), "webp"), "notes.txt"].sort());
		expect(Object.keys(manifest())).toEqual(["a.png"]);
	});

	it("survives a corrupt manifest (starts empty, removes the unreferenced thumbnails)", async () => {
		const dir = path.join(thumbsDir, SCOPE);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, THUMBS_MANIFEST), "{not json");
		fs.writeFileSync(path.join(dir, thumbnailFileName("a.png", "s:1:1", "webp")), "x");
		const c = cache();
		expect(await c.read(SCOPE, small("a.png"))).toBeNull();
		expect(scopeFiles()).toEqual([THUMBS_MANIFEST]);
	});

	it("counts thumbnails and bytes over every scope of the vault", async () => {
		const c = cache();
		await c.put(SCOPE, "a.png", "s:1:1", thumb("12345"));
		await c.put(OTHER_SCOPE, "b.png", "s:1:1", thumb("123"));
		await c.flush();
		expect(await cache().stats()).toEqual({ count: 2, bytes: 8 });
		expect(await cache({ root: () => null }).stats()).toEqual({ count: 0, bytes: 0 });
	});

	it("does nothing without a usable directory", async () => {
		const c = cache({ root: () => null });
		await c.put(SCOPE, "a.png", "s:1:1", thumb("A"));
		expect(await c.read(SCOPE, small("a.png"))).toBeNull();
		expect(await c.clear()).toBeNull();
		expect((await c.enforceCap(1)).evicted).toBe(0);
		expect(fs.existsSync(thumbsDir)).toBe(false);
	});

	it("debounces manifest writes with the injected timers and writes them on close()", async () => {
		const timers = new FakeTimers();
		const c = new ThumbnailCache(() => thumbsDir, { timers, flushDelayMs: 2000 });
		await c.put(SCOPE, "a.png", "s:1:1", thumb("A"));
		await c.put(SCOPE, "b.png", "s:1:1", thumb("B"));
		expect(timers.delays()).toEqual([2000]);
		expect(scopeFiles()).not.toContain(THUMBS_MANIFEST);
		c.close();
		expect(timers.size).toBe(0);
		expect(scopeFiles()).toContain(THUMBS_MANIFEST);
		expect((await cache().stats()).count).toBe(2);
	});
});

describe("last access and the size cap (LRU)", () => {
	/** Ten 10-byte thumbnails written one second apart: k0 oldest. */
	async function tenThumbs(c: ThumbnailCache): Promise<void> {
		for (let i = 0; i < 10; i++) {
			clock.now += 1000;
			await c.put(i % 2 === 0 ? SCOPE : OTHER_SCOPE, `k${i}.png`, "s:1:1", thumb(`thumb-000${i}`));
		}
	}

	it("a view moves the last access time (coarsely) and it is persisted in the manifest", async () => {
		const c = cache();
		await c.put(SCOPE, "a.png", "s:1:1", thumb("A"));
		const written = clock.now;
		await c.flush();
		expect(manifest()["a.png"].atime).toBe(written);

		clock.now += TOUCH_RESOLUTION_MS - 1;
		await c.read(SCOPE, small("a.png"));
		await c.flush();
		expect(manifest()["a.png"].atime).toBe(written);

		clock.now += 1;
		await c.read(SCOPE, small("a.png"));
		await c.flush();
		expect(manifest()["a.png"].atime).toBe(clock.now);

		// A miss (stale fingerprint) is not a view.
		const before = clock.now;
		clock.now += 10 * TOUCH_RESOLUTION_MS;
		await c.read(SCOPE, obj("a.png", { size: 999 }));
		await c.flush();
		expect(manifest()["a.png"].atime).toBe(before);
	});

	it("under the cap nothing is evicted", async () => {
		const c = cache();
		await tenThumbs(c);
		expect(await c.enforceCap(100)).toEqual({ evicted: 0, bytes: 100 });
		expect((await c.stats()).count).toBe(10);
	});

	it("over the cap evicts least recently viewed first, across scopes, down to 90%", async () => {
		const c = cache();
		await tenThumbs(c);
		// k0 and k1 are viewed again: now the most recent.
		clock.now += TOUCH_RESOLUTION_MS;
		await c.read(SCOPE, small("k0.png"));
		await c.read(OTHER_SCOPE, small("k1.png"));

		// 100 bytes > 95: trimmed to <= 85 (two evicted: k2 and k3).
		expect(await c.enforceCap(95)).toEqual({ evicted: 2, bytes: 80 });
		const left = async (key: string, scope: string) => (await c.read(scope, small(key))) !== null;
		expect(await left("k2.png", SCOPE)).toBe(false);
		expect(await left("k3.png", OTHER_SCOPE)).toBe(false);
		expect(await left("k0.png", SCOPE)).toBe(true);
		expect(await left("k1.png", OTHER_SCOPE)).toBe(true);
		expect(await left("k4.png", SCOPE)).toBe(true);
		await c.flush();
		expect(scopeFiles().length + scopeFiles(OTHER_SCOPE).length).toBe(8 + 2);
	});

	it("the order survives a restart (last access read back from the manifest)", async () => {
		const c = cache();
		await tenThumbs(c);
		clock.now += TOUCH_RESOLUTION_MS;
		await c.read(SCOPE, small("k0.png"));
		await c.flush();
		c.close();

		const reopened = cache();
		expect((await reopened.enforceCap(50)).evicted).toBe(6);
		const kept: string[] = [];
		for (let i = 0; i < 10; i++) {
			if (await reopened.read(i % 2 === 0 ? SCOPE : OTHER_SCOPE, small(`k${i}.png`))) {
				kept.push(`k${i}`);
			}
		}
		expect(kept).toEqual(["k0", "k7", "k8", "k9"]);
	});

	it("entries without a last access time go first", async () => {
		const c = cache();
		await c.put(SCOPE, "new.png", "s:1:1", thumb("0123456789"));
		await c.put(SCOPE, "old.png", "s:1:1", thumb("0123456789"));
		await c.flush();
		c.close();
		const file = path.join(thumbsDir, SCOPE, THUMBS_MANIFEST);
		const data = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Record<string, { atime?: number }> };
		delete data.entries["old.png"].atime;
		fs.writeFileSync(file, JSON.stringify(data));

		const reopened = cache();
		expect((await reopened.enforceCap(15)).evicted).toBe(1);
		expect(await reopened.read(SCOPE, small("old.png"))).toBeNull();
		expect(await reopened.read(SCOPE, small("new.png"))).not.toBeNull();
	});
});

describe("Clear thumbnails vs Clear index", () => {
	function write(rel: string, data = "x"): void {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, data);
	}

	it("clear() deletes only thumbnail files, keeps indexes, unknown files and other vaults", async () => {
		const c = cache();
		await c.put(SCOPE, "a.png", "s:1:1", thumb("A"));
		await c.put(OTHER_SCOPE, "b.png", "s:1:1", thumb("B"));
		await c.flush();
		write(`indexes/vault1/${SCOPE}/meta.json`);
		write(`indexes/vault1/${SCOPE}/vectors.bin`);
		write(`thumbs/vault1/${OTHER_SCOPE}/mine.txt`);
		write(`thumbs/vault1/not a scope/${thumbnailFileName("x", "y", "webp")}`);
		write(`thumbs/vault2/${SCOPE}/${THUMBS_MANIFEST}`);

		const r = await c.clear();
		expect(r).toEqual({ deleted: 4, failed: [], kept: 2 });
		expect(fs.existsSync(path.join(thumbsDir, SCOPE))).toBe(false);
		expect(fs.existsSync(path.join(thumbsDir, OTHER_SCOPE, "mine.txt"))).toBe(true);
		expect(fs.existsSync(path.join(thumbsDir, "not a scope"))).toBe(true);
		expect(fs.existsSync(path.join(root, "indexes", "vault1", SCOPE, "meta.json"))).toBe(true);
		expect(fs.existsSync(path.join(root, "indexes", "vault1", SCOPE, "vectors.bin"))).toBe(true);
		expect(fs.existsSync(path.join(root, "thumbs", "vault2", SCOPE, THUMBS_MANIFEST))).toBe(true);
		expect(await c.stats()).toEqual({ count: 0, bytes: 0 });
		// Usable again afterwards.
		await c.put(SCOPE, "c.png", "s:1:1", thumb("C"));
		expect(await readText(c, small("c.png"))).toBe("C");
	});

	it("clear() removes the emptied vault directory, never the thumbs root", async () => {
		const c = cache();
		await c.put(SCOPE, "a.png", "s:1:1", thumb("A"));
		await c.flush();
		await c.clear();
		expect(fs.existsSync(thumbsDir)).toBe(false);
		expect(fs.existsSync(path.join(root, THUMBS_DIR_NAME))).toBe(true);
	});

	it("a put queued before clear() writes nothing afterwards", async () => {
		const c = cache();
		const pending = c.put(SCOPE, "a.png", "s:1:1", thumb("A"));
		const cleared = c.clear();
		await pending;
		await cleared;
		await c.flush();
		expect(await cache().stats()).toEqual({ count: 0, bytes: 0 });
	});

	it("Clear index leaves thumbnails alone, even when the index directory is the thumbs root", async () => {
		const c = cache();
		await c.put(SCOPE, "a.png", "s:1:1", thumb("A"));
		await c.flush();
		write(`indexes/vault1/${SCOPE}/meta.json`);
		write(`indexes/vault1/${SCOPE}/status.json`);
		const r = clearVaultIndex(path.join(root, "indexes"), "vault1");
		expect(r.deleted).toBe(2);
		expect(await readText(cache(), small("a.png"))).toBe("A");

		// semantic.indexDir pointed at <appDir>/thumbs: same scope directories.
		write(`thumbs/vault1/${SCOPE}/meta.json`);
		const shared = clearVaultIndex(path.join(root, THUMBS_DIR_NAME), "vault1");
		expect(shared.deleted).toBe(1);
		expect(await readText(cache(), small("a.png"))).toBe("A");
		write(`thumbs/vault1/${SCOPE}/vectors.bin`);
		await cache().clear();
		expect(fs.existsSync(path.join(thumbsDir, SCOPE, "vectors.bin"))).toBe(true);
	});

	it("clearThumbnailDir is a no-op for a missing directory and leaves a symlinked one alone", async () => {
		expect(await clearThumbnailDir(path.join(root, "nope"), nodeThumbFs)).toEqual({ deleted: 0, failed: [], kept: 0 });
		const target = path.join(root, "elsewhere");
		fs.mkdirSync(path.join(target, SCOPE), { recursive: true });
		fs.writeFileSync(path.join(target, SCOPE, THUMBS_MANIFEST), "{}");
		fs.mkdirSync(path.dirname(thumbsDir), { recursive: true });
		let linked = true;
		try {
			fs.symlinkSync(target, thumbsDir, "junction");
		} catch {
			linked = false;
		}
		if (linked) {
			expect((await clearThumbnailDir(thumbsDir, nodeThumbFs)).kept).toBe(1);
			expect(fs.existsSync(path.join(target, SCOPE, THUMBS_MANIFEST))).toBe(true);
		}
	});
});
