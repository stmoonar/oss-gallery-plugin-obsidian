import { PluginSettings } from '../types/settings';
import { moment } from 'obsidian';
import { getFileTypeByMime } from '../utils/FileUtils';

export class ObjectKeyBuilder {
    constructor(private settings: PluginSettings) {}

    generateObjectName(file: File): string {
        return this.generatePath(file) + this.generateFileName(file);
    }

    private generatePath(file: File): string {
        switch (this.settings.pathRule) {
            case 'root':
                return '';
            case 'type':
                return `${getFileTypeByMime(file)}/`;
            case 'date':
                return `${moment().format('YYYY/MM/DD')}/`;
            case 'typeAndDate':
                return `${getFileTypeByMime(file)}/${moment().format('YYYY/MM/DD')}/`;
            default:
                return '';
        }
    }

    private generateFileName(file: File): string {
        const timestamp = moment().format('YYYYMMDDHHmmSS');
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
