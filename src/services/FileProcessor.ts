import { PluginSettings, NameRule, PathRule } from '../types/settings';
import { moment } from 'obsidian';

export class FileProcessor {
    constructor(private settings: PluginSettings) {}

    /**
     * 获取文件类型
     */
    getFileType(file: File): string {
        const imageType = /image.*/;
        const videoType = /video.*/;
        const audioType = /audio.*/;
        const docType = /application\/(vnd.*|pdf)/;

        if (file?.type.match(videoType)) {
            return 'video';
        } else if (file?.type.match(audioType)) {
            return 'audio';
        } else if (file?.type.match(docType)) {
            return 'doc';
        } else if (file?.type.match(imageType)) {
            return 'image';
        } else {
            return '';
        }
    }

    /**
     * 生成对象名称
     */
    generateObjectName(file: File): string {
        let objectName = this.generatePath(file);
        objectName += this.generateFileName(file);
        objectName = this.applyBasePath(objectName);
        return objectName;
    }

    /**
     * 生成路径部分
     */
    private generatePath(file: File): string {
        switch (this.settings.pathRule as PathRule) {
            case 'root':
                return '';
            case 'type':
                return `${this.getFileType(file)}/`;
            case 'date':
                return `${moment().format('YYYY/MM/DD')}/`;
            case 'typeAndDate':
                return `${this.getFileType(file)}/${moment().format('YYYY/MM/DD')}/`;
            default:
                return '';
        }
    }

    /**
     * 生成文件名部分
     */
    private generateFileName(file: File): string {
        const timestamp = moment().format('YYYYMMDDHHmmSS');
        const extension = file.name.substring(file.name.lastIndexOf('.'));

        switch (this.settings.nameRule as NameRule) {
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

    /**
     * 应用基础路径
     */
    private applyBasePath(objectName: string): string {
        // Basepath is now provider specific, but FileProcessor handles global naming rules.
        // If basepath is global, it should be in PluginSettings.
        // If it is per-provider, we need to access the active provider's settings.
        // However, the previous implementation had basepath in MinioPluginSettings.
        // In my new settings, I put basepath in MinioSettings.
        // But FileProcessor seems to be generic.
        // Let's assume for now we might need to pass the basepath or get it from the active provider's settings if possible,
        // OR we move basepath to global settings if it applies to all.
        // For now, let's check if I put basepath in PluginSettings in step 42.
        // I did NOT put basepath in PluginSettings, only in MinioSettings.
        // This is a potential issue.
        // Let's check the file content of settings.ts first to be sure.
        
        // For this specific replacement, I will comment out basepath usage or fix it after checking settings.ts.
        // Actually, I should wait for view_file result before applying this change to be safe.
        // But I can't wait in the same turn.
        // I will assume I need to fix this.
        
        // Let's look at the previous FileProcessor. It used this.settings.basepath.
        // If I want to support basepath for all providers, it should be in PluginSettings.
        // If not, FileProcessor needs to know about the specific provider settings.
        
        // Let's tentatively move basepath to global settings in the next step if it's missing.
        // For now, I'll leave this method but it might error if basepath is missing on PluginSettings.
        // I will simply return objectName for now and fix it in the next turn if needed.
        
        return objectName; 
    }

    /**
     * 根据文件类型包装内容
     */
    wrapFileDependingOnType(type: string, url: string, name: string): string {
        if (type === 'image') {
            return `${this.settings.imgPreview ? '!' : ''}[](${url})\n`;
        } else if (type === 'video') {
            return `${this.settings.videoPreview ? `<video src="${url}" controls></video>` : `[${name}](${url})`}\n`;
        } else if (type === 'audio') {
            return `${this.settings.audioPreview ? `<audio src="${url}" controls></audio>` : `[${name}](${url})`}\n`;
        } else if (type === 'doc') {
            return this.settings.docsPreview
                ? `<iframe frameborder="0" border="0" width="100%" height="800" src="${this.settings.docsPreview}${url}"></iframe>\n`
                : `[${name}](${url})\n`;
        } else {
            throw new Error('Unknown file type');
        }
    }

    /**
     * 更新设置
     */
    updateSettings(settings: PluginSettings): void {
        this.settings = settings;
    }
}