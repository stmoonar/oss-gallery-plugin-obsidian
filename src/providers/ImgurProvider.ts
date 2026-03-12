import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { ImgurSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Setting } from 'obsidian';
import { t } from '../i18n';
import { buildMultipartBody, generateBoundary } from './shared/multipart';
import { simulateProgress } from './shared/progress';
import { getBoolean, getRecord, getString } from '../utils/typeGuards';

export class ImgurProvider implements IOssProvider {
    name = 'imgur';
    private settings: ImgurSettings;

    constructor(settings: ImgurSettings) {
        this.settings = settings;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.clientId) {
            throw new Error(t('Please configure Imgur settings first'));
        }

        // Simulate progress since requestUrl doesn't support it
        simulateProgress(onProgress, file.size);

        // Convert file to base64
        const base64 = await this.fileToBase64(file);

        const boundary = generateBoundary();
        const requestParams: RequestUrlParam = {
            url: this.settings.proxy || 'https://api.imgur.com/3/image',
            method: 'POST',
            headers: {
                'Authorization': `Client-ID ${this.settings.clientId}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: buildMultipartBody([
                { name: 'image', value: base64 },
                { name: 'type', value: 'base64' },
                { name: 'name', value: file.name }
            ], boundary)
        };

        try {
            const response = await requestUrl(requestParams);

            if (response.status === 200) {
                const data = getRecord(response.json as unknown);
                const image = getRecord(data?.data);
                const link = getString(image?.link);
                if (getBoolean(data?.success) && link) {
                    return link;
                } else {
                    throw new Error(getString(image?.error) || 'Upload failed');
                }
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Imgur upload error:', error);
            throw new Error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        // Imgur doesn't provide a public API for listing all user images without authentication
        // We can implement account images listing if needed, but it would require OAuth
        // For now, return empty array
        console.warn('Imgur image listing is not supported');
        return [];
    }

    async deleteImage(key: string): Promise<void> {
        // Imgur deletion requires the image hash or delete hash
        // Without proper authentication, we cannot delete images
        // This would require OAuth2 implementation
        throw new Error(t('Imgur image deletion is not supported in this version'));
    }

    private async fileToBase64(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result as string;
                // Remove data URL prefix (e.g., "data:image/png;base64,")
                const base64 = result.substring(result.indexOf(',') + 1);
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        new Setting(containerEl)
            .setName(t('Client ID'))
            .setDesc(t('Imgur OAuth Client ID'))
            .addText(text => text
                .setPlaceholder('Enter your Client ID')
                .setValue(settings.providers.imgur?.clientId || '')
                .onChange(async (value) => {
                    if (!settings.providers.imgur) {
                        settings.providers.imgur = {
                            clientId: '',
                            proxy: ''
                        };
                    }
                    settings.providers.imgur.clientId = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Proxy'))
            .setDesc(t('HTTP proxy URL (optional, required in some regions)'))
            .addText(text => text
                .setPlaceholder('https://proxy.example.com')
                .setValue(settings.providers.imgur?.proxy || '')
                .onChange(async (value) => {
                    if (!settings.providers.imgur) {
                        settings.providers.imgur = {
                            clientId: '',
                            proxy: ''
                        };
                    }
                    settings.providers.imgur.proxy = value;
                    await saveSettings();
                }));

        // Add note about Imgur limitations
        const noteDiv = containerEl.createDiv({ cls: 'imgur-settings-note' });
        const noteTitle = noteDiv.createEl('p', { cls: 'imgur-settings-note-title' });
        noteTitle.createEl('strong', { text: `${t('Note')}:` });

        const noteList = noteDiv.createEl('ul');
        [
            t('Imgur only supports image uploads'),
            t('Image listing is not available'),
            t('Image deletion requires OAuth authentication'),
            t('In some regions, a proxy may be required to access Imgur API'),
        ].forEach((message) => {
            noteList.createEl('li', { text: message });
        });
    }
}
