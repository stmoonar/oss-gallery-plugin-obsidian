import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { TencentSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Notice, Setting } from 'obsidian';
import { t } from '../i18n';
import { createHmac } from 'crypto';
import { createHash } from 'crypto';
import { simulateProgress } from './shared/progress';
import { isImageFile } from './shared/image';
import { buildObjectKey } from './shared/path';

export class TencentProvider implements IOssProvider {
    name = 'tencent';
    private settings: TencentSettings;

    constructor(settings: TencentSettings) {
        this.settings = settings;
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
        const host = `${this.settings.bucket}.cos.${this.settings.region}.myqcloud.com`;
        const url = `https://${host}/${objectKey}`;

        // Generate authorization header for Tencent COS
        const authorization = await this.generateAuthorization('PUT', `/${objectKey}`, file.type || 'application/octet-stream');

        const requestParams: RequestUrlParam = {
            url: url,
            method: 'PUT',
            headers: {
                'Authorization': authorization,
                'Content-Type': file.type || 'application/octet-stream'
            },
            body: await file.arrayBuffer()
        };

        try {
            const response = await requestUrl(requestParams);

            if (response.status === 200) {
                // Return custom URL if configured, otherwise use default endpoint
                if (this.settings.customUrl) {
                    return `${this.settings.customUrl}/${objectKey}`;
                }
                return url;
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Tencent COS upload error:', error);
            throw new Error(`Upload failed: ${error.message}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // Tencent COS ListObjects API
        if (!this.settings.secretId || !this.settings.secretKey || !this.settings.bucket) {
            return [];
        }

        try {
            const prefixParam = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
            const objectKey = `/${prefixParam}`;
            const authorization = await this.generateAuthorization('GET', objectKey);

            const host = `${this.settings.bucket}.cos.${this.settings.region}.myqcloud.com`;

            const response = await requestUrl({
                url: `https://${host}${prefixParam}`,
                method: 'GET',
                headers: {
                    'Authorization': authorization
                }
            });

            if (response.status === 200) {
                const data = response.json;
                const images: OssImage[] = [];

                if (data.ListBucketResult && data.ListBucketResult.Contents) {
                    for (const item of data.ListBucketResult.Contents) {
                        // Filter for image files
                        const key = item.Key;
                        if (isImageFile(key)) {
                            images.push({
                                key: key,
                                url: `https://${host}/${key}`,
                                lastModified: new Date(item.LastModified),
                                size: parseInt(item.Size)
                            });
                        }
                    }
                }

                return images;
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
            const objectKey = `/${key}`;
            const authorization = await this.generateAuthorization('DELETE', objectKey);

            const host = `${this.settings.bucket}.cos.${this.settings.region}.myqcloud.com`;

            const response = await requestUrl({
                url: `https://${host}/${key}`,
                method: 'DELETE',
                headers: {
                    'Authorization': authorization
                }
            });

            if (response.status !== 204) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete Tencent COS image:', error);
            throw new Error(`Delete failed: ${error.message}`);
        }
    }

    private async generateAuthorization(method: string, pathname: string, contentType?: string): Promise<string> {
        const now = new Date();
        const timestamp = Math.floor(now.getTime() / 1000);
        const date = now.toISOString().substr(0, 10);

        // Create key time
        const keyTime = `${timestamp};${timestamp + 3600}`;

        // Create sign key
        const signKey = createHmac('sha1', this.settings.secretKey)
            .update(keyTime)
            .digest('hex');

        // Create http string
        const httpString = [
            method,
            pathname,
            '',
            contentType || '',
            ''
        ].join('\n');

        // Create string to sign
        const httpStringSha256 = createHash('sha256').update(httpString).digest('hex');
        const stringToSign = [
            'sha256',
            keyTime,
            httpStringSha256,
            ''
        ].join('\n');

        // Create signature
        const signature = createHmac('sha1', signKey)
            .update(stringToSign)
            .digest('hex');

        // Create authorization header
        const authorization = [
            `q-sign-algorithm=sha1`,
            `q-ak=${this.settings.secretId}`,
            `q-sign-time=${keyTime}`,
            `q-key-time=${keyTime}`,
            `q-header-list=&q-url-param-list=&q-signature=${signature}`
        ].join('&');

        return `QCLOUD ${authorization}`;
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