import { PluginSettings } from '../types/settings';
import { moment } from 'obsidian';
import { getFileTypeByMime } from '../utils/FileUtils';

export class ObjectKeyBuilder {
    private lastTimestamp = '';
    private timestampSeq = 0;

    constructor(private settings: PluginSettings) {}

    generateObjectName(file: File): string {
        return this.generatePath(file) + this.generateFileName(file);
    }

    private generatePath(file: File): string {
        const segments: string[] = [];
        const basePath = normalizeBasePath(this.settings.basepath);

        if (basePath) {
            segments.push(basePath);
        }

        switch (this.settings.pathRule) {
            case 'root':
                break;
            case 'type':
                segments.push(getFileTypeByMime(file));
                break;
            case 'date':
                segments.push(moment().format('YYYY/MM/DD'));
                break;
            case 'typeAndDate':
                segments.push(getFileTypeByMime(file), moment().format('YYYY/MM/DD'));
                break;
            default:
                break;
        }

        return segments.length > 0 ? `${segments.join('/')}/` : '';
    }

    /**
     * Millisecond timestamp with a sequence suffix when two uploads land in
     * the same millisecond (batch paste/drop), so keys never collide.
     */
    private nextTimestamp(): string {
        const timestamp = moment().format('YYYYMMDDHHmmssSSS');
        if (timestamp === this.lastTimestamp) {
            this.timestampSeq++;
            return `${timestamp}_${this.timestampSeq}`;
        }
        this.lastTimestamp = timestamp;
        this.timestampSeq = 0;
        return timestamp;
    }

    private generateFileName(file: File): string {
        const timestamp = this.nextTimestamp();
        const dotIndex = file.name.lastIndexOf('.');
        const extension = dotIndex > 0 ? file.name.substring(dotIndex) : '';
        const safeName = sanitizeFileName(file.name);

        switch (this.settings.nameRule) {
            case 'time':
                return timestamp + sanitizeFileName(extension);
            case 'timeAndLocal':
                return timestamp + '_' + safeName;
            case 'local':
            default:
                // Clipboard images always share a generic name ("image.png"),
                // so keeping it as-is would overwrite the previous upload.
                return isGenericClipboardName(file.name)
                    ? timestamp + '_' + safeName
                    : safeName;
        }
    }

    updateSettings(settings: PluginSettings): void {
        this.settings = settings;
    }
}

/**
 * Normalize the global base path the way object keys use it: trimmed,
 * without leading/trailing slashes, and with empty / "." / ".." segments
 * dropped so it cannot escape the storage root. Returns '' when unset.
 */
export function normalizeBasePath(basepath: string | undefined): string {
    return (basepath ?? '')
        .trim()
        .split('/')
        .filter((segment) => segment && segment !== '.' && segment !== '..')
        .join('/');
}

/**
 * Names browsers / Obsidian give to pasted clipboard images, which are not
 * unique across pastes.
 */
function isGenericClipboardName(name: string): boolean {
    return /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(name)
        || /^Pasted image \d*\.\w+$/i.test(name);
}

/**
 * Strip characters that break object keys or the URLs built from them.
 */
function sanitizeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|#%]/g, '_');
}
