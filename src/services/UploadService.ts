import { IOssProvider } from '../types/oss';
import { Notice } from 'obsidian';
import { t } from '../i18n';

export interface UploadProgress {
    loaded: number;
    total: number;
    percentage: number;
}

export class UploadService {
    private provider: IOssProvider;

    constructor(provider: IOssProvider) {
        this.provider = provider;
    }

    updateProvider(provider: IOssProvider) {
        this.provider = provider;
    }

    /**
     * Upload file using the current provider
     * Returns the access URL
     */
    async uploadFile(
        file: File,
        objectName: string,
        onProgress?: (progress: UploadProgress) => void
    ): Promise<string> {
        if (!this.provider) {
            throw new Error(t('No active provider'));
        }

        return await this.provider.upload(file, objectName, onProgress);
    }
}