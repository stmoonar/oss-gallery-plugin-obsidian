import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { GithubSettings, PluginSettings } from '../types/settings';
import { requestUrl, Setting, Notice } from 'obsidian';
import { t } from '../i18n';
import { isImageFile } from './shared/image';

export class GithubProvider implements IOssProvider {
    name = 'github';
    private settings: GithubSettings;

    constructor(settings: GithubSettings) {
        this.settings = settings;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.repo || !this.settings.token) {
            throw new Error(t('Please configure OSS settings first'));
        }

        const content = await this.fileToBase64(file);
        const fileName = file.name; // Or use path if path contains filename
        // path argument usually is the full object name (path + filename) from FileProcessor
        // But GitHub API expects path parameter in URL to be the full path including filename.

        // If path is just the directory, we append filename.
        // But FileProcessor.generateObjectName returns full path including filename.
        // So we use 'path' as the full path.
        // However, we should ensure it doesn't start with /.
        const cleanPath = path.replace(/^\//, '');

        const url = `https://api.github.com/repos/${this.settings.repo}/contents/${cleanPath}`;

        try {
            const response = await requestUrl({
                url: url,
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.settings.token}`,
                    'User-Agent': 'Obsidian-OSS-Gallery',
                    'Content-Type': 'application/json',
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                body: JSON.stringify({
                    message: `Upload ${fileName} by Obsidian OSS Gallery`,
                    content: content,
                    branch: this.settings.branch || 'main'
                })
            });

            if (response.status >= 200 && response.status < 300) {
                const data = response.json;
                if (this.settings.customUrl) {
                    // Replace https://github.com/user/repo/raw/branch/path with custom url
                    // Or usually customUrl is CDN like https://cdn.jsdelivr.net/gh/user/repo
                    // We need to construct it.
                    // If customUrl is provided, we assume it maps to the root of the repo?
                    // Or we just prepend it to the path?
                    // PicGo logic: replace raw.githubusercontent.com structure or just use customUrl + path
                    // Let's assume customUrl is the base URL.
                    const cleanCustomUrl = this.settings.customUrl.replace(/\/$/, '');
                    return `${cleanCustomUrl}/${cleanPath}`;
                }
                return data.content.download_url;
            } else {
                throw new Error(`Upload failed: ${response.status} ${response.text}`);
            }
        } catch (error) {
            console.error('GitHub upload error:', error);
            if (error.status === 401) {
                throw new Error('GitHub authentication failed. Please check your token.');
            } else if (error.status === 403) {
                throw new Error('GitHub permission denied. Please ensure your token has write access to the repository.');
            } else if (error.status === 404) {
                throw new Error('GitHub repository or file not found. Please check the repository name and path.');
            } else {
                throw new Error(`Upload failed: ${error.message || error}`);
            }
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        const repo = this.settings.repo;
        if (!repo) {
            return [];
        }

        // Remove leading slash from prefix if present
        const path = prefix ? prefix.replace(/^\//, '') : '';

        // Optimization 1: If a specific prefix is provided, search only that directory
        if (path) {
            return await this.searchDirectory(repo, path);
        }

        // Optimization 2: First try to get repository's Git tree to avoid multiple API calls
        try {
            const treeData = await this.getRepositoryTree(repo);
            return this.extractImagesFromTree(treeData);
        } catch (error) {
            // Fallback to directory-based search if tree API fails
            console.warn('Tree API failed, falling back to directory search');
            return await this.searchCommonDirectories(repo);
        }
    }

    /**
     * Get repository's Git tree with all files at once
     */
    private async getRepositoryTree(repo: string): Promise<any> {
        const url = `https://api.github.com/repos/${repo}/git/trees/${this.settings.branch || 'main'}?recursive=1`;

        const response = await requestUrl({
            url: url,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.settings.token}`,
                'User-Agent': 'Obsidian-OSS-Gallery',
                'Accept': 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        if (response.status === 200) {
            return response.json;
        }
        throw new Error(`Tree API failed: ${response.status}`);
    }

    /**
     * Extract images from Git tree data
     */
    private extractImagesFromTree(treeData: any): OssImage[] {
        const images: OssImage[] = [];

        if (treeData.tree && Array.isArray(treeData.tree)) {
            for (const item of treeData.tree) {
                if (item.type === 'blob' && isImageFile(item.path)) {
                    images.push({
                        key: item.path,
                        url: this.buildCustomUrl(item.path),
                        size: item.size || 0
                    });
                }
            }
        }

        return images;
    }

    /**
     * Search specific directory
     */
    private async searchDirectory(repo: string, path: string): Promise<OssImage[]> {
        const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${this.settings.branch || 'main'}`;

        try {
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.settings.token}`,
                    'User-Agent': 'Obsidian-OSS-Gallery',
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            if (response.status === 200) {
                const data = response.json;

                // Handle single file
                if (data && !Array.isArray(data) && data.type === 'file') {
                    if (isImageFile(data.name)) {
                        return [{
                            key: data.path,
                            url: data.download_url || this.buildCustomUrl(data.path),
                            size: data.size
                        }];
                    }
                    return [];
                }

                // Handle directory
                if (Array.isArray(data)) {
                    return data
                        .filter(item => item.type === 'file' && isImageFile(item.name))
                        .map(item => ({
                            key: item.path,
                            url: item.download_url || this.buildCustomUrl(item.path),
                            size: item.size
                        }));
                }
            }
        } catch (error) {
            console.warn(`Failed to search directory ${path}:`, error);
        }

        return [];
    }

    /**
     * Search common directories as fallback (limited recursive search)
     */
    private async searchCommonDirectories(repo: string): Promise<OssImage[]> {
        const allImages: OssImage[] = [];
        const commonImageDirs = ['images', 'img', 'assets', 'static', 'pictures', 'media', 'uploads'];

        // Add root directory to search
        const directoriesToSearch = [''];

        // Add common image directories if they exist
        for (const dir of commonImageDirs) {
            directoriesToSearch.push(dir);
        }

        // Batch search requests
        const searchPromises = directoriesToSearch.map(path => this.searchDirectory(repo, path));
        const results = await Promise.all(searchPromises);

        results.forEach(images => {
            allImages.push(...images);
        });

        return allImages;
    }

    /**
     * Build custom URL for files (e.g., CDN URLs)
     */
    private buildCustomUrl(path: string): string {
        if (this.settings.customUrl) {
            const cleanCustomUrl = this.settings.customUrl.replace(/\/$/, '');
            return `${cleanCustomUrl}/${path}`;
        }
        // Fallback to GitHub raw URL
        return `https://raw.githubusercontent.com/${this.settings.repo}/${this.settings.branch || 'main'}/${path}`;
    }

    async deleteImage(key: string): Promise<void> {
        // Delete requires SHA of the file.
        // We first need to get the file to get its SHA.
        // GET /repos/:owner/:repo/contents/:path

        const repo = this.settings.repo;
        if (!repo) throw new Error('Repo not configured');

        const url = `https://api.github.com/repos/${repo}/contents/${key}`;

        try {
            // Get SHA
            const getResponse = await requestUrl({
                url: url + `?ref=${this.settings.branch || 'main'}`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.settings.token}`,
                    'User-Agent': 'Obsidian-OSS-Gallery',
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            if (getResponse.status !== 200) {
                throw new Error('File not found');
            }

            const sha = getResponse.json.sha;

            // Delete
            const deleteResponse = await requestUrl({
                url: url,
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.settings.token}`,
                    'User-Agent': 'Obsidian-OSS-Gallery',
                    'Content-Type': 'application/json',
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                body: JSON.stringify({
                    message: `Delete ${key} by Obsidian OSS Gallery`,
                    sha: sha,
                    branch: this.settings.branch || 'main'
                })
            });

            if (deleteResponse.status !== 200) {
                throw new Error('Delete failed');
            }
        } catch (e) {
            throw new Error(`Delete failed: ${e.message}`);
        }
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        new Setting(containerEl)
            .setName(t('Repo Name'))
            .setDesc(t('username/reponame'))
            .addText(text => text
                .setPlaceholder('username/repo')
                .setValue(settings.providers.github.repo)
                .onChange(async (value) => {
                    settings.providers.github.repo = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Branch'))
            .setDesc(t('main or master'))
            .addText(text => text
                .setPlaceholder('main')
                .setValue(settings.providers.github.branch)
                .onChange(async (value) => {
                    settings.providers.github.branch = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Token'))
            .setDesc(t('GitHub Personal Access Token'))
            .addText(text => text
                .setPlaceholder('ghp_...')
                .setValue(settings.providers.github.token)
                .onChange(async (value) => {
                    settings.providers.github.token = value;
                    await saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('Custom Domain'))
            .setDesc(t('e.g. https://cdn.jsdelivr.net/gh/user/repo'))
            .addText(text => text
                .setPlaceholder('https://...')
                .setValue(settings.providers.github.customUrl)
                .onChange(async (value) => {
                    settings.providers.github.customUrl = value;
                    await saveSettings();
                }));
    }

    private fileToBase64(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => {
                const result = reader.result as string;
                // Remove data:image/png;base64, prefix
                const base64 = result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = error => reject(error);
        });
    }

}