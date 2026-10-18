import { ItemView, WorkspaceLeaf, Notice, setIcon, debounce, Menu, MarkdownView } from 'obsidian';
import { t } from '../i18n';
import { IOssProvider, OssImage } from '../types/oss';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { ConfirmModal } from '../modals/ConfirmModal';
import { SearchService } from '../services/SearchService';
import { SyncService } from '../services/SyncService';
import { ImageGrid } from '../components/ImageGrid';
import { SearchComponent } from '../components/SearchComponent';
import { SemanticIndexBar } from '../components/SemanticIndexBar';
import { intersectHits, needsSemanticRerank, queryFor, SemanticAvailability } from '../components/searchMode';
import { EMPTY_SELECTION, retainKeys, SelectionState } from '../components/tileSelection';
import { emptyStateKind, nextFocusAfterRemoval, previewNames, summarizeBatchDelete } from '../components/galleryUx';
import { GalleryState } from '../types/gallery';
import { handleError } from '../utils/ErrorHandler';
import { providerRegistry } from '../providers/registry';
import type { GallerySemanticHooks } from '../semantic/SemanticIndexing';
import type { GalleryThumbnailHooks } from '../thumbnails/GalleryThumbnails';
import { fileNameOf } from '../semantic/statusText';
import { openPluginSettings } from '../utils/openPluginSettings';

/** Tooltip of the semantic toggle: what it does, or why it is unavailable. */
function semanticToggleLabel(availability: SemanticAvailability): string {
    if (availability.ok) {
        return availability.indexing ? t('Semantic toggle indexing') : t('Semantic toggle on');
    }
    switch (availability.reason) {
        case 'checking': return t('Semantic unavailable checking');
        case 'not-installed': return t('Semantic unavailable not installed');
        case 'webgpu': return t('Semantic unavailable webgpu');
        case 'disabled': return t('Semantic unavailable disabled');
        case 'no-list': return t('Semantic unavailable provider');
        case 'no-index': return t('Semantic unavailable no index');
    }
}

export const GALLERY_VIEW_TYPE = 'oss-gallery-view';

/** Delay before re-listing after the active provider's settings were edited. */
const SETTINGS_RELOAD_DELAY = 1000;
/** Names listed in a batch delete confirmation. */
const CONFIRM_NAMES_SHOWN = 5;

/** Optional plugin services for the gallery (main.ts). */
export interface GalleryViewExtras {
    /** Embed text for an image, as uploads insert it (embedFormat setting). */
    renderEmbed?: (url: string, name: string) => string;
    /** Plugin id: "Open settings" opens this plugin's tab. */
    pluginId?: string;
}

export class OssGalleryView extends ItemView {
    private provider: IOssProvider;
    /** Directory listings are scoped to (the global base path), '' for all. */
    private listPrefix: string;
    private container: HTMLElement | null = null;
    /** Grid, loading, error and empty states (the toolbar rows stay). */
    private bodyEl: HTMLElement | null = null;
    private refreshBtn: HTMLButtonElement;
    private backToTopBtn: HTMLButtonElement | null = null;
    private metaRow: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;
    private selectionEl: HTMLElement | null = null;
    private selectionCountEl: HTMLElement | null = null;
    private selectionDeleteBtn: HTMLButtonElement | null = null;
    private scrollTimeout: number | null = null;
    private lastLoadTime: number = 0;
    /**
     * Incremented whenever a load starts or the provider changes; a load
     * whose generation is no longer current drops its results.
     */
    private loadGeneration = 0;
    /** A forced reload was requested while another load was running. */
    private reloadQueued = false;
    private readonly scheduleReload = debounce(
        () => {
            void this.loadGallery(true);
        },
        SETTINGS_RELOAD_DELAY,
        true
    );

    // Services and Components
    private searchService: SearchService;
    private syncService: SyncService;
    private imageGrid: ImageGrid | null = null;
    private searchComponent: SearchComponent | null = null;
    private semanticBar: SemanticIndexBar | null = null;
    private previewModal: ImagePreviewModal | null = null;
    private unsubscribeSemantic: (() => void) | null = null;
    /** Semantic search/similar requests: a newer one drops older results. */
    private semanticToken = 0;
    /** Semantic search usable for this provider (hover action, menu). */
    private semanticReady = false;
    /** A semantic text query is in flight or waits for the first listing. */
    private semanticPending = false;
    /** Keys the current text result was ranked against (the listing at query time). */
    private semanticRankedKeys: ReadonlySet<string> = new Set();
    /** `remoteObjects` holds a listing of the current provider (not just the initial []). */
    private listingLoaded = false;
    /** URL lookup for the current listing (see `objectUrlsFor`). */
    private objectUrlCache: { source: OssImage[]; urls: Map<string, string> } | null = null;
    /** Multi-selection; survives re-renders for keys still shown. */
    private selection: SelectionState = EMPTY_SELECTION;

    // State
    private state: GalleryState = {
        remoteObjects: [],
        visibleImages: [],
        isSearching: false,
        savedSearchTerm: '',
        useRegexSearch: false,
        useSemanticSearch: false,
        semanticResult: null,
        currentPreviewKey: null,
        isLoading: false
    };

    constructor(
        leaf: WorkspaceLeaf,
        provider: IOssProvider,
        listPrefix = '',
        private readonly semanticHooks: GallerySemanticHooks | null = null,
        private readonly thumbnailHooks: GalleryThumbnailHooks | null = null,
        private readonly extras: GalleryViewExtras = {}
    ) {
        super(leaf);
        this.provider = provider;
        this.listPrefix = listPrefix;
        this.initializeServices();
    }

    /**
     * Called after every settings change. The provider manager only creates
     * a new provider instance when that provider's settings changed, so an
     * unchanged instance and prefix means there is nothing to reload.
     */
    updateProvider(provider: IOssProvider, listPrefix: string = this.listPrefix): void {
        if (provider === this.provider && listPrefix === this.listPrefix) {
            return;
        }

        const providerSwitched = provider.name !== this.provider.name;
        this.provider = provider;
        this.listPrefix = listPrefix;
        this.initializeServices();

        // Anything still loading belongs to the previous provider/settings.
        this.invalidateLoads();
        // Semantic results belong to the previous index scope.
        this.dropSemanticResult();
        this.refreshSemanticUi();

        if (providerSwitched) {
            // Never keep showing the previous provider's images.
            this.scheduleReload.cancel();
            this.state.remoteObjects = [];
            this.state.visibleImages = [];
            this.listingLoaded = false;
            this.selection = EMPTY_SELECTION;
            this.previewModal?.close();
            void this.loadGallery(true);
        } else {
            // Bucket, credentials or base path edited: wait for typing to settle.
            this.scheduleReload();
        }
    }

    private initializeServices(): void {
        this.searchService = new SearchService();
        this.syncService = new SyncService({
            provider: this.provider,
            listPrefix: this.listPrefix,
        });
    }

    getViewType(): string {
        return GALLERY_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t('OSS gallery');
    }

    getIcon(): string {
        return 'image-file';
    }

    async onOpen() {
        const container = this.contentEl;

        this.container = container;
        this.container.empty();
        this.container.addClass('oss-gallery-view');

        this.createToolbar(container);
        this.createSemanticBar(container);
        this.createMetaRow(container);
        this.bodyEl = container.createDiv({ cls: 'oss-gallery-body' });
        this.createBackToTop(container);
        this.registerDomEvent(container, 'keydown', (event) => {
            // Esc anywhere in the gallery (but in the search box) clears the selection.
            if (event.key !== 'Escape' || this.selection.keys.size === 0 || event.defaultPrevented) return;
            if ((event.target as HTMLElement).closest('input, textarea')) return;
            event.preventDefault();
            this.clearSelection();
        });
        await this.loadGallery();
        this.startAutoSync();
        this.setupScrollListener(container);
    }

    private createToolbar(container: HTMLElement): void {
        const toolbar = container.createDiv({ cls: 'oss-gallery-toolbar' });

        this.searchComponent = new SearchComponent(toolbar, {
            placeholder: t('Search by URL...'),
            onSearch: (searchText) => {
                void this.handleSearch(searchText);
            },
            onToggleRegex: (enabled) => {
                this.state.useRegexSearch = enabled;
            },
            ...(this.semanticHooks ? {
                semanticPlaceholder: t('Semantic query placeholder'),
                onToggleSemantic: (enabled: boolean) => {
                    this.state.useSemanticSearch = enabled;
                    // Also drops a query still in flight (its late result
                    // must not replace the grid) and the "Searching" header.
                    if (!enabled && this.hasSemanticActivity()) {
                        void this.clearSemanticResult(false);
                    }
                },
                onEscapeEmpty: () => {
                    if (this.hasSemanticActivity()) {
                        void this.clearSemanticResult(true);
                    }
                },
                onSemanticUnavailable: () => this.explainSemanticUnavailable(),
            } : {}),
        });

        this.refreshBtn = toolbar.createEl('button', {
            cls: 'clickable-icon oss-gallery-toolbar-btn oss-gallery-refresh-btn',
            attr: { type: 'button', 'aria-label': t('Refresh') },
        });
        setIcon(this.refreshBtn, 'refresh-cw');
        this.refreshBtn.onclick = () => {
            if (!this.state.isLoading) {
                void this.loadGallery(true);
            }
        };
    }

    /** Image count, or the selection with its batch actions. */
    private createMetaRow(container: HTMLElement): void {
        const row = container.createDiv({ cls: 'oss-gallery-meta-row oss-gallery-is-hidden' });
        this.metaRow = row;
        this.countEl = row.createDiv({ cls: 'oss-gallery-count', attr: { 'aria-live': 'polite' } });

        const sel = row.createDiv({
            cls: 'oss-gallery-selection-bar oss-gallery-is-hidden',
            attr: { role: 'toolbar', 'aria-label': t('Selection actions') },
        });
        this.selectionEl = sel;
        this.selectionCountEl = sel.createSpan({ cls: 'oss-gallery-selection-count', attr: { 'aria-live': 'polite' } });
        const button = (icon: string, label: string, onClick: () => void, cls = '') => {
            const btn = sel.createEl('button', {
                cls: `clickable-icon oss-gallery-selection-btn ${cls}`.trim(),
                attr: { type: 'button', 'aria-label': label },
            });
            setIcon(btn, icon);
            btn.addEventListener('click', onClick);
            return btn;
        };
        button('link', t('Copy URLs'), () => void this.copyUrls(this.selectedKeys()));
        button('copy', t('Copy as embeds'), () => void this.copyEmbeds(this.selectedKeys()));
        button('file-input', t('Insert into note'), () => this.insertIntoNote(this.selectedKeys()));
        this.selectionDeleteBtn = button('trash', t('Delete'), () => this.requestDelete(this.selectedKeys()), 'oss-gallery-selection-delete');
        button('x', t('Clear selection'), () => this.clearSelection());
    }

    private updateMeta(): void {
        const row = this.metaRow;
        if (!row) return;
        const selected = this.selection.keys.size;
        const canList = providerRegistry.supports(this.provider.name, 'list');
        row.toggleClass('oss-gallery-is-hidden', !canList || (!this.listingLoaded && selected === 0));

        const total = this.state.remoteObjects.length;
        const shown = this.state.visibleImages.length;
        const filtered = this.state.isSearching || this.state.semanticResult !== null;
        const count = (n: number) => (n === 1 ? t('Gallery image count one') : t('Gallery image count').replace('{count}', String(n)));
        this.countEl?.setText(filtered
            ? t('Gallery filtered count').replace('{count}', String(shown)).replace('{total}', String(total))
            : count(total));
        this.countEl?.toggleClass('oss-gallery-is-hidden', selected > 0);

        this.selectionEl?.toggleClass('oss-gallery-is-hidden', selected === 0);
        this.selectionCountEl?.setText(t('Selected count').replace('{count}', String(selected)));
        this.selectionDeleteBtn?.toggleClass('oss-gallery-is-hidden', !providerRegistry.supports(this.provider.name, 'delete'));
    }

    private selectedKeys(): string[] {
        return this.imageGrid?.getSelectedKeys()
            ?? this.state.visibleImages.filter((o) => this.selection.keys.has(o.key)).map((o) => o.key);
    }

    private clearSelection(): void {
        if (this.imageGrid) {
            this.imageGrid.clearSelection();
        } else {
            this.selection = EMPTY_SELECTION;
            this.updateMeta();
        }
    }

    /** Index progress / status strip under the toolbar (semantic search). */
    private createSemanticBar(container: HTMLElement): void {
        const hooks = this.semanticHooks;
        if (!hooks) return;
        this.semanticBar = new SemanticIndexBar(container, {
            summaryText: (state) => (state.stats ? hooks.summaryText(state.stats) : ''),
            onStart: () => {
                hooks.startIndexing(this.provider.name, this.listPrefix).catch((error) => {
                    console.error('Semantic indexing failed to start:', error);
                });
            },
            onPause: () => hooks.pause(),
            onResume: () => hooks.resume(),
            onCancel: () => hooks.cancel(),
            onDetails: () => hooks.openDetails(this.provider.name, this.listPrefix, (key) => {
                void this.revealImage(key);
            }),
            onClearResult: () => {
                void this.clearSemanticResult(true);
            },
        });
        this.unsubscribeSemantic = hooks.subscribe(() => this.refreshSemanticUi());
        this.refreshSemanticUi();
    }

    /** Re-read availability and index state (progress, install, settings changed). */
    private refreshSemanticUi(): void {
        const hooks = this.semanticHooks;
        if (!hooks || !this.container) return;
        const availability = hooks.availability(this.provider.name, this.listPrefix);
        this.semanticReady = availability.ok;
        this.searchComponent?.setSemanticAvailability(availability, semanticToggleLabel(availability));
        this.semanticBar?.update(hooks.indexState(this.provider.name, this.listPrefix));
        if (!availability.ok && this.hasSemanticActivity()) {
            void this.clearSemanticResult(true);
        }
    }

    /** A semantic / similar result is shown, or a semantic query is pending. */
    private hasSemanticActivity(): boolean {
        return this.state.semanticResult !== null || this.semanticPending;
    }

    /** Index hooks must never break listing, delete or upload (they report in the semantic bar). */
    private semanticHook<T>(fn: (hooks: GallerySemanticHooks) => T, fallback: T): T {
        const hooks = this.semanticHooks;
        if (!hooks) return fallback;
        try {
            return fn(hooks);
        } catch (error) {
            console.error('Semantic index hook failed:', error);
            return fallback;
        }
    }

    /**
     * Why semantic search can't be used here, as a notice; settings-related
     * reasons get an "Open settings" button.
     */
    private explainSemanticUnavailable(): void {
        const hooks = this.semanticHooks;
        if (!hooks) return;
        const availability = hooks.availability(this.provider.name, this.listPrefix);
        if (availability.ok) return;
        const label = semanticToggleLabel(availability);
        if (availability.reason !== 'not-installed' && availability.reason !== 'disabled') {
            new Notice(label);
            return;
        }
        const fragment = createFragment();
        fragment.createDiv({ text: label });
        const btn = fragment.createEl('button', { cls: 'oss-gallery-notice-button', text: t('Open settings') });
        const notice = new Notice(fragment, 8000);
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            notice.hide();
            this.openSettings();
        });
    }

    /** This plugin's settings tab. */
    private openSettings(): void {
        openPluginSettings(this.app, this.extras.pluginId);
    }

    /**
     * Switch the search box to semantic mode (status bar click). Explains
     * with a notice when it is not available yet.
     */
    enterSemanticMode(): void {
        const hooks = this.semanticHooks;
        if (!hooks || !this.searchComponent) return;
        this.refreshSemanticUi();
        if (!this.searchComponent.enableSemantic()) {
            this.explainSemanticUnavailable();
        }
        this.searchComponent.focus();
    }

    /** Hide the search box and image count when the provider cannot list. */
    private syncListingSupport(): boolean {
        const canList = providerRegistry.supports(this.provider.name, 'list');
        this.searchComponent?.setVisible(canList);
        this.updateMeta();
        return canList;
    }

    async loadGallery(forceRefresh = false): Promise<void> {
        const container = this.container;
        // Not opened yet (e.g. a deferred leaf): onOpen loads later.
        if (!container) return;

        if (this.state.isLoading) {
            // Don't drop a forced refresh (e.g. after the last upload of a
            // batch): run it once the current load finishes.
            if (forceRefresh) {
                this.reloadQueued = true;
            }
            return;
        }

        if (!this.syncListingSupport()) {
            this.cleanupImageGrid();
            this.state.remoteObjects = [];
            this.state.visibleImages = [];
            this.listingLoaded = false;
            this.clearStatusMessages();
            this.renderListingUnsupported();
            return;
        }

        const currentTime = Date.now();
        // Skip if data was loaded less than 5 minutes ago (unless forced)
        if (!forceRefresh && (currentTime - this.lastLoadTime < 300000)) {
            return;
        }

        const generation = this.beginLoad();
        this.lastLoadTime = currentTime;
        this.clearStatusMessages();

        // With cached data and no forced refresh, show it first and refresh
        // quietly in the background.
        const showCachedFirst = !forceRefresh && this.state.remoteObjects.length > 0;
        let loading: HTMLElement | null = null;

        try {
            if (showCachedFirst) {
                await this.renderCurrentObjects();
            } else {
                this.cleanupImageGrid();
                loading = this.bodyEl?.createDiv({
                    cls: 'oss-gallery-loading-spinner',
                    attr: { role: 'status', 'aria-label': t('Loading...') },
                }) ?? null;
            }

            const ticket = this.semanticHook((h) => h.beginListing(this.provider.name, this.listPrefix), null);
            const listStartedAt = Date.now();
            const { objects, changes, listing } = await this.syncService.sync(this.state.remoteObjects);
            if (!this.isCurrentLoad(generation)) return;

            this.state.remoteObjects = objects;
            this.listingLoaded = true;
            if (ticket) this.semanticHook((h) => h.reconcile(ticket, listing), undefined);
            this.thumbnailHooks?.onListing(this.provider.name, this.listPrefix, listing, listStartedAt);
            loading?.remove();
            if (!showCachedFirst || changes.hasChanges) {
                await this.renderCurrentObjects();
            } else {
                this.updateMeta();
            }
        } catch (err) {
            if (!this.isCurrentLoad(generation)) return;
            console.error(err);
            // A semantic query typed before the first listing has nothing to rank.
            if (!this.listingLoaded && this.hasSemanticActivity()) {
                this.dropSemanticResult();
            }
            // A failed background refresh keeps the cached grid silently.
            if (loading) {
                loading.remove();
                this.renderListingError(err instanceof Error ? err.message : String(err));
            }
        } finally {
            if (!this.isCurrentLoad(generation)) {
                loading?.remove();
            }
            this.endLoad(generation);
        }
    }

    /** A status block in the body: icon, message, optional detail and buttons. */
    private renderStatusBlock(
        cls: string,
        icon: string,
        message: string,
        detail: string | null,
        actions: { label: string; cta?: boolean; run: () => void }[]
    ): HTMLElement {
        const box = (this.bodyEl ?? this.contentEl).createDiv({ cls: `oss-gallery-status-block ${cls}` });
        setIcon(box.createDiv({ cls: 'oss-gallery-status-icon', attr: { 'aria-hidden': 'true' } }), icon);
        box.createDiv({ cls: 'oss-gallery-status-message', text: message });
        if (detail) {
            box.createDiv({ cls: 'oss-gallery-status-detail', text: detail });
        }
        if (actions.length > 0) {
            const row = box.createDiv({ cls: 'oss-gallery-status-actions' });
            for (const action of actions) {
                const btn = row.createEl('button', {
                    cls: action.cta ? 'mod-cta' : '',
                    text: action.label,
                    attr: { type: 'button' },
                });
                btn.addEventListener('click', action.run);
            }
        }
        return box;
    }

    private renderListingError(message: string): void {
        const box = this.renderStatusBlock('oss-gallery-error', 'alert-triangle', t('Listing failed title'), message, [
            { label: t('Retry'), cta: true, run: () => void this.loadGallery(true) },
            { label: t('Open settings'), run: () => this.openSettings() },
        ]);
        box.setAttr('role', 'alert');
    }

    private renderListingUnsupported(): void {
        const label = providerRegistry.getLabel(this.provider.name, this.app);
        this.renderStatusBlock('oss-gallery-error oss-gallery-is-unsupported', 'cloud-off',
            t('Image listing is not available'),
            t('Listing unsupported').replace('{provider}', label),
            [{ label: t('Open settings'), cta: true, run: () => this.openSettings() }]);
    }

    /** Nothing to show: an empty bucket / base path, or a search without matches. */
    private renderEmptyState(): void {
        const kind = emptyStateKind({
            listed: this.state.remoteObjects.length,
            searching: this.state.isSearching,
            semantic: this.state.semanticResult !== null,
        });
        const clearSearch = { label: t('Clear search'), cta: true, run: () => void this.clearSearch() };
        switch (kind) {
            case 'empty-listing': {
                const message = this.listPrefix
                    ? t('Empty listing path').replace('{path}', this.listPrefix)
                    : t('Empty listing all');
                this.renderStatusBlock('oss-gallery-empty', 'image', message, t('Empty listing hint'), [
                    { label: t('Refresh'), run: () => void this.loadGallery(true) },
                ]);
                return;
            }
            case 'no-text-match':
                this.renderStatusBlock('oss-gallery-empty', 'search-x',
                    t('No text matches').replace('{query}', this.state.savedSearchTerm), null, [clearSearch]);
                return;
            case 'no-semantic-match':
                this.renderStatusBlock('oss-gallery-empty', 'search-x', t('No semantic matches'), null, [clearSearch]);
                return;
        }
    }

    /** "Clear search" of an empty state: back to every image. */
    private async clearSearch(): Promise<void> {
        if (this.hasSemanticActivity()) {
            await this.clearSemanticResult(true);
            return;
        }
        this.searchComponent?.clear();
        await this.handleSearch('');
        this.searchComponent?.focus();
    }

    private beginLoad(): number {
        this.state.isLoading = true;
        this.refreshBtn?.addClass('oss-gallery-loading');
        return ++this.loadGeneration;
    }

    private isCurrentLoad(generation: number): boolean {
        return generation === this.loadGeneration;
    }

    private endLoad(generation: number): void {
        if (!this.isCurrentLoad(generation)) return;

        this.state.isLoading = false;
        this.refreshBtn?.removeClass('oss-gallery-loading');

        if (this.reloadQueued) {
            this.reloadQueued = false;
            void this.loadGallery(true);
        }
    }

    /**
     * Make every running load stale so its results are dropped.
     */
    private invalidateLoads(): void {
        this.loadGeneration++;
        this.reloadQueued = false;
        this.state.isLoading = false;
        this.refreshBtn?.removeClass('oss-gallery-loading');
    }

    private clearStatusMessages(): void {
        this.container
            ?.querySelectorAll('.oss-gallery-loading-spinner, .oss-gallery-status-block')
            .forEach(el => el.remove());
    }

    /**
     * Render the loaded objects, re-applying the active search (if any).
     */
    private async renderCurrentObjects(): Promise<void> {
        if (this.state.semanticResult) {
            await this.renderSemanticResult();
            return;
        }
        let objects = this.state.remoteObjects;
        if (this.state.isSearching) {
            try {
                const result = await this.searchService.search(
                    objects,
                    this.state.savedSearchTerm,
                    this.state.useRegexSearch
                );
                objects = result.matchedObjects;
            } catch (error) {
                // Already reported when the term was entered.
                console.warn('Search failed, showing all images:', error);
            }
        }
        await this.renderObjects(objects);
    }

    private async renderObjects(objects: OssImage[], scores?: Map<string, number>): Promise<void> {
        this.state.visibleImages = objects;
        // Keys no longer shown leave the selection (the grid keeps the rest).
        this.selection = retainKeys(this.selection, objects.map((o) => o.key));
        this.clearStatusMessages();
        this.cleanupImageGrid();
        this.updateMeta();
        if (objects.length === 0) {
            this.renderEmptyState();
            return;
        }
        const grid = this.createImageGrid();
        await grid?.renderImages(objects, undefined, scores);
    }

    /**
     * Render the current semantic / similar result against the latest
     * listing: deleted images drop out (§7.6), "similar" is re-ranked so
     * newly indexed images join, text results keep their cached ranking
     * until the listing holds images the query was not ranked against (e.g.
     * typed while the first listing loaded): then the query runs again.
     */
    private async renderSemanticResult(): Promise<void> {
        const result = this.state.semanticResult;
        const hooks = this.semanticHooks;
        if (!result || !hooks) return;
        if (result.kind === 'semantic' && needsSemanticRerank(this.semanticRankedKeys, this.state.remoteObjects)) {
            await this.runSemanticSearch(result.query);
            return;
        }
        this.semanticPending = false;
        if (result.kind === 'similar') {
            result.hits = hooks.searchSimilar(this.provider.name, this.listPrefix, result.key, this.state.remoteObjects)
                .map((h) => ({ key: h.object.key, score: h.score }));
        }
        const hits = intersectHits(this.state.remoteObjects, result.hits);
        this.semanticBar?.setResult(result.kind === 'semantic'
            ? { kind: 'semantic', query: result.query, count: hits.length }
            : { kind: 'similar', name: fileNameOf(result.key), count: hits.length });
        await this.renderObjects(
            hits.map((h) => h.object),
            new Map(hits.map((h) => [h.object.key, h.score]))
        );
    }

    /** Semantic mode, Enter: rank the listed images by the query (query worker). */
    private async runSemanticSearch(query: string): Promise<void> {
        const hooks = this.semanticHooks;
        if (!hooks) return;
        const token = ++this.semanticToken;
        this.semanticPending = true;
        this.semanticBar?.setResult({ kind: 'loading', cold: !hooks.isQueryWarm() });
        // Ranked against this listing; a newer one with more images re-runs the query.
        const listed = this.state.remoteObjects;
        try {
            const hits = await hooks.searchText(this.provider.name, this.listPrefix, query, listed);
            if (token !== this.semanticToken) return;
            this.state.isSearching = true;
            this.state.savedSearchTerm = query;
            this.state.semanticResult = {
                kind: 'semantic',
                query,
                hits: hits.map((h) => ({ key: h.object.key, score: h.score })),
            };
            this.semanticRankedKeys = new Set(listed.map((o) => o.key));
            // First listing still loading: keep "Searching"; the load renders
            // (and re-ranks) the result when it arrives.
            if (!this.listingLoaded) return;
            await this.renderSemanticResult();
        } catch (error) {
            if (token !== this.semanticToken) return;
            this.semanticPending = false;
            this.semanticBar?.setResult(null);
            console.error('Semantic search failed:', error);
            new Notice(`${t('Semantic search failed')}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private canFindSimilar(key: string): boolean {
        return this.semanticReady
            && (this.semanticHooks?.isIndexed(this.provider.name, this.listPrefix, key) ?? false);
    }

    /** "Find similar images": rank by the stored vector of `key`. */
    private async findSimilar(key: string): Promise<void> {
        const hooks = this.semanticHooks;
        if (!hooks) return;
        if (!hooks.isIndexed(this.provider.name, this.listPrefix, key)) {
            new Notice(t('Image not indexed yet'));
            return;
        }
        this.semanticToken++;
        // Typing a query afterwards searches semantically as well.
        this.searchComponent?.enableSemantic();
        this.searchComponent?.clear();
        this.state.isSearching = true;
        this.state.savedSearchTerm = '';
        this.state.semanticResult = { kind: 'similar', key, hits: [] };
        await this.renderSemanticResult();
        this.container?.scrollTo({ top: 0 });
    }

    /** Forget the semantic result without rendering (provider changed). */
    private dropSemanticResult(): void {
        // Unconditional: also discards a query that is still running.
        this.semanticToken++;
        this.semanticPending = false;
        this.semanticRankedKeys = new Set();
        if (this.state.semanticResult) {
            this.state.semanticResult = null;
            this.state.isSearching = false;
            this.state.savedSearchTerm = '';
        }
        this.semanticBar?.setResult(null);
    }

    /** Leave a semantic / similar result and show every image again. */
    private async clearSemanticResult(clearInput: boolean): Promise<void> {
        this.dropSemanticResult();
        if (clearInput) {
            this.searchComponent?.clear();
        }
        // Before the first listing the load spinner stays; the load renders.
        if (this.listingLoaded) {
            await this.renderObjects(this.state.remoteObjects);
        }
    }

    /** Details dialog → scroll to an image and select it (leaving any search). */
    private async revealImage(key: string): Promise<void> {
        if (this.state.isSearching || this.state.semanticResult) {
            this.dropSemanticResult();
            this.state.isSearching = false;
            this.state.savedSearchTerm = '';
            this.searchComponent?.clear();
            const rendering = this.renderObjects(this.state.remoteObjects);
            const found = await this.imageGrid?.reveal(key);
            await rendering;
            if (!found) new Notice(t('Image not in the gallery'));
            return;
        }
        if (!(await this.imageGrid?.reveal(key))) {
            new Notice(t('Image not in the gallery'));
        }
    }

    // ---- per-image actions (menu, tile buttons, lightbox, selection bar) ----

    private objectFor(key: string): OssImage | undefined {
        return this.state.visibleImages.find((o) => o.key === key)
            ?? this.state.remoteObjects.find((o) => o.key === key);
    }

    private objectsFor(keys: readonly string[]): OssImage[] {
        const wanted = new Set(keys);
        const byKey = new Map<string, OssImage>();
        for (const o of [...this.state.remoteObjects, ...this.state.visibleImages]) {
            if (wanted.has(o.key)) byKey.set(o.key, o);
        }
        return keys.map((k) => byKey.get(k)).filter((o): o is OssImage => !!o?.url);
    }

    /** Embed text of an original (the embedFormat setting, like uploads), without the trailing newline. */
    private embedFor(object: OssImage): string {
        const name = fileNameOf(object.key);
        const text = this.extras.renderEmbed
            ? this.extras.renderEmbed(object.url, name)
            : `![](${object.url})`;
        return text.replace(/\n+$/, '');
    }

    private embedsFor(keys: readonly string[]): string {
        return this.objectsFor(keys).map((o) => this.embedFor(o)).join('\n');
    }

    private async copyText(text: string, success: string): Promise<void> {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            new Notice(success);
        } catch (error) {
            console.error('Copy failed', error);
            new Notice(t('Copy failed'));
        }
    }

    private async copyUrls(keys: readonly string[]): Promise<void> {
        const objects = this.objectsFor(keys);
        await this.copyText(
            objects.map((o) => o.url).join('\n'),
            objects.length === 1 ? t('URL copied') : t('URLs copied').replace('{count}', String(objects.length))
        );
    }

    private async copyEmbeds(keys: readonly string[]): Promise<void> {
        const objects = this.objectsFor(keys);
        await this.copyText(
            objects.map((o) => this.embedFor(o)).join('\n'),
            objects.length === 1 ? t('Embed copied') : t('Embeds copied').replace('{count}', String(objects.length))
        );
    }

    /** The markdown view the user worked in last (the gallery itself is not one). */
    private targetMarkdownView(): MarkdownView | null {
        const workspace = this.app.workspace;
        const recent = workspace.getMostRecentLeaf();
        if (recent?.view instanceof MarkdownView) return recent.view;
        const active = workspace.getActiveViewOfType(MarkdownView);
        if (active) return active;
        let best: MarkdownView | null = null;
        let bestTime = -1;
        for (const leaf of workspace.getLeavesOfType('markdown')) {
            const time = (leaf as unknown as { activeTime?: number }).activeTime ?? 0;
            if (leaf.view instanceof MarkdownView && time > bestTime) {
                best = leaf.view;
                bestTime = time;
            }
        }
        return best;
    }

    /** Insert the embeds at the cursor of the most recent note. */
    private insertIntoNote(keys: readonly string[]): void {
        const text = this.embedsFor(keys);
        if (!text) return;
        const view = this.targetMarkdownView();
        if (!view) {
            new Notice(t('No note to insert into'));
            return;
        }
        view.editor.replaceSelection(`${text}\n`);
        new Notice(t('Inserted into note').replace('{note}', view.file?.basename ?? ''));
    }

    /** Context menu / "more actions" of one tile. */
    private buildMenu(key: string): Menu {
        const object = this.objectFor(key);
        const menu = new Menu();
        const hooks = this.semanticHooks;
        if (hooks && this.semanticReady) {
            const indexed = hooks.isIndexed(this.provider.name, this.listPrefix, key);
            menu.addItem((item) => item
                .setTitle(indexed ? t('Find similar images') : `${t('Find similar images')} (${t('Image not indexed yet')})`)
                .setIcon('images')
                .setDisabled(!indexed)
                .onClick(() => {
                    void this.findSimilar(key);
                }));
        }
        if (object?.url) {
            menu.addItem((item) => item
                .setTitle(t('Copy URL'))
                .setIcon('link')
                .onClick(() => void this.copyUrls([key])));
            menu.addItem((item) => item
                .setTitle(t('Copy as embed'))
                .setIcon('copy')
                .onClick(() => void this.copyEmbeds([key])));
            menu.addItem((item) => item
                .setTitle(t('Insert into note'))
                .setIcon('file-input')
                .onClick(() => this.insertIntoNote([key])));
        }
        if (this.imageGrid) {
            const selected = this.imageGrid.isSelected(key);
            menu.addSeparator();
            menu.addItem((item) => item
                .setTitle(selected ? t('Deselect') : t('Select'))
                .setIcon(selected ? 'square' : 'check')
                .onClick(() => this.imageGrid?.toggleSelected(key)));
        }
        if (providerRegistry.supports(this.provider.name, 'delete')) {
            menu.addSeparator();
            menu.addItem((item) => item
                .setTitle(t('Delete'))
                .setIcon('trash')
                .setWarning(true)
                .onClick(() => this.requestDelete([key])));
        }
        return menu;
    }

    /** Right click on a tile (or the context-menu key / long press). */
    private openContextMenu(key: string, event: MouseEvent, element: HTMLElement): void {
        const menu = this.buildMenu(key);
        // The context-menu key reports (0, 0): open the menu at the tile instead.
        if (event.clientX === 0 && event.clientY === 0) {
            const rect = element.getBoundingClientRect();
            menu.showAtPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        } else {
            menu.showAtMouseEvent(event);
        }
    }

    private openMoreMenu(key: string, anchor: HTMLElement): void {
        const rect = anchor.getBoundingClientRect();
        this.buildMenu(key).showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }

    private createImageGrid(): ImageGrid | null {
        if (!this.bodyEl) return null;

        const gridContainer = this.bodyEl.createDiv({
            cls: 'oss-gallery-container'
        });

        const canDelete = providerRegistry.supports(this.provider.name, 'delete');
        this.imageGrid = new ImageGrid(gridContainer, {
            getObjectUrl: async (objectName) => await this.getObjectUrl(objectName),
            canDelete,
            onPreview: (objectName) => {
                this.openImagePreview(objectName);
            },
            onDelete: (keys) => this.requestDelete(keys),
            onContextMenu: (objectName, event, element) => {
                this.openContextMenu(objectName, event, element);
            },
            onMore: (objectName, anchor) => this.openMoreMenu(objectName, anchor),
            canFindSimilar: (objectName) => this.canFindSimilar(objectName),
            onFindSimilar: (objectName) => {
                void this.findSimilar(objectName);
            },
            tileSources: this.thumbnailHooks?.tileSources(this.provider.name, this.listPrefix) ?? null,
            dragText: (keys) => this.embedsFor(keys) || null,
            initialSelection: this.selection,
            onSelectionChange: (selection) => {
                this.selection = selection;
                this.updateMeta();
            },
        });
        return this.imageGrid;
    }

    private cleanupImageGrid(): void {
        const existingContainer = this.container?.querySelector('.oss-gallery-container');
        existingContainer?.remove();

        if (this.imageGrid) {
            this.imageGrid.destroy();
            this.imageGrid = null;
        }
    }

    private async handleSearch(searchText: string): Promise<void> {
        const query = queryFor(
            { semantic: this.state.useSemanticSearch, regex: this.state.useRegexSearch },
            searchText
        );
        if (query.kind === 'semantic') {
            await this.runSemanticSearch(query.query);
            return;
        }
        // Any other search (or clearing) leaves the semantic result.
        this.dropSemanticResult();
        const term = searchText.trim() === '' ? '' : searchText;
        this.state.savedSearchTerm = term;
        this.state.isSearching = term !== '';

        // Filters the data loaded so far; a running load re-applies the term
        // when it renders its results.
        try {
            const objectsToRender = term === ''
                ? this.state.remoteObjects
                : (await this.searchService.search(
                    this.state.remoteObjects,
                    term,
                    this.state.useRegexSearch
                )).matchedObjects;

            // Before the first listing the load spinner stays; the load renders.
            if (!this.listingLoaded) return;
            await this.renderObjects(objectsToRender);
        } catch (error) {
            new Notice(error instanceof Error ? error.message : t('Search failed'));
            console.error('Search error:', error);
        }
    }

    // ---- lightbox ----

    /**
     * Open the preview by object key: grid tiles must not capture indexes,
     * which shift after deletes and re-renders.
     */
    private openImagePreview(objectName: string): void {
        const imageIndex = this.state.visibleImages.findIndex(obj => obj.key === objectName);
        const object = this.state.visibleImages[imageIndex];
        if (!object) {
            return;
        }

        this.state.currentPreviewKey = object.key;
        const canDelete = providerRegistry.supports(this.provider.name, 'delete');

        const modal = new ImagePreviewModal(this.app, object.url, object.key, {
            onNavigate: (direction) => this.navigatePreview(direction),
            position: (key) => {
                const index = this.state.visibleImages.findIndex((o) => o.key === key);
                return index < 0 ? null : { index: index + 1, total: this.state.visibleImages.length };
            },
            onCopyUrl: (key) => void this.copyUrls([key]),
            onCopyEmbed: (key) => void this.copyEmbeds([key]),
            ...(canDelete ? { onDelete: (key: string) => this.requestDelete([key]) } : {}),
            ...(this.semanticHooks ? {
                canFindSimilar: (key: string) => this.canFindSimilar(key),
                onFindSimilar: (key: string) => void this.findSimilar(key),
            } : {}),
            onClosed: () => {
                if (this.previewModal !== modal) return;
                this.previewModal = null;
                // Back to the tile of the image last shown.
                const key = this.state.currentPreviewKey;
                if (key) this.imageGrid?.focusKey(key, false);
            },
        });
        this.previewModal = modal;
        modal.open();

        // 预加载相邻图片
        this.preloadAdjacentImages(imageIndex);
    }

    private navigatePreview(direction: 'prev' | 'next'): void {
        const modal = this.previewModal;
        if (!modal) return;
        const currentIndex = this.state.visibleImages.findIndex(
            obj => obj.key === this.state.currentPreviewKey
        );
        if (currentIndex < 0) return;

        const newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
        const nextObject = this.state.visibleImages[newIndex];
        if (nextObject) {
            this.state.currentPreviewKey = nextObject.key;
            modal.updateImage(nextObject.url, nextObject.key);
            this.preloadAdjacentImages(newIndex);
        }
    }

    private preloadAdjacentImages(currentIndex: number): void {
        // 预加载下一张
        if (currentIndex < this.state.visibleImages.length - 1) {
            const nextObject = this.state.visibleImages[currentIndex + 1];
            if (nextObject) {
                const img = new Image();
                img.src = nextObject.url;
            }
        }

        // 预加载上一张
        if (currentIndex > 0) {
            const prevObject = this.state.visibleImages[currentIndex - 1];
            if (prevObject) {
                const img = new Image();
                img.src = prevObject.url;
            }
        }
    }

    // ---- delete ----

    /** Confirm, then delete one image or a selection. */
    private requestDelete(keys: readonly string[]): void {
        if (!providerRegistry.supports(this.provider.name, 'delete')) {
            new Notice(t('Delete failed'));
            return;
        }
        if (keys.length === 0) return;
        const names = keys.map(fileNameOf);
        const run = () => {
            void this.deleteKeys([...keys]);
        };
        if (keys.length === 1) {
            new ConfirmModal(this.app, run, {
                title: t('Delete image title'),
                message: t('Delete confirm one').replace('{name}', names[0] ?? ''),
            }).open();
            return;
        }
        const { shown, more } = previewNames(names, CONFIRM_NAMES_SHOWN);
        const count = String(keys.length);
        new ConfirmModal(this.app, run, {
            title: t('Delete images title').replace('{count}', count),
            message: t('Delete confirm many').replace('{count}', count),
            names: shown,
            more,
        }).open();
    }

    /**
     * Delete one by one (providers such as GitHub can't take parallel
     * commits); every success updates the index and thumbnails exactly like
     * a single delete, failures are reported together.
     */
    private async deleteKeys(keys: string[]): Promise<void> {
        const provider = this.provider;
        const listPrefix = this.listPrefix;
        const syncService = this.syncService;
        const deleted: string[] = [];
        const failed: string[] = [];

        for (const key of keys) {
            try {
                await syncService.deleteObject(key);
            } catch (err) {
                console.error(`Delete failed: ${key}`, err);
                failed.push(key);
                continue;
            }
            deleted.push(key);
            // The vector goes right away (no tombstone for our own deletes).
            this.semanticHook((h) => h.onDeleted(provider.name, listPrefix, key), undefined);
            this.thumbnailHooks?.onDeleted(provider.name, listPrefix, key);
        }

        // Settings changed meanwhile: the gallery shows another listing now.
        if (provider === this.provider && listPrefix === this.listPrefix && deleted.length > 0) {
            this.removeDeleted(new Set(deleted));
        }

        if (keys.length === 1) {
            new Notice(deleted.length === 1
                ? t('Deleted name').replace('{name}', fileNameOf(keys[0] ?? ''))
                : t('Delete failed'));
            return;
        }
        const summary = summarizeBatchDelete(deleted.length, failed.length);
        switch (summary.kind) {
            case 'all':
                new Notice(t('Deleted count').replace('{count}', String(summary.deleted)));
                break;
            case 'partial':
                new Notice(t('Delete partial')
                    .replace('{deleted}', String(summary.deleted))
                    .replace('{failed}', String(summary.failed)));
                break;
            case 'none':
                new Notice(t('Delete none').replace('{count}', String(summary.failed)));
                break;
        }
    }

    /** Update state and grid in place instead of re-listing the whole bucket. */
    private removeDeleted(removed: ReadonlySet<string>): void {
        const before = this.state.visibleImages.map((o) => o.key);
        const nextKey = nextFocusAfterRemoval(before, removed);
        this.state.remoteObjects = this.state.remoteObjects.filter(obj => !removed.has(obj.key));
        this.state.visibleImages = this.state.visibleImages.filter(obj => !removed.has(obj.key));
        this.selection = retainKeys(this.selection, this.state.visibleImages.map((o) => o.key));

        const modal = this.previewModal;
        if (modal && removed.has(modal.currentKey)) {
            const next = nextKey ? this.state.visibleImages.find((o) => o.key === nextKey) : undefined;
            if (next) {
                this.state.currentPreviewKey = next.key;
                modal.updateImage(next.url, next.key);
            } else {
                modal.close();
            }
        }

        if (this.state.visibleImages.length === 0) {
            this.cleanupImageGrid();
            this.clearStatusMessages();
            this.renderEmptyState();
        } else {
            this.imageGrid?.removeItems([...removed], !this.previewModal);
        }
        this.updateMeta();
    }

    private async getObjectUrl(objectName: string): Promise<string> {
        return this.objectUrlsFor(this.state.remoteObjects).get(objectName) ?? '';
    }

    /**
     * key -> URL for a listing, built once per listing array (every tile of a
     * render looks its URL up here; `remoteObjects` is replaced, never
     * mutated, when the listing changes).
     */
    private objectUrlsFor(objects: OssImage[]): Map<string, string> {
        if (this.objectUrlCache?.source !== objects) {
            const urls = new Map<string, string>();
            for (const obj of objects) {
                if (obj.url) urls.set(obj.key, obj.url);
            }
            this.objectUrlCache = { source: objects, urls };
        }
        return this.objectUrlCache.urls;
    }

    private startAutoSync(): void {
        this.registerInterval(window.setInterval(() => {
            void this.runAutoSync();
        }, 120000));
    }

    private async runAutoSync(): Promise<void> {
        if (!this.container || this.state.isLoading) return;
        if (!providerRegistry.supports(this.provider.name, 'list')) return;

        const generation = this.beginLoad();
        try {
            const ticket = this.semanticHook((h) => h.beginListing(this.provider.name, this.listPrefix), null);
            const listStartedAt = Date.now();
            const { objects, changes, listing } = await this.syncService.sync(this.state.remoteObjects);
            if (!this.isCurrentLoad(generation)) return;
            // Reconcile even when the gallery itself has nothing to redraw:
            // the index may still be missing objects or hold deleted ones.
            if (ticket) this.semanticHook((h) => h.reconcile(ticket, listing), undefined);
            this.thumbnailHooks?.onListing(this.provider.name, this.listPrefix, listing, listStartedAt);
            this.listingLoaded = true;
            if (!changes.hasChanges) return;

            this.state.remoteObjects = objects;
            await this.renderCurrentObjects();
        } catch (error) {
            if (!this.isCurrentLoad(generation)) return;
            handleError(error, {
                operation: 'AutoSync',
                additionalInfo: {
                    interval: '120000ms'
                }
            });
        } finally {
            this.endLoad(generation);
        }
    }

    private setupScrollListener(container: HTMLElement): void {
        const throttledHandleScroll = () => {
            if (this.scrollTimeout) return;

            this.scrollTimeout = window.setTimeout(() => {
                const scrollTop = container.scrollTop;
                const containerHeight = container.clientHeight;
                const showThreshold = containerHeight * 0.5;
                this.backToTopBtn?.toggleClass('oss-gallery-visible', scrollTop > showThreshold);
                this.scrollTimeout = null;
            }, 16);
        };

        this.registerDomEvent(container, 'scroll', throttledHandleScroll, { passive: true });
    }

    /** Sticky at the bottom of the view's scroll area (not fixed to the window). */
    private createBackToTop(container: HTMLElement): void {
        const wrap = container.createDiv({ cls: 'oss-gallery-back-to-top-wrap' });
        this.backToTopBtn = wrap.createEl('button', {
            cls: 'oss-gallery-back-to-top',
            attr: { type: 'button', 'aria-label': t('Back to top') },
        });
        setIcon(this.backToTopBtn, 'chevron-up');
        this.backToTopBtn.addEventListener('click', () => {
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            container.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
            // Keyboard users continue at the first tile.
            const first = this.state.visibleImages[0];
            if (first) this.imageGrid?.focusKey(first.key, true);
        });
    }

    async onClose(): Promise<void> {
        // The auto-sync interval is cleaned up via registerInterval.
        this.scheduleReload.cancel();
        // Drop the results of any load that is still running.
        this.invalidateLoads();

        if (this.scrollTimeout) {
            window.clearTimeout(this.scrollTimeout);
            this.scrollTimeout = null;
        }

        this.backToTopBtn = null;
        this.metaRow = null;
        this.bodyEl = null;

        this.previewModal?.close();
        this.previewModal = null;

        this.searchComponent?.destroy();
        this.searchComponent = null;

        this.semanticToken++;
        this.unsubscribeSemantic?.();
        this.unsubscribeSemantic = null;
        this.semanticBar?.destroy();
        this.semanticBar = null;

        this.imageGrid?.destroy();
        this.imageGrid = null;
    }
}
