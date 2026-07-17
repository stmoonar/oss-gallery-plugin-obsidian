import { MinioSettings, PluginSettings } from '../types/settings';
import { Setting } from 'obsidian';
import { t } from '../i18n';
import { handleUploadError } from '../utils/ErrorHandler';
import { encodeObjectKeyForUrl, normalizeEndpointHost } from './shared/path';
import { S3CompatibleProvider } from './shared/S3CompatibleProvider';

export class MinioProvider extends S3CompatibleProvider<MinioSettings> {
    name = 'minio';

    constructor(settings: MinioSettings) {
        super(settings);
    }

    private getEndpointUrl(): URL {
        const protocol = this.settings.useSSL ? 'https' : 'http';
        const host = normalizeEndpointHost(this.settings.endpoint, protocol);
        const url = new URL(`${protocol}://${host}`);
        if (!url.port) {
            url.port = String(this.settings.port);
        }
        return url;
    }

    updateSettings(settings: MinioSettings): void {
        this.settings = settings;
    }

    protected isConfigured(): boolean {
        return Boolean(
            this.settings.endpoint
            && this.settings.accessKey
            && this.settings.secretKey
            && this.settings.bucket
        );
    }

    protected getConfigurationError(): Error {
        return new Error(t('Please configure OSS settings first'));
    }

    protected getCredentials() {
        return {
            accessKeyId: this.settings.accessKey,
            secretAccessKey: this.settings.secretKey,
        };
    }

    protected getSignedHost(): string {
        return this.getEndpointUrl().host;
    }

    protected getRegion(): string {
        return this.settings.region || 'us-east-1';
    }

    protected getRequestUrl(path: string): string {
        return `${this.getEndpointUrl().origin}${path}`;
    }

    protected getObjectRequestPath(objectKey: string): string {
        return `/${this.settings.bucket.trim()}/${encodeObjectKeyForUrl(objectKey)}`;
    }

    protected getListRequestPath(query: string): string {
        return `/${this.settings.bucket.trim()}?${query}`;
    }

    protected generateAccessUrl(objectName: string): string {
        const { customDomain } = this.settings;
        const bucket = this.settings.bucket.trim();
        const encodedObjectName = encodeObjectKeyForUrl(objectName);

        if (customDomain) {
            let url = customDomain.replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(url)) {
                url = `https://${url}`;
            }
            return `${url}/${bucket}/${encodedObjectName}`;
        }

        return `${this.getEndpointUrl().origin}/${bucket}/${encodedObjectName}`;
    }

    protected catchUploadPreparationErrors(): boolean {
        return true;
    }

    protected canListImages(): boolean {
        return true;
    }

    protected canDeleteImage(): boolean {
        return true;
    }

    protected uploadStatusError(status: number): Error {
        return new Error(`Upload failed with status ${status}`);
    }

    protected deleteStatusError(status: number): Error {
        return new Error(`Delete failed with status ${status}`);
    }

    protected handleUploadError(error: unknown, fileName: string): never {
        handleUploadError(error, fileName);
        throw error;
    }

    protected logListResponseFailure(status: number, responseText: string): void {
        console.error('List objects failed with status:', status, responseText);
    }

    protected handleListError(error: unknown): never {
        console.error('List images failed:', error);
        throw error;
    }

    protected handleDeleteError(error: unknown): never {
        console.error('Delete image failed:', error);
        throw error;
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        const minioSettings = settings.providers.minio;

        new Setting(containerEl)
            .setName(t('Endpoint'))
            .setDesc(t('Minio endpoint (e.g. play.min.io)'))
            .addText(text => text
                .setValue(minioSettings.endpoint)
                .onChange(async (value) => {
                    minioSettings.endpoint = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Port'))
            .setDesc(t('Minio port'))
            .addText(text => text
                .setValue(String(minioSettings.port))
                .onChange(async (value) => {
                    const port = Number(value);
                    if (!Number.isInteger(port) || port < 1 || port > 65535) {
                        return;
                    }
                    minioSettings.port = port;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Use SSL'))
            .addToggle(toggle => toggle
                .setValue(minioSettings.useSSL)
                .onChange(async (value) => {
                    minioSettings.useSSL = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Access Key'))
            .addText(text => text
                .setValue(minioSettings.accessKey)
                .onChange(async (value) => {
                    minioSettings.accessKey = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Secret Key'))
            .addText(text => {
                text.inputEl.type = 'password';
                text.setPlaceholder('Secret Key')
                    .setValue(minioSettings.secretKey)
                    .onChange(async (value) => {
                        minioSettings.secretKey = value;
                        this.updateSettings(minioSettings);
                        await saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName(t('Bucket'))
            .addText(text => text
                .setValue(minioSettings.bucket)
                .onChange(async (value) => {
                    minioSettings.bucket = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Region'))
            .addText(text => text
                .setValue(minioSettings.region)
                .onChange(async (value) => {
                    minioSettings.region = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Custom Domain'))
            .setDesc(t('Optional custom domain for public access'))
            .addText(text => text
                .setValue(minioSettings.customDomain)
                .onChange(async (value) => {
                    minioSettings.customDomain = value;
                    this.updateSettings(minioSettings);
                    await saveSettings();
                }));
    }
}
