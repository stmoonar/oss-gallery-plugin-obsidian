import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { LocalSettings, PluginSettings } from '../types/settings';
import { App, FileSystemAdapter, Setting, normalizePath } from 'obsidian';
import { t } from '../i18n';
import { isImageFile } from './shared/image';
import * as path from 'path';
import * as fs from 'fs';

export class LocalProvider implements IOssProvider {
    name = 'local';

    constructor(private settings: LocalSettings, private app: App) {}

    private getFileSystemAdapter(): FileSystemAdapter | null {
        const adapter = this.app.vault.adapter;
        return adapter instanceof FileSystemAdapter ? adapter : null;
    }

    private toFileUrl(absolutePath: string): string {
        const normalized = absolutePath.replace(/\\/g, '/').replace(/^\/+/, '');
        return encodeURI(`file:///${normalized}`);
    }

    /**
     * Resolve storagePath to an absolute directory.
     * If useRelativePath is true, resolve relative to the vault root.
     * Otherwise treat storagePath as an absolute path.
     */
    private getAbsoluteStoragePath(): string {
        if (this.settings.useRelativePath) {
            const adapter = this.getFileSystemAdapter();
            if (!adapter) {
                throw new Error(t('Vault-relative local storage requires a file-system vault'));
            }

            return path.join(adapter.getBasePath(), this.settings.storagePath);
        }
        return this.settings.storagePath;
    }

    /**
     * Ensure the storage directory exists.
     */
    private ensureStorageDir(): void {
        const dir = this.getAbsoluteStoragePath();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    async upload(
        file: File,
        filePath: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.storagePath) {
            throw new Error(t('Please configure local storage path first'));
        }

        this.ensureStorageDir();

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (onProgress) onProgress({ loaded: 0, total: buffer.length, percentage: 0 });

        const destAbsolute = path.join(this.getAbsoluteStoragePath(), filePath);
        const destDir = path.dirname(destAbsolute);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        fs.writeFileSync(destAbsolute, buffer);

        if (onProgress) onProgress({ loaded: buffer.length, total: buffer.length, percentage: 100 });

        // Return vault-relative path or absolute path for markdown embedding
        if (this.settings.useRelativePath) {
            return normalizePath(`${this.settings.storagePath}/${filePath}`);
        }
        return this.toFileUrl(destAbsolute);
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        if (!this.settings.storagePath) return [];

        const baseDir = this.getAbsoluteStoragePath();
        if (!fs.existsSync(baseDir)) return [];

        const images: OssImage[] = [];
        this.scanDirectory(baseDir, '', images, prefix);

        // Sort by lastModified descending
        images.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
        return images;
    }

    /**
     * Convert an absolute file path to a URL usable in <img> tags.
     * Uses Obsidian's vault adapter resource path for vault-relative files,
     * otherwise falls back to file:// URL.
     */
    private toDisplayUrl(absolutePath: string, vaultRelativePath?: string): string {
        if (vaultRelativePath) {
            return this.app.vault.adapter.getResourcePath(vaultRelativePath);
        }
        return this.toFileUrl(absolutePath);
    }

    private scanDirectory(baseDir: string, relativePath: string, images: OssImage[], prefix?: string): void {
        const currentDir = relativePath ? path.join(baseDir, relativePath) : baseDir;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                this.scanDirectory(baseDir, entryRelative, images, prefix);
            } else if (entry.isFile() && isImageFile(entry.name)) {
                if (prefix && !entryRelative.startsWith(prefix)) continue;

                const fullPath = path.join(currentDir, entry.name);
                const stat = fs.statSync(fullPath);

                // For gallery display, use a URL the <img> tag can load
                const vaultRelative = this.settings.useRelativePath
                    ? normalizePath(`${this.settings.storagePath}/${entryRelative}`)
                    : undefined;
                const displayUrl = this.toDisplayUrl(fullPath, vaultRelative);

                images.push({
                    key: entryRelative,
                    url: displayUrl,
                    lastModified: stat.mtime,
                    size: stat.size,
                });
            }
        }
    }

    async deleteImage(key: string): Promise<void> {
        const fullPath = path.join(this.getAbsoluteStoragePath(), key);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${key}`);
        }

        if (this.settings.deleteToTrash) {
            const adapter = this.getFileSystemAdapter();
            try {
                const trashed = adapter ? await adapter.trashSystem(fullPath) : false;
                if (!trashed) {
                    fs.unlinkSync(fullPath);
                }
            } catch {
                fs.unlinkSync(fullPath);
            }
        } else {
            fs.unlinkSync(fullPath);
        }
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        const local = settings.providers.local;

        new Setting(containerEl)
            .setName(t('Storage path'))
            .setDesc(t('Vault-relative directory or absolute directory inserted as file:/// links'))
            .addText(text => text
                .setPlaceholder('attachments')
                .setValue(local?.storagePath || '')
                .onChange(async (value) => {
                    settings.providers.local.storagePath = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Use vault-relative path'))
            .setDesc(t('Resolve storage path relative to vault root (desktop file-system vault only)'))
            .addToggle(toggle => toggle
                .setValue(local?.useRelativePath ?? true)
                .onChange(async (value) => {
                    settings.providers.local.useRelativePath = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Delete to trash'))
            .setDesc(t('Move deleted files to system trash instead of permanent deletion'))
            .addToggle(toggle => toggle
                .setValue(local?.deleteToTrash ?? true)
                .onChange(async (value) => {
                    settings.providers.local.deleteToTrash = value;
                    await saveSettings();
                }));
    }
}
