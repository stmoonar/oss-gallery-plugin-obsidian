import { IOssProvider, OssImage } from '../types/oss';
import { SmMsSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Notice, Setting } from 'obsidian';
import { t } from '../i18n';

export class SmMsProvider implements IOssProvider {
    name = 'smms';
    private settings: SmMsSettings;

    constructor(settings: SmMsSettings) {
        this.settings = settings;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void
    ): Promise<string> {
        if (!this.settings.token) {
            throw new Error(t('Please configure OSS settings first'));
        }

        // Get file as ArrayBuffer (binary data) - NOT base64
        const fileArrayBuffer = await file.arrayBuffer();
        const fileBytes = new Uint8Array(fileArrayBuffer);

        // Use requestUrl like MinIO does, but with proper multipart encoding
        const boundary = '----ObsidianFormBoundary' + Math.random().toString(36).substr(2, 16);
        const encoder = new TextEncoder();

        // Build the multipart body with binary file data
        const parts: Uint8Array[] = [];

        // Add boundary and headers
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="smfile"; filename="${encodeURIComponent(file.name)}"\r\n`));
        parts.push(encoder.encode(`Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));

        // Add the actual file data (binary)
        parts.push(fileBytes);
        parts.push(encoder.encode('\r\n'));

        // Add format field
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="format"\r\n\r\n`));
        parts.push(encoder.encode('json\r\n'));
        parts.push(encoder.encode(`--${boundary}--\r\n`));

        // Combine all parts into a single ArrayBuffer
        const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
        const bodyArrayBuffer = new ArrayBuffer(totalLength);
        const bodyView = new Uint8Array(bodyArrayBuffer);
        let offset = 0;
        for (const part of parts) {
            bodyView.set(part, offset);
            offset += part.length;
        }

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
            // Simulate progress since requestUrl doesn't support it
            if (onProgress) {
                setTimeout(() => onProgress({ loaded: 0, total: file.size, percentage: 0 }), 0);
                setTimeout(() => onProgress({ loaded: file.size, total: file.size, percentage: 100 }), 100);
            }

            // Log the request for debugging
            console.log('SM.MS Request Headers:', requestParams.headers);
            console.log('SM.MS Request Body size:', bodyArrayBuffer.byteLength);

            const response = await requestUrl(requestParams);
            console.log('SM.MS Response status:', response.status);
            console.log('SM.MS Response:', response.json);

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
            throw new Error(`Upload failed: ${error.message}`);
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
            throw new Error(`Delete failed: ${e.message}`);
        }
    }

    getSettingsTab(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
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
