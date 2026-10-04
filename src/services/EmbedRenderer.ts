import { PluginSettings } from '../types/settings';

export class EmbedRenderer {
    constructor(private settings: PluginSettings) {}

    render(type: string, url: string, name: string): string {
        const safeUrl = escapeHtmlAttr(url);
        const mdLink = `[${escapeMarkdownLinkText(name)}](${toMarkdownDestination(url)})`;

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
        // A $URL right after "(" is a markdown link destination and must
        // survive spaces / parentheses (e.g. local vault paths); other
        // occurrences (HTML attributes, plain text) get the raw URL.
        return format
            .replace(/(\(\s*)\$URL/g, (_match, open: string) => open + toMarkdownDestination(url))
            .replace(/\$URL/g, () => url)
            .replace(/\$NAME/g, () => name) + '\n';
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

/**
 * Markdown link destination: whitespace and parentheses break the plain
 * form, so such URLs use the CommonMark angle-bracket form `<...>`.
 */
function toMarkdownDestination(value: string): string {
    if (!/[\s()]/.test(value)) {
        return value;
    }
    return `<${value.replace(/[<>]/g, (char) => `\\${char}`)}>`;
}
