/**
 * Obsidian glue for semantic indexing (docs/semantic-search.md §4.5–§4.7, §9):
 * builds index scopes from the registry, owns the SemanticIndexService and
 * SemanticSearchService, supplies bytes (Local: disk, remote: requestUrl),
 * the traffic dialog, notices, the status bar item and everything the
 * gallery view needs (availability, search, index bar, details dialog).
 */
import { App, FileSystemAdapter, Notice, requestUrl } from "obsidian";
import { t } from "../i18n";
import { semanticBarVisible, shouldStopIndexing, SemanticAvailability } from "../components/searchMode";
import {
	SemanticClearIndexModal,
	SemanticIndexDetailsModal,
	SemanticTrafficModal,
} from "../modals/SemanticIndexModals";
import { isImageFile } from "../providers/shared/image";
import { LocalProvider } from "../providers/LocalProvider";
import type { OssProviderManager } from "../providers/OssProviderManager";
import { providerRegistry } from "../providers/registry";
import type { IOssProvider, ListResult, OssImage } from "../types/oss";
import type { PluginSettings } from "../types/settings";
import type { ThumbnailWriter } from "../thumbnails/ThumbnailCache";
import { IndexScope, makeIndexScope } from "./fingerprint";
import { clearVaultIndex, ClearResult, vaultIdFor, vaultIndexSize } from "./indexFiles";
import { resolveIndexDir, ResolvedModelDir } from "./modelDir";
import { formatBytes, formatMegabytes, formatPercent } from "./format";
import { AbortSignalLike, fetchRemoteImageBytes, FailureDescriber, TooLargeDescriber } from "../services/remoteBytes";
import type { SemanticController } from "./SemanticController";
import { IndexProgress, IndexStats, RunSummary, SemanticIndexService } from "./SemanticIndexService";
import { SemanticHit, SemanticSearchService } from "./SemanticSearchService";
import { formatCount, formatIndexSize, formatIndexSummary } from "./statusText";
import { rasterizeSvg } from "./svgRasterizer";
import { openPluginSettings } from "../utils/openPluginSettings";

/** Index state shown in the gallery's semantic bar. */
export interface GalleryIndexState {
	progress: IndexProgress;
	/** The running/paused run belongs to this gallery's scope. */
	runningHere: boolean;
	/** null = this scope has no index yet. */
	stats: IndexStats | null;
	/** Listed objects not indexed yet (from the last listing). */
	pending: number;
	/** Last failure of a listing/upload/delete hook (null = none). Never breaks the gallery. */
	error: string | null;
}

/** What OssGalleryView uses: listing hooks plus the semantic UI. */
export interface GallerySemanticHooks {
	/**
	 * Before listImages; null when the feature isn't usable here (not
	 * installed / off / no WebGPU / provider not indexable). Never throws.
	 */
	beginListing(providerName: string, listPrefix: string): { token: number; scope: IndexScope } | null;
	/** Never throws: index failures only show in the semantic bar. */
	reconcile(ticket: { token: number; scope: IndexScope }, listing: ListResult): void;
	/** Never throws. */
	onDeleted(providerName: string, listPrefix: string, key: string): void;

	availability(providerName: string, listPrefix: string): SemanticAvailability;
	/** null = hide the semantic bar (feature not usable here, see `semanticBarVisible`). */
	indexState(providerName: string, listPrefix: string): GalleryIndexState | null;
	summaryText(stats: IndexStats): string;
	searchText(providerName: string, listPrefix: string, query: string, listed: OssImage[]): Promise<SemanticHit[]>;
	searchSimilar(providerName: string, listPrefix: string, key: string, listed: OssImage[]): SemanticHit[];
	isIndexed(providerName: string, listPrefix: string, key: string): boolean;
	isQueryWarm(): boolean;
	/** "Build / update index" (traffic dialog for remote providers). Never rejects. */
	startIndexing(providerName: string, listPrefix: string): Promise<void>;
	pause(): void;
	resume(): void;
	cancel(): void;
	openDetails(providerName: string, listPrefix: string, onReveal: (key: string) => void): void;
	/** Anything above may have changed (progress, install state, settings). */
	subscribe(listener: () => void): () => void;
}

export interface SemanticIndexingHost {
	app: App;
	/** The plugin's manifest (its id opens the plugin's settings tab). */
	manifest: { id: string };
	settings: PluginSettings;
	providerManager: OssProviderManager;
	semantic: SemanticController;
	/** The gallery list prefix (global base path + '/', or ''). */
	getGalleryListPrefix(): string;
	/** Open (or focus) the gallery, optionally switching it to semantic mode. */
	openGalleryView(options?: { semantic?: boolean }): Promise<void>;
	/**
	 * Local gallery thumbnails (src/thumbnails): indexing hands it the
	 * thumbnails the worker makes from the decoded images, nothing else.
	 */
	thumbnailWriter(): ThumbnailWriter | null;
}

const FORMAT_LABELS: Record<string, string> = {
	svg: "SVG",
	tiff: "TIFF",
	heic: "HEIC",
	psd: "PSD",
	raw: "RAW",
	unknown: "?",
};

function formatList(formats: string[]): string {
	return formats.map((f) => FORMAT_LABELS[f] ?? f.toUpperCase()).join("/");
}

/** Localized reasons for remote download failures (status details). */
const describeFetchFailure: FailureDescriber = (kind, status, detail) => {
	const code = String(status ?? "?");
	switch (kind) {
		case "access-denied":
			return t("Fetch access denied").replace("{status}", code);
		case "not-found":
			return t("Fetch not found");
		case "http":
			return t("Fetch http error").replace("{status}", code);
		case "network":
			return t("Fetch network error").replace("{message}", detail);
		case "no-url":
			return t("Fetch no url");
	}
};

/** Localized reason for images over the indexing size limit (status details). */
const describeTooLarge: TooLargeDescriber = (bytes, limit) =>
	t("Fetch too large").replace("{size}", formatBytes(bytes)).replace("{limit}", formatBytes(limit));

/** Coalesce change notifications (download progress fires per chunk). */
const NOTIFY_DELAY_MS = 100;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Provider + index scope captured when an upload starts (see `uploadTarget`). */
export interface UploadIndexTarget {
	provider: IOssProvider;
	scope: IndexScope;
}

export class SemanticIndexing {
	readonly index: SemanticIndexService;
	readonly search: SemanticSearchService;
	readonly vaultId: string;
	private lastScopeId: string | null = null;
	private lastIndexDir: string;
	private lastBudget: number;
	private statusBar: HTMLElement | null = null;
	private readonly listeners = new Set<() => void>();
	private notifyTimer: number | null = null;
	private readonly unsubscribers: Array<() => void> = [];
	/** Indexing may run (enabled + model usable); false stops a running index. */
	private indexingAllowed: boolean;
	/** Last listing/upload/delete hook failure, shown in the gallery's semantic bar. */
	private hookError: string | null = null;

	constructor(private readonly host: SemanticIndexingHost) {
		const adapter = host.app.vault.adapter;
		const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : host.app.vault.getName();
		const appId = (host.app as unknown as { appId?: unknown }).appId;
		this.vaultId = vaultIdFor(appId, basePath);
		this.lastIndexDir = host.settings.semantic.indexDir;
		this.lastBudget = host.settings.semantic.imageTokenBudget;

		this.index = new SemanticIndexService({
			indexRoot: () => {
				const dir = this.getIndexDir();
				return dir.ok ? dir.dir : null;
			},
			vaultId: this.vaultId,
			embeddingConfig: () => host.semantic.embeddingConfig(),
			isEnabled: () => host.settings.semantic.enabled,
			isReady: () => host.semantic.isReady(),
			autoIndex: () => host.settings.semantic.autoIndex,
			createBackend: () => host.semantic.createBackend("index"),
			readBytes: (scope, obj, signal) => this.readBytes(scope, obj, signal),
			describeTooLarge,
			interruptedReason: () => t("Index interrupted"),
			rasterizeSvg: (bytes) => rasterizeSvg(bytes),
			confirmTraffic: (scope, estimate, reason) =>
				SemanticTrafficModal.ask(host.app, providerRegistry.getLabel(scope.providerId, host.app), estimate, reason),
			onRunFinished: (summary) => this.reportRun(summary),
			thumbnails: host.thumbnailWriter(),
			thumbnailsEnabled: () => host.settings.thumbnails.enabled,
		});
		this.search = new SemanticSearchService({
			getStore: (scope) => this.index.getSearchStore(scope),
			createQueryBackend: () => host.semantic.createBackend("query"),
			embeddingConfig: () => host.semantic.embeddingConfig(),
		});
		this.unsubscribers.push(this.index.onProgress(() => this.notify()));
		this.unsubscribers.push(host.semantic.manager.subscribe(() => {
			this.checkIndexingAllowed();
			this.notify();
		}));
		this.lastScopeId = this.currentScope()?.id ?? null;
		this.indexingAllowed = !this.indexingMustStop();
	}

	private indexingMustStop(): boolean {
		return shouldStopIndexing(this.host.settings.semantic.enabled, this.host.semantic.getState().kind);
	}

	/**
	 * Feature turned off, model deleted / broken: stop the running index (no
	 * more downloads) and the query worker. The gallery hides the semantic
	 * bar then, so nothing else could stop the run.
	 */
	private checkIndexingAllowed(): void {
		const allowed = !this.indexingMustStop();
		if (allowed === this.indexingAllowed) {
			return;
		}
		this.indexingAllowed = allowed;
		if (!allowed) {
			this.index.cancel();
			this.search.dispose();
		}
	}

	/** Run a listing/upload/delete hook; failures are logged and shown in the bar only. */
	private guardHook<T>(what: string, fn: () => T, fallback: T): T {
		try {
			return fn();
		} catch (error) {
			this.reportHookError(what, error);
			return fallback;
		}
	}

	private reportHookError(what: string, error: unknown): void {
		console.error(`OSS Gallery: semantic ${what} failed`, error);
		this.hookError = errorMessage(error);
		this.notify();
	}

	private clearHookError(): void {
		if (this.hookError !== null) {
			this.hookError = null;
			this.notify();
		}
	}

	getIndexDir(): ResolvedModelDir {
		return resolveIndexDir(this.host.settings.semantic.indexDir);
	}

	/** Index scope of a provider's current settings, or null if it can't be indexed. */
	scopeFor(providerId: string, listPrefix: string): IndexScope | null {
		const identity = providerRegistry.getIndexIdentity(
			providerId,
			this.host.settings.providers[providerId as keyof PluginSettings["providers"]],
			this.host.app
		);
		return identity ? makeIndexScope(providerId, identity, listPrefix) : null;
	}

	currentScope(): IndexScope | null {
		return this.scopeFor(this.host.settings.activeProvider, this.host.getGalleryListPrefix());
	}

	/**
	 * Local: straight from disk. Remote: Obsidian's requestUrl (no CORS, system
	 * proxy) on the listed URL, then a signed GET where the provider can sign
	 * (private S3 / R2 / MinIO buckets).
	 */
	private async readBytes(scope: IndexScope, obj: OssImage, signal?: AbortSignalLike): Promise<ArrayBuffer> {
		if (scope.local) {
			const provider = this.host.providerManager.getProvider("local");
			if (!(provider instanceof LocalProvider)) {
				throw new Error("Local provider is not available");
			}
			return provider.readObjectBytes(obj.key);
		}
		const provider = this.host.providerManager.getProvider(scope.providerId);
		const signer = provider?.signedObjectGet?.bind(provider);
		return fetchRemoteImageBytes(obj, {
			request: (request) => requestUrl(request),
			signedGet: signer,
			describe: describeFetchFailure,
			describeTooLarge,
			signal,
		});
	}

	// ---- change notifications -----------------------------------------------

	private notify(): void {
		if (this.notifyTimer !== null) {
			return;
		}
		this.notifyTimer = window.setTimeout(() => {
			this.notifyTimer = null;
			this.renderStatusBar();
			for (const listener of [...this.listeners]) {
				try {
					listener();
				} catch (error) {
					console.error("OSS Gallery: semantic listener failed", error);
				}
			}
		}, NOTIFY_DELAY_MS);
	}

	// ---- gallery hooks -------------------------------------------------------

	/** Why semantic search can't be used for this provider right now, if so. */
	availability(providerName: string, listPrefix: string): SemanticAvailability {
		const kind = this.host.semantic.getState().kind;
		if (kind === "unsupported") {
			return { ok: false, reason: "webgpu" };
		}
		if (!this.host.settings.semantic.enabled) {
			return { ok: false, reason: kind === "installed" ? "disabled" : kind === "checking" ? "checking" : "not-installed" };
		}
		if (kind === "checking" || kind === "verifying") {
			return { ok: false, reason: "checking" };
		}
		if (kind !== "installed") {
			return { ok: false, reason: "not-installed" };
		}
		if (!providerRegistry.supports(providerName, "list", this.host.app)) {
			return { ok: false, reason: "no-list" };
		}
		const scope = this.scopeFor(providerName, listPrefix);
		if (!scope) {
			return { ok: false, reason: "no-list" };
		}
		if (!this.index.hasIndex(scope)) {
			return { ok: false, reason: "no-index" };
		}
		const p = this.index.getProgress();
		return { ok: true, indexing: p.state !== "idle" && p.scopeId === scope.id };
	}

	summaryText(stats: IndexStats): string {
		return formatIndexSummary(stats, {
			indexed: t("Semantic chip indexed"),
			converted: t("Semantic chip converted"),
			unsupported: t("Semantic chip unsupported"),
			failed: t("Semantic chip failed"),
			pending: t("Semantic chip pending"),
			separator: " · ",
		});
	}

	galleryHooks(): GallerySemanticHooks {
		const scopeOrNull = (providerName: string, listPrefix: string) => this.scopeFor(providerName, listPrefix);
		return {
			beginListing: (providerName, listPrefix) => this.guardHook("listing", () => {
				if (!semanticBarVisible(this.availability(providerName, listPrefix))) {
					return null;
				}
				const scope = scopeOrNull(providerName, listPrefix);
				return scope ? { token: this.index.beginListing(scope), scope } : null;
			}, null),
			reconcile: (ticket, listing) => {
				this.guardHook("reconcile", () => {
					this.index.reconcile(ticket.token, ticket.scope, listing);
					this.clearHookError();
				}, undefined);
			},
			onDeleted: (providerName, listPrefix, key) => {
				this.guardHook("delete", () => {
					const scope = scopeOrNull(providerName, listPrefix);
					if (scope) {
						this.index.onDeleted(scope, key);
					}
				}, undefined);
			},
			availability: (providerName, listPrefix) => this.availability(providerName, listPrefix),
			indexState: (providerName, listPrefix) => {
				if (!semanticBarVisible(this.availability(providerName, listPrefix))) {
					return null;
				}
				const scope = scopeOrNull(providerName, listPrefix);
				if (!scope) {
					return null;
				}
				const progress = this.index.getProgress();
				const runningHere = progress.state !== "idle" && progress.scopeId === scope.id;
				const stats = this.index.hasIndex(scope) ? this.index.getStats(scope) : null;
				return {
					progress,
					runningHere,
					stats,
					pending: this.index.estimate(scope).pendingCount,
					error: this.hookError,
				};
			},
			summaryText: (stats) => this.summaryText(stats),
			searchText: async (providerName, listPrefix, query, listed) => {
				const scope = scopeOrNull(providerName, listPrefix);
				return scope ? this.search.searchByTextScored(scope, query, listed) : [];
			},
			searchSimilar: (providerName, listPrefix, key, listed) => {
				const scope = scopeOrNull(providerName, listPrefix);
				return scope ? this.search.searchSimilarScored(scope, key, listed) : [];
			},
			isIndexed: (providerName, listPrefix, key) => {
				const scope = scopeOrNull(providerName, listPrefix);
				return scope !== null && this.index.hasIndex(scope) && this.index.isIndexed(scope, key);
			},
			isQueryWarm: () => this.search.isWarm(),
			startIndexing: async (providerName, listPrefix) => {
				const scope = scopeOrNull(providerName, listPrefix);
				const provider = this.host.providerManager.getProvider(providerName);
				if (scope && provider) {
					await this.startIndexing(provider, scope, false);
				}
			},
			pause: () => this.index.pause(),
			resume: () => this.index.resume(),
			cancel: () => this.index.cancel(),
			openDetails: (providerName, listPrefix, onReveal) => {
				const scope = scopeOrNull(providerName, listPrefix);
				const provider = this.host.providerManager.getProvider(providerName);
				if (!scope || !provider) {
					return;
				}
				new SemanticIndexDetailsModal(this.host.app, {
					providerLabel: providerRegistry.getLabel(providerName, this.host.app),
					getStats: () => (this.index.hasIndex(scope) ? this.index.getStats(scope) : null),
					sizeText: () => this.indexSizeText(scope.id),
					summary: (stats) => this.summaryText(stats),
					onReveal,
					onRetryFailed: this.index.isRunning()
						? null
						: () => {
							this.index.resetFailed(scope);
							void this.startIndexing(provider, scope, false);
						},
				}).open();
			},
			subscribe: (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			},
		};
	}

	/**
	 * Capture where an upload goes when it starts (provider instance + index
	 * scope): the active provider or base path may change before it ends.
	 * Never throws.
	 */
	uploadTarget(provider: IOssProvider | null | undefined): UploadIndexTarget | null {
		if (!provider) {
			return null;
		}
		return this.guardHook("upload", () => {
			const scope = this.scopeFor(provider.name, this.host.getGalleryListPrefix());
			return scope ? { provider, scope } : null;
		}, null);
	}

	/**
	 * An in-plugin upload succeeded: index it from the file in hand, under
	 * the provider/scope captured at upload start. Never rejects.
	 */
	async onUploaded(target: UploadIndexTarget | null, objectName: string, file: File): Promise<void> {
		if (!target || !this.host.semantic.isReady() || !file.type.startsWith("image/")) {
			return;
		}
		try {
			const { provider, scope } = target;
			const key = provider.listingKeyForUpload?.(objectName) ?? null;
			if (!key || !isImageFile(key) || !this.index.hasIndex(scope)) {
				return;
			}
			const bytes = await file.arrayBuffer();
			this.index.onUploaded(scope, { key, url: "", size: file.size, lastModified: new Date() }, bytes);
		} catch (error) {
			this.reportHookError("upload indexing", error);
		}
	}

	/**
	 * Settings changed: a new active scope cancels other scopes' work; a new
	 * index directory or token budget closes the stores (they reopen at the
	 * new place / reset for the new header).
	 */
	onSettingsChanged(): void {
		this.checkIndexingAllowed();
		const semantic = this.host.settings.semantic;
		if (semantic.indexDir !== this.lastIndexDir || semantic.imageTokenBudget !== this.lastBudget) {
			this.lastIndexDir = semantic.indexDir;
			this.lastBudget = semantic.imageTokenBudget;
			this.index.closeAll();
			this.search.dispose();
		}
		const scopeId = this.currentScope()?.id ?? null;
		if (scopeId !== this.lastScopeId) {
			this.lastScopeId = scopeId;
			this.hookError = null;
			this.index.onScopeChanged(scopeId);
		}
		this.notify();
	}

	// ---- indexing entry points -------------------------------------------

	private activeProvider(): { provider: IOssProvider; scope: IndexScope } | null {
		const provider = this.host.providerManager.getActiveProvider();
		const scope = this.currentScope();
		if (!provider || !scope) {
			new Notice(t("Semantic index not available for provider"));
			return null;
		}
		return { provider, scope };
	}

	/** List the provider and reconcile (same protocol as the gallery). */
	private async listNow(provider: IOssProvider, scope: IndexScope): Promise<boolean> {
		const token = this.index.beginListing(scope);
		const listing = await provider.listImages(scope.listPrefix || undefined);
		return this.index.reconcile(token, scope, listing);
	}

	/** `scope` is still the active provider's scope (settings may change during awaits). */
	private isCurrentScope(scope: IndexScope): boolean {
		return this.currentScope()?.id === scope.id;
	}

	/**
	 * Manual start ("Build / update index", "Retry failed", the command).
	 * Lists first when asked to (command) or when nothing was listed yet;
	 * remote providers always show the traffic dialog (§9.4). Never rejects.
	 */
	private async startIndexing(provider: IOssProvider, scope: IndexScope, relist: boolean): Promise<void> {
		try {
			await this.startIndexingUnchecked(provider, scope, relist);
		} catch (error) {
			console.error("OSS Gallery: starting semantic indexing failed", error);
			new Notice(t("Semantic indexing failed").replace("{message}", errorMessage(error)), 10000);
			this.notify();
		}
	}

	private async startIndexingUnchecked(provider: IOssProvider, scope: IndexScope, relist: boolean): Promise<void> {
		if (!(await this.ensureReady()) || !this.isCurrentScope(scope)) {
			return;
		}
		if (this.index.isRunning()) {
			new Notice(t("Semantic indexing already running"));
			return;
		}
		if (relist || !this.index.getRemote(scope)) {
			try {
				await this.listNow(provider, scope);
			} catch (error) {
				new Notice(`${t("Load failed")}: ${errorMessage(error)}`);
				return;
			}
		}
		// The active provider / base path changed while we listed: never ask
		// for (or start) traffic on a provider that is no longer active.
		if (!this.isCurrentScope(scope)) {
			return;
		}
		const estimate = this.index.estimate(scope);
		if (estimate.pendingCount === 0) {
			// Creates the (empty) index so search becomes available.
			await this.index.start(scope);
			new Notice(t("Semantic index up to date").replace("{count}", formatCount(estimate.indexedCount)));
			this.notify();
			return;
		}
		const started = await this.index.start(scope);
		if (started) {
			new Notice(t("Semantic indexing started").replace("{count}", formatCount(estimate.pendingCount)));
		}
		this.notify();
	}

	/** Command "Semantic search: index current provider now". Never rejects. */
	async indexNow(): Promise<void> {
		let active: { provider: IOssProvider; scope: IndexScope } | null;
		try {
			active = this.activeProvider();
		} catch (error) {
			console.error("OSS Gallery: semantic index scope failed", error);
			new Notice(t("Semantic indexing failed").replace("{message}", errorMessage(error)), 10000);
			return;
		}
		if (active) {
			await this.startIndexing(active.provider, active.scope, true);
		}
	}

	/** Ready to index; otherwise a notice says what to do first. */
	private async ensureReady(): Promise<boolean> {
		const state = await this.host.semantic.refresh();
		if (this.host.settings.semantic.enabled && state.kind === "installed") {
			return true;
		}
		switch (state.kind) {
			case "installed":
				// Installed but switched off.
				new Notice(t("Semantic turn on in settings"));
				break;
			case "unsupported":
				new Notice(t("Semantic self-test needs WebGPU"));
				break;
			case "checking":
			case "downloading":
			case "verifying":
			case "deleting":
				new Notice(t("Semantic model busy"));
				break;
			case "needs-repair":
				new Notice(t("Semantic search files need repair"));
				break;
			default:
				new Notice(t("Semantic self-test needs installed model"));
				break;
		}
		return false;
	}

	// ---- settings ----------------------------------------------------------

	statsForCurrentScope(): IndexStats | null {
		const scope = this.currentScope();
		return scope && this.index.hasIndex(scope) ? this.index.getStats(scope) : null;
	}

	/**
	 * What a new image detail would rebuild for the active provider: its
	 * indexed count and the last listing (sizes for the download estimate).
	 * null when the provider cannot be indexed.
	 */
	rebuildInputs(): { indexed: number; listed: OssImage[] | null; local: boolean } | null {
		const scope = this.currentScope();
		if (!scope) {
			return null;
		}
		const indexed = this.index.hasIndex(scope) ? this.index.getStats(scope).indexed : 0;
		return { indexed, listed: this.index.getRemote(scope), local: scope.local };
	}

	/**
	 * On-disk size of this vault's index files ("5.19 MB on disk; 7.40 MB
	 * for this vault"): the files "Clear index" would delete, for the scope
	 * `scopeId` and for all scopes of the vault. '' when there are none or
	 * the index directory can't be read.
	 */
	indexSizeText(scopeId: string | null): string {
		const dir = this.getIndexDir();
		if (!dir.ok) {
			return "";
		}
		try {
			return formatIndexSize(vaultIndexSize(dir.dir, this.vaultId), scopeId, {
				single: t("Index size single"),
				split: t("Index size split"),
				othersOnly: t("Index size others only"),
			}, formatMegabytes);
		} catch (error) {
			console.warn("Semantic index size could not be read:", error);
			return "";
		}
	}

	/** Ask, then delete this vault's index files under the index directory. */
	confirmClearIndex(onDone: () => void): void {
		const dir = this.getIndexDir();
		if (!dir.ok) {
			return;
		}
		new SemanticClearIndexModal(this.host.app, `${dir.dir}/${this.vaultId}`.replace(/\\/g, "/"), () => {
			const result = this.clearIndex();
			if (result) {
				new Notice(result.failed.length > 0
					? `${t("Some index files could not be deleted")}: ${result.failed.join(", ")}`
					: t("Semantic index cleared"));
			}
			onDone();
		}).open();
	}

	clearIndex(): ClearResult | null {
		const dir = this.getIndexDir();
		if (!dir.ok) {
			return null;
		}
		this.index.closeAll();
		const result = clearVaultIndex(dir.dir, this.vaultId);
		this.notify();
		return result;
	}

	// ---- status bar & reports ------------------------------------------------

	attachStatusBar(el: HTMLElement): void {
		this.statusBar = el;
		el.addClass("oss-gallery-semantic-status");
		el.setAttribute("role", "button");
		el.setAttribute("tabindex", "0");
		const activate = () => {
			if (this.isModelBusy()) {
				this.openSettings();
				return;
			}
			const p = this.index.getProgress();
			if (p.state === "paused") {
				this.index.resume();
			} else if (p.state === "running") {
				this.index.pause();
			} else {
				void this.host.openGalleryView({ semantic: true });
			}
		};
		el.addEventListener("click", activate);
		el.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				activate();
			}
		});
		this.renderStatusBar();
	}

	/** Model download / verification running (shown in the status bar). */
	private isModelBusy(): boolean {
		const kind = this.host.semantic.getState().kind;
		return kind === "downloading" || kind === "verifying";
	}

	/** Open this plugin's tab in Obsidian's settings (download progress lives there). */
	private openSettings(): void {
		openPluginSettings(this.host.app, this.host.manifest.id);
	}

	/**
	 * Model download: "Model download 42%" (click opens the settings tab).
	 * Indexing: "Indexing 12/340 · click to pause" (click pauses/resumes).
	 * Hidden when nothing is happening; index statistics are in the
	 * settings tab and the gallery.
	 */
	private renderStatusBar(): void {
		const el = this.statusBar;
		if (!el) {
			return;
		}
		const install = this.host.semantic.getState();
		if (install.kind === "downloading" || install.kind === "verifying") {
			el.show();
			const template = install.kind === "downloading" ? t("Status model download") : t("Status model verifying");
			el.setText(template.replace("{percent}", formatPercent(install.bytesDone, install.bytesTotal)));
			el.setAttribute("aria-label", t("Status open settings"));
			return;
		}
		const p = this.index.getProgress();
		if (p.state !== "idle") {
			el.show();
			const paused = p.state === "paused";
			el.setText((paused ? t("Status indexing paused") : t("Status indexing running"))
				.replace("{done}", formatCount(p.done))
				.replace("{total}", formatCount(p.total)));
			el.setAttribute("aria-label", paused ? t("Click to resume") : t("Click to pause"));
			return;
		}
		el.hide();
	}

	private reportRun(summary: RunSummary): void {
		if (summary.error) {
			new Notice(t("Semantic indexing failed").replace("{message}", summary.error), 10000);
			return;
		}
		const issues = summary.converted + summary.unsupported + summary.failed > 0;
		if (!summary.fromListing && !issues) {
			return;
		}
		const parts: string[] = [];
		if (summary.converted > 0) {
			parts.push(t("Semantic summary converted")
				.replace("{count}", String(summary.converted))
				.replace("{formats}", formatList(summary.convertedFormats)));
		}
		if (summary.unsupported > 0) {
			// Too-large images have no detected format.
			parts.push(summary.unsupportedFormats.length > 0
				? t("Semantic summary unsupported")
					.replace("{count}", String(summary.unsupported))
					.replace("{formats}", formatList(summary.unsupportedFormats))
				: t("Semantic summary unsupported plain").replace("{count}", String(summary.unsupported)));
		}
		if (summary.failed > 0) {
			parts.push(t("Semantic summary failed").replace("{count}", String(summary.failed)));
		}
		let text = (summary.cancelled ? t("Semantic summary cancelled") : t("Semantic summary indexed"))
			.replace("{count}", String(summary.indexed));
		if (parts.length > 0) {
			text += `${t("Semantic summary of which")}${parts.join(t("List separator"))}${t("Semantic summary details")}`;
		}
		new Notice(text, issues ? 10000 : 5000);
	}

	dispose(): void {
		if (this.notifyTimer !== null) {
			window.clearTimeout(this.notifyTimer);
			this.notifyTimer = null;
		}
		this.listeners.clear();
		this.unsubscribers.forEach((u) => u());
		this.index.dispose();
		this.search.dispose();
	}
}
