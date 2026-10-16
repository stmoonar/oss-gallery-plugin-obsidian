/**
 * Plugin-level semantic indexing (docs/semantic-search.md §4.5, §7, §9.4).
 *
 * One instance per plugin, one VectorStore (+ status sidecar) per scope,
 * one serial low-priority runner for all scopes:
 * - beginListing/reconcile: apply the deletion sync protocol (§7) to a
 *   provider listing and work out what still needs embedding. Stale
 *   listings (older token) are dropped.
 * - start: index what the last listing showed. Remote providers download
 *   every image, so a run never starts without the user's confirmation
 *   (estimate dialog); Local reads from disk and needs none.
 * - onUploaded / onDeleted: in-plugin uploads are embedded from the bytes in
 *   hand (no download); deletions drop the vector immediately.
 *
 * No Obsidian imports: UI (dialogs, notices, strings) comes in through deps,
 * so the protocol is unit-tested with FakeEmbeddingBackend.
 */
import * as nodeFs from "fs";
import * as path from "path";
import type { ListResult, OssImage } from "../types/oss";
import type { EmbeddingBackend } from "./EmbeddingBackend";
import {
	fingerprint,
	IndexScope,
	matchesUploadFingerprint,
	uploadFingerprint,
} from "./fingerprint";
import { ConvertedFormat, prepareImage, PreparedImage } from "./imageFormat";
import { IndexEntryStatus, IndexStatusStore, StatusEntry } from "./IndexStatusStore";
import { EmbeddingConfig, EmbeddingError, ImageInput, maxBatchFor } from "./protocol";
import {
	AbortSignalLike,
	describeTooLargeEn,
	FetchAbortedError,
	MAX_INDEX_IMAGE_BYTES,
	raceWithTimeout,
	RemoteFetchError,
	TooLargeDescriber,
} from "./remoteBytes";
import { headerFromConfig, META_FILE, sameHeader, scopeIndexDir, VectorStore, VectorStoreOptions } from "./VectorStore";
import type { Timers } from "./WorkerEmbeddingBackend";

/** §7.3: purge after this many consecutive complete listings without the key... */
export const PURGE_AFTER_MISSES = 2;
/** ...or after it has been missing this long. */
export const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** §9.4: with autoIndex, runs above this estimate ask again. */
export const AUTO_CONFIRM_LIMIT_BYTES = 200 * 1000 * 1000;
/** §9.4: objects listed without a size count as this much for the auto-large rule. */
export const ASSUMED_UNKNOWN_SIZE_BYTES = 2 * 1000 * 1000;
/** Failed objects are retried this many times in total (until they change). */
export const MAX_ATTEMPTS = 3;
/** Wait before retry n (1-based) of a failed object. */
export const RETRY_BACKOFF_MS = [60_000, 10 * 60_000];
/** After a run stopped on a backend error, autoIndex does not start again for this long. */
export const FATAL_BACKOFF_MS = 10 * 60_000;
/** Consecutive batches whose embedding crashed/hung before the run stops (backend broken, not one image). */
export const MAX_CONSECUTIVE_CRASHES = 2;
/** Backstops per object (the remote fetcher has its own, shorter timeout). */
export const READ_TIMEOUT_MS = 4 * 60_000;
export const PREPARE_TIMEOUT_MS = 2 * 60_000;
/** Reason recorded for keys that were in flight when the app closed or crashed. */
export const INTERRUPTED_REASON = "Indexing was interrupted while processing this image (Obsidian closed or crashed)";

export interface TrafficEstimate {
	/** Listed objects that still need embedding. */
	pendingCount: number;
	/** Bytes to download for them (0 for Local: read from disk). */
	pendingBytes: number;
	/** Listed objects that already have a current vector. */
	indexedCount: number;
	/** Pending remote objects whose listing reported no size (not in pendingBytes). Omitted when 0. */
	unknownSizeCount?: number;
}

/** Why the traffic dialog is shown (§9.4). */
export type TrafficPromptReason = "manual" | "auto-first" | "auto-large";

/**
 * §9.4 rules: does starting this run need the traffic dialog, and why?
 * null = start without asking (Local, nothing to download, or autoIndex on
 * a remote scope confirmed before whose estimate is within the limit).
 * Objects without a listed size count as ASSUMED_UNKNOWN_SIZE_BYTES each.
 */
export function trafficPromptReason(o: {
	local: boolean;
	pendingCount: number;
	auto: boolean;
	confirmedBefore: boolean;
	pendingBytes: number;
	unknownSizeCount?: number;
}): TrafficPromptReason | null {
	if (o.local || o.pendingCount === 0) {
		return null;
	}
	if (!o.auto) {
		return "manual";
	}
	if (!o.confirmedBefore) {
		return "auto-first";
	}
	const bytes = o.pendingBytes + (o.unknownSizeCount ?? 0) * ASSUMED_UNKNOWN_SIZE_BYTES;
	return bytes > AUTO_CONFIRM_LIMIT_BYTES ? "auto-large" : null;
}

export type IndexRunState = "idle" | "running" | "paused";

export interface IndexProgress {
	state: IndexRunState;
	scopeId: string | null;
	done: number;
	total: number;
	/** Key of the object being downloaded / prepared right now. */
	currentKey: string | null;
}

export interface RunSummary {
	scopeId: string;
	/** Embedded (ok + converted). */
	indexed: number;
	converted: number;
	unsupported: number;
	failed: number;
	/** Formats seen among converted / unsupported objects. */
	convertedFormats: string[];
	unsupportedFormats: string[];
	/** The run indexed listed objects (not only uploads). */
	fromListing: boolean;
	cancelled: boolean;
	/** Set when the run stopped on a backend error (model load, crash...). */
	error?: string;
}

export interface IndexStatsItem {
	key: string;
	status: Exclude<IndexEntryStatus, "ok">;
	format?: string;
	reason?: string;
	attempts?: number;
}

export interface IndexStats {
	/** Vectors not tombstoned (ok + converted). */
	indexed: number;
	ok: number;
	converted: number;
	unsupported: number;
	failed: number;
	/** Listed objects still waiting for embedding. */
	pending: number;
	/** Tombstoned (hidden, waiting for purge). */
	missing: number;
	/** Every non-ok object, for the details list. */
	items: IndexStatsItem[];
}

export interface IndexServiceDeps {
	/** Absolute per-device index root, or null when the setting is invalid. */
	indexRoot(): string | null;
	vaultId: string;
	embeddingConfig(): EmbeddingConfig;
	/** semantic.enabled: reconcile and hooks run. */
	isEnabled(): boolean;
	/** Enabled and the model is installed: embedding can run. */
	isReady(): boolean;
	autoIndex(): boolean;
	/** A fresh index-mode backend (not initialized). */
	createBackend(): EmbeddingBackend | null;
	/**
	 * Bytes of a listed object: Local = disk, remote = download. `signal`
	 * aborts when the run is cancelled (pass it to fetchRemoteImageBytes);
	 * the service also stops waiting by itself (cancel, READ_TIMEOUT_MS).
	 */
	readBytes(scope: IndexScope, obj: OssImage, signal?: AbortSignalLike): Promise<ArrayBuffer>;
	/** Reason for objects above MAX_INDEX_IMAGE_BYTES (localized; default English). */
	describeTooLarge?: TooLargeDescriber;
	/** Reason for keys in flight when the app died (localized; default INTERRUPTED_REASON). */
	interruptedReason?(): string;
	/** SVG -> PNG (main thread). */
	rasterizeSvg(bytes: ArrayBuffer): Promise<ArrayBuffer>;
	/** Override of format detection/conversion (tests). */
	prepare?(bytes: ArrayBuffer, key: string): Promise<PreparedImage>;
	/** Ask before downloading a remote scope (§9.4). Resolves true to go. */
	confirmTraffic(scope: IndexScope, estimate: TrafficEstimate, reason: TrafficPromptReason): Promise<boolean>;
	/** End-of-run report (the plugin shows a Notice). */
	onRunFinished?(summary: RunSummary): void;
	now?(): number;
	timers?: Timers;
	/** Extra VectorStore options (tests: flushDelayMs 0). */
	storeOptions?: Partial<VectorStoreOptions>;
	statusFlushDelayMs?: number;
}

interface ScopeState {
	scope: IndexScope;
	store: VectorStore | null;
	status: IndexStatusStore | null;
	/** Objects of the last applied listing, by key. */
	remote: Map<string, OssImage> | null;
	lastApplied: number;
	/** Tokens below this were issued before the scope was invalidated. */
	minToken: number;
	/** Listed objects that need embedding. */
	pending: Map<string, OssImage>;
	/** In-plugin uploads with their bytes. */
	uploads: Map<string, { obj: OssImage; bytes: ArrayBuffer }>;
	/**
	 * What the current (or about to start) run may download for this scope;
	 * null = nothing. Set by start(), bound to one run (see Grant).
	 */
	grant: Grant | null;
	/** Bumped by cancel / scope change / closeAll: a start() awaiting its dialog gives up. */
	epoch: number;
	/** autoIndex already asked this session (and was declined or not answered yet). */
	autoPrompted: boolean;
	/** Keys deleted while a batch was in flight: their results are dropped. */
	deletedDuringRun: Set<string>;
	/** Keys of the batch being processed: a listing meanwhile must not queue them again. */
	processing: Set<string>;
}

/**
 * Authorization of one run (§9.4): the pending objects the user confirmed
 * (or autoIndex accepted) when start() ran, by key and fingerprint. Objects
 * a later listing adds, or whose fingerprint changes, are not covered: they
 * need another start (autoIndex evaluates them on that listing). Local
 * scopes download nothing, so their grant covers everything (`all`).
 * A grant is replaced (never mutated) and cleared when the run that saw it
 * ends, when start() could not start a run, on cancel and on a fatal error.
 */
interface Grant {
	all: boolean;
	keys: Map<string, string>;
}

interface WorkItem {
	obj: OssImage;
	bytes?: ArrayBuffer;
	upload: boolean;
	/** A status/vector was recorded for it in this batch. */
	handled?: boolean;
}

type ProgressListener = (progress: IndexProgress) => void;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** embedImages failed for a whole batch (crash, hang); its items were recorded as failed. */
class BatchCrashError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BatchCrashError";
	}
}

export class SemanticIndexService {
	private readonly states = new Map<string, ScopeState>();
	private readonly listeners = new Set<ProgressListener>();
	private nextToken = 0;
	private backend: EmbeddingBackend | null = null;
	private backendInit: Promise<unknown> | null = null;
	private backendBudget: number | null = null;
	private running: Promise<void> | null = null;
	private activeScopeId: string | null = null;
	private paused = false;
	private resumeWaiters: Array<() => void> = [];
	private cancelRequested = false;
	private done = 0;
	private inFlight = 0;
	private currentKey: string | null = null;
	private disposed = false;
	/** Aborted by cancel(): interrupts the download / preparation in progress. */
	private abort: AbortController | null = null;
	/** autoIndex does not start runs before this time (after a backend error). */
	private autoBlockedUntil = 0;

	constructor(private readonly deps: IndexServiceDeps) {}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	// ---- scopes and stores -------------------------------------------------

	private state(scope: IndexScope): ScopeState {
		let st = this.states.get(scope.id);
		if (!st) {
			st = {
				scope,
				store: null,
				status: null,
				remote: null,
				lastApplied: 0,
				minToken: 0,
				pending: new Map(),
				uploads: new Map(),
				grant: null,
				epoch: 0,
				autoPrompted: false,
				deletedDuringRun: new Set(),
				processing: new Set(),
			};
			this.states.set(scope.id, st);
		}
		return st;
	}

	private scopeDir(scope: IndexScope): string | null {
		const root = this.deps.indexRoot();
		return root ? scopeIndexDir(root, this.deps.vaultId, scope.id) : null;
	}

	/** Does an index exist for this scope (open or on disk)? */
	hasIndex(scope: IndexScope): boolean {
		const st = this.states.get(scope.id);
		if (st?.store) {
			return true;
		}
		const dir = this.scopeDir(scope);
		return dir !== null && nodeFs.existsSync(path.join(dir, META_FILE));
	}

	/**
	 * The scope's store, opened on first use. Without `create`, a scope that
	 * was never indexed stays without files. A store opened for another
	 * header (token budget changed) is reopened, which resets it.
	 */
	private getStore(st: ScopeState, create: boolean): VectorStore | null {
		const header = headerFromConfig(this.deps.embeddingConfig());
		if (st.store?.isClosed) {
			// A compaction failed half-way: reopen (recovery rolls it forward).
			st.store = null;
		}
		if (st.store && !sameHeader(st.store.header, header)) {
			this.closeState(st);
		}
		if (st.store) {
			return st.store;
		}
		const dir = this.scopeDir(st.scope);
		if (!dir || (!create && !nodeFs.existsSync(path.join(dir, META_FILE)))) {
			return null;
		}
		let store: VectorStore;
		try {
			store = VectorStore.open(dir, header, {
				asyncIo: true,
				timers: this.deps.timers,
				...this.deps.storeOptions,
			});
			st.status ??= IndexStatusStore.open(dir, {
				timers: this.deps.timers,
				flushDelayMs: this.deps.statusFlushDelayMs,
			});
		} catch (error) {
			console.error("OSS Gallery: opening semantic index failed", error);
			return null;
		}
		st.store = store;
		if (store.openResult.status === "reset") {
			st.status.dropEmbeddingResults();
		}
		this.adoptInterrupted(st);
		// Pending work was computed without the store's knowledge.
		if (st.remote) {
			this.recomputePending(st);
		}
		return st.store;
	}

	/** Keys in flight when a previous session died count as a failed attempt (poison images). */
	private adoptInterrupted(st: ScopeState): void {
		for (const [key, m] of st.status?.takeInterrupted() ?? []) {
			this.recordFailure(st, key, m.fp, undefined, this.deps.interruptedReason?.() ?? INTERRUPTED_REASON, null, true);
		}
	}

	/** Open the store for searching (never creates files). */
	getSearchStore(scope: IndexScope): VectorStore | null {
		return this.getStore(this.state(scope), false);
	}

	/** Does `key` have a visible (not tombstoned) vector in `scope`? */
	isIndexed(scope: IndexScope, key: string): boolean {
		const info = this.getSearchStore(scope)?.peek(key);
		return info !== undefined && info.missingSince === undefined;
	}

	/** Objects of the last applied listing of `scope` (null before the first). */
	getRemote(scope: IndexScope): OssImage[] | null {
		const remote = this.states.get(scope.id)?.remote;
		return remote ? [...remote.values()] : null;
	}

	private closeState(st: ScopeState): void {
		try {
			st.store?.close();
		} catch (error) {
			console.error("OSS Gallery: closing semantic index failed", error);
		}
		try {
			// An orderly close is not a crash: the batch in flight is not an attempt.
			for (const key of st.status?.inFlightKeys() ?? []) {
				st.status?.clearInFlight(key);
			}
			st.status?.close();
		} catch (error) {
			console.error("OSS Gallery: writing semantic index status failed", error);
		}
		st.store = null;
		st.status = null;
	}

	// ---- listings (§7) -----------------------------------------------------

	/** Call before listImages; pass the token to reconcile (§7.4). */
	beginListing(scope: IndexScope): number {
		this.state(scope);
		return ++this.nextToken;
	}

	/**
	 * Apply a listing. Returns false when it was ignored (stale token,
	 * feature off). `complete === false` only adds/updates, never deletes;
	 * deletions are limited to keys under `r.prefix`.
	 */
	reconcile(token: number, scope: IndexScope, r: ListResult): boolean {
		if (this.disposed || !this.deps.isEnabled()) {
			return false;
		}
		const st = this.state(scope);
		if (token <= st.lastApplied || token < st.minToken) {
			return false;
		}
		st.lastApplied = token;
		const remote = new Map(r.items.map((o) => [o.key, o]));
		st.remote = remote;

		// Index trouble (closed store, I/O error) must never surface as a
		// listing failure: log it and let the next use reopen the store.
		try {
			const store = this.getStore(st, false);
			if (store && r.complete) {
				this.applyDeletions(st, store, r.prefix);
			}
			if (store && r.complete && st.status) {
				for (const key of st.status.keys()) {
					if (key.startsWith(r.prefix) && !remote.has(key) && !store.has(key)) {
						st.status.delete(key);
					}
				}
			}
			this.recomputePending(st);
		} catch (error) {
			console.error("OSS Gallery: semantic index reconcile failed", error);
			this.dropBrokenStore(st);
			st.pending.clear();
		}
		this.emit();
		this.maybeAutoStart(st);
		return true;
	}

	/** Forget a store that threw (closed after a failed compaction); the next use reopens it. */
	private dropBrokenStore(st: ScopeState): void {
		if (st.store?.isClosed) {
			st.store = null;
		}
	}

	/** §7.3 step 3 for keys under `prefix` missing from a complete listing. */
	private applyDeletions(st: ScopeState, store: VectorStore, prefix: string): void {
		const now = this.now();
		const remote = st.remote ?? new Map<string, OssImage>();
		for (const key of store.keys()) {
			if (!key.startsWith(prefix) || remote.has(key) || st.uploads.has(key)) {
				continue;
			}
			const before = store.peek(key);
			store.markMissing(key, now);
			const after = store.peek(key);
			if (!before || !after || before.missingSince === undefined) {
				continue;
			}
			if ((after.missCount ?? 1) >= PURGE_AFTER_MISSES || now - before.missingSince >= PURGE_AFTER_MS) {
				store.remove(key);
				st.status?.delete(key);
			}
		}
	}

	/**
	 * What the last listing still needs: not indexed, or indexed with another
	 * fingerprint. Also restores tombstoned keys that came back (§7.3 step 1)
	 * and adopts the listed fingerprint of in-plugin uploads.
	 */
	private recomputePending(st: ScopeState): void {
		st.pending.clear();
		if (!st.remote) {
			return;
		}
		const store = st.store;
		const now = this.now();
		for (const obj of st.remote.values()) {
			if (st.uploads.has(obj.key) || st.processing.has(obj.key)) {
				continue;
			}
			const fp = fingerprint(obj);
			const info = store?.peek(obj.key);
			if (info && store) {
				if (info.missingSince !== undefined) {
					store.restore(obj.key);
				}
				if (info.fp === fp) {
					continue;
				}
				if (matchesUploadFingerprint(info.fp, obj)) {
					store.setFingerprint(obj.key, fp);
					const s = st.status?.get(obj.key);
					if (s && s.fp === info.fp) {
						st.status?.set(obj.key, { ...s, fp });
					}
					continue;
				}
			}
			const s = st.status?.get(obj.key);
			if (s && s.fp === fp) {
				if (s.status === "unsupported") {
					continue;
				}
				if (s.status === "failed" && ((s.attempts ?? 0) >= MAX_ATTEMPTS || (s.nextRetryAt ?? 0) > now)) {
					continue;
				}
			}
			st.pending.set(obj.key, obj);
		}
	}

	// ---- hooks -------------------------------------------------------------

	/**
	 * An in-plugin upload finished: embed it from the bytes in hand. The key
	 * gets a provisional fingerprint until a listing reports the real one.
	 * `bytes` is transferred to the worker (detached afterwards).
	 */
	onUploaded(scope: IndexScope, obj: OssImage, bytes: ArrayBuffer): void {
		if (this.disposed || !this.deps.isReady()) {
			return;
		}
		const st = this.state(scope);
		st.uploads.set(obj.key, { obj, bytes });
		st.pending.delete(obj.key);
		st.deletedDuringRun.delete(obj.key);
		this.kick();
	}

	/** An in-plugin delete succeeded: drop the vector now (no tombstone). */
	onDeleted(scope: IndexScope, key: string): void {
		if (this.disposed) {
			return;
		}
		const st = this.state(scope);
		st.pending.delete(key);
		st.uploads.delete(key);
		st.remote?.delete(key);
		if (this.running) {
			st.deletedDuringRun.add(key);
		}
		try {
			const store = this.getStore(st, false);
			store?.remove(key);
			st.status?.delete(key);
		} catch (error) {
			console.error("OSS Gallery: removing a deleted image from the semantic index failed", error);
			this.dropBrokenStore(st);
		}
		this.emit();
	}

	// ---- estimate / start / pause / cancel ----------------------------------

	estimate(scope: IndexScope): TrafficEstimate {
		const st = this.state(scope);
		return this.estimateOf(st, [...st.pending.values()]);
	}

	/** Is `obj` covered by the scope's current grant (same key and fingerprint)? */
	private isGranted(st: ScopeState, obj: OssImage): boolean {
		const g = st.grant;
		return g !== null && (g.all || g.keys.get(obj.key) === fingerprint(obj));
	}

	private estimateOf(st: ScopeState, objects: OssImage[]): TrafficEstimate {
		const scope = st.scope;
		let pendingBytes = 0;
		let unknownSizeCount = 0;
		for (const obj of objects) {
			if (obj.size > 0) {
				pendingBytes += obj.size;
			} else {
				unknownSizeCount++;
			}
		}
		let indexedCount = 0;
		if (st.remote && st.store) {
			for (const obj of st.remote.values()) {
				const info = st.store.peek(obj.key);
				if (info && info.missingSince === undefined && !st.pending.has(obj.key)) {
					indexedCount++;
				}
			}
		}
		return {
			pendingCount: objects.length,
			pendingBytes: scope.local ? 0 : pendingBytes,
			indexedCount,
			...(!scope.local && unknownSizeCount > 0 ? { unknownSizeCount } : {}),
		};
	}

	/**
	 * Index what the last listing showed. Remote scopes ask for confirmation
	 * first: always for a manual start; with autoIndex only the first time and
	 * when the estimate exceeds AUTO_CONFIRM_LIMIT_BYTES. Returns whether
	 * indexing was started (or nothing was left to do).
	 *
	 * The confirmation covers exactly the pending objects of the estimate
	 * (Grant): during a run only objects not yet covered are estimated and
	 * added. It is bound to one run: when no run starts, it is dropped.
	 */
	async start(scope: IndexScope, options: { auto?: boolean } = {}): Promise<boolean> {
		if (this.disposed || !this.deps.isReady()) {
			return false;
		}
		const st = this.state(scope);
		if (!st.remote) {
			return false;
		}
		if (!this.getStore(st, true)) {
			return false;
		}
		const epoch = st.epoch;
		const uncovered = [...st.pending.values()].filter((o) => !this.isGranted(st, o));
		const estimate = this.estimateOf(st, uncovered);
		const reason = trafficPromptReason({
			local: scope.local,
			pendingCount: estimate.pendingCount,
			auto: options.auto === true,
			confirmedBefore: st.status?.confirmedAt !== undefined,
			pendingBytes: estimate.pendingBytes,
			unknownSizeCount: estimate.unknownSizeCount,
		});
		if (reason) {
			if (options.auto && st.autoPrompted) {
				return false;
			}
			if (options.auto) {
				// Ask at most once per session unless the user agrees.
				st.autoPrompted = true;
			}
			const ok = await this.deps.confirmTraffic(scope, estimate, reason);
			// Cancelled, scope switched or index closed while the dialog was open.
			if (!ok || this.disposed || st.epoch !== epoch || !this.deps.isReady()) {
				return false;
			}
			st.autoPrompted = false;
			st.status?.setConfirmed(this.now());
		}
		if (!options.auto) {
			// The user asked explicitly: lift the backoff after a backend error.
			this.autoBlockedUntil = 0;
		}
		// A new object: a run finishing up only clears the grant it saw.
		const keys = new Map(st.grant?.keys ?? []);
		for (const o of uncovered) {
			keys.set(o.key, fingerprint(o));
		}
		const grant: Grant = { all: (st.grant?.all ?? false) || scope.local, keys };
		st.grant = grant;
		this.kick();
		if (!this.running && st.grant === grant) {
			// Nothing to do: the authorization must not outlive this call.
			st.grant = null;
		}
		return true;
	}

	/**
	 * "Retry failed": forget the failure records (attempts and backoff) of
	 * `scope`, so its failed objects are pending again for the next start.
	 * Unsupported files stay skipped. Returns how many were reset.
	 */
	resetFailed(scope: IndexScope): number {
		const st = this.state(scope);
		this.getStore(st, false);
		let count = 0;
		for (const [key, entry] of st.status?.all() ?? []) {
			if (entry.status === "failed") {
				st.status?.delete(key);
				count++;
			}
		}
		if (count > 0) {
			try {
				st.status?.flush();
			} catch (error) {
				console.error("OSS Gallery: writing semantic index status failed", error);
			}
			this.recomputePending(st);
			this.emit();
		}
		return count;
	}

	/**
	 * autoIndex: start for pending objects no grant covers yet (new ones a
	 * listing found, also while a run is going), unless a backend error
	 * happened recently (FATAL_BACKOFF_MS).
	 */
	private maybeAutoStart(st: ScopeState): void {
		if (!this.deps.autoIndex() || !this.deps.isReady() || this.now() < this.autoBlockedUntil) {
			return;
		}
		if (![...st.pending.values()].some((o) => !this.isGranted(st, o))) {
			return;
		}
		this.start(st.scope, { auto: true }).catch((error) => {
			console.error("OSS Gallery: automatic semantic indexing failed to start", error);
		});
	}

	pause(): void {
		if (this.running && !this.paused) {
			this.paused = true;
			this.emit();
		}
	}

	resume(): void {
		if (!this.paused) {
			return;
		}
		this.paused = false;
		const waiters = this.resumeWaiters;
		this.resumeWaiters = [];
		waiters.forEach((w) => w());
		this.emit();
	}

	isPaused(): boolean {
		return this.paused;
	}

	isRunning(): boolean {
		return this.running !== null;
	}

	/**
	 * Stop the run: queued work stays pending (a later start resumes it),
	 * the worker is terminated (D13), nothing more is downloaded.
	 */
	cancel(): void {
		for (const st of this.states.values()) {
			st.grant = null;
			st.epoch++;
		}
		if (!this.running) {
			return;
		}
		this.cancelRequested = true;
		// Interrupt the download / preparation in progress (also while paused).
		this.abort?.abort();
		this.resume();
		this.disposeBackend();
	}

	/** Wait for the current run (tests / unload). */
	whenIdle(): Promise<void> {
		return this.running ?? Promise.resolve();
	}

	/**
	 * The active provider/scope changed (§7.4): stop work for other scopes and
	 * invalidate every listing token issued for them so far.
	 */
	onScopeChanged(currentScopeId: string | null): void {
		for (const st of this.states.values()) {
			if (st.scope.id !== currentScopeId) {
				st.minToken = this.nextToken + 1;
				st.grant = null;
				st.epoch++;
				st.uploads.clear();
			}
		}
		if (this.running && this.activeScopeId !== currentScopeId) {
			this.cancel();
		}
	}

	/**
	 * Index directory / header changed or the index is being cleared: stop,
	 * close every store (flushed), forget confirmations made this session.
	 */
	closeAll(): void {
		this.cancel();
		for (const st of this.states.values()) {
			this.closeState(st);
			st.autoPrompted = false;
			if (st.remote) {
				this.recomputePending(st);
			}
		}
		this.emit();
	}

	dispose(): void {
		this.cancel();
		for (const st of this.states.values()) {
			this.closeState(st);
		}
		this.disposed = true;
		this.disposeBackend();
		this.listeners.clear();
	}

	// ---- progress & stats --------------------------------------------------

	onProgress(listener: ProgressListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getProgress(): IndexProgress {
		let remaining = 0;
		for (const st of this.states.values()) {
			remaining += st.uploads.size;
			if (st.grant?.all) {
				remaining += st.pending.size;
			} else if (st.grant) {
				// Taken keys leave the grant, so this shrinks as the run goes.
				for (const [key, fp] of st.grant.keys) {
					const obj = st.pending.get(key);
					if (obj && fingerprint(obj) === fp) {
						remaining++;
					}
				}
			}
		}
		return {
			state: this.running ? (this.paused ? "paused" : "running") : "idle",
			scopeId: this.activeScopeId,
			done: this.done,
			total: this.done + this.inFlight + remaining,
			currentKey: this.running ? this.currentKey : null,
		};
	}

	private emit(): void {
		const progress = this.getProgress();
		for (const listener of [...this.listeners]) {
			try {
				listener(progress);
			} catch (error) {
				console.error("OSS Gallery: index progress listener failed", error);
			}
		}
	}

	/** Counts per status and the non-ok objects with reasons (settings details). */
	getStats(scope: IndexScope): IndexStats {
		const st = this.state(scope);
		const store = this.getStore(st, false);
		const items: IndexStatsItem[] = [];
		let converted = 0;
		let unsupported = 0;
		let failed = 0;
		for (const [key, e] of st.status?.all() ?? []) {
			if (e.status === "converted") {
				if (!store?.has(key)) {
					continue;
				}
				converted++;
			} else if (e.status === "unsupported") {
				unsupported++;
			} else {
				failed++;
			}
			items.push({ key, status: e.status, format: e.format, reason: e.reason, attempts: e.attempts });
		}
		const indexed = store?.visibleCount() ?? 0;
		return {
			indexed,
			ok: Math.max(0, indexed - converted),
			converted,
			unsupported,
			failed,
			pending: st.pending.size,
			missing: (store?.size ?? 0) - indexed,
			items: items.sort((a, b) => a.status.localeCompare(b.status) || a.key.localeCompare(b.key)),
		};
	}

	// ---- runner ------------------------------------------------------------

	private kick(): void {
		if (this.running || this.disposed) {
			return;
		}
		if (!this.nextBatch(true)) {
			return;
		}
		this.cancelRequested = false;
		this.done = 0;
		this.abort = new AbortController();
		const run = this.runLoop().finally(() => {
			if (this.running === run) {
				this.running = null;
			}
			this.activeScopeId = null;
			this.paused = false;
			this.emit();
			// Work queued while finishing up (an upload, or a start confirmed
			// meanwhile, even after a cancel) starts a new run.
			if (!this.cancelRequested || [...this.states.values()].some((st) => st.grant !== null)) {
				this.kick();
			}
		});
		this.running = run;
		this.emit();
	}

	/**
	 * Uploads first, then granted pending objects. An object whose last
	 * attempt crashed the worker is embedded alone, so one poison image does
	 * not take the rest of its batch down with it again.
	 */
	private nextBatch(peekOnly = false): { st: ScopeState; items: WorkItem[] } | null {
		const size = maxBatchFor(this.deps.embeddingConfig().imageTokenBudget);
		const ordered = [...this.states.values()].sort((a, b) =>
			Number(b.scope.id === this.activeScopeId) - Number(a.scope.id === this.activeScopeId));
		for (const st of ordered) {
			const items: WorkItem[] = [];
			for (const [key, u] of st.uploads) {
				if (items.length >= size) break;
				items.push({ obj: u.obj, bytes: u.bytes, upload: true });
				if (!peekOnly) st.uploads.delete(key);
			}
			if (st.grant) {
				for (const [key, obj] of st.pending) {
					if (items.length >= size) break;
					if (!this.isGranted(st, obj)) continue;
					const s = st.status?.get(key);
					const crashed = s?.crashed === true && s.fp === fingerprint(obj);
					if (crashed && items.length > 0) continue;
					items.push({ obj, upload: false });
					if (!peekOnly) {
						st.pending.delete(key);
						// Covered once: a later listing that queues it again needs a new start.
						st.grant.keys.delete(key);
					}
					if (crashed) break;
				}
			}
			if (items.length > 0) {
				return { st, items };
			}
		}
		return null;
	}

	private async waitIfPaused(): Promise<void> {
		while (this.paused && !this.cancelRequested) {
			await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
		}
	}

	private disposeBackend(): void {
		const backend = this.backend;
		this.backend = null;
		this.backendInit = null;
		this.backendBudget = null;
		if (backend) {
			void backend.dispose();
		}
	}

	/** The index-mode backend; its worker recycles itself after the idle timeout. */
	private async readyBackend(): Promise<EmbeddingBackend> {
		const cfg = this.deps.embeddingConfig();
		if (this.backend && this.backendBudget !== cfg.imageTokenBudget) {
			this.disposeBackend();
		}
		if (!this.backend) {
			const backend = this.deps.createBackend();
			if (!backend) {
				throw new EmbeddingError("runtime-verify", "The model directory is not usable");
			}
			this.backend = backend;
			this.backendBudget = cfg.imageTokenBudget;
			this.backendInit = backend.init("index", cfg);
		}
		const backend = this.backend;
		try {
			await this.backendInit;
		} catch (error) {
			if (this.backend === backend) {
				this.disposeBackend();
			}
			throw error;
		}
		return backend;
	}

	private async runLoop(): Promise<void> {
		const summaries = new Map<string, RunSummary>();
		const summaryFor = (st: ScopeState): RunSummary => {
			let s = summaries.get(st.scope.id);
			if (!s) {
				s = {
					scopeId: st.scope.id,
					indexed: 0,
					converted: 0,
					unsupported: 0,
					failed: 0,
					convertedFormats: [],
					unsupportedFormats: [],
					fromListing: false,
					cancelled: false,
				};
				summaries.set(st.scope.id, s);
			}
			return s;
		};
		let fatal: string | undefined;
		let crashes = 0;
		try {
			for (;;) {
				await this.waitIfPaused();
				if (this.cancelRequested || this.disposed) {
					break;
				}
				const batch = this.nextBatch();
				if (!batch) {
					break;
				}
				this.activeScopeId = batch.st.scope.id;
				const summary = summaryFor(batch.st);
				this.inFlight = batch.items.length;
				this.emit();
				try {
					await this.processBatch(batch.st, batch.items, summary);
					crashes = 0;
				} catch (error) {
					// Put listed objects back: they were not attempted.
					for (const item of batch.items) {
						if (!item.handled && !item.upload && batch.st.remote?.has(item.obj.key)) {
							batch.st.pending.set(item.obj.key, item.obj);
						}
					}
					this.inFlight = 0;
					if (this.cancelRequested || this.disposed) {
						break;
					}
					// The worker is gone or unusable either way; the next batch gets a new one.
					this.disposeBackend();
					if (error instanceof BatchCrashError && ++crashes < MAX_CONSECUTIVE_CRASHES) {
						// Its images were recorded as failed (retried alone, with backoff).
						this.emit();
						continue;
					}
					fatal = errorText(error);
					for (const st of this.states.values()) {
						st.grant = null;
					}
					// Do not let autoIndex retry (and download) on every listing.
					this.autoBlockedUntil = this.now() + FATAL_BACKOFF_MS;
					break;
				}
				this.inFlight = 0;
				this.emit();
			}
		} finally {
			this.inFlight = 0;
			this.currentKey = null;
			// A start authorizes one run: the grants this run saw end with it.
			// A start confirmed while finishing up made a new grant, kept for
			// the next run (kick after this one).
			const seen = new Map<ScopeState, Grant | null>();
			for (const st of this.states.values()) {
				seen.set(st, st.grant);
				st.deletedDuringRun.clear();
			}
			for (const st of this.states.values()) {
				await this.finishScope(st);
			}
			for (const [st, grant] of seen) {
				if (st.grant === grant) {
					st.grant = null;
				}
			}
			for (const summary of summaries.values()) {
				summary.cancelled = this.cancelRequested;
				if (fatal) {
					summary.error = fatal;
				}
				try {
					this.deps.onRunFinished?.(summary);
				} catch (error) {
					console.error("OSS Gallery: semantic index run report failed", error);
				}
			}
		}
	}

	/** End of a run for one scope: flush, compact, write the status. Never throws. */
	private async finishScope(st: ScopeState): Promise<void> {
		const store = st.store;
		if (store && !store.isClosed) {
			// Flush first: a compaction that fails half-way loses nothing committed.
			await store.flush().catch((error) => {
				console.error("OSS Gallery: semantic index flush failed", error);
			});
			await store.compactIfNeeded().catch((error) => {
				console.error("OSS Gallery: semantic index compaction failed", error);
			});
			if (store.isClosed && st.store === store) {
				// Reopened (and rolled forward) on next use.
				st.store = null;
			}
		}
		try {
			for (const key of st.status?.inFlightKeys() ?? []) {
				st.status?.clearInFlight(key);
			}
			st.status?.flush();
		} catch (error) {
			console.error("OSS Gallery: writing semantic index status failed", error);
		}
	}

	private recordFailure(
		st: ScopeState,
		key: string,
		fp: string,
		format: string | undefined,
		reason: string,
		summary: RunSummary | null,
		crashed = false
	): void {
		const prev = st.status?.get(key);
		const attempts = (prev && prev.status === "failed" && prev.fp === fp ? prev.attempts ?? 0 : 0) + 1;
		const backoff = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1];
		const entry: StatusEntry = { fp, status: "failed", reason, attempts, at: this.now() };
		if (format) {
			entry.format = format;
		}
		if (attempts < MAX_ATTEMPTS) {
			entry.nextRetryAt = this.now() + backoff;
		}
		if (crashed) {
			entry.crashed = true;
		}
		st.status?.set(key, entry);
		if (summary) {
			summary.failed++;
		}
	}

	private recordUnsupported(st: ScopeState, store: VectorStore, key: string, fp: string, format: string | undefined, reason: string, summary: RunSummary): void {
		const entry: StatusEntry = { fp, status: "unsupported", reason, at: this.now() };
		if (format) {
			entry.format = format;
		}
		st.status?.set(key, entry);
		store.remove(key);
		summary.unsupported++;
		if (format && !summary.unsupportedFormats.includes(format)) {
			summary.unsupportedFormats.push(format);
		}
	}

	/** Fingerprint to store for a work item. */
	private fingerprintFor(st: ScopeState, item: WorkItem): string {
		if (!item.upload) {
			return fingerprint(item.obj);
		}
		const listed = st.remote?.get(item.obj.key);
		const provisional = uploadFingerprint(item.obj.size);
		return listed && matchesUploadFingerprint(provisional, listed) ? fingerprint(listed) : provisional;
	}

	/** Wait for `work`, but give up on cancel (abort) or after `ms`. */
	private guard<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
		return raceWithTimeout(work, {
			timeoutMs: ms,
			signal: this.abort?.signal,
			timers: this.deps.timers,
			onTimeout: () => new Error(`${what} timed out after ${Math.round(ms / 1000)} s`),
		});
	}

	private cancelled(): EmbeddingError {
		return new EmbeddingError("terminated", "Cancelled");
	}

	private async processBatch(st: ScopeState, items: WorkItem[], summary: RunSummary): Promise<void> {
		const store = this.getStore(st, true);
		if (!store) {
			throw new Error("The index directory is not usable");
		}
		// Model first: a load failure must not cost any download.
		const backend = await this.readyBackend();
		if (this.cancelRequested) {
			throw this.cancelled();
		}
		// On disk before anything risky: if the app dies during this batch,
		// these keys count as an attempt on the next start (adoptInterrupted).
		try {
			st.status?.markInFlight(items.map((item) => [item.obj.key, this.fingerprintFor(st, item)]), this.now());
		} catch (error) {
			console.error("OSS Gallery: writing semantic index status failed", error);
		}
		for (const item of items) {
			st.processing.add(item.obj.key);
		}
		try {
			await this.embedBatch(st, store, backend, items, summary);
		} finally {
			for (const item of items) {
				st.processing.delete(item.obj.key);
				st.status?.clearInFlight(item.obj.key);
			}
		}
	}

	private async embedBatch(
		st: ScopeState,
		store: VectorStore,
		backend: EmbeddingBackend,
		items: WorkItem[],
		summary: RunSummary
	): Promise<void> {
		const inputs: ImageInput[] = [];
		const meta = new Map<string, { item: WorkItem; fp: string; format: string; convertedFrom?: ConvertedFormat }>();
		const prepare = (bytes: ArrayBuffer, key: string): Promise<PreparedImage> => this.deps.prepare
			? this.deps.prepare(bytes, key)
			: prepareImage(bytes, key, { rasterizeSvg: (b) => this.deps.rasterizeSvg(b) });
		const describeTooLarge = this.deps.describeTooLarge ?? describeTooLargeEn;

		for (const item of items) {
			if (this.cancelRequested) {
				throw this.cancelled();
			}
			const key = item.obj.key;
			const fp = this.fingerprintFor(st, item);
			if (!item.upload) {
				summary.fromListing = true;
			}
			this.currentKey = key;
			this.emit();
			let bytes = item.bytes;
			if (!bytes) {
				if (item.obj.size > MAX_INDEX_IMAGE_BYTES) {
					// Never downloaded or read: requestUrl / readFile buffer it all.
					this.recordUnsupported(st, store, key, fp, undefined, describeTooLarge(item.obj.size, MAX_INDEX_IMAGE_BYTES), summary);
					item.handled = true;
					this.done++;
					continue;
				}
				try {
					bytes = await this.guard(this.deps.readBytes(st.scope, item.obj, this.abort?.signal), READ_TIMEOUT_MS, "Download");
				} catch (error) {
					if (this.cancelRequested || error instanceof FetchAbortedError) {
						throw this.cancelled();
					}
					if (error instanceof RemoteFetchError && error.kind === "too-large") {
						this.recordUnsupported(st, store, key, fp, undefined, error.message, summary);
					} else {
						// Remote fetch errors carry a user-facing reason already.
						const reason = error instanceof RemoteFetchError ? error.message : `Download: ${errorText(error)}`;
						this.recordFailure(st, key, fp, undefined, reason, summary);
					}
					item.handled = true;
					this.done++;
					continue;
				}
			}
			let prepared: PreparedImage;
			try {
				prepared = await this.guard(prepare(bytes, key), PREPARE_TIMEOUT_MS, "Preparing the image");
			} catch (error) {
				if (this.cancelRequested || error instanceof FetchAbortedError) {
					throw this.cancelled();
				}
				this.recordFailure(st, key, fp, undefined, errorText(error), summary);
				item.handled = true;
				this.done++;
				continue;
			}
			if (prepared.kind === "unsupported") {
				this.recordUnsupported(st, store, key, fp, prepared.format, prepared.reason, summary);
				item.handled = true;
				this.done++;
				continue;
			}
			if (prepared.kind === "failed") {
				this.recordFailure(st, key, fp, prepared.format, prepared.reason, summary);
				item.handled = true;
				this.done++;
				continue;
			}
			inputs.push({ id: key, bytes: prepared.bytes, mime: prepared.mime });
			meta.set(key, { item, fp, format: prepared.format, convertedFrom: prepared.convertedFrom });
		}
		if (inputs.length === 0) {
			return;
		}
		if (this.cancelRequested) {
			throw this.cancelled();
		}
		let results: Awaited<ReturnType<EmbeddingBackend["embedImages"]>>;
		try {
			results = await backend.embedImages(inputs);
		} catch (error) {
			if (this.cancelRequested || this.disposed) {
				throw error;
			}
			// The worker crashed or hung with these images: each gets a failed
			// attempt (backoff, MAX_ATTEMPTS, retried alone), so a poison image
			// is not downloaded and retried forever.
			const reason = errorText(error);
			for (const [key, m] of meta) {
				this.recordFailure(st, key, m.fp, m.format, reason, summary, true);
				m.item.handled = true;
				this.done++;
			}
			throw new BatchCrashError(reason);
		}
		for (const result of results) {
			const m = meta.get(result.id);
			if (!m) {
				continue;
			}
			this.done++;
			const key = result.id;
			if (st.deletedDuringRun.has(key)) {
				continue;
			}
			if (result.ok) {
				store.upsert(key, m.fp, result.vector);
				summary.indexed++;
				if (m.convertedFrom) {
					st.status?.set(key, { fp: m.fp, status: "converted", format: m.convertedFrom, at: this.now() });
					summary.converted++;
					if (!summary.convertedFormats.includes(m.convertedFrom)) {
						summary.convertedFormats.push(m.convertedFrom);
					}
				} else {
					st.status?.delete(key);
				}
			} else {
				this.recordFailure(st, key, m.fp, m.format, `${result.code}: ${result.message}`, summary);
			}
		}
	}
}
