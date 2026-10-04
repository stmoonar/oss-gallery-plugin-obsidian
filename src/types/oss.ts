import { PluginSettings } from './settings';

export interface OssImage {
    key: string;
    url: string;
    lastModified?: Date;
    size: number;
}

export interface SearchResult {
    matchedObjects: OssImage[];
    totalCount: number;
}

export interface UploadProgressInfo {
    loaded: number;
    total: number;
    percentage: number;
}

/**
 * Core storage operations - no UI dependency.
 */
export interface IStorageProvider {
    name: string;

    upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string>;

    /**
     * List stored images. `prefix` is a directory relative to the provider's
     * own path setting (the same space as the `path` passed to upload), used
     * to scope the listing to the configured base path. Providers without
     * folders (e.g. S.EE) ignore it.
     */
    listImages(prefix?: string): Promise<OssImage[]>;

    deleteImage(key: string): Promise<void>;
}

/**
 * Settings UI renderer - separated from storage logic.
 */
export interface IProviderSettingsRenderer {
    renderSettings(
        containerEl: HTMLElement,
        settings: PluginSettings,
        saveSettings: () => Promise<void>
    ): void;
}

/**
 * Combined interface for backward compatibility.
 * Providers implement both storage and settings rendering.
 */
export interface IOssProvider extends IStorageProvider, IProviderSettingsRenderer {}
