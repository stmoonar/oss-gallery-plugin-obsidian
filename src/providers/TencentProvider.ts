import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { TencentSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Setting } from 'obsidian';
import { t } from '../i18n';
import { simulateProgress } from './shared/progress';
import { buildObjectKey, encodeObjectKeyForUrl, normalizeBaseUrl } from './shared/path';
import { parseS3ListObjectsPage } from './shared/s3xml';
import { isImageFile } from './shared/image';
import { createTencentCosAuthorization } from './shared/tencentcos';

export class TencentProvider implements IOssProvider {
    name = 'tencent';
    private settings: TencentSettings;

    constructor(settings: TencentSettings) {
        this.settings = settings;
    }

    private getHost(): string {
        return `${this.settings.bucket}.cos.${this.settings.region}.myqcloud.com`;
    }

    private getObjectPath(objectKey: string): string {
        return `/${encodeObjectKeyForUrl(objectKey)}`;
    }

    private buildPublicUrl(objectKey: string): string {
        const customUrl = this.settings.customUrl
            ? normalizeBaseUrl(this.settings.customUrl)
            : '';
        if (customUrl) {
            return `${customUrl}/${encodeObjectKeyForUrl(objectKey)}`;
        }
        return `https://${this.getHost()}/${encodeObjectKeyForUrl(objectKey)}`;
    }

    private generateAuthorization(
        method: string,
        pathname: string,
        query?: Record<string, string | number | boolean | undefined>,
        headers?: Record<string, string | number | undefined>
    ): string {
        return createTencentCosAuthorization({
            secretId: this.settings.secretId,
            secretKey: this.settings.secretKey,
            method,
            pathname,
            query,
            headers,
        });
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.secretId || !this.settings.secretKey || !this.settings.bucket) {
            throw new Error(t('Please configure Tencent COS settings first'));
        }

        // Simulate progress since requestUrl doesn't support it
        simulateProgress(onProgress, file.size);

        const objectKey = buildObjectKey(this.settings.path, path);
        const host = this.getHost();
        const objectPath = this.getObjectPath(objectKey);
        const url = `https://${host}${objectPath}`;
        const contentType = file.type || 'application/octet-stream';

        const authorization = this.generateAuthorization('PUT', objectPath, undefined, {
            host,
            'content-type': contentType,
        });

        const requestParams: RequestUrlParam = {
            url: url,
            method: 'PUT',
            headers: {
                'Authorization': authorization,
                'Content-Type': contentType,
            },
            body: await file.arrayBuffer(),
        };

        try {
            const response = await requestUrl(requestParams);

            if (response.status >= 200 && response.status < 300) {
                return this.buildPublicUrl(objectKey);
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Tencent COS upload error:', error);
            throw new Error(`Upload failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // Tencent COS ListObjects API
        if (!this.settings.secretId || !this.settings.secretKey || !this.settings.bucket) {
            return [];
        }

        try {
            const host = this.getHost();
            const images: OssImage[] = [];
            let marker = '';

            while (true) {
                const query: Record<string, string> = { 'max-keys': '1000' };
                if (prefix) {
                    query.prefix = prefix;
                }
                if (marker) {
                    query.marker = marker;
                }

                const authorization = this.generateAuthorization('GET', '/', query, { host });
                const queryString = new URLSearchParams(query).toString();
                const response = await requestUrl({
                    url: `https://${host}/?${queryString}`,
                    method: 'GET',
                    headers: {
                        'Authorization': authorization,
                    },
                });

                if (response.status !== 200) {
                    throw new Error(`List failed with status: ${response.status}`);
                }

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
            console.error('Failed to list Tencent COS images:', error);
        }
        return [];
    }

    async deleteImage(key: string): Promise<void> {
        if (!this.settings.secretId || !this.settings.secretKey || !this.settings.bucket) {
            throw new Error(t('Please configure Tencent COS settings first'));
        }

        try {
            const host = this.getHost();
            const objectPath = this.getObjectPath(key);
            const authorization = this.generateAuthorization('DELETE', objectPath, undefined, { host });

            const response = await requestUrl({
                url: `https://${host}${objectPath}`,
                method: 'DELETE',
                headers: {
                    'Authorization': authorization,
                },
            });

            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete Tencent COS image:', error);
            throw new Error(`Delete failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        new Setting(containerEl)
            .setName(t('Secret ID'))
            .setDesc(t('Tencent COS Secret ID'))
            .addText(text => text
                .setPlaceholder('Enter your Secret ID')
                .setValue(settings.providers.tencent?.secretId || '')
                .onChange(async (value) => {
                    if (!settings.providers.tencent) {
                        settings.providers.tencent = {
                            secretId: '',
                            secretKey: '',
                            bucket: '',
                            region: 'ap-shanghai',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.tencent.secretId = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Secret Key'))
            .setDesc(t('Tencent COS Secret Key'))
            .addText(text => text
                .setPlaceholder('Enter your Secret Key')
                .setValue(settings.providers.tencent?.secretKey || '')
                .onChange(async (value) => {
                    if (!settings.providers.tencent) {
                        settings.providers.tencent = {
                            secretId: '',
                            secretKey: '',
                            bucket: '',
                            region: 'ap-shanghai',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.tencent.secretKey = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Bucket'))
            .setDesc(t('Tencent COS Bucket name'))
            .addText(text => text
                .setPlaceholder('bucket-name-appid')
                .setValue(settings.providers.tencent?.bucket || '')
                .onChange(async (value) => {
                    if (!settings.providers.tencent) {
                        settings.providers.tencent = {
                            secretId: '',
                            secretKey: '',
                            bucket: '',
                            region: 'ap-shanghai',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.tencent.bucket = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Region'))
            .setDesc(t('Tencent COS Region (e.g., ap-shanghai)'))
            .addText(text => text
                .setPlaceholder('ap-shanghai')
                .setValue(settings.providers.tencent?.region || 'ap-shanghai')
                .onChange(async (value) => {
                    if (!settings.providers.tencent) {
                        settings.providers.tencent = {
                            secretId: '',
                            secretKey: '',
                            bucket: '',
                            region: 'ap-shanghai',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.tencent.region = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Path'))
            .setDesc(t('Path prefix for uploaded files (optional)'))
            .addText(text => text
                .setPlaceholder('path/to/folder')
                .setValue(settings.providers.tencent?.path || '')
                .onChange(async (value) => {
                    if (!settings.providers.tencent) {
                        settings.providers.tencent = {
                            secretId: '',
                            secretKey: '',
                            bucket: '',
                            region: 'ap-shanghai',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.tencent.path = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Custom Domain'))
            .setDesc(t('Custom domain for CDN (optional)'))
            .addText(text => text
                .setPlaceholder('https://cdn.example.com')
                .setValue(settings.providers.tencent?.customUrl || '')
                .onChange(async (value) => {
                    if (!settings.providers.tencent) {
                        settings.providers.tencent = {
                            secretId: '',
                            secretKey: '',
                            bucket: '',
                            region: 'ap-shanghai',
                            path: '',
                            customUrl: ''
                        };
                    }
                    settings.providers.tencent.customUrl = value;
                    await saveSettings();
                }));
    }

}
