import { ItemView, WorkspaceLeaf, Notice, setIcon, debounce } from 'obsidian';
import { t } from '../i18n';
import { IOssProvider, OssImage } from '../types/oss';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { ConfirmModal } from '../modals/ConfirmModal';
import { SearchService } from '../services/SearchService';
import { SyncService } from '../services/SyncService';
import { ImageGrid } from '../components/ImageGrid';
import { SearchComponent } from '../components/SearchComponent';
import { GalleryState } from '../types/gallery';
import { handleError } from '../utils/ErrorHandler';
import { providerRegistry } from '../providers/registry';

export const GALLERY_VIEW_TYPE = 'oss-gallery-view';

/** Delay before re-listing after the active provider's settings were edited. */
const SETTINGS_RELOAD_DELAY = 1000;

export class OssGalleryView extends ItemView {
    private provider: IOssProvider;
    /** Directory listings are scoped to (the global base path), '' for all. */
    private listPrefix: string;
    private container: HTMLElement | null = null;
    private refreshBtn: HTMLButtonElement;
    private backToTopBtn: HTMLButtonElement | null = null;
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

    // State
    private state: GalleryState = {
        remoteObjects: [],
        visibleImages: [],
        isSearching: false,
        savedSearchTerm: '',
        useRegexSearch: false,
        currentPreviewKey: null,
        isLoading: false
    };

    constructor(leaf: WorkspaceLeaf, provider: IOssProvider, listPrefix = '') {
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

        if (providerSwitched) {
            // Never keep showing the previous provider's images.
            this.scheduleReload.cancel();
            this.state.remoteObjects = [];
            this.state.visibleImages = [];
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

        this.createToolbar(container);
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
            }
        });

        this.refreshBtn = toolbar.createEl('button', { cls: 'oss-gallery-icon-btn oss-gallery-refresh-btn' });
        setIcon(this.refreshBtn, 'refresh-cw');
        this.refreshBtn.onclick = () => {
            if (!this.state.isLoading) {
                void this.loadGallery(true);
            }
        };
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

        if (!providerRegistry.supports(this.provider.name, 'list')) {
            this.cleanupImageGrid();
            this.state.remoteObjects = [];
            this.state.visibleImages = [];
            this.clearStatusMessages();

            container.createDiv({
                cls: 'oss-gallery-error',
                text: t('Image listing is not available'),
            });
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
                loading = container.createDiv({ cls: 'oss-gallery-loading-spinner' });
            }

            const { objects, changes } = await this.syncService.sync(this.state.remoteObjects);
            if (!this.isCurrentLoad(generation)) return;

            this.state.remoteObjects = objects;
            loading?.remove();
            if (!showCachedFirst || changes.hasChanges) {
                await this.renderCurrentObjects();
            }
        } catch (err) {
            if (!this.isCurrentLoad(generation)) return;
            console.error(err);
            // A failed background refresh keeps the cached grid silently.
            if (loading) {
                loading.removeClass('oss-gallery-loading-spinner');
                loading.addClass('oss-gallery-error');
                const errorMessage = err instanceof Error ? err.message : String(err);
                loading.setText(`${t('Load failed')}: ${errorMessage}`);
            }
        } finally {
            if (!this.isCurrentLoad(generation)) {
                loading?.remove();
            }
            this.endLoad(generation);
        }
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
            ?.querySelectorAll('.oss-gallery-loading-spinner, .oss-gallery-error')
            .forEach(el => el.remove());
    }

    /**
     * Render the loaded objects, re-applying the active search (if any).
     */
    private async renderCurrentObjects(): Promise<void> {
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

    private async renderObjects(objects: OssImage[]): Promise<void> {
        this.state.visibleImages = objects;
        this.clearStatusMessages();
        this.cleanupImageGrid();
        const grid = this.createImageGrid();
        await grid?.renderImages(objects);
    }

    private createImageGrid(): ImageGrid | null {
        if (!this.container) return null;

        const gridContainer = this.container.createDiv({
            cls: 'oss-gallery-container'
        });

        this.imageGrid = new ImageGrid(gridContainer, {
            getObjectUrl: async (objectName) => await this.getObjectUrl(objectName),
            canDelete: providerRegistry.supports(this.provider.name, 'delete'),
            onPreview: (objectName) => {
                this.openImagePreview(objectName);
            },
            onDelete: (objectName, element) => {
                void this.handleDelete(objectName, element);
            }
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

            await this.renderObjects(objectsToRender);
        } catch (error) {
            new Notice(error instanceof Error ? error.message : t('Search failed'));
            console.error('Search error:', error);
        }
    }

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

        const modalInstance = new ImagePreviewModal(this.app, object.url, object.key, {
            onNavigate: (direction: 'prev' | 'next') => {
                const currentIndex = this.state.visibleImages.findIndex(
                    obj => obj.key === this.state.currentPreviewKey
                );
                if (currentIndex < 0) return;

                const newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
                const nextObject = this.state.visibleImages[newIndex];
                if (nextObject) {
                    modalInstance.updateImage(nextObject.url, nextObject.key);
                    this.state.currentPreviewKey = nextObject.key;
                    this.preloadAdjacentImages(newIndex);
                }
            }
        });
        modalInstance.open();

        // 预加载相邻图片
        this.preloadAdjacentImages(imageIndex);
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

    private async handleDelete(objectName: string, element: HTMLElement): Promise<void> {
        if (!providerRegistry.supports(this.provider.name, 'delete')) {
            new Notice(t('Delete failed'));
            return;
        }

        const modal = new ConfirmModal(this.app, () => {
            void this.deleteConfirmed(objectName, element);
        });
        modal.open();
    }

    private async deleteConfirmed(objectName: string, element: HTMLElement): Promise<void> {
        try {
            await this.syncService.deleteObject(objectName);
        } catch (err) {
            new Notice(t('Delete failed'));
            console.error(err);
            return;
        }

        // Update in-memory state instead of re-listing the whole bucket.
        element.remove();
        this.state.remoteObjects = this.state.remoteObjects.filter(obj => obj.key !== objectName);
        this.state.visibleImages = this.state.visibleImages.filter(obj => obj.key !== objectName);

        new Notice(t('Delete success'));
    }

    private async getObjectUrl(objectName: string): Promise<string> {
        // Try to find object in remoteObjects to get URL directly if available
        const obj = this.state.remoteObjects.find(o => o.key === objectName);
        if (obj && obj.url) {
            return obj.url;
        }

        return '';
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
            const { objects, changes } = await this.syncService.sync(this.state.remoteObjects);
            if (!this.isCurrentLoad(generation) || !changes.hasChanges) return;

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

                if (scrollTop > showThreshold) {
                    this.showBackToTopButton(container);
                } else {
                    this.hideBackToTopButton();
                }

                this.scrollTimeout = null;
            }, 16);
        };

        this.registerDomEvent(container, 'scroll', throttledHandleScroll, { passive: true });
    }

    private showBackToTopButton(container: HTMLElement): void {
        if (!this.backToTopBtn) {
            this.backToTopBtn = container.createEl('button', {
                cls: 'oss-gallery-back-to-top'
            });
            setIcon(this.backToTopBtn, 'chevron-up');

            this.backToTopBtn.onclick = () => {
                container.scrollTo({ top: 0, behavior: 'smooth' });
            };
        }

        this.backToTopBtn.classList.add('oss-gallery-visible');
    }

    private hideBackToTopButton(): void {
        this.backToTopBtn?.classList.remove('oss-gallery-visible');
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

        this.backToTopBtn?.remove();
        this.backToTopBtn = null;

        this.searchComponent?.destroy();
        this.searchComponent = null;

        this.imageGrid?.destroy();
        this.imageGrid = null;
    }
}
