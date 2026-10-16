/**
 * Local gallery thumbnail cache (docs/semantic-search.md §13). Layout and
 * file names: thumbnailFiles.ts.
 *
 * thumbs.json maps object key -> { fp, ext, bytes, atime }. A thumbnail is
 * used only while the listed object still has that fingerprint (or the
 * provisional upload fingerprint matches it). `atime` is the last time it
 * was written or shown (kept in memory, persisted with the debounced
 * manifest write); `enforceCap` evicts the least recently viewed thumbnails
 * of all scopes of the vault once their total size exceeds the cap.
 *
 * Files are written as `<name>.tmp` and renamed; the manifest is rewritten
 * (tmp + rename) after a debounce. On first use of a scope, thumbnail files
 * the manifest does not reference (a crash between file and manifest write)
 * and leftover tmp files are deleted, and entries whose file is gone are
 * dropped.
 *
 * Everything is async and serialized per scope; no method rejects (errors
 * are logged, thumbnails are a cache). Only file names this module writes
 * are ever deleted. Never imports src/semantic (semantic indexing writes
 * through `put`).
 */
import * as path from "path";
import type { OssImage } from "../types/oss";
import { isUploadFingerprint, fingerprint, matchesUploadFingerprint } from "../utils/objectScope";
import type { Timers } from "../utils/timers";
import { SAFE_ID } from "../utils/vaultId";
import type { EncodedThumbnail, ThumbnailMime } from "./encode";
import {
	clearThumbnailDir,
	extForMime,
	MANIFEST_TMP,
	mimeForExt,
	nodeThumbFs,
	THUMB_FILE,
	THUMB_TMP,
	ThumbFs,
	ThumbnailClearResult,
	ThumbnailExt,
	thumbnailFileName,
	thumbnailMatches,
	THUMBS_MANIFEST,
} from "./thumbnailFiles";

const MANIFEST_FORMAT = 1;
export const DEFAULT_THUMBS_FLUSH_DELAY_MS = 2000;
/** A view moves `atime` (and dirties the manifest) at most this often per thumbnail. */
export const TOUCH_RESOLUTION_MS = 60_000;
/** Eviction goes down to this fraction of the cap, so it does not run after every write. */
export const EVICT_TO_FRACTION = 0.9;

export interface ThumbnailEntry {
	/** Fingerprint of the object the thumbnail was made from. */
	fp: string;
	ext: ThumbnailExt;
	/** File size. */
	bytes: number;
	/** Last write or view (ms since epoch); 0 = unknown (evicted first). */
	atime: number;
}

export interface ThumbnailCacheOptions {
	fs?: ThumbFs;
	timers?: Timers;
	now?: () => number;
	/** Manifest write debounce; 0 = write after every change. */
	flushDelayMs?: number;
}

export interface ThumbnailStats {
	count: number;
	bytes: number;
}

export interface EvictionResult {
	evicted: number;
	/** Total size after eviction. */
	bytes: number;
}

/** A thumbnail read back for display. */
export interface CachedThumbnail {
	bytes: Uint8Array<ArrayBuffer>;
	mime: ThumbnailMime;
}

/**
 * What semantic indexing may use (its only way in). `put(…, null)` = no
 * thumbnail this time: drops one of another fingerprint. Never rejects.
 */
export interface ThumbnailWriter {
	put(scopeId: string, key: string, fp: string, thumbnail: EncodedThumbnail | null): Promise<void>;
}

interface ManifestFile {
	format: number;
	entries: Record<string, ThumbnailEntry>;
}

interface ScopeThumbs {
	dir: string;
	entries: Map<string, ThumbnailEntry>;
	loaded: Promise<void> | null;
	/** Serializes writes of this scope. */
	chain: Promise<void>;
	dirty: boolean;
	timer: number | null;
}

function parseEntry(v: unknown): ThumbnailEntry | null {
	if (typeof v !== "object" || v === null) {
		return null;
	}
	const r = v as Record<string, unknown>;
	if (typeof r.fp !== "string" || (r.ext !== "webp" && r.ext !== "jpg") || typeof r.bytes !== "number" || !(r.bytes >= 0)) {
		return null;
	}
	const atime = typeof r.atime === "number" && Number.isFinite(r.atime) && r.atime > 0 ? r.atime : 0;
	return { fp: r.fp, ext: r.ext, bytes: r.bytes, atime };
}

function isMissing(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "ENOENT";
}

export class ThumbnailCache implements ThumbnailWriter {
	private readonly fs: ThumbFs;
	private readonly scopes = new Map<string, ScopeThumbs>();
	/** Bumped by clear()/close(): operations queued before give up. */
	private generation = 0;
	/** A clear() in progress: new operations wait for it. */
	private clearing: Promise<void> | null = null;
	/** A running enforceCap (calls meanwhile share it). */
	private evicting: Promise<EvictionResult> | null = null;

	/** `rootDir`: <appDir>/thumbs/<vaultId>, or null when unusable. */
	constructor(private readonly rootDir: () => string | null, private readonly options: ThumbnailCacheOptions = {}) {
		this.fs = options.fs ?? nodeThumbFs;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private scopeDir(scopeId: string): string | null {
		if (!SAFE_ID.test(scopeId)) {
			return null;
		}
		const root = this.rootDir();
		return root ? path.join(root, scopeId) : null;
	}

	private scope(dir: string): ScopeThumbs {
		let s = this.scopes.get(dir);
		if (!s) {
			s = { dir, entries: new Map(), loaded: null, chain: Promise.resolve(), dirty: false, timer: null };
			this.scopes.set(dir, s);
		}
		return s;
	}

	/** Load the manifest once and tidy the directory (orphans, tmp files, missing files). */
	private ensureLoaded(s: ScopeThumbs): Promise<void> {
		s.loaded ??= this.load(s).catch((error) => {
			console.error("OSS Gallery: reading local thumbnails failed", error);
		});
		return s.loaded;
	}

	private async load(s: ScopeThumbs): Promise<void> {
		try {
			const raw = new TextDecoder().decode(await this.fs.readFile(path.join(s.dir, THUMBS_MANIFEST)));
			const parsed = JSON.parse(raw) as Partial<ManifestFile>;
			if (parsed?.format === MANIFEST_FORMAT && typeof parsed.entries === "object" && parsed.entries !== null) {
				for (const [key, value] of Object.entries(parsed.entries)) {
					const entry = parseEntry(value);
					if (entry) {
						s.entries.set(key, entry);
					}
				}
			}
		} catch {
			// Missing or unreadable manifest: start empty (thumbnails are a cache).
		}
		let names: string[];
		try {
			names = await this.fs.readdir(s.dir);
		} catch {
			names = [];
		}
		const present = new Set(names);
		const referenced = new Set<string>();
		for (const [key, entry] of [...s.entries]) {
			const name = thumbnailFileName(key, entry.fp, entry.ext);
			if (present.has(name)) {
				referenced.add(name);
			} else {
				s.entries.delete(key);
				s.dirty = true;
			}
		}
		for (const name of names) {
			if (referenced.has(name) || !(THUMB_FILE.test(name) || THUMB_TMP.test(name) || name === MANIFEST_TMP)) {
				continue;
			}
			const file = path.join(s.dir, name);
			try {
				if ((await this.fs.lstat(file)).isFile()) {
					await this.fs.unlink(file);
				}
			} catch {
				// Gone already or locked: tried again next session.
			}
		}
		if (s.dirty) {
			this.scheduleFlush(s);
		}
	}

	/**
	 * Run a write operation for `scopeId` after the scope's earlier ones.
	 * Skipped when a clear()/close() happened meanwhile. Never rejects.
	 */
	private run(scopeId: string, what: string, op: (s: ScopeThumbs) => Promise<void>): Promise<void> {
		const dir = this.scopeDir(scopeId);
		if (!dir) {
			return Promise.resolve();
		}
		const s = this.scope(dir);
		const generation = this.generation;
		const task = s.chain.then(async () => {
			// Queued before a clear()/close(): skip (clear() waits for these).
			if (generation !== this.generation) {
				return;
			}
			if (this.clearing) {
				await this.clearing;
			}
			if (generation !== this.generation) {
				return;
			}
			await this.ensureLoaded(s);
			if (generation !== this.generation) {
				return;
			}
			await op(s);
		}).catch((error) => {
			console.error(`OSS Gallery: ${what} failed`, error);
		});
		s.chain = task;
		return task;
	}

	put(scopeId: string, key: string, fp: string, thumbnail: EncodedThumbnail | null): Promise<void> {
		return this.run(scopeId, "saving a local thumbnail", async (s) => {
			const old = s.entries.get(key);
			if (!thumbnail) {
				if (old && old.fp !== fp) {
					await this.dropEntry(s, key, old);
				}
				return;
			}
			const ext = extForMime(thumbnail.mime);
			const name = thumbnailFileName(key, fp, ext);
			const file = path.join(s.dir, name);
			const tmp = `${file}.tmp`;
			await this.fs.mkdir(s.dir, { recursive: true });
			await this.fs.writeFile(tmp, new Uint8Array(thumbnail.bytes));
			await this.fs.rename(tmp, file);
			s.entries.set(key, { fp, ext, bytes: thumbnail.bytes.byteLength, atime: this.now() });
			this.changed(s);
			if (old) {
				const oldName = thumbnailFileName(key, old.fp, old.ext);
				if (oldName !== name) {
					await this.unlinkQuietly(path.join(s.dir, oldName));
				}
			}
		});
	}

	remove(scopeId: string, key: string): Promise<void> {
		return this.run(scopeId, "removing a local thumbnail", async (s) => {
			const old = s.entries.get(key);
			if (old) {
				await this.dropEntry(s, key, old);
			}
		});
	}

	/**
	 * A listing of this scope: thumbnails stored under a provisional upload
	 * fingerprint adopt the listed one when it matches. Complete listings
	 * (`prune`) also delete thumbnails of keys under `prefix` that are not
	 * listed, unless written or shown at or after `since` (an upload the
	 * listing may not show yet). Never rejects.
	 */
	reconcile(scopeId: string, items: readonly OssImage[], prune: { prefix: string; since: number } | null): Promise<void> {
		return this.run(scopeId, "updating local thumbnails", async (s) => {
			const listed = new Map<string, OssImage>();
			for (const obj of items) {
				listed.set(obj.key, obj);
			}
			for (const [key, entry] of [...s.entries]) {
				const obj = listed.get(key);
				if (obj) {
					if (isUploadFingerprint(entry.fp) && matchesUploadFingerprint(entry.fp, obj)) {
						await this.adoptInScope(s, key, entry, fingerprint(obj));
					}
					continue;
				}
				if (prune && key.startsWith(prune.prefix) && entry.atime < prune.since && s.entries.get(key) === entry) {
					await this.dropEntry(s, key, entry);
				}
			}
		});
	}

	private async adoptInScope(s: ScopeThumbs, key: string, entry: ThumbnailEntry, toFp: string): Promise<void> {
		if (entry.fp === toFp || s.entries.get(key) !== entry) {
			return;
		}
		const from = path.join(s.dir, thumbnailFileName(key, entry.fp, entry.ext));
		const to = path.join(s.dir, thumbnailFileName(key, toFp, entry.ext));
		try {
			await this.fs.rename(from, to);
		} catch (error) {
			if (isMissing(error)) {
				s.entries.delete(key);
				this.changed(s);
				return;
			}
			throw error;
		}
		s.entries.set(key, { ...entry, fp: toFp });
		this.changed(s);
	}

	private async dropEntry(s: ScopeThumbs, key: string, entry: ThumbnailEntry): Promise<void> {
		s.entries.delete(key);
		this.changed(s);
		await this.unlinkQuietly(path.join(s.dir, thumbnailFileName(key, entry.fp, entry.ext)));
	}

	private async unlinkQuietly(file: string): Promise<void> {
		try {
			await this.fs.unlink(file);
		} catch (error) {
			if (!isMissing(error)) {
				// Left behind: the next load removes it as an orphan.
				console.warn("OSS Gallery: deleting a local thumbnail failed", error);
			}
		}
	}

	/**
	 * The thumbnail of a listed object, or null (none, stale fingerprint,
	 * unreadable). A hit counts as a view (LRU). Reads do not wait for
	 * queued writes. Never rejects.
	 */
	async read(scopeId: string, obj: OssImage): Promise<CachedThumbnail | null> {
		const dir = this.scopeDir(scopeId);
		if (!dir || this.clearing) {
			return null;
		}
		const s = this.scope(dir);
		await this.ensureLoaded(s);
		const entry = s.entries.get(obj.key);
		if (!entry || !thumbnailMatches(entry.fp, obj)) {
			return null;
		}
		try {
			const bytes = await this.fs.readFile(path.join(s.dir, thumbnailFileName(obj.key, entry.fp, entry.ext)));
			if (bytes.byteLength === 0) {
				return null;
			}
			// Own ArrayBuffer (a Blob part; Node buffers may be views of a shared pool).
			const copy = new Uint8Array(bytes.byteLength);
			copy.set(bytes);
			this.touch(s, entry);
			return { bytes: copy, mime: mimeForExt(entry.ext) };
		} catch (error) {
			if (isMissing(error) && s.entries.get(obj.key) === entry) {
				// Deleted behind our back: forget it (through the write queue).
				void this.run(scopeId, "forgetting a local thumbnail", async (cur) => {
					if (cur.entries.get(obj.key) === entry) {
						cur.entries.delete(obj.key);
						this.changed(cur);
					}
				});
			}
			return null;
		}
	}

	/** Record a view; the manifest write is debounced like any other change. */
	private touch(s: ScopeThumbs, entry: ThumbnailEntry): void {
		const now = this.now();
		if (now - entry.atime < TOUCH_RESOLUTION_MS || this.scopes.get(s.dir) !== s) {
			return;
		}
		entry.atime = now;
		this.changed(s);
	}

	/** Every scope directory of the vault on disk, loaded. */
	private async allScopes(): Promise<Array<{ scopeId: string; s: ScopeThumbs }>> {
		const root = this.rootDir();
		if (!root) {
			return [];
		}
		let names: string[];
		try {
			names = await this.fs.readdir(root);
		} catch {
			return [];
		}
		const out: Array<{ scopeId: string; s: ScopeThumbs }> = [];
		for (const name of names) {
			if (!SAFE_ID.test(name)) {
				continue;
			}
			const s = this.scope(path.join(root, name));
			await this.ensureLoaded(s);
			out.push({ scopeId: name, s });
		}
		return out;
	}

	/** Count and size of this vault's thumbnails (all scopes on disk). Never rejects. */
	async stats(): Promise<ThumbnailStats> {
		const out: ThumbnailStats = { count: 0, bytes: 0 };
		try {
			for (const { s } of await this.allScopes()) {
				for (const entry of s.entries.values()) {
					out.count++;
					out.bytes += entry.bytes;
				}
			}
		} catch (error) {
			console.error("OSS Gallery: counting local thumbnails failed", error);
		}
		return out;
	}

	/**
	 * Size cap over all scopes of the vault: when the thumbnails take more
	 * than `maxBytes`, delete the least recently viewed ones until they take
	 * at most EVICT_TO_FRACTION of it. Background work; never rejects.
	 */
	enforceCap(maxBytes: number): Promise<EvictionResult> {
		this.evicting ??= this.evict(maxBytes)
			.catch((error) => {
				console.error("OSS Gallery: trimming local thumbnails failed", error);
				return { evicted: 0, bytes: 0 };
			})
			.finally(() => {
				this.evicting = null;
			});
		return this.evicting;
	}

	private async evict(maxBytes: number): Promise<EvictionResult> {
		if (!(maxBytes > 0) || this.clearing) {
			return { evicted: 0, bytes: 0 };
		}
		const candidates: Array<{ scopeId: string; key: string; entry: ThumbnailEntry; atime: number }> = [];
		let total = 0;
		for (const { scopeId, s } of await this.allScopes()) {
			for (const [key, entry] of s.entries) {
				candidates.push({ scopeId, key, entry, atime: entry.atime });
				total += entry.bytes;
			}
		}
		if (total <= maxBytes) {
			return { evicted: 0, bytes: total };
		}
		const target = Math.floor(maxBytes * EVICT_TO_FRACTION);
		candidates.sort((a, b) => a.atime - b.atime);
		let evicted = 0;
		for (const c of candidates) {
			if (total <= target) {
				break;
			}
			let dropped = false;
			await this.run(c.scopeId, "trimming local thumbnails", async (s) => {
				// Replaced or viewed again meanwhile: keep it.
				if (s.entries.get(c.key) === c.entry && c.entry.atime === c.atime) {
					await this.dropEntry(s, c.key, c.entry);
					dropped = true;
				}
			});
			if (dropped) {
				total -= c.entry.bytes;
				evicted++;
			}
		}
		return { evicted, bytes: total };
	}

	private changed(s: ScopeThumbs): void {
		s.dirty = true;
		this.scheduleFlush(s);
	}

	private timers(): Timers {
		return this.options.timers ?? {
			setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
			clearTimeout: (id: number) => window.clearTimeout(id),
		};
	}

	private scheduleFlush(s: ScopeThumbs): void {
		const delay = this.options.flushDelayMs ?? DEFAULT_THUMBS_FLUSH_DELAY_MS;
		if (delay <= 0) {
			// Written by the queue right after the current operation.
			this.queueManifestWrite(s);
			return;
		}
		if (s.timer !== null) {
			return;
		}
		s.timer = this.timers().setTimeout(() => {
			s.timer = null;
			this.queueManifestWrite(s);
		}, delay);
	}

	private queueManifestWrite(s: ScopeThumbs): void {
		const generation = this.generation;
		s.chain = s.chain.then(async () => {
			if (generation === this.generation && this.scopes.get(s.dir) === s) {
				await this.writeManifest(s);
			}
		}).catch((error) => {
			console.error("OSS Gallery: writing the local thumbnail list failed", error);
		});
	}

	private manifestJson(s: ScopeThumbs): string {
		const data: ManifestFile = { format: MANIFEST_FORMAT, entries: Object.fromEntries(s.entries) };
		return JSON.stringify(data);
	}

	private async writeManifest(s: ScopeThumbs): Promise<void> {
		if (!s.dirty) {
			return;
		}
		s.dirty = false;
		const file = path.join(s.dir, THUMBS_MANIFEST);
		try {
			await this.fs.mkdir(s.dir, { recursive: true });
			await this.fs.writeFile(`${file}.tmp`, this.manifestJson(s));
			await this.fs.rename(`${file}.tmp`, file);
		} catch (error) {
			s.dirty = true;
			throw error;
		}
	}

	/** Write every pending manifest now and wait for queued operations (tests, settings). */
	async flush(): Promise<void> {
		for (const s of [...this.scopes.values()]) {
			// Operations append manifest writes while they run: wait until the
			// queue is quiet (bounded, a failing write stays dirty).
			for (let round = 0; round < 5; round++) {
				if (s.timer !== null) {
					this.timers().clearTimeout(s.timer);
					s.timer = null;
				}
				if (s.dirty) {
					this.queueManifestWrite(s);
				}
				const chain = s.chain;
				await chain;
				if (chain === s.chain && s.timer === null && !s.dirty) {
					break;
				}
			}
		}
	}

	/**
	 * Unload: write pending manifests synchronously, drop queued operations
	 * and forget all cached state.
	 */
	close(): void {
		this.generation++;
		for (const s of this.scopes.values()) {
			if (s.timer !== null) {
				this.timers().clearTimeout(s.timer);
				s.timer = null;
			}
			if (!s.dirty) {
				continue;
			}
			try {
				const file = path.join(s.dir, THUMBS_MANIFEST);
				this.fs.mkdirSync(s.dir, { recursive: true });
				this.fs.writeFileSync(`${file}.tmp`, this.manifestJson(s));
				this.fs.renameSync(`${file}.tmp`, file);
				s.dirty = false;
			} catch (error) {
				console.error("OSS Gallery: writing the local thumbnail list failed", error);
			}
		}
		this.scopes.clear();
	}

	/**
	 * "Clear thumbnails": delete this vault's thumbnail files (only names this
	 * module writes) and the directories that became empty. Never touches the
	 * semantic index, the model or other vaults. Resolves null when the
	 * thumbnail directory is unusable.
	 */
	async clear(): Promise<ThumbnailClearResult | null> {
		const root = this.rootDir();
		if (!root) {
			return null;
		}
		while (this.clearing) {
			await this.clearing;
		}
		this.generation++;
		let release!: () => void;
		this.clearing = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const pending = [...this.scopes.values()];
			for (const s of pending) {
				if (s.timer !== null) {
					this.timers().clearTimeout(s.timer);
					s.timer = null;
				}
			}
			// Let operations already running finish (they skip their rest).
			await Promise.all(pending.map((s) => s.chain));
			this.scopes.clear();
			return await clearThumbnailDir(root, this.fs);
		} finally {
			this.clearing = null;
			release();
		}
	}
}
