import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { AliyunSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, RequestUrlResponse, Setting } from 'obsidian';
import { t } from '../i18n';
import { createHmac } from 'crypto';
import { simulateProgress } from './shared/progress';
import {
    buildObjectKey,
    encodeObjectKeyForUrl,
    normalizeBaseUrl,
    normalizeEndpointHost,
} from './shared/path';
import { parseS3ListObjectsPage } from './shared/s3xml';
import { isImageFile } from './shared/image';

export class AliyunProvider implements IOssProvider {
    name = 'aliyun';
    private settings: AliyunSettings;

    constructor(settings: AliyunSettings) {
        this.settings = settings;
    }

    private getDefaultHost(): string {
        return `${this.settings.bucket}.${this.settings.area}.aliyuncs.com`;
    }

    private getDefaultApiBaseUrl(): string {
        return `https://${this.getDefaultHost()}`;
    }

    private getApiBaseUrls(): string[] {
        const customHost = this.settings.customUrl
            ? normalizeEndpointHost(this.settings.customUrl)
            : '';
        const customBaseUrl = customHost ? `https://${customHost}` : '';
        if (customBaseUrl && customBaseUrl !== this.getDefaultApiBaseUrl()) {
            return [this.getDefaultApiBaseUrl(), customBaseUrl];
        }
        return [this.getDefaultApiBaseUrl()];
    }

    private async requestApi(buildRequest: (baseUrl: string) => RequestUrlParam): Promise<RequestUrlResponse> {
        let lastError: unknown;

        for (const baseUrl of this.getApiBaseUrls()) {
            try {
                return await requestUrl(buildRequest(baseUrl));
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError instanceof Error ? lastError : new Error('Aliyun OSS request failed');
    }

    private getPublicBaseUrl(): string {
        if (this.settings.customUrl) {
            return normalizeBaseUrl(this.settings.customUrl);
        }
        return `https://${this.getDefaultHost()}`;
    }

    private buildPublicUrl(objectKey: string): string {
        return `${this.getPublicBaseUrl()}/${encodeObjectKeyForUrl(objectKey)}`;
    }

    private createAuthorization(
        method: 'PUT' | 'GET' | 'DELETE',
        date: string,
        objectKey = '',
        contentType = ''
    ): string {
        const canonicalString = [
            method,
            '',
            contentType,
            date,
            `/${this.settings.bucket}/${objectKey}`,
        ].join('\n');

        const signature = createHmac('sha1', this.settings.accessKeySecret)
            .update(canonicalString, 'utf8')
            .digest('base64');

        return `OSS ${this.settings.accessKeyId}:${signature}`;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.accessKeyId || !this.settings.accessKeySecret || !this.settings.bucket) {
            throw new Error(t('Please configure Aliyun OSS settings first'));
        }

        // Simulate progress since requestUrl doesn't support it
        simulateProgress(onProgress, file.size);

        // Build object key
        const objectKey = buildObjectKey(this.settings.path, path);
        const encodedObjectKey = encodeObjectKeyForUrl(objectKey);

        // Generate authorization header
        const date = new Date().toUTCString();
        const contentType = file.type || 'application/octet-stream';
        const authorization = this.createAuthorization('PUT', date, objectKey, contentType);
        const body = await file.arrayBuffer();

        try {
            const response = await this.requestApi((baseUrl) => ({
                url: `${baseUrl}/${encodedObjectKey}`,
                method: 'PUT',
                headers: {
                    'Authorization': authorization,
                    'Date': date,
                    'Content-Type': contentType,
                },
                body,
            }));

            if (response.status === 200) {
                return this.buildPublicUrl(objectKey);
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Aliyun OSS upload error:', error);
            throw new Error(`Upload failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // Aliyun OSS ListObjects API
        if (!this.settings.accessKeyId || !this.settings.accessKeySecret || !this.settings.bucket) {
            return [];
        }

        try {
            const images: OssImage[] = [];
            let marker = '';

            while (true) {
                const date = new Date().toUTCString();
                const authorization = this.createAuthorization('GET', date);
                const query = new URLSearchParams({ 'max-keys': '1000' });
                if (prefix) {
                    query.append('prefix', prefix);
                }
                if (marker) {
                    query.append('marker', marker);
                }

                const response = await this.requestApi((baseUrl) => ({
                    url: `${baseUrl}/?${query.toString()}`,
                    method: 'GET',
                    headers: {
                        'Authorization': authorization,
                        'Date': date,
                    },
                }));

                const page = parseS3ListObjectsPage(response.text);
                images.push(
                    ...page.objects
                        .filter((item) => isImageFile(item.key))
                        .map((item) => ({
                            key: item.key,
                            url: this.buildPublicUrl(item.key),
                            lastModified: item.lastModified,
                            size: item.size,
                        }))
                );

                const nextMarker = page.nextMarker || page.objects[page.objects.length - 1]?.key;
                if (!page.isTruncated || !nextMarker || nextMarker === marker) {
                    return images;
                }

                marker = nextMarker;
            }
        } catch (error) {
            console.error('Failed to list Aliyun OSS images:', error);
        }
        return [];
    }

    async deleteImage(key: string): Promise<void> {
        if (!this.settings.accessKeyId || !this.settings.accessKeySecret || !this.settings.bucket) {
            throw new Error(t('Please configure Aliyun OSS settings first'));
        }

        try {
            const date = new Date().toUTCString();
            const authorization = this.createAuthorization('DELETE', date, key);
            const encodedKey = encodeObjectKeyForUrl(key);

            const response = await this.requestApi((baseUrl) => ({
                url: `${baseUrl}/${encodedKey}`,
                method: 'DELETE',
                headers: {
                    'Authorization': authorization,
                    'Date': date,
                },
            }));

            if (response.status !== 204) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete Aliyun OSS image:', error);
            throw new Error(`Delete failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        new Setting(containerEl)
            .setName(t('Access Key ID'))
            .setDesc(t('Aliyun OSS Access Key ID'))
            .addText(text => text
                .setPlaceholder('Enter your Access Key ID')
                .setValue(settings.providers.aliyun?.accessKeyId || '')
                .onChange(async (value) => {
                    if (!settings.providers.aliyun) {
                        settings.providers.aliyun = {
                            accessKeyId: '',
                            accessKeySecret: '',
                            bucket: '',
                            area: 'oss-cn-hangzhou',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.aliyun.accessKeyId = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Access Key Secret'))
            .setDesc(t('Aliyun OSS Access Key Secret'))
            .addText(text => text
                .setPlaceholder('Enter your Access Key Secret')
                .setValue(settings.providers.aliyun?.accessKeySecret || '')
                .onChange(async (value) => {
                    if (!settings.providers.aliyun) {
                        settings.providers.aliyun = {
                            accessKeyId: '',
                            accessKeySecret: '',
                            bucket: '',
                            area: 'oss-cn-hangzhou',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.aliyun.accessKeySecret = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Bucket'))
            .setDesc(t('Aliyun OSS Bucket name'))
            .addText(text => text
                .setPlaceholder('bucket-name')
                .setValue(settings.providers.aliyun?.bucket || '')
                .onChange(async (value) => {
                    if (!settings.providers.aliyun) {
                        settings.providers.aliyun = {
                            accessKeyId: '',
                            accessKeySecret: '',
                            bucket: '',
                            area: 'oss-cn-hangzhou',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.aliyun.bucket = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Region'))
            .setDesc(t('Aliyun OSS Region (e.g., oss-cn-hangzhou)'))
            .addText(text => text
                .setPlaceholder('oss-cn-hangzhou')
                .setValue(settings.providers.aliyun?.area || 'oss-cn-hangzhou')
                .onChange(async (value) => {
                    if (!settings.providers.aliyun) {
                        settings.providers.aliyun = {
                            accessKeyId: '',
                            accessKeySecret: '',
                            bucket: '',
                            area: 'oss-cn-hangzhou',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.aliyun.area = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Path'))
            .setDesc(t('Path prefix for uploaded files (optional)'))
            .addText(text => text
                .setPlaceholder('path/to/folder')
                .setValue(settings.providers.aliyun?.path || '')
                .onChange(async (value) => {
                    if (!settings.providers.aliyun) {
                        settings.providers.aliyun = {
                            accessKeyId: '',
                            accessKeySecret: '',
                            bucket: '',
                            area: 'oss-cn-hangzhou',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.aliyun.path = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Custom Domain'))
            .setDesc(t('Custom domain for CDN (optional)'))
            .addText(text => text
                .setPlaceholder('https://cdn.example.com')
                .setValue(settings.providers.aliyun?.customUrl || '')
                .onChange(async (value) => {
                    if (!settings.providers.aliyun) {
                        settings.providers.aliyun = {
                            accessKeyId: '',
                            accessKeySecret: '',
                            bucket: '',
                            area: 'oss-cn-hangzhou',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.aliyun.customUrl = value;
                    await saveSettings();
                }));

    }
}
