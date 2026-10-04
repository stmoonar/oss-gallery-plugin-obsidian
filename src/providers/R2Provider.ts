import { R2Settings, PluginSettings } from '../types/settings';
import { Setting } from 'obsidian';
import { t } from '../i18n';
import { encodeObjectKeyForUrl, normalizeEndpointHost } from './shared/path';
import { S3CompatibleProvider } from './shared/S3CompatibleProvider';

export class R2Provider extends S3CompatibleProvider<R2Settings> {
    name = 'r2';

    constructor(settings: R2Settings) {
        super(settings);
    }

    private getAccountId(): string {
        return normalizeEndpointHost(this.settings.accountId)
            .replace(/\.r2\.cloudflarestorage\.com$/i, '')
            .split(':')[0];
    }

    private getBucketName(): string {
        return this.settings.bucket.trim();
    }

    protected isConfigured(): boolean {
        return Boolean(
            this.settings.accountId
            && this.settings.accessKeyId
            && this.settings.secretAccessKey
            && this.settings.bucket
        );
    }

    protected getConfigurationError(): Error {
        return new Error(t('Please configure Cloudflare R2 settings first'));
    }

    protected getCredentials() {
        return {
            accessKeyId: this.settings.accessKeyId,
            secretAccessKey: this.settings.secretAccessKey,
        };
    }

    protected getSignedHost(): string {
        return `${this.getAccountId()}.r2.cloudflarestorage.com`;
    }

    protected getRegion(): string {
        return 'auto';
    }

    protected getRequestUrl(path: string): string {
        return `https://${this.getSignedHost()}${path}`;
    }

    protected getObjectRequestPath(objectKey: string): string {
        return `/${this.getBucketName()}/${encodeObjectKeyForUrl(objectKey)}`;
    }

    protected getListRequestPath(query: string): string {
        return `/${this.getBucketName()}?${query}`;
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
        // Fallback to S3 API URL (won't work for public access without configured public URL)
        return `https://${this.getSignedHost()}/${this.getBucketName()}/${encodedKey}`;
    }

    protected handleUploadError(error: unknown): never {
        console.error('Cloudflare R2 upload error:', error);
        if (error instanceof Error && error.message.includes('ERR_INVALID_ARGUMENT')) {
            throw new Error('Upload failed: invalid R2 request. Check Account ID, bucket name, and file path/name for unsupported characters.');
        }
        throw new Error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    protected logListResponseFailure(status: number, responseText: string): void {
        console.error('R2 list objects failed:', status, responseText);
    }

    protected handleListError(error: unknown): never {
        console.error('Failed to list R2 images:', error);
        throw error;
    }

    protected handleDeleteError(error: unknown): never {
        console.error('Failed to delete R2 image:', error);
        if (error instanceof Error && error.message.includes('ERR_INVALID_ARGUMENT')) {
            throw new Error('Delete failed: invalid R2 request. Check Account ID, bucket name, and object key.');
        }
        throw new Error(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        const r2 = settings.providers.r2;

        new Setting(containerEl)
            .setName(t('Account ID'))
            .setDesc(t('Cloudflare Account ID'))
            .addText(text => text
                .setPlaceholder(t('Enter your Cloudflare account ID'))
                .setValue(r2?.accountId || '')
                .onChange(async (value) => {
                    settings.providers.r2.accountId = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Access Key ID'))
            .setDesc(t('R2 API Token Access Key ID'))
            .addText(text => text
                .setPlaceholder(t('Enter your access key ID'))
                .setValue(r2?.accessKeyId || '')
                .onChange(async (value) => {
                    settings.providers.r2.accessKeyId = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Secret Access Key'))
            .setDesc(t('R2 API Token Secret Access Key'))
            .addText(text => {
                text.inputEl.type = 'password';
                text.setPlaceholder(t('Enter your secret access key'))
                    .setValue(r2?.secretAccessKey || '')
                    .onChange(async (value) => {
                        settings.providers.r2.secretAccessKey = value;
                        await saveSettings();
                    });
            });

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
