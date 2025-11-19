import { Setting } from "obsidian";

export interface OssImage {
    key: string;
    url: string;
    lastModified: Date;
    size: number;
}

export interface SearchResult {
    matchedObjects: OssImage[];
    totalCount: number;
}

export interface IOssProvider {
    name: string;
    
    /**
     * Upload a file to the OSS
     * @param file The file to upload
     * @param path The path (including filename) to store the file
     * @param onProgress Optional callback for upload progress
     * @returns The public URL of the uploaded file
     */
    upload(
        file: File, 
        path: string,
        onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void
    ): Promise<string>;

    /**
     * List images in the OSS
     * @param prefix Optional prefix to filter images
     */
    listImages(prefix?: string): Promise<OssImage[]>;

    /**
     * Delete an image from the OSS
     * @param key The key (path) of the image to delete
     */
    deleteImage(key: string): Promise<void>;

    /**
     * Render settings for this provider
     * @param containerEl The container element to render settings into
     * @param settings The current plugin settings
     * @param saveSettings Callback to save settings
     */
    getSettingsTab(
        containerEl: HTMLElement, 
        settings: any, 
        saveSettings: () => Promise<void>
    ): void;
}
