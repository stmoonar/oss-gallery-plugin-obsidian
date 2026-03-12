import { getNumber, getRecord, getString } from './typeGuards';

interface CachedImageEntry {
    data: string;
    timestamp: number;
    size: number;
}

interface CachedImageStore {
    data: Record<string, CachedImageEntry>;
    timestamp: number;
}

export class ImageCache {
    private static imageCache: Map<string, CachedImageEntry> = new Map();
    private static readonly CACHE_KEY = 'oss-gallery-cache';
    private static readonly LEGACY_CACHE_KEY = 'minio-gallery-cache';
    private static readonly CACHE_EXPIRY = 12 * 60 * 60 * 1000; // 12小时
    private static readonly MAX_CACHE_SIZE = 50 * 1024 * 1024; // 50MB
    private static saveTimeout: number | null = null;
    private static dirty = false;

    private static getStorage(): Storage {
        return window.localStorage;
    }

    static async init() {
        try {
            const storage = this.getStorage();
            const savedCache = storage.getItem(this.CACHE_KEY) ?? storage.getItem(this.LEGACY_CACHE_KEY);
            if (savedCache) {
                const parsed = this.parseCacheStore(JSON.parse(savedCache) as unknown);
                if (parsed && Date.now() - parsed.timestamp < this.CACHE_EXPIRY) {
                    this.imageCache = new Map(Object.entries(parsed.data));
                    if (!storage.getItem(this.CACHE_KEY)) {
                        storage.setItem(this.CACHE_KEY, savedCache);
                    }
                    storage.removeItem(this.LEGACY_CACHE_KEY);
                }
            }
        } catch (err) {
            console.error('Failed to load image cache:', err);
        }
    }

    static async get(key: string): Promise<string | null> {
        const cached = this.imageCache.get(key);
        if (!cached) return null;

        // 检查过期时间
        if (Date.now() - cached.timestamp > this.CACHE_EXPIRY) {
            this.imageCache.delete(key);
            this.dirty = true;
            this.scheduleSave();
            return null;
        }

        return cached.data;
    }

    static async set(key: string, data: string): Promise<void> {
        // 检查缓存大小
        const dataSize = new Blob([data]).size;
        if (this.getTotalCacheSize() + dataSize > this.MAX_CACHE_SIZE) {
            this.cleanupOldCache();
        }

        this.imageCache.set(key, {
            data,
            timestamp: Date.now(),
            size: dataSize
        });

        this.dirty = true;
        this.scheduleSave();
    }

    static has(key: string): boolean {
        const cached = this.imageCache.get(key);
        if (!cached) return false;

        // 检查过期时间
        if (Date.now() - cached.timestamp > this.CACHE_EXPIRY) {
            this.imageCache.delete(key);
            this.dirty = true;
            this.scheduleSave();
            return false;
        }

        return true;
    }

    static delete(key: string): void {
        this.imageCache.delete(key);
        this.dirty = true;
        this.scheduleSave();
    }

    static clear(): void {
        this.imageCache.clear();
        const storage = this.getStorage();
        storage.removeItem(this.CACHE_KEY);
        storage.removeItem(this.LEGACY_CACHE_KEY);
    }

    private static getTotalCacheSize(): number {
        let totalSize = 0;
        this.imageCache.forEach(entry => {
            totalSize += entry.size;
        });
        return totalSize;
    }

    private static cleanupOldCache(): void {
        // 按LRU策略清理缓存
        const entries = Array.from(this.imageCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);

        const targetSize = this.MAX_CACHE_SIZE * 0.7; // 清理到70%

        for (const [key] of entries) {
            if (this.getTotalCacheSize() <= targetSize) break;

            this.imageCache.delete(key);
        }

        this.dirty = true;
        this.scheduleSave();
    }

    private static scheduleSave(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = window.setTimeout(() => {
            this.saveCache();
            this.saveTimeout = null;
        }, 1000); // 1秒后保存
    }

    private static saveCache(): void {
        if (!this.dirty) return;

        try {
            const data = Object.fromEntries(this.imageCache);
            this.getStorage().setItem(this.CACHE_KEY, JSON.stringify({
                data,
                timestamp: Date.now()
            }));
            this.dirty = false;
        } catch (err) {
            console.error('Failed to save image cache:', err);
        }
    }

    static getStats(): { count: number, totalSize: number, totalSizeMB: number } {
        const count = this.imageCache.size;
        const totalSize = this.getTotalCacheSize();
        return {
            count,
            totalSize,
            totalSizeMB: Math.round(totalSize / (1024 * 1024) * 100) / 100
        };
    }

    private static parseCacheStore(value: unknown): CachedImageStore | null {
        const record = getRecord(value);
        const data = getRecord(record?.data);
        const timestamp = getNumber(record?.timestamp);
        if (!data || timestamp === undefined) {
            return null;
        }

        const parsedEntries = Object.entries(data).flatMap(([key, entryValue]) => {
            const entry = getRecord(entryValue);
            const entryData = getString(entry?.data);
            const entryTimestamp = getNumber(entry?.timestamp);
            const size = getNumber(entry?.size);

            if (entryData === undefined || entryTimestamp === undefined || size === undefined) {
                return [];
            }

            return [[key, {
                data: entryData,
                timestamp: entryTimestamp,
                size,
            } satisfies CachedImageEntry]];
        });

        return {
            data: Object.fromEntries(parsedEntries) as Record<string, CachedImageEntry>,
            timestamp,
        };
    }
}
