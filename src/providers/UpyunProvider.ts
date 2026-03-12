import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { UpyunSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Setting } from 'obsidian';
import { t } from '../i18n';
import { simulateProgress } from './shared/progress';
import { isImageFile } from './shared/image';
import {
    buildObjectKey,
    encodeObjectKeyForUrl,
    normalizeBaseUrl,
    normalizePath,
} from './shared/path';
import {
    createUpyunAuthorization,
    createUpyunContentMd5,
    isUpyunDirectory,
    parseUpyunListPage,
} from './shared/upyun';

export class UpyunProvider implements IOssProvider {
    name = 'upyun';
    private settings: UpyunSettings;

    constructor(settings: UpyunSettings) {
        this.settings = settings;
    }

    private getApiBaseUrl(): string {
        return `https://v0.api.upyun.com/${this.settings.bucket}`;
    }

    private getSignedUri(path: string): string {
        const normalized = normalizePath(path);
        return normalized
            ? `/${this.settings.bucket}/${encodeObjectKeyForUrl(normalized)}`
            : `/${this.settings.bucket}`;
    }

    private getRequestUrl(path: string): string {
        const normalized = normalizePath(path);
        return normalized
            ? `${this.getApiBaseUrl()}/${encodeObjectKeyForUrl(normalized)}`
            : this.getApiBaseUrl();
    }

    private getPublicBaseUrl(): string {
        if (this.settings.url) {
            return normalizeBaseUrl(this.settings.url);
        }
        return `https://${this.settings.bucket}.test.upcdn.net`;
    }

    private buildPublicUrl(key: string): string {
        return `${this.getPublicBaseUrl()}/${encodeObjectKeyForUrl(key)}${this.settings.suffix || ''}`;
    }

    private async listDirectory(
        directory: string,
        filterPrefix: string,
        visitedDirectories: Set<string>,
        seenPaths: Set<string>
    ): Promise<OssImage[]> {
        const directoryKey = normalizePath(directory);
        if (visitedDirectories.has(directoryKey)) {
            console.warn(`Upyun: skipping duplicate directory "${directoryKey || '/'}" during listing`);
            return [];
        }
        visitedDirectories.add(directoryKey);

        const images: OssImage[] = [];
        let iter = '';

        while (true) {
            const date = new Date().toUTCString();
            const signedUri = this.getSignedUri(directory);
            const authorization = createUpyunAuthorization(
                this.settings.operator,
                this.settings.password,
                'GET',
                signedUri,
                date
            );

            const response = await requestUrl({
                url: this.getRequestUrl(directory),
                method: 'GET',
                headers: {
                    'Authorization': authorization,
                    'Date': date,
                    'Accept': 'application/json',
                    'x-list-limit': '1000',
                    ...(iter ? { 'x-list-iter': iter } : {}),
                },
            });

            if (response.status !== 200) {
                throw new Error(`List failed with status: ${response.status}`);
            }

            const page = parseUpyunListPage(response.json, response.headers['x-list-iter']);
            for (const entry of page.entries) {
                const entryPath = directory ? `${directory}/${entry.name}` : entry.name;
                if (!entry.name) {
                    continue;
                }
                if (seenPaths.has(entryPath)) {
                    console.warn(`Upyun: skipping duplicate path "${entryPath}" during listing`);
                    continue;
                }
                if (isUpyunDirectory(entry.type)) {
                    seenPaths.add(entryPath);
                    images.push(
                        ...await this.listDirectory(entryPath, filterPrefix, visitedDirectories, seenPaths)
                    );
                    continue;
                }
                if (filterPrefix && !entryPath.startsWith(filterPrefix)) {
                    continue;
                }
                if (isImageFile(entryPath)) {
                    seenPaths.add(entryPath);
                    images.push({
                        key: entryPath,
                        url: this.buildPublicUrl(entryPath),
                        lastModified: entry.lastModified,
                        size: entry.size,
                    });
                }
            }

            if (!page.iter || page.iter === iter) {
                return images;
            }
            iter = page.iter;
        }
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.operator || !this.settings.password || !this.settings.bucket) {
            throw new Error(t('Please configure Upyun settings first'));
        }

        // Simulate progress since requestUrl doesn't support it
        simulateProgress(onProgress, file.size);

        const objectKey = buildObjectKey(this.settings.path, path);
        const arrayBuffer = await file.arrayBuffer();
        const contentMd5 = createUpyunContentMd5(arrayBuffer);
        const signedUri = this.getSignedUri(objectKey);

        // Generate authorization header
        const date = new Date().toUTCString();
        const authorization = createUpyunAuthorization(
            this.settings.operator,
            this.settings.password,
            'PUT',
            signedUri,
            date,
            contentMd5
        );

        const requestParams: RequestUrlParam = {
            url: this.getRequestUrl(objectKey),
            method: 'PUT',
            headers: {
                'Authorization': authorization,
                'Date': date,
                'Content-Type': file.type || 'application/octet-stream',
                'Content-MD5': contentMd5,
            },
            body: arrayBuffer,
        };

        try {
            const response = await requestUrl(requestParams);

            if (response.status >= 200 && response.status < 300) {
                return this.buildPublicUrl(objectKey);
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Upyun upload error:', error);
            throw new Error(`Upload failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // Upyun list API
        if (!this.settings.operator || !this.settings.password || !this.settings.bucket) {
            return [];
        }

        try {
            const normalizedPrefix = normalizePath(prefix);
            const rootDirectory = normalizedPrefix.includes('/')
                ? normalizedPrefix.split('/').slice(0, -1).join('/')
                : '';
            return await this.listDirectory(
                rootDirectory,
                normalizedPrefix,
                new Set<string>(),
                new Set<string>()
            );
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
            const signedUri = this.getSignedUri(key);
            const date = new Date().toUTCString();
            const authorization = createUpyunAuthorization(
                this.settings.operator,
                this.settings.password,
                'DELETE',
                signedUri,
                date
            );

            const response = await requestUrl({
                url: this.getRequestUrl(key),
                method: 'DELETE',
                headers: {
                    'Authorization': authorization,
                    'Date': date,
                },
            });

            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Delete failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to delete Upyun image:', error);
            throw new Error(`Delete failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
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
}
