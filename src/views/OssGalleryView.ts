import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import { t } from '../i18n';
import { IOssProvider, OssImage } from '../types/oss';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { ConfirmModal } from '../modals/ConfirmModal';
import { ImageCache } from '../utils/ImageCache';
import { SearchService } from '../services/SearchService';
import { SyncService } from '../services/SyncService';
import { ImageGrid } from '../components/ImageGrid';
import { SearchComponent } from '../components/SearchComponent';
import { GalleryState } from '../types/gallery';
import { handleError } from '../utils/ErrorHandler';
import { providerRegistry } from '../providers/registry';

export const GALLERY_VIEW_TYPE = 'oss-gallery-view';

export class OssGalleryView extends ItemView {
    private provider: IOssProvider;
    private container: HTMLElement;
    private refreshBtn: HTMLButtonElement;
    private backToTopBtn: HTMLButtonElement | null = null;
    private syncInterval: number | null = null;
    private scrollTimeout: number | null = null;
    private lastLoadTime: number = 0;

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
        currentPreviewIndex: null,
        isLoading: false
    };

    constructor(leaf: WorkspaceLeaf, provider: IOssProvider) {
        super(leaf);
        this.provider = provider;
        this.initializeServices();
    }

    updateProvider(provider: IOssProvider) {
        this.provider = provider;
        this.initializeServices();
        this.loadGallery(true);
    }

    private initializeServices(): void {
        // Search service might need update if it depends on specific object structure, 
        // but OssImage should be compatible if we map 'key' to 'name' or update SearchService.
        // Assuming SearchService expects objects with 'name' property. 
        // OssImage has 'key', let's ensure compatibility.
        this.searchService = new SearchService(async (objectName) => await this.getObjectUrl(objectName));
        this.syncService = new SyncService({ provider: this.provider });
    }

    getViewType(): string {
        return GALLERY_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t('Minio gallery'); // Should probably rename to OSS Gallery in i18n
    }

    getIcon(): string {
        return 'image-file';
    }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        if (!container) throw new Error("Failed to get container element");

        this.container = container;
        this.container.empty();

        this.createToolbar();
        await this.loadGallery();
        this.startAutoSync();
        this.setupScrollListener();
    }

    private createToolbar(): void {
        const toolbar = this.container.createEl('div', { cls: 'minio-gallery-toolbar' });

        this.searchComponent = new SearchComponent(toolbar, {
            placeholder: t('Search by URL...'),
            onSearch: (searchText) => this.handleSearch(searchText),
            onToggleRegex: (enabled) => {
                this.state.useRegexSearch = enabled;
            }
        });

        this.refreshBtn = toolbar.createEl('button', { cls: 'minio-gallery-icon-btn refresh-btn' });
        setIcon(this.refreshBtn, 'refresh-cw');
        this.refreshBtn.onclick = () => {
            if (!this.state.isLoading) {
                this.loadGallery(true);
            }
        };
    }

    async loadGallery(forceRefresh = false): Promise<void> {
        if (this.state.isLoading) return;

        if (!providerRegistry.supports(this.provider.name, 'list')) {
            this.cleanupImageGrid();
            this.state.remoteObjects = [];
            this.state.visibleImages = [];

            const existingMessages = this.container.querySelectorAll('.minio-loading-spinner, .minio-gallery-error');
            existingMessages.forEach(el => el.remove());

            this.container.createEl('div', {
                cls: 'minio-gallery-error',
                text: t('Image listing is not available'),
            });
            return;
        }

        const currentTime = Date.now();
        // Increase cache time to 5 minutes to reduce frequent API calls
        if (!forceRefresh && (currentTime - this.lastLoadTime < 300000)) {
            // But if it's a force refresh for new upload, we should bypass cache
            if (!forceRefresh) return;
        }

        this.state.isLoading = true;
        this.refreshBtn?.addClass('loading');
        this.lastLoadTime = currentTime;

        this.cleanupImageGrid();

        // Clear any existing loading or error messages
        const existingMessages = this.container.querySelectorAll('.minio-loading-spinner, .minio-gallery-error');
        existingMessages.forEach(el => el.remove());

        // If we have cached data and not forcing refresh, use it first
        if (!forceRefresh && this.state.remoteObjects.length > 0) {
            // Show cached data immediately for better UX
            this.createImageGrid();
            await this.imageGrid!.renderImages(this.state.remoteObjects);
            this.state.visibleImages = this.state.remoteObjects;
            this.state.isSearching = false;

            // Then load fresh data in background
            this.refreshDataInBackground();
            return;
        }

        const loading = this.container.createEl('div', { cls: 'minio-loading-spinner' });

        try {
            const { objects } = await this.syncService.sync(this.state.remoteObjects);
            this.state.remoteObjects = objects;

            // Filter logic might need adjustment if listImages returns non-images
            // But IOssProvider.listImages implies images.
            const imageObjects = objects;

            this.createImageGrid();
            await this.imageGrid!.renderImages(imageObjects);

            this.state.visibleImages = imageObjects;
            this.state.isSearching = false;

            loading.remove();
        } catch (err) {
            loading.removeClass('minio-loading-spinner');
            loading.addClass('minio-gallery-error');
            
            const errorMessage = err instanceof Error ? err.message : String(err);
            loading.setText(`${t('Load failed')}: ${errorMessage}`);
            console.error(err);
        } finally {
            this.state.isLoading = false;
            this.refreshBtn?.removeClass('loading');
        }
    }

    private createImageGrid(): void {
        const gridContainer = this.container.createEl('div', {
            cls: 'minio-gallery-container'
        });

        this.imageGrid = new ImageGrid(gridContainer, {
            getObjectUrl: async (objectName) => await this.getObjectUrl(objectName),
            canDelete: providerRegistry.supports(this.provider.name, 'delete'),
            onPreview: (index) => this.openImagePreview(index),
            onDelete: async (objectName, element) => {
                await this.handleDelete(objectName, element);
            }
        });
    }

    private cleanupImageGrid(): void {
        const existingContainer = this.container.querySelector('.minio-gallery-container');
        existingContainer?.remove();

        if (this.imageGrid) {
            this.imageGrid.destroy();
            this.imageGrid = null;
        }
    }

    private async handleSearch(searchText: string): Promise<void> {
        if (this.state.isLoading) return;

        this.state.isSearching = true;
        this.state.savedSearchTerm = searchText;

        try {
            let objectsToRender: OssImage[];

            if (searchText.trim() === '') {
                objectsToRender = this.state.remoteObjects;
                this.state.isSearching = false;
                this.state.savedSearchTerm = '';
            } else {
                const result = await this.searchService.search(
                    this.state.remoteObjects,
                    searchText,
                    this.state.useRegexSearch
                );
                objectsToRender = result.matchedObjects;
            }

            this.state.visibleImages = objectsToRender;

            this.cleanupImageGrid();
            this.createImageGrid();
            await this.imageGrid!.renderImages(objectsToRender);
        } catch (error) {
            new Notice(error instanceof Error ? error.message : t('Search failed'));
            console.error('Search error:', error);
        }
    }

    private async openImagePreview(imageIndex: number, modal?: ImagePreviewModal): Promise<void> {
        if (imageIndex < 0 || imageIndex >= this.state.visibleImages.length || this.state.isLoading) {
            return;
        }

        const object = this.state.visibleImages[imageIndex];
        // 使用 object.url 而不是异步搜索
        const objectUrl = object.url;

        if (modal) {
            modal.updateImage(objectUrl, object.key);
            this.state.currentPreviewIndex = imageIndex;
            return;
        }

        const modalInstance = new ImagePreviewModal(this.app, objectUrl, object.key, {
            onNavigate: (direction: 'prev' | 'next') => {
                const currentIndex = this.state.currentPreviewIndex ?? imageIndex;
                const newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
                if (newIndex >= 0 && newIndex < this.state.visibleImages.length) {
                    // 直接更新，不需要再次调用 openImagePreview
                    const nextObject = this.state.visibleImages[newIndex];
                    if (nextObject) {
                        modalInstance.updateImage(nextObject.url, nextObject.key);
                        this.state.currentPreviewIndex = newIndex;
                    }
                }
            }
        });
        modalInstance.open();

        this.state.currentPreviewIndex = imageIndex;

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

        const modal = new ConfirmModal(this.app, async () => {
            try {
                await this.syncService.deleteObject(objectName);
                element.remove();

                this.state.remoteObjects = this.state.remoteObjects.filter(obj => obj.key !== objectName);
                this.state.visibleImages = this.state.visibleImages.filter(obj => obj.key !== objectName);

                ImageCache.delete(objectName);

                const { objects } = await this.syncService.sync(this.state.remoteObjects);
                this.state.remoteObjects = objects;

                new Notice(t('Delete success'));
            } catch (err) {
                new Notice(t('Delete failed'));
                console.error(err);
            }
        });
        modal.open();
    }

    
    private async getObjectUrl(objectName: string): Promise<string> {
        // Try to find object in remoteObjects to get URL directly if available
        const obj = this.state.remoteObjects.find(o => o.key === objectName);
        if (obj && obj.url) {
            return obj.url;
        }

        return '';
    }

    private async refreshDataInBackground(): Promise<void> {
        try {
            const { objects, changes } = await this.syncService.sync(this.state.remoteObjects);

            if (changes.hasChanges) {
                this.state.remoteObjects = objects;

                // Update gallery if user hasn't changed anything
                if (!this.state.isSearching) {
                    this.cleanupImageGrid();
                    this.createImageGrid();
                    await this.imageGrid!.renderImages(objects);
                    this.state.visibleImages = objects;
                }
            }
        } catch (error) {
            console.error('Background refresh failed:', error);
            // Don't show error to user for background refresh
        } finally {
            this.state.isLoading = false;
            this.refreshBtn?.removeClass('loading');
        }
    }

    private startAutoSync(): void {
        this.syncInterval = window.setInterval(async () => {
            try {
                const { objects } = await this.syncService.sync(this.state.remoteObjects);
                this.state.remoteObjects = objects;

                if (!this.state.isSearching) {
                    this.state.visibleImages = objects;
                }
            } catch (error) {
                handleError(error, {
                    operation: 'AutoSync',
                    additionalInfo: {
                        interval: '120000ms'
                    }
                });
            }
        }, 120000);
    }

    private setupScrollListener(): void {
        const throttledHandleScroll = () => {
            if (this.scrollTimeout) return;

            this.scrollTimeout = window.setTimeout(() => {
                const scrollTop = this.container.scrollTop;
                const containerHeight = this.container.clientHeight;
                const showThreshold = containerHeight * 0.5;

                if (scrollTop > showThreshold) {
                    this.showBackToTopButton();
                } else {
                    this.hideBackToTopButton();
                }

                this.scrollTimeout = null;
            }, 16);
        };

        this.container.addEventListener('scroll', throttledHandleScroll, { passive: true });
    }

    private showBackToTopButton(): void {
        if (!this.backToTopBtn) {
            this.backToTopBtn = this.container.createEl('button', {
                cls: 'minio-back-to-top'
            });
            setIcon(this.backToTopBtn, 'chevron-up');

            this.backToTopBtn.onclick = () => {
                this.container.scrollTo({ top: 0, behavior: 'smooth' });
            };
        }

        this.backToTopBtn.classList.add('visible');
    }

    private hideBackToTopButton(): void {
        this.backToTopBtn?.classList.remove('visible');
    }

    async onunload(): Promise<void> {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }

        if (this.scrollTimeout) {
            clearTimeout(this.scrollTimeout);
            this.scrollTimeout = null;
        }

        this.backToTopBtn?.remove();
        this.backToTopBtn = null;

        this.searchComponent?.destroy();
        this.searchComponent = null;

        this.imageGrid?.destroy();
        this.imageGrid = null;

        this.searchService.clearCache();
    }

    async onload(): Promise<void> {
        await ImageCache.init();
    }
}
