import { IOssProvider, OssImage } from '../types/oss';
import { UpyunSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Notice, Setting } from 'obsidian';
import { t } from '../i18n';
import { createHmac } from 'crypto';
import { createHash } from 'crypto';

export class UpyunProvider implements IOssProvider {
    name = 'upyun';
    private settings: UpyunSettings;

    constructor(settings: UpyunSettings) {
        this.settings = settings;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void
    ): Promise<string> {
        if (!this.settings.operator || !this.settings.password || !this.settings.bucket) {
            throw new Error(t('Please configure Upyun settings first'));
        }

        // Simulate progress since requestUrl doesn't support it
        if (onProgress) {
            setTimeout(() => onProgress({ loaded: 0, total: file.size, percentage: 0 }), 0);
            setTimeout(() => onProgress({ loaded: file.size, total: file.size, percentage: 100 }), 100);
        }

        // Normalize path prefix - remove leading and trailing slashes, then add one leading slash
        let normalizedPath = this.settings.path ? this.settings.path.trim() : '';
        normalizedPath = normalizedPath.replace(/^\/+/, '').replace(/\/+$/, '');

        // Build URI - always start with slash
        const uri = normalizedPath ? `/${normalizedPath}/${path}` : `/${path}`;

        // Generate authorization header
        const date = new Date().toUTCString();
        const passwordMd5 = createHash('md5').update(this.settings.password).digest('hex');
        const signStr = `PUT${uri}${date}`;
        const signature = createHmac('sha1', passwordMd5).update(signStr).digest('base64');
        const authorization = `UPYUN ${this.settings.operator}:${signature}`;

        const url = `https://v0.api.upyun.com/${this.settings.bucket}${uri}`;

        const requestParams: RequestUrlParam = {
            url: url,
            method: 'PUT',
            headers: {
                'Authorization': authorization,
                'Date': date,
                'Content-Type': file.type || 'application/octet-stream'
            },
            body: await file.arrayBuffer()
        };

        try {
            const response = await requestUrl(requestParams);

            if (response.status === 200) {
                const baseUrl = this.settings.url || `https://${this.settings.bucket}.test.upcdn.net`;
                const finalUrl = `${baseUrl}${uri}${this.settings.suffix || ''}`;
                return finalUrl;
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Upyun upload error:', error);
            throw new Error(`Upload failed: ${error.message}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // Upyun list API
        if (!this.settings.operator || !this.settings.password || !this.settings.bucket) {
            return [];
        }

        try {
            const uri = prefix ? `/?prefix=${encodeURIComponent(prefix)}` : '/';
            const date = new Date().toUTCString();
            const passwordMd5 = createHash('md5').update(this.settings.password).digest('hex');
            const signStr = `GET${uri}${date}`;
            const signature = createHmac('sha1', passwordMd5).update(signStr).digest('base64');
            const authorization = `UPYUN ${this.settings.operator}:${signature}`;

            const url = `https://v0.api.upyun.com/${this.settings.bucket}${uri}`;

            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'Authorization': authorization,
                    'Date': date
                }
            });

            if (response.status === 200) {
                const data = response.json;
                const images: OssImage[] = [];

                if (data.files) {
                    const baseUrl = this.settings.url || `https://${this.settings.bucket}.test.upcdn.net`;

                    for (const item of data.files) {
                        // Filter for image files and exclude directories
                        if (!item.type && this.isImageFile(item.name)) {
                            const filePath = prefix ? `${prefix}/${item.name}` : item.name;
                            images.push({
                                key: filePath,
                                url: `${baseUrl}/${filePath}${this.settings.suffix || ''}`,
                                lastModified: new Date(item.last_update * 1000), // Upyun uses timestamp
                                size: item.size
                            });
                        }
                    }
                }

                return images;
            }
        } catch (error) {
            console.error('Failed to list Upyun images:', error);
        }
        return [];
    }

    async deleteImage(key: string): Promise<void> {
        if (!this.settings.operator || !this.settings.password || !this.settings.bucket) {
            throw new Error(t('Please configure Upyun settings first'));
        }

        try {
            const uri = `/${key}`;
            const date = new Date().toUTCString();
            const passwordMd5 = createHash('md5').update(this.settings.password).digest('hex');
            const signStr = `DELETE${uri}${date}`;
            const signature = createHmac('sha1', passwordMd5).update(signStr).digest('base64');
            const authorization = `UPYUN ${this.settings.operator}:${signature}`;

            const url = `https://v0.api.upyun.com/${this.settings.bucket}${uri}`;

            const response = await requestUrl({
                url: url,
                method: 'DELETE',
                headers: {
                    'Authorization': authorization,
                    'Date': date
                }
            });

            if (response.status !== 200) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete Upyun image:', error);
            throw new Error(`Delete failed: ${error.message}`);
        }
    }

    getSettingsTab(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        new Setting(containerEl)
            .setName(t('Operator'))
            .setDesc(t('Upyun Operator name'))
            .addText(text => text
                .setPlaceholder('Enter your operator name')
                .setValue(settings.providers.upyun?.operator || '')
                .onChange(async (value) => {
                    if (!settings.providers.upyun) {
                        settings.providers.upyun = {
                            operator: '',
                            password: '',
                            bucket: '',
                            url: '',
                            path: '',
                            suffix: ''
                        };
                    }
                    settings.providers.upyun.operator = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Password'))
            .setDesc(t('Upyun Operator password'))
            .addText(text => text
                .setPlaceholder('Enter your password')
                .setValue(settings.providers.upyun?.password || '')
                .onChange(async (value) => {
                    if (!settings.providers.upyun) {
                        settings.providers.upyun = {
                            operator: '',
                            password: '',
                            bucket: '',
                            url: '',
                            path: '',
                            suffix: ''
                        };
                    }
                    settings.providers.upyun.password = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Bucket'))
            .setDesc(t('Upyun service name'))
            .addText(text => text
                .setPlaceholder('service-name')
                .setValue(settings.providers.upyun?.bucket || '')
                .onChange(async (value) => {
                    if (!settings.providers.upyun) {
                        settings.providers.upyun = {
                            operator: '',
                            password: '',
                            bucket: '',
                            url: '',
                            path: '',
                            suffix: ''
                        };
                    }
                    settings.providers.upyun.bucket = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('URL'))
            .setDesc(t('Upyun acceleration domain URL'))
            .addText(text => text
                .setPlaceholder('https://your-domain.upcdn.net')
                .setValue(settings.providers.upyun?.url || '')
                .onChange(async (value) => {
                    if (!settings.providers.upyun) {
                        settings.providers.upyun = {
                            operator: '',
                            password: '',
                            bucket: '',
                            url: '',
                            path: '',
                            suffix: ''
                        };
                    }
                    settings.providers.upyun.url = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Path'))
            .setDesc(t('Path prefix for uploaded files (optional)'))
            .addText(text => text
                .setPlaceholder('path/to/folder')
                .setValue(settings.providers.upyun?.path || '')
                .onChange(async (value) => {
                    if (!settings.providers.upyun) {
                        settings.providers.upyun = {
                            operator: '',
                            password: '',
                            bucket: '',
                            url: '',
                            path: '',
                            suffix: ''
                        };
                    }
                    settings.providers.upyun.path = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Suffix'))
            .setDesc(t('Image processing suffix (optional)'))
            .addText(text => text
                .setPlaceholder('!x200')
                .setValue(settings.providers.upyun?.suffix || '')
                .onChange(async (value) => {
                    if (!settings.providers.upyun) {
                        settings.providers.upyun = {
                            operator: '',
                            password: '',
                            bucket: '',
                            url: '',
                            path: '',
                            suffix: ''
                        };
                    }
                    settings.providers.upyun.suffix = value;
                    await saveSettings();
                }));
    }

    private isImageFile(key: string): boolean {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
        const ext = key.toLowerCase().substring(key.lastIndexOf('.'));
        return imageExtensions.includes(ext);
    }
}