import { PluginSettings } from '../types/settings';

export class EmbedRenderer {
    constructor(private settings: PluginSettings) {}

    render(type: string, url: string, name: string): string {
        switch (type) {
            case 'image':
                return this.renderImage(url, name);
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

    private renderImage(url: string, name: string): string {
        if (!this.settings.imgPreview) {
            return `[${name}](${url})\n`;
        }

        const format = this.settings.embedFormat || '![]($URL)';
        return format.replace(/\$URL/g, url).replace(/\$NAME/g, name) + '\n';
    }

    updateSettings(settings: PluginSettings): void {
        this.settings = settings;
    }
}
