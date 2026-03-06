import { IOssProvider, OssImage } from '../types/oss';
import { QiniuSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Notice, Setting } from 'obsidian';
import { t } from '../i18n';
import { createHmac } from 'crypto';
import * as Base64 from 'js-base64';

export class QiniuProvider implements IOssProvider {
    name = 'qiniu';
    private settings: QiniuSettings;

    constructor(settings: QiniuSettings) {
        this.settings = settings;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void
    ): Promise<string> {
        if (!this.settings.accessKey || !this.settings.secretKey || !this.settings.bucket) {
            throw new Error(t('Please configure Qiniu settings first'));
        }

        // Simulate progress since requestUrl doesn't support it
        if (onProgress) {
            setTimeout(() => onProgress({ loaded: 0, total: file.size, percentage: 0 }), 0);
            setTimeout(() => onProgress({ loaded: file.size, total: file.size, percentage: 100 }), 100);
        }

        // Normalize path prefix - remove leading slash, trim trailing slash
        let normalizedPath = this.settings.path ? this.settings.path.trim() : '';
        normalizedPath = normalizedPath.replace(/^\/+/, '').replace(/\/+$/, '');

        // Build key
        const key = normalizedPath ? `${normalizedPath}/${path}` : path;

        // Generate upload token
        const token = this.generateUploadToken(key);

        // Determine upload URL based on area
        let uploadUrl = 'https://upload.qiniup.com';
        if (this.settings.area === 'z0') uploadUrl = 'https://upload-z1.qiniup.com';
        else if (this.settings.area === 'na0') uploadUrl = 'https://upload-na0.qiniup.com';
        else if (this.settings.area === 'as0') uploadUrl = 'https://upload-as0.qiniup.com';

        // Create form data
        const boundary = '----ObsidianFormBoundary' + Math.random().toString(36).substr(2, 16);
        const encoder = new TextEncoder();

        const parts: Uint8Array[] = [];

        // Add token
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="token"\r\n\r\n`));
        parts.push(encoder.encode(`${token}\r\n`));

        // Add key
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="key"\r\n\r\n`));
        parts.push(encoder.encode(`${key}\r\n`));

        // Add file
        const fileArrayBuffer = await file.arrayBuffer();
        const fileBytes = new Uint8Array(fileArrayBuffer);

        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="file"; filename="${encodeURIComponent(file.name)}"\r\n`));
        parts.push(encoder.encode(`Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
        parts.push(fileBytes);
        parts.push(encoder.encode('\r\n'));

        parts.push(encoder.encode(`--${boundary}--\r\n`));

        // Combine all parts
        const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
        const bodyArrayBuffer = new ArrayBuffer(totalLength);
        const bodyView = new Uint8Array(bodyArrayBuffer);
        let offset = 0;
        for (const part of parts) {
            bodyView.set(part, offset);
            offset += part.length;
        }

        const requestParams: RequestUrlParam = {
            url: uploadUrl,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: bodyArrayBuffer
        };

        try {
            const response = await requestUrl(requestParams);

            if (response.status === 200) {
                const data = response.json;
                if (data.hash) {
                    // Return custom URL if configured
                    const baseUrl = this.settings.url || `https://${this.settings.bucket}.qiniudn.com`;
                    return `${baseUrl}/${key}`;
                } else {
                    throw new Error(data.error || 'Upload failed');
                }
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Qiniu upload error:', error);
            throw new Error(`Upload failed: ${error.message}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // Qiniu ListFiles API
        if (!this.settings.accessKey || !this.settings.secretKey || !this.settings.bucket) {
            return [];
        }

        try {
            // Qiniu requires different API for listing files
            const url = 'https://rsf.qbox.me/list';
            const listPrefix = prefix || '';

            const body = JSON.stringify({
                bucket: this.settings.bucket,
                prefix: listPrefix,
                limit: 1000
            });

            const authorization = this.generateAuthHeader('POST', '/list', body, 'rsf.qbox.me', 'application/json');

            const response = await requestUrl({
                url: url,
                method: 'POST',
                headers: {
                    'Authorization': authorization,
                    'Content-Type': 'application/json'
                },
                body: body
            });

            if (response.status === 200) {
                const data = response.json;
                const images: OssImage[] = [];

                if (data.items) {
                    const baseUrl = this.settings.url || `https://${this.settings.bucket}.qiniudn.com`;

                    for (const item of data.items) {
                        // Filter for image files
                        if (this.isImageFile(item.key)) {
                            images.push({
                                key: item.key,
                                url: `${baseUrl}/${item.key}`,
                                lastModified: new Date(item.putTime / 10000), // Qiniu timestamp is in 100ns
                                size: item.fsize
                            });
                        }
                    }
                }

                return images;
            }
        } catch (error) {
            console.error('Failed to list Qiniu images:', error);
        }
        return [];
    }

    async deleteImage(key: string): Promise<void> {
        if (!this.settings.accessKey || !this.settings.secretKey || !this.settings.bucket) {
            throw new Error(t('Please configure Qiniu settings first'));
        }

        try {
            // Qiniu delete API
            const encodedEntry = Base64.encode(`${this.settings.bucket}:${key}`);
            const url = `https://rs.qbox.me/delete/${encodedEntry}`;

            const authorization = this.generateAuthHeader('POST', `/delete/${encodedEntry}`, '', 'rs.qbox.me', 'application/x-www-form-urlencoded');

            const response = await requestUrl({
                url: url,
                method: 'POST',
                headers: {
                    'Authorization': authorization,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            if (response.status !== 200) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete Qiniu image:', error);
            throw new Error(`Delete failed: ${error.message}`);
        }
    }

    private generateUploadToken(key: string): string {
        const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour expiry
        const policy = {
            scope: `${this.settings.bucket}:${key}`,
            deadline: deadline
        };

        const encodedPolicy = Base64.encode(JSON.stringify(policy));
        const signature = createHmac('sha1', this.settings.secretKey)
            .update(encodedPolicy)
            .digest('base64');

        return `${this.settings.accessKey}:${signature}:${encodedPolicy}`;
    }

    private generateAuthHeader(method: string, path: string, body: string, host: string, contentType: string): string {
        const signingStr = `${method} ${path}\nHost: ${host}\nContent-Type: ${contentType}\n\n${body}`;
        const signature = createHmac('sha1', this.settings.secretKey)
            .update(signingStr)
            .digest('base64');

        return `QBox ${this.settings.accessKey}:${signature}`;
    }

    getSettingsTab(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        new Setting(containerEl)
            .setName(t('Access Key'))
            .setDesc(t('Qiniu Access Key'))
            .addText(text => text
                .setPlaceholder('Enter your Access Key')
                .setValue(settings.providers.qiniu?.accessKey || '')
                .onChange(async (value) => {
                    if (!settings.providers.qiniu) {
                        settings.providers.qiniu = {
                            accessKey: '',
                            secretKey: '',
                            bucket: '',
                            url: '',
                            area: 'z0',
                            path: ''
                        };
                    }
                    settings.providers.qiniu.accessKey = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Secret Key'))
            .setDesc(t('Qiniu Secret Key'))
            .addText(text => text
                .setPlaceholder('Enter your Secret Key')
                .setValue(settings.providers.qiniu?.secretKey || '')
                .onChange(async (value) => {
                    if (!settings.providers.qiniu) {
                        settings.providers.qiniu = {
                            accessKey: '',
                            secretKey: '',
                            bucket: '',
                            url: '',
                            area: 'z0',
                            path: ''
                        };
                    }
                    settings.providers.qiniu.secretKey = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Bucket'))
            .setDesc(t('Qiniu Bucket name'))
            .addText(text => text
                .setPlaceholder('bucket-name')
                .setValue(settings.providers.qiniu?.bucket || '')
                .onChange(async (value) => {
                    if (!settings.providers.qiniu) {
                        settings.providers.qiniu = {
                            accessKey: '',
                            secretKey: '',
                            bucket: '',
                            url: '',
                            area: 'z0',
                            path: ''
                        };
                    }
                    settings.providers.qiniu.bucket = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('URL'))
            .setDesc(t('Qiniu CDN domain URL'))
            .addText(text => text
                .setPlaceholder('https://your-domain.qiniudn.com')
                .setValue(settings.providers.qiniu?.url || '')
                .onChange(async (value) => {
                    if (!settings.providers.qiniu) {
                        settings.providers.qiniu = {
                            accessKey: '',
                            secretKey: '',
                            bucket: '',
                            url: '',
                            area: 'z0',
                            path: ''
                        };
                    }
                    settings.providers.qiniu.url = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Area'))
            .setDesc(t('Qiniu storage area (z0: East China, z1: North China, na0: North America, as0: Southeast Asia)'))
            .addText(text => text
                .setPlaceholder('z0')
                .setValue(settings.providers.qiniu?.area || 'z0')
                .onChange(async (value) => {
                    if (!settings.providers.qiniu) {
                        settings.providers.qiniu = {
                            accessKey: '',
                            secretKey: '',
                            bucket: '',
                            url: '',
                            area: 'z0',
                            path: ''
                        };
                    }
                    settings.providers.qiniu.area = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Path'))
            .setDesc(t('Path prefix for uploaded files (optional)'))
            .addText(text => text
                .setPlaceholder('path/to/folder')
                .setValue(settings.providers.qiniu?.path || '')
                .onChange(async (value) => {
                    if (!settings.providers.qiniu) {
                        settings.providers.qiniu = {
                            accessKey: '',
                            secretKey: '',
                            bucket: '',
                            url: '',
                            area: 'z0',
                            path: ''
                        };
                    }
                    settings.providers.qiniu.path = value;
                    await saveSettings();
                }));
    }

    private isImageFile(key: string): boolean {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
        const ext = key.toLowerCase().substring(key.lastIndexOf('.'));
        return imageExtensions.includes(ext);
    }
}