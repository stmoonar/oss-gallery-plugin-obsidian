import { IStorageProvider, UploadProgressInfo } from '../types/oss';
import { t } from '../i18n';

// Re-export for backward compatibility
export type UploadProgress = UploadProgressInfo;

export class UploadService {
    private provider: IStorageProvider;

    constructor(provider: IStorageProvider) {
        this.provider = provider;
    }

    updateProvider(provider: IStorageProvider) {
        this.provider = provider;
    }

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
