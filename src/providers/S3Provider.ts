import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { S3Settings, PluginSettings } from '../types/settings';
import { requestUrl, Setting } from 'obsidian';
import { t } from '../i18n';
import { isImageFile } from './shared/image';
import { encodeObjectKeyForUrl, normalizeEndpointHost } from './shared/path';
import mime from 'mime';
import * as aws4 from 'aws4';

export class S3Provider implements IOssProvider {
    name = 's3';

    constructor(private settings: S3Settings) {}

    private getHost(): string {
        const clean = normalizeEndpointHost(this.settings.endpoint);
        return this.settings.forcePathStyle
            ? clean
            : `${this.settings.bucket.trim()}.${clean}`;
    }

    private getRequestPath(objectPath: string): string {
        return this.settings.forcePathStyle
            ? `/${this.settings.bucket.trim()}${objectPath}`
            : objectPath;
    }

    private getUrl(path: string): string {
        const protocol = this.settings.useSSL ? 'https' : 'http';
        const host = this.getHost();
        return `${protocol}://${host}${path}`;
    }

    private signRequest(opts: any) {
        aws4.sign(opts, {
            accessKeyId: this.settings.accessKeyId,
            secretAccessKey: this.settings.secretAccessKey,
        });
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
        const path = this.getRequestPath(`/${encodedKey}`);
        return this.getUrl(path);
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.endpoint || !this.settings.accessKeyId || !this.settings.secretAccessKey || !this.settings.bucket) {
            throw new Error(t('Please configure S3 settings first'));
        }

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = file.type || mime.getType(file.name) || 'application/octet-stream';

        const requestPath = this.getRequestPath(`/${encodeObjectKeyForUrl(path)}`);
        const opts = {
            host: this.getHost(),
            path: requestPath,
            service: 's3',
            region: this.settings.region || 'us-east-1',
            method: 'PUT',
            body: buffer,
            headers: {
                'Content-Type': contentType,
            },
        };

        this.signRequest(opts);

        const headers = { ...opts.headers } as any;
        delete headers['Host'];
        delete headers['host'];
        delete headers['Content-Length'];
        delete headers['content-length'];

        if (onProgress) onProgress({ loaded: 0, total: buffer.length, percentage: 0 });

        try {
            const response = await requestUrl({
                url: this.getUrl(requestPath),
                method: 'PUT',
                headers: headers as Record<string, string>,
                body: arrayBuffer,
            });

            if (response.status >= 200 && response.status < 300) {
                if (onProgress) onProgress({ loaded: buffer.length, total: buffer.length, percentage: 100 });
                return this.generateAccessUrl(path);
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('S3 upload error:', error);
            throw new Error(`Upload failed: ${error.message}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        if (!this.settings.endpoint || !this.settings.accessKeyId || !this.settings.secretAccessKey || !this.settings.bucket) {
            return [];
        }

        try {
            const queryParams = new URLSearchParams({ 'list-type': '2' });
            if (prefix) {
                queryParams.append('prefix', prefix);
            }
            const queryString = queryParams.toString();

            const basePath = this.settings.forcePathStyle
                ? `/${this.settings.bucket}`
                : '';
            const requestPath = `${basePath}/${queryString ? '?' + queryString : ''}`;

            const opts = {
                host: this.getHost(),
                path: requestPath,
                service: 's3',
                region: this.settings.region || 'us-east-1',
                method: 'GET',
                headers: { 'Accept': 'application/xml' },
            };

            this.signRequest(opts);

            const headers = { ...opts.headers } as any;
            delete headers['Host'];
            delete headers['host'];

            const response = await requestUrl({
                url: this.getUrl(requestPath),
                method: 'GET',
                headers: headers as Record<string, string>,
            });

            if (response.status === 200) {
                return this.parseListObjectsResponse(response.text);
            } else {
                throw new Error(`List objects failed with status ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to list S3 images:', error);
            throw error;
        }
    }

    async deleteImage(key: string): Promise<void> {
        if (!this.settings.endpoint || !this.settings.accessKeyId || !this.settings.secretAccessKey || !this.settings.bucket) {
            throw new Error(t('Please configure S3 settings first'));
        }

        try {
            const requestPath = this.getRequestPath(`/${encodeObjectKeyForUrl(key)}`);
            const opts = {
                host: this.getHost(),
                path: requestPath,
                service: 's3',
                region: this.settings.region || 'us-east-1',
                method: 'DELETE',
                headers: {},
            };

            this.signRequest(opts);

            const headers = { ...opts.headers } as any;
            delete headers['Host'];
            delete headers['host'];

            const response = await requestUrl({
                url: this.getUrl(requestPath),
                method: 'DELETE',
                headers: headers as Record<string, string>,
            });

            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete S3 image:', error);
            throw new Error(`Delete failed: ${error.message}`);
        }
    }

    private parseListObjectsResponse(xml: string): OssImage[] {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xml, 'text/xml');
        const contents = xmlDoc.getElementsByTagName('Contents');
        const images: OssImage[] = [];

        for (let i = 0; i < contents.length; i++) {
            const item = contents[i];
            const key = item.getElementsByTagName('Key')[0]?.textContent;
            const lastModified = item.getElementsByTagName('LastModified')[0]?.textContent;
            const size = item.getElementsByTagName('Size')[0]?.textContent;

            if (key && isImageFile(key)) {
                images.push({
                    key,
                    url: this.generateAccessUrl(key),
                    lastModified: lastModified ? new Date(lastModified) : new Date(),
                    size: size ? parseInt(size) : 0,
                });
            }
        }
        return images;
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        const s3 = settings.providers.s3;

        new Setting(containerEl)
            .setName(t('Endpoint'))
            .setDesc(t('S3-compatible endpoint (e.g. s3.amazonaws.com)'))
            .addText(text => text
                .setPlaceholder('s3.amazonaws.com')
                .setValue(s3?.endpoint || '')
                .onChange(async (value) => {
                    settings.providers.s3.endpoint = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Region'))
            .setDesc(t('S3 region'))
            .addText(text => text
                .setPlaceholder('us-east-1')
                .setValue(s3?.region || 'us-east-1')
                .onChange(async (value) => {
                    settings.providers.s3.region = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Access Key ID'))
            .setDesc(t('S3 Access Key ID'))
            .addText(text => text
                .setPlaceholder('Enter your Access Key ID')
                .setValue(s3?.accessKeyId || '')
                .onChange(async (value) => {
                    settings.providers.s3.accessKeyId = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Secret Access Key'))
            .setDesc(t('S3 Secret Access Key'))
            .addText(text => text
                .setPlaceholder('Enter your Secret Access Key')
                .setValue(s3?.secretAccessKey || '')
                .onChange(async (value) => {
                    settings.providers.s3.secretAccessKey = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Bucket'))
            .setDesc(t('S3 Bucket name'))
            .addText(text => text
                .setPlaceholder('my-bucket')
                .setValue(s3?.bucket || '')
                .onChange(async (value) => {
                    settings.providers.s3.bucket = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Use SSL'))
            .setDesc(t('Use HTTPS for S3 requests'))
            .addToggle(toggle => toggle
                .setValue(s3?.useSSL ?? true)
                .onChange(async (value) => {
                    settings.providers.s3.useSSL = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Force path style'))
            .setDesc(t('Use path-style URLs (endpoint/bucket/key) instead of virtual-hosted-style (bucket.endpoint/key)'))
            .addToggle(toggle => toggle
                .setValue(s3?.forcePathStyle ?? true)
                .onChange(async (value) => {
                    settings.providers.s3.forcePathStyle = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Public URL'))
            .setDesc(t('Custom public URL for accessing files (optional)'))
            .addText(text => text
                .setPlaceholder('https://cdn.example.com')
                .setValue(s3?.publicUrl || '')
                .onChange(async (value) => {
                    settings.providers.s3.publicUrl = value;
                    await saveSettings();
                }));
    }
}
