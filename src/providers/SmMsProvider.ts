import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { SmMsSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Setting } from 'obsidian';
import { t } from '../i18n';
import { buildMultipartBody, generateBoundary } from './shared/multipart';
import { simulateProgress } from './shared/progress';

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

            const data = response.json;

            if (data.success) {
                return data.data.url;
            } else if (data.code === 'image_repeated') {
                return data.images;
            } else {
                throw new Error(data.message || `Upload failed with code: ${data.code}`);
            }
        } catch (error) {
            console.error('SM.MS upload error:', error);
            throw new Error(`Upload failed: ${error instanceof Error ? error.message : error}`);
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
                const data = response.json;
                if (data.success) {
                    return data.data.map((item: any) => ({
                        key: item.hash, // SM.MS uses hash as ID
                        url: item.url,
                        lastModified: new Date(item.created_at), // Assuming created_at exists
                        size: item.size
                    }));
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
            
            if (response.status !== 200 || !response.json.success) {
                throw new Error(response.json.message || 'Delete failed');
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
