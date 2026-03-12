import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { R2Settings, PluginSettings } from '../types/settings';
import { requestUrl, Setting } from 'obsidian';
import { t } from '../i18n';
import { encodeObjectKeyForUrl, normalizeEndpointHost } from './shared/path';
import { parseS3ListObjectsXml } from './shared/s3xml';
import { extractSignedHeaders } from './shared/aws4helpers';
import mime from 'mime';
import * as aws4 from 'aws4';

export class R2Provider implements IOssProvider {
    name = 'r2';
    private settings: R2Settings;

    constructor(settings: R2Settings) {
        this.settings = settings;
    }

    private getAccountId(): string {
        return normalizeEndpointHost(this.settings.accountId)
            .replace(/\.r2\.cloudflarestorage\.com$/i, '')
            .split(':')[0];
    }

    private getBucketName(): string {
        return this.settings.bucket.trim();
    }

    private getApiHost(): string {
        return `${this.getAccountId()}.r2.cloudflarestorage.com`;
    }

    private getObjectPath(objectKey: string): string {
        return `/${this.getBucketName()}/${encodeObjectKeyForUrl(objectKey)}`;
    }

    private signRequest(opts: any) {
        aws4.sign(opts, {
            accessKeyId: this.settings.accessKeyId,
            secretAccessKey: this.settings.secretAccessKey,
        });
    }

    private getApiUrl(path: string): string {
        return `https://${this.getApiHost()}${path}`;
    }

    private generateAccessUrl(objectKey: string): string {
        const encodedKey = encodeObjectKeyForUrl(objectKey);
        if (this.settings.publicUrl) {
            let url = this.settings.publicUrl.replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(url)) {
                url = `https://${url}`;
            }
            return `${url}/${encodedKey}`;
        }
        // Fallback to S3 API URL (won't work for public access without configured public URL)
        return `https://${this.getApiHost()}/${this.getBucketName()}/${encodedKey}`;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.accountId || !this.settings.accessKeyId || !this.settings.secretAccessKey || !this.settings.bucket) {
            throw new Error(t('Please configure Cloudflare R2 settings first'));
        }

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = file.type || mime.getType(file.name) || 'application/octet-stream';

        const requestPath = this.getObjectPath(path);
        const opts = {
            host: this.getApiHost(),
            path: requestPath,
            service: 's3',
            region: 'auto',
            method: 'PUT',
            body: buffer,
            headers: {
                'Content-Type': contentType,
            },
        };

        this.signRequest(opts);

        if (onProgress) onProgress({ loaded: 0, total: buffer.length, percentage: 0 });

        try {
            const response = await requestUrl({
                url: this.getApiUrl(requestPath),
                method: 'PUT',
                headers: extractSignedHeaders(opts.headers as Record<string, string>),
                body: arrayBuffer,
            });

            if (response.status >= 200 && response.status < 300) {
                if (onProgress) onProgress({ loaded: buffer.length, total: buffer.length, percentage: 100 });
                return this.generateAccessUrl(path);
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Cloudflare R2 upload error:', error);
            if (error instanceof Error && error.message.includes('ERR_INVALID_ARGUMENT')) {
                throw new Error('Upload failed: invalid R2 request. Check Account ID, bucket name, and file path/name for unsupported characters.');
            }
            throw new Error(`Upload failed: ${error.message}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        if (!this.settings.accountId || !this.settings.accessKeyId || !this.settings.secretAccessKey || !this.settings.bucket) {
            return [];
        }

        try {
            const queryParams = new URLSearchParams({ 'list-type': '2' });
            if (prefix) {
                queryParams.append('prefix', prefix);
            }

            const queryString = queryParams.toString();
            const path = `/${this.getBucketName()}${queryString ? '?' + queryString : ''}`;

            const opts = {
                host: this.getApiHost(),
                path: path,
                service: 's3',
                region: 'auto',
                method: 'GET',
                headers: {
                    'Accept': 'application/xml',
                },
            };

            this.signRequest(opts);

            const response = await requestUrl({
                url: this.getApiUrl(path),
                method: 'GET',
                headers: extractSignedHeaders(opts.headers as Record<string, string>),
            });

            if (response.status === 200) {
                return this.parseListObjectsResponse(response.text);
            } else {
                console.error('R2 list objects failed:', response.status, response.text);
                throw new Error(`List objects failed with status ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to list R2 images:', error);
            throw error;
        }
    }

    async deleteImage(key: string): Promise<void> {
        if (!this.settings.accountId || !this.settings.accessKeyId || !this.settings.secretAccessKey || !this.settings.bucket) {
            throw new Error(t('Please configure Cloudflare R2 settings first'));
        }

        try {
            const path = this.getObjectPath(key);

            const opts = {
                host: this.getApiHost(),
                path: path,
                service: 's3',
                region: 'auto',
                method: 'DELETE',
                headers: {},
            };

            this.signRequest(opts);

            const response = await requestUrl({
                url: this.getApiUrl(path),
                method: 'DELETE',
                headers: extractSignedHeaders(opts.headers as Record<string, string>),
            });

            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete R2 image:', error);
            if (error instanceof Error && error.message.includes('ERR_INVALID_ARGUMENT')) {
                throw new Error('Delete failed: invalid R2 request. Check Account ID, bucket name, and object key.');
            }
            throw new Error(`Delete failed: ${error.message}`);
        }
    }

    private parseListObjectsResponse(xml: string): OssImage[] {
        return parseS3ListObjectsXml(xml, (key) => this.generateAccessUrl(key));
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        const r2 = settings.providers.r2;

        new Setting(containerEl)
            .setName(t('Account ID'))
            .setDesc(t('Cloudflare Account ID'))
            .addText(text => text
                .setPlaceholder('Enter your Cloudflare Account ID')
                .setValue(r2?.accountId || '')
                .onChange(async (value) => {
                    settings.providers.r2.accountId = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Access Key ID'))
            .setDesc(t('R2 API Token Access Key ID'))
            .addText(text => text
                .setPlaceholder('Enter your Access Key ID')
                .setValue(r2?.accessKeyId || '')
                .onChange(async (value) => {
                    settings.providers.r2.accessKeyId = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Secret Access Key'))
            .setDesc(t('R2 API Token Secret Access Key'))
            .addText(text => text
                .setPlaceholder('Enter your Secret Access Key')
                .setValue(r2?.secretAccessKey || '')
                .onChange(async (value) => {
                    settings.providers.r2.secretAccessKey = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Bucket'))
            .setDesc(t('R2 Bucket name'))
            .addText(text => text
                .setPlaceholder('my-bucket')
                .setValue(r2?.bucket || '')
                .onChange(async (value) => {
                    settings.providers.r2.bucket = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Public URL'))
            .setDesc(t('R2 public access URL (custom domain or r2.dev URL)'))
            .addText(text => text
                .setPlaceholder('https://pub-xxx.r2.dev')
                .setValue(r2?.publicUrl || '')
                .onChange(async (value) => {
                    settings.providers.r2.publicUrl = value;
                    await saveSettings();
                }));
    }
}
