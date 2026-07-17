import { PluginSettings } from '../types/settings';

export class EmbedRenderer {
    constructor(private settings: PluginSettings) {}

    render(type: string, url: string, name: string): string {
        const safeUrl = escapeHtmlAttr(url);
        const mdLink = `[${escapeMarkdownLinkText(name)}](${encodeMarkdownLinkUrl(url)})`;

        switch (type) {
            case 'image':
                return this.renderImage(url, name, mdLink);
            case 'video':
                return `${this.settings.videoPreview ? `<video src="${safeUrl}" controls></video>` : mdLink}\n`;
            case 'audio':
                return `${this.settings.audioPreview ? `<audio src="${safeUrl}" controls></audio>` : mdLink}\n`;
            case 'doc':
                return this.settings.docsPreview
                    ? `<iframe frameborder="0" border="0" width="100%" height="800" src="${escapeHtmlAttr(this.settings.docsPreview + encodeURIComponent(url))}"></iframe>\n`
                    : `${mdLink}\n`;
            default:
                throw new Error('Unknown file type');
        }
    }

    private renderImage(url: string, name: string, mdLink: string): string {
        if (!this.settings.imgPreview) {
            return `${mdLink}\n`;
        }

        const format = this.settings.embedFormat || '![]($URL)';
        // Replacement callbacks keep "$&"-style patterns in the values literal.
        return format.replace(/\$URL/g, () => url).replace(/\$NAME/g, () => name) + '\n';
    }

    updateSettings(settings: PluginSettings): void {
        this.settings = settings;
    }
}

function escapeHtmlAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeMarkdownLinkText(value: string): string {
    return value.replace(/([\\[\]])/g, '\\$1');
}

function encodeMarkdownLinkUrl(value: string): string {
    // Spaces and parentheses break markdown link syntax.
    return value.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}
