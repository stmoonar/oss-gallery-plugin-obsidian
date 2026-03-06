import { IOssProvider, OssImage } from '../types/oss';
import { AliyunSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Notice, Setting } from 'obsidian';
import { t } from '../i18n';
import { createHmac } from 'crypto';

export class AliyunProvider implements IOssProvider {
    name = 'aliyun';
    private settings: AliyunSettings;

    constructor(settings: AliyunSettings) {
        this.settings = settings;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void
    ): Promise<string> {
        if (!this.settings.accessKeyId || !this.settings.accessKeySecret || !this.settings.bucket) {
            throw new Error(t('Please configure Aliyun OSS settings first'));
        }

        // Simulate progress since requestUrl doesn't support it
        if (onProgress) {
            setTimeout(() => onProgress({ loaded: 0, total: file.size, percentage: 0 }), 0);
            setTimeout(() => onProgress({ loaded: file.size, total: file.size, percentage: 100 }), 100);
        }

        // Normalize path prefix - remove leading slash, trim trailing slash
        let normalizedPath = this.settings.path ? this.settings.path.trim() : '';
        normalizedPath = normalizedPath.replace(/^\/+/, '').replace(/\/+$/, '');

        // Build object key
        const objectKey = normalizedPath ? `${normalizedPath}/${path}` : path;
        // Always use the OSS API endpoint for upload requests
        const apiEndpoint = `${this.settings.bucket}.${this.settings.area}.aliyuncs.com`;
        const url = `https://${apiEndpoint}/${objectKey}`;

        // Generate authorization header
        const date = new Date().toUTCString();
        const contentType = file.type || 'application/octet-stream';

        // Build canonical string for OSS signature
        const canonicalString = [
            'PUT',
            '', // Content-MD5 (empty)
            contentType,
            date,
            `/${this.settings.bucket}/${objectKey}`
        ].join('\n');

        // Generate signature
        const signature = createHmac('sha1', this.settings.accessKeySecret)
            .update(canonicalString, 'utf8')
            .digest('base64');

        const authorization = `OSS ${this.settings.accessKeyId}:${signature}`;

        const requestParams: RequestUrlParam = {
            url: url,
            method: 'PUT',
            headers: {
                'Authorization': authorization,
                'Date': date,
                'Content-Type': contentType
            },
            body: await file.arrayBuffer()
        };

        try {
            const response = await requestUrl(requestParams);

            if (response.status === 200) {
                // Return custom URL if configured, otherwise use default API endpoint URL
                if (this.settings.customUrl) {
                    const customBase = this.settings.customUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
                    return `https://${customBase}/${objectKey}`;
                } else {
                    return url;
                }
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Aliyun OSS upload error:', error);
            throw new Error(`Upload failed: ${error.message}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // Aliyun OSS ListObjects API
        if (!this.settings.accessKeyId || !this.settings.accessKeySecret || !this.settings.bucket) {
            return [];
        }

        try {
            const date = new Date().toUTCString();
            const prefixQuery = prefix ? `?prefix=${prefix}` : '';
            const canonicalString = [
                'GET',
                '', // Content-MD5
                '', // Content-Type
                date,
                `/${this.settings.bucket}/`
            ].join('\n');

            const signature = createHmac('sha1', this.settings.accessKeySecret)
                .update(canonicalString, 'utf8')
                .digest('base64');

            const authorization = `OSS ${this.settings.accessKeyId}:${signature}`;
            // Always use OSS API endpoint for API requests
            const apiEndpoint = `${this.settings.bucket}.${this.settings.area}.aliyuncs.com`;
            // Use custom URL for public access URLs if configured
            const publicEndpoint = this.settings.customUrl
                ? this.settings.customUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
                : apiEndpoint;

            const response = await requestUrl({
                url: `https://${apiEndpoint}/${prefixQuery}`,
                method: 'GET',
                headers: {
                    'Authorization': authorization,
                    'Date': date
                }
            });

            if (response.status === 200) {
                // Parse XML response from Aliyun OSS
                const xmlText = response.text;
                let xmlDoc: Document;

                try {
                    const parser = new DOMParser();
                    xmlDoc = parser.parseFromString(xmlText, 'text/xml');
                } catch (parseError) {
                    console.error('Failed to parse XML:', parseError);
                    return [];
                }

                const images: OssImage[] = [];

                // Get all Contents elements from the XML
                const contents = xmlDoc.getElementsByTagName('Contents');

                for (let i = 0; i < contents.length; i++) {
                    const content = contents[i];
                    const keyElement = content.getElementsByTagName('Key')[0];
                    const lastModifiedElement = content.getElementsByTagName('LastModified')[0];
                    const sizeElement = content.getElementsByTagName('Size')[0];

                    if (keyElement && keyElement.textContent) {
                        const key = keyElement.textContent;

                        // Filter for image files
                        if (this.isImageFile(key)) {
                            images.push({
                                key: key,
                                url: `https://${publicEndpoint}/${key}`,
                                lastModified: lastModifiedElement ? new Date(lastModifiedElement.textContent || '') : new Date(),
                                size: sizeElement ? parseInt(sizeElement.textContent || '0') : 0
                            });
                        }
                    }
                }

                return images;
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
            const canonicalString = [
                'DELETE',
                '', // Content-MD5
                '', // Content-Type
                date,
                `/${this.settings.bucket}/${key}`
            ].join('\n');

            const signature = createHmac('sha1', this.settings.accessKeySecret)
                .update(canonicalString, 'utf8')
                .digest('base64');

            const authorization = `OSS ${this.settings.accessKeyId}:${signature}`;
            // Always use OSS API endpoint for delete requests
            const apiEndpoint = `${this.settings.bucket}.${this.settings.area}.aliyuncs.com`;

            const response = await requestUrl({
                url: `https://${apiEndpoint}/${key}`,
                method: 'DELETE',
                headers: {
                    'Authorization': authorization,
                    'Date': date
                }
            });

            if (response.status !== 204) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete Aliyun OSS image:', error);
            throw new Error(`Delete failed: ${error.message}`);
        }
    }

    getSettingsTab(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
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

    private isImageFile(key: string): boolean {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
        const ext = key.toLowerCase().substring(key.lastIndexOf('.'));
        return imageExtensions.includes(ext);
    }
}