import { S3Settings, PluginSettings } from '../types/settings';
import { Setting } from 'obsidian';
import { t } from '../i18n';
import { encodeObjectKeyForUrl, normalizeEndpointHost } from './shared/path';
import { S3CompatibleProvider } from './shared/S3CompatibleProvider';

export class S3Provider extends S3CompatibleProvider<S3Settings> {
    name = 's3';

    constructor(settings: S3Settings) {
        super(settings);
    }

    protected isConfigured(): boolean {
        return Boolean(
            this.settings.endpoint
            && this.settings.accessKeyId
            && this.settings.secretAccessKey
            && this.settings.bucket
        );
    }

    protected getConfigurationError(): Error {
        return new Error(t('Please configure S3 settings first'));
    }

    protected getCredentials() {
        return {
            accessKeyId: this.settings.accessKeyId,
            secretAccessKey: this.settings.secretAccessKey,
        };
    }

    protected getSignedHost(): string {
        const endpoint = normalizeEndpointHost(this.settings.endpoint);
        return this.settings.forcePathStyle
            ? endpoint
            : `${this.settings.bucket.trim()}.${endpoint}`;
    }

    protected getRegion(): string {
        return this.settings.region || 'us-east-1';
    }

    protected getRequestUrl(path: string): string {
        const protocol = this.settings.useSSL ? 'https' : 'http';
        return `${protocol}://${this.getSignedHost()}${path}`;
    }

    protected getObjectRequestPath(objectKey: string): string {
        const objectPath = `/${encodeObjectKeyForUrl(objectKey)}`;
        return this.settings.forcePathStyle
            ? `/${this.settings.bucket.trim()}${objectPath}`
            : objectPath;
    }

    protected getListRequestPath(query: string): string {
        const basePath = this.settings.forcePathStyle
            ? `/${this.settings.bucket}`
            : '';
        return `${basePath}/?${query}`;
    }

    protected generateAccessUrl(objectKey: string): string {
        const encodedKey = encodeObjectKeyForUrl(objectKey);
        if (this.settings.publicUrl) {
            let url = this.settings.publicUrl.replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(url)) {
                url = `https://${url}`;
            }
            return `${url}/${encodedKey}`;
        }
        return this.getRequestUrl(this.getObjectRequestPath(objectKey));
    }

    protected handleUploadError(error: unknown): never {
        console.error('S3 upload error:', error);
        throw new Error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    protected handleListError(error: unknown): never {
        console.error('Failed to list S3 images:', error);
        throw error;
    }

    protected handleDeleteError(error: unknown): never {
        console.error('Failed to delete S3 image:', error);
        throw new Error(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
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
            .addText(text => {
                text.inputEl.type = 'password';
                text.setPlaceholder('Enter your Secret Access Key')
                    .setValue(s3?.secretAccessKey || '')
                    .onChange(async (value) => {
                        settings.providers.s3.secretAccessKey = value;
                        await saveSettings();
                    });
            });

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
