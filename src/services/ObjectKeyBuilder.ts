import { PluginSettings } from '../types/settings';
import { moment } from 'obsidian';
import { getFileTypeByMime } from '../utils/FileUtils';

export class ObjectKeyBuilder {
    constructor(private settings: PluginSettings) {}

    generateObjectName(file: File): string {
        return this.generatePath(file) + this.generateFileName(file);
    }

    private generatePath(file: File): string {
        const segments: string[] = [];
        const basePath = this.settings.basepath.trim().replace(/^\/+/, '').replace(/\/+$/, '');

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

    private generateFileName(file: File): string {
        const timestamp = moment().format('YYYYMMDDHHmmssSSS');
        const extension = file.name.substring(file.name.lastIndexOf('.'));

        switch (this.settings.nameRule) {
            case 'local':
                return file.name;
            case 'time':
                return timestamp + extension;
            case 'timeAndLocal':
                return timestamp + '_' + file.name;
            default:
                return file.name;
        }
    }

    updateSettings(settings: PluginSettings): void {
        this.settings = settings;
    }
}
