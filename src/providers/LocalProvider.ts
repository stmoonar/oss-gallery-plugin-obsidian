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
     * Resolve a storage-relative path to an absolute path, rejecting any
     * path (e.g. containing "..") that escapes the storage directory.
     */
    private resolveWithinStorage(relativePath: string): string {
        const baseDir = path.resolve(this.getAbsoluteStoragePath());
        const resolved = path.resolve(baseDir, relativePath);
        if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
            throw new Error(t('Path escapes the storage directory'));
        }
        return resolved;
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

        const destAbsolute = this.resolveWithinStorage(filePath);
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
        images.sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0));
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
        const fullPath = this.resolveWithinStorage(key);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${key}`);
        }

        if (this.settings.deleteToTrash) {
            const trashed = await this.moveToSystemTrash(fullPath, key);
            if (!trashed) {
                // Never silently fall back to permanent deletion when the
                // user explicitly asked for trash.
                throw new Error(t('Failed to move file to system trash'));
            }
        } else {
            fs.unlinkSync(fullPath);
        }
    }

    /**
     * Move a file to the system trash. `trashSystem` expects a vault-relative
     * path, so it only works in vault-relative mode; for absolute storage
     * paths fall back to Electron's shell.trashItem.
     */
    private async moveToSystemTrash(fullPath: string, key: string): Promise<boolean> {
        if (this.settings.useRelativePath) {
            const adapter = this.getFileSystemAdapter();
            if (adapter) {
                try {
                    const vaultRelative = normalizePath(`${this.settings.storagePath}/${key}`);
                    if (await adapter.trashSystem(vaultRelative)) return true;
                } catch {
                    // fall through to Electron
                }
            }
        }

        try {
            interface ElectronShell { shell?: { trashItem?: (p: string) => Promise<void> } }
            const requireFn = (window as unknown as { require?: (m: string) => ElectronShell }).require;
            const electron = requireFn?.('electron');
            if (electron?.shell?.trashItem) {
                await electron.shell.trashItem(fullPath);
                return true;
            }
        } catch {
            // no Electron available (mobile) or trash failed
        }

        return false;
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
