import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { QiniuSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Setting } from 'obsidian';
import { t } from '../i18n';
import { buildMultipartBody, generateBoundary } from './shared/multipart';
import { simulateProgress } from './shared/progress';
import { isImageFile } from './shared/image';
import { buildObjectKey, encodeObjectKeyForUrl, normalizeBaseUrl } from './shared/path';
import {
    createQiniuAccessTokenV2,
    createQiniuUploadToken,
    encodeQiniuEntry,
} from './shared/qiniu';

export class QiniuProvider implements IOssProvider {
    name = 'qiniu';
    private settings: QiniuSettings;

    constructor(settings: QiniuSettings) {
        this.settings = settings;
    }

    private getUploadUrl(): string {
        const normalizedArea = this.settings.area.trim();
        const knownHosts: Record<string, string> = {
            z0: 'https://up-z0.qiniup.com',
            z1: 'https://up-z1.qiniup.com',
            z2: 'https://up-z2.qiniup.com',
            na0: 'https://up-na0.qiniup.com',
            as0: 'https://up-as0.qiniup.com',
        };

        return knownHosts[normalizedArea] || `https://up-${normalizedArea}.qiniup.com`;
    }

    private getPublicBaseUrl(): string {
        if (this.settings.url) {
            return normalizeBaseUrl(this.settings.url);
        }
        return `https://${this.settings.bucket}.qiniudn.com`;
    }

    private buildPublicUrl(key: string): string {
        return `${this.getPublicBaseUrl()}/${encodeObjectKeyForUrl(key)}`;
    }

    private createManagementAuthorization(
        host: string,
        method: string,
        path: string,
        queryString?: string,
        contentType?: string,
        body?: string
    ): string {
        const token = createQiniuAccessTokenV2({
            accessKey: this.settings.accessKey,
            secretKey: this.settings.secretKey,
            method,
            host,
            path,
            queryString,
            contentType,
            body,
        });

        return `Qiniu ${token}`;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.accessKey || !this.settings.secretKey || !this.settings.bucket) {
            throw new Error(t('Please configure Qiniu settings first'));
        }

        // Simulate progress since requestUrl doesn't support it
        simulateProgress(onProgress, file.size);

        // Build key
        const key = buildObjectKey(this.settings.path, path);

        // Generate upload token
        const token = createQiniuUploadToken(this.settings.accessKey, this.settings.secretKey, {
            scope: `${this.settings.bucket}:${key}`,
            deadline: Math.floor(Date.now() / 1000) + 3600,
        });
        const uploadUrl = this.getUploadUrl();

        // Create form data
        const boundary = generateBoundary();
        const bodyArrayBuffer = buildMultipartBody([
            { name: 'token', value: token },
            { name: 'key', value: key },
            { name: 'file', value: new Uint8Array(await file.arrayBuffer()), filename: file.name, contentType: file.type || 'application/octet-stream' }
        ], boundary);

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
                    return this.buildPublicUrl(key);
                } else {
                    throw new Error(data.error || 'Upload failed');
                }
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Qiniu upload error:', error);
            throw new Error(`Upload failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // Qiniu ListFiles API
        if (!this.settings.accessKey || !this.settings.secretKey || !this.settings.bucket) {
            return [];
        }

        try {
            const host = 'rsf.qiniuapi.com';
            const images: OssImage[] = [];
            let marker = '';

            while (true) {
                const query = new URLSearchParams({
                    bucket: this.settings.bucket,
                    limit: '1000',
                });
                if (prefix) {
                    query.append('prefix', prefix);
                }
                if (marker) {
                    query.append('marker', marker);
                }

                const queryString = query.toString();
                const authorization = this.createManagementAuthorization(
                    host,
                    'POST',
                    '/list',
                    queryString
                );

                const response = await requestUrl({
                    url: `https://${host}/list?${queryString}`,
                    method: 'POST',
                    headers: {
                        'Authorization': authorization,
                    },
                });

                if (response.status !== 200) {
                    throw new Error(`List failed with status: ${response.status}`);
                }

                const data = response.json;
                for (const item of data?.items || []) {
                    if (isImageFile(item.key)) {
                        images.push({
                            key: item.key,
                            url: this.buildPublicUrl(item.key),
                            lastModified: item.putTime ? new Date(item.putTime / 10000) : undefined,
                            size: item.fsize || 0,
                        });
                    }
                }

                const nextMarker = typeof data?.marker === 'string'
                    ? data.marker
                    : typeof data?.nextMarker === 'string'
                        ? data.nextMarker
                        : '';
                if (!nextMarker || nextMarker === marker) {
                    return images;
                }

                marker = nextMarker;
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
            const encodedEntry = encodeQiniuEntry(this.settings.bucket, key);
            const host = 'rs.qiniuapi.com';
            const path = `/delete/${encodedEntry}`;
            const authorization = this.createManagementAuthorization(host, 'POST', path);

            const response = await requestUrl({
                url: `https://${host}${path}`,
                method: 'POST',
                headers: {
                    'Authorization': authorization,
                },
            });

            if (response.status !== 200) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete Qiniu image:', error);
            throw new Error(`Delete failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
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

}
