import { PluginSettings } from '../types/settings';

export class EmbedRenderer {
    constructor(private settings: PluginSettings) {}

    render(type: string, url: string, name: string): string {
        switch (type) {
            case 'image':
                return `${this.settings.imgPreview ? '!' : ''}[](${url})\n`;
            case 'video':
                return `${this.settings.videoPreview ? `<video src="${url}" controls></video>` : `[${name}](${url})`}\n`;
            case 'audio':
                return `${this.settings.audioPreview ? `<audio src="${url}" controls></audio>` : `[${name}](${url})`}\n`;
            case 'doc':
                return this.settings.docsPreview
                    ? `<iframe frameborder="0" border="0" width="100%" height="800" src="${this.settings.docsPreview}${url}"></iframe>\n`
                    : `[${name}](${url})\n`;
            default:
                throw new Error('Unknown file type');
        }
    }

    updateSettings(settings: PluginSettings): void {
        this.settings = settings;
    }
}
