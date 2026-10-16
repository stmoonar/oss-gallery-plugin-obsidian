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
import { RemoteFetchError } from "./remoteBytes";
import { headerFromConfig, META_FILE, sameHeader, scopeIndexDir, VectorStore, VectorStoreOptions } from "./VectorStore";
import type { Timers } from "./WorkerEmbeddingBackend";

/** §7.3: purge after this many consecutive complete listings without the key... */
export const PURGE_AFTER_MISSES = 2;
/** ...or after it has been missing this long. */
export const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** §9.4: with autoIndex, runs above this estimate ask again. */
export const AUTO_CONFIRM_LIMIT_BYTES = 200 * 1000 * 1000;
/** Failed objects are retried this many times in total (until they change). */
export const MAX_ATTEMPTS = 3;
/** Wait before retry n (1-based) of a failed object. */
export const RETRY_BACKOFF_MS = [60_000, 10 * 60_000];

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
 */
export function trafficPromptReason(o: {
	local: boolean;
	pendingCount: number;
	auto: boolean;
	confirmedBefore: boolean;
	pendingBytes: number;
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
	return o.pendingBytes > AUTO_CONFIRM_LIMIT_BYTES ? "auto-large" : null;
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
	/** Bytes of a listed object: Local = disk, remote = download. */
	readBytes(scope: IndexScope, obj: OssImage): Promise<ArrayBuffer>;
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
	/** The user started (and, for remote, confirmed) indexing this session. */
	authorized: boolean;
	/** autoIndex already asked this session (and was declined or not answered yet). */
	autoPrompted: boolean;
	/** Keys deleted while a batch was in flight: their results are dropped. */
	deletedDuringRun: Set<string>;
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
				authorized: false,
				autoPrompted: false,
				deletedDuringRun: new Set(),
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
		st.store = VectorStore.open(dir, header, {
			asyncIo: true,
			timers: this.deps.timers,
			...this.deps.storeOptions,
		});
		st.status = IndexStatusStore.open(dir, {
			timers: this.deps.timers,
			flushDelayMs: this.deps.statusFlushDelayMs,
		});
		if (st.store.openResult.status === "reset") {
			st.status.dropEmbeddingResults();
		}
		// Pending work was computed without the store's knowledge.
		if (st.remote) {
			this.recomputePending(st);
		}
		return st.store;
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
		st.remote = new Map(r.items.map((o) => [o.key, o]));

		const store = this.getStore(st, false);
		if (store && r.complete) {
			this.applyDeletions(st, store, r.prefix);
		}
		if (store && r.complete && st.status) {
			for (const key of st.status.keys()) {
				if (key.startsWith(r.prefix) && !st.remote.has(key) && !store.has(key)) {
					st.status.delete(key);
				}
			}
		}
		this.recomputePending(st);
		this.emit();
		this.maybeAutoStart(st);
		return true;
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
			if (st.uploads.has(obj.key)) {
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
		const store = this.getStore(st, false);
		store?.remove(key);
		st.status?.delete(key);
		this.emit();
	}

	// ---- estimate / start / pause / cancel ----------------------------------

	estimate(scope: IndexScope): TrafficEstimate {
		const st = this.state(scope);
		let pendingBytes = 0;
		let unknownSizeCount = 0;
		for (const obj of st.pending.values()) {
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
			pendingCount: st.pending.size,
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
		const estimate = this.estimate(scope);
		const reason = trafficPromptReason({
			local: scope.local,
			pendingCount: estimate.pendingCount,
			auto: options.auto === true,
			confirmedBefore: st.status?.confirmedAt !== undefined,
			pendingBytes: estimate.pendingBytes,
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
			if (!ok || this.disposed) {
				return false;
			}
			st.autoPrompted = false;
			st.status?.setConfirmed(this.now());
		}
		st.authorized = true;
		this.kick();
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
			st.status?.flush();
			this.recomputePending(st);
			this.emit();
		}
		return count;
	}

	private maybeAutoStart(st: ScopeState): void {
		if (st.pending.size === 0 || st.authorized || !this.deps.autoIndex() || !this.deps.isReady()) {
			return;
		}
		void this.start(st.scope, { auto: true });
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
			st.authorized = false;
		}
		if (!this.running) {
			return;
		}
		this.cancelRequested = true;
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
				st.authorized = false;
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
			remaining += st.uploads.size + (st.authorized ? st.pending.size : 0);
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
		const run = this.runLoop().finally(() => {
			if (this.running === run) {
				this.running = null;
			}
			this.activeScopeId = null;
			this.paused = false;
			this.emit();
			// Work queued while finishing up (e.g. an upload) starts a new run.
			if (!this.cancelRequested) {
				this.kick();
			}
		});
		this.running = run;
		this.emit();
	}

	/** Uploads first, then pending objects of authorized scopes. */
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
			if (st.authorized) {
				for (const [key, obj] of st.pending) {
					if (items.length >= size) break;
					items.push({ obj, upload: false });
					if (!peekOnly) st.pending.delete(key);
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
					fatal = errorText(error);
					for (const st of this.states.values()) {
						st.authorized = false;
					}
					this.disposeBackend();
					break;
				}
				this.inFlight = 0;
				this.emit();
			}
		} finally {
			this.inFlight = 0;
			this.currentKey = null;
			for (const st of this.states.values()) {
				// A start authorizes one run; later listings need a new start
				// (or autoIndex, which applies its own confirmation rules).
				st.authorized = false;
				st.deletedDuringRun.clear();
				if (st.store) {
					await st.store.compactIfNeeded().catch((error) => {
						console.error("OSS Gallery: semantic index compaction failed", error);
					});
					await st.store.flush().catch((error) => {
						console.error("OSS Gallery: semantic index flush failed", error);
					});
				}
				st.status?.flush();
			}
			for (const summary of summaries.values()) {
				summary.cancelled = this.cancelRequested;
				if (fatal) {
					summary.error = fatal;
				}
				this.deps.onRunFinished?.(summary);
			}
		}
	}

	private recordFailure(st: ScopeState, key: string, fp: string, format: string | undefined, reason: string, summary: RunSummary): void {
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
		st.status?.set(key, entry);
		summary.failed++;
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

	private async processBatch(st: ScopeState, items: WorkItem[], summary: RunSummary): Promise<void> {
		const store = this.getStore(st, true);
		if (!store) {
			throw new Error("The index directory is not usable");
		}
		const inputs: ImageInput[] = [];
		const meta = new Map<string, { item: WorkItem; fp: string; format: string; convertedFrom?: ConvertedFormat }>();
		const prepare = (bytes: ArrayBuffer, key: string): Promise<PreparedImage> => this.deps.prepare
			? this.deps.prepare(bytes, key)
			: prepareImage(bytes, key, { rasterizeSvg: (b) => this.deps.rasterizeSvg(b) });

		for (const item of items) {
			if (this.cancelRequested) {
				throw new EmbeddingError("terminated", "Cancelled");
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
				try {
					bytes = await this.deps.readBytes(st.scope, item.obj);
				} catch (error) {
					// Remote fetch errors carry a user-facing reason already.
					const reason = error instanceof RemoteFetchError ? error.message : `Download: ${errorText(error)}`;
					this.recordFailure(st, key, fp, undefined, reason, summary);
					item.handled = true;
					this.done++;
					continue;
				}
			}
			const prepared = await prepare(bytes, key);
			if (prepared.kind === "unsupported") {
				st.status?.set(key, { fp, status: "unsupported", format: prepared.format, reason: prepared.reason, at: this.now() });
				store.remove(key);
				summary.unsupported++;
				if (!summary.unsupportedFormats.includes(prepared.format)) {
					summary.unsupportedFormats.push(prepared.format);
				}
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
			throw new EmbeddingError("terminated", "Cancelled");
		}
		const backend = await this.readyBackend();
		const results = await backend.embedImages(inputs);
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
