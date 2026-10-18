import { PluginSettings } from './settings';

export interface OssImage {
    key: string;
    url: string;
    lastModified?: Date;
    size: number;
    /**
     * Content identity reported by the listing API: S3-style ETag, Qiniu
     * hash, GitHub blob sha. Used for the semantic index fingerprint; when
     * absent the fingerprint falls back to size + lastModified.
     */
    etag?: string;
}

/**
 * Result of IStorageProvider.listImages (docs/semantic-search.md §4.1).
 */
export interface ListResult {
    items: OssImage[];
    /**
     * false = the listing was cut short (page/request/depth cap) or part of
     * it failed. An incomplete listing must never be used to conclude that
     * an object was deleted.
     */
    complete: boolean;
    /**
     * Key prefix the listing covers ('' = the whole store). Keys outside it
     * were not looked at. Providers that ignore the requested prefix (S.EE)
     * report ''.
     */
    prefix: string;
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
    listImages(prefix?: string): Promise<ListResult>;

    /**
     * Key a listing reports for an object uploaded with `upload(file, path)`,
     * or null when it cannot be known up front (e.g. S.EE assigns its own
     * ids). Used to index uploads without downloading them again.
     */
    listingKeyForUpload?(path: string): string | null;

    /**
     * A signed GET (URL + headers for requestUrl) of an object key, for
     * providers that sign requests themselves (S3 / R2 / MinIO). Lets the
     * semantic index read private buckets whose public URL is refused.
     * null when the provider is not configured.
     */
    signedObjectGet?(key: string): { url: string; headers: Record<string, string> } | null;

    deleteImage(key: string): Promise<void>;

    /**
     * Check the settings with one cheap read-only request (e.g. a one-key
     * listing page, or reading the storage directory). Throws a descriptive
     * error on failure. Never uploads, writes or deletes anything. Providers
     * that can only be checked by uploading (Imgur) do not implement it.
     */
    testConnection?(): Promise<void>;
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
