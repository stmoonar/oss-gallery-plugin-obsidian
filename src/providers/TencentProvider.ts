import { IOssProvider, ListResult, UploadProgressInfo } from '../types/oss';
import { TencentSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Setting } from 'obsidian';
import { t } from '../i18n';
import { reportUploadBounds } from './shared/progress';
import { buildListPrefix, buildObjectKey, encodeObjectKeyForUrl, normalizeBaseUrl } from './shared/path';
import { collectPages, ListingCollector, MAX_LIST_PAGES } from './shared/listing';
import { parseS3ListObjectsPage, s3EntriesToImages } from './shared/s3xml';
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

    // COS signs the raw (unencoded) UriPathname; percent-encoding is only for the request URL.
    private getSignPath(objectKey: string): string {
        return `/${objectKey}`;
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

        const progress = reportUploadBounds(onProgress, file.size);

        const objectKey = buildObjectKey(this.settings.path, path);
        const host = this.getHost();
        const objectPath = this.getObjectPath(objectKey);
        const url = `https://${host}${objectPath}`;
        const contentType = file.type || 'application/octet-stream';

        const authorization = this.generateAuthorization('PUT', this.getSignPath(objectKey), undefined, {
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
                progress.finish();
                return this.buildPublicUrl(objectKey);
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            progress.fail();
            console.error('Tencent COS upload error:', error);
            throw new Error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async listImages(prefix?: string): Promise<ListResult> {
        // Tencent COS ListObjects API
        const listPrefix = buildListPrefix(this.settings.path, prefix);
        if (!this.settings.secretId || !this.settings.secretKey || !this.settings.bucket) {
            return { items: [], complete: false, prefix: listPrefix };
        }

        try {
            const collector = new ListingCollector(this.name, listPrefix);

            return await collectPages(collector, MAX_LIST_PAGES, async (marker = '') => {
                const page = await this.fetchListPage(listPrefix, marker, 1000);
                // V1 ListObjects: NextMarker is only sent with a delimiter;
                // otherwise continue after the last key of the page.
                const nextMarker = page.nextMarker || page.objects[page.objects.length - 1]?.key;
                return {
                    items: s3EntriesToImages(page.objects, (key) => this.buildPublicUrl(key)),
                    more: page.isTruncated,
                    next: nextMarker,
                };
            });
        } catch (error) {
            console.error('Failed to list Tencent COS images:', error);
            throw new Error(`List failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** One signed ListObjects request with at most one key (settings check). */
    async testConnection(): Promise<void> {
        if (!this.settings.secretId || !this.settings.secretKey || !this.settings.bucket) {
            throw new Error(t('Please configure Tencent COS settings first'));
        }
        try {
            await this.fetchListPage(buildListPrefix(this.settings.path, undefined), '', 1);
        } catch (error) {
            throw new Error(`List failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async fetchListPage(listPrefix: string, marker: string, maxKeys: number) {
        const host = this.getHost();
        const query: Record<string, string> = { 'max-keys': String(maxKeys) };
        if (listPrefix) {
            query.prefix = listPrefix;
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

        return parseS3ListObjectsPage(response.text);
    }

    listingKeyForUpload(path: string): string {
        return buildObjectKey(this.settings.path, path);
    }

    async deleteImage(key: string): Promise<void> {
        if (!this.settings.secretId || !this.settings.secretKey || !this.settings.bucket) {
            throw new Error(t('Please configure Tencent COS settings first'));
        }

        try {
            const host = this.getHost();
            const objectPath = this.getObjectPath(key);
            const authorization = this.generateAuthorization('DELETE', this.getSignPath(key), undefined, { host });

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
            throw new Error(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        new Setting(containerEl)
            .setName(t('Secret ID'))
            .setDesc(t('Tencent COS Secret ID'))
            .addText(text => text
                .setPlaceholder(t('Enter your secret ID'))
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
            .addText(text => {
                text.inputEl.type = 'password';
                return text
                .setPlaceholder(t('Enter your secret key'))
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
                });
            });

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
