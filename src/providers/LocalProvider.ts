import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { LocalSettings, PluginSettings } from '../types/settings';
import { App, Setting, TFile, TFolder, normalizePath } from 'obsidian';
import { t } from '../i18n';
import { isImageFile } from './shared/image';
import { buildListPrefix } from './shared/path';

/** Highest numeric suffix tried when picking a non-colliding file name. */
const MAX_NAME_SUFFIX = 999;

/**
 * Split a relative path into clean segments, or return null when it is
 * absolute (leading slash / backslash, drive letter) or contains "..".
 */
function toSafeSegments(value: string): string[] | null {
    const trimmed = value.trim();
    if (/^[\\/]/.test(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
        return null;
    }
    const segments = trimmed
        .split(/[\\/]+/)
        .filter((segment) => segment !== '' && segment !== '.');
    return segments.includes('..') ? null : segments;
}

/**
 * Vault-relative folder for a Local storage path, or null when the path is
 * empty, absolute, or escapes the vault (no longer supported).
 */
export function resolveLocalStorageFolder(storagePath: string | undefined): string | null {
    const segments = toSafeSegments(storagePath ?? '');
    if (!segments || segments.length === 0) {
        return null;
    }
    return normalizePath(segments.join('/'));
}

/**
 * Whether a non-empty Local storage path is rejected because it is absolute
 * or leaves the vault (e.g. settings saved by an older plugin version).
 */
export function isUnsupportedLocalStoragePath(storagePath: string | undefined): boolean {
    return Boolean(storagePath?.trim()) && resolveLocalStorageFolder(storagePath) === null;
}

export class LocalProvider implements IOssProvider {
    name = 'local';

    constructor(private settings: LocalSettings, private app: App) {}

    private getStorageFolder(): string {
        const folder = resolveLocalStorageFolder(this.settings.storagePath);
        if (!folder) {
            throw new Error(this.settings.storagePath?.trim()
                ? t('Absolute paths are no longer supported. Use a folder inside the vault.')
                : t('Please configure local storage path first'));
        }
        return folder;
    }

    /**
     * Resolve a storage-relative key to a vault path, rejecting keys that are
     * absolute or contain ".." so nothing escapes the storage folder.
     */
    private toVaultPath(key: string): string {
        const segments = toSafeSegments(key);
        if (!segments || segments.length === 0) {
            throw new Error(t('Path escapes the storage directory'));
        }
        return normalizePath(`${this.getStorageFolder()}/${segments.join('/')}`);
    }

    /**
     * Create every missing folder along `folderPath`, tolerating folders that
     * appear concurrently (e.g. two uploads into the same new folder).
     */
    private async ensureFolder(folderPath: string): Promise<TFolder> {
        const vault = this.app.vault;
        let current = '';
        for (const segment of folderPath.split('/')) {
            current = current ? `${current}/${segment}` : segment;
            const existing = vault.getAbstractFileByPath(current);
            if (existing instanceof TFolder) continue;
            if (existing) {
                throw new Error(`Not a folder: ${current}`);
            }
            try {
                await vault.createFolder(current);
            } catch (error) {
                if (!vault.getFolderByPath(current)) throw error;
            }
        }

        const folder = vault.getFolderByPath(folderPath);
        if (!folder) {
            throw new Error(`Folder not found: ${folderPath}`);
        }
        return folder;
    }

    /**
     * Write the file under `vaultPath`, or under "name 1.ext", "name 2.ext"...
     * when that name is taken. Never overwrites. Returns the created file.
     */
    private async createWithoutOverwrite(vaultPath: string, data: ArrayBuffer): Promise<TFile> {
        const slash = vaultPath.lastIndexOf('/');
        const parentPath = vaultPath.slice(0, slash);
        const fileName = vaultPath.slice(slash + 1);
        const dot = fileName.lastIndexOf('.');
        const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
        const ext = dot > 0 ? fileName.slice(dot) : '';

        const parent = await this.ensureFolder(parentPath);
        // Compare case-insensitively: Windows and macOS file systems treat
        // "A.png" and "a.png" as the same file.
        const taken = new Set(parent.children.map((child) => child.name.toLowerCase()));

        for (let n = 0; n <= MAX_NAME_SUFFIX; n++) {
            const candidateName = n === 0 ? fileName : `${stem} ${n}${ext}`;
            if (taken.has(candidateName.toLowerCase())) continue;

            const candidatePath = `${parentPath}/${candidateName}`;
            try {
                return await this.app.vault.createBinary(candidatePath, data);
            } catch (error) {
                // Another upload claimed this name in the meantime: try the next.
                if (!this.app.vault.getAbstractFileByPath(candidatePath)) throw error;
                taken.add(candidateName.toLowerCase());
            }
        }

        throw new Error(`No free file name for: ${vaultPath}`);
    }

    async upload(
        file: File,
        filePath: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        const vaultPath = this.toVaultPath(filePath);
        const arrayBuffer = await file.arrayBuffer();
        const total = arrayBuffer.byteLength;

        if (onProgress) onProgress({ loaded: 0, total, percentage: 0 });

        const created = await this.createWithoutOverwrite(vaultPath, arrayBuffer);

        if (onProgress) onProgress({ loaded: total, total, percentage: 100 });

        // Vault-relative path of the file actually written, for embedding.
        return created.path;
    }

    listImages(prefix?: string): Promise<OssImage[]> {
        const folderPath = resolveLocalStorageFolder(this.settings.storagePath);
        const folder = folderPath ? this.app.vault.getFolderByPath(folderPath) : null;
        if (!folder) return Promise.resolve([]);

        const images: OssImage[] = [];
        this.scanFolder(folder, folder.path.length + 1, images, buildListPrefix(undefined, prefix));

        // Sort by lastModified descending
        images.sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0));
        return Promise.resolve(images);
    }

    private scanFolder(folder: TFolder, rootLength: number, images: OssImage[], prefix: string): void {
        for (const child of folder.children) {
            const key = child.path.slice(rootLength);

            if (child instanceof TFolder) {
                // Only descend into folders that can contain matches.
                const canMatch = !prefix
                    || `${key}/`.startsWith(prefix)
                    || prefix.startsWith(`${key}/`);
                if (canMatch) {
                    this.scanFolder(child, rootLength, images, prefix);
                }
            } else if (child instanceof TFile && isImageFile(child.name)) {
                if (prefix && !key.startsWith(prefix)) continue;

                images.push({
                    key,
                    url: this.app.vault.getResourcePath(child),
                    lastModified: new Date(child.stat.mtime),
                    size: child.stat.size,
                });
            }
        }
    }

    async deleteImage(key: string): Promise<void> {
        const file = this.app.vault.getFileByPath(this.toVaultPath(key));
        if (!file) {
            throw new Error(`File not found: ${key}`);
        }

        // Follows the user's "Deleted files" preference (system trash,
        // vault .trash folder, or permanent deletion).
        await this.app.fileManager.trashFile(file);
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        const local = settings.providers.local;

        const storageSetting = new Setting(containerEl)
            .setName(t('Storage path'))
            .setDesc(t('Folder inside the vault where uploaded files are stored'));

        const warningEl = storageSetting.descEl.createDiv({
            cls: 'mod-warning',
            text: t('Absolute paths are no longer supported. Use a folder inside the vault.'),
        });
        warningEl.toggle(isUnsupportedLocalStoragePath(local?.storagePath));

        storageSetting.addText(text => text
            .setPlaceholder('attachments')
            .setValue(local?.storagePath || '')
            .onChange(async (value) => {
                settings.providers.local.storagePath = value;
                warningEl.toggle(isUnsupportedLocalStoragePath(value));
                await saveSettings();
            }));
    }
}
