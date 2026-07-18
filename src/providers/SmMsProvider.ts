import { IOssProvider, OssImage, UploadProgressInfo } from '../types/oss';
import { SmMsSettings, PluginSettings } from '../types/settings';
import { requestUrl, RequestUrlParam, Setting } from 'obsidian';
import { t } from '../i18n';
import { buildMultipartBody, generateBoundary } from './shared/multipart';
import { simulateProgress } from './shared/progress';
import { getArray, getBoolean, getNumber, getNumberLike, getRecord, getString } from '../utils/typeGuards';

const SEE_API_BASE_URL = 'https://s.ee/api/v1';
const SEE_HISTORY_PAGE_SIZE = 30;

function parseCreatedAt(value: unknown): Date | undefined {
    const numericValue = getNumberLike(value);
    const date = numericValue !== undefined
        ? new Date(numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue)
        : new Date(getString(value) ?? '');
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseJsonResponse(text: string): Record<string, unknown> | undefined {
    try {
        return getRecord(JSON.parse(text) as unknown);
    } catch {
        return undefined;
    }
}

export class SmMsProvider implements IOssProvider {
    name = 'smms';
    private settings: SmMsSettings;

    constructor(settings: SmMsSettings) {
        this.settings = settings;
    }

    async upload(
        file: File,
        path: string,
        onProgress?: (progress: UploadProgressInfo) => void
    ): Promise<string> {
        if (!this.settings.token) {
            throw new Error(t('Please configure OSS settings first'));
        }

        const boundary = generateBoundary();

        const bodyArrayBuffer = buildMultipartBody([
            { name: 'smfile', value: new Uint8Array(await file.arrayBuffer()), filename: file.name, contentType: file.type || 'application/octet-stream' },
            { name: 'format', value: 'json' }
        ], boundary);

        const requestParams: RequestUrlParam = {
            url: `${SEE_API_BASE_URL}/file/upload`,
            method: 'POST',
            headers: {
                'Authorization': this.settings.token,
                'Accept': 'application/json',
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: bodyArrayBuffer
        };

        const progress = simulateProgress(onProgress, file.size);

        try {
            const response = await requestUrl({ ...requestParams, throw: false });
            const data = parseJsonResponse(response.text);
            if (response.status < 200 || response.status >= 300) {
                throw new Error(getString(data?.message) || `Request failed with status ${response.status}`);
            }
            if (!data) {
                throw new Error('S.EE returned an invalid JSON response');
            }

            const uploadData = getRecord(data?.data);
            const imageUrl = getString(uploadData?.url);
            const repeatedImageUrl = getString(data?.images);
            const code = getString(data?.code) ?? getNumber(data?.code)?.toString();

            if (getBoolean(data?.success) && imageUrl) {
                progress.finish();
                return imageUrl;
            } else if (code === 'image_repeated' && repeatedImageUrl) {
                progress.finish();
                return repeatedImageUrl;
            } else {
                throw new Error(getString(data?.message) || `Upload failed with code: ${code ?? 'unknown'}`);
            }
        } catch (error) {
            progress.fail();
            console.error('SM.MS upload error:', error);
            throw new Error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async listImages(prefix?: string): Promise<OssImage[]> {
        if (!this.settings.token) {
            return [];
        }

        try {
            const images: OssImage[] = [];
            const seenPages = new Set<string>();
            let page = 1;

            while (true) {
                const response = await requestUrl({
                    url: `${SEE_API_BASE_URL}/files?page=${page}`,
                    method: 'GET',
                    headers: {
                        'Authorization': this.settings.token,
                        'Accept': 'application/json'
                    },
                    throw: false
                });

                const data = parseJsonResponse(response.text);
                if (response.status < 200 || response.status >= 300) {
                    throw new Error(getString(data?.message) || `Request failed with status ${response.status}`);
                }
                if (!data) {
                    throw new Error('S.EE returned an invalid JSON response');
                }
                if (getBoolean(data.success) !== true) {
                    throw new Error(getString(data?.message) || 'List failed');
                }

                const items = getArray(data?.data) ?? [];
                const pageFingerprint = items.map((item) => {
                    const record = getRecord(item);
                    return getString(record?.hash)
                        ?? getNumber(record?.file_id)?.toString()
                        ?? getString(record?.url)
                        ?? '';
                }).join('\n');
                if (items.length > 0 && seenPages.has(pageFingerprint)) {
                    return images;
                }
                seenPages.add(pageFingerprint);

                images.push(...items.flatMap((item) => {
                    const record = getRecord(item);
                    const key = getString(record?.hash);
                    const url = getString(record?.url);
                    if (!key || !url) {
                        return [];
                    }

                    return [{
                        key,
                        url,
                        lastModified: parseCreatedAt(record?.created_at),
                        size: getNumber(record?.size) ?? 0,
                    }];
                }));

                const totalPages = getNumber(data?.TotalPages)
                    ?? getNumber(getRecord(data?.meta)?.total_pages);
                const isLastPage = totalPages !== undefined
                    ? page >= totalPages
                    : items.length < SEE_HISTORY_PAGE_SIZE;
                if (items.length === 0 || isLastPage) {
                    return images;
                }
                page++;
            }
        } catch (e) {
            console.error('Failed to list SM.MS images', e);
            throw new Error(`List failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    async deleteImage(key: string): Promise<void> {
        try {
            const response = await requestUrl({
                url: `${SEE_API_BASE_URL}/file/delete/${encodeURIComponent(key)}`,
                method: 'GET',
                headers: {
                    'Authorization': this.settings.token,
                    'Accept': 'application/json'
                },
                throw: false
            });

            const data = parseJsonResponse(response.text);
            if (response.status < 200 || response.status >= 300) {
                throw new Error(getString(data?.message) || `Request failed with status ${response.status}`);
            }
            if (!data) {
                throw new Error('S.EE returned an invalid JSON response');
            }
            if (getBoolean(data.success) !== true) {
                throw new Error(getString(data?.message) || 'Delete failed');
            }
        } catch (e) {
            throw new Error(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    renderSettings(containerEl: HTMLElement, settings: PluginSettings, saveSettings: () => Promise<void>): void {
        new Setting(containerEl)
            .setName(t('Token'))
            .setDesc(t('SM.MS Secret Token'))
            .addText(text => {
                text.inputEl.type = 'password';
                return text
                .setPlaceholder('Enter your token')
                .setValue(settings.providers.smms.token)
                .onChange(async (value) => {
                    settings.providers.smms.token = value;
                    await saveSettings();
                });
            });
    }
}
