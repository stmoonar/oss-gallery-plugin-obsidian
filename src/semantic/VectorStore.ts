/**
 * Per-scope vector index on disk (docs/semantic-search.md §4.4, §5).
 *
 *   <vault>/<manifest.dir>/semantic-index/<scopeId>/meta.json
 *   <vault>/<manifest.dir>/semantic-index/<scopeId>/vectors.bin
 *
 * vectors.bin: headerless, slot i at byte i * dims * 4, little-endian
 * float32. Append-only: an update writes a new slot and frees the old one;
 * compaction rewrites the file when more than 30 % of the slots are holes.
 * meta.json is the commit point: new slots are appended and fsynced first,
 * then meta.json is replaced atomically (write .tmp, fsync, rename).
 *
 * Every entry stores an FNV-1a checksum of its slot, so on open each entry is
 * validated individually: a slot past the end of the file (truncated file,
 * mixed versions from a sync conflict) or with the wrong bytes drops only
 * that entry; the caller re-embeds it. A header mismatch (model, revision,
 * dtype, dims, token budget, preprocessing) resets the whole store.
 *
 * I/O uses Node's synchronous fs on the absolute path (desktop-only plugin):
 * positional writes, fsync and rename-over are not in Obsidian's DataAdapter,
 * the sync calls make flush-on-unload reliable, and writes are small (new
 * slots + meta; a full 10k-image file is ~10 MB, written only by compaction).
 */
import * as nodeFs from "fs";
import * as path from "path";
import { fnv1a } from "./EmbeddingBackend";
import type { EmbeddingConfig } from "./protocol";
import type { Timers } from "./WorkerEmbeddingBackend";

export const META_FILE = "meta.json";
export const VECTORS_FILE = "vectors.bin";
export const STORE_FORMAT = 1;
const TMP = ".tmp";
/** Private meta tmp file of an async flush: meta.json.a<N>.tmp. */
export const ASYNC_META_TMP = /^meta\.json\.a\d+\.tmp$/;
/** Compact when holes / slots exceeds this. */
export const COMPACTION_THRESHOLD = 0.3;
export const DEFAULT_FLUSH_DELAY_MS = 2000;

export interface IndexHeader {
	modelId: string;
	revision: string;
	dtype: string;
	dims: number;
	imageTokenBudget: number;
	preprocessVersion: number;
}

export function headerFromConfig(cfg: EmbeddingConfig): IndexHeader {
	return {
		modelId: cfg.modelId,
		revision: cfg.revision,
		dtype: cfg.dtype,
		dims: cfg.dims,
		imageTokenBudget: cfg.imageTokenBudget,
		preprocessVersion: cfg.preprocessVersion,
	};
}

const HEADER_FIELDS: Array<keyof IndexHeader> = [
	"modelId",
	"revision",
	"dtype",
	"dims",
	"imageTokenBudget",
	"preprocessVersion",
];

export function sameHeader(a: unknown, b: IndexHeader): boolean {
	if (typeof a !== "object" || a === null) {
		return false;
	}
	const rec = a as Record<string, unknown>;
	return HEADER_FIELDS.every((f) => rec[f] === b[f]);
}

/** Scope and vault ids are used as directory names. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Absolute index directory of a scope: <indexRoot>/<vaultId>/<scopeId>
 * (indexRoot = the per-device `semantic.indexDir`, outside the vault).
 */
export function scopeIndexDir(indexRoot: string, vaultId: string, scopeId: string): string {
	if (!SAFE_ID.test(vaultId)) {
		throw new Error(`Invalid vault id: ${vaultId}`);
	}
	if (!SAFE_ID.test(scopeId)) {
		throw new Error(`Invalid scope id: ${scopeId}`);
	}
	return path.join(indexRoot, vaultId, scopeId);
}

/** Synchronous fs subset used by the store (Node's `fs` satisfies it; tests inject failures). */
export interface StoreFs {
	existsSync(p: string): boolean;
	mkdirSync(p: string, options: { recursive: true }): unknown;
	readFileSync(p: string): Buffer;
	statSync(p: string): { size: number };
	openSync(p: string, flags: string): number;
	writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
	fsyncSync(fd: number): void;
	ftruncateSync(fd: number, len: number): void;
	closeSync(fd: number): void;
	renameSync(from: string, to: string): void;
	unlinkSync(p: string): void;
}

export interface StoredEntry {
	fp: string;
	vec: Float32Array;
	missingSince?: number;
	missCount?: number;
}

interface Entry {
	fp: string;
	slot: number;
	/** FNV-1a of the slot bytes. */
	h: number;
	missingSince?: number;
	missCount?: number;
}

interface MetaFile {
	format: number;
	header: IndexHeader;
	slotCount: number;
	entries: Record<string, Entry>;
	freeSlots: number[];
}

export type OpenStatus =
	/** No index yet. */
	| "created"
	| "loaded"
	/** Discarded: header mismatch or unreadable meta. Caller reindexes. */
	| "reset"
	/** Loaded after dropping inconsistent entries / trimming the file. */
	| "repaired";

export interface OpenResult {
	status: OpenStatus;
	reason?: "header-mismatch" | "corrupt-meta";
	/** Entries dropped by repair (to be re-embedded). */
	dropped: number;
	/** An interrupted flush/compaction was rolled forward or back. */
	recoveredTmp: boolean;
}

export interface VectorStoreOptions {
	fs?: StoreFs;
	timers?: Timers;
	/** Debounce for automatic flushes after changes; 0 disables auto flush. */
	flushDelayMs?: number;
	/** Called when an automatic flush fails. */
	onFlushError?: (error: unknown) => void;
	/**
	 * Automatic and flush() writes use async fs (the main thread only builds
	 * the snapshot and renames meta.json), so a 10k-entry index does not stall
	 * the UI while indexing. flushSync/close/compaction stay synchronous.
	 * Ignored when `fs` is injected without `asyncFs`.
	 */
	asyncIo?: boolean;
	/** Async fs used with `asyncIo` (default: Node's fs.promises). */
	asyncFs?: StoreAsyncFs;
}

/** Async fs subset for asyncIo flushes. */
export interface StoreAsyncFs {
	mkdir(p: string, options: { recursive: true }): Promise<unknown>;
	open(p: string, flags: string): Promise<{
		write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
		sync(): Promise<void>;
		close(): Promise<void>;
	}>;
	unlink(p: string): Promise<void>;
}

/** Key data without the vector. */
export interface EntryInfo {
	fp: string;
	missingSince?: number;
	missCount?: number;
}

export interface SearchHit {
	key: string;
	score: number;
}

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function isValidEntry(e: unknown): e is Entry {
	if (typeof e !== "object" || e === null) {
		return false;
	}
	const r = e as Record<string, unknown>;
	return typeof r.fp === "string"
		&& Number.isInteger(r.slot) && (r.slot as number) >= 0
		&& Number.isInteger(r.h)
		&& (r.missingSince === undefined || typeof r.missingSince === "number")
		&& (r.missCount === undefined || typeof r.missCount === "number");
}

export class VectorStore {
	private readonly fs: StoreFs;
	private readonly dims: number;
	private readonly slotBytes: number;
	private readonly metaPath: string;
	private readonly vecPath: string;
	private entries = new Map<string, Entry>();
	private data: Float32Array;
	/** Slots in use in memory (committed + pending appends). */
	private slotCount = 0;
	/** Slots present in vectors.bin and referenced by meta.json. */
	private committedSlots = 0;
	private free = new Set<number>();
	private dirty = false;
	private flushTimer: number | null = null;
	private closed = false;
	/** Bumped by every change; an async flush only clears `dirty` if unchanged. */
	private changeVersion = 0;
	/**
	 * Bumped by every synchronous write of meta.json / vectors.bin layout
	 * (flushSync, compaction, clear, close). An async flush that started
	 * before discards its result instead of renaming an older meta over it.
	 */
	private writeGeneration = 0;
	private asyncFlush: Promise<void> | null = null;
	private asyncFlushAgain = false;
	private tmpCounter = 0;
	openResult: OpenResult = { status: "created", dropped: 0, recoveredTmp: false };

	private constructor(
		readonly dir: string,
		readonly header: IndexHeader,
		private readonly options: VectorStoreOptions
	) {
		if (!IS_LITTLE_ENDIAN) {
			throw new Error("VectorStore requires a little-endian platform");
		}
		if (!Number.isInteger(header.dims) || header.dims <= 0) {
			throw new Error(`Invalid dims ${header.dims}`);
		}
		this.fs = options.fs ?? nodeFs;
		this.dims = header.dims;
		this.slotBytes = header.dims * 4;
		this.metaPath = path.join(dir, META_FILE);
		this.vecPath = path.join(dir, VECTORS_FILE);
		this.data = new Float32Array(this.dims * 64);
	}

	/**
	 * Open (or create) the store in `dir`. A store written for another header
	 * is discarded (status "reset"); inconsistent entries are dropped
	 * ("repaired"). Never throws for bad on-disk data, only for I/O errors.
	 */
	static open(dir: string, header: IndexHeader, options: VectorStoreOptions = {}): VectorStore {
		const store = new VectorStore(dir, { ...header }, options);
		store.load();
		return store;
	}

	// ---- reading -----------------------------------------------------------

	get size(): number {
		return this.entries.size;
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	keys(): string[] {
		return [...this.entries.keys()];
	}

	get(key: string): StoredEntry | undefined {
		const e = this.entries.get(key);
		if (!e) {
			return undefined;
		}
		const out: StoredEntry = { fp: e.fp, vec: this.slotView(e.slot).slice() };
		if (e.missingSince !== undefined) {
			out.missingSince = e.missingSince;
			out.missCount = e.missCount;
		}
		return out;
	}

	/** Fingerprint and tombstone state without copying the vector. */
	peek(key: string): EntryInfo | undefined {
		const e = this.entries.get(key);
		if (!e) {
			return undefined;
		}
		const out: EntryInfo = { fp: e.fp };
		if (e.missingSince !== undefined) {
			out.missingSince = e.missingSince;
			out.missCount = e.missCount;
		}
		return out;
	}

	/** Number of entries not tombstoned. */
	visibleCount(): number {
		let n = 0;
		for (const e of this.entries.values()) {
			if (e.missingSince === undefined) {
				n++;
			}
		}
		return n;
	}

	/** Keys that may appear in results (tombstoned entries excluded). */
	visibleKeys(): Set<string> {
		const out = new Set<string>();
		for (const [key, e] of this.entries) {
			if (e.missingSince === undefined) {
				out.add(key);
			}
		}
		return out;
	}

	/** Free slots / used slots. */
	holeRatio(): number {
		return this.slotCount === 0 ? 0 : this.free.size / this.slotCount;
	}

	stats(): { entries: number; slots: number; holes: number; pendingSlots: number; dirty: boolean } {
		return {
			entries: this.entries.size,
			slots: this.slotCount,
			holes: this.free.size,
			pendingSlots: this.slotCount - this.committedSlots,
			dirty: this.dirty,
		};
	}

	/**
	 * Brute-force dot product (vectors are normalized) over visible entries,
	 * optionally restricted to `allow` (§7.6). Sorted by score, descending.
	 */
	search(query: ArrayLike<number>, k: number, allow?: Set<string> | ((key: string) => boolean)): SearchHit[] {
		if (query.length !== this.dims) {
			throw new Error(`Query has ${query.length} dims, expected ${this.dims}`);
		}
		const accept = allow === undefined
			? () => true
			: allow instanceof Set
				? (key: string) => allow.has(key)
				: allow;
		const hits: SearchHit[] = [];
		const d = this.dims;
		const data = this.data;
		for (const [key, e] of this.entries) {
			if (e.missingSince !== undefined || !accept(key)) {
				continue;
			}
			const base = e.slot * d;
			let s = 0;
			for (let i = 0; i < d; i++) {
				s += data[base + i] * query[i];
			}
			hits.push({ key, score: s });
		}
		hits.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		return k >= hits.length ? hits : hits.slice(0, Math.max(0, k));
	}

	// ---- writing -----------------------------------------------------------

	/** Add or replace (re-embed) a vector. Clears any tombstone. */
	upsert(key: string, fp: string, vec: ArrayLike<number>): void {
		this.assertOpen();
		if (vec.length !== this.dims) {
			throw new Error(`Vector has ${vec.length} dims, expected ${this.dims}`);
		}
		for (let i = 0; i < vec.length; i++) {
			if (!Number.isFinite(vec[i])) {
				throw new Error("Vector contains a non-finite value");
			}
		}
		const slot = this.appendSlot(vec);
		const old = this.entries.get(key);
		if (old) {
			this.free.add(old.slot);
		}
		this.entries.set(key, { fp, slot, h: this.slotHash(slot) });
		this.changed();
	}

	/**
	 * Replace the fingerprint of an existing entry without touching its
	 * vector (an upload's provisional fingerprint replaced by the listed one).
	 */
	setFingerprint(key: string, fp: string): void {
		this.assertOpen();
		const e = this.entries.get(key);
		if (!e || e.fp === fp) {
			return;
		}
		e.fp = fp;
		this.changed();
	}

	/** Tombstone (§7.3): hidden from results; counts consecutive complete listings without it. */
	markMissing(key: string, now: number): void {
		this.assertOpen();
		const e = this.entries.get(key);
		if (!e) {
			return;
		}
		if (e.missingSince === undefined) {
			e.missingSince = now;
			e.missCount = 1;
		} else {
			e.missCount = (e.missCount ?? 1) + 1;
		}
		this.changed();
	}

	restore(key: string): void {
		this.assertOpen();
		const e = this.entries.get(key);
		if (!e || e.missingSince === undefined) {
			return;
		}
		delete e.missingSince;
		delete e.missCount;
		this.changed();
	}

	remove(key: string): void {
		this.assertOpen();
		const e = this.entries.get(key);
		if (!e) {
			return;
		}
		this.entries.delete(key);
		this.free.add(e.slot);
		this.changed();
	}

	/** Remove everything (e.g. the user asked to rebuild). */
	clear(): void {
		this.assertOpen();
		this.entries.clear();
		this.free.clear();
		this.slotCount = 0;
		this.data = new Float32Array(this.dims * 64);
		// Rewrite from scratch: drop the file, commit an empty meta. Unlink
		// rather than truncate, so an async flush still holding the old file
		// open cannot write stale slots into the new one.
		this.committedSlots = 0;
		this.writeGeneration++;
		if (this.fs.existsSync(this.vecPath)) {
			this.unlinkQuiet(this.vecPath);
			this.fs.closeSync(this.fs.openSync(this.vecPath, "w"));
		}
		this.changed();
	}

	/** Commit pending changes (async I/O with `asyncIo`, else flushSync). */
	flush(): Promise<void> {
		if (this.usesAsyncIo()) {
			return this.flushAsync();
		}
		try {
			this.flushSync();
			return Promise.resolve();
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private usesAsyncIo(): boolean {
		return this.options.asyncIo === true && (this.options.fs === undefined || this.options.asyncFs !== undefined);
	}

	private getAsyncFs(): StoreAsyncFs {
		return this.options.asyncFs ?? nodeFs.promises;
	}

	/** Async flushes run one after another. */
	private flushAsync(): Promise<void> {
		this.cancelFlushTimer();
		const previous = this.asyncFlush ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(() => this.flushAsyncOnce());
		this.asyncFlush = next;
		next.then(
			() => {
				if (this.asyncFlush === next) {
					this.asyncFlush = null;
				}
			},
			() => {
				if (this.asyncFlush === next) {
					this.asyncFlush = null;
				}
			}
		);
		return next;
	}

	/**
	 * Same protocol as flushSync with the slow parts (writes, fsync) off the
	 * main thread: snapshot new slots + meta now, append the slots and write a
	 * private meta tmp asynchronously, then rename it over meta.json in one
	 * synchronous step, unless a synchronous write (flushSync, compaction,
	 * clear, close) happened meanwhile; that write already committed a newer
	 * state, so this one is dropped. Slots are written at fixed offsets
	 * without truncating, so racing with flushSync only rewrites identical
	 * bytes; anything past the committed slot count is trimmed on open.
	 */
	private async flushAsyncOnce(): Promise<void> {
		if (!this.dirty || this.closed) {
			return;
		}
		const afs = this.getAsyncFs();
		const generation = this.writeGeneration;
		const version = this.changeVersion;
		const from = this.committedSlots;
		const to = this.slotCount;
		const B = this.slotBytes;
		const slots = new Uint8Array(this.data.buffer, this.data.byteOffset + from * B, (to - from) * B).slice();
		const meta = Buffer.from(JSON.stringify(this.buildMeta(this.entries, to, [...this.free])), "utf8");
		const tmp = `${this.metaPath}.a${++this.tmpCounter}${TMP}`;
		const stale = (): boolean => this.closed || generation !== this.writeGeneration;

		await afs.mkdir(this.dir, { recursive: true });
		if (to > from) {
			if (stale()) {
				return;
			}
			if (!this.fs.existsSync(this.vecPath)) {
				this.fs.closeSync(this.fs.openSync(this.vecPath, "a"));
			}
			const fh = await afs.open(this.vecPath, "r+");
			try {
				// A compaction/clear may have replaced the file before it was opened.
				if (stale()) {
					return;
				}
				let off = 0;
				while (off < slots.length) {
					const { bytesWritten } = await fh.write(slots, off, slots.length - off, from * B + off);
					off += bytesWritten;
				}
				await fh.sync();
			} finally {
				await fh.close();
			}
		}
		try {
			const fh = await afs.open(tmp, "w");
			try {
				let off = 0;
				while (off < meta.length) {
					const { bytesWritten } = await fh.write(meta, off, meta.length - off, off);
					off += bytesWritten;
				}
				await fh.sync();
			} finally {
				await fh.close();
			}
			if (stale()) {
				await afs.unlink(tmp).catch(() => undefined);
				return;
			}
			this.fs.renameSync(tmp, this.metaPath);
		} catch (error) {
			await afs.unlink(tmp).catch(() => undefined);
			throw error;
		}
		this.committedSlots = to;
		if (this.changeVersion === version) {
			this.dirty = false;
		}
	}

	/** Commit pending changes now: append new slots + fsync, then atomically replace meta.json. */
	flushSync(): void {
		this.cancelFlushTimer();
		if (!this.dirty) {
			return;
		}
		this.writeGeneration++;
		this.fs.mkdirSync(this.dir, { recursive: true });
		if (this.slotCount > this.committedSlots) {
			this.writeVectors(this.vecPath, this.committedSlots, this.slotCount, false);
		}
		this.writeMetaAtomic(this.buildMeta(this.entries, this.slotCount, [...this.free]));
		this.committedSlots = this.slotCount;
		this.dirty = false;
	}

	/** Compact when holes exceed COMPACTION_THRESHOLD. Returns whether it compacted. */
	compactIfNeeded(threshold = COMPACTION_THRESHOLD): Promise<boolean> {
		if (this.holeRatio() <= threshold) {
			return Promise.resolve(false);
		}
		try {
			this.compactSync();
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * Rewrite vectors.bin without holes: write vectors.bin.tmp and
	 * meta.json.tmp (both fsynced), rename vectors, then meta. A crash between
	 * the renames is rolled forward on open.
	 */
	compactSync(): void {
		this.assertOpen();
		this.cancelFlushTimer();
		this.writeGeneration++;
		const ordered = [...this.entries.entries()].sort((a, b) => a[1].slot - b[1].slot);
		const d = this.dims;
		const next = new Float32Array(Math.max(64, ordered.length) * d);
		const nextEntries = new Map<string, Entry>();
		ordered.forEach(([key, e], i) => {
			next.set(this.slotView(e.slot), i * d);
			nextEntries.set(key, { ...e, slot: i });
		});
		this.fs.mkdirSync(this.dir, { recursive: true });
		const tmpVec = this.vecPath + TMP;
		const prevData = this.data;
		this.data = next;
		const tmpMeta = this.metaPath + TMP;
		const dropTmp = (): void => {
			this.unlinkQuiet(tmpVec);
			this.unlinkQuiet(tmpMeta);
		};
		try {
			this.writeVectors(tmpVec, 0, ordered.length, true);
		} catch (error) {
			dropTmp();
			this.rearmFlush();
			throw error;
		} finally {
			this.data = prevData;
		}
		const meta = this.buildMeta(nextEntries, ordered.length, []);
		try {
			this.writeFileDurable(tmpMeta, Buffer.from(JSON.stringify(meta), "utf8"));
		} catch (error) {
			dropTmp();
			this.rearmFlush();
			throw error;
		}
		try {
			this.fs.renameSync(tmpVec, this.vecPath);
		} catch (error) {
			// Nothing committed changed (e.g. Windows EPERM from a virus
			// scanner holding vectors.bin): drop the tmp files and keep the
			// store usable; the next run tries to compact again.
			dropTmp();
			this.rearmFlush();
			throw error;
		}
		try {
			this.fs.renameSync(tmpMeta, this.metaPath);
		} catch (error) {
			// vectors.bin now holds the compacted layout while meta.json and
			// memory hold the old one; refuse further writes until reopen (which
			// rolls the compaction forward, see recoverTmpFiles). Owners check
			// `isClosed` and reopen.
			this.closed = true;
			this.cancelFlushTimer();
			throw error;
		}
		this.data = next;
		this.entries = nextEntries;
		this.slotCount = ordered.length;
		this.committedSlots = ordered.length;
		this.free = new Set();
		this.dirty = false;
	}

	/** Closed by close() or by a compaction that failed half-way (reopen it). */
	get isClosed(): boolean {
		return this.closed;
	}

	/** Pending changes whose flush timer a failed compaction cancelled get a new one. */
	private rearmFlush(): void {
		if (this.dirty && !this.closed) {
			this.changed();
		}
	}

	/** Flush and stop timers. The store must not be used afterwards. */
	close(): void {
		if (this.closed) {
			return;
		}
		this.flushSync();
		this.closed = true;
	}

	// ---- internals ---------------------------------------------------------

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("VectorStore is closed");
		}
	}

	private slotView(slot: number): Float32Array {
		return this.data.subarray(slot * this.dims, (slot + 1) * this.dims);
	}

	private slotHash(slot: number): number {
		const v = this.slotView(slot);
		return fnv1a(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
	}

	private ensureCapacity(slots: number): void {
		if (slots * this.dims <= this.data.length) {
			return;
		}
		let cap = Math.max(64, this.data.length / this.dims);
		while (cap < slots) {
			cap *= 2;
		}
		const next = new Float32Array(cap * this.dims);
		next.set(this.data.subarray(0, this.slotCount * this.dims));
		this.data = next;
	}

	private appendSlot(vec: ArrayLike<number>): number {
		const slot = this.slotCount;
		this.ensureCapacity(slot + 1);
		const base = slot * this.dims;
		for (let i = 0; i < this.dims; i++) {
			this.data[base + i] = vec[i];
		}
		this.slotCount++;
		return slot;
	}

	private changed(): void {
		this.dirty = true;
		this.changeVersion++;
		const delay = this.options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
		if (delay <= 0 || this.flushTimer !== null) {
			return;
		}
		const timers = this.options.timers ?? {
			setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
			clearTimeout: (id: number) => window.clearTimeout(id),
		};
		const report = (error: unknown): void => {
			if (this.options.onFlushError) {
				this.options.onFlushError(error);
			} else {
				console.error("OSS Gallery: semantic index flush failed", error);
			}
		};
		this.flushTimer = timers.setTimeout(() => {
			this.flushTimer = null;
			if (this.closed) {
				return;
			}
			if (this.usesAsyncIo()) {
				this.flushAsync().catch(report);
				return;
			}
			try {
				this.flushSync();
			} catch (error) {
				report(error);
			}
		}, delay);
	}

	private cancelFlushTimer(): void {
		if (this.flushTimer === null) {
			return;
		}
		const timers = this.options.timers;
		if (timers) {
			timers.clearTimeout(this.flushTimer);
		} else {
			window.clearTimeout(this.flushTimer);
		}
		this.flushTimer = null;
	}

	private buildMeta(entries: Map<string, Entry>, slotCount: number, freeSlots: number[]): MetaFile {
		const out: Record<string, Entry> = {};
		for (const [key, e] of entries) {
			const rec: Entry = { fp: e.fp, slot: e.slot, h: e.h };
			if (e.missingSince !== undefined) {
				rec.missingSince = e.missingSince;
				rec.missCount = e.missCount ?? 1;
			}
			out[key] = rec;
		}
		return {
			format: STORE_FORMAT,
			header: { ...this.header },
			slotCount,
			entries: out,
			freeSlots: freeSlots.sort((a, b) => a - b),
		};
	}

	private writeFileDurable(file: string, bytes: Uint8Array): void {
		const fd = this.fs.openSync(file, "w");
		try {
			let off = 0;
			while (off < bytes.length) {
				off += this.fs.writeSync(fd, bytes, off, bytes.length - off, off);
			}
			this.fs.fsyncSync(fd);
		} finally {
			this.fs.closeSync(fd);
		}
	}

	private writeMetaAtomic(meta: MetaFile): void {
		const tmp = this.metaPath + TMP;
		this.writeFileDurable(tmp, Buffer.from(JSON.stringify(meta), "utf8"));
		this.fs.renameSync(tmp, this.metaPath);
	}

	/** Write slots [from, to) of `this.data` at their offsets in `file`, cutting anything after. */
	private writeVectors(file: string, from: number, to: number, fresh: boolean): void {
		const exists = this.fs.existsSync(file);
		const fd = this.fs.openSync(file, fresh || !exists ? "w" : "r+");
		try {
			// Drop uncommitted bytes a failed earlier flush may have left.
			this.fs.ftruncateSync(fd, from * this.slotBytes);
			const bytes = new Uint8Array(
				this.data.buffer,
				this.data.byteOffset + from * this.slotBytes,
				(to - from) * this.slotBytes
			);
			let off = 0;
			while (off < bytes.length) {
				off += this.fs.writeSync(fd, bytes, off, bytes.length - off, from * this.slotBytes + off);
			}
			this.fs.fsyncSync(fd);
		} finally {
			this.fs.closeSync(fd);
		}
	}

	private truncateVectors(slots: number): void {
		if (!this.fs.existsSync(this.vecPath)) {
			return;
		}
		const fd = this.fs.openSync(this.vecPath, "r+");
		try {
			this.fs.ftruncateSync(fd, slots * this.slotBytes);
			this.fs.fsyncSync(fd);
		} finally {
			this.fs.closeSync(fd);
		}
	}

	private fileSize(file: string): number | null {
		try {
			return this.fs.statSync(file).size;
		} catch {
			return null;
		}
	}

	private unlinkQuiet(file: string): void {
		try {
			this.fs.unlinkSync(file);
		} catch {
			// already gone
		}
	}

	private readMeta(file: string): MetaFile | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(this.fs.readFileSync(file).toString("utf8"));
		} catch {
			return null;
		}
		const m = parsed as Partial<MetaFile> | null;
		if (!m || m.format !== STORE_FORMAT || typeof m.entries !== "object" || m.entries === null
			|| !Number.isInteger(m.slotCount) || (m.slotCount as number) < 0) {
			return null;
		}
		return m as MetaFile;
	}

	/** Finish or undo an interrupted flush/compaction (see compactSync). */
	private recoverTmpFiles(): boolean {
		const tmpVec = this.vecPath + TMP;
		const tmpMeta = this.metaPath + TMP;
		const hasTmpVec = this.fs.existsSync(tmpVec);
		const hasTmpMeta = this.fs.existsSync(tmpMeta);
		if (!hasTmpVec && !hasTmpMeta) {
			return false;
		}
		if (hasTmpVec) {
			// Crash before vectors.bin was replaced: the committed state is intact.
			this.unlinkQuiet(tmpVec);
			this.unlinkQuiet(tmpMeta);
			return true;
		}
		// Only meta.json.tmp: complete it if it is whole and matches vectors.bin.
		const meta = this.readMeta(tmpMeta);
		const size = this.fileSize(this.vecPath) ?? 0;
		if (meta && sameHeader(meta.header, this.header) && size === meta.slotCount * this.slotBytes) {
			this.fs.renameSync(tmpMeta, this.metaPath);
		} else {
			this.unlinkQuiet(tmpMeta);
		}
		return true;
	}

	/**
	 * An async flush that never reached its rename leaves meta.json.a<N>.tmp
	 * behind; it was never committed, so it is simply deleted (any appended
	 * slots are trimmed below as uncommitted bytes).
	 */
	private removeAsyncTmpFiles(): void {
		const list = (this.fs as Partial<{ readdirSync(p: string): string[] }>).readdirSync;
		if (!list) {
			return;
		}
		let names: string[];
		try {
			names = list.call(this.fs, this.dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (ASYNC_META_TMP.test(name)) {
				this.unlinkQuiet(path.join(this.dir, name));
			}
		}
	}

	private resetFiles(): void {
		this.unlinkQuiet(this.metaPath);
		this.unlinkQuiet(this.vecPath);
	}

	private load(): void {
		this.fs.mkdirSync(this.dir, { recursive: true });
		const recoveredTmp = this.recoverTmpFiles();
		this.removeAsyncTmpFiles();

		if (!this.fs.existsSync(this.metaPath)) {
			this.unlinkQuiet(this.vecPath);
			this.openResult = { status: "created", dropped: 0, recoveredTmp };
			return;
		}
		const meta = this.readMeta(this.metaPath);
		if (!meta) {
			this.resetFiles();
			this.openResult = { status: "reset", reason: "corrupt-meta", dropped: 0, recoveredTmp };
			return;
		}
		if (!sameHeader(meta.header, this.header)) {
			this.resetFiles();
			this.openResult = { status: "reset", reason: "header-mismatch", dropped: 0, recoveredTmp };
			return;
		}

		let bytes: Buffer;
		try {
			bytes = this.fs.readFileSync(this.vecPath);
		} catch {
			bytes = Buffer.alloc(0);
		}
		const fileSlots = Math.floor(bytes.length / this.slotBytes);
		const slotCount = Math.min(meta.slotCount, fileSlots);
		let repaired = bytes.length !== meta.slotCount * this.slotBytes;

		this.ensureCapacity(slotCount);
		new Uint8Array(this.data.buffer, this.data.byteOffset, slotCount * this.slotBytes)
			.set(bytes.subarray(0, slotCount * this.slotBytes));
		this.slotCount = slotCount;

		let dropped = 0;
		const used = new Set<number>();
		for (const key of Object.keys(meta.entries)) {
			const e = meta.entries[key];
			if (!isValidEntry(e) || e.slot >= slotCount || used.has(e.slot) || this.slotHash(e.slot) !== e.h) {
				dropped++;
				continue;
			}
			used.add(e.slot);
			const entry: Entry = { fp: e.fp, slot: e.slot, h: e.h };
			if (e.missingSince !== undefined) {
				entry.missingSince = e.missingSince;
				entry.missCount = e.missCount ?? 1;
			}
			this.entries.set(key, entry);
		}
		for (let s = 0; s < slotCount; s++) {
			if (!used.has(s)) {
				this.free.add(s);
			}
		}
		this.committedSlots = slotCount;
		if (dropped > 0) {
			repaired = true;
		}
		if (repaired) {
			// Persist the repaired state: trim the file, rewrite meta.
			if (bytes.length !== slotCount * this.slotBytes) {
				this.truncateVectors(slotCount);
			}
			this.writeMetaAtomic(this.buildMeta(this.entries, slotCount, [...this.free]));
		}
		this.openResult = { status: repaired ? "repaired" : "loaded", dropped, recoveredTmp };
	}
}
