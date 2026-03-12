import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { SmMsSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Setting } from 'obsidian';
import { t } from '../i18n';
import { buildMultipartBody, generateBoundary } from './shared/multipart';
import { simulateProgress } from './shared/progress';
import { getArray, getBoolean, getNumber, getRecord, getString } from '../utils/typeGuards';

export class SmMsProvider implements IOssProvider {
    name = 'smms';
    private settings: SmMsSettings;

    constructor(settings: SmMsSettings) {
        this.settings = settings;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.token) {
            throw new Error(t('Please configure OSS settings first'));
        }

        const boundary = generateBoundary();

        const bodyArrayBuffer = buildMultipartBody([
            { name: 'smfile', value: new Uint8Array(await file.arrayBuffer()), filename: file.name, contentType: file.type || 'application/octet-stream' },
            { name: 'format', value: 'json' }
        ], boundary);

        const requestParams: RequestUrlParam = {
            url: 'https://sm.ms/api/v2/upload',
            method: 'POST',
            headers: {
                'Authorization': this.settings.token,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: bodyArrayBuffer
        };

        try {
            simulateProgress(onProgress, file.size);

            const response = await requestUrl(requestParams);

            const data = getRecord(response.json as unknown);
            const uploadData = getRecord(data?.data);
            const imageUrl = getString(uploadData?.url);
            const repeatedImageUrl = getString(data?.images);
            const code = getString(data?.code);

            if (getBoolean(data?.success) && imageUrl) {
                return imageUrl;
            } else if (code === 'image_repeated' && repeatedImageUrl) {
                return repeatedImageUrl;
            } else {
                throw new Error(getString(data?.message) || `Upload failed with code: ${code ?? 'unknown'}`);
            }
        } catch (error) {
            console.error('SM.MS upload error:', error);
            throw new Error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // SM.MS API for listing history is https://sm.ms/api/v2/upload_history
        // But it might require different permissions or return structure.
        // For now, we can try to implement it or return empty if not supported.
        // Let's assume we want to support it if possible.
        
        try {
            const response = await requestUrl({
                url: 'https://sm.ms/api/v2/upload_history',
                method: 'GET',
                headers: {
                    'Authorization': this.settings.token
                }
            });

            if (response.status === 200) {
                const data = getRecord(response.json as unknown);
                if (getBoolean(data?.success)) {
                    return (getArray(data?.data) ?? []).flatMap((item) => {
                        const record = getRecord(item);
                        const key = getString(record?.hash);
                        const url = getString(record?.url);
                        if (!key || !url) {
                            return [];
                        }

                        const createdAt = getString(record?.created_at);
                        return [{
                            key,
                            url,
                            lastModified: createdAt ? new Date(createdAt) : undefined,
                            size: getNumber(record?.size) ?? 0,
                        }];
                    });
                }
            }
        } catch (e) {
            console.error('Failed to list SM.MS images', e);
        }
        return [];
    }

    async deleteImage(key: string): Promise<void> {
        // SM.MS delete API: https://sm.ms/api/v2/delete/:hash
        try {
            const response = await requestUrl({
                url: `https://sm.ms/api/v2/delete/${key}`,
                method: 'GET', // Documentation says GET for delete? Or DELETE? Usually GET for SM.MS delete link, but API might be different.
                // Checking docs: https://doc.sm.ms/#api-Image-Deletion
                // It says GET /delete/:hash
                headers: {
                    'Authorization': this.settings.token
                }
            });
            
            const data = getRecord(response.json as unknown);
            if (response.status !== 200 || !getBoolean(data?.success)) {
                throw new Error(getString(data?.message) || 'Delete failed');
            }
        } catch (e) {
            throw new Error(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        new Setting(containerEl)
            .setName(t('Token'))
            .setDesc(t('SM.MS Secret Token'))
            .addText(text => text
                .setPlaceholder('Enter your token')
                .setValue(settings.providers.smms.token)
                .onChange(async (value) => {
                    settings.providers.smms.token = value;
                    await saveSettings();
                }));
    }
}
