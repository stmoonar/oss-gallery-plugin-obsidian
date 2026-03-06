import { IOssProvider, OssImage } from '../types/oss';
import { ImgurSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Notice, Setting } from 'obsidian';
import { t } from '../i18n';

export class ImgurProvider implements IOssProvider {
    name = 'imgur';
    private settings: ImgurSettings;

    constructor(settings: ImgurSettings) {
        this.settings = settings;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void
    ): Promise<string> {
        if (!this.settings.clientId) {
            throw new Error(t('Please configure Imgur settings first'));
        }

        // Simulate progress since requestUrl doesn't support it
        if (onProgress) {
            setTimeout(() => onProgress({ loaded: 0, total: file.size, percentage: 0 }), 0);
            setTimeout(() => onProgress({ loaded: file.size, total: file.size, percentage: 100 }), 100);
        }

        // Convert file to base64
        const base64 = await this.fileToBase64(file);

        const boundary = '----ObsidianFormBoundary' + Math.random().toString(36).substr(2, 16);
        const requestParams: RequestUrlParam = {
            url: this.settings.proxy || 'https://api.imgur.com/3/image',
            method: 'POST',
            headers: {
                'Authorization': `Client-ID ${this.settings.clientId}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: this.createFormData(base64, file.name, file.type, boundary)
        };

        try {
            const response = await requestUrl(requestParams);

            if (response.status === 200) {
                const data = response.json;
                if (data.success && data.data && data.data.link) {
                    return data.data.link;
                } else {
                    throw new Error(data.data.error || 'Upload failed');
                }
            } else {
                throw new Error(`Upload failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('Imgur upload error:', error);
            throw new Error(`Upload failed: ${error.message}`);
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

    private createFormData(base64: string, fileName: string, mimeType: string, boundary: string): ArrayBuffer {
        const encoder = new TextEncoder();

        const parts: Uint8Array[] = [];

        // Add image data
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="image"\r\n\r\n`));
        parts.push(encoder.encode(base64));
        parts.push(encoder.encode('\r\n'));

        // Add type
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="type"\r\n\r\n`));
        parts.push(encoder.encode('base64'));
        parts.push(encoder.encode('\r\n'));

        // Add name
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="name"\r\n\r\n`));
        parts.push(encoder.encode(fileName));
        parts.push(encoder.encode('\r\n'));

        parts.push(encoder.encode(`--${boundary}--\r\n`));

        // Combine all parts
        const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
        const bodyArrayBuffer = new ArrayBuffer(totalLength);
        const bodyView = new Uint8Array(bodyArrayBuffer);
        let offset = 0;
        for (const part of parts) {
            bodyView.set(part, offset);
            offset += part.length;
        }

        return bodyArrayBuffer;
    }

    getSettingsTab(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
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
        const noteDiv = containerEl.createDiv();
        noteDiv.innerHTML = `
            <p><strong>${t('Note')}:</strong></p>
            <ul>
                <li>${t('Imgur only supports image uploads')}</li>
                <li>${t('Image listing is not available')}</li>
                <li>${t('Image deletion requires OAuth authentication')}</li>
                <li>${t('In some regions, a proxy may be required to access Imgur API')}</li>
            </ul>
        `;
        noteDiv.style.marginTop = '20px';
        noteDiv.style.fontSize = '0.9em';
        noteDiv.style.color = 'var(--text-muted)';
    }
}